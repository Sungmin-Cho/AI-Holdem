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
