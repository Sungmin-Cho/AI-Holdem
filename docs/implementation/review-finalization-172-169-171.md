# Review finalization reliability

Issues are implemented in order: #172 diagnostics, #169 Korean claim validation,
then #171 deterministic completion. Existing game events, coach notes, review
publication checkpoints and resume authority remain authoritative.

## Design and implementation plan

1. Split empty output, rejected authority claims and missing headings into
   stable error codes. Log bounded, sanitized failure messages and persist a
   bounded diagnostic output in the session only. Diagnostics never enter UI,
   export or model prompts. Use private files, reject unsafe paths, redact known
   session credentials and common credential forms. Keep four fixed attempt
   slots (two stages, two attempts), so repeated resumes have bounded storage.
   Retention is latest attempt per slot, not a complete historical archive.
   Diagnostic persistence failure is reported without hiding the original error.
2. Extend claim phrase recognition and narrowly scoped Korean negation/meta
   grammar. Coordinated claims can share a directly attached negative predicate;
   a positive claim cannot borrow another clause's negation. Test the six issue
   examples, positive counterparts, compound clauses, and double negations.
3. Use the existing factual machine review for either opponent runtime when no
   upper adapter exists or review attempts are exhausted with confirmed child
   termination. Check termination on the second failure too. Validate game-over
   result and players before fallback. Do not catch source-integrity errors as
   model unavailability. Validate fallback with the same heading/claim guard and
   publish through review_generated -> review_published -> done.
4. Exercise evaluator and synthesizer failures, unavailable adapters, failed
   termination on either attempt, corruption, publication/resume checkpoints,
   and a real Codex adapter with a deterministic CLI fixture. This tests the
   adapter contract without claiming a live model's reliability.

## Review and release

Use model-router for independent review of the plan and implementation where
risk warrants it. Review findings require concrete evidence and adjudication;
record accepted and rejected findings. Run focused regression tests followed by
the repository suite and CI. Publish one PR with ordered commits closing all
three issues and merge only after required checks succeed.

## Boundaries

No migration of existing sessions, no live game modification and no change to
the coach termination or publication gates. Fallback explicitly says LLM
explanation is unavailable and does not claim poker skill, EV or GTO proof.

## Implemented contracts and review decisions

- Error precedence is `EMPTY_REVIEW_OUTPUT`, `REVIEW_CLAIM_REJECTED`, then
  `REVIEW_HEADINGS_MISSING`. Successful empty Codex CLI output carries an empty
  output discriminator through the existing CLI_FAILED adapter error; malformed
  protocol output remains CLI_FAILED. Only model-attempt output is retained;
  checkpoint/fallback validation failures do not get an extra output slot.
- `.review-diagnostics/{evaluator,synthesizer}-{1,2}.txt` contains at most 16 KiB
  per slot, with one fixed `.pending.tmp` scratch slot for crash recovery.
  Retention continues after done for diagnosis; a subsequent attempt replaces
  its own slot. Oversized input is omitted, recognized credentials are redacted
  before truncation, and invisible/control separators are removed before secret
  matching. This is bounded local diagnostics, not a universal secret detector.
- Existing directories and files must pass POSIX privacy/Windows ACL checks.
  Windows checks are batched; failed privacy or I/O leaves `outputStatus` as
  `not_saved` without replacing the primary review failure. Diagnostic writes
  run after the coach result-wait cutoff, outside its publication deadline.
- Export enumerates `hands/hand-N.json` plus engine lastHand and explicit learning
  inputs (`export/hand-normalizer.js`, `export/manifest.js`). UI reads the explicit
  snapshot. Prompts use captured hand data and successful evaluator output.
  Diagnostics have no reader in those paths; export and UI exclusion are tested.
  Session archival may retain diagnostics as intended session-private data.
- Korean coordination delegates only when the entire gap is a noun conjunction.
  The two meta constructions have complete narrow predicates; general `여부` or
  a later clause's negation does not permit a positive authority claim.
- Fallback is entered only for missing oneshot capability or an exhaustion error
  carrying positive termination evidence. Any failed termination takes precedence
  on either attempt. Fallback rechecks engine result, players, stats, derived
  policy data and completed-hand agreement with the persisted cutoff.
- All present stats rows must be well-formed, including AI rows. The engine emits
  complete rows; corruption is not converted to an absent measurement. Engine
  result producers use completed/abort/win/lose; unused loss display alias removed.
- Complete appended fallback text passes heading/claim validation and the existing
  atomic review checkpoint. Invalid fallback output halts without recursive retry.
  After review_generated, digest-checked resume publishes the same review without
  invoking a model. Existing review and replay artifacts are preserved.

Both plan and implementation were reviewed by independently dispatched
claude-opus-5/high and gpt-5.6-sol/high, through model-router 1.14.0 (HIGH risk
9/18, execution EASY 8/18, data_integrity_sensitive, routing confidence 0.95).
The first file-reading seats had operational failures: Sol's nested sandbox
could not read files and was cancelled with confirmed termination; Opus timed
out with confirmed termination. Each missing plan seat was retried once using
inline source. Both returned PASS_WITH_CHANGES. No peer findings were included
in either independent input.

Implementation findings accepted: late cutoff/hand-count revalidation, actual
adapter empty-output classification, bounded crash scratch retention, normalized
secret matching, batched Windows privacy proofs, explicit export exclusion test
and valid result vocabulary. Rejected: permitting malformed AI stats as missing
data, treating an unsupported result alias as legal, and deleting diagnostics at
done (would defeat the requested post-failure diagnosis). Broad archival/optional
self-opponent refactoring was not required: diagnostics remain private with their
session and fallback validates required derived data before optional rendering.
These decisions do not claim arbitrary concurrent same-user filesystem mutation
is contained, or prove live model reliability.

The implementation re-review found one further accepted regression: accessing
`error.code` on an undefined adapter rejection skipped handle termination. Optional
access and a lifecycle regression close it. Other suggestions were checked against
source: Claude stream text already preserves an explicit empty string and normal
oneshot uses plain text; nonzero CLI/protocol failures intentionally do not retain
raw stdout/stderr, which can contain transport credentials. The engine has no
`result = 'loss'` producer in reachable Git history. Present malformed stats remain
errors by design. Speculative Korean paraphrases and alternate diagnostic windows
are not additional accepted authority syntax without regression evidence.
