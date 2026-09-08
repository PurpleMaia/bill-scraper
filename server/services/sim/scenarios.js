/**
 * Sim Week scenario data — the two bill lifecycles as pure data.
 *
 * See docs/superpowers/specs/2026-08-27-sim-week-design.md.
 *
 * Every status line below has been validated against the real deterministic
 * classifier (server/services/statusClassifier.js) so that the cumulative log
 * up to each sim-day resolves to the intended kanban stage. Do NOT reword a
 * line without re-running server/tests/simEngine.test.js — the wording is
 * load-bearing (it must match docs/bill-status-pattern-table.md).
 *
 * A "step" is one sim-day (1..5). Each step contributes zero or more status
 * lines to the bill's cumulative log. Lines are authored oldest->newest here;
 * the engine reverses to newest-first before handing to the classifier.
 *
 * `requiredAction` marks a checkpoint that user-driven bills must satisfy:
 *   - 'contact'  : bill is waiting; a contact flag advances it (else it dies).
 *   - 'testify'  : bill is at a hearing; a support testimony passes it,
 *                  an oppose testimony (or none) defers/kills it.
 * Auto bills ignore requiredAction and always take the advancing line(s).
 *
 * When a user-driven bill fails a checkpoint, the engine replaces that day's
 * advancing line with a `deathLine` (a permanent committee deferral that
 * dead-bill.js recognizes) and injects nothing further.
 */

/** @typedef {{ chamber: string, statustext: string }} Line */
/**
 * @typedef {Object} Step
 * @property {number} day             - sim-day 1..5
 * @property {string} label           - human label (matches Jaden's table)
 * @property {string} targetStage     - kanban stage expected after this step
 * @property {Line[]} advance         - lines added when the step succeeds
 * @property {('contact'|'testify')} [requiredAction] - checkpoint gate
 * @property {Line} [deathLine]       - committee deferral used when a
 *                                      user-driven bill fails the checkpoint
 */
/**
 * @typedef {Object} Scenario
 * @property {string} id
 * @property {Line[]} history         - lines that predate day 1 (back-history)
 * @property {Step[]} steps
 */

// The date a line carries is the sim date for its step; the engine stamps it.
// `chamber` is 'H' (origin) or 'S' (receiving), matching the classifier's
// chamber-phase logic. Both scenarios are House-origin (crossover to Senate).

const COMMITTEE_1 = 'SIM-JHA'; // origin-chamber committee
const COMMITTEE_2 = 'SIM-CPN'; // receiving-chamber committee

const deferOrigin = { chamber: 'H', statustext: `The committee(s) on ${COMMITTEE_1} deferred the measure.` };
const deferRecv = { chamber: 'S', statustext: `The committee(s) on ${COMMITTEE_2} deferred the measure.` };

/**
 * SCENARIO 1 — introduced -> first hearing -> crossover -> crossover hearing.
 * Checkpoints: day 2 (contact -> scheduled1), day 3 (testify -> pass/defer),
 * day 5 (contact -> crossoverScheduled1).
 */
const scenario1 = {
  id: 'scenario1',
  history: [],
  steps: [
    {
      day: 1,
      label: 'Introduced & Waiting',
      targetStage: 'introduced',
      advance: [
        { chamber: 'H', statustext: 'Introduced and passed First Reading.' },
        { chamber: 'H', statustext: `Referred to ${COMMITTEE_1}.` },
      ],
    },
    {
      day: 2,
      label: 'Hearing Notice',
      targetStage: 'scheduled1',
      requiredAction: 'contact',
      advance: [
        { chamber: 'H', statustext: `The committee(s) on ${COMMITTEE_1} has scheduled a public hearing on 09-1-26 2:00PM.` },
      ],
      deathLine: deferOrigin,
    },
    {
      day: 3,
      label: 'Hearing',
      targetStage: 'waiting2',
      requiredAction: 'testify',
      advance: [
        { chamber: 'H', statustext: `The committee(s) on ${COMMITTEE_1} recommend(s) that the measure be PASSED, unamended.` },
      ],
      deathLine: deferOrigin,
    },
    {
      day: 4,
      label: 'Crossover & Waiting',
      targetStage: 'crossoverWaiting1',
      advance: [
        { chamber: 'H', statustext: 'Passed Third Reading. Ayes, 25. Transmitted to the Senate.' },
        { chamber: 'S', statustext: `Received from the House. Referred to ${COMMITTEE_2}.` },
      ],
    },
    {
      day: 5,
      label: 'Crossed Over Hearing Notice',
      targetStage: 'crossoverScheduled1',
      requiredAction: 'contact',
      advance: [
        { chamber: 'S', statustext: `The committee(s) on ${COMMITTEE_2} has scheduled a public hearing on 09-4-26 2:00PM.` },
      ],
      deathLine: deferRecv,
    },
  ],
};

