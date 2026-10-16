# Review dispositions

## Design/plan round 1

Routed MEDIUM independent review: claude-sonnet-5-5/high; receipt design-r1,
verdict PASS_WITH_CHANGES, confidence 0.8. Parent authored the initial documents;
reviewer used a fresh context and Read/Glob/Grep only. No implementation ran
during review.

- F1 accepted: inject a fixed outcome message in the sidecar before note
  validation/proof; remove instructions requiring retrospective input.
- F2 accepted: facts and allowed note IDs come only from validated prospective
  evidence. Select a single target to prevent later user snapshots leaking
  future boards into an earlier decision. All-invalid evidence stays unavailable.
- F3 accepted: separate coaching estimator and explicit bounded heuristic
  likelihoods, historical-board strength and weak support. No mixed unknown
  opponent presented as fully conditioned range equity.
- F4 accepted: adapter-local validated model configuration for real comparison;
  no argv interception/containment bypass and no production game setting needed.
- F5 accepted: cover resume low effort, actual catalog support, and preserve
  the intentionally model-default short learning-explanation exception. Update
  cross-file integration expectations as identified by tests.
- F6 partially accepted: measure real latency and record fallback limitations.
  The claim of a 25s loop hard limit is incorrect: shared/player-budget.js has
  soft 25s/hard 300s, and game-loop currentWatchdog uses it. The 25s adapter
  default is a distinct direct-call budget. Do not invent a statistical p95
  safety proof from a tiny smoke sample.
- F7 accepted: raw summary/source/hash validation, explicit assessment ID for
  retest, no unfinished-run replacement; targeted free practice rather than
  claiming a nonempty transfer queue. A protected next-step start must also check the server under its drill lock;
  normal deliberate replacement remains available through the ordinary Start button.
- F8 rejected in part: no supplied AGENTS.md instruction forbids tracked design
  documents; docs/implementation already contains tracked designs/plans. Keep
  these reviewable artifacts. Accepted the request to document retry limits.

The reviewed decisions and acceptance checks are incorporated in the design and
the worker task contracts before implementation begins.

## Integration checks before independent code review

- Initial range slice's pure checks passed. Its guarded worker could not run
  process-identity integration tests (`ps` denied); those are not accepted as
  passing and must run on the unrestricted parent host.
- The first coaching implementation added an unrequested outcome/card sentence
  filter. A parent reproduction showed that ordinary advice, "쇼다운 가치가 있어
  체크를 고려하세요.", was removed entirely. Reject that filter: prospective
  input isolation, a fixed sidecar outcome and existing publication validators
  are the intended controls. Route a corrective attempt with this concrete
  capability-failure evidence; the router selected the same Sonnet model at
  xhigh (one effort up), rather than silently repeating the first attempt.
- Host run of the initial prospective-coach tests: 11/12 passed. The remaining
  assertion incorrectly banned earlier preflop action IDs from the target's
  prior-actions context. Earlier actions are permitted; future decisions are
  not. Correct the assertion to inspect that boundary, retaining byte-equality
  and private/future-card negative controls.
- Range-equity scope: unacted opponents can be excluded from the explicitly
  labeled subset simulation only when ALL live opponents have conditioned
  evidence. Any missing/partial live opponent suppresses range equity, including
  unacted opponents. This is a conditional heuristic, never complete action EV.
- Comparison tool: a parent call of the real runner with an exhausted injected
  clock produced `ok:true` with zero compared spots and both probes skipped.
  Reject this acceptance gate. A second routed runtime attempt at xhigh adds
  distinct execution-health, measurement-completeness and decision-legality
  gates; partial or invalid comparisons must exit nonzero while retaining their
  diagnostic observations.
- Study retests may intentionally target a known historical reference version:
  the suggested card names that version, sends only its assessment ID, and the
  server derives the source from that assessment. Its results are compared only
  with its own baseline, never mixed into the active version's score.

## Independent code review scope

Core round 1 runs on an immutable local snapshot of 19 changed source/test/CI
files, with the initial design and plan as contracts. Routed HIGH with
`security_sensitive`: claude-opus-5-5/high and gpt-6-astra/high in separate fresh
processes. Neither receives the other's output. The comparison runner and its
tests are excluded from that snapshot while their correction finishes; they
receive a separate final risk-proportionate review. Snapshot file hashes must
still match the delivered core, or changed files need renewed review.

