# Issues #273 and #274: validation and recovery contract

Branch: `fix/273-274-publish-resume-recovery`, base `cf1b8e5`.
Design: [recovery plan](issues-273-274-recovery-plan.md).

## Verification

Latest supplemental R21 completes R20 in **one pending-drain test fixture only**. A
native Windows 22 run on `d48b354` passed the A/B drain and fresh-current
ordering checks but failed the final cross-time relay/loop checkpoint comparison
(`6 != 5`). That run did not log which operation produced publication 6; a
specific later-publish kind is not claimed as an observed cause.

The first R19 halt-only correction failed the actual host case: its heads-up
AI fold completed the hand, and halting before the next publication left no
user decision for the HTTP assertion. An additional diagnostic copy timed out
and is not a positive reproduction. Both failed outcomes remain recorded.
R20 uses a legal nonterminal AI call so the next human BB decision is already
in the current-action publication. The existing synchronous pre-spawn hook
halts the next publisher; the test explicitly awaits TEST_HALT before reading
the live relay. Exact publication/revision equalities and A/B/fresh-current
order remain, with a stronger exact applied-action list (`p1` call once) and
one model decision. No product file, timeout, skip or CI budget changed.
The focused case and **all 15 cases in its complete test file passed**.
Fresh author-excluded HIGH Sol/Astra reviews of the final test-only delta
both passed with no findings or missing tests. Their protected receipts passed
the official verifier with confirmed termination, model/fingerprint/output
linkage. The next exact-head native CI remains a merge gate.

Prior supplemental R18 changes **only two test fixtures**. The product files
remain byte-identical to the R17 version reviewed by Sol/Astra. Four generated
isolated-probe imports now use native file URLs on Windows. The lost-lock
fixture retains the renamed original directory before creating its replacement,
then checks distinct dev/ino and unchanged owner bytes, avoiding the assumption
that deleting and recreating a directory guarantees a different inode.
The complete core rerun passed **124/124** and the separate audit file passed.
The unchanged 363 compatibility results remain applicable. A fresh author-excluded
Astra HIGH MEDIUM review passed, officially verified with confirmed termination;
it requires the actual native Windows and Ubuntu cases in CI before merge.
The original full suite below ran on parent commit `2f96547`; it is not relabeled
as execution of the new fixture revision. Exact-head native CI remains required.

R17 production candidate (unchanged by supplemental R18): **487/487 host cases passed** — 124 core cases in
a complete rerun and 363 compatibility cases on identical production and
related-test hashes. The new exact-settlement regression also passed separately:
genuine evidence for B does not acknowledge A; late NO_ATTEMPT without proof
stays a failure; completed exact A proof allows one fresh innocent publication.
The portable Windows-path test passed. Real POSIX directory-fsync tests skip
explicitly on Windows; file-sync and no-directory-handle checks remain executable.
The final lobby browser journey passed.

**Both fresh source-author-excluded Sol/Astra MAX CRITICAL reviews: PASS.**
Neither reported a finding or missing test. Their protected receipts passed the
official evidence verifier with confirmed termination, model/fingerprint linkage,
output hashes and all five required categories. Both reviewed the identical
source/test target `43865742e000687fa3e3f12319706e6380b64c53ab480a9cce5b5722c60d8e22`
in independent read-only processes; no host-pass claims or peer output were sent.
The guarded Fable writer terminated with served-model/output/source hashes
independently verified. The reviewer results are static inspection; execution
counts are actual root-host runs. **Full serial suite: 3,583 total, 3,565 passed,
18 skipped, zero failed/cancelled; normal exit 0.** Its owned process group and
temporary services are gone. Root rechecked all 21 source/test file hashes against
the reviewed target. Required CI on the committed PR head remains a merge gate.


Superseded R16 revision 2: **485/485 host cases passed** — 122 core and
363 compatibility cases. Revision 2 corrected two test fixtures only; all
production hashes are identical to revision 1. The complete reruns, including
the new canonical FIFO/value, public diagnostic and middle-read retirement race
cases, passed. The original failed runs remain recorded below. Protected review
round 15 was cancelled with confirmed termination because its packet was
superseded by those fixture corrections. Fresh round 16 Sol/Astra MAX CRITICAL
reviews returned valid FAIL with official verification and confirmed termination.
The incomplete full run was stopped after exact process ownership checks and is
not a pass; all owned group and temporary-service processes are gone. The final
lobby browser journey passed. The guarded Fable writer has confirmed termination; root verified its
served model, output hash and unchanged source hashes.

Superseded R15 revision 3: **481/481 host cases passed** — 118 core and
363 compatibility cases on identical production hashes, plus the final lobby
browser journey. The first core run passed 117/118; its remaining privacy test
matched the permitted code CHILD_SIGNAL_FAILED with the broad word `signal`.
The fixture-only repair retains the exact first snapshot/receipt error objects
and checks quoted raw-message, pid and path sentinels without matching allowed
codes. The complete final core rerun passed; production hashes were unchanged.

