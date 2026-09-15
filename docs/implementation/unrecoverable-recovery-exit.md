# Unverifiable decision recovery exits

Related: issues #196 and #197.

An explicit End/Restart after `BAD_PLAYER_RECOVERY` abandons the pending decision, not its evidence. Identity and current selection are checked under the store loop lock before reference or loop writes. No player runtime is resolved by an abort. A finalized engine keeps its outcome and proceeds through existing finalization; upper-model review or a halt remains possible.

## Durable records

1. The first validation failure snapshots the exact disk bytes to create-only `loop-state.unverified.json`, before cleanup can serialize values such as `1e400`.
2. An explicit operation publishes create-only `loop-state.abandoned.<operationId>.json`, verifies its SHA-256, and writes an `aborting` checkpoint without the damaged pending subtree.
3. Engine `end`, the terminal checkpoint and relay adoption share one atomic transition. The engine preserves the unfinished hand in `.aborted-hand.json` and keeps chip balances, completed hands and configuration unchanged.
4. Resume validates a remaining checkpoint and completes that operation idempotently. `GAME_ENDED` consumes the lifecycle: neither managed resume nor legacy main runs again after lock release.

The command journal records the original game ID, selection version and epoch. Restart recovery checks a committed reservation before the old recovery marker and parks the new game. An accepted retry command cannot certify execution: it fails `RETRY_NOT_APPLIED` and needs another explicit request.

## Rollback boundary

Do not downgrade while any `pendingDecision` exists, any command row is `accepted`, or an `aborting`/`abandonedPendingDecision` record has not converged with the terminal engine. Preserve original events and sidecars; use a compatible version to roll forward. A successful unit test or a retained sidecar is not proof that a live game is safe to downgrade.

The historical baseline is `ddcabe22f82b2fb5fc6d9a2d423b754f33b627ff`. The checked-in compatibility fixture records isolated calls to that revision's legacy loop API and app initializer, not paid-model play or an interactive production run. Its retained `COMPATIBILITY_CAPTURE` line is safe public machine evidence; the full diagnostic capture remains private and its digest is informational rather than a substitute for the retained line.

Reproduce with `HOLDEM_BASELINE=/absolute/detached-ddcabe2 node --test scripts/capture-recovery-compatibility.mjs`. The capture verifies the checkout SHA and uses only owned temporary stores. `test/fixtures/recovery-compatibility-ddcabe2.json` binds the observed matrix to the capture script and retained machine-output line; current lifecycle and app-journal behavior are exercised by separate integration tests.

The app reader is independently bounded to 2 MiB, so a larger loop file can make controls unavailable without proving that snapshot/core recovery rejects it. Controls fail closed. For a stopped, unowned legacy game, the exact manual entrypoint is `node tools/game-loop.js --game-dir /absolute/game --resume --abort-unrecoverable <operationId>`; do not add `--retry-decision`. The explicit flag can abandon an eligible playing state even if the operator did not previously observe `BAD_PLAYER_RECOVERY`. Its audit reason labels this operator recovery category, not proof of every caller's observation. Do not interrupt a live session, and do not delete pending/checkpoint evidence. Audit retry events may repeat for the same operationId/SHA; this is not an exactly-once claim.

| Stored boundary | Old legacy behavior | Old app behavior |
|---|---|---|
| Unverified snapshot only | Snapshot ignored | Snapshot ignored |
| Fresh authorization | Field retained; no fresh recreation | Retry recovery does not prove execution |
| Sidecar/checkpoint; engine still playing | May resume play because pending is absent | Parks before an action |
| Engine aborted, no accepted row | Ends | Ends |
| Engine aborted, accepted end | Not an app journal consumer | Ends |
| Accepted restart, no reservation | Not an app journal consumer | Creates a new parked game |
| Restart reservation saved/staged, selector uncommitted | Not an app journal consumer | Recovers its reservation, parked |
| Restart selector committed | Not an app journal consumer | Recovers the selected reservation, parked |

These observations explain the downgrade prohibition; they do not authorize running an older version on user data.