/**
 * SCENARIO 2 — first hearing -> crossover -> crossover hearing -> conference.
 * Back-history seeds an introduced+referred bill before day 1.
 *
 * Day 1 lands the bill at its first hearing and ADVANCES IT NO MATTER WHAT (the
 * bill is scheduled and passes committee that day regardless of testimony) — so a
 * freshly-seeded scenario-2 bill starts alive at waiting2 and nobody dies on day
 * 1 before participants have had a chance to act. The first real user checkpoint
 * is the crossover CONTACT on day 3; the crossover TESTIFY vote is day 4.
 *
 * Checkpoints: day 3 (contact -> crossoverScheduled1), day 4 (testify -> pass/defer).
 */
const scenario2 = {
  id: 'scenario2',
  history: [
    { chamber: 'H', statustext: 'Introduced and passed First Reading.' },
    { chamber: 'H', statustext: `Referred to ${COMMITTEE_1}, referral sheet 1.` },
  ],
  steps: [
    {
      day: 1,
      label: 'Hearing (auto-advances)',
      targetStage: 'waiting2',
      // No requiredAction: day 1 always moves forward. The bill is scheduled for a
      // hearing AND passes committee the same day, so scenario-2 bills survive the
      // seed regardless of testimony — the life/death gates come later.
      advance: [
        { chamber: 'H', statustext: `The committee(s) on ${COMMITTEE_1} has scheduled a public hearing on 09-1-26 2:00PM.` },
        { chamber: 'H', statustext: `The committee(s) on ${COMMITTEE_1} recommend(s) that the measure be PASSED, unamended.` },
      ],
    },
    {
      day: 2,
      label: 'Crossover & Waiting',
      targetStage: 'crossoverWaiting1',
      advance: [
        { chamber: 'H', statustext: 'Passed Third Reading. Ayes, 25. Transmitted to the Senate.' },
        { chamber: 'S', statustext: `Received from the House. Referred to ${COMMITTEE_2}.` },
      ],
    },
    {
      day: 3,
      label: 'Crossed Over Hearing Notice',
      targetStage: 'crossoverScheduled1',
      requiredAction: 'contact',
      advance: [
        { chamber: 'S', statustext: `The committee(s) on ${COMMITTEE_2} has scheduled a public hearing on 09-1-26 2:00PM.` },
      ],
      deathLine: deferRecv,
    },
    {
      day: 4,
      label: 'Crossed Over Hearing',
      targetStage: 'passedCommittees',
      requiredAction: 'testify',
      advance: [
        { chamber: 'S', statustext: `The committee(s) on ${COMMITTEE_2} recommend(s) that the measure be PASSED, unamended.` },
        { chamber: 'S', statustext: 'Passed Third Reading in amended form. Transmitted to the House.' },
      ],
      deathLine: deferRecv,
    },
    {
      day: 5,
      label: 'Conference / Conference Hearing Notice',
      targetStage: 'conferenceAssigned',
      advance: [
        { chamber: 'H', statustext: 'House disagrees with Senate amendments.' },
        { chamber: 'H', statustext: 'House Conferees Appointed: SMITH, JONES.' },
        { chamber: 'S', statustext: 'Senate Conferees Appointed: LEE, KIM.' },
      ],
    },
  ],
};

/**
 * The 20-bill roster. 4 auto (isAuto:true) + 16 user-driven, split evenly.
 * SIM_ID is the operator handle (flag.js, sentinel URL); billNumber is what the
 * classifier parses for origin chamber. Both scenarios are House-origin, so
 * numbers are HB9001..HB9020 in a reserved high range (see spec §5a).
 *
 * `title` / `description` are realistic food-related measure text modeled on real
 * Hawaiʻi bills (voice: `RELATING TO <TOPIC>.` + dense clauses on what the measure
 * establishes/requires/appropriates, draft markers, effective dates). They exist
 * only for display/demo realism — the sim engine ignores them and drives stages
 * purely off scenario/isAuto. Fictional measures; not real bills.
 */
