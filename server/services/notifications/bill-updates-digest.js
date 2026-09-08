import dotenv from 'dotenv';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { statusLabel, diffBillState, describeChange } from '../statusChange.js';
dotenv.config();

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const ALERT_FROM = process.env.ALERT_FROM || 'Hawaiʻi Bill Tracker <onboarding@resend.dev>';
const APP_URL = process.env.APP_URL || 'https://foodplus.purplemaia.org';

// The logo is embedded as a CID inline attachment rather than hotlinked. A
// remote <img src> only works if APP_URL serves this repo's public/email/ dir —
// but APP_URL points at the separate front-facing app, which does not host it
// (every /email/*.png path 404s), so the logo never rendered. Embedding via
// cid: removes the hosting dependency entirely and renders in Gmail too (unlike
// a base64 data: URI, which Gmail strips).
const LOGO_CID = 'foodplus-logo';
const LOGO_SRC = `cid:${LOGO_CID}`;

// Load the PNG once at module init. Path is relative to this file so it works
// from both the source tree and a build. If it's ever missing, fall back to no
// attachment (the alt text still shows) rather than crashing the send.
const __dirname = dirname(fileURLToPath(import.meta.url));
let LOGO_ATTACHMENT = null;
try {
  const logoPath = resolve(__dirname, '../../../public/email/foodplus-logo.png');
  LOGO_ATTACHMENT = {
    filename: 'foodplus-logo.png',
    content: readFileSync(logoPath).toString('base64'),
    content_id: LOGO_CID,
  };
} catch (err) {
  console.error('[NOTIFY] logo asset not found; emails will send without an embedded logo:', err.message);
}

//  brand palette (from app globals.css, HSL → hex). Light-mode values.
//  Page background is a clean light grey (not near-white cream): the Gmail app
//  blends near-white surfaces to a muddy dark grey, whereas a light grey page +
//  PURE-WHITE cards survive Gmail's dark-mode blend far better. Text is pushed to
//  near-black for contrast that survives the blend.
const COLOR = {
  cream: '#F1F3F4',     // page background — clean light grey (was #FAF8F5 cream)
  white: '#FFFFFF',     // cards — pure white (blends cleanly in Gmail dark)
  teal: '#255E6D',
  tealSoft: '#DCE8E8',
  text: '#1A1D1F',      // near-black body text (was #2D3436)
  muted: '#5A6167',
  border: '#D7DBDE',
  coral: '#BE4934',
  olive: '#A8B660',
  gold: '#B8860B',      // "hearing today" highlight (warm, distinct from teal/coral)
  goldSoft: '#FBF3DC',  // its soft background
};

// Note: dark mode does NOT use a separate dark palette. The email pins its light
// appearance (cream page, white cards, teal accent) in dark mode via the
// prefers-color-scheme block in renderEmailShell, so there is no DARK palette.

/**
 * Build the plain-text body of a per-user bill-update digest.
 * @param {string[]} lines - one describeChange() line per changed bill
 * @returns {string}
 */
export function buildBillUpdateBody(lines) {
  return [
    'Updates on bills you follow:',
    '',
    ...lines.map(l => `- ${l}`),
    '',
    'You are receiving this because you follow these bills in the Hawaiʻi Bill Tracker.',
    'Made by Purple Maiʻa Foundation ʻĀina Foundry, and Hawaiʻi Food+ Policy.',
  ].join('\n');
}

/**
 * Escape user/bill-derived text for safe inclusion in HTML.
 * @param {string|null|undefined} value
 * @returns {string}
 */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Plain-language meaning of a bill's current stage plus the single most useful
 * action a follower can take from it. Classified by stage FAMILY (not all ~28
 * ids individually) so new/unseen ids still get sensible copy via the default.
 *
 * `action.kind` maps to a per-bill route the app serves:
 *   'testimony' → ${APP_URL}/bills/<id>/testimony   (a hearing is coming up)
 *   'contact'   → ${APP_URL}/bills/<id>/contact      (no hearing yet; lobby a legislator)
 *   null        → no CTA (terminal/administrative stages where action is moot)
 *
 * @param {string|null} statusId - a bills.bill_status enum id
 * @returns {{ meaning: string, action: { kind: 'testimony'|'contact'|null, label: string|null } }}
 */
