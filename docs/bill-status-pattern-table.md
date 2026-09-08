# Bill-Status Deterministic Pattern Table

Reference + debugging aid for the deterministic bill-stage classifier that replaces the LLM
(`statusClassifierService.js` → pure `classifyStatus`). This is the authoritative rule table.

- **Source of rules:** mined from the production DB, 2026 session (`scripts/llm/mine-phrasings.mjs`).
  Frequencies below are 2026 newest-line counts unless noted.
- **Matching:** each rule regex is case-insensitive, whitespace-relaxed (` ` → `\s{,10}`), and
  matched with `.search()` (substring, not anchored) — the Open States convention.
- **Precedence:** rules are evaluated **top tier first, top rule within a tier first**. The first
  matching rule for a given status line wins (governor/conference beat committee stages).
- **Rollup:** every status line is tagged; the bill's stage = the **most-advanced** tag seen
  (max `COLUMN_INDEX` in `server/kanban-columns.js`), then `enforceForwardProgression` prevents
  regression. Terminal tags (governor/veto/dead) and the hearing-cancelled revert are handled
  before the guard.
- **No match → keep current status + log the unmatched line** (self-healing: log drives new rules).

## Context flags (computed deterministically, no AI)

| Flag | How it's derived |
|---|---|
| `originChamber` | `HB*` → House, `SB*` → Senate (bill number prefix) |
| `crossover` | newest status line's chamber ≠ `originChamber` |
| `bothChambers` | distinct chambers across full history contains both `H` and `S` |
| `committeeOrdinal` | position (1/2/3) of the committee named in the line, within the referral order of the current chamber phase. Joint committees (`ECD/TOU`) = one slot. **Capped at 3** — a rare 4+-committee referral clamps to 3, since the enum only defines the `scheduled{N}`/`waiting{N}`/`deferred{N}` families up to 3. |

`crossover` selects the `crossover*` stage variant. `bothChambers` gates the conference tier.

---

## Tier 0 — Terminal / Governor  (highest priority; stops further matching)

| # | Regex (case-insensitive) | → result | Corpus phrasing |
|---|---|---|---|
| 0.1 | `\bAct\s+\d+` | `governorSigns` | `Act 071, on 05/19/2025 (Gov. Msg. No. 1171).` |
| 0.2 | `became law without` | `lawWithoutSignature` | (enum-defined; rare) |
| 0.3 | `Vetoed\b.*line-item` | `vetoList` | `Vetoed on DATE - Returned from the Governor ... line-item` |
| 0.4 | `\bVetoed\b\|Notice of Intent to veto\|intent to veto` | `vetoList` | `Vetoed (Gov. Msg. No. #).`, `Notice of Intent to veto dated ...` |
| 0.5 | `Failed to pass (Third\|Final) Reading` | set `dead=true`, keep stage | `Failed to pass Third Reading. Ayes ...` |
| 0.6 | `Enrolled to Governor\|Transmitted to the Governor` | `transmittedGovernor` | `Enrolled to Governor.` (15+6) |

**Explicit non-match guard:** `Received from Governor re: emergency appropriation` and
`Received from Governor re: Recommended for Immediate Passage` are gubernatorial *origination*,
NOT a terminal governor stage. They match none of the above and fall through to committee logic.

---

## Tier 1 — Conference  (only applied when `bothChambers === true`)

| # | Regex | → stage | Corpus phrasing (freq) |
|---|---|---|---|
| 1.1 | `Reported from Conference Committee` | `conferencePassed` | fixture |
| 1.2 | `Conference [Cc]ommittee recommends that the measure be PASSED` | `conferencePassed` | fixture |
| 1.3 | `Bill scheduled for Conference Committee Meeting\|Conference committee meeting (to reconvene\|scheduled)\|Conference Committee Meeting will reconvene` | `conferenceScheduled` | 13+30+... |
| 1.4 | `discharge of all .* Conferees\|Conferee\(s\) discharged\|conferees being discharged` | `conferenceAssigned` | 84+8+7 (conference broke down → back to awaiting) |
| 1.5 | `Conferees Appointed\|notice of (appointment of )?(Senate\|House) conferees\|notice of change in .* conferees` | `conferenceAssigned` **if `bothConferees`** else `passedCommittees` | 50+35+4 |
| 1.6 | `Received notice of disagreement\|(Senate\|House) disagrees with .* amendment` | `conferenceAssigned` **if `bothConferees`** else `passedCommittees` | 16+9+8 |

