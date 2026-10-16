# Range slice evidence

Slice: coaching-only public-action range estimate (plan step 3). No commit, push
or agent spawn. Policy v3, `estimate-v3.js`, `charts-v3.js` and the reference
dataset are untouched (`git diff` empty for `training/ranges/estimate-v3.js`,
`charts-v3.js`, `training/policies/`).

## Changed files

- `training/ranges/coach-estimate.js` (new): `estimateCoachRanges`,
  `coachEquityRanges`, `COACH_RANGE_METHOD`, `COACH_RANGE_CONSTANTS`,
  `COACH_RANGE_LIMITATIONS`.
- `tools/review-facts.js`: `decisionFacts` now uses the coaching estimate. The
  `equityRange` field name is kept; a new `rangeEstimate` object is added.
- `shared/decision-facts.js`: additive Korean labels (`rangeLabelKo`,
  `EQUITY_CAVEAT_KO`) and a `rangeMeta` option on `factsLineKo`. `chipFacts`,
  `handFacts` and `equityFacts` are unchanged, so price arithmetic is identical.
  It does not import `training/` (it stays browser-safe).
- `test/coach-ranges.test.js` (new, 29 tests, in-memory fixtures and temporary in-memory
  engine hands only; 17 from the first pass, 12 added or changed by the R1/R2 corrective pass).
- `test/replay-facts.test.js`: no change needed.

## Method

1. Start from `estimateOpponentRanges` (v3 preflop chart for each opponent's first
   preflop action), normalized to a maximum of 1.
2. For each visible postflop action in order, validate it and judge it on the board
   stored on that action. Each action's board must be a prefix of the decision
   board with the length its street requires. Later streets, later cards and
   malformed boards are rejected.
3. For each hand class, average a bounded action likelihood over the combos that
   avoid the board and hero's own cards (blockers). Combo strength is the
   made-hand percentile among all compatible holdings (ties at mid-rank), plus a
   capped draw credit on flop and turn.
4. Multiply the likelihood into the class weight. Each action keeps at least
   `floorShare` (0.02) of the previous weight, and the result is renormalized.
   Weak hands keep support: the likelihood floors are check 0.35, call 0.15,
   bet 0.12 and raise 0.05, relative to the peak.
5. `coachEquityRanges` admits range equity in two steps (R1). First **every live
   opponent**, acted or not, must be fully `conditioned` with a range, the estimate
   must carry no `issues`, and `acted` plus `unacted` must cover exactly the listed
   players. Otherwise there is no range equity (`range-evidence-missing`). Only then
   are the ranges of the opponents already committed on the current street (acted
   this street, or all-in) used, and the unacted ones, whose evidence is complete, are
   excluded and counted (`excluded`, shown as `아직 행동 전 N명 제외`).

Per-opponent status:

- `conditioned`: a preflop range exists and every visible postflop action was applied.
- `partial`: a range exists but evidence is incomplete. Reasons are
  `missing-street-action` (a completed street has no action from a player who is
  not all-in) and `later-preflop-action-not-modeled`.
- `unavailable`: `range` is null. Reasons are `no-preflop-range`, `bad-board`,
  `board-street-mismatch`, `board-not-history`, `future-street`, `unknown-action`,
  `bad-sizing`, `no-compatible-combo`, `earlier-preflop-evidence` (another player's
  earlier preflop action that the v3 chart reads is malformed) and the whole-snapshot
  reasons `bad-board-evidence`, `bad-preflop-context`, `malformed-action`,
  `unknown-street` and `bad-actions` (also recorded in `issues`).
- If the seats themselves are unreadable (`bad-seat-evidence`, `bad-snapshot`,
  `estimate-failed`) there are no players at all, only an `issues` entry, and range
  equity is refused.

Overall status is `full`, `partial` or `unavailable`. The function never throws on
bad evidence. `decisionFacts().rangeEstimate` exposes method, status,
limitations, issues, acted/unacted ids and per-player status. It does not expose
weights, cards or personas.

