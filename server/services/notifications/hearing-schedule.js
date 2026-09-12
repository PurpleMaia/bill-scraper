// Extract a bill's upcoming hearing date/time from its status_updates text and derive
// the two things the digests need: "is the hearing today?" and "is the testimony
// window closing (hearing within ~24h)?".
//
// There is NO hearing_date column — the Capitol embeds the hearing in the scheduling
// status line, e.g.
//   "The committee(s) on AEN will hold a public hearing on 02-03-25 1:02PM; Conference Room 224 ..."
// so we parse it out of `statustext`. All functions are pure (no DB, no clock) so they
// unit-test against fixture rows, mirroring dead-bill.js / statusClassifier.js.

const DAY_MS = 24 * 60 * 60 * 1000;

// The Capitol schedules a hearing with either of two lead-ins:
//   "...will hold a public hearing on 02-03-25 1:02PM; Conference Room 224"
//   "Bill scheduled to be heard by LAB on Tuesday, 02-11-25 9:00AM in House conference room 309"
// So we anchor on " on " optionally preceded by a weekday ("on Tuesday, ") and capture the
// MM-DD-YY(YY) date plus an optional H:MM(AM|PM) time. Slashes are accepted for the date.
const WEEKDAYS = 'Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday';
const HEARING_RE = new RegExp(
  `\\bon\\s+(?:(?:${WEEKDAYS}),?\\s+)?` + // " on " + optional "Tuesday, "
    `(\\d{1,2})[-/](\\d{1,2})[-/](\\d{2,4})` + // MM-DD-YY(YY)
    `(?:\\s+(\\d{1,2}):(\\d{2})\\s*([AP]M))?`, // optional H:MM AM/PM
  'i',
);

/**
 * Normalize a 2- or 4-digit year to a full year. 2-digit years map to 2000-2099
 * (the Capitol only publishes current-session hearings, so this is safe).
 * @param {string} yy
 * @returns {number}
 */
function fullYear(yy) {
  const n = parseInt(yy, 10);
  return yy.length <= 2 ? 2000 + n : n;
}

// Only parse a date out of lines that are actually about scheduling a hearing — otherwise a
// stray "on MM-DD-YY" in some other status line could be mistaken for a hearing date. These
// are the same scheduling signals the status classifier keys on.
const SCHEDULING_RE = /hearing|scheduled to be heard|has scheduled|decision making|Meeting Scheduled/i;

/**
 * Parse a single status line into a hearing date (YYYY-MM-DD) + optional time label.
 * Returns null when the line is not a scheduling line or has no parseable date.
 * @param {string} statustext
 * @returns {{ date: string, time: string|null } | null}
 */