Isolated-process regressions reject inherited evaluation keys without prototype,
authority or canonical-file changes. Legitimate repeated audits after an
interrupted retirement reconcile a completed competing call, while contradictory
membership stays unverified. Publisher CLI fresh and bound-retry FIFO cases
return promptly without POST or record removal and release the publish lock.
The first failed launch reports the original run error and LOOP_LOCK_LOST as its
actual cleanup failure, with retained ownership and no replacement. The later
resume in that case exercises cleanup retry, not a fresh recovery launch; a
separate cold-recovery launch with lost-lock first-snapshot coverage is a stated
gap. Both bootstrap and resume catches preserve the same closed cleanup context.

The protected Fable MAX writer completed with confirmed termination and verified
served-model, output and source hashes; its execution was syntax-only. The
counts above are root-host runs. Both protected round-14 reviewers returned
valid FAIL, officially verified with termination confirmed. The owned full run
was stopped after exact PID/start-time/group checks; all owned test processes
are gone. This incomplete run is not a full-suite pass.

Superseded R14 revision 2: **477/477 host cases passed** — 114 core and
363 compatibility cases on identical production hashes. The complete final core
rerun passed after a fixture-only correction. The earlier hard-link case now
restores a regular owned record, observes a real relay refusal during the drain,
then plants the unsafe link before the helper reads it. It asserts the earlier
closed refusal beside the new preflight failure, unchanged record/queue/outside
file, and no subsequent send or retirement. The direct publisher still returns
its existing ATTEMPT_SYNC_FAILED classification; no guard was weakened.

The new POSIX FIFO test is externally bounded in an owned subprocess and checks
both reconciliation and the pipeline helper without a writer, requiring prompt
REJECTION_EVIDENCE_UNAVAILABLE, no POST/disposition and preservation of the
entry. Parent loop attempt reads share the same bounded nonblocking primitive.
A separate retained-session FIFO integration test was not added; existing
retained-session failure tests and the shared reader/real-loop cases cover the
relevant error handling. This is a stated coverage limit, not an execution claim.

Completed competing retirement tests use the identity from the actual refusal,
require matching durable audit and authority disposition, and verify fresh
current-action publication with one engine action. Missing/malformed/mismatched
identity or audit does not authorize settlement. The browser journey passed.
Both protected round-13 reviews subsequently returned valid FAIL, officially
verified with termination confirmed. The incomplete full run was stopped after
exact process ownership checks; a remaining owned study service was stopped
using its official command. All owned test processes are gone.

Superseded R13 revision 3: **473/473 host cases passed** — 110 core and
363 compatibility cases, plus the final lobby browser journey. The four
round-11 findings are implemented and exercised: verified queue progress resets
the consecutive-stall budget; truly unchanged settlements remain bounded;
first HTTP answers on automatic retries persist before successful recovery;
missing attempts reconcile only verified surviving evidence; and actual
annotation values must reproduce their claimed digest even with canonical files
already present. The worker completed its protected Fable MAX dispatch with
confirmed termination and independently verified output/source hashes. It ran
syntax checks only; the execution counts above are root-host runs.

Both protected round-12 reviewers returned valid FAIL; their receipts passed
the official verifier with termination confirmed. The owned full run was stopped
after exact start-time/group checks. A remaining owned temporary study service
was stopped with its official command; all owned processes are gone. The
incomplete full run is not a pass. The following history is not substituted for
final acceptance.

Superseded R12 revision 2: **468/468 host cases passed** — 105 core cases
and 363 compatibility cases on identical production hashes. Revision 2 changes
only the new test fixture: its stand-in now refuses the actual publisher POST
once, forwards snapshot reads to the real relay, and checks the relay's own
persisted publication id alongside its HTTP next-decision projection. The three
revision-1 fixture failures remain recorded and are superseded by the complete
105-case rerun. Runtime source was unchanged between these revisions.

The pending-drain regression settles A, records B before the queued retry takes
the publish lock, and verifies B is drained before the current action is freshly
published, with one engine step. The fresh-refusal concurrency regression holds
training admission while a competing retirement withdraws the attempt, then
verifies the losing helper reconciles evidence and publishes only the innocent
note. Successful recovery tests retain the first closed HTTP refusal in the
owned loop log for both accepted retry and a different retirement recheck.
The browser journey passed. Protected review 11 Astra returned valid FAIL with
confirmed termination. Sol subsequently returned valid FAIL; both protected
receipts passed the official verifier. The owned full
run was stopped after exact start-time/group checks, including a deliberately
SIGTERM-resistant fixture; no temporary service remained. This incomplete run
is not a full-suite pass.