The Korean line now says the range equity is a public-action heuristic and not
calibrated, names how many opponents it covers and how many unacted ones were
excluded (`행동한 N명 대상, 아직 행동 전 M명 제외`), or says why it is omitted
(`레인지 에퀴티 생략(…)`). Whenever any equity is shown, it also states that the
equity is a showdown simulation and not an action EV, and that price comparison
cannot settle future betting, multiway pots or reopened calls.

## RED / GREEN

The estimator module is new, so a plain "test fails before the code exists" would
only be an import failure. Behavioural RED evidence therefore comes from two
checks.

**Wiring RED.** I restored HEAD versions of `tools/review-facts.js` and
`shared/decision-facts.js` (temporarily, then put my versions back) and ran
`test/coach-ranges.test.js`. 4 of 16 tests failed: the three-handed
unacted/omission test, the no-acted-opponent test, the metadata/caveat test, and
the pressure-vs-passive equity test. They passed once the wiring was in place.

**Mutation RED.** I temporarily broke `coach-estimate.js` and restored it after
each run (checked by `diff`):

| Mutation | Tests that failed |
|---|---|
| judge every action on the decision board | "judged on the board it was made on" |
| checks carry no information | pressure vs check-through; check changes weights |
| remove the likelihood and share floors | "bounded share: bluff and weak support persist" (ratio 4.8e-5) |
| accept future streets | future/malformed evidence rejected |
| ignore a missing street action | missing-street-action → partial |
| treat unacted opponents as acted | three-handed unacted; nobody-acted |

The first run of the floor mutation survived, because strengths are never exactly
0 and the positivity test alone passed. I added the bounded-ratio test
(weakest/strongest likelihood ≥ 0.04 and < 0.9) and re-ran the mutation to
confirm it fails.

**GREEN** (final run, `node --test --test-concurrency=1`, each file under 120 s):

| File | Result |
|---|---|
| `test/coach-ranges.test.js` | 17 pass, 0 fail (first pass; superseded by the corrective pass below: 29 pass) |
| `test/decision-facts.test.js` | 7 pass |
| `test/replay-facts.test.js` | 3 pass |
| `test/strategy-v3.test.js` | 11 pass |
| `test/coaching-claims.test.js` | 7 pass |
| `test/decision-aid.test.js` | 3 pass |
| `test/boundaries.test.js` | 18 pass |

## What the tests prove

- Triple-barrel pressure vs a check-through on the identical river board give
  different ranges. The oracle is a pair-or-better combo share counted with
  `scoreCards`, not the estimator's own formula. Range equity is lower against
  pressure.
- A check changes the weights, but the best holding keeps ≥ 20% of its relative
  weight and no class disappears.
- Weak support is positive and bounded after one action and after three actions.
- Reproducible and finite: the result is `deepEqual` across calls and cloned
  input, with JSON round-trip and weights in (0, 1].
- Later boards do not matter: with only a flop action, changing the turn card
  leaves the villain's range identical. A different flop changes it.
- Hidden or future material (opponent hole cards, persona, notes, reasons, record
  showdown, future board) does not change the result, and no card strings appear
  in it.
- Future streets, boards that are not the history, bad boards, unknown actions,
  bad sizing, an invalid or duplicate decision board and hero cards on the board
  are all rejected. A limp (outside the charts), a missing street action and any
  live opponent without evidence, acted or not, never produce a full estimate or
  range equity.
- When every live opponent is conditioned, unacted opponents are excluded and
  labelled. The equity equals
  `equityFacts(snap, { ranges: [actedRange] })`.
- `chips` from `decisionFacts` equals `chipFacts`. The preflop 33.3% required
  equity, the partial all-in call and the side-pot examples are unchanged. The v3
  estimator output is identical before and after the coaching estimate, and the
  two share no state.
- Real engine decisions (temporary in-memory game) give valid evidence and
  deterministic fact lines.