> **DOMAIN RULE — `conferenceAssigned` requires BOTH chambers to have appointed conferees.**
> `bothConferees` = the history contains a House-conferee appointment AND a Senate-conferee
> appointment. One chamber alone (or a bare disagreement) keeps the bill at `passedCommittees`.

> **DOMAIN RULE — re-referral after a prior committee passage → `waiting2` (crossover variant).**
> `Re-Referred`/`Recommitted` when the phase already has a committee-passage line means the bill
> cleared a committee and is waiting for the next one. With no prior passage it's an intro/landing
> (re)assignment (`introduced` / `crossoverWaiting1`).

If `bothChambers === false`, the whole tier is skipped even if text says "conference".

---

## Tier 2 — Passed all committees  (both chambers passed, pre-conference)

| # | Regex | → stage | Corpus phrasing |
|---|---|---|---|
| 2.1 | `Received from (House\|Senate).*in amended form` | `passedCommittees` | fixture L35 |
| 2.2a | `Passed (Third\|Final) Reading.*Transmitted to (the )?(House\|Senate)`  **AND** destination ≠ `originChamber` | `crossoverWaiting1` | `Passed Third Reading ... Transmitted to Senate.` (HB) |
| 2.2b | `Passed (Third\|Final) Reading.*Transmitted`  **AND** `crossover` (return trip) | `passedCommittees` | fixture L20/L36 |

> **DOMAIN RULE — outbound transmit vs. return trip (rule 2.2a before 2.2b).** The origin chamber
> posts `Passed Third Reading ... Transmitted to the <other chamber>` *before* the receiving chamber
> logs `Received from ...`, so `crossover` is not yet true from a receiving-chamber line. Direction
> disambiguates: an HB (origin H) `Transmitted to the Senate` is **outbound** → `crossoverWaiting1`
> (stable with rule 4.1 once receipt is logged); an HB `Transmitted to the House` is the **return
> trip** after the Senate amended it → `passedCommittees`. When origin is unknown, 2.2a is skipped
> and 2.2b applies its crossover-gated fallback.

---

## Tier 3 — Committee stage  (family rules resolved by `crossover` + `committeeOrdinal`)

`SCHED(n)` → `scheduled{n}`, `DEFER(n)` → `deferred{n}`, `WAIT(n)` → `waiting{n}`,
each prefixed `crossover` when `crossover === true` (e.g. `crossoverWaiting2`).

| # | Regex | → family | Corpus phrasing (freq) |
|---|---|---|---|
| 3.1 | `deleted the measure from (the public hearing\|decision making)` | **revert** `SCHED(n)` → `WAIT(n)` | 10+3 (hearing cancelled) |
| 3.2 | `scheduled to be heard by\|has scheduled a public hearing\|will hold a public decision making\|Meeting Scheduled on` | `SCHED(ordinal)` | 7+6+4+3 |
| 3.3 | `committee(\(s\))? on .* deferred the measure\|be DEFERRED\|recommend(s)? that the measure be deferred` | **`SCHED(ordinal)`** (see rule below) | **120+107** |

> **DOMAIN RULE — deferral does NOT move to a `deferred{N}` column.** An explicit committee
> deferral keeps the bill at `scheduled{N}` (the hearing it was scheduled for). The deferral is
> effectively a death; the UI reads the deferral text to explain why. The `deferred1/2/3` columns
> in the enum are therefore never produced by the classifier.
| 3.4 | `recommend(s)? that the measure be PASSED` | `WAIT(ordinal+1)` | **557+489** (most common line) |
| 3.5 | `Reported from .* recommendation of passage on Second\|recommending passage on (Second\|Third)` | `WAIT(ordinal+1)` | 54+23 |
| 3.6 | `Reported from .* recommending referral to\|Report adopted; referred to the committee` | `WAIT(ordinal+1)` | 18+3 |
| 3.7 | `Passed Second Reading.*referred to the committee\|Report adopted; Passed Second Reading.*referred` | `WAIT(ordinal+1)` | 27+14+7 |