The following execution history concerns superseded candidates.

R11 revision 2: **464/464 related host cases passed** — 101 final-source
core cases and 363 compatibility cases on identical production hashes. Revision
2 changed only three test files. The first run's four test mismatches are retained:
two UI expectations differed from safe messages, the automatic-retry test's
baseline preceded the run's initial accepted publication, and the publisher
error schema expectation lacked its newly added closed request identity. Final
assertions check the actual pre-retry baseline, unchanged replacement record,
no replacement acknowledgement, exact request identity fields, and safe UI
reason/guidance with first and recheck answers.
The automatic-retry case uses a controlled original refusal and the real
publisher's replacement record created by an actual transport failure. It
checks the real loop/publisher resend boundary, applied action preservation and
the replacement's subsequent own publication; it is not claimed as a replay
of the historical incident or as a complete real-relay batch-retirement race.
Its browser journey passed. Both protected independent round-10 reviews returned
valid FAIL; the incomplete full run was stopped after verified ownership checks.

Prior R10 execution evidence (superseded source):

R10 revision 2: **461/461 related host cases passed** — 98 final-source
core cases plus 363 compatibility cases on identical production hashes. The
revision-1 failures were test setup errors: the authority-sync injector now
correctly targets the post-disposition boundary after two pre-disposition
canonical-directory syncs; the lost-lock fixture preserves the same live pid
record while replacing the directory inode, rather than simulating a foreign
unverifiable owner. No runtime source changed between those revisions.
The root actual-relay bypass witness now reports REJECTION_EVIDENCE_PENDING,
no retired explanation on the relay, and retained evidence. Missing refusal
fields also no longer qualify. Final R10 lobby browser journey: **PASS**. Round 9 returned Astra FAIL and Sol PASS_WITH_CHANGES; its incomplete full
run was stopped.

R9 revision 2: **82/82 changed-core cases passed**. Of 375 related
cases, 374 passed and one existing participant secrecy assertion falsely matched
`4242` in the randomly generated game UUID (`339556fb-58b5-4242-8f5e-7220adfc465c`).
The unchanged case passed alone and its full test file passed on recheck. This
false-positive failure remains recorded; neither the assertion nor production
code was changed to mask it. R9 final lobby browser journey: **PASS**. The R9 full run was later interrupted after review round 8 returned valid FAIL;
these outcomes describe superseded source.

R9 revision 1 exposed an ordinary CLI argument regression: the new optional
expectation presence check treated default nulls as provided. Both host runs
failed and are retained. The author corrected null admission in the same active
attempt and added default/partial-pair CLI coverage before revision 2. All six
round-7 blockers and earliest-recheck preservation are implemented with
regressions. R9's mandatory protected writer receipt is SUCCEEDED, termination
confirmed and output hash independently verified; actual execution remains host
validation. The user explicitly authorized continuation and further necessary
review on 2026-10-11, including the manual Fable MAX ceiling exception.

Prior R8 execution evidence (superseded source):
Final R8 focused host validation: **449/449 passed**, no skips or cancellations.
The four changed-core test files passed 63/63; the other 16 related and migration
files passed 386/386 on the same pinned runtime hashes. A separate controlled
child-process preemption witness also passed: no retired explanation reached
the relay and the queue was empty. R8 full serial suite: **3,545 total, 3,527 passed, 18 skipped, zero failures**
(exit 0, 1,568.3 seconds). Final R8 lobby browser journey: **PASS**.
Independent round 7 reviews found remaining defects despite those passing
executions; PR creation remains gated on correcting and reviewing them.


R7 host validation verified **440 focused and compatibility cases** across 20
publication, training, authority migration, runtime, retained-session, app and
public-contract files. The first targeted run passed 53/54; its remaining test
had an invalid playing-to-end fixture transition, corrected to pause before end
without weakening assertions, and passed separately. The remaining 313 related
and 73 migration cases passed. The R7 lobby browser journey also passed, and an additional final-source browser
run after the concurrency correction passed.
These runs used pinned source hashes and owned temporary stores. A subsequent
real concurrent-producer witness exposed one remaining authority settlement
race. Its correction passed the original real-relay witness (both operations
complete, no remaining attempt/evidence, empty queue) and all **45 affected
pipeline/publication cases**, including a new controlled production regression.
The source was then frozen for the full serial suite and independent reviews.
The pull request records full serial-suite and required Ubuntu/Windows CI results
for its exact head; those checks are merge gates, not inferred from worker output.