## Results and limitations

- Not run: `test/game-loop-learning-feedback.test.js` and
  `test/coach-prospective-input.test.js` fail here with `IDENTITY_UNAVAILABLE`,
  because `ps` is `operation not permitted` in this sandbox and the loop lock
  cannot be acquired. The cause is environmental, not this slice. I did not
  override the sandbox. By reading them, their assertions on fact lines
  (`d-1-…: 팟 [\d.]+BB`, `유효 스택`) match the unchanged line prefix. Re-run them
  outside the sandbox before merging.
- I did not run the full suite.
- The likelihood constants are engineering assumptions, not calibrated poker
  frequencies. The estimate is a coaching aid only, with no GTO or EV claim.
- The preflop part keeps v3's limits: only each opponent's first preflop action
  is modeled. Limps and a caller before the opponent give no range. An opener who
  later faces a 3-bet is marked `partial`, which omits range equity in many
  3-bet pots. Omission is deliberate, not a bug.
- Excluding unacted opponents (only when all live opponents are conditioned) means no range equity when hero is first to act
  (the random-hand number is still shown). With several opponents committed it is
  a multiway equity against their ranges only.
- Sizing uses raise-to / pot before the action. The record has no per-street
  prior bet, so re-raise sizes are approximate.
- Preflop snapshots are still handled by the v3 chart. The postflop reweighting
  adds nothing there.
- `server/public/replay-facts.js` is not changed. Its line now also carries the
  not-an-EV caveat whenever it shows an equity, because `factsLineKo` adds it.
  It still shows only the random-hand equity, because it passes no range.
- Real-provider behaviour is not exercised: this slice has no LLM calls.

## Corrective pass: R1 (all live opponents) and R2 (consumed evidence)

Accepted independent findings R1 and R2 (R3, the study-button race, belongs to another
slice). Files changed: `training/ranges/coach-estimate.js`, `test/coach-ranges.test.js`
and this document. Not touched, and `git diff HEAD` is empty for them:
`training/ranges/estimate-v3.js`, `charts-v3.js`, `training/policies/`. I did not edit
`tools/review-facts.js` or `shared/decision-facts.js`; their current text already
says "남아 있는 상대 중 레인지 근거가 없거나 불완전한 상대가 있음", which matches R1.

### R1: range equity needs every live opponent

`coachEquityRanges` used to check only `estimate.acted`, so a live unacted opponent
with no range (or a partial one) still got a subset equity labelled as complete. It
now refuses unless all live opponents are `conditioned` (see Method step 5). The
three-handed test that asserted a numeric subset equity against p2 (`no-preflop-range`)
now asserts omission. A new three-handed fixture where both opponents sit on charted
lines (BTN opens, SB calls, hero BB calls) keeps the subset equity with the
`행동한 1명 대상, 아직 행동 전 1명 제외` label, and a real engine hand shows the same.
When the omission is due to missing evidence `excluded` is 0, so the line does not
claim an opponent was "excluded" from a number that was never computed.

### R2: validate everything the estimate reads

Required, otherwise the opponent is `unavailable` and never defaulted:

| Evidence | Rule | Reason |
|---|---|---|
| Snapshot | object | `bad-snapshot` |
| Seats | list of objects; unique string `playerId`; boolean `out`, `folded`, `allIn`; string `position` for every seat still in the game; `actorId` is a seated, live seat | `bad-seat-evidence` (no players listed) |
| Decision board and hero cards | street known, board length matches, no duplicates; hero holds exactly two valid cards not on the board | `bad-board-evidence` |
| Big blind | `blinds[1]` positive integer (sizes every preflop shove test) | `bad-preflop-context` |
| Timeline | `priorActions` is a list; each entry an object with a string `playerId` and a known string `street` | `bad-actions`, `malformed-action`, `unknown-street` |
| Any action | `action` is fold/check/call/raise | `unknown-action` |
| Preflop raise | integer `amount` > 0 and integer `maxRaiseTo` >= `amount` (the cap decides shove vs open) | `bad-sizing` |
| Postflop action | street not after the decision; board is valid and a prefix of the decision board | `future-street`, `bad-board`, `board-street-mismatch`, `board-not-history` |
| Postflop call or raise | integer `potTotal` and `callAmount` >= 0 (the price separates a bet, with nothing to call, from a raise) | `bad-sizing` |
| Postflop raise | integer `amount` > 0 | `bad-sizing` |