const ROSTER = [
  // Scenario 1
  {
    simId: 'SIM-01', billNumber: 'HB9001', scenario: 'scenario1', isAuto: true,
    title: 'RELATING TO FARM TO SCHOOL MEALS.',
    description: 'Establishes a Farm to School Meals Grant Program within the Department of Agriculture and Biosecurity to reimburse public schools for locally grown produce purchased for school meals. Sets a goal that thirty per cent of school food ingredients be locally sourced by 2030. Requires an annual report to the Legislature. Appropriates funds. Effective 7/1/2050. (HD1)',
  },
  {
    simId: 'SIM-02', billNumber: 'HB9002', scenario: 'scenario1', isAuto: true,
    title: 'RELATING TO DOUBLE-UP FOOD BUCKS.',
    description: 'Establishes and appropriates funds for a statewide Double-Up Food Bucks Program under the Department of Human Services to match Supplemental Nutrition Assistance Program benefits spent on Hawaii-grown fruits and vegetables at participating farmers markets and retailers. Requires reports to the Legislature before the Regular Sessions of 2027 and 2028.',
  },
  {
    simId: 'SIM-03', billNumber: 'HB9003', scenario: 'scenario1', isAuto: false,
    title: 'RELATING TO FARMERS MARKET NUTRITION.',
    description: 'Establishes a Farmers Market Nutrition Incentive Program within the Department of Health to provide vouchers redeemable for fresh local produce to participants in the Special Supplemental Nutrition Program for Women, Infants, and Children. Requires the Department to adopt rules. Appropriates funds. Effective 7/1/2050. (HD1)',
  },
  {
    simId: 'SIM-04', billNumber: 'HB9004', scenario: 'scenario1', isAuto: false,
    title: 'RELATING TO SCHOOL GARDENS.',
    description: 'Requires the Department of Education to establish and maintain edible school gardens at each public school that elects to participate, and to integrate garden-based learning into science and nutrition curricula. Requires a report to the Legislature. Appropriates funds for coordinator positions. Effective 7/1/3000. (HD1)',
  },
  {
    simId: 'SIM-05', billNumber: 'HB9005', scenario: 'scenario1', isAuto: false,
    title: 'RELATING TO TARO.',
    description: 'Establishes recognition of kalo (taro) as a staple food crop of cultural significance. Requires the Department of Agriculture and Biosecurity to establish a loi restoration grant program and to maintain a repository of Hawaiian taro varieties. Appropriates funds. Effective 7/1/2050. (HD1)',
  },
  {
    simId: 'SIM-06', billNumber: 'HB9006', scenario: 'scenario1', isAuto: false,
    title: 'RELATING TO EMERGENCY FOOD RESERVES.',
    description: 'Establishes the Hawaii Emergency Food Reserves Program within the Department of Agriculture and Biosecurity to procure and store shelf-stable, locally produced food sufficient to supply the State during a disruption to imported food supplies. Establishes purchasing requirements favoring Hawaii producers. Appropriates funds.',
  },
  {
    simId: 'SIM-07', billNumber: 'HB9007', scenario: 'scenario1', isAuto: false,
    title: 'RELATING TO THE GENERAL EXCISE TAX.',
    description: 'Exempts eligible groceries from the general excise tax. Defines "eligible groceries" to exclude prepared foods and dietary supplements. Applies to taxable years beginning after 12/31/2026.',
  },
  {
    simId: 'SIM-08', billNumber: 'HB9008', scenario: 'scenario1', isAuto: false,
    title: 'RELATING TO FOOD HUB INFRASTRUCTURE.',
    description: 'Establishes a Regional Food Hub Grant Program within the Agribusiness Development Corporation to fund aggregation, processing, cold storage, and distribution facilities that connect local farmers to institutional and retail buyers. Requires a report to the Legislature. Appropriates funds. Effective 7/1/2050. (HD2)',
  },
  {
    simId: 'SIM-09', billNumber: 'HB9009', scenario: 'scenario1', isAuto: false,
    title: 'RELATING TO AGRICULTURAL LAND LEASES.',
    description: 'Requires the Department of Agriculture and Biosecurity to offer long-term leases of state agricultural lands at preferential rates to farmers who grow food crops for local consumption. Establishes lease provisions requiring active agricultural use. Effective 7/1/3000. (HD1)',
  },
  {
    simId: 'SIM-10', billNumber: 'HB9010', scenario: 'scenario1', isAuto: false,
    title: 'RELATING TO LOCAL FOOD PROCUREMENT.',
    description: 'Requires state agencies operating food service programs to give preference to Hawaii-grown and Hawaii-processed food products and establishes a minimum local procurement threshold that increases annually. Requires an annual report on local procurement percentages. Effective 7/1/2050. (HD1)',
  },
  // Scenario 2
  {
    simId: 'SIM-11', billNumber: 'HB9011', scenario: 'scenario2', isAuto: true,
    title: 'RELATING TO AQUACULTURE.',
    description: 'Requires the Department of Agriculture and Biosecurity to establish a permitting framework and grant program to support the restoration and operation of loko iʻa (traditional Hawaiian fishponds) for food production. Requires rules and a report to the Legislature. Appropriates funds. Effective 7/1/2050. (SD1)',
  },
  {
    simId: 'SIM-12', billNumber: 'HB9012', scenario: 'scenario2', isAuto: true,
    title: 'RELATING TO BREADFRUIT.',
    description: 'Establishes an ulu (breadfruit) production and value-added processing pilot program within the Agribusiness Development Corporation to expand acreage, aggregation, and market development for breadfruit as a local staple. Requires a report to the Legislature. Appropriates funds.',
  },
  {
    simId: 'SIM-13', billNumber: 'HB9013', scenario: 'scenario2', isAuto: false,
    title: 'RELATING TO COLD STORAGE.',
    description: 'Establishes a Cold Storage and Post-Harvest Infrastructure Grant Program within the Department of Agriculture and Biosecurity to reduce food loss by funding refrigerated storage and handling facilities for local farmers and fishers. Requires a report to the Legislature. Appropriates funds. Effective 7/1/2050. (SD1)',
  },
  {
    simId: 'SIM-14', billNumber: 'HB9014', scenario: 'scenario2', isAuto: false,
    title: 'RELATING TO FOOD WASTE.',
    description: 'Requires the Department of Health to establish a food donation and food waste diversion program, including liability protections for donors and standards for the safe recovery of edible surplus food from food establishments. Requires rules and a report to the Legislature. Effective 1/1/2028.',
  },
  {
    simId: 'SIM-15', billNumber: 'HB9015', scenario: 'scenario2', isAuto: false,
    title: 'RELATING TO AGRICULTURAL WATER.',
    description: 'Appropriates funds to the Department of Agriculture and Biosecurity for the assessment, repair, and modernization of state irrigation systems serving diversified agriculture. Requires a report to the Legislature on the condition of each system. Effective 7/1/2050. (SD1)',
  },
  {
    simId: 'SIM-16', billNumber: 'HB9016', scenario: 'scenario2', isAuto: false,
    title: 'RELATING TO AGRICULTURAL PRODUCTION.',
    description: 'Establishes a nonrefundable income tax credit to incentivize investment in the production of food crops for local consumption. Applies to taxable years beginning after 12/31/2026. Requires the Department of Taxation to report on the credit to the Legislature.',
  },
  {
    simId: 'SIM-17', billNumber: 'HB9017', scenario: 'scenario2', isAuto: false,
    title: 'RELATING TO FOOD SECURITY.',
    description: 'Establishes a Hawaii Food Systems Coordinator position within the Office of the Governor to align state programs advancing local food production, food access, and food security, and to develop a statewide food security plan. Requires reports to the Legislature before the Regular Sessions of 2027 and 2028. Appropriates funds.',
  },
  {
    simId: 'SIM-18', billNumber: 'HB9018', scenario: 'scenario2', isAuto: false,
    title: 'RELATING TO AGRICULTURAL COOPERATIVES.',
    description: 'Authorizes and provides start-up grants for multi-stakeholder agricultural cooperatives that aggregate and market the products of small local farmers. Clarifies the organization of producer and consumer cooperatives under chapter 421C, Hawaii Revised Statutes. Appropriates funds. Effective 7/1/2050. (SD1)',
  },
  {
    simId: 'SIM-19', billNumber: 'HB9019', scenario: 'scenario2', isAuto: false,
    title: 'RELATING TO SCHOOL MEALS.',
    description: 'Requires the Department of Education to provide free breakfast and lunch to all public school students regardless of household income, and to maximize federal reimbursement through community eligibility. Appropriates funds to cover the state share. Effective 7/1/3000. (SD2)',
  },
  {
    simId: 'SIM-20', billNumber: 'HB9020', scenario: 'scenario2', isAuto: false,
    title: 'RELATING TO AGRICULTURAL TRANSPORTATION.',
    description: 'Establishes an Agricultural Transportation Assistance Program within the Department of Agriculture and Biosecurity, consisting of a reimbursement program and a grant program, to help farmers and livestock producers with the inter-island and intra-island shipping costs of moving local food to market. Appropriates funds. Effective 7/1/2050. (SD1)',
  },
];

const SCENARIOS = { scenario1, scenario2 };

/** The sim week: Sept 14 (Mon) .. Sept 18 (Fri) 2026, indexed by sim-day 1..5. */
const SIM_DATES = ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18'];

const SENTINEL_PREFIX = 'test://sim-week/';

/** Origin/receiving committees, exported for tooling/tests. */
const COMMITTEES = { origin: COMMITTEE_1, receiving: COMMITTEE_2 };

export { SCENARIOS, ROSTER, SIM_DATES, SENTINEL_PREFIX, COMMITTEES };
