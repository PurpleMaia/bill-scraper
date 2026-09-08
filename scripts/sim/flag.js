/**
 * Sim Week action flagger.
 *
 * `--bill` / `--clear` take the real bill NUMBER (e.g. HB9003), matching what the
 * dashboard shows; it's resolved to the internal sim id via the roster.
 *
 * CONTACT (manual JSON flag; the runner reads this before the next scrape):
 *   node scripts/sim/flag.js --bill HB9003 --action contact
 *   node scripts/sim/flag.js --list
 *   node scripts/sim/flag.js --clear HB9003
 *
 * TESTIMONY (test convenience — inserts real `testimonies` rows against the sim
 * bill so the pass/defer path can be exercised without the front-facing app).
 * The runner tallies ALL testimonies for a bill (majority support vs oppose), so
 * you can simulate a crowd, not just one vote:
 *   node scripts/sim/flag.js --bill HB9004 --action testify --stance support
 *   node scripts/sim/flag.js --bill HB9005 --action testify --stance oppose
 *   node scripts/sim/flag.js --bill HB9006 --action testify --support 7 --oppose 3
 *
 * --stance X is shorthand for one row of X. --support N / --oppose M insert N
 * supporting and M opposing rows (each a distinct author_name) in one call.
 *
 * See docs/superpowers/specs/2026-08-27-sim-week-design.md §7.
 */

import { db } from '../../db/kysely/client.js';
import { ROSTER } from '../../server/services/sim/scenarios.js';
import { sentinelUrl } from '../../server/services/sim/simRunner.js';
import { resolveSimUser, resolveSimTestifiers } from '../../server/services/sim/simUsers.js';
import { readFlags, setContactFlag, clearFlag } from '../../server/services/sim/flagStore.js';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

/**
 * Resolve a user-supplied bill NUMBER (e.g. HB9003) to its internal sim id.
 * Case-insensitive. Throws if the number isn't in the roster. Also accepts a
 * raw sim id (SIM-03) as a fallback so older invocations keep working.
 */
function resolveSimId(billNumber) {
  const needle = String(billNumber).trim().toUpperCase();
  const match = ROSTER.find(
    (b) => b.billNumber.toUpperCase() === needle || b.simId.toUpperCase() === needle
  );
  if (!match) throw new Error(`Unknown bill: ${billNumber}`);
  return match.simId;
}

async function main() {
  if (process.argv.includes('--list')) {
    const flags = await readFlags();
    const keys = Object.keys(flags);
    if (keys.length === 0) console.log('No pending flags.');
    for (const k of keys) console.log(`${k}: ${flags[k].action} @ ${flags[k].flaggedAt}`);
    return;
  }

  const clearArg = arg('--clear');
  if (clearArg) {
    const simId = resolveSimId(clearArg);
    await clearFlag(simId);
    console.log(`Cleared flag for ${clearArg}.`);
    return;
  }

  const billArg = arg('--bill');
  const action = arg('--action');
  if (!billArg || !action) throw new Error('Usage: --bill <BILL_NUMBER> --action contact|testify [--stance support|oppose]');
  const simId = resolveSimId(billArg);

  if (action === 'contact') {
    await setContactFlag(simId, new Date().toISOString());
    console.log(`Flagged ${billArg} as CONTACTED. It will advance on the next run-day/cron.`);
    return;
  }

  if (action === 'testify') {
    // Accept either --stance X (one row) or --support N / --oppose M (a crowd).
    const stance = (arg('--stance') || '').toLowerCase();
    let nSupport = Number(arg('--support') || 0);
    let nOppose = Number(arg('--oppose') || 0);
    if (stance === 'support') nSupport += 1;
    else if (stance === 'oppose') nOppose += 1;
    else if (stance) throw new Error('--stance must be support|oppose');

    if (nSupport === 0 && nOppose === 0) {
      throw new Error('--action testify requires --stance support|oppose (or --support N / --oppose M)');
    }
    if (!Number.isInteger(nSupport) || !Number.isInteger(nOppose) || nSupport < 0 || nOppose < 0) {
      throw new Error('--support / --oppose must be non-negative integers');
    }

    const url = sentinelUrl(simId);
    const bill = await db.selectFrom('bills').select('id').where('bill_url', '=', url).executeTakeFirst();
    if (!bill) throw new Error(`Sim bill ${simId} not seeded — run scripts/sim/seed.js first.`);

    // testimonies has a unique (user_id, bill_id) constraint, so each testimony
    // needs a DISTINCT user. Resolve as many throwaway testifier users as the
    // crowd needs, then assign them across the support/oppose split.
    const testifiers = await resolveSimTestifiers(nSupport + nOppose);

    // Replace this bill's testimonies so counts are exact (not additive across
    // repeated flag runs). reset.js also clears these by bill_id.
    await db.deleteFrom('testimonies').where('bill_id', '=', bill.id).execute();

    const rows = [];
    let t = 0;
    for (let i = 0; i < nSupport; i++, t++) {
      rows.push({ bill_id: bill.id, user_id: testifiers[t].id, position: 'support', author_name: `Sim Supporter ${i + 1}`, submitted_at: new Date() });
    }
    for (let i = 0; i < nOppose; i++, t++) {
      rows.push({ bill_id: bill.id, user_id: testifiers[t].id, position: 'oppose', author_name: `Sim Opponent ${i + 1}`, submitted_at: new Date() });
    }
    await db.insertInto('testimonies').values(rows).execute();

    const majority = nSupport > nOppose ? 'support' : 'oppose';
    const outcome = nSupport > nOppose ? 'PASS' : 'be DEFERRED';
    console.log(`Recorded ${nSupport} support + ${nOppose} oppose testimony for ${billArg} (majority ${majority}). It will ${outcome} at its testimony checkpoint on the next run.`);
    return;
  }

  throw new Error(`Unknown action: ${action}`);
}

main()
  .then(async () => { await db.destroy(); })
  .catch(async (err) => {
    console.error(err.message);
    try { await db.destroy(); } catch { /* ignore */ }
    process.exit(1);
  });
