# Issue #149: Windows privacy gate stabilization

## Scope and baseline

Worktree: `tope`; branch: `Sungmin-Cho/github-issue-triage`.
Baseline main: `306f527f894bc4c1483bd3fccbc8bdf2f0360240` (2026-09-10).

The six Windows shards and full-suite execution are already delivered by PR #155.
PR #177 retains the measured 45-minute file and 60-minute job limits. This work
addresses the remaining privacy-probe timeout, not another sharding rewrite.

The live main ruleset was read on 2026-09-10. It requires
`Node 20.x (ubuntu-latest)`, `Node 22.x (ubuntu-latest)` and `Windows suite`;
one approving review, code-owner review and resolved review threads also apply.
No ruleset changes are needed for this work.

## Observed failures

- [Run 34434712787](https://github.com/Sungmin-Cho/AI-Holdem/actions/runs/34434712787):
  Node 22 Windows loop failed in `Verify Windows private directory creation`.
  Both create attempts reported `ETIMEDOUT`, `SIGTERM`, empty stdout/stderr,
  then `PRIVATE_PATH_UNVERIFIED`; the aggregate failed as a consequence.
- [Run 34345067744](https://github.com/Sungmin-Cho/AI-Holdem/actions/runs/34345067744):
  Node 22 Windows rest/learning-b failed at the same gate, including create/read
  timeouts. Thus the issue predates the latest lobby merge.
- In the successful Node 22 rest job of run 34434712787, the first ACL read took
  about 6.9 seconds and the next about 0.9 seconds. Later proof profiling recorded
  2,899 calls with no timeouts. This suggests a cold-path cost, but does not yet
  identify whether startup, compilation or cmdlet/provider discovery dominates.

## Investigation and validation

- PR #178 starts with diagnostic-only markers for script entry, C# compilation,
  ACL construction, native creation and ACL reading. Markers use a disposable
  trace file; production stdout/stderr, timeout and privacy verdict are preserved.
- Local Node 22 targeted suite: 44 passed, 0 failed (platform runtime, deadline,
  PowerShell environment, proof diagnostics, cold-budget boundaries and CI
  partition contracts).
- JavaScript syntax and `git diff --check` pass.
- [Diagnostic run 34438603636](https://github.com/Sungmin-Cho/AI-Holdem/actions/runs/34438603636),
  SHA `2e690406d43fa4c7df8c71bd0659d1bce50c7f9f`: all 12 privacy gates passed.
  The run was deliberately cancelled once the gate measurements were available;
  its unfinished suite and failed cancellation aggregate are not a green matrix.
- Node 20 study-a measured creation at 12,870 ms: about 8.7 seconds before script
  entry, 4.06 seconds for compilation, and about 26 ms for the native creation
  section. First ACL read: 12,963 ms, including 9.94 seconds in `Get-Acl`; next
  read: 998 ms. These cold costs nearly consume the 15-second production cap.

## Corrective change

CI explicitly prepares the cold Windows PowerShell/.NET dependencies before the
existing production-budget privacy gate. `--cold-start` still executes real
exclusive directory creation, post-create ACL proof and owned-lock proof; it
allows at most 60 seconds per synchronous child within a 120-second total budget.
The CI step has a separate 3-minute guard. Failed or expired preparation fails
the job. Each subsequent ordinary gate retains the original timeouts and the
child-allowlist proof. No product code, ACL policy or required check is changed.

The larger allowance addresses measured cold setup costs on hosted CI; it does
not claim that Windows process startup has been optimized or that every possible
host stall is eliminated. Final matrix status and subsequent validation are
tracked on [PR #178](https://github.com/Sungmin-Cho/AI-Holdem/pull/178).

## First full matrix and residual lifecycle budget

- SHA `919e3fd482414000c25ea58bd3f22b840fd59922`: local Node 22 full suite passed
  2,253 tests, zero failed/cancelled/skipped (697 seconds).
- [Run 34438962309](https://github.com/Sungmin-Cho/AI-Holdem/actions/runs/34438962309):
  all 12 cold/ordinary/child-environment gates passed. Node 22 Windows loop later
  cancelled `repair_failed halt clears only after resume-check reports a successful
  repair boundary` at its literal 10-second test timeout (11.93s including
  cancellation). There was no failed assertion; the same test passed in 5.12s on
  Node 20 Windows. The loop proof profile had zero PowerShell timeouts.
- Its inner `waitForUserSnapshot` already allows `3_000 * WIN32_SCALE` (30s on
  Windows), exceeding the enclosing 10s lifecycle budget. The test is about repair
  correctness, not a performance SLA. Its outer timeout now uses the existing
  `10_000 * WIN32_SCALE`, like adjacent recovery tests; assertions, inner waits,
  product deadlines and POSIX budgets are unchanged.
- Long-term warm proof-call optimization is tracked separately in issue #179.

The privacy/identity checks, caller deadlines, retry diagnostics and six-shard
coverage must remain enforced. No unchecked timeout or unknown proof becomes
success. This record does not claim live Windows resolution or authorize merge.