The previous expanded run had three recovery-test failures: concurrent retirement
could stall its lock release; a fixture retained an archived private card; and the
combined fixture invented a decision without practice provenance. The final code
and fixtures correct those causes. The real integrated case now uses an actual
engine-recorded user decision and asserts refused explanation → applied AI action
publication failure → unconfirmed cleanup → blocked resume → confirmed-close
recovery of the same game, with the action applied exactly once.

The previous full host run also failed the unchanged G6 policy gate at
`bet-when-checked 51.3bb/100`. An untouched-base full policy file and four
untouched-base G6-only runs passed; current-source G6-only also passed. The engine
randomizes the initial button independently of the simulator's card/action seed.
A controlled temporary copy of the base simulator, with only that valid initial
button fixed to 5, produced **51.284bb/100**, matching the failure's printed value.
This isolates an existing random-position gate outcome; the controlled copy is
not described as a failing untouched-base run. Policy code and thresholds are
unchanged by this work.

The R6 full-suite run spanned an overnight interruption and accumulated long
timeouts. It was stopped after verifying the owned process group, working
directory and output log; termination was confirmed. It is retained as an
interrupted run, with its failures preserved, and is not a full-suite pass.
The fresh R7 full-suite run was stopped before editing after verified independent
review round 6 found blocking defects. It had 1,821 passing top-level lines and no
observed failures before interruption; it has no complete suite summary and is
not counted as a pass. The owned group and temporary-service cleanup were
verified, without touching the original app/store.

An earlier browser run timed out at an owned corrupted-state fixture; its precise
cause remains unconfirmed. Subsequent unchanged-code runs and the final-source
run passed without weakening assertions. The user's running app and store were
not used for validation.

Worker/runtime evidence is kept separate. The initial writer timed out and a
completion worker's outer sandbox denied identity/atomic-write operations. The
R6 Fable writer's receipt is INVALID_OUTPUT because Claude Edit replaced the
three declared artifact inodes; termination was confirmed, changed paths were
independently checked as regular single-link files, and their hashes were pinned.
That receipt is not claimed as successful completion. Passing
execution evidence comes from root-host tests of those pinned files; independent
reviews assess the resulting artifact. R7 Fable completion is **SUCCEEDED**, with served-model evidence and confirmed
termination. Its protected receipt, output digest and independently pinned
regular-file hashes were checked; inode identity was not declared as an artifact
requirement because Claude Edit replaces files atomically. The final writer ran
syntax checks only; host execution and independent review are separate evidence.
ESLint and Stryker are not installed, and
this repository defines no lint command.

## Publication rejection (#274)

The publisher carries only HTTP status and a code from a closed relay-code
vocabulary through its CLI envelope. Response text, URLs, tokens, annotation
values and private cards are excluded. Semantic refusals no longer trigger a
transport-style relay restart. Other publication failures retain existing recovery.

Only `400 FORBIDDEN_LITERAL`, `400 ANNOTATION_PROOF_MISMATCH` and
`409 ANNOTATION_CONFLICT` can retire an annotation-only attempt. Action, view and
machine evaluation bodies remain non-retirable. Epoch, authorization, missing
machine-row and other refusals retain their fail-closed paths. The helper requires a verified relay binding and
passes the expected body's SHA-256, epoch, PID/start time and port to the publisher.
The publisher compares them under its publish lock and verifies lock, process
identity and listener ownership immediately before and after the exact POST.
A changed binding or body preserves the attempt and fails explicitly. Accepted
retries also return their body digest, so the helper cannot settle a different body.

Retirement writes a bounded audit (at most 200 lines / 512 KiB) containing IDs,
digests, epoch, status and code, without values. Shared audit I/O rejects unsafe
file types, links, oversized files and read failures; only ENOENT means absence.
Before retirement evidence is written, the exact recorded attempt is file-synced
and its directory synced, including the unchanged-attempt path. Writable handles
permit the Windows file-sync implementation without changing existing bytes.
Audit and evidence use exclusive random temporary files, synced and installed
with directory sync before the attempt is removed. The unlink is followed by another directory sync.
Node cannot sync directories on Windows; file sync and rename still apply there,
but identical power-loss metadata durability is not claimed.

A separate owner-only, bounded private retirement journal preserves the exact
refused body, annotation authority and verified relay binding before attempt
removal. It contains no relay token. Training authority accepts only matching
durable evidence and matching current annotation digests. Single-item refusals retire that explanation; multi-item
refusals isolate entries for individual publication because the server does not
identify which entry was refused. Canonical values remain stored. Crash before
attempt removal retries the same body; crash after attempt removal recovers from
the private journal before building an annotation, without restoring or resending
the refused attempt. Authority replacement is followed by training-directory
fsync before journal consumption, including unchanged-authority replay. Sync
failure preserves the journal for another recovery. All same-session training authority lock admission, including ordinary
accept/mark/consume operations, retirement and migration, queues asynchronously
across control instances and path aliases before the existing filesystem mutex,
preserving cross-process ownership gates. Queue dispositions are idempotent.
Unsafe or unreadable audit/journal state settles nothing. Training flush no-progress
limits remain.

