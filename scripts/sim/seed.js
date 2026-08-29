/**
 * Seed the 20 Sim Week bills and follow them as the sim user.
 *
 *   node scripts/sim/seed.js            # create sim bills + follows (refuses if present)
 *   node scripts/sim/seed.js --force    # recreate even if sim bills already exist
 *   node scripts/sim/seed.js --day0     # leave bills blank (no status/stage) — legacy day-0 seed
 *
 * Bills are isolated by bill_url = test://sim-week/<SIM_ID>.
 *
 * By DEFAULT the seed populates each bill to its DAY-1 stage (Sept 14) by running
 * the real sim engine once, so a freshly seeded board already shows stages
 * (scenario-1 bills at scheduled1, scenario-2 auto bills at waiting2, and
 * scenario-2 user-driven bills DEAD — their day-1 checkpoint is a testimony that
 * hasn't happened yet). Pass --day0 to skip that and leave bills blank the way
 * run-day.js expects to advance them itself.
 *
 * See docs/superpowers/specs/2026-08-27-sim-week-design.md.
 */

import { db } from '../../db/kysely/client.js';
import { COMMITTEES, ROSTER, SIM_DATES } from '../../server/services/sim/scenarios.js';
import { sentinelUrl, runSimDay } from '../../server/services/sim/simRunner.js';
import { resolveSimUser, ensureFollow } from '../../server/services/sim/simUsers.js';
import { seedSimCommittees } from './seed-committees.js';

const force = process.argv.includes('--force');
const day0Only = process.argv.includes('--day0');

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

  // Seed the fake sim committees + tagged chair emails (SIM-JHA, SIM-CPN) so a
  // single seed run stands up everything the sim needs. Idempotent.
  const committees = await seedSimCommittees();
  console.log(`Sim committees: ${committees.map((c) => `${c.committee} -> ${c.email}`).join(', ')}`);

  let created = 0;
  let refreshed = 0;
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

    await ensureFollow(user.id, billId);
  }

  console.log(`Seeded sim bills: ${created} created, ${refreshed} refreshed, ${ROSTER.length} follows ensured.`);

  if (day0Only) {
    console.log('Left bills at day-0 (blank) per --day0.');
    console.log('Next: node scripts/sim/run-day.js --date=2026-09-14  (or run-week.js)');
    await db.destroy();
    return;
  }

  // Populate every bill to its DAY-1 stage using the real sim engine (same code
  // run-day.js uses), so a freshly seeded board already shows stages. No email is
  // sent here — this only writes status_updates + bill_status + dead.
  const day1 = SIM_DATES[0];
  const { summary } = await runSimDay(day1);
  console.log(`\nPopulated day-1 (${day1}) stages:`);
  for (const s of summary) {
    if (s.error) console.log(`  ${s.simId}: ERROR ${s.error}`);
    else console.log(`  ${s.simId} ${s.billNumber}: ${s.stage}${s.dead ? ' [DEAD]' : ''}`);
  }
  console.log('\nNext: node scripts/sim/run-day.js --date=2026-09-15  (advance to day 2, sends email)');
  await db.destroy();
}

main().catch(async (err) => {
  console.error(err);
  try { await db.destroy(); } catch { /* ignore */ }
  process.exit(1);
});
