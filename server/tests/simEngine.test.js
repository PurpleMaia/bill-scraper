import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildBillLog, normalizeStance } from '../services/sim/simEngine.js';
import { SCENARIOS, ROSTER } from '../services/sim/scenarios.js';
import { classifyStatus } from '../services/statusClassifier.js';
import { isExplicitlyDeferred } from '../services/dead-bill.js';

// Real classifier over an engine-produced log.
const stageOf = (billNumber, updates) => classifyStatus({ billNumber, statusUpdates: updates }).status;

const bill = (simId) => ROSTER.find((b) => b.simId === simId);
const auto1 = bill('SIM-01');   // scenario1 auto
const user1 = bill('SIM-03');   // scenario1 user-driven
const auto2 = bill('SIM-11');   // scenario2 auto
const user2 = bill('SIM-13');   // scenario2 user-driven

const ALL_PASS = { contacted: true, stance: 'support' };

// ---------------------------------------------------------------------------
// normalizeStance
// ---------------------------------------------------------------------------
test('normalizeStance: support synonyms -> support', () => {
  for (const s of ['Support', 'in favor', 'FOR', 'aye', 'yes', 'we endorse this']) {
    assert.equal(normalizeStance(s), 'support', s);
  }
});
test('normalizeStance: oppose / unknown / empty -> oppose (safe default)', () => {
  for (const s of ['Oppose', 'against', 'comments only', '', null, undefined, 'blah']) {
    assert.equal(normalizeStance(s), 'oppose', String(s));
  }
});

// ---------------------------------------------------------------------------
// Scenario 1 auto — full advance regardless of (no) actions, correct stages
// ---------------------------------------------------------------------------
test('Scenario 1 auto: classifier yields intended stage each day, no actions needed', () => {
  const expected = ['introduced', 'scheduled1', 'waiting2', 'crossoverWaiting1', 'crossoverScheduled1'];
  for (let day = 1; day <= 5; day++) {
    const { updates, dead, reachedStage } = buildBillLog(auto1, day, {}); // no flags/testimony
    assert.equal(dead, false, `auto must never die (day ${day})`);
    assert.equal(reachedStage, expected[day - 1], `reachedStage day ${day}`);
    assert.equal(stageOf(auto1.billNumber, updates), expected[day - 1], `classifier day ${day}`);
  }
});

// ---------------------------------------------------------------------------
// Scenario 2 auto — full advance to conference over 5 days
// ---------------------------------------------------------------------------
test('Scenario 2 auto: reaches conferenceAssigned by day 5, no actions needed', () => {
  const expected = ['waiting2', 'crossoverWaiting1', 'crossoverScheduled1', 'passedCommittees', 'conferenceAssigned'];
  for (let day = 1; day <= 5; day++) {
    const { updates, dead, reachedStage } = buildBillLog(auto2, day, {});
    assert.equal(dead, false, `auto must never die (day ${day})`);
    assert.equal(reachedStage, expected[day - 1], `reachedStage day ${day}`);
    assert.equal(stageOf(auto2.billNumber, updates), expected[day - 1], `classifier day ${day}`);
  }
});

// ---------------------------------------------------------------------------
// Scenario 1 user-driven — contact checkpoint (day 2)
// ---------------------------------------------------------------------------
test('S1 user: no contact by day 2 -> dead but STAYS introduced, no deferral line', () => {
  // The bill enters day 2 still `introduced` (no hearing ever scheduled). Failing
  // the contact checkpoint must NOT insert a "deferred the measure" line — a
  // deferral only makes sense once a hearing was scheduled. The bill dies in place.
  const { updates, dead } = buildBillLog(user1, 2, { contacted: false });
  assert.equal(dead, true);
  assert.equal(isExplicitlyDeferred(updates), false, 'no deferral line at introduced');
  assert.equal(stageOf(user1.billNumber, updates), 'introduced', 'stays introduced');
  // later days inject nothing further -> still dead, still introduced, still no deferral
  const d5 = buildBillLog(user1, 5, { contacted: false });
  assert.equal(d5.dead, true);
  assert.equal(isExplicitlyDeferred(d5.updates), false);
  assert.equal(stageOf(user1.billNumber, d5.updates), 'introduced');
  assert.doesNotMatch(d5.updates[0].statustext, /deferred the measure/);
});