Annotation batching observes both the 64 KiB request-body and audit-line budgets.
A large valid batch therefore remains recoverable within the existing
512 KiB total audit bound. After a pending attempt is settled, a flush rebuilds
its envelope from current authority instead of submitting its prebuilt stale body.
If another producer has already removed a refused body as stale, the annotation
flush rebuilds after that explicit stale result only when the recorded attempt is
absent, within the existing settlement limit; a retained attempt stays an error.

A pending explanatory attempt is settled before the current action is published.
An already applied engine action is never run again to solve an annotation refusal.
A refusal whose safety cannot be established retains its attempt/queue and reports
`PENDING_ANNOTATION_BLOCKED`.

## Retained session resume (#273)

Child termination/disposal callers share an in-flight observation. A failed
observation is cleared for a later bounded observation; successful delivered
signals are not resent to a potentially reused PID. Disposal permanently closes
the runtime to new work even if cleanup fails. PID absence alone is not close
confirmation. Actual unconfirmed child or HTTP termination retains ownership.

Resume with a retained failed session or a failed launching loop first retries
cleanup. Failure yields a
failed command receipt with ownership preserved; confirmed cleanup permits the
ordinary recovery launch. Shutdown's closed guard still prevents a replacement
launch. Resume writes success only for an actual resumable/terminal result state,
never for an error-state no-op. The snapshot and lobby retain separate original
run and cleanup diagnostics. The first closed HTTP refusal tuple survives a later
verification or retirement failure, with at most one separate recheck tuple. Complete public snapshots and command receipts use a static closed code vocabulary;
unlisted identifier-shaped text becomes `UNLISTED`. Command replay uses the
same projection as receipt reads, including legacy stored rows and pending
decision codes, without rewriting the private journal. Original run/cleanup details
survive a failed replacement resume.

## Review and test coverage

The initial model-router route was HIGH. Source authors are Sonnet, Opus and
Fable; Haiku authored the small fixture correction. Final recovery architecture
and review retain the CRITICAL checks: security, edge cases, rollback, test
adequacy and specification compliance. Fresh independent Astra and Sol CLI seats
exclude every source author, take the same pinned source/test diff and original
issue requirements, receive no peer output, and use a protected receipt store.
The user authorized the additional bounded repair/review loops and PR/merge after
verification. The available final slate has no separate adjudicator; no model
adjudication is claimed. Final receipt-backed dispositions are recorded in the PR.

New coverage includes real relay refusals; unchanged attempt/queue on non-retirable
or unverifiable outcomes; body replacement and concurrent retirement; audit
read/write/sync failures and crash boundaries; private-code projection; no duplicate
engine action; restart recovery; retained cleanup failure and later successful
resume; concurrent stop/resume requests; and child close/disposal retry.

## Historical limits and accepted follow-ups

The original incident store was unavailable in this worktree and the main checkout.
An independent real-relay fixture reproduces a `FORBIDDEN_LITERAL` refusal blocking
later publication. It establishes that mechanism, not the original incident's
HTTP code or the cause of the first child-close timeout. The historical association
with post-restart `SESSION_STOPPED` remains unconfirmed. The user's running app and
original store were not modified or replayed.

Private-literal validation depends on the current hand context. Conservative
explanation retirement can therefore discard innocent text that collides with a
later private literal. Values are preserved and security validation remains active.
Coach/review direct-retry paths can still halt explicitly on a pending annotation;
ordinary resume/action publication settles eligible attempts. `ANNOTATION_ORPHAN`
remains non-retirable. Broader diagnostic fields predating this change are outside
this projection change. These limitations are recorded without weakening gates.

## Rollback

Reverting the source changes restores the previous behavior. New audit files and
extra training-item/cleanup fields and private retirement journal are additive;
no schema version or lock format changes. Old code ignores the new evidence and
can again encounter the original blocked
publication behavior. Existing proof, epoch, owner identity, listener and
private-information checks remain in place.

## Final lifetime-boundary repair

Round 6 fresh Astra and Sol reviews both returned valid FAIL with confirmed
termination. Their five distinct findings concern ordinary retry durability,
nonsemantic first-refusal diagnostics, retirement proof eligibility, concurrent
publication past unsettled evidence and pre-seal authority rollback.

