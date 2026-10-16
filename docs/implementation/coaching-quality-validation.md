# Pre-PR validation record

Audit baseline: `b239dd72261070f8834ee36d3d7129f40f0fb546`. Delivery base:
`edb0b57bdb07d46718776f0a30446062521455a9` (concurrent PR #294). Branch:
`Sungmin-Cho/holdem-coaching-quality`. This is the local pre-PR record; the
complete exact-final-SHA GitHub checks remain a required merge gate.

## Delivered behavior and review basis

- Codex LLM players use latest Sol / explicit low (`gpt-6.1-sol` fallback);
  upper coaching/review remains medium, with the existing short study
  explanation's model-default exception. Existing services are not restarted.
- One validated prospective user decision reaches the hand coach. Completed
  replay/result, future boards and opponent cards do not. The fixed outcome
  is injected before validation/seal/proof; existing private-card checks remain.
- Coaching-only public-action ranges use historical boards and explicit fixed
  heuristic assumptions. Any live opponent with incomplete evidence suppresses
  range equity. Exact price arithmetic and simulated equity do not establish EV.
- Evaluator facts and machine detectors use available process projections; a
  malformed decision cannot supply a verdict or erase its valid neighbors.
  A loss fact label uses the actual last decision only when it is valid.
- Study next steps bind verified source/hash and retest identity; a protected
  start checks unfinished state atomically under the drill lock, preserving
  normal deliberate replacement and idempotent recovery.
- Recorded policy/reference bytes are unchanged. Policy v3's river raises
  remain value-only; LLM bluff/persona frequencies are uncalibrated.

Model-router supervised the makers and independent reviews. Initial core R3:
Astra PASS; Opus PASS_WITH_CHANGES with one non-blocking loss-label finding,
subsequently reproduced and fixed. Upstream integration: Opus/Astra PASS/PASS.
Comparison R3: Terra PASS. Final one-line simulation wording: Opus/medium PASS.
The one fenced Opus R2 output was INVALID_OUTPUT and is not counted as a pass.

[Structured evidence](coaching-quality-evidence.json) preserves supervisor
receipt/output hashes, requested model/effort, actual envelope model metadata,
34 final source hashes, 25 preserved policy/reference hashes and test summaries.
The final source matches the original-core, integration, wording and scoped CI platform snapshots.
Separate processes and fixed inputs were used; Codex read-only reviews did not
use the Darwin receipt guard. No stronger isolation property is claimed.

## Local checks

Node v26.0.0, dependencies installed with `npm ci --ignore-scripts`.

| Check | Observed result |
| --- | --- |
| Integrated `HOLDEM_PUBLIC_PORT=0 npm run test:ci` | 3,958 tests: 3,938 pass, 2 fail, 0 cancelled, 18 platform skip; exit 1 |
| Final fact/coach/replay consumer suites after the one-line correction | 88/88 pass, exit 0 |
| Integrated backend/controller/UI contract checks | 85/85 pass |
| Historical-all-in, comparison argv/cleanup and v3 source inventory checks | 62/62 pass |
| Final next-step rendered journey | 15/15 required checks, cleanup confirmed |
| Final replay library rendered journey after wording correction | 22/22 required checks, cleanup confirmed |
| Final existing learning rendered journey after wording correction | 19/19 required checks, cleanup confirmed |
| Old policies, estimator and reference data | All 25 baseline file hashes match |

The integrated whole run is **not labeled green**. Both failures were the same
shared simulation caveat's generic word `쇼다운` matching the strict own-replay
result-vocabulary checks, reproduced in isolation. After that run ended, exactly
one string changed to the equivalent "추가 베팅 없이 끝까지 패를 비교한다는
가정". All original projection/DOM privacy assertions remain unchanged. The
complete affected fact, coach and replay modules (88 tests), followed by the
actual replay and learning browser journeys, passed on those reviewed bytes.
The final complete Linux/Windows result will be the exact PR SHA's CI, which
must pass before merge; no local full-suite success is manufactured.

The rendered study API fixture proves page requests and recovery, while the
real temporary-backend two-controller test proves stale-tab atomic protection.
The refused protected start preserved the unfinished assessment byte-for-byte,
and an ordinary explicit Start could replace it. Browser protected-store
checks used an owned empty temporary directory, not a changing user game.
Production game/study stores were never used as fixtures or stopped.

The real-loop prompt-invariance test also has a pinned-base behavioral RED:
export b239dd7, copy only its new test file and run that named test. One test
ran and failed with ERR_ASSERTION because the old prompt included completed
replay/private cards; there was no import error. It passes on the new source.
Transcript SHA-256:
`e489b37dd1d3fed47e5b9f98f96fa244aec94c82227e8ad83962d003660e6b47`.

## Actual provider observations (2026-10-16)

`node tools/compare-codex-players.js --live --samples 6 --timeout-ms 60000
--budget-ms 900000 --json`, codex-cli 0.162.1. The first execution used schema
`/1`: actual no-tool canary probes, production-adapter warmup/resume, identical
engine situations, temporary cwd and confirmed cleanup. Elapsed: 124,178ms.

| Setting | Legal decisions | Failures/timeouts/mismatches | Median decision | Maximum |
| --- | --- | --- | --- | --- |
| gpt-6-luna / model-default | 6/6 | 0/0/0 | 3,533ms | 3,840ms |
| gpt-6.1-sol / low | 6/6 | 0/0/0 | 5,121ms | 9,160ms |

All six action classes matched; the first open was 150 chips for Luna, 125 for
Sol. On 9s8s / Ks7s2c, Luna incorrectly described a nut flush draw; Sol did
not make that wording error. One example does not establish strategic strength.
Sol was slower in this small sample.

A later `/3` checkpoint, after per-phase observation/disposal fixes but before
the final duplicate-argv tightening, **failed** (exit 3). Both actual probes
were observed with matching requested model/effort and passed containment. Luna
completed one legal open in 3,183ms. Sol's first warmup exceeded the comparison's
60s cap and returned CHILD_CLOSE_UNCONFIRMED after 62,005ms. The remaining ten
measurements were skipped. Final disposal then confirmed cleanup and removed
the temporary directory. Total elapsed: 84,940ms. The earlier `/1` capture is
not relabeled as a passing final `/3` report. One timeout does not establish
a root cause or stable availability. Production soft25s/hard300s and the
adapter's direct25s defaults are distinct from this comparison cap.

A separate actual temporary Luna/default session resumed through Sol/low and
returned a legal raise to 125; resume argv carried low. Both probes and final
cleanup passed. No existing game was resumed. Codex JSON streams do not attest
provider serving IDs; evidence covers requested/adapter/actual argv model and
effort. Catalog defaults are not proof of a server effort when unspecified.
No win-rate, EV, GTO, calibration or human-learning effect is established.

## Earlier failures and integration history

The initial whole run had 3,778 pass, 3 fail, 1 cancelled, 18 skip. Two failures
were temporary lobbies colliding with occupied port8899; both passed with an
ephemeral public port. A study-rotation fixture's 40ms auto-fold could advance
to hand2 during identity inspection. It now holds the observed user decision
open with the existing scaled30s fixture budget and keeps the hand1 assertion
and requestStop cleanup. The missing new source-suffix inventory entry was
also corrected without deleting existing inventory checks.

PR #294 merged independently during finalization. Task changes were preserved
in a named stash and binary diff, the branch fast-forwarded, and only actual
README/study mount conflicts were combined to retain both features. The
superseded running test group was identified by exact argv/cwd/process group,
stopped, and all observed processes confirmed dead. Its partial run is not a
passing result. The complete integrated run and final checks above supersede
that checkpoint. Raw local transcripts and browser artifacts remain outside
the repository; durable hashes are committed in the structured evidence.

## PR CI platform corrections

Initial PR run38865017268 on c930a46 completed with failure. Linux22 and
Windows20/22 rest exposed a new comparison-test bug: it resolved the child's
temporary cwd after the runner had removed it. macOS had hidden this through
an alias-prefix fallback that inspected os.tmpdir instead. The test now records
every actual fake-CLI child's reported cwd before forwarding its done promise,
canonicalizes all compared paths with realpathSync.native while alive, verifies
it is inside the owned temp root and outside the repo, then verifies both
reported and canonical paths are absent after cleanup. Runtime and comparison
production code do not change. Original model/effort, same-input, negative-gate
and cleanup assertions remain. Host comparison suite:28/28, exit0. Fresh
Opus/high PASS0.85 and Astra/high PASS0.95 independently reviewed these bytes.

Windows22 loop also hit SERVER_LISTENER_UNAVAILABLE in an unchanged bootstrap
listener probe before the target repair-bookkeeping assertion; Windows20 loop
passed the same SHA. Linux22's unchanged held-back pipeline test hit its120s
outer timeout; a targeted host run executed that one test and passed in2.489s.
Neither root cause is established, and no assertion or timeout is relaxed.
Linux20's complete job was cancelled at its40-minute cap near test3475.
Linux CI now splits the complete recursive test inventory into services/rest
per Node20/22, preserves the platform gate and15-minute per-file/40-minute job
caps, and tests exactly-once coverage including helper/browser/fixture modules.
All Windows shards remain intact. Final exact-SHA whole CI remains mandatory.
Failure log hashes and dispositions are retained in the structured evidence.

Linux partition review: Opus/high PASS_WITH_CHANGES0.80 identified required
check-name preservation, independently caught by the parent through the live
branch rules. The strict two-name aggregate fixes it without changing rules.
Astra/high PASS0.94 found no coverage issue. The final aggregate delta then
passed fresh Opus/high0.86 and Astra/high0.94 reviews. All receipts have confirmed
termination. Host CI/comparison/platform checks:75/75, exit0, no skips.
The parent separately compared the prior Linux TAP's53 auto-discovered
non-test modules with the new rest inventory: all retained. Current recursive
inventory297 = services28 + rest268 + GATE1. A tracked-file search found no
Node test-pattern file outside test/. Future tests must remain under test/ for
this runner; root-wide auto-discovery outside that tree is not claimed. Each
Linux version still executes the platform gate before both partitions. The
original required names succeed only when all four Linux partitions succeed.
Final PR CI now has25 jobs; its exact-SHA outcome is recorded on the PR after
completion rather than embedding an unexecuted success in this commit.
