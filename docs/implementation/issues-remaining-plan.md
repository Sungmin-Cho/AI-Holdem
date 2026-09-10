# Remaining issue initial implementation plan

Date: 2026-09-11. Design: [issues-remaining-design.md](../design/issues-remaining-design.md). Baseline: `6175a64da4f183389aa1aed6781f174635da5d26`. This plan follows the initial design; steps below are pending unless separately accompanied by implementation evidence. Work order is #173 → #168 → #181 → #174 → #175 → #179. Keep each issue reviewable and preserve unrelated worktree changes.

## Delivery and evidence rules

Implement each contract with targeted tests, then run the repository's required full checks on the final candidate. Independent reviewers evaluate producer → persistence → consumer → runtime paths and closure evidence. Record actual author/reviewer model and effort from runtime/dispatch evidence; a requested alias or this document is not verification. A requested unavailable seat is a blocker to that seat, not authorization for an unannounced fallback.

Every issue's evidence includes final source SHA, changed paths, commands/results, coverage and remaining limitations. Use real engine fixtures for action/state assertions, real service processes for lifecycle checks, and injected runtime fixtures only where determinism is necessary. Do not claim paid LLM quality or real Windows performance from unit tests. Keep issue close/merge decisions tied to all applicable acceptance criteria; branch CI success alone does not satisfy real lifecycle or latency evidence.

## 1. #173 — Termination

1. In `tools/player-runtime.js`, trace the default executor's `error`, `exit`, `close`, and `done` events. Add explicit optional close evidence to its handle contract; maintain compatibility with fulfilled-done fake executors. Keep command failure separate from close confirmation, and track purpose/model/pid/start time in entries.
2. Amend `killAndConfirmClose` to handle close-before-call and close-during-signal races, using positive close evidence. Add structured error details at signal and wait failures, including actual elapsed and configured wait. Keep signal/close failure fatal and prohibit new work after disposal.
3. In `tools/game-loop.js:persistCleanupFailure`, project safe diagnostic fields into `loop-state.json` and append `cleanup-failed` to `loop.log`; log even when state is absent/unwritable. Preserve the original failure if logging fails. Multiple failed children can have a bounded detail array while keeping a stable top-level code.
4. Extend `test/player-runtime.test.js`, `test/game-loop.test.js`, and relevant `test/session-controls.test.js` paths. Cover concurrent timeout/dispose, independently closed failed command, false signal with real close, unresolved close despite PID absence, retained ownership, repeated stop, and managed End.

Validate with focused runtime/cleanup name patterns, then full affected files. A real local fixture child should exit normally and through SIGTERM with no orphan; this does not recreate the historical Codex race, so state the limitation. Do not terminate unrelated app/player processes.

## 2. #168 — Sweep

1. Refactor `tools/profile-cli.js:sweepStore` so observed nonterminal sessions append a structured skip record and continue before any migration/takeover. Return one readable summary string for the skip count while retaining `notices` API compatibility. Include gameId/phase in actual error detail records too; handle state-read failure distinctly.
2. In game-loop bootstrap collect sweep diagnostics, create/open the new log, then write detail events. Avoid relying on `onNotice` logging before `openLog()`. Verify notices merge does not reuse old state and grow across boot.
3. Add profile CLI and game-loop fixtures containing `playing`, `review_generated`, `aborted`, terminal, malformed, and consumer-failing sessions. Snapshot authority/pending bytes before/after skips. Repeat sweep/boot and terminal transition to show one UI summary, exact details, and one-time terminal consumption.

Required evidence: counts and final notice arrays for each boot, unchanged skipped authority, identifiable actual error, and the consumed terminal session absent from skip detail. Historical abandoned-session cleanup is not part of this issue implementation.

## 3. #181 — Decision preservation and recovery

### 3A. Shared budget and persistence

1. Add a browser-safe player-budget contract module (for example `shared/player-budget.js`) with schema/version, default, integer/range/cross-field validation and a documented legacy default resolver. Add settings to `shared/game-setup.js`, `server/public/lobby.html`, `server/public/lobby.js`, `tools/app-service.js` CLI prefill parsing, game-loop CLI parser/preparation, and `.app-setup.json` round trips.
2. Persist resolved budget in canonical session/loop configuration before first invocation. Resume uses persisted value; unknown versions/malformed settings refuse. New budget properties must not reach engine init as unsupported flags accidentally. Engine configuration stores only fields it owns, with an explicit source of truth for player runtime settings.
3. Replace production T1/T2 resolution with the single hard deadline. Add soft notification without cancellation in runtime/game loop; clear timers on every completion/stop path. Keep restored warmup + redecision under remaining deadline. Tests may retain an explicit legacy adapter, but production must not select old force-default semantics by missing config.