export function stageGuidance(statusId) {
  const id = statusId || '';
  const testimony = { kind: 'testimony', label: 'Submit testimony' };
  const contact = { kind: 'contact', label: 'Contact the committee members' };
  const contactIntro = { kind: 'contact', label: 'Contact your legislator' };
  const none = { kind: null, label: null };

  // Terminal / governor stages — the outcome is decided; no follower action.
  if (id === 'governorSigns') return { meaning: 'The Governor has signed this bill into law.', action: none };
  if (id === 'lawWithoutSignature') return { meaning: 'This bill became law without the Governor’s signature.', action: none };
  if (id === 'vetoList') return { meaning: 'The Governor has vetoed this bill.', action: none };
  if (id === 'transmittedGovernor') return { meaning: 'This bill has passed the Legislature and is now on the Governor’s desk.', action: contactIntro };

  // Scheduled for a hearing (any reading, pre- or post-crossover) → testimony window is open.
  if (/^(crossover)?[Ss]cheduled\d$/.test(id) || id === 'conferenceScheduled') {
    return { meaning: 'This bill has been scheduled for a committee hearing.', action: testimony };
  }
  // Waiting to be scheduled (referred, not yet heard) → lobby the committee to hear it.
  if (/^(crossover)?[Ww]aiting\d$/.test(id)) {
    return { meaning: 'This bill is awaiting a hearing in committee.', action: contact };
  }
  // Deferred after a hearing → committee held it; contact them to revive it.
  if (/[Dd]eferred\d$/.test(id) || id === 'conferenceDeferred') {
    return { meaning: 'This bill was deferred after its committee hearing and may not advance.', action: contact };
  }
  // Just introduced / awaiting first referral → the earliest point to weigh in.
  if (id === 'introduced' || id === 'unassigned') {
    return { meaning: 'This bill has been introduced and is awaiting its first committee referral.', action: contactIntro };
  }
  // Conference / passed-committees stages → both chambers reconciling the text.
  if (id === 'passedCommittees' || id === 'conferenceAssigned' || id === 'conferencePassed') {
    return { meaning: 'This bill has cleared its committees and is in conference between the House and Senate.', action: contactIntro };
  }

  // Unknown/new id: no invented meaning, but still offer the safe default action.
  return { meaning: '', action: contactIntro };
}

/**
 * The stage label to SHOW in emails, simplified to drop committee ordinals so
 * followers see "SCHEDULED" / "WAITING" rather than "SCHEDULED 1ST" / "WAITING 2ND".
 * The underlying kanban titles (COLUMN_TITLES) are unchanged — this only affects
 * the email display. Strips trailing numeric ordinals (1ST/2ND/3RD) and the
 * word ordinals (First/Second/Third) used in the deferred titles.
 * @param {string|null|undefined} statusId
 * @returns {string}
 */