### Ordinal semantics (the subtle part)

- **PASS / deferral line** names the committee that *just acted* (committee N). "Committee N
  passed" → bill is now **`waiting{N+1}`** (confirmed convention). "Committee N deferred" →
  **`deferred{N}`** (stays at N).
- **Referral / report line** (`referred to FIN`) names the **next** committee directly — FIN's
  ordinal is already N+1, so tag = `waiting{FIN's position}` with **no** extra +1.
- The classifier must use the committee captured by the matching regex to look up its position
  in the referral order for the current chamber phase.
- **Crossover reset:** after crossover the opposite chamber issues its own referral; that new
  referral list resets 1/2/3 for the post-crossover phase.
- **Ordinal cap at 3:** `committeeOrdinal` clamps its result to a maximum of 3. The enum stops at
  `scheduled3`/`waiting3`/`deferred3` (and their crossover forms), so a 4th-committee referral is
  treated as the 3rd column rather than emitting an invalid `scheduled4` that fails the DB insert.

---

## Tier 4 — Introduction / crossover landing  (lowest priority)

| # | Regex | → stage | Corpus phrasing (freq) |
|---|---|---|---|
| 4.1 | `Received from (House\|Senate)`  **AND** `crossover` | `crossoverWaiting1` | 51+12 |
| 4.2 | `(Re-?[Rr]eferred\|Recommitted) to` | referral → `introduced` (or `crossoverWaiting1` if crossover) | **306+336+37** |
| 4.3 | `Referred to .*(referral sheet\|,)\|Referred to [A-Z]` | `introduced` (or `crossoverWaiting1`) | **479+1181** |
| 4.4 | `Introduced and Pass(ed)? First Reading\|Pass(ed)? First Reading\|^Introduced\.\|Pending introduction` | `introduced` | 315+205+55 |

---

## Ambiguous → no-op (keep current status, log for review)

| Regex | Why not classified |
|---|---|
| `The recommendation was not adopted` | Outcome unclear (3 hits) — don't guess |
| `Received notice of Final Reading` (alone) | Context-only notice, not a stage change |
| *(no rule matches)* | Log the line so a rule can be authored later |

---

## Worked example (fixture bill: SB → House → conference → Governor)

| Newest line | Flags | Matched rule | Stage |
|---|---|---|---|
| `Referred to AEN, WAM.` | crossover=NO | 4.3 | `introduced` |
| `committee(s) on AEN ... scheduled a public hearing` | NO, ordinal(AEN)=1 | 3.2 | `scheduled1` |
| `AEN recommend(s) ... be PASSED` | NO, ordinal(AEN)=1 | 3.4 | `waiting2` |
| `Received from House ... in amended form (SD 2)` | crossover=YES | 2.1 | `passedCommittees` |
| `AGR recommend that the measure be PASSED` | YES, ordinal(AGR)=1 | 3.4 | `crossoverWaiting2` |
| `Conferees Appointed` | bothChambers=YES | 1.5 | `conferenceAssigned` |
| `Reported from Conference Committee` | bothChambers=YES | 1.1 | `conferencePassed` |
| `Enrolled to Governor.` | — | 0.6 | `transmittedGovernor` |
| `Act 048, on 05/14/2025` | — | 0.1 | `governorSigns` |

---

## Maintenance

- Re-mine phrasings each session: `node scripts/llm/mine-phrasings.mjs`. New high-frequency
  shapes not covered here should become new rules.
- The "no match → log" bucket is the backlog of rules to add.
- Frequencies are a snapshot; the *set* of shapes is stable across sessions, the counts drift.