### 3B. Pending decision state machine

1. Implement a small module for pending-decision validation/transitions, then wire it into `decideWithWatchdog`. Persist pending identity/generation before invoking the adapter. Store redacted attempt diagnostics and closure state. On nonfatal exhaustion return `{kind:'recovery_required', ...}` with no call to `applyDecision(null)`.
2. In `run` branch on that result before touching `decision.envelope`, atomic transition, or normal applied-action metrics. Publish a view-only envelope with recovery status and park; the engine state must be untouched. Differentiate pending/wait metrics from applied-decision metrics.
3. Add explicit `retryDecision` on the loop. Under control serialization re-read the current engine decision, epoch, actor and stateVersion, reconcile any already-applied matching action, increment generation, and only then restart. Hold no synchronous ownership transaction across the model await. Validate generation again before engine step, followed by `--expect-version`.
4. On restart, `running` becomes interrupted recovery; never call a model automatically merely by opening the app. Crash-after-apply reconciliation must inspect exact archived/current engine evidence. Unknown/mismatch remains visible and non-applying.

### 3C. Managed and legacy recovery

1. Extend `shared/session-control-contract.js`, `tools/session-control.js`, and `tools/session-manager.js` with a revisioned recovery command/projection, reusing durable app command requestId semantics. Decide explicitly whether recovery is `paused` plus validated reason metadata or a new allowed state, and update every state allowlist/reader consistently. The design permits either representation, not silent mixed schemas.
2. Expose soft wait/recovery cause and Retry/End in `server/public/lobby.js` and relevant game status projection/UI. Normal Resume preserves recovery; End uses existing end/abort lifecycle. Validate retry decision identity in server-side manager, not only disabled buttons.
3. Add legacy `--retry-decision <decisionId>` with explicit resume semantics and a documented end procedure. CLI omission only inspects/restores the unresolved state. Budget changes apply on the next explicit retry unless live extension is implemented and timer-tested. Update `.agents/skills/start-game/SKILL.md` legacy recovery documentation only; do not initiate a user game during verification.

### 3D. Tests and actual runtime evidence

Use `test/player-runtime.test.js`, `test/game-loop.test.js`, `test/session-controls.test.js`, `test/session-control-contract.test.js`, `test/lobby-command-client.test.js`, and `test/browser/lobby-session-journey.mjs` as the main suites. Add adversarial fixtures for all failure classes and restart boundaries rather than mirroring the transition helper in isolation.

Acceptance matrix:

| Trigger | Durable/UI result | Engine assertion |
| --- | --- | --- |
| Valid result after soft threshold | accepted once | one action only |
| Hard timeout with confirmed close | recovery required | chips/bets/turn/history unchanged |
| Transport/format/illegal exhaustion | classified recovery | no default/policy action |
| Close uncertainty | safety failure, retry disabled | no new invocation or action |
| Normal pause then resume | pending decision retained | no implicit retry |
| Duplicate Retry or late response | one generation accepted | at most one action |
| Engine version/decision changed | stale recovery/reconcile | no stale action |
| Crash before apply / after apply | pending / exact reconciliation | zero / one action respectively |
| Restored-session repair budget spent | recovery required | no force-default |

Use accelerated fake timers for broad coverage, plus one real wall-clock delayed fixture above 25 seconds (for example 26 seconds, 25-second soft threshold, 35-second hard deadline) to verify actual child timer and non-overlap. This is runtime transport evidence, not a real model completion distribution. A small real tool-free CLI smoke may record the requested/resolved model, supported effort, elapsed, result and closure if a supported runtime is available; report absence honestly. Do not downgrade model/effort to manufacture a pass. Existing containment probes remain mandatory for actual CLI invocation. No measured default-budget sufficiency claim before collecting real completion/censoring samples.

## 4. #174 — Structured policy behavior

