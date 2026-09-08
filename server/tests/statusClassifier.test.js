import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyStatus } from '../services/statusClassifier.js';

// Helper: build newest-first status updates from [date, chamber, text] rows.
const S = (rows) => rows.map(([date, chamber, statustext]) => ({ date, chamber, statustext }));
// Classify from scratch (no prior status) unless a currentStatus is given.
const clf = (billNumber, rows, currentStatus = null) =>
  classifyStatus({ billNumber, statusUpdates: S(rows), currentStatus }).status;

// ---------------------------------------------------------------------------
// Tier 0 — terminal / governor (absorbing, scanned first regardless of position)
// ---------------------------------------------------------------------------
test('Act NNN -> governorSigns', () => {
  assert.equal(clf('HB1', [['5/14/2026', 'S', 'Act 048, on 05/14/2026 (Gov. Msg. No. 1148).']]), 'governorSigns');
});
test('Act wins even when a newer administrative line follows', () => {
  assert.equal(clf('HB1', [
    ['5/15/2026', 'S', 'Received notice of transmittal.'],
    ['5/14/2026', 'S', 'Act 048, on 05/14/2026 (Gov. Msg. No. 1148).'],
  ]), 'governorSigns');
});
test('Vetoed -> vetoList', () => {
  assert.equal(clf('HB1', [['6/1/2026', 'H', 'Vetoed on 06-01-26 - Returned from the Governor without approval.']]), 'vetoList');
});
test('Notice of Intent to veto -> vetoList', () => {
  assert.equal(clf('HB1', [['6/1/2026', 'H', 'Notice of Intent to veto dated 06-24-26 (Gov. Msg. No. 1400)']]), 'vetoList');
});
test('became law without signature', () => {
  assert.equal(clf('HB1', [['7/1/2026', 'H', 'Became law without the Governor\'s signature.']]), 'lawWithoutSignature');
});
test('Transmitted to Governor (no "the") -> transmittedGovernor', () => {
  assert.equal(clf('HB1', [
    ['5/8/2026', 'S', 'Received notice of passage on Final Reading in House (Hse. Com. No. 888).'],
    ['5/8/2026', 'H', 'Transmitted to Governor.'],
  ]), 'transmittedGovernor');
});
test('Enrolled to Governor -> transmittedGovernor', () => {
  assert.equal(clf('HB1', [['5/2/2026', 'S', 'Enrolled to Governor.']]), 'transmittedGovernor');
});
test('Failed to pass Third Reading -> dead flag', () => {
  const r = classifyStatus({ billNumber: 'HB1', statusUpdates: S([['4/1/2026', 'H', 'Failed to pass Third Reading. Ayes 20; Noes 30.']]), currentStatus: null });
  assert.equal(r.dead, true);
});
test('gubernatorial origination is NOT a governor terminal', () => {
  // "Received from Governor re: emergency appropriation" must fall through, not become governor stage.
  assert.notEqual(clf('HB1', [['1/20/2026', 'H', 'Received from Governor re: emergency appropriation (Gov. Msg. No. 5).']]), 'governorSigns');
});

// ---------------------------------------------------------------------------
// Tier 1 — conference (gated on bothChambers; conferenceAssigned needs bothConferees)
// ---------------------------------------------------------------------------
const CONF_BASE = [
  ['4/10/2026', 'S', 'Received from House (Hse. Com. No. 673).'],
  ['4/8/2026', 'H', 'Passed Third Reading as amended in HD 3. Transmitted to Senate.'],
];
test('one chamber conferees only -> stays passedCommittees', () => {
  assert.equal(clf('HB1', [
    ['4/21/2026', 'H', 'House Conferees Appointed: Hashem, Morikawa Co-Chairs; Souza.'],
    ...CONF_BASE,
  ]), 'passedCommittees');
});
test('both chambers conferees -> conferenceAssigned', () => {
  assert.equal(clf('HB1', [
    ['4/22/2026', 'S', 'Senate Conferees Appointed: Gabbard Chair; DeCoite.'],
    ['4/21/2026', 'H', 'House Conferees Appointed: Hashem, Morikawa Co-Chairs; Souza.'],
    ...CONF_BASE,
  ]), 'conferenceAssigned');
});
test('conference meeting scheduled -> conferenceScheduled', () => {
  assert.equal(clf('HB1', [
    ['4/24/2026', 'S', 'Conference committee meeting scheduled for 04-24-26 9:31AM; Conference Room 325.'],
    ['4/22/2026', 'S', 'Senate Conferees Appointed: Gabbard.'],
    ['4/21/2026', 'H', 'House Conferees Appointed: Hashem.'],
    ...CONF_BASE,
  ]), 'conferenceScheduled');
});
test('reported from conference committee -> conferencePassed', () => {
  assert.equal(clf('HB1', [
    ['4/25/2026', 'S', 'Reported from Conference Committee as amended CD 1 (Conf. Com. Rep. No. 112).'],
    ...CONF_BASE,
  ]), 'conferencePassed');
});
test('conference words IGNORED when only one chamber has acted', () => {
  // bothChambers=false -> conference tier skipped; "conferees" line falls through to committee/intro.
  const out = clf('SB1', [['3/1/2026', 'S', 'Received notice of Senate conferees (Sen. Com. No. 1).']]);
  assert.notEqual(out, 'conferenceAssigned');
});

