# Windows study lifecycle evidence

Issue #179 measures request wall time independently of suite-wide cumulative proof time. `test/helpers/benchmark-study-lifecycle.mjs` runs an actual detached service in an isolated private store, records fresh-service ensure and warmed ensure/inspect/HTTP/stop operations, rejects a wrong token, and verifies the exact stopped process and removed descriptor/lock. The harness preserves failed/censored rows in denominators. No user store or credentials are exported. Its external-checkout loading belongs to the test harness, not the guarded production dependency graph.

The paired Windows workflow uses the same runner for baseline and candidate, alternating order across three fresh lifecycles per revision, with ten warm samples per lifecycle. Order is baseline/candidate, candidate/baseline, baseline/candidate: this reduces but does not eliminate order effects; it is not a perfectly counterbalanced statistical experiment. It records SHA, OS image, Node, PowerShell, wall-time rows and redacted proof kinds/durations. Fresh service/store is not a cold operating-system cache. Concurrent service checkpoints may fall inside client operation windows. Cumulative proof time must not be reported as request latency.

The candidate merges only adjacent synchronous context/ownership reads in inspect and stop into one existing before/after ACL transaction. If an alias or Windows short spelling differs from the canonical path, initial reads retain the original separate canonical transaction instead of multiplying per-file fallback proofs. Stop's context assertion also stays inside its transaction. All inode, descriptor bytes, owner/start-time, reparse, deadline and post-await revalidation checks remain. Identity memoization is transaction-local; no TTL, persisted cache, await-spanning proof or long-lived PowerShell host is added. Writes and process ownership handoffs retain their existing boundaries.

The benchmark measures canonical store paths on both revisions with diagnostics enabled. Alias behavior is separately regression-tested with a real service. Partial final diagnostic lines are deferred, malformed complete lines fail measurement, and rows are saved after every operation with `complete:false`/`passed:false` until terminal completion. Success-only percentiles, censored counts, maximum observed latency and client/service proof totals are separate. The paired report aggregates all 30 warm observations per revision; its PASS means complete evidence, not a performance improvement. Automatic Node test discovery never starts the standalone benchmark.

Local POSIX lifecycle and security/recovery tests: 55 passed. Final combined local integration: 2,308 passed, zero failed (803,974 ms). Local benchmark smoke passed; POSIX has no PowerShell proof calls and is not Windows performance evidence. Windows paired results and full Node 20/22 Linux/Windows gates must be recorded before accepting the optimization.

## Preliminary measurement, not isolated optimization evidence

[Run 34509414263](https://github.com/Sungmin-Cho/AI-Holdem/actions/runs/34509414263) completed on both Node versions with all six paired records complete and no failed measured operations. Baseline `87512461c37372032f8eda044a15d2621ec20412`, candidate `02f8458ba44065eaddc555f98b4d870751a8c6d0`. Windows release 10.0.26100, x64, image 20260907.229.1, PowerShell 5.1.26100.33296; Node v20.20.2 / v22.23.2. The candidate also contains the preceding recovery/policy/provenance features, so this comparison cannot isolate the optimization's causal effect. The final baseline must include those merged features.

| Node | Operation | Baseline median / p95 ms | Candidate median / p95 ms | Client proof calls B / C |
|---|---|---:|---:|---:|
| 20 | inspect (30 samples) | 10119.7 / 15042.1 | 7178.8 / 7529.2 | 362 / 270 |
| 22 | inspect (30 samples) | 9980.4 / 10178.8 | 7368.3 / 7466.3 | 330 / 270 |
| 20 | stop (3 samples) | 27489.4 / 27711.7 | 24446.9 / 24782.8 | 103 / 92 |
| 22 | stop (3 samples) | 23410.5 / 23651.7 | 19471.2 / 19627.8 | 80 / 65 |

Not every operation improved: HTTP-summary median rose from 1750.8 to 1873.3 ms on Node 20 and 1754.1 to 1903.6 ms on Node 22, while its service-side proof counts also changed. Cold ensure was approximately unchanged; warm ensure had mixed small changes. Neither the HTTP difference nor the inspect/stop improvements are attributed solely to the optimization in this preliminary comparison. Raw per-operation evidence and proof kinds remain in the run artifacts. Final isolated measurements and acceptance adjudication are recorded in [PR #186](https://github.com/Sungmin-Cho/AI-Holdem/pull/186), separately from this preliminary run.
