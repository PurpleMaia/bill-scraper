/**
 * Seed the 20 Sim Week bills and follow them as the sim user.
 *
 *   node scripts/sim/seed.js            # create sim bills + follows (refuses if present)
 *   node scripts/sim/seed.js --force    # recreate even if sim bills already exist
 *   node scripts/sim/seed.js --day0     # leave bills blank (no status_updates at all)
 *
 * Bills are isolated by bill_url = test://sim-week/<SIM_ID>.
 *
 * By DEFAULT the seed populates ONLY each scenario's back-history status_updates
 * (the pre-window "introduced / referred / [hearing noticed]" lines) and classifies
 * that history to a starting stage. It does NOT run day 1 and NOTHING dies at seed
 * time — the day-1 checkpoints are applied later by run-day.js. Pass --day0 to skip
 * even the history and leave bills fully blank.
 *
 * See docs/superpowers/specs/2026-08-27-sim-week-design.md.
 */

import { db } from '../../db/kysely/client.js';
import { COMMITTEES, ROSTER } from '../../server/services/sim/scenarios.js';
import { sentinelUrl } from '../../server/services/sim/simRunner.js';
import { buildBillLog } from '../../server/services/sim/simEngine.js';
import { classifyStatusWithLLM } from '../../server/services/statusClassifierService.js';
import { resolveSimUser, resolveSimUserByEmail, ensureFollow } from '../../server/services/sim/simUsers.js';
import { seedSimCommittees } from './seed-committees.js';

const force = process.argv.includes('--force');
const day0Only = process.argv.includes('--day0');

// Extra addresses that should also receive the sim digests/deadline mail. Each
// gets a `user` row (if missing) and a follow on every sim bill. Their follows
// are cleaned up by reset.js (it clears user_bills by sim bill_id).
// For now: just the primary sim user (ALERT_EMAIL). Add 'janine@purplemaia.org'
// back here once the Resend domain is verified and sending to others works.
const EXTRA_FOLLOWER_EMAILS = ['janine@purplemaia.org'];

async function main() {
  const urls = ROSTER.map((b) => sentinelUrl(b.simId));
  const existing = await db
    .selectFrom('bills')
    .select(['id', 'bill_url'])
    .where('bill_url', 'in', urls)
    .execute();

  if (existing.length > 0 && !force) {
    console.error(`Refusing to seed: ${existing.length} sim bills already exist. Use --force to recreate (or run reset.js first).`);
    process.exit(1);
  }

  const user = await resolveSimUser();
  console.log(`Sim user: ${user.email} (${user.id})${user.created ? ' [created]' : ''}`);

  // Additional followers that should get the same sim mail (e.g. janine@).
  const extraUsers = [];
  for (const email of EXTRA_FOLLOWER_EMAILS) {
    const u = await resolveSimUserByEmail(email);
    console.log(`Extra follower: ${u.email} (${u.id})${u.created ? ' [created]' : ''}`);
    extraUsers.push(u);
  }
  const followers = [user, ...extraUsers];

  // Seed the fake sim committees + tagged chair emails (SIM-JHA, SIM-CPN) so a
  // single seed run stands up everything the sim needs. Idempotent.
  const committees = await seedSimCommittees();
  console.log(`Sim committees: ${committees.map((c) => `${c.committee} -> ${c.email}`).join(', ')}`);

  let created = 0;
  let refreshed = 0;
  const billIds = new Map(); // simId -> bills.id, for history population below
  for (const bill of ROSTER) {
    const url = sentinelUrl(bill.simId);
    const values = {
      bill_number: bill.billNumber,
      bill_title: bill.title ?? `SIM WEEK — ${bill.simId} (${bill.scenario}${bill.isAuto ? ', auto' : ''})`,
      committee_assignment: COMMITTEES.origin,
      description: bill.description ?? 'sim week',
      current_status_string: '',
      bill_status: null,
      dead: false,
      archived: false,
      food_related: true,
      year: 2027,
      updated_at: new Date(),
    };

    const found = existing.find((e) => e.bill_url === url);
    let billId;
    if (found) {
      billId = found.id;
      await db.updateTable('bills').set(values).where('id', '=', billId).execute();
      // Clear any stale status updates so a re-seed is a true day-0 reset.
      await db.deleteFrom('status_updates').where('bill_id', '=', billId).execute();
      refreshed++;
    } else {
      const inserted = await db
        .insertInto('bills')
        .values({ bill_url: url, created_at: new Date(), ...values })
        .returning('id')
        .executeTakeFirst();
      billId = inserted.id;
      created++;
    }

    for (const f of followers) await ensureFollow(f.id, billId);
    billIds.set(bill.simId, billId);
  }

  console.log(`Seeded sim bills: ${created} created, ${refreshed} refreshed, ${ROSTER.length} bills followed by ${followers.length} user(s).`);

  if (day0Only) {
    console.log('Left bills fully blank (no status_updates) per --day0.');
    console.log('Next: node scripts/sim/run-day.js --date=2026-09-14  (or run-week.js)');
    await db.destroy();
    return;
  }

  // Populate ONLY the back-history status_updates for each bill (buildBillLog with
  // simDay 0 returns just the stamped history lines — no steps, nothing dies), then
  // run the DETERMINISTIC classifier over that history to set the starting stage.
  // (classifyStatusWithLLM is the deterministic classifier — no LLM/network for the
  // stage.) Day-1 CHECKPOINTS are NOT applied here; run-day.js does that later.
  console.log('\nPopulated history-only stages (deterministic classify; no day advanced, nothing dies):');
  for (const bill of ROSTER) {
    const billId = billIds.get(bill.simId);
    const { updates } = buildBillLog(bill, 0);
    if (updates.length) {
      await db.insertInto('status_updates').values(
        updates.map((u) => ({ bill_id: billId, date: u.date, chamber: u.chamber, statustext: u.statustext }))
      ).execute();
    }
    const stage = await classifyStatusWithLLM(billId);
    await db.updateTable('bills')
      .set({
        bill_status: stage,
        dead: false,
        committee_assignment: COMMITTEES.origin,
        current_status_string: updates[0]?.statustext ?? '',
        updated_at: new Date(),
      })
      .where('id', '=', billId)
      .execute();
    console.log(`  ${bill.simId} ${bill.billNumber}: ${stage}`);
  }
  console.log('\nNext: node scripts/sim/run-day.js --date=2026-09-14  (advance to day 1)');
  await db.destroy();
}

main().catch(async (err) => {
  console.error(err);
  try { await db.destroy(); } catch { /* ignore */ }
  process.exit(1);
});