// ---------------------------------------------------------------------------
// Tier 2 — passed all committees
// ---------------------------------------------------------------------------
test('received in amended form -> passedCommittees', () => {
  assert.equal(clf('HB1', [
    ['2/27/2026', 'H', 'Received from Senate (Sen. Com. No. 31) in amended form (SD 2).'],
    ['2/1/2026', 'H', 'Introduced and Pass First Reading.'],
  ]), 'passedCommittees');
});

// ---------------------------------------------------------------------------
// Tier 3 — committee stage (crossover + ordinal)
// ---------------------------------------------------------------------------
const REFERRED = ['1/17/2026', 'S', 'Referred to AEN, WAM.'];
test('scheduled 1st committee', () => {
  assert.equal(clf('SB1', [
    ['1/31/2026', 'S', 'The committee(s) on AEN has scheduled a public hearing on 02-03-26 1:02PM.'],
    REFERRED,
  ]), 'scheduled1');
});
test('DOMAIN RULE: committee deferral stays at scheduled{N}, not deferred{N}', () => {
  assert.equal(clf('SB1', [
    ['2/4/2026', 'S', 'The committee(s) on AEN recommend(s) that the measure be deferred.'],
    ['1/31/2026', 'S', 'The committee(s) on AEN has scheduled a public hearing on 02-03-26.'],
    REFERRED,
  ]), 'scheduled1');
});
test('committee passed 1st -> waiting2', () => {
  assert.equal(clf('SB1', [
    ['2/3/2026', 'S', 'The committee(s) on AEN recommend(s) that the measure be PASSED, WITH AMENDMENTS.'],
    REFERRED,
  ]), 'waiting2');
});
test('committee passed 2nd (WAM) -> waiting3', () => {
  assert.equal(clf('SB1', [
    ['2/12/2026', 'S', 'The committee(s) on WAM recommend(s) that the measure be PASSED, WITH AMENDMENTS.'],
    REFERRED,
  ]), 'waiting3');
});
test('hearing cancelled reverts scheduled2 -> waiting2', () => {
  assert.equal(clf('SB1', [
    ['2/13/2026', 'S', 'The committee(s) on WAM deleted the measure from the public hearing scheduled on 02-14-26.'],
    ['2/10/2026', 'S', 'The committee(s) on WAM will hold a public decision making on 02-12-26.'],
    ['2/6/2026', 'S', 'Report adopted; Passed Second Reading and referred to WAM.'],
    REFERRED,
  ]), 'waiting2');
});
test('hearing cancelled at 1st reverts to introduced (no waiting1)', () => {
  const out = clf('SB1', [
    ['2/3/2026', 'S', 'This measure has been deleted from the meeting scheduled on 02-04-26.'],
    ['1/31/2026', 'S', 'The committee(s) on AEN has scheduled a public hearing on 02-03-26.'],
    REFERRED,
  ]);
  assert.equal(out, 'introduced');
});

