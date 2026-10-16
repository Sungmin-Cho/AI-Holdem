# Coaching slice evidence: prospective hand-coach input (corrective attempt)

## Changed files

- `tools/coach-prompt.js` (new): target selection, prompt, fixed-outcome contract.
- `tools/game-loop.js` (coaching sections only): imports the module, `buildCoachPrompt`
  delegates to it, `coachPipeline` selects the target and applies the contract,
  `validateCoachNote` takes an optional `allowedDecisionIds`. `coachFactsLines` is removed.
- `test/coach-prospective-input.test.js` (new): 10 pure tests, 6 real-loop prompt-capture tests.
- `test/game-loop.test.js`, `test/game-loop-finalize.test.js`: only expectations of the old
  coach prompt / outcome / target contract (listed below).
- `docs/implementation/coaching-quality-coach.md`: this file.

## What this corrective attempt changed

The first attempt added an outcome/card sentence filter (`dropOutcomeClaims`, a phrase regex plus a
card-token regex). A parent reproduction showed `dropOutcomeClaims("쇼다운 가치가 있어 체크를 고려하세요.")`
returned an empty string, and the card-token rule also dropped legitimate hypothetical examples.
That filter and its tests are **removed entirely**. Nothing in the sidecar now reads, drops or
rewrites `text`, `why` or `alternative`. The agreed safety properties are:

1. prospective input invariance (the prompt is built from one validated decision-time snapshot),
2. a fixed outcome written by the sidecar,
3. the existing validators (decision contract, `coachingClaimAllowed`, private literals, hidden and
   live cards, multiplayer host-text rule) unchanged.

This module makes **no claim** that the model's prose is free of an outcome claim. The prompt tells
the model it knows nothing after the decision; that is an instruction, not enforcement.

## Behavior

1. **Input.** `buildProcessInput([captured redacted hand])` (the existing validated
   `toProcessReview` projection) feeds `selectCoachTarget`. Only `available` user decisions of the
   requested hand whose `decisionFacts` are computable compete. The prompt carries one target's own
   validated snapshot (prior actions without the per-action stack maps), its `decisionFacts` line,
   the result-independent practice focus and the overfold flag. The completed redacted hand and the
   replay are not in the prompt. They are still captured to disk, hashed and passed to the
   validators, so the raw-capture and publication APIs are unchanged.
2. **Target rule** (result-independent, from the decision's own snapshot): committed cost = call and
   fold use `toCall` (a fold counts the price it declined), raise and bet use `amount - actorBet`,
   check is 0. Order: deliberate before timeout-forced, cost descending, then the earlier decision
   (street, then index). Other user snapshots are excluded because a later snapshot carries later
   boards. Earlier actions are the target's context (its `priorActions`); no later decision is named.
3. **No target = unavailable.** Legacy schema 1, missing or inconsistent legal evidence, or
   uncomputable facts leave no target. The existing `completeCoachUnavailable(...,
   'process-evidence-unavailable')` path publishes the honest placeholder and the model is not called.
   The existing "unavailable decisions were excluded" notice is still appended to a published note.
4. **Single model call.** One `oneshotStart` per attempt; the pipeline's existing second attempt after
   an invalid output (same bounded recovery) is unchanged and is not a second role.
5. **Fixed outcome, injected by the sidecar.** The prompt does not ask for `outcome`.
   `applyProspectiveNoteContract` sets every decision row's `outcome` to `COACH_FIXED_OUTCOME`
   (`결과는 리플레이에서 별도로 확인하세요.`) and changes nothing else. The pipeline validates twice:
   a containment pass with `{ keepModelOutcome: true }` keeps an `outcome` the model wrote anyway, so
   the existing private-card validators see every word it produced (a deferral from this pass is
   rewritten to the fixed outcome before it is stored), then the note that is sealed and proved,
   with the fixed outcome, is validated. A model-written outcome therefore cannot bypass those
   validators and is never published.
6. **Target-only ids.** `allowedDecisionIds = {target}` replaces the replay's decision set for a
   fresh note. Recovery paths (`result-ready` heartbeat, deferred flush) still validate stored notes
   against the replay set; the deny validators are unchanged.
7. **Prompt warning.** The prompt states that price arithmetic (required equity, pot odds, SPR) is
   separate from heuristic equity (random or estimated range), that hand strength and draws are
   facts and not action EV, and that equity does not fix a call EV with betting left. The facts line
   is the range worker's `decisionFacts` (it omits range equity when any live opponent lacks
   evidence) and is consumed unchanged.