export function parseHearingFromText(statustext) {
  const text = statustext || '';
  if (!SCHEDULING_RE.test(text)) return null; // not a hearing/scheduling line
  const m = HEARING_RE.exec(text);
  if (!m) return null;
  const [, mm, dd, yy, hh, min, ap] = m;
  const month = parseInt(mm, 10);
  const day = parseInt(dd, 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = `${fullYear(yy)}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const time = hh ? `${parseInt(hh, 10)}:${min}${ap.toUpperCase()}` : null;
  return { date, time };
}

// A hearing scheduling line is SUPERSEDED once the committee has acted on the measure
// or the bill has moved past that hearing — even if the scheduled date itself hasn't
// arrived on the calendar (a hearing held and passed the SAME day, or a stale notice a
// later run leapfrogged). Any of these later status shapes means the hearing is done and
// must not warn: a committee recommendation/deferral, a floor reading/vote, a transmittal
// or crossover receipt, or conferee appointments. Same signals dead-bill.js/statusClassifier
// key on for progression.
const SUPERSEDING_RE = /recommend|deferred|Passed (First|Second|Third) Reading|Received from the (House|Senate)|Transmitted to|Conferees Appointed|carried over|be PASSED|be HELD|re-referred|referred to/i;

/**
 * Has the committee acted on / the bill moved past a hearing scheduled for `hearingDate`?
 * A superseding status line dated on OR after the hearing date means the hearing happened
 * (or was leapfrogged) and its testimony window is closed. Order-independent: keyed on the
 * status DATE, not row position (same-date row order is not guaranteed).
 * @param {Array<{ date?: string, statustext: string }>} statusUpdates
 * @param {string} hearingDate - YYYY-MM-DD of the scheduled hearing
 * @returns {boolean}
 */
function hearingSuperseded(statusUpdates, hearingDate) {
  for (const row of statusUpdates ?? []) {
    if (parseHearingFromText(row.statustext)) continue; // scheduling lines don't supersede
    if (!SUPERSEDING_RE.test(row.statustext || '')) continue;
    const rowDate = row.date ? String(row.date).slice(0, 10) : null;
    if (rowDate && rowDate >= hearingDate) return true;
  }
  return false;
}

/**
 * The bill's next upcoming hearing (on/after `today`) parsed from its status_updates.
 * A bill can have several scheduling lines over the session; we want the earliest
 * hearing that has not yet passed AND has not been superseded by later committee action
 * (a hearing the committee already acted on is not "upcoming", even on its own date).
 * Returns null if none is upcoming.
 * @param {Array<{ date?: string, statustext: string }>} statusUpdates
 * @param {string} today - YYYY-MM-DD
 * @returns {{ date: string, time: string|null } | null}
 */
export function getUpcomingHearing(statusUpdates, today) {
  let best = null;
  for (const row of statusUpdates ?? []) {
    const hearing = parseHearingFromText(row.statustext);
    if (!hearing || hearing.date < today) continue; // ignore past hearings
    if (hearingSuperseded(statusUpdates, hearing.date)) continue; // committee already acted
    if (!best || hearing.date < best.date) best = hearing;
  }
  return best;
}

/**
 * Whole days from `today` until `date` (both YYYY-MM-DD). 0 = today, 1 = tomorrow.
 * @param {string} date
 * @param {string} today
 * @returns {number}
 */
export function daysUntilHearing(date, today) {
  return Math.round((new Date(`${date}T00:00:00Z`) - new Date(`${today}T00:00:00Z`)) / DAY_MS);
}

// Hawaiʻi has no DST; HST is a fixed UTC-10.
const HST_OFFSET = '-10:00';

/**
 * Parse a hearing time label ("2:00PM", "1:02PM", "10:30AM") into { hour24, minute },
 * or null if it can't be parsed.
 * @param {string|null|undefined} time
 * @returns {{ hour24: number, minute: number } | null}
 */
export function parseTimeLabel(time) {
  const m = /^(\d{1,2}):(\d{2})(AM|PM)$/i.exec((time || '').trim());
  if (!m) return null;
  let hour = parseInt(m[1], 10) % 12;
  if (/PM/i.test(m[3])) hour += 12;
  return { hour24: hour, minute: parseInt(m[2], 10) };
}

/**
 * Whole hours from `nowMs` until a hearing at `date` (YYYY-MM-DD) + `time` label,
 * interpreting the hearing time as HST. Rounded, never negative. Returns null when
 * there is no parseable time (caller should fall back to a day-granularity message).
 * @param {string} date - YYYY-MM-DD (HST calendar date)
 * @param {string|null} time - e.g. "2:00PM"
 * @param {number} nowMs - current time in epoch ms (pass Date.now())
 * @returns {number|null}
 */
export function hoursUntilHearing(date, time, nowMs) {
  const t = parseTimeLabel(time);
  if (!t) return null;
  const hh = String(t.hour24).padStart(2, '0');
  const mm = String(t.minute).padStart(2, '0');
  const hearingMs = new Date(`${date}T${hh}:${mm}:00${HST_OFFSET}`).getTime();
  if (Number.isNaN(hearingMs)) return null;
  return Math.max(0, Math.round((hearingMs - nowMs) / (60 * 60 * 1000)));
}

/**
 * Does this bill have a hearing scheduled for `today`?
 * @param {Array<{ date?: string, statustext: string }>} statusUpdates
 * @param {string} today - YYYY-MM-DD
 * @returns {{ date: string, time: string|null } | null} the hearing if it's today, else null
 */
export function hearingToday(statusUpdates, today) {
  const next = getUpcomingHearing(statusUpdates, today);
  return next && next.date === today ? next : null;
}

/**
 * Is the testimony window closing? Testimony is due 24h after the hearing NOTICE (the
 * committee issues the notice 48h ahead for House / 72h for Senate, but the testimony
 * cutoff is a flat notice+24h, same for both chambers). We scrape once/day and only
 * have day-granularity, so we approximate the open window by flagging bills whose next
 * hearing is today or tomorrow (daysUntil <= 1) — i.e. testimony is effectively due now.
 * @param {Array<{ date?: string, statustext: string }>} statusUpdates
 * @param {string} today - YYYY-MM-DD
 * @returns {{ date: string, time: string|null, daysUntil: number } | null}
 */
export function testimonyClosing(statusUpdates, today) {
  const next = getUpcomingHearing(statusUpdates, today);
  if (!next) return null;
  const d = daysUntilHearing(next.date, today);
  return d <= 1 ? { ...next, daysUntil: d } : null;
}