The v3 chart classifies an opponent's line from **every** preflop action up to and
including that opponent's first one, whoever made them. A malformed earlier action of
another player (for example the hero's open without `maxRaiseTo`) therefore makes the
opponents who answer it `unavailable` with `earlier-preflop-evidence`. Preflop actions
after the opponent's first one are not read and do not matter. Another player's
postflop action only affects that player.

Assumptions, all taken from `engine/decision.js` and `engine/hand.js`:

- Chip counts are integers and flags are booleans; any other type counts as missing.
  This is the engine's own contract (`snapshotDecision` rejects non-integers, and
  `applyAction` requires an integer raise-to no larger than the cap).
- Only fields the estimate reads are required. A test strips every field it does not
  read (`decisionId`, `stacks`, `currentBet`, `minRaiseTo`, `reason`, `note`,
  preflop `board` / `potTotal` / `callAmount`, non-raise preflop `amount` / `maxRaiseTo`,
  checks' prices, snapshot-level pot and legal fields, seat `stack` / `bet` /
  `contribution`) and requires an identical result, so older or trimmed records that
  still carry the read fields keep working.
- An entry that cannot be attributed to a player or placed on a street could belong
  to anyone (v3 reads a missing street as preflop), so it makes every opponent
  `unavailable` rather than guessing whose it is.
- Hero cards are required: a malformed pair used to mean "no blockers", which changes
  the blocker-adjusted range.
- A legacy record whose raises lack `maxRaiseTo`, or whose postflop raises lack
  `callAmount`, now gets no coaching range. The policy-v3 path (`estimate-v3.js`) is
  unchanged and still handles them as before.
- `estimateCoachRanges` is wrapped so that any unexpected exception becomes an
  `estimate-failed` issue instead of propagating.

### RED / GREEN for the corrective pass

RED, before any change to `coach-estimate.js` (the new and changed tests against the
first-pass estimator; `node --test --test-concurrency=1 test/coach-ranges.test.js`):
11 of 29 failed, 18 passed.

| Failing test | Why it failed (first assertion) |
|---|---|
| three-handed: any live opponent without evidence | numeric subset range returned for the unacted p2 with no preflop range (R1) |
| unacted opponent partial or unavailable | same, for a partial unacted opponent (R1) |
| `coachEquityRanges` refuses incomplete estimates | `TypeError` reading `unacted.length` of a hand-built estimate |
| postflop raise without a valid price | `conditioned`, range returned, with `callAmount` deleted (R2) |
| every field the likelihoods read | `bet.callAmount` missing was `conditioned` (R2) |
| action that cannot be placed in the timeline | a flop bet with no street became a second preflop action, `partial` |
| preflop evidence | opener without `amount` became a full RFI range, `conditioned` |
| decision context must be complete | missing big blind gave `issues: []` and no `bad-preflop-context` |
| no junk in any field | missing `holeCards` admitted a different range (blockers silently dropped) |
| bad decisions inside a hand record | the decision with no raise price still printed `추정 레인지 대비 에퀴티` |
| real engine hands | the same hand with `callAmount` deleted from the villain's bet stayed `conditioned` |

Two of those 11 first failed for a reason in my own fixtures, not in the estimator: the
heads-up fixture had hero and villain positions swapped, and a decision with a broken
big blind has no fact line at all because `chipFacts` returns null. I fixed the
fixtures, re-ran, and confirmed each of the two by running it alone: it then failed on
the intended behaviour (an opener without `amount` read as a conditioned full range, and a bad decision
still carrying range equity).

