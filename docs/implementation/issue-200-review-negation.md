# Issue #200: Korean review caveats

## Design

Recognize the complete `최적해` noun and allow a middle dot only as a direct
connector between matched authority nouns sharing one predicate. Accept the
specific `판정이 아니라` predicate. Keep each claim independently checked;
sentence boundaries, positive claims and reported/double negations remain denied.

Review failures already distinguish empty output, rejected claims and missing
headings with structured codes. Reuse these codes for a fixed correction on the
second attempt. Never interpolate rejected text or exception messages into a
later prompt. Preserve two attempts per stage, confirmed termination before retry,
private diagnostic slots and the existing factual fallback/publication lifecycle.

## Implementation plan

1. Add positive and adversarial regression examples; reproduce the two failures.
2. Extend only the noun, connector and predicate rules above.
3. Add allowlisted, code-specific retry instructions to the original stage prompt.
4. Verify both review stages, prompt privacy, exhaustion and termination gates
   using existing loop fixtures and the real adapter with a synthetic CLI child.
5. Route independent code review; assess findings, run full sequential CI, then
   create and merge the PR after required remote checks pass.

## Evidence limits

Synthetic CLI and loop fixtures verify contracts, not real-model review quality
or poker skill. No private game output is needed for this fix.

## Verification and review

- Before the fix, the new regression failed on the middle-dot example.
- Initial implementation: full sequential `npm run test:ci`, 2,383 passed,
  zero failures/skips (commit `87fff8c`). Focused loop finalization: 14 passed.
- Model-router classified review as MEDIUM (risk 7, execution 8/EASY).
  The guarded Claude Opus 5 attempt timed out with no verdict; termination was
  confirmed. A fresh native GPT-5.6 Sol/high review used independent context;
  provider-family diversity was unavailable on this completed review path.
- The reviewer identified Unicode line/paragraph separator propagation. Synthetic
  probes reproduced both cases. Accepted: all JS line terminators now bound the
  prefix, suffix and noun connector, with regressions at each location.
- After that correction: reference/export and private diagnostic suites, 20 passed.
  Remote full CI runs on the final PR commit before merge.