test('S1 user: contact by day 2 -> scheduled1 (advances like auto)', () => {
  const { updates, dead } = buildBillLog(user1, 2, { contacted: true });
  assert.equal(dead, false);
  assert.equal(stageOf(user1.billNumber, updates), 'scheduled1');
});

// ---------------------------------------------------------------------------
// Scenario 1 user-driven — testimony checkpoint (day 3)
// ---------------------------------------------------------------------------
test('S1 user: support testimony by day 3 -> waiting2 (passes)', () => {
  const { updates, dead } = buildBillLog(user1, 3, { contacted: true, stance: 'support' });
  assert.equal(dead, false);
  assert.equal(stageOf(user1.billNumber, updates), 'waiting2');
});

test('S1 user: oppose testimony by day 3 -> dead', () => {
  const { updates, dead } = buildBillLog(user1, 3, { contacted: true, stance: 'oppose' });
  assert.equal(dead, true);
  assert.equal(isExplicitlyDeferred(updates), true);
});

test('S1 user: no testimony by day 3 -> dead (default oppose)', () => {
  const { dead, updates } = buildBillLog(user1, 3, { contacted: true, stance: null });
  assert.equal(dead, true);
  assert.equal(isExplicitlyDeferred(updates), true);
});

// ---------------------------------------------------------------------------
// Scenario 2 user-driven — day 1 ALWAYS advances (no gate); the bill survives the
// seed regardless of testimony so participants have time to act. The first
// life/death checkpoint is the crossover CONTACT on day 3.
// ---------------------------------------------------------------------------
test('S2 user: day 1 auto-advances to waiting2 regardless of testimony', () => {
  for (const stance of ['support', 'oppose', null]) {
    const { updates, dead } = buildBillLog(user2, 1, { stance });
    assert.equal(dead, false, `stance=${stance} must survive day 1`);
    assert.equal(stageOf(user2.billNumber, updates), 'waiting2', `stance=${stance}`);
  }
});

test('S2 user: no contact by day 3 -> dead but STAYS crossoverWaiting1, no deferral line', () => {
  // The crossover contact checkpoint fires while the bill is at crossoverWaiting1
  // (waiting, not scheduled for a hearing). Like the scenario-1 day-2 contact
  // gate, failing it kills the bill in place — no deferral line is inserted.
  const { updates, dead } = buildBillLog(user2, 3, { contacted: false });
  assert.equal(dead, true);
  assert.equal(isExplicitlyDeferred(updates), false, 'no deferral line at crossoverWaiting1');
  assert.equal(stageOf(user2.billNumber, updates), 'crossoverWaiting1', 'stays crossoverWaiting1');
});

test('S2 user full happy path: reaches passedCommittees by day 4 with all actions', () => {
  const { updates } = buildBillLog(user2, 4, ALL_PASS);
  assert.equal(stageOf(user2.billNumber, updates), 'passedCommittees');
});

// ---------------------------------------------------------------------------
// Testimony must NOT move a bill that isn't SCHEDULED. People can submit
// testimony before a hearing is scheduled; that early testimony must not
// advance the bill — the bill must be in a scheduled state first.
// ---------------------------------------------------------------------------
test('testify checkpoint entered from a NON-scheduled state does not advance on support', () => {
  // A synthetic scenario whose testify step is reached while the bill is still
  // in a waiting (not scheduled) state — the guard must refuse to advance it.
  const scenarioEarlyTestify = {
    id: 'earlyTestify',
    history: [],
    steps: [
      { day: 1, label: 'Introduced & Waiting', targetStage: 'introduced',
        advance: [
          { chamber: 'H', statustext: 'Introduced and passed First Reading.' },
          { chamber: 'H', statustext: 'Referred to JHA, referral sheet 1.' },
        ] },
      // Testify BEFORE any hearing is scheduled — bill is still "introduced"/waiting.
      { day: 2, label: 'Hearing (too early)', targetStage: 'waiting2',
        requiredAction: 'testify',
        advance: [{ chamber: 'H', statustext: 'The committee(s) on JHA recommend(s) that the measure be PASSED, unamended.' }],
        deathLine: { chamber: 'H', statustext: 'The committee(s) on JHA deferred the measure.' } },
    ],
  };
  const scenariosWithEarly = { ...SCENARIOS, earlyTestify: scenarioEarlyTestify };
  const bill = { simId: 'SIM-X', billNumber: 'HB9999', scenario: 'earlyTestify', isAuto: false };

  const { dead, updates } = buildBillLog(bill, 2, { stance: 'support' }, scenariosWithEarly);
  // Support testimony is present, but the bill was NOT scheduled entering day 2,
  // so it must NOT advance — it dies instead of moving to waiting2. Because it
  // died from an unscheduled state, no deferral line is inserted.
  assert.equal(dead, true, 'early testimony must not advance an unscheduled bill');
  assert.equal(isExplicitlyDeferred(updates), false, 'no deferral line when dying unscheduled');
});