Root-host witnesses independently confirmed that the current-hand context can
change while settlement is blocked and allow a retired explanation to reach the
relay; that pre-seal authority with surviving exact files/evidence can reseal the
refused value after the journal is consumed; and that a malformed proof can
produce `retired:true` but unreconcilable evidence. The context witness includes
complete archived hands; an earlier incomplete fixture failed safely because a
required hand archive was missing and is not claimed as the accepting outcome.
The user-approved attempt 8 is routed to Fable MAX for these concrete corrections.
Ordinary retries preserve the recorded body durably; retirement checks proof
eligibility before POST; all annotation publications observe pending evidence
before reading authority; explicit absent-attempt recovery reconciles before
rebuilding; pre-seal rollback records the proven singleton refusal even with its
queue entry absent; and nonsemantic recovery preserves the first response while
classifying subsequent responses by their own closed tuple.

The first R8 core run passed 58/63. Five test preparation failures were corrected:
the scripted CLI was moved outside the game directory initialization removes;
both machine rows were published before creating the refused explanatory attempt;
and the old race gate now expects the stronger pre-POST evidence block. The five
fixed cases passed, followed by a complete unchanged-runtime 63/63 rerun. No
product guard or assertion was weakened.
The final full-suite and independent review outcomes will replace pending status
before PR creation and merge.

R8 full serial-suite run completed with exit status 0: 3,545 tests, 3,527
passed, 18 skipped, zero failures; the exact summary is retained in
`full-r8-host.log`. Round 7 Astra and Sol both returned valid FAIL
with termination confirmed. The full run is execution evidence of that superseded
artifact, not an independent-review pass. The remaining six repair cases and
model-ceiling control are recorded in the recovery plan. At that stage, no PR or merge had
been performed.

Additional root-host probes on an isolated frozen R8 runtime confirmed: an existing
JSON-null evidence file permits resend after context changes; duplicated notes
[A, A] with authority [A, B] isolate B despite its absence from the body; loss of
an innocent batch member's exact-file entry leads to journal consumption and
`exact-file-missing` queue removal; and an accepted retry withdrawing both files
can race a reconciler holding old evidence, leaving `published:true` together
with `publishFailed:rejected`. The first withdrawal probe used the wrong I/O
checkpoint and did not reproduce; the corrected controlled `openSync` checkpoint
reproduced the interleaving. These are demonstrated defects, not passing product
regressions. The user authorized continuation and further necessary reviews on 2026-10-11;
R9 repairs these demonstrated defects under the existing controls.

## Review round 8 and R10 continuation

Both fresh protected reviews on R9 revision 2 completed with valid FAIL and
confirmed termination. Four substantive defects remain: restoration replay
directory durability, missing status/code incorrectly qualifying as a refusal,
an annotation body without the optional authority wrapper bypassing pending
evidence, and LOOP_LOCK_LOST clearing the original run failure before stop
succeeded. A root actual-relay probe confirmed retired A reached the relay via
the authority-less envelope after context changed while evidence remained.
This diagnostic probe executed successfully to demonstrate a defect; it is
not a passing product contract. R10 repairs the union under the user's explicit
continuation authorization. The R9 full-suite run was stopped only after
verifying its owned group and logs; the group is gone and no temporary-service
process remains. Its incomplete result is not counted as a full-suite pass.

## Review round 9 and R11 continuation

Protected review 9 returned Astra FAIL and Sol PASS_WITH_CHANGES, with both
terminated. Astra identified an unbound automatic transport-recovery retry
(the separately bound unresolved-training helper did not cover that path),
and generic lobby handling for new binding/evidence errors. Sol noted a low
matching-initial nested recheck omission. The disagreement route reports no
unused tier-3 judge; no adjudicator receipt or invocation is claimed. Under the
user's explicit delegation of judgment and further necessary work, the union
is corrected and independently reviewed again; neither reviewer is declared
incorrect. The R10 full run was interrupted after verified review failure,
with its owned group gone and no temporary-service process remaining.
It has no final suite summary and is not counted as a full-suite pass.

## Review round 10 and R12 continuation

Both protected reviews on R11 returned valid FAIL with confirmed termination.
The union identifies a pending-drain existence-check race that skips the current
action publication, fresh-refusal concurrent settlement incorrectly triggering
the no-progress latch, and loss of the initial HTTP tuple when recovery succeeds.
R12 repairs these under the user's continuation authorization. The R11 full run
was stopped only after verifying its exact pid/start-time/group; that group is
gone and no temporary-service process remains. Its incomplete result is not a
full-suite pass. The prior 464-case and browser passes remain superseded-source
evidence, not review acceptance.


## Review round 11 and R13 continuation

Astra identified two remaining medium correctness/diagnostic gaps: successful
retirements counted against the fixed no-progress budget, and a first HTTP
refusal received only on an automatic retry disappearing after successful
recovery. The protected reviewer receipt passed the official evidence verifier
and confirmed termination. Sol additionally found missing-record settlement before the helper's first read
and inconsistent evidence value/proof admission when canonical files already
exist. Both protected receipts passed the official verifier with termination
confirmed. R13 corrects the four distinct findings under the user's explicit
judgment delegation; the model-ceiling terminal and manual exception remain
separate records. Final candidate execution and review will replace the
superseded results before PR creation. The original running app/store and policy
thresholds remain unchanged.