export function displayLabel(statusId) {
  return statusLabel(statusId)
    .replace(/\s+(?:1ST|2ND|3RD)\b/gi, '')
    .replace(/\b(?:First|Second|Third)\s+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Inline-styled status badge. `variant` selects the brand color scheme.
 * @param {string} label
 * @param {'old'|'new'|'dead'|'alive'} variant
 * @returns {string}
 */
function statusPill(label, variant) {
  const schemes = {
    old: { bg: COLOR.tealSoft, fg: COLOR.text, cls: 'dm-pill-old' },
    new: { bg: COLOR.teal, fg: COLOR.white, cls: 'dm-pill-new' },
    dead: { bg: COLOR.coral, fg: COLOR.white, cls: 'dm-pill-dead' },
    alive: { bg: COLOR.olive, fg: COLOR.text, cls: '' },
  };
  const { bg, fg, cls } = schemes[variant] ?? schemes.old;
  return (
    `<span class="${cls}" style="display:inline-block;padding:4px 12px;border-radius:999px;` +
    `background-color:${bg};color:${fg};font-size:13px;font-weight:600;` +
    `line-height:1.4;white-space:nowrap;">${escapeHtml(label)}</span>`
  );
}

/**
 * Build the status row (pills + arrow) for one change, mirroring describeChange logic.
 * @param {{ old_status: string|null, new_status: string|null, old_dead: boolean|null, new_dead: boolean|null }} change
 * @returns {string}
 */
function statusRow(change) {
  const { statusChanged, deadChanged } = diffBillState({
    oldStatus: change.old_status,
    newStatus: change.new_status,
    oldDead: change.old_dead,
    newDead: change.new_dead,
  });
  const pills = [];
  if (statusChanged) {
    pills.push(statusPill(displayLabel(change.old_status), 'old'));
    pills.push(
      `<span style="color:${COLOR.muted};font-size:15px;font-weight:700;` +
      `padding:0 4px;vertical-align:middle;">&rarr;</span>`,
    );
    pills.push(statusPill(displayLabel(change.new_status), 'new'));
  }
  if (deadChanged) {
    pills.push(
      Boolean(change.new_dead)
        ? statusPill('FAILED', 'dead')
        : statusPill('Revived · ALIVE', 'alive'),
    );
  }
  return `<div style="margin-top:8px;line-height:2;">${pills.join(' ')}</div>`;
}

/**
 * A per-bill action link ("Submit testimony", "Contact your legislator") pointing
 * at the app's per-bill route. Returns '' when the stage has no useful action or
 * the bill id is missing (can't build a link without it).
 * @param {{ kind: 'testimony'|'contact'|null, label: string|null }} action
 * @param {string|null|undefined} billId
 * @param {string} accent - the email's accent color (teal or coral)
 * @returns {string}
 */
function actionLink(action, billId, accent) {
  if (!action?.kind || !billId) return '';
  const url = `${APP_URL.replace(/\/$/, '')}/bills/${encodeURIComponent(billId)}/${action.kind}`;
  return (
    `<div style="margin-top:12px;">` +
    `<a href="${escapeHtml(url)}" target="_blank" ` +
    `style="display:inline-block;padding:8px 16px;border-radius:6px;background-color:${accent};` +
    `color:${COLOR.white};font-size:13px;font-weight:600;text-decoration:none;">` +
    `${escapeHtml(action.label)} &rarr;</a></div>`
  );
}

/**
 * A prominent "Hearing today" banner. `hearing` is the parsed hearing ({date, time});
 * pass null/undefined when the bill has no hearing today and this renders ''.
 * @param {{ date: string, time: string|null } | null | undefined} hearing
 * @returns {string}
 */
function hearingTodayBanner(hearing) {
  if (!hearing) return '';
  const when = hearing.time ? ` at ${escapeHtml(hearing.time)}` : '';
  return (
    `<div style="margin-top:12px;padding:10px 14px;border-radius:6px;` +
    `background-color:${COLOR.goldSoft};border:1px solid ${COLOR.gold};">` +
    `<span style="font-size:14px;font-weight:700;color:${COLOR.gold};">Hearing today</span>` +
    `<span style="font-size:14px;color:${COLOR.text};">${when}. Testimony is due now!</span>` +
    `</div>`
  );
}

/**
 * Effective meaning + action for a change, reconciling the stage with live signals
 * the stage alone doesn't know about:
 *   - Newly failed → fixed "failed" explanation, no action.
 *   - Hearing TODAY → the testimony window is open right now, so the action is
 *     always "Submit testimony" regardless of the stage family (a bill at
 *     `waiting2` with a hearing today would otherwise wrongly say "contact the
 *     committee"). This keeps the CTA consistent with the "Hearing today —
 *     testimony is due now" banner shown on the same card.
 * @param {{ new_status: string|null, new_dead: boolean|null, old_dead: boolean|null, hearing_today?: object|null }} change
 * @returns {{ meaning: string, action: { kind: 'testimony'|'contact'|null, label: string|null } }}
 */
function effectiveGuidance(change) {
  const nowDead = Boolean(change.new_dead) && !Boolean(change.old_dead);
  if (nowDead) {
    return {
      meaning: 'This bill failed to meet a legislative deadline and is no longer advancing this session.',
      action: { kind: null, label: null },
    };
  }
  const base = stageGuidance(change.new_status);
  if (change.hearing_today) {
    return {
      meaning: 'This bill has a committee hearing today. The testimony submit window is open now!',
      action: { kind: 'testimony', label: 'Submit testimony' },
    };
  }
  return base;
}

/**
 * A plain-language line explaining what the bill's new stage means. '' when there's
 * no meaning to show (unknown stage). Dead bills get a fixed "failed" explanation.
 * @param {{ new_status: string|null, new_dead: boolean|null, old_dead: boolean|null, hearing_today?: object|null }} change
 * @returns {string}
 */
function meaningLine(change) {
  const meaning = effectiveGuidance(change).meaning;
  if (!meaning) return '';
  return `<div class="dm-text" style="margin-top:10px;font-size:14px;color:${COLOR.text};line-height:1.5;">${escapeHtml(meaning)}</div>`;
}

/**
 * The raw Capitol status line as small subtext under the clean stage pills — the human
 * detail (committee, room, time) behind the kanban stage. '' when absent.
 * @param {string|null|undefined} rawStatus
 * @returns {string}
 */
function rawStatusLine(rawStatus) {
  if (!rawStatus) return '';
  return `<div class="dm-muted" style="margin-top:6px;font-size:13px;color:${COLOR.muted};line-height:1.4;">${escapeHtml(rawStatus)}</div>`;
}

/**
 * One branded per-bill card.
 * @param {{ bill_number: string, bill_title: string|null }} change
 * @returns {string}
 */
function billCard(change, accent = COLOR.teal) {
  const title = change.bill_title
    ? `<div class="dm-muted" style="color:${COLOR.muted};font-size:14px;margin-top:2px;">${escapeHtml(change.bill_title)}</div>`
    : '';
  // Meaning + action come from the same effective-guidance resolver so they never
  // disagree (e.g. a hearing today forces "Submit testimony"). A newly-failed bill
  // resolves to a null action, so no CTA renders.
  const action = actionLink(effectiveGuidance(change).action, change.bill_id, accent);
  return (
    `<div class="dm-card" style="border:1px solid ${COLOR.border};border-radius:8px;` +
    `padding:16px 18px;margin-bottom:12px;background-color:${COLOR.white};">` +
    `<div class="dm-text" style="color:${COLOR.text};font-size:16px;font-weight:700;">${escapeHtml(change.bill_number)}</div>` +
    title +
    statusRow(change) +
    rawStatusLine(change.raw_status) +
    hearingTodayBanner(change.hearing_today) +
    meaningLine(change) +
    action +
    `</div>`
  );
}

/**
 * Shared branded email shell — header bar + white content card + CTA + footer.
 * Table-based layout with all-inline CSS for email-client compatibility.
 * @param {{ accent: string, title: string, subtitle: string, intro: string, cardsHtml: string, ctaLabel: string }} opts
 * @returns {string}
 */
function renderEmailShell({ accent, title, subtitle, intro, cardsHtml, ctaLabel }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="only light">
<meta name="supported-color-schemes" content="only light">
<title>Hawaiʻi Bill Tracker</title>
<style>
  /* Dark-mode strategy: keep the LIGHT design everywhere, and make it survive each
     client's dark treatment rather than switch to a dark palette (which read muddy).
     - Apple Mail / iOS Mail honor prefers-color-scheme -> we re-pin the light colors.
     - The Gmail app / Outlook ignore that query and apply their OWN blend; they DO
       respect the [data-ogsc] (text swap) and [data-ogsb] (background swap) hooks,
       so we re-pin light surfaces there too. Pure-white cards on a light-grey page
       blend cleanly; near-white cream did not. The title stays white on teal. */
  @media (prefers-color-scheme: dark) {
    .dm-page   { background-color: ${COLOR.cream} !important; }
    .dm-card   { background-color: ${COLOR.white} !important; border-color: ${COLOR.border} !important; }
    .dm-text   { color: ${COLOR.text} !important; }
    .dm-muted  { color: ${COLOR.muted} !important; }
    .dm-accent { background-color: ${COLOR.teal} !important; }
    .dm-title  { color: #FFFFFF !important; }
    .dm-pill-old { background-color: ${COLOR.tealSoft} !important; color: ${COLOR.text} !important; }
    .dm-pill-new { background-color: ${COLOR.teal} !important; color: #FFFFFF !important; }
    .dm-coral  { color: ${COLOR.coral} !important; }
    .dm-pill-dead { background-color: ${COLOR.coral} !important; color: #FFFFFF !important; }
  }
  /* Gmail / Outlook dark-mode swap hooks (they inject these attributes). */
  [data-ogsc] .dm-page  { background-color: ${COLOR.cream} !important; }
  [data-ogsb] .dm-page  { background-color: ${COLOR.cream} !important; }
  [data-ogsc] .dm-card  { background-color: ${COLOR.white} !important; }
  [data-ogsb] .dm-card  { background-color: ${COLOR.white} !important; }
  [data-ogsc] .dm-text  { color: ${COLOR.text} !important; }
  [data-ogsc] .dm-muted { color: ${COLOR.muted} !important; }
  [data-ogsc] .dm-title { color: #FFFFFF !important; }
  [data-ogsc] .dm-accent { background-color: ${COLOR.teal} !important; }
</style>
</head>
<body class="dm-page" style="margin:0;padding:0;background-color:${COLOR.cream};font-family:Arial,Helvetica,sans-serif;color:${COLOR.text};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="dm-page" style="background-color:${COLOR.cream};padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
          <!-- Header: logo + wordmark -->
          <tr>
            <td class="dm-accent" style="background-color:${accent};border-radius:12px 12px 0 0;padding:24px 28px;">
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="vertical-align:middle;padding-right:14px;">
                    <img src="${LOGO_SRC}" width="48" height="48" alt="Hawaiʻi Bill Tracker"
                         style="display:block;width:48px;height:48px;border:0;" />
                  </td>
                  <td style="vertical-align:middle;">
                    <div class="dm-title" style="color:${COLOR.white};font-size:22px;font-weight:700;letter-spacing:-0.3px;">${escapeHtml(title)}</div>
                    <div class="dm-title" style="color:${COLOR.white};opacity:0.85;font-size:14px;margin-top:4px;">${escapeHtml(subtitle)}</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- Content card -->
          <tr>
            <td class="dm-card" style="background-color:${COLOR.white};border:1px solid ${COLOR.border};border-top:none;border-radius:0 0 12px 12px;padding:24px 24px 28px;">
              <p class="dm-text" style="margin:0 0 18px;font-size:15px;color:${COLOR.text};">
                ${escapeHtml(intro)}
              </p>
              ${cardsHtml}
              <!-- CTA -->
              <table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 4px;">
                <tr>
                  <td class="dm-accent" style="border-radius:8px;background-color:${accent};">
                    <a href="${escapeHtml(APP_URL)}" target="_blank"
                       style="display:inline-block;padding:12px 24px;color:${COLOR.white};font-size:15px;font-weight:600;text-decoration:none;border-radius:8px;">
                      ${escapeHtml(ctaLabel)}
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding:18px 24px;">
              <p class="dm-muted" style="margin:0;font-size:12px;color:${COLOR.muted};line-height:1.5;">
                You are receiving this because you follow these bills in the Hawaiʻi Bill Tracker.
              </p>
              <p class="dm-muted" style="margin:10px 0 0;font-size:12px;color:${COLOR.muted};line-height:1.5;">
                Made by Purple Maiʻa Foundation - ʻĀina Foundry, and Hawaiʻi Food+ Policy.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Build the full branded HTML body of a per-user bill-update digest.
 * @param {Array<{ bill_number: string, bill_title: string|null, old_status: string|null, new_status: string|null, old_dead: boolean|null, new_dead: boolean|null }>} changes
 * @returns {string}
 */
export function buildBillUpdateHtml(changes) {
  const count = changes?.length ?? 0;
  return renderEmailShell({
    accent: COLOR.teal,
    title: 'Hawaiʻi Bill Tracker',
    subtitle: 'Updates on bills you follow',
    intro: `${count === 1 ? 'A bill you follow' : `${count} bills you follow`} changed status:`,
    cardsHtml: (changes ?? []).map((c) => billCard(c, COLOR.teal)).join(''),
    ctaLabel: 'View in Hawaiʻi Bill Tracker',
  });
}

// --- Deadline-warning emails (coral accent) ---------------------------------

/**
 * Build the plain-text body of a deadline-warning digest.
 * @param {Array<{ bill_number: string, bill_title: string|null, deadline_name: string, deadline_date: string, days_left: number }>} items
 * @param {{ urgent?: boolean }} [opts]
 * @returns {string}
 */
export function buildDeadlineWarningBody(items, { urgent = false } = {}) {
  const header = urgent
    ? 'URGENT — bills you follow are about to miss a deadline:'
    : 'Bills you follow are approaching a deadline:';
  return [
    header,
    '',
    ...(items ?? []).map(
      (i) =>
        `- ${i.bill_number}${i.bill_title ? ` (${i.bill_title})` : ''}: ` +
        `${i.deadline_name} on ${i.deadline_date} — ${i.days_left} day${i.days_left === 1 ? '' : 's'} left`,
    ),
    '',
    'You are receiving this because you follow these bills in the Hawaiʻi Bill Tracker.',
    'Made by Purple Maiʻa Foundation, ʻĀina Foundry, and Hawaiʻi Food+ Policy.',
  ].join('\n');
}

/** True when a status is a "scheduled for a hearing" stage (any reading, pre/post
 * crossover, or conference). These are the stages where a testimony window is open. */
function isScheduledStatus(statusId) {
  const id = statusId || '';
  return /^(crossover)?[Ss]cheduled\d$/.test(id) || id === 'conferenceScheduled';
}

/**
 * The single CTA for a deadline-warning card, by an explicit binary rule:
 *   scheduled for a hearing → Submit testimony
 *   anything else           → Contact your legislator
 * @param {string|null} statusId - the bill's current bill_status
 * @returns {{ kind: 'testimony'|'contact', label: string }}
 */
function deadlineAction(statusId) {
  return isScheduledStatus(statusId)
    ? { kind: 'testimony', label: 'Submit testimony' }
    : { kind: 'contact', label: 'Contact your legislator' };
}

/**
 * One coral deadline-warning card: bill number, title, current status, deadline line.
 * @param {{ bill_id?: string, bill_number: string, bill_title: string|null, current_status: string|null, deadline_name: string, deadline_date: string, days_left: number }} item
 * @returns {string}
 */
function deadlineCard(item) {
  const title = item.bill_title
    ? `<div class="dm-muted" style="color:${COLOR.muted};font-size:14px;margin-top:2px;">${escapeHtml(item.bill_title)}</div>`
    : '';
  const statusPart = item.current_status
    ? `<div style="margin-top:8px;line-height:2;">${statusPill(displayLabel(item.current_status), 'old')}</div>`
    : '';
  const guidance = stageGuidance(item.current_status);
  const meaning = guidance.meaning
    ? `<div style="margin-top:10px;font-size:14px;color:${COLOR.text};line-height:1.5;">${escapeHtml(guidance.meaning)}</div>`
    : '';
  // Deadline-warning CTA is binary and independent of the general stage guidance:
  // a bill scheduled for a hearing → submit testimony; otherwise → contact your
  // legislator to push it forward before the deadline.
  const action = actionLink(deadlineAction(item.current_status), item.bill_id, COLOR.coral);
  const dayWord = item.days_left === 1 ? 'day' : 'days';
  return (
    `<div class="dm-card" style="border:1px solid ${COLOR.border};border-radius:8px;` +
    `padding:16px 18px;margin-bottom:12px;background-color:${COLOR.white};">` +
    `<div class="dm-text" style="color:${COLOR.text};font-size:16px;font-weight:700;">${escapeHtml(item.bill_number)}</div>` +
    title +
    statusPart +
    `<div class="dm-coral" style="margin-top:8px;font-size:14px;font-weight:600;color:${COLOR.coral};">` +
    `Deadline: ${escapeHtml(item.deadline_name)} on ${escapeHtml(item.deadline_date)} — ${item.days_left} ${dayWord} left` +
    `</div>` +
    meaning +
    action +
    `</div>`
  );
}

/**
 * Build the full branded HTML body of a per-user deadline-warning digest (coral accent).
 * @param {Array<{ bill_number: string, bill_title: string|null, current_status: string|null, deadline_name: string, deadline_date: string, days_left: number }>} items
 * @param {{ urgent?: boolean }} [opts]
 * @returns {string}
 */
export function buildDeadlineWarningHtml(items, { urgent = false } = {}) {
  const count = items?.length ?? 0;
  return renderEmailShell({
    accent: COLOR.coral,
    title: urgent ? 'URGENT: Deadline approaching' : 'Deadline approaching',
    subtitle: 'Bills you follow are at risk',
    intro:
      `${count === 1 ? 'A bill you follow is' : `${count} bills you follow are`} ` +
      `approaching a legislative deadline and may die if they don't advance in time:`,
    cardsHtml: (items ?? []).map(deadlineCard).join(''),
    ctaLabel: 'View in Hawaiʻi Bill Tracker',
  });
}

// ===========================================================================
// Unified daily digest — one email combining status changes AND deadline
// warnings. A bill can carry either or both. See sendDailyDigest() below and
// the design in the sim-week/notification specs.
// ===========================================================================

/** Constant subject — a plain daily-digest line with no counts or per-day detail. */
export const DAILY_DIGEST_SUBJECT = 'Your Hawaiʻi Bill Tracker daily digest';

/** Rank for ordering merged items: urgent (3-day) first, then 7-day, then changed-only. */
function digestRank(item) {
  if (item.warning?.tier === '3') return 0;
  if (item.warning?.tier === '7') return 1;
  return 2;
}

/**
 * Merge status changes and deadline warnings into one ordered list of per-bill
 * items, deduped by bill_id. A bill present in both lists yields ONE item
 * carrying both its `change` and its `warning`. Ordered urgent-first (see
 * digestRank). Pure — no DB.
 *
 * @param {Array<object>} changes - computeChange records (may include hearing_today)
 * @param {Array<object>} warnings - deadline items ({ bill_id, current_status, deadline_name, deadline_date, days_left, tier })
 * @returns {Array<{ bill_id: string, bill_number: string, bill_title: string|null, change: object|null, warning: object|null, hearing_today: object|null }>}
 */
export function mergeDigestItems(changes = [], warnings = []) {
  const byBill = new Map();

  const ensure = (bill_id, bill_number, bill_title) => {
    if (!byBill.has(bill_id)) {
      byBill.set(bill_id, { bill_id, bill_number, bill_title: bill_title ?? null, change: null, warning: null, hearing_today: null });
    }
    return byBill.get(bill_id);
  };

  for (const c of changes ?? []) {
    const it = ensure(c.bill_id, c.bill_number, c.bill_title);
    it.change = c;
    if (c.hearing_today) it.hearing_today = c.hearing_today;
  }
  for (const w of warnings ?? []) {
    const it = ensure(w.bill_id, w.bill_number, w.bill_title);
    it.warning = w;
  }

  return [...byBill.values()].sort((a, b) => digestRank(a) - digestRank(b));
}

/**
 * Human phrasing of how much time is left for a warning. Testimony warnings count
 * down in HOURS to the hearing time when we have it ("in ~20 hours"); otherwise
 * (legislative deadlines, or a testimony window with no parseable time) we use the
 * day-granularity "N days left".
 * @param {{ days_left: number, hours_left?: number|null, testimony?: boolean }} warning
 * @returns {string}
 */
export function deadlineTiming(warning) {
  if (warning.testimony && warning.hours_left != null) {
    const h = warning.hours_left;
    if (h <= 0) return 'due now';
    return `in ~${h} hour${h === 1 ? '' : 's'}`;
  }
  const d = warning.days_left;
  return `${d} day${d === 1 ? '' : 's'} left`;
}

/** The deadline line for a merged item's warning, or '' when it has none. */
function deadlineLine(warning) {
  if (!warning) return '';
  return (
    `<div class="dm-coral" style="margin-top:8px;font-size:14px;font-weight:600;color:${COLOR.coral};">` +
    `Deadline: ${escapeHtml(warning.deadline_name)} on ${escapeHtml(warning.deadline_date)} — ${escapeHtml(deadlineTiming(warning))}` +
    `</div>`
  );
}

/**
 * One unified card for a merged item. Shows status pills + meaning when the bill
 * changed, and a deadline line when it's at-risk (both when both). A single CTA:
 *   - at-risk → the deadline rule (scheduled → testimony, else contact)
 *   - changed only → the effective-guidance rule (hearing today → testimony, etc.)
 * @param {{ bill_id: string, bill_number: string, bill_title: string|null, change: object|null, warning: object|null, hearing_today: object|null }} item
 * @param {string} accent
 * @returns {string}
 */
function unifiedCard(item, accent) {
  const title = item.bill_title
    ? `<div class="dm-muted" style="color:${COLOR.muted};font-size:14px;margin-top:2px;">${escapeHtml(item.bill_title)}</div>`
    : '';

  // Status pills + raw line + meaning only when the bill changed this run.
  const changeParts = item.change
    ? statusRow(item.change) + rawStatusLine(item.change.raw_status) + meaningLine({ ...item.change, hearing_today: item.hearing_today })
    : (item.warning?.current_status
        ? `<div style="margin-top:8px;line-height:2;">${statusPill(displayLabel(item.warning.current_status), 'old')}</div>`
        : '');

  // One CTA. At-risk bills use the deadline rule; otherwise the change rule.
  const action = item.warning
    ? actionLink(deadlineAction(item.warning.current_status), item.bill_id, accent)
    : actionLink(effectiveGuidance({ ...item.change, hearing_today: item.hearing_today }).action, item.bill_id, accent);

  return (
    `<div class="dm-card" style="border:1px solid ${COLOR.border};border-radius:8px;` +
    `padding:16px 18px;margin-bottom:12px;background-color:${COLOR.white};">` +
    `<div class="dm-text" style="color:${COLOR.text};font-size:16px;font-weight:700;">${escapeHtml(item.bill_number)}</div>` +
    title +
    changeParts +
    hearingTodayBanner(item.hearing_today) +
    deadlineLine(item.warning) +
    action +
    `</div>`
  );
}

/**
 * Build the full branded HTML for the combined daily digest. Accent is coral when
 * The accent is always the brand dark teal. Urgency is conveyed inside the email
 * (the coral deadline line and the ordering), not by the header/button color.
 * @param {Array<object>} items - output of mergeDigestItems()
 * @returns {string}
 */
export function buildDailyDigestHtml(items) {
  const list = items ?? [];
  const accent = COLOR.teal;
  const count = list.length;
  return renderEmailShell({
    accent,
    title: 'Your daily digest',
    subtitle: 'Updates & deadlines on bills you follow',
    intro:
      `${count === 1 ? 'A bill you follow needs' : `${count} bills you follow need`} ` +
      `your attention — status changes and approaching deadlines:`,
    cardsHtml: list.map((i) => unifiedCard(i, accent)).join(''),
    ctaLabel: 'View in Hawaiʻi Bill Tracker',
  });
}

/**
 * Plain-text fallback for the combined daily digest.
 * @param {Array<object>} items - output of mergeDigestItems()
 * @returns {string}
 */
export function buildDailyDigestBody(items) {
  const list = items ?? [];
  const lines = list.map((i) => {
    const parts = [];
    if (i.change) {
      parts.push(describeChange({
        billNumber: i.change.bill_number,
        billTitle: i.change.bill_title,
        oldStatus: i.change.old_status,
        newStatus: i.change.new_status,
        oldDead: i.change.old_dead,
        newDead: i.change.new_dead,
      }));
    } else {
      parts.push(`${i.bill_number}${i.bill_title ? ` (${i.bill_title})` : ''}`);
    }
    if (i.warning) {
      parts.push(`deadline: ${i.warning.deadline_name} on ${i.warning.deadline_date} — ${deadlineTiming(i.warning)}`);
    }
    return `- ${parts.join(' · ')}`;
  });
  return [
    'Your daily digest — bills you follow:',
    '',
    ...lines,
    '',
    'You are receiving this because you follow these bills in the Hawaiʻi Bill Tracker.',
    'Made by Purple Maiʻa Foundation, ʻĀina Foundry, and Hawaiʻi Food+ Policy.',
  ].join('\n');
}

/**
 * Send the combined daily digest to a single user via Resend.
 * @param {string} toEmail
 * @param {Array<object>} items - output of mergeDigestItems()
 */
export async function sendDailyDigestEmail(toEmail, items) {
  if (!RESEND_API_KEY) {
    console.error('[NOTIFY] RESEND_API_KEY not set — skipping daily digest email');
    return;
  }
  if (!toEmail || !items?.length) return;

  const payload = {
    from: ALERT_FROM,
    to: [toEmail],
    subject: DAILY_DIGEST_SUBJECT,
    text: buildDailyDigestBody(items),
    html: buildDailyDigestHtml(items),
  };
  if (LOGO_ATTACHMENT) payload.attachments = [LOGO_ATTACHMENT];

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[NOTIFY] Resend API error (${response.status}) for ${toEmail}: ${errorText}`);
    } else {
      console.log(`[NOTIFY] Daily digest sent to ${toEmail} (${items.length} bill(s))`);
    }
  } catch (error) {
    console.error(`[NOTIFY] Failed to send daily digest to ${toEmail}:`, error.message);
  }
}

/**
 * Send a bill-update digest email to a single user via Resend.
 * Fire-and-forget safe — catches its own errors so it never crashes the caller.
 * NOTE: recipient is the user's own email, NOT ALERT_EMAIL (which is for cron failures only).
 * @param {string} toEmail
 * @param {string[]} lines - describeChange() lines for this user's changed bills (text fallback)
 * @param {Array<object>} [changes] - structured change records for the branded HTML body
 */
export async function sendBillUpdateEmail(toEmail, lines, changes) {
  if (!RESEND_API_KEY) {
    console.error('[NOTIFY] RESEND_API_KEY not set — skipping bill update email');
    return;
  }
  if (!toEmail || !lines?.length) {
    return;
  }

  const payload = {
    from: ALERT_FROM,
    to: [toEmail],
    subject: `Hawaiʻi Bill Tracker: ${lines.length} update${lines.length === 1 ? '' : 's'} on bills you follow`,
    text: buildBillUpdateBody(lines),
  };
  if (changes?.length) {
    payload.html = buildBillUpdateHtml(changes);
    if (LOGO_ATTACHMENT) payload.attachments = [LOGO_ATTACHMENT];
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[NOTIFY] Resend API error (${response.status}) for ${toEmail}: ${errorText}`);
    } else {
      console.log(`[NOTIFY] Bill update email sent to ${toEmail} (${lines.length} changes)`);
    }
  } catch (error) {
    console.error(`[NOTIFY] Failed to send bill update email to ${toEmail}:`, error.message);
  }
}

/**
 * Send a deadline-warning digest email to a single user via Resend.
 * Fire-and-forget safe — catches its own errors so it never crashes the caller.
 * @param {string} toEmail
 * @param {Array<{ bill_number: string, bill_title: string|null, current_status: string|null, deadline_name: string, deadline_date: string, days_left: number }>} items
 * @param {{ urgent?: boolean }} [opts] urgent = the 3-day tier (any item within 3 days)
 */
export async function sendDeadlineWarningEmail(toEmail, items, { urgent = false } = {}) {
  if (!RESEND_API_KEY) {
    console.error('[NOTIFY] RESEND_API_KEY not set — skipping deadline warning email');
    return;
  }
  if (!toEmail || !items?.length) {
    return;
  }

  const count = items.length;
  const subject =
    `${urgent ? 'URGENT — ' : ''}Hawaiʻi Bill Tracker: deadline approaching for ` +
    `${count} bill${count === 1 ? '' : 's'} you follow`;

  const payload = {
    from: ALERT_FROM,
    to: [toEmail],
    subject,
    text: buildDeadlineWarningBody(items, { urgent }),
    html: buildDeadlineWarningHtml(items, { urgent }),
  };
  if (LOGO_ATTACHMENT) payload.attachments = [LOGO_ATTACHMENT];

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[NOTIFY] Resend API error (${response.status}) for ${toEmail}: ${errorText}`);
    } else {
      console.log(`[NOTIFY] Deadline warning email sent to ${toEmail} (${count} bills, urgent=${urgent})`);
    }
  } catch (error) {
    console.error(`[NOTIFY] Failed to send deadline warning email to ${toEmail}:`, error.message);
  }
}