test('testify checkpoint entered from a SCHEDULED state advances on support (control)', () => {
  // Same shape but with a scheduling step before the testify step — support advances.
  const scenarioScheduledFirst = {
    id: 'scheduledFirst',
    history: [],
    steps: [
      { day: 1, label: 'Hearing Notice', targetStage: 'scheduled1',
        advance: [
          { chamber: 'H', statustext: 'Introduced and passed First Reading.' },
          { chamber: 'H', statustext: 'Referred to JHA, referral sheet 1.' },
          { chamber: 'H', statustext: 'The committee(s) on JHA has scheduled a public hearing on 09-15-26 2:00PM.' },
        ] },
      { day: 2, label: 'Hearing', targetStage: 'waiting2',
        requiredAction: 'testify',
        advance: [{ chamber: 'H', statustext: 'The committee(s) on JHA recommend(s) that the measure be PASSED, unamended.' }],
        deathLine: { chamber: 'H', statustext: 'The committee(s) on JHA deferred the measure.' } },
    ],
  };
  const scenarios = { ...SCENARIOS, scheduledFirst: scenarioScheduledFirst };
  const bill = { simId: 'SIM-Y', billNumber: 'HB9998', scenario: 'scheduledFirst', isAuto: false };

  const { dead, updates } = buildBillLog(bill, 2, { stance: 'support' }, scenarios);
  assert.equal(dead, false, 'scheduled bill advances on support');
  assert.equal(stageOf(bill.billNumber, updates), 'waiting2');
});

// ---------------------------------------------------------------------------
// Idempotency: re-running a day is identical; day N log extends day N-1
// ---------------------------------------------------------------------------
test('idempotent: same (bill, day, actions) yields identical log', () => {
  const a = buildBillLog(auto2, 4, ALL_PASS).updates;
  const b = buildBillLog(auto2, 4, ALL_PASS).updates;
  assert.deepEqual(a, b);
});

test('monotonic: day 3 log contains day 2 log as a prefix (chronologically)', () => {
  const d2 = buildBillLog(auto1, 2, ALL_PASS).updates.slice().reverse(); // oldest-first
  const d3 = buildBillLog(auto1, 3, ALL_PASS).updates.slice().reverse();
  assert.ok(d3.length >= d2.length);
  for (let i = 0; i < d2.length; i++) assert.deepEqual(d3[i], d2[i], `line ${i}`);
});

// ---------------------------------------------------------------------------
// Roster shape guards
// ---------------------------------------------------------------------------
test('roster: 20 bills, 4 auto split evenly across two scenarios', () => {
  assert.equal(ROSTER.length, 20);
  const autos = ROSTER.filter((b) => b.isAuto);
  assert.equal(autos.length, 4);
  assert.equal(autos.filter((b) => b.scenario === 'scenario1').length, 2);
  assert.equal(autos.filter((b) => b.scenario === 'scenario2').length, 2);
  assert.equal(ROSTER.filter((b) => !b.isAuto).length, 16);
});

test('roster: every bill number parses to a chamber the classifier accepts', () => {
  for (const b of ROSTER) assert.match(b.billNumber, /^(HB|SB)\d+$/, b.simId);
});

test('scenarios: every step targetStage is reachable (sanity via auto run)', () => {
  for (const scenId of Object.keys(SCENARIOS)) {
    const autoBill = ROSTER.find((b) => b.scenario === scenId && b.isAuto);
    for (const step of SCENARIOS[scenId].steps) {
      const { updates } = buildBillLog(autoBill, step.day, ALL_PASS);
      assert.equal(stageOf(autoBill.billNumber, updates), step.targetStage,
        `${scenId} day ${step.day} (${step.label})`);
    }
  }
});