## RED / GREEN

**Proven RED (pure, this attempt).** The regression test for legitimate showdown-value and
hypothetical range advice was written first and run against the filter version of
`applyProspectiveNoteContract`:

```
✖ RED-PROBE legitimate showdown-value and hypothetical range advice survives the note contract
  actual:   ''
  expected: '쇼다운 가치가 있어 체크를 고려하세요. 예를 들어 Qh Jh 같은 핸드라면 이 가격에 콜 레인지에 넣을 수 있습니다.'
```

It reproduces the parent's finding: the whole note text was dropped. After the filter was removed the
same assertions pass (below). This is a behavior RED of the code I am replacing, not an import failure.

**Pinned-base RED of the prospective-input change: NOT PROVEN by me.** The earlier "OLD prompt
identical: false" numbers came from a `/tmp` script that rebuilt the old composition itself; that is a
reimplementation, not the old production path, and **is withdrawn** as evidence. The real loop tests
need `ps` (`acquireOwnedLock` → `IDENTITY_UNAVAILABLE`), which my guard forbids, so I could not run
them against the base. What I did instead:

- The new test file has no top-level import of `tools/coach-prompt.js` (the pure tests load it lazily,
  and the loop tests do not use it). I confirmed on a clean `git archive` of the base commit
  `b239dd7` that the file loads and collects without a file-level import error: a pure test fails
  per test on the missing module (not a behavior RED), and the loop tests are runnable there.
