# Runtime slice evidence

Scope: Codex player model/effort, adapter-local benchmark pin, opt-in comparison
CLI. Design decisions 1 and review findings F4–F6 in `coaching-quality-design.md`
and `coaching-quality-review.md`.

## Changed files

- `tools/player-runtime.js` — Codex player fallback `gpt-6.1-sol`, `playerArgs`
  `-c model_reasoning_effort="low"`, latest-family rule `{ player: 'sol', upper: 'sol' }`;
  validated `benchmarkPlayerPin` + `benchmarkPin` adapter option.
- `tools/compare-codex-players.js` (new) — bounded opt-in comparison CLI/runner. Corrective
  attempt: fail-closed verdict (`executionOk` / `complete` / `allDecisionsLegal`), schema
  `codex-player-comparison/2`, two spot labels fixed (see "Corrective attempt").
- `test/player-runtime.test.js` — updated obsolete Luna-player expectations, new
  low/medium purpose-based argv test, catalog "cannot revert to Luna" tests, pin tests.
- `test/codex-player-comparison.test.js` (new) — 20 fixture-runtime tests (13 originally;
  the corrective attempt updated the ones that expected `ok:true` for partial/invalid runs
  and added gate, exit-code, production-runner and spot-label tests).
- `test/learning-integration.test.js` — **not changed** (see limitations).

## Production behaviour

- `RUNTIME_TABLE.codex`: player/upper both `gpt-6.1-sol`; `playerArgs` low, `upperArgs`
  medium (unchanged). Player and upper now share a model id, so the tier is told apart
  by the effort argument (tests identify tiers by call order/stdin and effort, not id).
- `playerArgs` is read once per adapter and used by every player path: probe, resume-probe
  (grok only), warmup/create, decide/resume, and `oneshotStart({tier:'player'})`.
  Effort is a global option placed before `exec` (create/probe/oneshot) or before `-m`
  (resume), exactly once.
- Catalog selection looks for the newest `sol` for both tiers. A catalog that lists only
  (newer) Luna entries yields `error:NO_MATCH` and the Sol fallback; the player cannot be
  silently reverted to Luna. `latestCodexModel(…, 'luna')` and its generic tests are kept.
- When a catalog Sol id fails before verification, `useFallbackModel` moves both tiers
  together (`replaced` reports both), and the retried player call still carries low.
- Short learning explanation (`oneshotStart({tier:'upper', reasoning:'model-default'})`)
  still sends no effort argument — existing test kept unchanged.
- Loop budget unchanged: soft 25 s / hard 300 s (`shared/player-budget.js`); the adapter's
  direct `decide` default stays 25 s (`RUNTIME_TABLE.codex.watchdog.t1Ms`). The comparison
  uses `--timeout-ms` as a per-call cap and labels the 25 s soft line.

### Benchmark pin (why a small runtime option was needed)

The comparison must run the old Luna/model-default next to Sol/low through the real
adapter (no-tool probe, warmup, resume). The catalog can no longer choose Luna and
`playerArgs` has no model-default form, so without a runtime hook the only option would be
rewriting argv, which the design forbids. `benchmarkPlayerPin(kind, {model, effort})`:

- closed allowlists: models `gpt-6-luna`, `gpt-6.1-sol` (codex only); efforts
  `model-default`, `low`, `medium`; exactly those two keys;
- returns a frozen object registered in a module-private `WeakSet`; `createPlayerRuntime`
  accepts `opts.benchmarkPin` only if that object came from the validator and its `kind`
  matches. Plain objects, spread/structured clones, strings and other-runtime pins throw
  `BAD_BENCHMARK_PIN` before any spawn;
- applies to the **player tier only**: skips the catalog for the player (no extra catalog
  call), `models.source.player === 'pinned'`, never swapped by the fallback retry. Upper
  tier, catalog and containment argv are unchanged;
- it is not wired into `resolveRuntimes`, the loop, the app or any CLI flag.

## Comparison CLI

