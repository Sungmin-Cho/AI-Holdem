# UI implementation — delivery verification in progress

Date: 2026-09-11. Worktree: beluga. Branch: `feat/ui-bb-elimination-polish`.
Deep-loop run: `01M27FTBNWNK8XAC63E28X63M3`; workstream `ws-01-ui-bb-elimination-and-product-polish`.

## Current authorization and orchestration

The user explicitly authorized additional review/fix rounds and PR plus merge, then requested stopping deep-loop and continuing with model-router only. The installed deep-loop public `finish --status stopped --confirm` route rejected the request with `LEASE_FENCED: RUN_PAUSED`. Its state was not forged or rewritten; this is an unclosed orchestration record, not completed goal proof. No further deep-loop operations are used. Another user session owns the plugin issue. Deep-work integration skills are inapplicable because this implementation has no deep-work session.

The six bounded follow-ups below are now implemented; fresh browser checks and source review are in progress. Additional review is explicitly authorized, retaining all prior failed/invalid attempt history and the 1,200-second per-seat deadline.

## Scope delivered locally

- Additive public `out` and `handInProgress`; no engine betting, settlement, saved chip/state or policy migration.
- Shared rational BB/chip formatting, historical blind context, unit preference; strict integer chip input with explicit clamp confirmation. Action authority remains the existing receipt controller.
- Stable seat identity, explicit elimination/all-in/fold distinctions, cash reset explanation, accessible seat details and participant panel. Live pot layers are aggregated; completed multi-pot detail is separate.
- Shared charcoal/emerald tokens, offline system fonts, lobby setup summary, lifecycle-aware iframe sizing, table geometry for 2–9 seats, narrow/zoom ordered-seat fallback, study controls.
- Roving tabs, modal focus/inert management, deferred review, keyed log reading anchors and cumulative new-event indication, replay study-button focus restoration.
- Separate pinned browser CI job, explicit required-check manifest and owned fixture cleanup.

## Design adjustments

- Keep existing style.css intact and put scoped presentation overrides in table-design.css. No framework rewrite.
- Mobile action panel uses normal document flow, not a whole-panel sticky overlay. The input/presets/intent panel is too tall for a 667px viewport plus virtual keyboard; a repeated hero stack/pot/card summary keeps context available at the action. Measured hero/action overlap is zero. This is an explicit P4/M7 method adjustment, not a claim that sticky behavior was tested.
- Crowded medium-width tables use the ordered seat geometry rather than forcing an oval; very narrow zoomed containers use a vertical seat list. Hidden compact secondary values and street bets remain available in seat details.
- Dependency boundary allows only the named pure `normalizeSetup` import from lobby.js into shared/game-setup.js. Broader server imports remain prohibited.

## Executed evidence

- Initial full Node regression: 2,322 tests, 2,320 pass, 2 fail, zero skipped. Both failures were the new lobby import edge; fixed and all 65 focused tests passed. R2: 2,327 tests, 2,326 pass, one release-browser-manifest failure because the newly required replay focus case was missing from the verifier manifest. The manifest was synchronized without weakening checks; all 42 release/browser contract tests passed. Final full run: **2,327 passed, zero failed/skipped**, 826.7 seconds, output/ui-node-tests-final.log. Latest browser-only test additions were separately exercised in ui-final-contract (19/19 checks).
- Full table geometry: `output/playwright/ui-full-r3/result.json`, PASS; 2/6/8/9 players × 360/390/768/1024/1440px. Plate bounding boxes and minimum stack font measured; screenshots retained. Earlier tablet overlap failures retained in their own output folders.
- Extended UI smoke: `output/playwright/ui-final-ci/result.json`, PASS. Real relay/public views, synthetic out/events: invalid input sends zero POSTs; blur correction consumes first click; second click sends exact integer maxRaiseTo; units, reload, log unread/scroll, keyboard seat dialog, 667px action context, long names/large safe integers and CSS 200% zoom.
- Existing lobby lifecycle: `output/playwright/lobby-implemented/result.json`, PASS, 14 checks.
- Learning journey: `output/playwright/learning-final/result.json`, PASS including log/replay focus, action-receipt recovery, short all-in, review reopen, and study contracts. Uses the explicitly owned sentinel store noted below. The legacy short-all-in assertion now reads the explicit chip secondary value, not a concatenated BB/chip label.
- Latest production source full geometry and expanded behavior: `output/playwright/ui-accepted-full/result.json`, PASS. Additional cash/pot/modal cases: `output/playwright/ui-contract-ci/result.json`, PASS. Real settlement and historical BB cases now cross actual server publication/SSE/reload, not only pure helpers.
- Real tournament all-in settlement and simultaneous busts, cash intermediate reset, view publish/persist/restart round-trip are covered by test/ui-public-contract.test.js. Existing privacy/views/receipt tests remain in the full suite.
- App assets and narrow shared allowlist, study tokens-only static exposure covered by server tests.
- Baseline compatibility: ui-baseline-compatibility.json records 234 player/state comparisons over three tournament and three cash hands. turnSummary is byte-identical to base 161cd7a; views are deep-equal after removing only the two additive fields. The baseline module was read with git show and loaded in memory, without modifying source or stores.

