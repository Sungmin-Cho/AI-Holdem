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
