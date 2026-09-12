/**
 * Morning "current standings" briefing for Sim Week — the 5AM reminder.
 *
 *   node scripts/sim/standings.js               # date defaults to TODAY (HST)
 *   node scripts/sim/standings.js --date=2026-09-16
 *   node scripts/sim/standings.js --dry         # build + report, no email
 *
 * Unlike run-day.js (the 5PM "session over" run that ADVANCES the sim and emails a
 * status-change digest), this ADVANCES NOTHING. It reads each followed sim bill's
 * CURRENT stage straight from the DB — the state the 5PM run already persisted —
 * and re-sends it as a briefing that shows the current stage (no old→new arrow)
 * plus any live deadline/testimony window. No re-classification, no DB writes, so
 * it is safe to run on the ephemeral cron container with no shared state.
 *
 * See docs/superpowers/specs/2026-08-27-sim-week-design.md.
 */

import { db } from '../../db/kysely/client.js';
import { simDayFor, sentinelUrl } from '../../server/services/sim/simRunner.js';
import { ROSTER } from '../../server/services/sim/scenarios.js';
import {
  checkApproachingDeadlines,
  checkTestimonyDeadlines,
} from '../../server/services/notifications/deadline-warnings.js';
import { sendCurrentStandingsEmail } from '../../server/services/notifications/bill-updates-digest.js';

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.split('=')[1] : undefined;
}

/** Today's date as YYYY-MM-DD in Hawaiʻi (UTC−10, no DST). */
function todayHst() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Honolulu' }).format(new Date());
}

const date = arg('--date') ?? todayHst();
const dry = process.argv.includes('--dry');

/** Live (not-dead, classified) sim bills — the same scope run-day's warnings use. */
async function fetchSimBills() {
  const urls = ROSTER.map((b) => sentinelUrl(b.simId));
  return db
    .selectFrom('bills')
    .select(['id', 'bill_number', 'bill_title', 'bill_status', 'current_status_string', 'committee_assignment'])
    .where('bill_url', 'in', urls)
    .where('dead', '=', false)
    .where('bill_status', 'is not', null)
    .execute();
}
async function fetchSimBillsWithStatus() {
  const bills = await fetchSimBills();
  if (bills.length === 0) return [];
  const rows = await db
    .selectFrom('status_updates')
    .select(['bill_id', 'date', 'statustext'])
    .where('bill_id', 'in', bills.map((b) => b.id))
    .execute();
  const byBill = new Map();
  for (const r of rows) {
    if (!byBill.has(r.bill_id)) byBill.set(r.bill_id, []);
    byBill.get(r.bill_id).push({ date: r.date, statustext: r.statustext });
  }
  return bills.map((b) => ({ ...b, statusUpdates: byBill.get(b.id) ?? [] }));
}

/** Followers (user + email) for a set of bill ids. Mirrors the notifier's fetch. */
async function fetchFollowers(billIds) {
  if (billIds.length === 0) return [];
  return db
    .selectFrom('user_bills as ub')
    .innerJoin('user as u', 'u.id', 'ub.user_id')
    .where('ub.bill_id', 'in', billIds)
    .select(['ub.bill_id as bill_id', 'u.id as user_id', 'u.email as email'])
    .execute();
}

/** Shape a raw deadline/testimony warning into the digest's warning item. */
function warningToItem(w) {
  return {
    bill_id: w.bill.id,
    deadline_name: w.nextName,
    deadline_date: w.nextDate,
    days_left: w.daysLeft,
    hours_left: w.hoursLeft ?? null,
    testimony: Boolean(w.testimony),
    tier: w.tier,
  };
}

async function main() {
  const simDay = simDayFor(date);
  if (simDay === 0) {
    console.log(`${date} is outside the sim window (Sept 14–18). No-op.`);
    await db.destroy();
    return;
  }

  const bills = await fetchSimBills();
  if (bills.length === 0) {
    console.log('No live sim bills to report. (Seed with scripts/sim/seed.js.)');
    await db.destroy();
    return;
  }
  const billById = new Map(bills.map((b) => [b.id, b]));

  // Live deadlines/testimony windows, scoped to sim bills — one warning per bill.
  // Anchor "now" to the SIM date (8:00AM HST), not the real machine clock — otherwise
  // "hours until the hearing" is computed against the wrong day and prints nonsense.
  const simNowMs = new Date(`${date}T08:00:00-10:00`).getTime();
  const [approaching, testimony] = await Promise.all([
    checkApproachingDeadlines(date, { fetchBills: fetchSimBills }),
    checkTestimonyDeadlines(date, { fetchBills: fetchSimBillsWithStatus, nowMs: simNowMs }),
  ]);
  const warnByBill = new Map();
  const rank = (item, testi) => (testi ? 0 : item.tier === '3' ? 1 : 2);
  for (const w of [...approaching, ...testimony]) {
    const item = warningToItem(w);
    const existing = warnByBill.get(item.bill_id);
    if (!existing || rank(item, w.testimony) < rank(existing, existing.testimony)) {
      warnByBill.set(item.bill_id, item);
    }
  }

  // Bucket every followed sim bill under its user, carrying current status + warning.
  const followers = await fetchFollowers(bills.map((b) => b.id));
  const byUser = new Map();
  for (const f of followers) {
    if (!f.email) continue;
    const bill = billById.get(f.bill_id);
    if (!bill) continue;
    if (!byUser.has(f.user_id)) byUser.set(f.user_id, { email: f.email, items: [] });
    byUser.get(f.user_id).items.push({
      bill_id: bill.id,
      bill_number: bill.bill_number,
      bill_title: bill.bill_title,
      current_status: bill.bill_status,
      raw_status: bill.current_status_string ?? null,
      warning: warnByBill.get(bill.id) ?? null,
      hearing_today: null,
    });
  }

  console.log(`\n=== Morning briefing — Sim day ${simDay} (${date}) ===`);
  console.log(`Live bills: ${bills.length}. Deadline/testimony warnings: ${warnByBill.size}. Users: ${byUser.size}.`);
  for (const [, { email, items }] of byUser) {
    console.log(`  ${email}: ${items.length} bill(s)`);
  }

  if (dry) {
    console.log('[dry] skipping email send.');
    await db.destroy();
    return;
  }

  let sent = 0;
  for (const { email, items } of byUser.values()) {
    if (!items.length) continue;
    await sendCurrentStandingsEmail(email, items);
    sent++;
  }
  console.log(`Morning briefing dispatched to ${sent} user(s) (subject to RESEND_API_KEY).`);
  await db.destroy();
}

main().catch(async (err) => {
  console.error(err);
  try { await db.destroy(); } catch { /* ignore */ }
  process.exit(1);
});