GREEN, after the change (each command a separate run, under 120 s):

| File | Result |
|---|---|
| `test/coach-ranges.test.js` | 29 pass, 0 fail (about 5.4 s) |
| `test/decision-facts.test.js` | 7 pass |
| `test/replay-facts.test.js` | 3 pass |
| `test/strategy-v3.test.js` | 11 pass |
| `test/coaching-claims.test.js` | 7 pass |
| `test/decision-aid.test.js` | 3 pass |
| `test/boundaries.test.js` | 18 pass |
| `test/coach-prospective-input.test.js` | 10 pass, 7 fail, all `IDENTITY_UNAVAILABLE` |

The `coach-prospective-input` result is identical with the first-pass estimator
(10 pass, 7 fail), so the 7 failures come from this sandbox (`ps` is not permitted, the
loop lock cannot be acquired), not from this change. Re-run it outside the sandbox.

Mutation check of the new tests (each mutation applied to `coach-estimate.js` alone,
the file restored and compared with `diff` afterwards): all 12 were caught.

| Mutation | Tests that failed |
|---|---|
| admission checks acted opponents only (R1 back) | three-handed; unacted partial; hand-built estimates |
| raise no longer needs `callAmount` | raise price; required fields; fuzz; mixed record; real engine |
| no check of other players' earlier preflop actions | preflop evidence; mixed record |
| preflop raise needs no `amount` / `maxRaiseTo` | preflop evidence; unacted partial; mixed record; real engine |
| missing street defaults to preflop | timeline test |
| seat flags not validated | decision context; mixed record |
| hero cards optional | decision context; fuzz |
| big blind not validated | decision context |
| `issues` ignored at admission | mixed record; hand-built estimates |
| actor not checked | decision context |
| over-strict: postflop actions need `minRaiseTo` | required fields; unread-fields test |
| preflop check also reads actions after the opponent's first | preflop evidence |

The fuzz test sets every path of a good river snapshot to eight kinds
of junk (missing, null, NaN, Infinity, -1, a string, an object, an array). It requires
that nothing throws, the result is serialisable, weights stay in (0, 1], and any range
equity still admitted is **identical** to the baseline's, so a read field can never be
silently defaulted into a different range. Where the unchanged `chipFacts` /
`equityFacts` helpers themselves throw (for example no `holeCards`), that shape is not
fed to `decisionFacts`; see the next section.

### Remaining limits (outside this slice)

- `decisionFacts` in `tools/review-facts.js` computes the random-hand equity
  (`equityFacts(snap)`) outside any `try` block, as it did at HEAD. A decision without
  `holeCards` therefore throws `cards must be an array` before the range path is
  reached, and `tools/game-loop.js` catches that per hand, which drops the evaluator
  facts of every decision in that hand, not only the bad one. The range estimate itself
  does not throw. Real engine records always carry `holeCards`. Moving that call into
  the existing `try` (or computing per decision) is a one-line change for the owner
  of `tools/review-facts.js`.
- Mixed records are covered where `chipFacts` accepts the shape: a good decision keeps
  its range line, a decision with a missing raise price, a missing seat flag or a
  missing opener cap keeps its price arithmetic and random equity but omits range
  equity, and a decision with no big blind has no line at all.
- Not run: the full suite, `game-loop*.test.js` and live model calls, as instructed.

## Parent integration follow-through

The parent accepted the mixed-invalid-decision concern. `decisionFacts` now
returns null for unreadable raw decisions rather than throwing past the hand's
remaining valid facts. A regression first failed on missing hole cards, then
passed while proving the valid decision in the same hand still produces its
exact fact line. The final range suite has 30 tests. Host range, prospective
coach and fact tests passed 54/54, including all real-loop identity paths that
the maker's guarded sandbox could not execute. Preserved policy/reference
files remain checked separately against 25 baseline hashes.
