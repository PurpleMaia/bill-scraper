/**
 * Sim Week user/follow helpers.
 *
 * Notifications reach a user via user_bills ⋈ user (see notificationService
 * defaultFetchFollowers). To make sim digests/deadline mail land in Jaden's
 * inbox, we ensure a `user` row exists for ALERT_EMAIL and that every sim bill
 * has a `user_bills` follow row pointing at it.
 *
 * These rows are cleaned up by scripts/sim/reset.js (follows keyed on sim bills;
 * the user row is left in place since it may be a real account).
 */

import { db } from '../../../db/kysely/client.js';

/**
 * Find or create a user that will receive sim notifications, by email.
 * If a user with that email exists, reuse it; otherwise create a minimal sim user.
 * @param {string} email
 * @param {string} [username='sim-week']
 * @returns {Promise<{ id: string, email: string, created: boolean }>}
 */
export async function resolveSimUserByEmail(email, username = 'sim-week') {
  if (!email) throw new Error('email is required to resolve a sim notification user');

  const existing = await db
    .selectFrom('user')
    .select(['id', 'email'])
    .where('email', '=', email)
    .executeTakeFirst();
  if (existing) return { ...existing, created: false };

  const inserted = await db
    .insertInto('user')
    .values({
      email,
      username,
      account_status: 'active',
      role: 'user',
      system_role: 'user',
    })
    .returning(['id', 'email'])
    .executeTakeFirst();
  return { ...inserted, created: true };
}

/**
 * Find or create the primary user that will receive sim notifications.
 * Uses ALERT_EMAIL (the address the cron already emails).
 * @returns {Promise<{ id: string, email: string, created: boolean }>}
 */
export async function resolveSimUser() {
  const email = process.env.ALERT_EMAIL;
  if (!email) throw new Error('ALERT_EMAIL is not set; cannot resolve sim notification user');
  return resolveSimUserByEmail(email);
}

/**
 * Email prefix for throwaway sim TESTIFIER users. `testimonies` has a unique
 * (user_id, bill_id) constraint, so simulating a crowd of testifiers on one bill
 * requires distinct users — these are them. reset.js removes any user whose email
 * starts with this prefix. Never collides with a real account (the '+sim-testifier'
 * tag routes to the same inbox but is a distinct address).
 */
const TESTIFIER_PREFIX = 'sim-testifier';

/** The tagged email for the Nth throwaway testifier, derived from ALERT_EMAIL. */
function testifierEmail(n) {
  const base = process.env.ALERT_EMAIL || 'sim@example.com';
  const [local, domain] = base.split('@');
  return `${local}+${TESTIFIER_PREFIX}-${n}@${domain}`;
}

export { TESTIFIER_PREFIX };

/**
 * Find or create `count` throwaway testifier users (distinct rows) so a crowd of
 * testimonies can be inserted on one bill despite the unique (user_id, bill_id)
 * constraint. Idempotent: re-requesting the same indices reuses existing rows.
 * @param {number} count
 * @returns {Promise<Array<{ id: string }>>}
 */
export async function resolveSimTestifiers(count) {
  const out = [];
  for (let i = 1; i <= count; i++) {
    const email = testifierEmail(i);
    const existing = await db.selectFrom('user').select('id').where('email', '=', email).executeTakeFirst();
    if (existing) { out.push(existing); continue; }
    const inserted = await db
      .insertInto('user')
      .values({
        email,
        username: `${TESTIFIER_PREFIX}-${i}`,
        account_status: 'active',
        role: 'user',
        system_role: 'user',
      })
      .returning('id')
      .executeTakeFirst();
    out.push(inserted);
  }
  return out;
}

/**
 * Ensure a user_bills follow row exists linking `userId` to `billId`.
 * Idempotent: skips if a row already exists.
 * @param {string} userId
 * @param {string} billId
 */
export async function ensureFollow(userId, billId) {
  const existing = await db
    .selectFrom('user_bills')
    .select('id')
    .where('user_id', '=', userId)
    .where('bill_id', '=', billId)
    .executeTakeFirst();
  if (existing) return;
  await db
    .insertInto('user_bills')
    .values({ user_id: userId, bill_id: billId, adopted_at: new Date() })
    .execute();
}