- `/tmp/coach-pinned-red/run.sh` (scratch, outside the repo) exports the base, symlinks
  `node_modules`, copies only the new test file and runs the real-loop tests against the OLD prompt
  path. Run it where `ps` works. Expected: `captured hand-coach prompt is byte-identical…` fails at
  `assert.equal(a.prompt, b.prompt)` (the old prompt inlines the replay and redacted captures);
  `the published note carries the fixed outcome…`, `legitimate … is published unchanged` and the
  `public` (`all`) variant of `a model-written outcome…` fail because the old prompt names no target
  (and the old `outcome` is the model's). The `showdown` variant of the outcome test and the
  `without valid decision-time evidence` test may pass on the base (the old path also refuses a
  hidden card and also leaves legacy data unavailable); they are guards, not REDs, and on the new
  code the showdown refusal can only come from the card because the target id is valid.

**GREEN.**

- `node --test --test-concurrency=1` over the 10 pure tests of
  `test/coach-prospective-input.test.js` → 10 pass, 0 fail (about 0.5 s).
- `test/decision-time-review.test.js test/coach-decisions.test.js test/coaching-claims.test.js` →
  34 pass, 0 fail.
- `node --check` passes for `tools/coach-prompt.js`, `tools/game-loop.js` and the three edited test
  files.
- Host run of the first version of the loop tests (parent, `coach-integration-first.log`): 11 of 12
  passed. The one failure was my assertion `!prompt.includes('d-1-preflop')`, which wrongly banned the
  target's earlier-action ids (`priorActions` carry `d-1-preflop-0/1`). Earlier actions are allowed
  context; only future decisions are not. It is replaced by a boundary check: the snapshot JSON is
  parsed, every prior action id has a smaller index than the target, the largest decision index named
  anywhere in the prompt is the target's, and exactly one snapshot (`"holeCards"` once) is shown.
  Byte-equality across a different deck/replay and the undealt-card negative controls are kept.
- **Not run by me:** every real-loop test (6 in the new file plus the edited ones below). They are
  unverified until the parent runs them on the host. I do not mark them passed.

Pure tests cover: costliest-first target; tie and fold-price rule; forced demotion; invalid, tampered
and legacy legal evidence (skipped, or null for all-invalid, no prompt); other hand number; byte
identical prompt under changed board/holes/showdown/pots/end stacks/net/winners/actions/names/
archetypes; a changed later user snapshot (turn and river) not changing an earlier selected target,
with a control that the target's own snapshot does; the warning text; fixed-outcome injection, the
containment variant and pass-through of non-notes; legitimate showdown-value/hypothetical advice
surviving the contract and the existing `sanitizeCoachingText`, `coachingClaimAllowed` and
`validateCoachDecisions` unchanged; and a property that, for hostile wordings (`결국 이겼다`, `쇼다운`,
card tokens in several spellings, empty, whitespace), only `outcome` differs between input and output.

Real-loop tests (new file, injected runtime fixtures, temp stores): prompt byte-identity across a
different deck and reveal policy plus the future boundary; published note with the fixed outcome and a
non-target id refused once; legitimate advice published unchanged with one model call; a
model-written outcome naming p1's card refused and retried under `showdown` and replaced by the fixed
outcome under `all` (prose fields only are searched, because the proof's hex digest can spell a club or
diamond card by chance); legacy data unavailable with zero model calls.

## Existing tests edited (expectations of the old contract only)

Not run by me (they need `ps`); the parent must run them.

`test/game-loop.test.js`:

- Added `COACH_FIXED_OUTCOME` and `coachTargetOf(prompt)` (reads the id from the prompt's
  `(d-…)만 한국어` line).
- `코치는 redacted hand·stats를 reserve 전에 캡처하고 …`: `(replay)` header now asserted absent; the
  prompt must name a target. Event order and all other assertions are unchanged.
- `코치 프롬프트는 상대 카드·정책·아키타입을 …` (renamed from "replay 범위 카드만 담고 …"): the old
  expectation that the prompt contains the replay bytes and the replay-public opponent cards is
  reversed to a stronger one: neither capture's bytes, no opponent card in either reveal mode, and none
  of the archetype/personality/policy sentinels are in the prompt. The deny assertions are unchanged.
- `코치 프롬프트는 완료된 redacted·replay 캡처를 인라인하지 않고 캡처 파일은 보존한다` (renamed from
  "… exact bytes를 모두 인라인한다"): capture files still exist, are not in the prompt, and the prompt
  carries a target snapshot.
- `replay에 없는 decisionId는 …`, `폴드 상대 카드 outcome 인용은 …`, the deferral test, the
  `replay 범위 밖 카드 …` tests (including the two spellings), the `Kh` test, the SIGKILL-resume test and
  the proof-bearing test: the valid id is now the prompt's target instead of `replay.decisions[0]`
  (without this the card-containment tests would have been refused for the wrong reason and passed
  vacuously). The `all` fold-card test now expects the fixed outcome and that the card is absent from
  the published prose; the deferral tests also assert the stored/published row carries the fixed outcome.
  The #290 multiplayer test needs no change (text only).

`test/game-loop-finalize.test.js`: the `#192 S3` live-generation deferred-flush test takes the valid id
from the prompt. The seeded-note flush tests are unchanged (they validate stored notes, a recovery path).
`test/game-loop-learning-feedback.test.js` D9 still matches (`결정 사실 카드(엔진 계산`,
`d-1-<street>-<k>: 팟 …`, `가장 비싼(결정적인) 결정 1개`) and expects the same sanitized text.

## Remaining limitations

- Target choice is a committed-chips heuristic; it can pick a large call over a more instructive
  small decision. It is explained to the user only through the note text.
- The prose in `text`, `why` and `alternative` is not checked for outcome claims. Only the fixed
  outcome and the existing validators protect the published note; the prompt's instruction is not
  enforcement.
- Selection depends on the costs of the user's other decisions (their own choices, not results).
- The model-visible snapshot includes the user's chosen action; that is the decision judged.
  `publicSeats` carries seat ids and positions from the validated projection (no names/archetypes).
- Equity and range figures are the range worker's uncalibrated heuristics; the prompt says so.
- The guarded maker could not run real-loop identity tests; the parent-host
  results below supersede that worker limitation.

## Parent-host follow-through

The parent ran the real loop with working process identity: the final focused
range/coach/fact command passed 54/54, including all 17 prospective-coach tests.
The removed-outcome regression first failed on lost why/alternative and then
passed after preserving the row and letting the sidecar fill its fixed outcome.
Surviving model outcomes still receive the existing private-card checks.

A pinned-base behavioral RED exported b239dd7 to an owned scratch directory,
copied only this test file, and ran the named real-loop prompt-invariance test.
One test ran and failed with ERR_ASSERTION on old completed replay/private-card
input, not an import failure. The same named test passes on the new source.
The scratch directory was removed; the transcript hash is
`e489b37dd1d3fed47e5b9f98f96fa244aec94c82227e8ad83962d003660e6b47`.