// ---------------------------------------------------------------------------
// Crossover variants
// ---------------------------------------------------------------------------
test('HB received in Senate -> crossoverWaiting1', () => {
  assert.equal(clf('HB1', [
    ['3/6/2026', 'S', 'Received from House (Hse. Com. No. 53).'],
    ['1/23/2026', 'H', 'Introduced and Pass First Reading.'],
  ]), 'crossoverWaiting1');
});
test('crossover committee passed -> crossoverWaiting2', () => {
  assert.equal(clf('HB1', [
    ['3/23/2026', 'S', 'The committee(s) on LBT recommend(s) that the measure be PASSED, WITH AMENDMENTS.'],
    ['3/12/2026', 'S', 'Referred to LBT, CPN.'],
    ['3/10/2026', 'S', 'Received from House (Hse. Com. No. 53).'],
    ['1/23/2026', 'H', 'Introduced and Pass First Reading.'],
  ]), 'crossoverWaiting2');
});

// A House bill posts "Passed Third Reading ... Transmitted to the Senate" in the ORIGIN
// chamber BEFORE the Senate logs receipt. At that instant crossover is not yet detectable
// from a receiving-chamber line, but the bill has demonstrably left its origin chamber, so
// the transmit line itself must classify it as crossed over -> crossoverWaiting1.
test('HB passed 3rd reading + transmitted to Senate (before receipt) -> crossoverWaiting1', () => {
  assert.equal(clf('HB1', [
    ['3/10/2026', 'H', 'Passed Third Reading. Ayes, 25. Transmitted to the Senate.'],
    ['3/6/2026', 'H', 'The committee on AGR recommend that the measure be PASSED, unamended.'],
    ['1/23/2026', 'H', 'Introduced and Pass First Reading.'],
  ]), 'crossoverWaiting1');
});
test('HB passed 3rd reading as amended + transmitted to Senate (real wording) -> crossoverWaiting1', () => {
  assert.equal(clf('HB1', [
    ['3/10/2026', 'H', 'Passed Third Reading as amended in HD 2 with none voting aye with reservations; none voting no (0) and none excused (0). Transmitted to Senate.'],
    ['1/23/2026', 'H', 'Introduced and Pass First Reading.'],
  ]), 'crossoverWaiting1');
});
test('SB passed 3rd reading + transmitted to House (before receipt) -> crossoverWaiting1', () => {
  assert.equal(clf('SB1', [
    ['3/10/2026', 'S', 'Passed Third Reading. Ayes, 25. Transmitted to the House.'],
    ['1/23/2026', 'S', 'Introduced and Pass First Reading.'],
  ]), 'crossoverWaiting1');
});
test('RETURN trip: HB passed 3rd reading in Senate + transmitted back to House -> passedCommittees', () => {
  // After crossover, the Senate amends and passes the HB, transmitting it BACK to the House.
  // Direction is "to the House" (origin), so this is the return trip: passedCommittees, NOT crossover.
  assert.equal(clf('HB1', [
    ['4/8/2026', 'S', 'Passed Third Reading in amended form. Transmitted to the House.'],
    ['3/23/2026', 'S', 'The committee(s) on CPN recommend(s) that the measure be PASSED, WITH AMENDMENTS.'],
    ['3/6/2026', 'S', 'Received from House (Hse. Com. No. 53).'],
    ['1/23/2026', 'H', 'Introduced and Pass First Reading.'],
  ]), 'passedCommittees');
});

// ---------------------------------------------------------------------------
// Tier 4 — introduction / re-referral
// ---------------------------------------------------------------------------
test('introduced and pass first reading -> introduced', () => {
  assert.equal(clf('HB1', [['1/23/2026', 'H', 'Introduced and Pass First Reading.']]), 'introduced');
});
test('referred with sheet -> introduced', () => {
  assert.equal(clf('HB1', [['1/26/2026', 'H', 'Referred to AGR/EEP, FIN, referral sheet 1']]), 'introduced');
});
test('DOMAIN RULE: re-referral after a prior passage -> waiting2', () => {
  assert.equal(clf('HB1', [
    ['2/20/2026', 'H', 'Re-referred to PBS, FIN, referral sheet 14'],
    ['2/11/2026', 'H', 'The committee on PBS recommend that the measure be PASSED, WITH AMENDMENTS.'],
    ['2/2/2026', 'H', 'Referred to PBS, HED, FIN, referral sheet 6'],
    ['1/28/2026', 'H', 'Introduced and Pass First Reading.'],
  ]), 'waiting2');
});
test('re-referral with NO prior passage -> introduced', () => {
  assert.equal(clf('HB1', [
    ['2/2/2026', 'H', 'Re-Referred to AGR, CPC.'],
    ['1/28/2026', 'H', 'Introduced and Pass First Reading.'],
  ]), 'introduced');
});