`node tools/compare-codex-players.js [--live] [--samples N] [--rounds N] [--timeout-ms N] [--warmup-timeout-ms N] [--decide-timeout-ms N] [--budget-ms N] [--json]`

(Usage as of #297; the flags added there are described in "#297: CLI child process groups and lifecycle timelines" below.)

- Without `--live` it prints the plan and spawns nothing. No store/model flags exist
  (`--store-dir`, `--game-dir`, `--model` are rejected with usage, exit 2).
- Defaults: 6 spots, 60 s per call, 15 min total. Caps: 8 spots, 300 s per call, 60 min total.
  Max calls = 2 × (1 probe + 2 × samples) = 26 at default. A call is only started if the
  remaining budget covers a full per-call timeout, otherwise the sample is `skipped
  (BUDGET_EXHAUSTED)`.
- Spots: 8 engine-generated 3-handed 100BB situations (6 default: BTN open, BB vs open,
  BTN vs 3-bet, flop vs bet, turn vs bet, river vs overbet; extras: flop checked-to,
  12 BB shove). Messages come from the real `turnSummary`; the identical string goes to
  both variants. The hero's own cards are the only hole cards in the text. Labels are only
  report text — the model sees `message` alone.
- Each variant uses a temp cwd + fresh canary under `os.tmpdir()`, a real
  `createPlayerRuntime('codex', …)` with the pin, and an `exec` wrapper that only *records*
  argv before delegating to `spawnCli` (observation for mismatch reporting, no rewriting).
  Calls are sequential; variant order alternates per spot.
- Report per sample: requested model/effort, adapter-resolved model, observed argv
  model/effort, `legal`, action, amount, normalised reason, status
  (`ok|invalid|timeout|failed|termination_unconfirmed|skipped`), error code/phase, warmup
  and decide latency. Per variant: counts, decide-latency observations (+median/min/max,
  number over 25 s). Cross-variant: same-action count over spots where both were legal.
  `mismatches` lists any call whose argv model/effort or adapter model differs from the
  request; any mismatch makes `executionOk=false` and so `ok=false` (exit 3).
- Verdict (`ok = executionOk && complete && allDecisionsLegal`, details in "Corrective
  attempt"). Only a complete run whose every response was legal exits 0; everything else
  that actually ran exits 3 with the reasons on stderr (stdout stays pure JSON with `--json`).
- Timeouts: the adapter kills the child and confirms close before rejecting `TIMEOUT`; this
  is recorded as `timeout` data (kept as an observation) and the run continues, but the
  comparison is then `complete=false` and not `ok`. If termination cannot be confirmed
  (`CHILD_SIGNAL_FAILED`/`CHILD_CLOSE_UNCONFIRMED`) the run aborts immediately (no further
  children), every adapter is still disposed (one retry), and the temp dir is **kept** and
  reported. Adapter-creation failure disposes what exists and removes the temp dir.
- The report states: no win-rate, EV, GTO or strategy-superiority inference; small sample;
  codex streams expose no served-model id (only argv/adapter values are compared). Raw
  prompts, snapshots and model output are not in the report.
- The parent runs the live comparison; this slice did not.
- Exit codes: `0` complete and all legal (`ok`), `3` executed but incomplete/invalid/
  unavailable/unsafe (`ok=false`), `2` argument error, `1` runner error.

## RED → GREEN

RED (test edits first, production untouched): `node --test --test-concurrency=1
test/player-runtime.test.js` → 134 tests, 18 failing: the 15 intended
(`RUNTIME_TABLE`, `LATEST_MODEL_RULES`, codex create/resume argv, probe argv, catalog
selection ×2, catalog failure/Luna-only, fallback retry, fallback-both-fail, leak,
re-resolution, unconfirmed catalog child notice, catalog timeout, upper fallback, the new
purpose-based low/medium test) plus 3 environment failures (below). Example RED message:
`두 tier는 같은 모델 id다  2 !== 1` (player still Luna while upper Sol).

GREEN after the production change: 131/134 pass, only the 3 environment failures remain.
Then 5 pin tests added (all pass). Combined run
`node --test --test-concurrency=1 test/player-runtime.test.js test/codex-player-comparison.test.js`:
152 tests, 149 pass, 3 fail (the same 3).

Mutation checks (production/tool temporarily broken, restored byte-identical, `cmp` ok):

| Mutant | Result |
| --- | --- |
| pin model not applied | 2 pin tests fail |
| forged pins accepted | forgery test fails |
| catalog read for pinned player | 2 tests fail |
| player oneshot drops effort | failures rise from the 3 environment ones to 6 |
| comparison variants not alternated | 1 fails |
| mismatch hidden | 1 fails |
| unconfirmed termination treated as plain failure | 1 fails |
| different message per variant | 1 fails |
| timeout recorded as `failed` | 1 fails |
| temp dir deleted even if dispose unconfirmed | 1 fails |

`codex-player-comparison.test.js` (20 tests, ~16 s after the corrective attempt; the list below is the original 13-test coverage, whose `ok` expectations the corrective attempt tightened) covers: option caps; plan call count;
snapshot validity/variety/hidden-card containment; identical stdin and containment argv
across variants with exactly one model/effort per variant; invalid (out-of-range) response;
model/effort mismatch reporting + exit code 3; timeout with kill confirmed and pid gone;
unconfirmed termination abort + disposal of both adapters + kept temp dir; adapter-creation
failure cleanup; budget exhaustion with zero spawns; failed canary probe skips samples;
failed CLI call; dry-run without `--live`; rejected store/model flags; `--live` summary.
All use `test/helpers/fake-cli.js`; no network, no real `codex`, no stores.

## Corrective attempt: fail-closed verdict and label fixes

Edited only `tools/compare-codex-players.js`, `test/codex-player-comparison.test.js` and
this file. Production runtime (`tools/player-runtime.js`), model, effort and containment are
untouched.

### Defect

The parent reproduced, with the **production** runner and only an injected clock
(`runComparison({samples:1,timeoutMs:250,budgetMs:250},{now:()=>tick+=1000})`), `ok:true`
with `comparedSpots:0`, both probes `false` and every sample `skipped`. `ok` had been
defined as "no abort, no mismatch, cleanup fine", so a run that measured nothing, or only
timed out / failed / answered illegally, was reported as success and exited 0.

### Contract now

| Field | Meaning (report top level; each variant also has `gates: {complete, allDecisionsLegal}`) |
| --- | --- |
| `executionOk` | The harness ran safely: no unconfirmed child termination / abort, no call whose argv or adapter model/effort differs from the request, every adapter disposed, temp dir removed. |
| `complete` | Every variant's probe passed (ok + containment) and **every requested sample produced a response** (`ok` or `invalid`): no `skipped`, `timeout`, `failed` or `termination_unconfirmed`. |
| `allDecisionsLegal` | Every variant obtained at least one response and none was illegal. "No response at all" is **not** vacuously legal. |
| `ok` | `executionOk && complete && allDecisionsLegal`. |
| `failures` | `[{gate, variant, code, detail?}]`: `TERMINATION_UNCONFIRMED`, `MODEL_MISMATCH`, `DISPOSE_UNCONFIRMED`, `TMP_NOT_REMOVED`, `PROBE_NOT_PASSED`, `SKIPPED`, `TIMEOUT`, `CALL_FAILED`, `MEASUREMENTS_MISSING`, `ILLEGAL_DECISION`, `NO_DECISIONS_OBSERVED`. Empty iff `ok`. |

Invalid / timeout / failed / skipped samples stay in the report as observations (status,
error code/phase, latency, rejection detail); they just no longer count as a pass. A canary
probe refusal or an exhausted budget is `complete=false`, not an `executionOk` failure,
because the harness itself behaved. `ok=true` is worded as "complete and all legal", never
as production readiness; a caveat says so. The schema string is now
`codex-player-comparison/2` because the meaning of `ok` tightened and fields were added.

CLI: exit `3` whenever `ok=false`, human report ends with `판정: 불합격(ok=false) …` plus one
line per failure, stderr gets `비교 불합격(ok=false): …` (also in `--json` mode); exit `0`
prints `판정: 완전·전부 합법(ok)`.

### Spot labels

Checked against the actual cards (the message text, not the script):

- `flop-facing-bet-bb`: 9s8s on Ks7s2c = four spades (flush draw) plus 9-8-7 (two more
  cards needed, so only a **backdoor** straight possibility; `현재 메이드: 하이 카드`).
  Label was "플러시·스트레이트 드로" → "플러시 드로와 백도어 스트레이트 가능성".
- `flop-checked-to-bb`: QdJd on 7h6d2s = three diamonds (hero holds two), i.e. a
  **backdoor** flush, not a four-card draw. Label was "플러시 드로" → "QJ 수딧,
  다이아몬드 백도어 플러시 가능성".
- `turn-facing-bet-btn` (Ac5c on 9c6d2hKc: four clubs, nut flush draw) and the others were
  re-checked and are accurate.

A test derives flush / backdoor-flush / straight-draw / backdoor-straight facts from each
spot's message and rejects any label claiming a draw the cards do not support.

### RED → GREEN

RED (tests changed first, tool untouched): `node --test --test-concurrency=1
test/codex-player-comparison.test.js` → 20 tests, **15 failed, 5 passed**. The parent's
repro test failed with `측정을 하나도 얻지 못한 비교는 합격이 아니다  actual: true, expected: false`
(the production runner, injected clock only, `exec` that throws if anything is spawned —
nothing was spawned, `ok` was `true`); the label test failed on the old labels; the other
failures were the missing `executionOk/complete/allDecisionsLegal/failures/gates`, schema
`/2`, verdict text and exit code expectations.

GREEN after the change: 20/20 (~16 s). With the runtime suite
(`test/player-runtime.test.js test/codex-player-comparison.test.js`): 159 tests, 156 pass,
3 fail — the same three sandbox failures as before (`ps` is blocked here, process start-time
identity is `null`: `oneshotStart: pid·startTime…`, `oneshotStart: done 타임아웃…`,
`terminate: kill이 false…`). They are in `player-runtime.test.js`, which this attempt did
not touch; the parent reported 152/152 for the host run outside the sandbox.

Mutation checks (tool temporarily mutated, restored byte-identical, `cmp` ok):

| Mutant | Result (comparison file) |
| --- | --- |
| `ok` ignores `complete` | 4 fail |
| `ok` ignores `allDecisionsLegal` | 2 fail |
| `ok` ignores `executionOk` | 2 fail |
| "no response" counts as legal (vacuous) | 4 fail |
| `complete` ignores probe / skipped | 5 fail |
| CLI exits 0 when `ok=false` | 6 fail |
| old flop label restored | 1 fail |
| old checked-to label restored | 1 fail |

Tests added or changed (all fixture runtime / temp dirs, no network, no real `codex`, no
stores; no leftover temp directories afterwards):

- production runner with injected clock only (the parent's repro) → `ok=false`,
  `executionOk=true`, `complete=false`, `allDecisionsLegal=false`, zero spawns, temp dir
  removed; the same input through the CLI → exit 3, JSON gates, stderr reason;
- budget-exhausted fixture run, failed canary probe, failed CLI call, timeout, illegal
  amount, model mismatch, unconfirmed termination: each asserts the exact gate triple and
  `failures` codes (previously these asserted `ok:true`; every diagnostic assertion kept);
- an all-legal complete run → all gates true, `failures` empty;
- CLI exit tests: success → 0 with empty stderr and no readiness wording; illegal /
  timeout / failed call / probe refusal / model mismatch → 3 with reasons on stderr, both
  `--json` and text modes;
- spot-label facts test.

### Saved live report

The parent's live run (`/private/tmp/holdem-coaching-quality/codex-comparison-live.json`,
schema `/1`, 6 spots, 124 s) was not rerun. Read offline, its fields satisfy all three new
gates: both probes passed, 6 legal of 6 per variant, zero invalid/timeout/failed/skipped/
unconfirmed, zero mismatches, cleanup confirmed, 6/6 same action. It predates the new
fields (`executionOk`, `complete`, `allDecisionsLegal`, `failures`, `gates`) and carries the
two inaccurate spot labels; the model inputs of that run were unaffected because labels are
not part of the prompt. Rerun the live comparison to obtain a `/2` report.

## Corrective attempt 2: observed child argv per phase, probe verification, disposal

Review `comparison-r1-review.txt` (PASS_WITH_CHANGES, three findings, all accepted). Edited only
`tools/compare-codex-players.js`, `test/codex-player-comparison.test.js` and this file.
`tools/player-runtime.js` is untouched; no provider calls were made.

### Findings and fixes

| # | Finding | Fix |
| --- | --- | --- |
| 1 | Probe argv was logged but never checked; a runtime bug could probe with another model/effort and the report still be `ok`. | The probe phase is observed like a sample: `probe.observedCalls`, `argvModel`, `argvEffort`, `mismatch`, `verified`, `unverified` (`NOT_RUN` / `PROBE_FAILED` / `NO_CHILD_OBSERVED` / `MODEL_MISMATCH`). `summary.probeOk` is `probe.verified`, so a probe mismatch fails `complete` (`PROBE_NOT_PASSED`, detail = reason) and `executionOk` (`MODEL_MISMATCH`, counted with the sample mismatches). `report.mismatches` entries carry `phase: 'probe' \| 'sample'`. |
| 2 | A warmup/decide call that spawned nothing counted as matching when `adapter.models.player` matched. | Each sample records `observedCalls: {warmup, decide}` (`null` = phase not run) and `unobservedPhases`. A phase that ran but emitted zero argv makes the sample `status: 'unobserved'`, `legal: false`, `errorCode: NO_CHILD_OBSERVED`, `errorPhase` = first silent phase; it is not counted in `legal`/`invalid`. Failures: `executionOk NO_CHILD_OBSERVED {samples, phases}` and `complete NO_CHILD_OBSERVED n`. Phases that failed/timed out before spawning keep their own diagnostic (the sample is already non-success) and still add `executionOk NO_CHILD_OBSERVED`. A probe that spawned nothing fails `executionOk NO_CHILD_OBSERVED 'probe'` and the variant's samples are skipped with `PROBE_UNOBSERVED` (containment was never shown by a real child, so no further children for that variant). The adapter-reported model never substitutes for observed argv. |
| 3 | A synchronous `dispose()` throw escaped `runs.map`, skipping the other adapters and the report. | Each dispose is called inside `Promise.resolve().then(...)`; all adapters are attempted (and retried once), the thrown error lands in `cleanup.errors` with its code, the temp dir is retained (`cleanup.tmp`) and the report comes back fail-closed (`DISPOSE_UNCONFIRMED` + `TMP_NOT_REMOVED`, exit 3) instead of a rejection (exit 1). |

Schema is now `codex-player-comparison/3` (new probe/sample fields, new sample status
`unobserved`, `mismatches[].phase`). Human report: `probe 통과(argv N회 확인)` /
`probe 미통과(REASON[: notice])`, counts line gains `미관측 n`.

Side effect worth knowing: an adapter **without** the benchmark pin spawns a catalog child
(`codex debug models`, no `-m`) during the probe. Under per-phase probe verification that child is
reported as a probe mismatch (`argvModels: [null, …]`) for both variants, including Sol/low whose
sample calls match. That is intentional: a child the comparison did not request ran in the probe
phase, and the report says so rather than filtering `-m`-less argv (which would also hide a model
call that silently fell back to the account default). The pinned production path spawns no
catalog child, so the all-legal run is unaffected (asserted: no `debug` argv).

### Tests (`test/codex-player-comparison.test.js`, 25 tests, ~14 s)

Added:

- a scripted no-spawn adapter helper that, like the real adapter, passes argv to `opts.exec` per
  phase, so each scenario controls exactly which phase claims to have spawned what. `exec` is a
  stub (no child). Positive control: the honest script yields all three gates true, `ok`, and
  exactly `2 × (1 + 2 × samples)` observed argv — so the negative tests below are not vacuous;
- probe argv with wrong model (Luna→Sol) and wrong effort (low→medium): adapter claims
  `ok/containment`, samples match, yet `executionOk=false`, `complete=false`, `ok=false`;
  `probe.unverified='MODEL_MISMATCH'`, `mismatches` has two `phase:'probe'` entries;
- probe spawns nothing: `NO_CHILD_OBSERVED 'probe'`, `PROBE_NOT_PASSED NO_CHILD_OBSERVED`,
  samples `skipped(PROBE_UNOBSERVED)`, warmup never called for that variant, other variant complete;
- warmup silent (luna) / decide silent (sol): samples `unobserved`, `legal=0`,
  `observedCalls {warmup:0,decide:1}` / `{1,0}`, gates all false, CLI exit 3 with
  `NO_CHILD_OBSERVED` on stderr; adapter model equals the request and does not rescue it;
- synchronous `dispose()` throw on the first adapter (real adapter + fake CLI): report returned,
  second adapter disposed, thrower retried, `cleanup.errors=[{luna-default, DISPOSE_SYNC_THROW}]`,
  temp dir retained and reported, gates `{false,true,true}`, CLI exit 3.

Changed (tightened, no diagnostic assertion removed): the all-legal run also asserts
`probe.verified/observedCalls/argvModel` and `observedCalls {1,1}` per sample; the ignored-pin
test now expects `complete=false` and `PROBE_NOT_PASSED` for both variants, luna mismatch detail
3 (probe + 2 samples), sol probe mismatch from the catalog child, 4 mismatches in the text report;
schema `/3`.

### RED → GREEN

RED (tests edited first, tool at the r1 state): `node --test --test-concurrency=1
test/codex-player-comparison.test.js` → 25 tests, **7 failed, 18 passed**
(`/private/tmp/holdem-coaching-quality/compare-r2-red.log`). Behavioural RED messages:

- wrong probe model/effort: `actual {executionOk:true, complete:true, allDecisionsLegal:true}`,
  expected `{false,false,true}`;
- silent probe: `actual {true,true,true}`, expected `{false,false,false}`;
- silent warmup/decide: `actual {true,true,true}`, expected `{false,false,false}`;
- synchronous dispose throw: `runComparison` rejected with `Error: sync boom` from
  `disposeAll → runs.map` (no report);
- ignored-pin: `complete` was `true`; all-legal: schema `/2`; control: probe fields undefined.

GREEN after the fix: **25/25** (`compare-r2-green.log`), zero `ai-holdem-compare-*` or
`holdem-compare-test-*` directories left in the temp root.

Mutation checks (tool mutated, tests run, restored byte-identical, `cmp` ok):

| Mutant | Result |
| --- | --- |
| probe `verified` := adapter `ok && containment` (argv not checked) | 3 fail |
| unobserved phases never demote a sample | 1 fail |
| dispose not wrapped in a promise | 1 fail |
| probe `NO_CHILD_OBSERVED` not an `executionOk` failure | 1 fail |
| unobserved probe still runs samples | 1 fail |

Not run here: the full suite, `player-runtime.test.js` (not touched by this attempt), any live
comparison. The saved live report (`codex-comparison-live.json`, schema `/1`) predates probe and
per-phase observation fields; a `/3` report needs a rerun by the parent.

## Limitations and open items

- **`ps` is blocked in this sandbox**, so process start-time identity is `null`. Three
  pre-existing `player-runtime.test.js` tests fail here with and without this change
  (`oneshotStart: pid·startTime…`, `oneshotStart: done 타임아웃…`, `terminate: kill이
  false…`); confirmed by running the HEAD archive: 134 tests, the same 3 failures.
- `test/learning-integration.test.js` `S8 early` CLI tests (3) fail here with
  `IDENTITY_UNAVAILABLE` for the same reason, so they could not be executed. By static
  reading no expectation is obsolete: the codex assertions use
  `RUNTIME_TABLE.codex.player` (now `gpt-6.1-sol`), and the failing catalog fixture
  still ends with the Sol fallback. I did not edit that file; please run those tests where
  `ps` works. The other 16 `S8 early` tests pass.
- The full suite, `game-loop.test.js` and other files that mock codex were not run (not
  allowed / over budget); a search of `test/` for codex model ids, `RUNTIME_TABLE`, `playerArgs` and effort
  strings found only `player-runtime.test.js`, `learning-integration.test.js` and string/data
  fixtures in `game-loop.test.js` and `notice-projection.test.js`.
- A real Luna request depends on the account still serving `gpt-6-luna`; a refusal shows up
  as a failed probe with the variant skipped, not as a silent fallback.
- `ok` is an observation gate, not a quality or readiness certificate: it says nothing about
  win rate, EV, GTO or which model plays better. Timeouts at a given `--timeout-ms` make a run
  incomplete even though they are useful latency data; rerun with a larger cap if a complete
  comparison is required.
- A budget smaller than the worst case (`maxModelCalls × timeoutMs`) can legitimately skip
  calls; that run is reported incomplete (exit 3) rather than silently partial.
- Latency is a list of single observations per spot; no percentile or safety claim.
  Variants run sequentially so provider load drift is not controlled beyond alternating order.
- The pin allowlist is hard-coded; retiring either model id needs an edit and test.

## Parent round-2 edge corrections

The next independent review found two additional false-observation cases.
Parent reproduced synchronous executor failure being counted as a child and
a later `--model` flag being ignored. Logging now follows successful executor
return and requires a positive PID. Missing/zero PID or a synchronous throw
leaves no observed child. All model and effort occurrences are parsed across
short, long and config forms; duplicate occurrences fail closed, and mismatch
evidence retains their exact parsed values. Fixture executors explicitly
return synthetic positive PIDs; those tests are orchestration controls, not
actual provider execution. Final comparison tests: 28/28. No production runtime
adapter changed in these parent corrections.

The subsequent actual schema /3 checkpoint did NOT pass: both probes were
verified, Luna produced one legal decision, and Sol's first warmup exceeded
60 seconds before child close was initially unconfirmed. Final disposal then
confirmed cleanup. See coaching-quality-validation.md for the complete
observation and the separate earlier six-spot result. Do not infer readiness
from the earlier schema /1 success or from fixture tests.

## #297: CLI child process groups and lifecycle timelines

The installed `codex` command is the npm launcher (`@openai/codex/bin/codex.js`). It runs
the platform binary as a child with inherited stdio, forwards only SIGINT/SIGTERM/SIGHUP,
and waits for that child. A SIGKILL sent only to the launcher pid therefore leaves the
binary running its request while it holds the adapter's stdout/stderr pipes. The adapter's
close confirmation (`killWaitMs`, 2 s) then fails with `CHILD_CLOSE_UNCONFIRMED`, and a
later disposal succeeds once the binary finishes on its own.

Observed directly on codex-cli 0.163.0: signalling the launcher 1.5 s after
`turn.started` gave exit +1 ms but close +11.4 s. The binary completed its turn. The same
probe with SIGTERM, or with a process-group SIGKILL, closed in under 10 ms. The historical
`/3` checkpoint above is consistent with this mechanism, but its process tree was not
recorded, so the match remains a hypothesis rather than an observation.

### Runtime change (`spawnCli`)

- POSIX: each CLI child is spawned `detached` (its own session and process group, pgid =
  pid). argv, env and cwd are unchanged.
- `kill(signal)` sends to the group (`-pid`) only while the direct child's exit has not been
  reported. That pid is then still this process's unreaped child, so no other group can
  carry that number.
  - Once the exit is reported, it falls back to `ChildProcess.kill`, which sends nothing
    and returns `false`.
  - ESRCH from the group returns `false` without a numeric-pid retry.
  - Any other error falls back to the direct child's handle.
- Every adapter path benefits, because each one goes through this `kill`: timeout and user
  interrupt (`runOnce`), disposal, and coach `terminate()` (SIGTERM, then SIGKILL).
- Residual cases stay unconfirmed instead of being forced. A descendant that left the group
  (setsid) cannot be reached. Neither can a same-group descendant that is still holding
  stdio after the direct child exited. Both are pinned by tests, and the disposal retry
  confirms them once they close.
- Residual risk:
  - The #255 S4 window (reaped but not yet reported) has the same length as before. If the
    number is reused as a new group leader inside it, though, that whole group is signalled
    instead of one pid.
  - A parent killed with SIGKILL still leaves CLI children running until they finish.
- Windows is unchanged and not verified for this launcher shape. It would need launcher
  resolution plus an owned Job object. Recorded-pid signal paths (coach recovery in
  `game-loop.js`) still signal the recorded pid.
- The app service was already detached, so production CLI children already ran without a
  controlling terminal.

### Comparison tool, schema `codex-player-comparison/4`

- **New options:**
  - `--rounds N` (1–8) repeats the spot list, so samples = spots × rounds. The order
    alternates by sample index, and the denominators use spots × rounds.
  - `--warmup-timeout-ms`/`--decide-timeout-ms` default to `--timeout-ms`, which stays the
    probe cap. This lets one tool reproduce production caps (warmup 120 s, decide hard
    300 s) or force short caps.
- **`budgetMs`** is a call-start budget. A phase starts only if the remaining budget covers
  that phase's cap. Termination confirmation and disposal come on top. All durations use a
  monotonic clock.
- **Per-child timelines** (`probe.timelines`, `samples[].timelines.{warmup,decide}`):
  - Recorded per child: spawn offset, first stdout, JSONL event names from a closed
    allow-list (unknown names become `other`, non-JSON lines become `nonjson`), kills
    (time, signal, delivered), exit (code/signal) and close.
  - Bounds: at most 64 names are kept (`eventsDropped` counts the rest), and lines over
    64 KiB are counted in `oversizeLines` without being parsed.
  - Error-class events carry only a closed class (`reconnect`, `rate_limit`,
    `code_mode_unavailable`, `timeout`, `other`), never the message.
  - Derived values are CLI-observed proxies, not provider measurements: `bootMs`,
    `threadToTurnMs`, `turnMs`, `censored` with `turnObservedMs`, `lastEventToSignalMs`,
    `signalToExitMs`, `signalToCloseMs` and `exitToCloseMs`.
  - Timelines are rendered after disposal, so a late close shows its real time.
- **Other new report fields:** `cleanup.attempts[]` (start, duration, open children,
  errors per attempt), `samples[].errorDetails` (purpose, signal, waitBudgetMs, waitedMs,
  closeConfirmed), `summary.phases.{warmup,decide}` (planned, attempted, answered, timeout,
  failed, interrupted, terminationUnconfirmed, skipped), `summary.warmupMs` (including
  `cold` for the first create of the variant), `environment` (Node, platform, loadavg) and
  `startedAtIso`.
- **Raw-text rule:** the no-raw-text rule covers these diagnostic fields. The normalised
  one-line `reason` per legal sample stays as before.
- **Signals:** SIGINT/SIGTERM during `--live` stops new calls and interrupts the in-flight
  call through the adapter's confirmed-close path. Disposal still runs, and the report is
  printed as incomplete (`aborted.code: STOPPED`, `complete` gate, exit 3). A second
  signal takes the default action.
- **Gates:** `ok` and the three gates keep their meaning. The new fields are observations
  and do not relax any gate.

Fixture evidence (`test/player-runtime.test.js`, `test/codex-player-comparison.test.js`,
`test/game-loop.test.js`, names prefixed `#297`):

- The launcher-shaped fake CLI (`wrapper: true`) reproduces the original signature on the
  pinned base `912de13`:
  - decide timeout and interrupt end in `CHILD_CLOSE_UNCONFIRMED`;
  - coach terminate ends in `CLOSE_UNSETTLED`;
  - the game loop's interrupt is not confirmed (`{interrupted:false}`).
- The same tests pass with the change. The residual boundaries are pinned with an explicit
  holder release instead of timing.

