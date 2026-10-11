# Issues #273 and #274: publish and session recovery

## Design

The relay owns publish acceptance; the loop owns child and HTTP cleanup; the app
owns command receipts. A failed annotation publish must not be confused with a
transport failure, and a retained failed loop must not turn resume into a
successful no-op. Keep these authorities and all existing proof, epoch, lock,
selector, and private-information checks intact.

1. Preserve a bounded, allowlisted HTTP status and rejection code through the
   publisher CLI and loop diagnostics. Never copy response text, URLs, tokens,
   annotation values, or private cards into diagnostics. Preserve the original
   run failure alongside subsequent cleanup failure.
2. Treat a live relay's semantic or permission rejection as a rejection, rather
   than restarting the server as if transport had failed. Reproduce rejection
   with an independent fixture or an isolated copy of the incident session.
3. Resolve rejected explanatory publication only with evidence bound to the
   exact pending body and server/epoch authority. Preserve an audit record and
   training queue disposition; never blindly remove a pending attempt, relax
   security gates, resend a different body with the same ID, or repeat an
   already applied engine action. If safe resolution cannot be proven, fail
   explicitly and retain ownership and the pending attempt.
4. Share an in-flight child-close observation across concurrent callers, but
   allow another bounded observation after a failed observation settles.
   PID absence is not close evidence. Unconfirmed child or JEV HTTP termination
   continues to retain ownership and prevent replacement work.
5. Resume a retained failed session by retrying its cleanup first. Only after
   confirmed cleanup may the app launch recovery and resume play. Check the
   resulting state before writing a succeeded command receipt; expose a
   concrete failure when recovery cannot complete.

## Implementation sequence

1. Publisher diagnostics and rejection reproduction tests.
2. Safe rejected-annotation handling, ordered publication and replay regression
   tests, including restart recovery.
3. Child-close retry and app retained-session resume, with positive and
   fail-closed tests and UI error presentation.
4. Focused tests, independent model-router HIGH reviews, corrections for
   substantive findings, full repository tests and relevant browser journey.
5. PR with both issue closing references; merge after required checks; record
   the result and any limitations in the wiki.

## Routing and evidence

Classification: IMPLEMENTATION, complexity 2, uncertainty 2, blast radius 1,
reversibility 1; security, data integrity, and concurrency flags. Risk HIGH
(9/18), execution NORMAL (10/18). Initial implementation: claude-sonnet-5-5,
HIGH; review: claude-opus-5-5 and gpt-6.1-sol, HIGH, separate fresh processes.
All three model IDs passed live minimal invocation probes. Re-route reviews
with the actual artifact authors declared, and re-score if scope expands.

The incident session is not present in the current worktree or main checkout's
current session store at initial inspection. Independent fixtures are permitted
by the issues; distinguish reproduced causes from unconfirmed historical cause.
Do not modify or replay requests into the user's running app or original store.

## Recovery boundary adjustments after final static review

The final review and a new host probe exposed an additional launching-loop boundary.
The user approved up to two additional implementation attempts and two review rounds;
the judge budget remains one invocation. Design the following changes before coding:

1. Preserve private exact-body/authority and verified relay-binding evidence before
   removing a retired attempt. Public diagnostics and the bounded digest audit remain
   value-free. Reuse protected, bounded file primitives; never follow link targets.
2. Reconcile durable retirement evidence before rebuilding/flushing an annotation
   queue, even when the attempt is absent. Make singleton disposition and batch
   isolation idempotent across interruption and changing private-literal context.
3. A retained launching loop is owned work too. Explicit resume must retry its
   cleanup, preserving it on every unconfirmed result, before acquiring replacement
   ownership. Shutdown races still prevent a new launch. Preserve original failure
   context through command failure reporting.
4. Close the public snapshot/receipt code boundary, retaining every repository-defined
   code that callers rely on and projecting unknown child/adapter text to UNLISTED.
   Test complete host-facing objects, rather than only the new detail sub-object.
5. Cover the combined rejection → applied-action publication failure → unconfirmed
   cleanup → explicit app resume path with independent temporary fixtures.

This is a coupled recovery-state design adjustment, routed as ARCHITECTURE HIGH.
The new host probe supplies fresh evidence for the router's one permitted same-model,
higher-effort retry: Opus VERY_HIGH (native xhigh). Root owns runtime verification;
protected worker completion is not evidence that runtime tests passed.

## Final durability and concurrency repair