// ---------------------------------------------------------------------------
// Rollup / guard behavior
// ---------------------------------------------------------------------------
test('empty history -> unassigned', () => {
  assert.equal(classifyStatus({ billNumber: 'HB1', statusUpdates: [], currentStatus: null }).status, 'unassigned');
});
test('newest confident line wins over older stage (crossover ladder resets)', () => {
  // A House bill that passed 3rd reading then crossed to Senate is crossoverWaiting1, NOT passedCommittees.
  assert.equal(clf('HB1', [
    ['3/10/2026', 'S', 'Referred to AEN/HHS, WAM.'],
    ['3/6/2026', 'S', 'Received from House (Hse. Com. No. 53).'],
    ['3/5/2026', 'H', 'Passed Third Reading with none voting no.'],
    ['2/6/2026', 'H', 'The committee on EEP recommend that the measure be PASSED, WITH AMENDMENTS.'],
    ['1/23/2026', 'H', 'Introduced and Pass First Reading.'],
  ]), 'crossoverWaiting1');
});
test('monotonic guard: never regress below an explicit currentStatus', () => {
  // Newest line alone would be "introduced" but currentStatus is waiting2 -> stays waiting2.
  const out = classifyStatus({
    billNumber: 'HB1',
    statusUpdates: S([['1/1/2026', 'H', 'The recommendation was not adopted.']]),
    currentStatus: 'waiting2',
  }).status;
  assert.equal(out, 'waiting2');
});
test('committeeOrdinal ignores draft markers (HD/SD)', () => {
  // "as amended in HD 1 ... referred to FIN" must pick FIN, not HD.
  assert.equal(clf('HB1', [
    ['2/11/2026', 'H', 'Passed Second Reading as amended in HD 1 and referred to the committee(s) on FIN'],
    ['2/2/2026', 'H', 'Referred to AGR, ECD, FIN, referral sheet 1'],
    ['1/23/2026', 'H', 'Introduced and Pass First Reading.'],
  ]), 'waiting3'); // FIN is 3rd -> waiting for FIN
});
test('committeeOrdinal caps at 3 (4-committee referral -> scheduled3, not invalid scheduled4)', () => {
  // A rare 4-committee referral: the 4th committee (FIN) schedules a hearing. The kanban enum only
  // defines scheduled{1,2,3}, so the 4th committee must clamp to scheduled3 rather than emit the
  // invalid `scheduled4` that fails the DB enum insert.
  assert.equal(clf('HB1', [
    ['2/11/2026', 'H', 'The committee(s) on FIN has scheduled a public hearing on 02-15-26.'],
    ['2/2/2026', 'H', 'Referred to EDN, LAB, JHA, FIN, referral sheet 1'],
    ['1/23/2026', 'H', 'Introduced and Pass First Reading.'],
  ]), 'scheduled3');
});
test('DOMAIN RULE: "recommendation was not adopted" negates the preceding PASS (stays scheduled)', () => {
  // AEN recommended PASS, but the recommendation was not adopted -> bill stays at the 1st hearing.
  assert.equal(clf('SB1', [
    ['2/11/2026', 'S', 'The recommendation was not adopted.'],
    ['2/11/2026', 'S', 'The committee(s) on AEN recommend(s) that the measure be PASSED, WITH AMENDMENTS.'],
    ['2/6/2026', 'S', 'The committee(s) on AEN/WLA has scheduled a public hearing on 02-11-26.'],
    ['2/2/2026', 'S', 'Referred to AEN/WLA, JDC.'],
  ]), 'scheduled1');
});
test('recommend(s) with LITERAL parens still classifies as PASS', () => {
  // Regression: /recommend(s)?/ (optional s) does NOT match "recommend(s)" (literal parens).
  assert.equal(clf('SB1', [
    ['2/3/2026', 'S', 'The committee(s) on AEN recommend(s) that the measure be PASSED, WITH AMENDMENTS.'],
    ['1/17/2026', 'S', 'Referred to AEN, WAM.'],
  ]), 'waiting2');
});
test('unmatched line is reported for maintenance', () => {
  const r = classifyStatus({
    billNumber: 'HB1',
    statusUpdates: S([['1/1/2026', 'H', 'Some totally novel legislative action never seen before.']]),
    currentStatus: null,
  });
  assert.equal(r.status, 'unassigned');
  assert.ok(r.unmatched.length >= 1, 'unmatched should list the novel line');
});