1. Extend `training/policies/strategy-v2.js` with pure context/line and hand-role helpers, ideally separate modules to make public-input boundaries testable. Read actor holes and public snapshot only. Validate unknown position/history and suppress unsupported bluffs. Build explicit position-by-context modifiers and named line conditions.
2. Add shared-support sizing choices to `training/policies/sizing.js` without changing engine raise-to semantics. Preserve facing-raise formulas and legal clamping; merge duplicated sizes before normalizing. Apply persona-adjusted value/semi-bluff/pure-bluff weights and a documented context cap. Keep policy output reason codes bounded and descriptive.
3. Update `training/policies/contracts.js` version/predecessor declarations and `catalog.js` digest/roll-forward. Check `strategy-mirror.js` and derived exploiter configuration explicitly. Preserve historical event provenance and existing mismatch failures.
4. Extend `tools/benchmark-policies.js` with real engine-produced positions, unopened/open/3bet scenarios, multiple public street lines, value/draw/air hands, common size support, multiway exclusions and illegal-action counts. Retain existing baseline scenarios. Publish theoretical weights and independent seeded samples separately.
5. Extend `test/policy-v2.test.js`, `test/policy-sizing.test.js`, `test/policy-distribution.test.js`, `test/policy-layer-boundary.test.js`, `test/derived-policy.test.js`, `test/policy-mirror.test.js`, and `test/policy-loop.test.js` only as affected. Include hidden-card/future-outcome invariance and deterministic retry fixtures.

Run `node tools/benchmark-policies.js --assert --json` before/after on the same seeded scenarios. Acceptance must specify fixed tolerances/sample counts before observing candidate results (e.g. 10,000 samples per selected cheap distribution, 0.02 absolute probability tolerance; compute expensive distributions once per spot). Record supports/exclusions and CPU wall cost. Calibrate heuristic changes by intended behavior, without tuning thresholds after seeing failures just to obtain green. Report measured distribution improvement, not GTO or profitability.

## 5. #175 — Favorable deal and downstream exclusion

### 5A. Engine and interface

1. Add shared `deal-selection` contract with `off|light|strong`, algorithm version and strict parser. Add setup/CLI flags to every same route used in 3A, engine `createGame` validation and `engineInitFlags`. Preserve off as default for genuinely historical sessions, explicit immutability/resume mismatch, and app restart persistence.
2. Add weighted unordered-combination sampler to a focused engine module, using the existing card/RNG utilities. Non-off selects user holes then shuffles remaining cards uniformly. Insert them at user positions in the existing two-round deal order. Off calls the original shuffle unchanged. Define explicit supplied-deck/non-off refusal in engine CLI and tests.
3. Stamp `dealSelection`/contract marker into active hand, hand-start public metadata where appropriate, archived record and user decision snapshots. Add current mode to viewer/session config. No opponent private-card disclosure in metadata. Keep the entire conditional distribution marked even when the selected hand is weak.

### 5B. Canonical proof and every consumer

1. Extend `training/contracts.js` snapshot validation and `training/decision-evaluator.js` projection. Implement canonical marker verification beside `tools/assistance-proof.js`, called at `tools/training-control.js` ingestion/consumption using engine session and hand evidence. Missing/corrupt new provenance refuses ingestion; do not let downgraded envelope schema bypass canonical checks.
2. Extend training item/events schema deliberately, including serializers in `tools/training-pipeline.js`/training stores. Keep old records readable. New event validators require selection metadata; equality/digest/idempotence must cover it. Do not indiscriminately rewrite old events or change v2 reference authority.
3. Update both `independentAssessmentEligibility` and `assistanceAllowsIndependent` in `shared/assistance.js` to compose reference, hint and deal eligibility. Trace actual consumers: `training/profile-aggregator.js` (scores/mix/leaks), `training/mistake-bank.js`, `training/spaced-repetition.js`, `training/mastery.js`, drill/retest generation and goal/practice-focus materialization. Direct consumers bypassing the helper need explicit coverage; do not presume helper imports alone prove exclusion.
4. Update hand-level disposition and `training/tendency/extract.js` so all biased user hands are excluded before `t.hands = 1`, even if decisions/actions are empty. Add explicit biased/unknown-selection exclusion counters to tendency contracts/readers where needed. Mirror/exploit minimum remains 60 independent hands.

### 5C. Verification

Build one integration fixture that flows a biased hand through actual engine archive → evaluator → authority/training consumer → profile/mistake/retest/mastery/goals/tendency, asserting no independent contribution at each persisted output and visible factual practice. Include marker stripped at snapshot, evaluation, event, record, and downgraded-schema layers; immutable config should reveal inconsistency. Repeat consumer execution and resume to prove idempotence and no later promotion.

