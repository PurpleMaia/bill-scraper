/**
 * Sim Week runner — DB glue between the pure engine and the real pipeline.
 *
 * For each sim bill on a given date, it:
 *   1. reads the contact flag (JSON file) and latest testimony stance (DB),
 *   2. builds the cumulative status log with the pure engine,
 *   3. replaces the bill's status_updates (delete-then-insert),
 *   4. runs the REAL deterministic classifier and writes bill_status,
 *   5. sets `dead` from the explicit-deferral check ONLY (never the real
 *      deadline path — sim dates are after all real session deadlines, spec §6),
 *   6. returns a statusChanges[] compatible with sendStatusChangeNotifications.
 *
 * Bills are isolated by the sentinel URL test://sim-week/<SIM_ID>.
 * See docs/superpowers/specs/2026-08-27-sim-week-design.md.
 */

import { db } from '../../../db/kysely/client.js';
import { classifyStatusWithLLM } from '../statusClassifierService.js';
import { isExplicitlyDeferred } from '../dead-bill.js';
import { computeChange } from '../statusChange.js';
import { buildBillLog, normalizeStance } from './simEngine.js';
import { ROSTER, SIM_DATES, SENTINEL_PREFIX } from './scenarios.js';
import { readFlags } from './flagStore.js';

export const sentinelUrl = (simId) => `${SENTINEL_PREFIX}${simId}`;

/** sim-day (1..5) for a YYYY-MM-DD date, or 0 if outside the window. */
export function simDayFor(dateStr) {
  const idx = SIM_DATES.indexOf(dateStr);
  return idx === -1 ? 0 : idx + 1;
}

/**
 * Aggregate testimony stance for a bill id across ALL submitted testimonies, or
 * null if none submitted. Every testimony row is one person's position; we tally
 * support vs oppose and return the MAJORITY, not just the latest single vote — a
 * bill moves forward on the collective show of support, so many opposing voices
 * can sink it even if the most recent testimony happened to be supportive.
 *
 * Support wins only when support strictly outnumbers oppose. A tie (or no clear
 * support) resolves to oppose — the same safe default the per-vote path used:
 * a bill advances only on a clear show of support (spec §7b).
 *
 * The `testimonies` table belongs to the front-facing app and may not exist in
 * every environment; if it's absent we treat it as "no testimony" (null) rather
 * than failing the bill.
 *
 * @returns {Promise<{stance: ('support'|'oppose'|null), support: number, oppose: number}>}
 */
async function aggregateStance(billId) {
  try {
    const rows = await db
      .selectFrom('testimonies')
      .select(['position'])
      .where('bill_id', '=', billId)
      .where('submitted_at', 'is not', null)
      .execute();
    if (rows.length === 0) return { stance: null, support: 0, oppose: 0 };
    let support = 0;
    let oppose = 0;
    for (const r of rows) {
      if (normalizeStance(r.position) === 'support') support++;
      else oppose++;
    }
    return { stance: support > oppose ? 'support' : 'oppose', support, oppose };
  } catch (err) {
    if (/relation .*testimonies.* does not exist/i.test(err.message)) return { stance: null, support: 0, oppose: 0 };
    throw err;
  }
}

/** Replace a bill's status_updates with the given newest-first log. */
async function replaceStatusUpdates(billId, updates) {
  await db.deleteFrom('status_updates').where('bill_id', '=', billId).execute();
  if (!updates?.length) return;
  await db.insertInto('status_updates').values(
    updates.map((u) => ({ bill_id: billId, date: u.date, chamber: u.chamber, statustext: u.statustext }))
  ).execute();
}

/**
 * Advance all sim bills to the state implied by `dateStr`, running the real
 * classifier and producing change records. Outside the sim window this is a no-op.
 *
 * @param {string} dateStr - YYYY-MM-DD
 * @returns {Promise<{ simDay: number, statusChanges: object[], summary: object[] }>}
 */
export async function runSimDay(dateStr) {
  const simDay = simDayFor(dateStr);
  if (simDay === 0) {
    return { simDay: 0, statusChanges: [], summary: [] };
  }

  const flags = await readFlags();
  const statusChanges = [];
  const summary = [];

  for (const bill of ROSTER) {
    try {
      const url = sentinelUrl(bill.simId);
      const row = await db
        .selectFrom('bills')
        .select(['id', 'bill_status', 'bill_number', 'bill_title', 'dead'])
        .where('bill_url', '=', url)
        .executeTakeFirst();
      if (!row) {
        summary.push({ simId: bill.simId, skipped: 'not seeded' });
        continue;
      }

      const contacted = flags[bill.simId]?.action === 'contact';
      const { stance, support, oppose } = await aggregateStance(row.id);

      const { updates, dead: engineDead } = buildBillLog(bill, simDay, { contacted, stance });
      await replaceStatusUpdates(row.id, updates);

      const oldStatus = row.bill_status ?? null;
      const oldDead = row.dead ?? false;

      // Real deterministic classifier (read-only) -> new stage.
      const newStatus = await classifyStatusWithLLM(row.id);

      // Dead via explicit committee deferral OR the engine's checkpoint-failure
      // flag. A bill that dies before any hearing was scheduled (e.g. a
      // never-contacted scenario-1 bill stuck at `introduced`) has NO deferral
      // line, so the deferral check alone would miss it — the engine's `dead`
      // flag carries those. We still never use the real deadline path (sim dates
      // are after all real session deadlines, spec §6).
      const newDead = engineDead || isExplicitlyDeferred(updates);

      await db.updateTable('bills')
        .set({
          bill_status: newStatus,
          dead: newDead,
          current_status_string: updates[0]?.statustext ?? null,
          updated_at: new Date(),
        })
        .where('id', '=', row.id)
        .execute();

      const change = computeChange({
        billId: row.id,
        billNumber: row.bill_number,
        billTitle: row.bill_title,
        oldStatus,
        newStatus,
        oldDead,
        newDead,
      });
      if (change) {
        change.raw_status = updates[0]?.statustext ?? null;
        statusChanges.push(change);
      }

      summary.push({
        simId: bill.simId,
        billNumber: row.bill_number,
        stage: newStatus,
        dead: newDead,
        changed: Boolean(change),
        testimony: { stance, support, oppose },
      });
    } catch (err) {
      // Isolate failures per bill, like the real scrape.
      console.error(`[SIM] ${bill.simId} failed:`, err.message);
      summary.push({ simId: bill.simId, error: err.message });
    }
  }

  return { simDay, statusChanges, summary };
}