## Review round 12 and R14 continuation

Both reviewers confirmed a synchronous unsafe-attempt read: opening a POSIX FIFO
before checking its type can block the app's event loop and defeat command,
shutdown and timeout handling. Astra additionally found that a fully completed
competing retirement can disappear before the losing helper's first read:
attempt and private evidence are gone, while the audit and authority disposition
are durable. The surviving-evidence-only path still returns a false recovery
failure in that case.

R14 protects attempted-record reads with bounded contained regular-file checks
and verifies the expected refused body's exact identity against durable audit
and authority disposition when another caller has fully settled it. Bare
absence remains insufficient. The user delegated further necessary correctness
work; typed model-ceiling terminals and manual exceptions remain recorded.
Final execution, independent review and exact-head CI remain required.


## Review round 13 and R15 continuation

The four distinct protected findings concern inherited authority-map lookups,
legitimate repeated audit rows after interrupted retirement, first cleanup
context when bootstrap/recovery loses loop-lock identity, and unsafe attempt
reads inside the publisher CLI. R15 adds own-item validation, consistent repeated
proof handling, preservation of the actual cleanup code without changing the
headline/ownership rule, and the shared bounded attempt reader at the CLI entry
points. The user delegated further necessary correctness work; the model-ceiling
terminal and explicit manual exception remain separate records. The new local
batch cap is 16 implementation attempts and 17 review rounds, judge limit 1.
Source-author-excluded CRITICAL review and actual final execution remain gates.


## Review round 14 and R16 continuation

The four distinct protected findings cover canonical-file FIFO reads, readable
canonical contents disagreeing with the recovery digest, adapter-supplied
errorDetail bypassing snapshot projection, and a completed retirement occurring
between the loop's record read and the helper's reread without the expected
identity being carried. R16 applies bounded nonblocking contained reads,
validates needed canonical values before disposition/evidence consumption,
projects every incoming public diagnostic detail, and carries the refused
request identity through both helper branches. Values, queue and evidence stay
intact on unsafe or inconsistent files; published/newer entries are not overwritten.
The existing explicit continuation authorization, protected independent review
and actual final execution gates remain in force.

## R16 revision 1 host execution

The core run completed with 122 tests, 121 passes and one failure: the new
hostile-detail fixture expected a result snapshot on a failed-command receipt,
although the unchanged receipt contract records results only on success. The
whole first error snapshot projection passed. The related run completed with
363 tests, 360 passes and three failures (two ABA subtests and their parent):
the guarded read refused the injected inode swap before the read hook could
restore it; the production rejection assertions passed, while the fixture
required reaching that hook. Both failures are retained, not counted as passes.

R16 continues with fixture corrections and actual reruns. The already launched
independent review round 15 pair was cancelled through the official dispatcher;
both protected receipts confirm termination. Its superseded packet is not review
acceptance. Fresh review and final execution remain required.

## Review round 16 and R17 continuation

Both protected reviewers identify the same exact-settlement gap: the initial
absent-record branch acknowledges the captured A after reconciling a different
B, and a late publisher NO_ATTEMPT is accepted solely from absence. R17 requires
matching verified surviving evidence or completed audit/disposition for the
full captured identity at every successful settlement boundary. Independent
reconciliation of B cannot acknowledge A.

Astra additionally identifies real-filesystem tests forcing POSIX directory
fsync on Windows. R17 separates actual POSIX checks from portable/Windows
file-sync and limited-directory behavior; the Windows limitation stays explicit.
The user delegated necessary further work. The typed Fable MAX ceiling terminal
and the manual exception remain separate; local batch caps are 17 implementations,
18 reviews and one judge. Final execution, fresh independent review and exact-head
CI remain gates before merge.

## R17 revision 1 execution and revision 2 fixture correction

The complete core run passed 123 of 124 cases; the one new identity fixture
expected an unpublished sealed annotation to have published undefined, while
the established representation is published false. Its preceding unrelated-B
evidence, queued-A and no-acknowledgment assertions passed. Revision 2 makes
that assertion explicitly false, preserving the safety check. The full related
363-case run passed. Root verified the only changed file is the new core
fixture; all runtime and related-test hashes are identical, so those related
results apply to revision 2. The new identity test passed in a separate actual
run, including unrelated evidence, late NO_ATTEMPT without proof and late
NO_ATTEMPT with completed exact proof followed by one innocent publication.
The complete 124-case core rerun passed. Both fresh protected round-17 reviews
subsequently passed; final acceptance results appear at the top of this document.