## Independent code review round 1 dispositions

Core: Opus/high PASS_WITH_CHANGES (0.72), Astra/high FAIL (0.93). Both
independently found the all-live-opponent evidence admission gap. Comparison:
Terra/high PASS_WITH_CHANGES (0.94). Findings are assessed individually; none
of these first-round verdicts constitutes final acceptance.

- Both core reviewers' missing unacted-opponent evidence finding accepted.
  Suppress range equity unless every live opponent is conditioned, and reverse
  the incorrect multiway test expectation.
- Astra's malformed action-evidence finding accepted: validate the fields and
  dependent public preflop context consumed by both estimators. Missing raise
  price cannot silently become a bet.
- Both reviewers' stale-tab unfinished-run gap accepted. A client refresh
  alone is insufficient for an atomic guarantee; carry a protected-start
  condition to the backend's existing drill lock. Preserve explicit Start
  replacement and idempotent retries.
- Opus's outcome-sanitizer finding accepted. A real-loop regression first
  failed because valid why/alternative disappeared when an unsupported outcome
  was removed. Remove the empty outcome field before the fixed contract fills
  it, and retain nonempty model outcomes for existing private-card checks.
  This targeted RED then GREEN is recorded outside the repository.
- Opus's malformed assessment timestamp finding accepted; an invalid date
  cannot replace the latest valid eligible baseline.
- Opus's Windows shard headroom concern accepted. Place the real-loop
  prospective test in learning-b (baseline 9.7 minutes), rather than the crowded
  rest shard. Preserve all shard coverage and timeout limits.
- Terra's probe/phase argv and synchronous-disposal findings accepted. Require
  actual child observations per intended phase and validate probe model/effort.
  Attempt every disposal even if another throws synchronously; retain failure
  diagnostics and temporary evidence on unconfirmed cleanup.

Routed corrective attempts use the fresh findings as hashed retry evidence.
Range/study seats advance Sonnet high to xhigh; comparison advances beyond its
already-used Sonnet xhigh retry to the router-selected Fable/high. Parent fixes
the narrow sanitizer and shard assignments inline. Relevant tests and a fresh
frozen-snapshot review remain required after all corrective edits.

The range maker also identified a pre-existing malformed raw-decision exception
in `decisionFacts`: one missing hole-card array could suppress the valid fact
lines for its whole hand in the evaluator path. Parent added a per-decision
fail-closed wrapper and a mixed good/bad regression (behavioral RED, then GREEN),
so unavailable evidence cannot erase valid neighboring facts.

## Independent code review round 2 scope

All final source is frozen in one new snapshot: 23 core source/test/CI files,
including the drill backend condition and CI shard assignment, plus the two
comparison tool/test files. Parent source fixes are included in author exclusions
with Sonnet and Fable. The router again selects Opus/high + Astra/high for core
and Terra/high for comparison. Each fresh process reads the source independently,
with no peer output. Final manifests bind the delivered files to this review.

## Round 2 dispositions and final correction

Astra returned PASS_WITH_CHANGES (0.91): accepted the historical-all-in gap.
A current all-in flag cannot excuse missing earlier streets. Only a public
historical full-stack raise/call proves that no later action was required;
a turn shove with missing flop evidence stays partial. A negative regression
and a proven earlier-shove positive control pass.

Opus's output was INVALID_OUTPUT (`schema_invalid`, termination confirmed):
it wrapped the required verdict in a Markdown code fence. It is not counted
as a passing review. Its actual findings were still read and reproduced:
invalid-evidence decisions in an otherwise eligible hand reached evaluator
facts, and malformed raw snapshots could break machine detectors. Parent added
real evaluator-prompt capture and machine-fallback regressions (both RED), then
built evaluator facts and machine detectors from the same validated available
projection used for process evaluation (both GREEN). Observed chip losses may
still be reported, but no invalid decision facts support a verdict.

Terra returned FAIL (0.92) on two observation gaps: synchronous executor
failure was logged as a child, and duplicate model flags could be ignored.
Accepted and reproduced. Log only after a successful executor return with a
positive PID; reject duplicate model/effort occurrences across short/long/config
forms, retaining all values in mismatch diagnostics. Tests cover probe, warmup
and decide in both model-flag orders, missing PID and synchronous failure.
These narrow parent fixes use the router skill's explicit inline-executor path.