Test off exact seeded equivalence, all seat counts, duplicate-card impossibility, deterministic finite RNG use, weighted combination totals, and conditional remaining-card uniformity with fixed seed/sample/tolerance. Assert light and strong selectable-hand rates match `(w*K)/(w*K + 1326-K)` for the frozen predicate size K; this verifies the intended algorithm without inventing strength/GTO claims. Validate 59 independent + biased ≥60 total does not unlock a self model, and the 60th independent hand does.

## 6. #179 — Benchmark first, measured optimization second

### 6A. Standalone real lifecycle harness

1. Add `tools/benchmark-windows-lifecycle.mjs` (name can be adjusted) that accepts an absolute implementation root, isolated workspace, revision label and output directory. Dynamically import that implementation's production study APIs. Use only private temporary fixture stores and bounded exported APIs; no mocks, live user games or user training data.
2. The harness records operation start/end wall times, outcome/error/deadline, implementation SHA, PID, and proof counts. Correlate diagnostic records with operation and client/server side; avoid logging descriptor/token/path contents. Keep existing `proof-profile-report.mjs` suite summaries intact and explicitly separate them from request measurements.
3. Each full run executes cold ensure → verified warm ensure reuse → inspect → bad-token denial → valid health and one actual study data request → stop → stopped inspect/lock cleanup/owned-process absence. Use an appropriate fixture training store for the actual supported data endpoint discovered in `tools/drill-server.js`. Always stop owned processes in `finally`; check recorded PID/start time before cleanup signaling.
4. Capture environment versions without secrets and raw samples. Report cold-store vs warm separately, and mark the OS/process preparation state. Errors and timeouts remain distinct censored/failure samples, not omitted timing rows.

### 6B. Same-runner A/B CI

Add a dedicated Windows Node 20/22 job or workflow with baseline SHA input pinned in evidence. Check out baseline and candidate to separate paths without swapping a running checkout. Use one unchanged harness from candidate to invoke each implementation, ensuring the harness adapts only to shared public API and fails unsupported operations explicitly. Prepare both identically; execute A/B then B/A paired blocks with disjoint stores. Collect ≥10 paired warm samples plus ≥3 fresh-store lifecycle samples per revision. Do not install credentials or invoke an LLM.

Upload redacted operation/proof JSON and summary artifacts with exact SHAs, image/OS/Node/PowerShell, run ID, ordering and repetitions. Add real lifecycle success as an explicit required result; the existing Windows unit shards alone are not that evidence. The ordinary full Node 20/22 Linux and Windows matrix remains required and must not be narrowed for performance tests.

### 6C. Optimization and security gate

1. Inspect real per-operation counts for repeated calls within the same synchronous proof boundary. Build a before/after producer/read/write/await map for the chosen operation and state exactly which repeated proof is removed and why its original evidence remains valid.
2. Prefer combining adjacent read-only transactions or eliminating duplicate same-transaction identity/parsing. Keep before/after ACL checks, owner/reparse, inode/bytes and after-HTTP proof. Never expand memo life across await/request/write or use TTL. Do not increase deadlines to make the optimization appear faster.
3. Expand `test/study-proof-transactions.test.js`, `test/study-service.test.js`, `test/study-service-recovery.test.js`, `test/windows-runtime-contract.test.js`, and platform security tests with mutable ACL owner, public DACL, reparse replacement, between-proof path replacement and exhausted budget. Use real Windows mutation cases where supported; label fixture-only evidence separately.
4. Repeat the same A/B benchmark after the candidate. Require an observed proof-count decrease or reproducible latency benefit in the intended operation with no new refusals/timeouts/security regression. Report median/p95 with raw n and order effects; cumulative proof milliseconds remain a different metric. If improvement is absent or trust weakened, omit the optimization and retain/report measurement results. Resident PowerShell/native implementation needs a new reviewable design and is not an automatic fallback.

## Final handoff checklist

- Final implementation matches the relevant design or documents an evidence-backed amendment.
- New settings reach managed and legacy runtime paths and survive restart/resume.
- Uncertain close/recovery/provenance/deadline states remain fail-closed.
- No historical training/review/policy evidence was silently rewritten.
- Focused tests and final required CI results point to the reviewed SHA.
- Real delayed child, managed recovery journey, end-to-end biased sample exclusion, policy benchmark, and paired Windows lifecycle evidence are present where required; unavailable evidence remains explicitly incomplete.
- Independent review and merge are handled by the coordinator after implementation; these initial documents do not assert approval or completion.
