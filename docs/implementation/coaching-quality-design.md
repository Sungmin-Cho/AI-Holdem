# Player and coaching quality

## Goal and boundaries

Improve the Codex LLM opponent and make coaching useful without giving heuristic
estimates the authority of solved poker. Deliver in the existing butterfish
worktree, independently review, validate, merge a PR, and ingest the result into
Deep Wiki. Production game/study stores and running services are read-only.

The audit baseline is main b239dd7. Existing policy/reference versions and saved
observations must remain reproducible. No solver, retrospective regrading,
manufactured learner improvement, or live-session migration is included.

## Decisions

1. Codex LLM players select the Sol family, with gpt-6.1-sol as fallback and
   explicit low effort across probe/create/resume/player oneshots. Upper-tier
   coaching remains Sol/medium. This is an operational default, not a claim of
   poker superiority. Provide an opt-in, bounded, isolated comparison runner for
   Luna/default and Sol/low using identical public spots and actual runtime
   containment, reporting legality, failures, latency and strategy caveats. Use
   validated adapter-local model/effort configuration for the comparison, never
   rewrite models in argv or bypass containment. The loop's normal decision
   budget is soft 25s / hard 300s; the adapter's direct default is 25s. Report
   small-sample latency honestly, including slow responses and failures.
2. Coaching uses an explicit public-action range estimate separate from the
   recorded policy-v3 estimator. Incorporate only actions/boards visible before
   the decision. Keep nonzero weak-hand support, use deterministic bounded
   reweighting, and identify this as an uncalibrated heuristic. Missing or
   malformed evidence yields no conditioned estimate, not a confident random
   substitute. Omit range equity when any live opponent lacks range evidence.
   Never inspect actual opponent hole cards/personas/future boards.
   Price arithmetic and simulation estimates are distinct; raw showdown equity
   cannot establish call EV before the action closes or with future betting.
3. Hand coaching selects one valid user decision by a deterministic,
   result-independent committed-cost/price rule. It receives only that target's
   validated decision-time snapshot, facts and result-independent practice focus.
   Other user snapshots may contain later boards, so they are also excluded.
   It never receives
   the completed board, opponent cards, final actions/stacks or hand outcome.
   Retain the published coach-note contract and recovery/proof pipeline. Outcome
   text is a fixed sidecar-injected message before validation/seal/proof, not a
   model prediction. Only the selected target ID is accepted. Drop instructions
   requiring opponent reasons or unprojected intent notes. Use a single LLM call.
   Legacy snapshots lacking legal evidence remain honestly unavailable.
4. Study home offers an explicit next action using existing verified summary
   data and supported modes: due review, an eligible delayed retest of the same
   source, targeted practice/transfer, or a fresh assessment. The user starts it;
   no automatic answer, assessment or mutation on page load. Completion suggests
   a later retest and a variation. Preserve busy/recovery gates and chart-exposure
   exclusions. Explain sparse exact coverage and offer fixed 100BB cash training
   as a way to obtain more comparable preflop examples, never as a guarantee.
   Derive actions from raw summary counts, not formatted strings. Daily/new
   assessment starts bind summary.source including its hash; retests send only
   assessmentId and use server-derived source. Targeted practice requires a
   source-matched observed goal. Do not advertise transfer as known available
   without evidence. Block next-step replacement of every unfinished run.
5. Preserve policy v3's behavior and stored identity. Surface its river-raise
   value-only limitation in relevant mode/help text so users do not generalize
   it to real opponents. Explain that LLM bluffs/personas are not calibrated.
   A new versioned bluff-raise strategy needs its own behavioral evaluation.

## Heuristic estimation contract

The coaching-only module owns documented fixed likelihood constants. Order hand
classes by average compatible-combo strength on each action's historical board;
retain a positive weak-hand likelihood and avoid treating checks as proof of
weakness. Normalize bounded weights deterministically and report partial/unknown
evidence. These coefficients are engineering assumptions, not calibrated poker
probabilities. Decision facts feed hand coaching, final evaluation and machine
review consistently. Existing policy estimators and dataset bytes stay fixed.

## Acceptance

- Runtime tests prove explicit low for all player paths and medium for upper;
  catalog selection cannot silently revert the player to Luna.
- Range tests distinguish pressure from check-through on the same board, retain
  weak support, reject bad/future evidence and remain invariant to hidden cards.
  Recorded policy v3 distributions and reference dataset bytes are unchanged.
- Captured hand-coach prompts are byte-identical when only outcome, showdown,
  future board/actions, final stacks or opponent identity changes. Invalid
  decision-time evidence cannot become a strategy verdict.
- Study next actions are source/eligibility checked, start the intended mode and
  cannot mutate an active/recovering assessment. No unsupported spot is graded.
- Relevant tests and full CI pass on the final PR SHA. Real provider calls are
  reported separately from fixtures. No win-rate/GTO/learning-effect claim.

## Review and delivery

Use model-router for implementation seats and independent design/plan and code
review. Freeze the tree during each review. Record dispositions and actual test
evidence. A single PR and durable documents/receipts suffice; deep-loop is not
needed for this bounded delivery. PR creation, push, merge and post-merge Wiki
publication are authorized by the user in this session. At most three initial core code
review rounds and four implementation attempts per routed executor lineage;
escalate with observed evidence rather than silently retrying.

## Concurrent main integration (2026-10-16)

PR #294 merged to main at 06:19:26Z while the original code reviews were
finishing. Its replay study library overlaps study HTML/CSS/JS and the drill
server. Integrate edb0b57 without discarding either feature; preserve replay
entry health/auth behavior and next-step unauthenticated/unfinished-run gates.
The initial three-round core review is closed; this new upstream composition
gets a separate scoped integration review (at most two rounds) and a new
complete suite. Earlier frozen snapshots cannot certify the integrated files.