## Review adjudication so far

- Native independent pre-audit found two P2 focus losses: detaching/reinserting a reused log row and replacing a replay body after coach updates. Accepted after tracing the DOM path; implemented logical-row and evaluationId focus restoration. Actual replay arrival focus and coach-update focus browser cases passed.
- model-router HIGH dual review R1 returned narration/fake tool requests, not verdicts, from both seats. Both receipts were INVALID_OUTPUT with confirmed termination. Neither is approval. The no-tool recipe was replaced with an explicit read-only Read/Grep/Glob tool surface for the single permitted retry, retaining a 1,200-second deadline.
- R2 both reviewers independently found the showdown DocumentFragment/dataset crash (blocker). Accepted: showdown now returns a stable Element; real all-in→showdown→pot-award→bust→reload browser test passed. This also explains the earlier intermittent review journey failure when a contested showdown occurred.
- Accepted R2 corrections: persistent confirmation text after the first clamp click; INVALID_SETUP code lookup; clear seats on empty view; include replay marker state in log keys; spoken card labels; exclude talk from unread count; phrasing-only plate children; SVG exception by localName. The comma-focus suggestion was not adopted: selecting valid formatted text preserves raw-input/confirmation semantics; the misleading comment was corrected. Call amounts remain displayable only when explicitly present in an event (normal live engine call events omit them); no new live-call amount feature or engine payload change is claimed.
- R3 Fable returned substantive PASS_WITH_CHANGES text with no blocking finding, but prefixed narration before its verdict caused schema_invalid / INVALID_OUTPUT. Its raw text is archived in ui-code-review-r3-claude-fable-5-1.md; this is NOT trusted approval and its supervisor receipt is unchanged. Opus R3 returned valid PASS_WITH_CHANGES (archived separately). Both processes terminated. Final pair verify-evidence failed because Fable is not SUCCEEDED/schema_valid; the evidence gate is honestly open. The router's three-round budget is exhausted: another dispatch needs human direction; do not disguise a format-repair call as an uncounted retry.
- R3 nonblocking feedback adjudication: desktop/mobile seat rotation direction, completed pot-details open/focus preservation, and focus when jumping from replay into a training card are useful scoped follow-ups. They remain unimplemented/unverified pending the next authorized review/fix round. Hidden-log unread behavior and modal-time elimination announcement merit follow-up; optional textarea support and policy-hidden-input changes are not required for this delivery. No peer feedback was supplied to the other reviewer.
- Formal deep-loop implementation checker and whole-goal checker are pending. The maker attempt is not returned/done, and the workstream/goal are not marked complete. This document is not a completion proof.

## Bounded next round (requires additional review-round approval)

1. Preserve completed pot-details open/focus across updates and unit changes; align desktop/mobile seat rotation; focus the destination training card when leaving replay.
2. Add fallback palette values for an already-running old study service; make the UI harness always record failures and run owned cleanup even when the protected-store digest changes. Clarify legacy cash seat status without introducing tournament elimination semantics.
3. Add focused browser regressions for these cases, then perform one additional independently routed review round. Preserve the 1,200-second deadline and use an explicit final `=== REVIEW ===` marker to avoid narration/grammar ambiguity. Do not edit old receipts or count the invalid result as approval.
4. Only after adequate review evidence, return maker artifacts, run the claimed independent deep-loop checker, close the workstream and perform the separate whole-goal check.

Not mechanically accepted: splitting range-invalid and syntax-invalid state is optional wording work, not a chip-safety correction (the current legal-range help and two-step confirmation remain safe). A textarea trap extension has no current consumer. Relay-hosted lobby support is not an intended application route. Replay blind fallback requires an identifiable hand; no missing hand identity is inferred. Broader hidden-log unread and modal announcement policy changes are deferred rather than expanding this finish pass.

## Evidence limits and safety

- No commit, push, PR, merge, branch-protection change or deployment was performed. Remote Linux/Windows/CI results are not claimed.
- Browser fixtures own separate temporary stores and clean up their own processes. No game was started in the user's real store.
- One existing learning-harness read-only digest comparison observed the real main game directory changing during the test. That run does NOT prove real-store invariance; no changes were reverted or processes stopped. Subsequent harness runs use an explicitly owned protected sentinel directory and prove only that fixture boundary.
- Full geometry assertions cover seat plates, not every possible combination of hint text, translated text, cards and zoom. Browser virtual-keyboard behavior is not equivalent to a real mobile-device certification. Real-money play, GTO/training efficacy and commercial launch readiness are not claimed.
- ESLint and Stryker are not installed; no lint/mutation green claim.

## Measured token contrast

Computed from the actual sRGB token values with WCAG relative luminance: ink/panel 15.20:1, muted/panel 8.40:1, gold/panel 9.75:1, danger/raised 6.15:1, border/panel 3.58:1, accent/panel 10.22:1, primary action text/accent 10.14:1. This is a token-level measurement, not exhaustive rendered-page or assistive-technology certification.