The expanded host run and independent review found two substantive boundaries:
retirement evidence can be consumed before the authority directory rename is
durable, and concurrent reconciliation can block the event loop while waiting for
the same filesystem mutex. The user approved one more implementation and two
reviews. Route Fable HIGH for these corrections, with independent Sol/Astra
reviews excluding all source authors. The route raises review to CRITICAL because
of evidenced retries; the available slate has no separate adjudicator.

Sync the training directory after the authority write and before consuming
retirement evidence, including unchanged-authority replay. Preserve evidence on
sync failure. Serialize same-session reconciliation asynchronously across control
instances before entering the existing filesystem mutex; keep all cross-process
ownership checks. Test durability ordering and concurrent calls with real fixtures.

Correct the two newly added fixtures without weakening production gates: explicitly
select the new-game replay visibility before testing changing private literals,
and register real user-decision/practice provenance before testing the combined
refusal/action/cleanup/resume path. Isolate the unrelated G6 strategy failure on
the untouched base commit rather than changing policy code to obtain a green run.

## Residual lifetime-contract repair after independent review

Both final reviewers rejected the current artifact. Root reproduced mixed ordinary
training/retirement locking and legacy command-replay projection failures. The user
requested resumption after an explicit request for three additional implementation
attempts and three review rounds. Keep the full previous history and the global
attempt counts; do not claim that a failed writer receipt was successful.

The remaining repair concerns state that survives multiple processes and sessions:

1. Admit every operation on the training mutex through the same asynchronous
   per-session queue, including ordinary mutation, consumption and migration.
   Preserve filesystem mutex ownership and avoid recursive queue entry.
2. Keep the recorded attempt's bytes durable before depending on private retirement
   evidence. Sync any replacement's contents and directory entry, or preserve and
   sync the existing record with the same identity checks. Test the crash boundary.
3. Rebuild annotation envelopes after a pending attempt is settled and its authority
   changes; publish unrelated queued annotations within the same bounded flush.
4. Make the supported envelope budget compatible with bounded retirement evidence
   and audit storage. Test a large valid batch; preserve the exact eligible body.
5. Preserve the first sanitized HTTP refusal alongside later verification/retirement
   failures instead of replacing it, without retaining response text or values.
6. Project legacy receipts on every public return path, including idempotent command
   replay and nested diagnostic codes, without altering their persisted identity.

Route the focused lifetime-contract slice as ARCHITECTURE HIGH with long-horizon
state context. New independent findings and the root runtime proof support Fable's
one same-model effort increase, HIGH to VERY_HIGH (native xhigh). Record the broader
historical tier-exhaustion result separately. The global approved implementation cap
is nine and review cap ten; the judge cap remains one. Final artifact review still
excludes every source author and retains the previous CRITICAL checklist.

The final real-relay concurrency witness also covers retirement evidence written
while authority settlement waits behind an ordinary holder and a second producer
has already built a body from the unsettled queue. An explicit stale-body result
with the attempt absent rebuilds the remaining queue in the same bounded flush;
a still-recorded attempt remains a failure. The regression verifies no extra
retirement evidence, no relayed refused explanation and publication of the
unrelated explanation.

## Remaining concrete repair after review round 7

The R8 focused and complete serial suites passed, but fresh Astra and Sol reviews
identified six remaining contract defects. Their protected receipts are valid,
both workers terminated, and root independently reproduced the ordinary retry
binding failure: a caller captured A, A was retired, B was left pending by an
actual transport failure, the retry sent B successfully, but the caller marked A
published (A absent from the relay, B present and still queued).

The final bounded repair is concrete:

1. `readRetirementEvidence`: distinguish ENOENT from existing JSON scalar/null
   content; existing invalid evidence must fail closed before annotation POST.
2. Settlement eligibility and verification: enforce unique note identities and
   complete one-to-one authority coverage before evidence or attempt removal.
3. Exact-file durability and batch recovery: sync `training/annotations` as well
   as its parent before depending on its filenames. For existing interrupted
   journals, restore missing canonical files only from verified evidence whose
   recomputed value digest matches authority, sync before journal consumption,
   and retain evidence if restoration is unverifiable or unsafe. Preserve
   innocent batch values and avoid overwriting newer canonical digests.
4. Reconciliation ordering: establish recorded-attempt state before capturing
   refusal evidence so an accepted retry's withdrawn evidence cannot authorize
   retirement. Preserve publisher/training mutex ordering without blocking an
   in-process relay on a synchronously held cross-process publish mutex.
5. Ordinary unresolved retry: pass expected body digest and epoch, enforce that
   binding under the publisher lock, and check accepted result identity before
   marking the captured queue entries. A replacement B must remain unsent and
   untouched by a caller that captured A.