The first full integrated run finished with 3,778 pass, 3 fail, 1 cancelled,
18 skipped. Two occupied-8899 failures passed with `HOLDEM_PUBLIC_PORT=0`.
The study-rotation failure was a test race: its 40ms auto-fold advanced the
engine to hand 2 while it verified the rotated service. Preserve the hand-1
assertion, hold that user decision open with the existing scaled 30s fixture
budget, and retain requestStop cleanup. The new source-suffix inference also
needed its explicit entry in the existing v3 call-site inventory; no old
inventory checks were removed. The final whole suite runs with isolated ports.

Last review round (3 of 3) uses a new immutable snapshot, all source-author
exclusions, fresh Opus/Astra core seats and Terra comparison seat. Opus's
invalid-format receipt and an explicit plain-text formatting correction are
recorded as recovered operational history. No peer verdicts are shared.

## Initial review closure and concurrent upstream integration

Core round 3: Astra PASS (0.88), Opus PASS_WITH_CHANGES (0.72), both valid
supervisor receipts. Opus found no merge-blocking acceptance issue and one low
loss-label defect: if the actual last user decision was invalid, the machine
review attached the previous valid decision's facts to the whole-hand loss.
Parent reproduced the reversed good/bad order, then uses the actual last
projected decision only when available and a neutral unavailable-evidence
message otherwise. The new regression keeps observed chip-loss totals intact.
Comparison round 3: Terra PASS (0.92), no material missing tests.

During this closure, PR #294 merged independently into main (edb0b57). Preserve
the local work in stash 45402ef6b68ce9b23c744042ff229f9a323d8005 and a binary
diff, fast-forward this task branch, then reapply. Resolve only the actual
README and study mount conflicts by retaining both replay-library entry
health/auth behavior and the next-step auth failure painting. The automatic
HTML/CSS/server/workflow merges are inspected too. No other worktree is edited.
The superseded in-flight test group was identified by exact Node test argv,
worktree cwd and process group; only that owned group was stopped, all six
processes confirmed gone. Its partial result is not a passing whole suite.

This new upstream integration has a separate scoped review lineage and fresh
Opus/Astra seats. It reviews the eight changed core files relative to the
last frozen core, plus docs/conflict composition. Unchanged core and comparison
files remain bound to the completed round-3 manifests. A new complete suite
and study/replay rendered journeys validate the combined product.

## Upstream integration review closure

Both independent integration reviewers passed: Opus/high PASS (0.82) and
Astra/high PASS (0.91), valid schema and confirmed termination. Each compared
all 11 delta files against the preserved pre-integration snapshot. Replay
health/auth entry and protected next-step behavior remain intact together.
The actual-last-decision loss label is correct and raw loss totals remain.
The optional incorrect-token replay retry wording and additional combined-page
rendered permutations are non-blocking follow-ups in the upstream replay entry;
they do not permit actions or replace a session. No production source changes
follow this review.

Host integrated checks: focused 85/85; next-step browser 15/15; replay library
browser 22/22; full learning browser 19/19. All rendered journeys confirmed
owned cleanup. Browser protected-store observation uses an owned empty store,
not the user's independently changing game. Final complete local suite and
exact PR SHA CI remain the outstanding release gates.

## Final integration wording correction

The complete integrated local run finished with 3,938 pass, two failures and
18 platform skips (zero cancellations). Both failures were the same generic
`쇼다운` word in the new simulation caveat conflicting with strict own-replay
result-vocabulary assertions. Parent reproduced both, kept every privacy test
unchanged, and reviewed a frozen one-line equivalent wording before applying it.
The low-risk text change routes to Opus/medium model review because the LOW
lint check is unavailable; its valid receipt is PASS (0.9), no blocker. This is
the second and last scoped integration round. Numeric and projection logic do
not change. Final affected fact/coach/replay suites: 88/88; final rendered
replay22/22 and learning19/19; original next-step15/15 remains unchanged.
The historical whole run remains non-green in evidence. Exact-final-SHA full
CI is still required in the PR before merge; a partial local rerun is never
reported as a completed whole-suite pass.
