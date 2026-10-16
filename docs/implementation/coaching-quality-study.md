# Study next-step slice (learning slice, plan item 5)

## Changed files

- `server/drill-public/study-format.js`: pure `planNextStep`, `nextStepGate`, `nextStepView`, `unfinishedRun`, `coverageGuidance`, `completionGuidance`, `spotKeyVersion`.
- `server/drill-public/drill.js`: next-step card painter, one explicit click handler, `controller.start(selectors, { protectUnfinished })`; a protected start puts `protectUnfinished: true` in the request body, and `UNFINISHED_RUN` (409) is a definitive start rejection (clears the captured request, restores the server's session).
- `tools/drill-cli.js` (`startDrill`) and `tools/drill-server.js`: the protected-start condition, enforced under the existing drill lock (review R3, below); new client error `UNFINISHED_RUN` (409); `protectUnfinished` is a validated boolean on the wire (`START_FIELDS`) and in the library.
- `server/drill-public/drill.html`, `drill.css`: the `#next-step` card.
- `server/public/lobby.js`: `OPPONENT_HELP` text only.
- `test/study-next-step.test.js` (new, 33 tests), `test/browser/coaching-study-journey.mjs` (new).
- `.github/workflows/test.yml`: one step added to the existing `ui-browser` job.
- `README.md`, `README.ko.md`: brief Codex Sol/low, coaching and study limitation notes.
- `test/study-format.test.js` was not changed; no existing test was edited or weakened.

## Behaviour

Priority, derived from the raw `/api/summary` counts and identities (never formatted strings):

1. `bank.dueCount` a non-negative safe integer > 0 and `summary.source` a known reference (id, version and hash all match): `daily` with `{mode, source}` where source is the summary source, hash included.
2. A completed assessment with `retest.eligible === true` exactly, no `reason`, a known source identity, no parent `assessmentId`: `retest` with `{mode: 'retest', assessmentId}` only. No source selector; the server derives the source. Several eligible: the most recently completed one, ranked only by a canonical ISO `completedAt` (the form `toISOString` writes; same test as `validIso` in `training/study-history.js`). An eligible run whose `completedAt` is missing, not a string or not canonical is skipped, never ranked (review F4: `NaN` compares false both ways and used to win); if none has a valid date no retest is offered. An ineligible one with a valid `nextAvailableAt` only adds a note.
3. `goal.origin` of `game`/`practice` whose `sourceIdentity` equals the summary source, whose spot key version suffix matches that source version, and whose key and hand class pass the same patterns as `readStudyEntry`: `free` with `spotKey`, `handClass`, `source`. A default goal is never a target.
4. Otherwise `assessment` with `{mode, source}`.
5. Without a known summary source and without a retest: kind `none`, no selectors, nothing is offered.

Not done on purpose: transfer is never offered, because nothing in the summary proves it has questions; `daily` and free practice text says the server rechecks at start and may return no questions.

Labels separate "연습" (not a measured run) from "측정" (assessment and retest are the only runs that reach the trends).

Gating (`nextStepGate`), evaluated from the controller state on every `render` and on every summary repaint: unauthenticated, busy, recovery or pending, `replacementOnly`, or any unfinished run of any of the seven modes, including a completed run whose last answer is not yet acknowledged (`awaitNext`). A failed or in-flight summary read clears the summary, so a stale offer is never actionable. The click handler recomputes the view from the current state, and the controller refuses the same cases (`protectUnfinished`). The main 연습 시작 button keeps its existing explicit replacement behaviour.

### Server-enforced protected start (review R3)

A tab's cached state can be stale: with two idle study tabs, a run started in A left B's enabled next-step button free to post an ordinary start and replace A's unfinished run. The client gate cannot prevent that, so every next-step request now carries `protectUnfinished: true` and `startDrill` decides atomically under the drill lock (`DRILL_LOCK`), in this order:

1. input shape: `protectUnfinished` must be a boolean (`USAGE`/400 otherwise, also on the wire), checked before the lock and before any read;
2. the stored session cannot be read or is not an object: `UNFINISHED_RUN` (fail closed; an unparseable file is not provably finished). A missing file is simply no session;
3. the existing proof (`committedProof`) and pending checks run unchanged, so a corrupt, inconsistent or pending session is still refused with its own `PENDING_UNRESOLVED`/`SOURCE_CHANGED` code;
4. the idempotent replay (same `idempotencyKey`) returns the run that request created, before the guard, so a lost response to a protected start can be retried without the guard rejecting its own run;
5. the guard: a run is replaceable only if it is provably finished (`queue` is a list, `index` is a safe integer equal to `queue.length`, no pending answer). Anything else, including the retired-source unanswered question that an ordinary start deliberately replaces, is `UNFINISHED_RUN` (409). Nothing is written before the guard; a refused start leaves the session file byte-identical.

The ordinary 연습 시작 button sends no condition (and `false` means the same), so deliberate replacement, including of a legacy or retired-source session, is unchanged. A finished run, or a run with no questions, is replaceable by a protected start. Client side, `UNFINISHED_RUN` is in `START_REJECTIONS`, so the rejected request is cleared (no endless retry), `/api/current` is read to show the server's session, and the status line explains it (`formatStudyError`). A run finished in another tab but not yet acknowledged there is finished for the server and is replaceable: the server has no acknowledgement state.

Completion guidance (finished, acknowledged, non-empty run) suggests a variation and a delayed retest as text. Two buttons only select the mode in the picker; nothing is posted.

Sparse coverage: when `game.coverage.exactComparableDecisions` is 0 or under half of the evaluated decisions (or there are none), the card explains it and suggests fixed 100BB cash training, stating it does not guarantee coverage, comparable examples, or improvement. Legacy coverage layouts, strings, negative, fractional or `exact > evaluated` counts make no claim.

Existing target/source behaviour and the chart-exposure exclusions are untouched; the assessment text reuses `STUDY_MODE_HELP.assessment`, which already states the 7-day chart exclusion. Lobby help now says policy v3's river raises are value-only (no bluff raises) and that LLM bluff and persona frequencies are uncalibrated.

## RED, then GREEN

- RED 1: `node --test --test-concurrency=1 test/study-next-step.test.js` before any production change: the file failed to load (`planNextStep` and the other exports did not exist).
- RED 2: after adding only the pure functions, 18 of 21 tests passed and the three that exercise the missing behaviour failed with the expected reasons: protected start replaced an unfinished run in all modes (`free` first), a legacy replacement-only session was replaced, and lobby help lacked the river-raise/uncalibrated wording. The dispatch tests passed already because the controller spreads explicit selectors after its URL target; they are kept as regression guards.
- GREEN: after `protectUnfinished` and the `OPPONENT_HELP` text, 21/21; with the page-contract, fixture-server and journey self-test tests, 24/24.

## Results

`node --test --test-concurrency=1` over `test/study-next-step.test.js test/study-format.test.js test/reference-coverage-release.test.js test/ui-token-usage.test.js test/journey-contract.test.js test/drill-server.test.js`: 111 tests, 111 pass, about 7.5 s. `journey-contract.test.js` also discovered and passed the new journey's structure, self-test and CI-wiring checks.

Also run: `test/ui-assets.test.js` and `test/gto-minors.test.js`. Two tests there fail with `IDENTITY_UNAVAILABLE` from `engine/state.js` because `ps` is denied in this sandbox (`operation not permitted: ps`); they start app-service and loop locks, do not touch these files, and were not changed by this slice. They need rerunning where `ps` works. The full suite was not run, as instructed.

## Browser journey

`test/browser/coaching-study-journey.mjs` serves the real page assets through the production `createDrillHandler` over an empty temp workspace and scripts `/api/*` in process, so every state is exact and no store is read. It checks: no POST on load, sparse-coverage text, a 390px layout, the busy gate and a forced click during an in-flight start, the exact daily body, the unfinished gate across a summary rerender with a different offer, completion guidance after acknowledging the last answer, mode-only choice buttons, the exact retest body (`assessmentId`, no source), the targeted practice body, a hash-mismatched source, and the recovery gate. CI runs it in the existing `ui-browser` job with `--out-dir output/playwright/ui-journey/coaching-study`.

Review R3 added a rendered check, `next-step-stale-tab-guard` (step 9): the page loads idle with an enabled card, the scripted server then opens a run as another tab would, the click posts a protected start, the scripted server (which mirrors the real guard) refuses with `UNFINISHED_RUN`, and the page shows the other run with the card gated and the status explaining. The exact-body checks now include `protectUnfinished` (daily, retest, targeted practice). The guarantee itself is proven by the two-controller test over the real server below, not by this scripted check.

Not executed here: per instructions no live browser was run. Executed instead: the module's node-level fixture-server test, the HTML-id contract test (every `$('id')` in `drill.js` exists in `drill.html`) and `--self-test` (including `--omit`). The in-page selectors and timing are therefore unproven until the parent's rendered check or the CI job.

## Remaining limitations

- Two-tab start races between two *ordinary* starts (the existing idempotency boundary) are unchanged, as accepted in design review F7. A next-step start can no longer replace an unfinished run, in this tab or another.
- "Unfinished" is the server's notion (questions left or a pending answer). Another tab's finished-but-unacknowledged last answer is not protected, because acknowledgement exists only in that tab. A condition cannot protect a run it cannot see, and an unreadable store is refused rather than assumed finished.
- The protected-start condition is also not offered by the CLI `start` command; it exists for the HTTP adapter and library callers.
- A retest of an assessment from another reference version is allowed and labelled with its version; it compares only against its own baseline.
- The coverage thresholds (0, or under half of evaluated decisions) are a presentation choice, not a statistical claim.
- Variation and retest text is advice; whether transfer practice has questions is only known after the server starts it.
- Codex Sol/low and coaching statements in the READMEs describe the runtime and coaching slices' intended behaviour; they depend on those slices landing.

## Review R3 and F4 round: RED, then GREEN

Accepted findings: R3 (a stale tab replaced another tab's unfinished run) and Opus F4 (a malformed `completedAt` won the latest eligible assessment). New tests only in `test/study-next-step.test.js`; the exact-body assertions of the two earlier dispatch tests gained `protectUnfinished: true` (an expected contract change, nothing relaxed).

New tests (temp fixtures only, the real drill server over HTTP, no production store):

- two controllers sharing one real backend: B idle and stale, A starts an assessment, B's next step is refused with `UNFINISHED_RUN`, the session file is byte-identical, B's request is cleared and B shows A's session, B's gate then matches, no further request is sent, and an ordinary Start from B replaces it (body without the condition);
- the same pair with A's run finished: B's protected start is allowed;
- a lost response to a protected start, retried: byte-identical request, same `idempotencyKey`, same run, no rejection by its own guard;
- server level: refusal mid-run leaves bytes unchanged; the same request replayed returns the same run; unset/false replaces as before; finished and empty (zero-question) runs are replaceable; fail-closed cases (unreadable file, non-list queue, bad index, index beyond the queue, non-object file, retired source, legacy layout) refuse and never touch the file; `protectUnfinished` of every non-boolean type is `USAGE`/400 on the wire and in the library; the HTTP shape is 409 `UNFINISHED_RUN`;
- F4: fourteen malformed `completedAt` values (loose strings such as `foo 1`, date-only, empty, `undefined`, `null`, numbers, objects) in five list orders never beat a valid date; alone they yield an assessment offer, not a retest; ties keep the later entry.

RED, before any production change in this round: `node --test --test-concurrency=1 test/study-next-step.test.js` gave 33 tests, 24 pass, 9 fail, for the intended reasons: the malformed date chose `bad` over `good`; both dispatch bodies lacked `protectUnfinished`; the stale tab replaced the run (`Missing expected rejection`); the lost-response request lacked the guard; the unreadable-file case surfaced a raw `SyntaxError`; non-boolean conditions were accepted; `formatStudyError` fell back to the generic text. Two guard tests (finished/empty runs are replaceable; ordinary replacement) already passed and are kept as regressions.

GREEN after the change: 33/33, then 33/33 again with the journey fixture mirroring the guard.

Mutation checks of the new tests (production file restored and diffed after each): guard moved before the idempotent replay fails the lost-response and replay tests; "finished = no pending answer" fails the stale-tab, server and fail-closed tests; not converting an unreadable file fails the fail-closed test; removing `UNFINISHED_RUN` from the client's `START_REJECTIONS` fails the stale-tab test (the rejected request would stay pending).

Adjacent runs, `--test-concurrency=1`, each well under 120 s: `study-format`, `journey-contract`, `ui-token-usage`, `reference-coverage-release` 66/66; `drill-server` 21/21; `drill-cli`, `drill-committed-integrity` 44/44; `drill-learning`, `drill-stratified` 89/89; `node test/browser/coaching-study-journey.mjs --self-test` passes. The full suite and any live browser run were not executed (parent gate). The rendered `next-step-stale-tab-guard` selectors and timing are unproven until the parent's browser run or the `ui-browser` CI job.

## Parent-host follow-through

After the corrective pass, the actual host ran `study-next-step`, `drill-server`,
`drill-cli` and `drill-committed-integrity`: 98/98 passed. The final rendered
Chromium journey passed all 15 required checks, including stale-tab refusal,
exact protected-start bodies, recovery, and owned cleanup. Mobile screenshot
inspection confirmed the card and CTA fit the viewport. These parent results
supersede the maker's unexecuted-browser limitation above. Backend race
protection is proved by the real temp-backend integration; the browser's
scripted API only proves rendered request/recovery behavior.