6. Lobby rendering: give `REJECTION_AUDIT_FAILED` an actionable recovery message
   and show the sanitized original refusal and cleanup detail in the combined
   failure and subsequent failed-resume states.

Add regression cases for each reachable trigger. Preserve proof, epoch, relay
binding, listener/owner identity, child/HTTP close confirmation, canonical values,
closed public-code projection, bounded recovery and single engine action.
The reviewer also noted a nonblocking loss of an already observed recheck tuple
at a later wrapper; preserve that earliest recheck within the existing two-tuple
bound if included in this repair, without adding an extra review gate.

On 2026-10-11 the user explicitly authorized continuation through completion and
further reviews at the orchestrator's judgment. This overrides the previous
model-ceiling stopping gate and authorizes a manual Fable MAX continuation.
The historical terminal route and failed reviews remain preserved; this is a
human-authorized exception, not an automatic capability escalation. The latest local
batch budget is 18 implementations and 18 review rounds (judge limit 1),
expanded under that explicit judgment delegation after further verified findings.
Mandatory receipt guards, ownership/proof checks and fresh CRITICAL independent
reviews remain required. Further concrete correctness work is authorized within
the user's requested PR, merge and wiki scope.


## Final publication and settlement contracts

Later protected reviews and real host regressions refine the same design:

1. A successful `ATTEMPT_PENDING` drain publishes a recorded body. The loop must
   then publish the current transition with its fresh arguments before recording
   its publication as successful; a pre-await file-existence check cannot decide
   which body a queued retry later sends. Do not repeat the engine step.
2. A successful fresh-refusal settlement can race another publisher's withdrawal
   of the attempt. Reconcile verified surviving evidence before rebuilding,
   including when the attempt is already absent at the helper's first read.
   Absence alone authorizes no disposition; invalid evidence stays intact.
3. Limit consecutive settlements without verified queue progress. Whole-batch
   isolation may spend one stalled settlement; actual retirement/publication
   removes a queued identity and resets the budget. A progressing batch must
   reach its innocent members, while an unchanged queue remains bounded.
4. Persist each invocation's first closed HTTP refusal before further recovery,
   including an automatic resend following an initial transport failure. Keep
   the actual recheck verdict for retirement proof, with no relay text or values
   in diagnostics. A successful recovery must not erase that earlier answer.
5. Evidence verification recomputes the annotation digest from field, status and
   value against its authority item whether canonical files are present or
   missing. Existing files cannot bypass value/proof consistency checks.

6. Shared contained reads and every publisher/parent attempt read inspect regular
   single-link bounded files before opening, then use nonblocking/no-follow flags
   where supported and recheck descriptor identity. Unsafe pipes or links cannot
   hang the app or turn unreadable evidence into absence.
7. Before consuming recovery evidence, check the actual contents of existing
   canonical files still needing settlement against the verified digest/status.
   Preserve unknown mismatching files and the journal; skip published/newer
   authority entries. Authority lookups require own registered evaluation items.
8. Every incoming public error detail, including resolver/adapter-supplied detail,
   passes the same closed projection at state, snapshot and receipt boundaries.
   Preserve known codes and the bounded first/recheck tuples, drop extra fields.
9. Carry the actual refused request identity through both presence and absence
   branches into the retirement helper. A competitor can finish between reads;
   matching durable audit and authority disposition can prove completion.
   Repeated consistent audits are valid; contradictory membership and bare
   absence are insufficient, and a replacement request is never sent as the old one.

Final acceptance requires actual host execution, protected independent
source-author-excluded CRITICAL review, exact-head required CI and PR merge.
The wiki records that completed result and preserves the unconfirmed historical
incident causes; it does not turn superseded or interrupted runs into passes.

## Exact settlement and platform execution follow-up

Require the full captured body digest, publication ID and game epoch to match
verified surviving evidence or completed durable proof before acknowledging
settlement in any initial-absence, replacement or late-NO_ATTEMPT path. Another
body can settle independently without resolving this caller's refused request.
Missing proof preserves an explicit failure, authority and the original refusal.
Real POSIX directory-fsync tests run only where supported; separate portable and
Windows file-sync/no-directory-handle contracts remain executable on Windows.

## Supplemental native-platform fixture correction

R18 preserves all production bytes and changes only fixture construction:
serialize generated ESM imports as file URLs; retain the original lock directory
before making the replacement, proving distinct directory identity without
assuming deletion prevents inode reuse. Preserve every security and lost-lock
assertion. Validate core tests and native Windows/Ubuntu CI; use a separate
MEDIUM/HIGH author-excluded review for this supplemental patch because ESLint is
unavailable. The prior CRITICAL product reviews remain valid for unchanged code.