## First PR CI and supplemental fixture portability (R18)

PR #275's first CI run `38161783028` on `2f96547` completed with failures.
Both Ubuntu versions failed the same three new lost-lock fixture assertions:
the fixture removed then recreated a directory while claiming a new physical
identity; old/new inode values were not logged. R18 holds the original inode
live by rename, verifies a physically distinct replacement, and preserves the
same owner bytes and all failure/retention assertions. The two Windows rest
jobs failed the isolated prototype-forgery probe before its assertions because
native drive paths are not ESM URLs. R18 converts all four probe import literals
without changing module targets, cases, skips, timeouts or production guards.

Windows 20 additionally reported EPERM opening a coach reservation in the
unchanged upper-background-resolve case; Windows 22 did not report that failure.
The first UI learning journey timed out waiting for a fold button after a normal
all-AI-fold walk had already completed the one-hand game (CI trace and screenshot).
The current full learning journey passed on owned local fixtures. The unchanged
baseline source matches 485 JS/MJS files; bounded random and controlled-position
probes did not reproduce that walk, so no baseline reproduction is claimed.
The native CI rerun on the fixture-corrected commit must settle these outcomes.
Original failures and probe results are preserved rather than labeled passes.

This supplemental execution is mechanical test construction, with unchanged
product risk/review acceptance. Missing repository ESLint triggered a separate
model review; the expanded filesystem fixture received MEDIUM/HIGH review in a
protected fresh read-only Astra process. R18 Haiku LOW completed with verified
served model, output hash and termination. The user delegated necessary further
work; the typed ceiling history/manual exception and rescore remain separate.
The local batch caps are 18 implementations, 18 reviews and one judge.

## R19/R20 test observation boundary

The user delegated necessary additional fixes and reviews through merge/wiki.
The earlier Fable MAX capability terminal remains preserved; the isolated
fixture scope was rescored separately. Guarded R19 Haiku MEDIUM completed with
confirmed termination but failed the host acceptance case. Its typed failure
routed to stronger R20 Opus MEDIUM, with protected served-model/output/source
checks and confirmed termination. The construction route's reduced review gate
is compensated by separate author-excluded HIGH dual review. Original product
CRITICAL dual acceptance remains applicable because all 11 runtime files are
unchanged. Batch bounds are now 20 implementations, 20 review rounds and one
judge; no adjudicator invocation is claimed.

R20 host execution: focused real pending-drain case PASS; the complete affected
loop-publication file has 15 passes, zero failures/skips/cancellations and normal
exit 0. Owned temporary fixture cleanup completed. The old R18 CI failure and
R19 failed diagnostic/test outcomes are retained, not counted as passes.

## Supplemental review 19 and final R21 acceptance

Protected HIGH review 19 returned Astra PASS and Sol PASS_WITH_CHANGES with one
blocking test-adequacy finding: stopping any next publisher could hide an extra
fresh CURRENT after the accepted metric. The finding is accepted and fixed;
no reviewer is declared incorrect and no judge invocation is claimed.
R21 asserts the complete next invocation is exactly the unmanaged user's
`--from` turn / `--wait-only` / `--wait-ms 0` array before assigning TEST_HALT.
Unexpected CURRENT/retry/view or other arguments now fail the test. No optional
flag relaxation is needed before finalization. The final complete file passed
15/15 with zero failures/skips/cancellations and normal exit 0.

The Claude-only retry plan returned INDEPENDENCE_UNAVAILABLE and was not
executed. The cross-family route retains both typed Haiku/Opus failures and
selects stronger Fable MEDIUM plus author-excluded review. Its guarded writer
completed with verified served-model/output/source evidence and termination.
Fresh protected HIGH review 20 Sol/Astra both passed with no findings or missing
tests; the official verifier exited 0 with confirmed termination. Both saw the
same single-file delta `623a4b9a9134dda63ea2eee3cb7f71afa2787fb99ee06497535a0cad53b28fdd`.
All 11 product files are byte-identical to the original CRITICAL dual-PASS R17
version. Batch bounds are 21 implementations, 20 review rounds and one judge.

Second native CI run `38165255733` completed on `d48b354`: 19 checks succeeded;
Windows 22 rest and its Windows aggregate failed only the pending-drain fixture
comparison above. Ubuntu Node 20/22 each completed 3,582 full-suite cases:
3,573 passed, 9 skipped, zero failures/cancellations. Windows 20 rest completed
2,342 cases: 2,226 passed, 116 skipped, zero failures/cancellations. The browser
journey passed. The earlier Windows 20 coach-reservation EPERM did not recur.
The R18 Windows ESM and Linux lock-identity fixture corrections passed in these
native executions. These are earlier-head results; a new exact-head CI run is
required for the final test-fixture commit before merge.
