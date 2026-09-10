# LLM decision recovery

The default player call has a 25,000 ms soft notification and a 300,000 ms hard limit. These are provisional operational settings, not measured sufficient reasoning time. The soft notification leaves the call running; the hard limit includes startup, transport, and any bounded restored-session repair. There is no automatic shorter retry, check/fold, or policy replacement after failure.

Set the two limits in the lobby, or use `--player-soft-ms 25000 --player-hard-ms 300000` with `tools/game-loop.js`. The resolved budget is stored with the pending decision. A failed decision preserves chips, bets, turn and action history. In the managed app, open the pause menu and select **LLM 결정 재시도** or **게임 종료**. Ordinary Resume does not retry an unresolved decision. Command IDs, decision identity, generation and engine state version fence duplicate/stale application.

For legacy runs, a failure exits with `PLAYER_RECOVERY_REQUIRED` after preserving `loop-state.json.pendingDecision`. Read its decisionId and restart explicitly:

```sh
node tools/game-loop.js --store-dir /absolute/store --resume --retry-decision d-1-preflop-0
```

The same command accepts `--player-hard-ms 600000` to increase the next attempt's budget. Omitted budgets restore the previous budget. An ordinary `--resume` preserves recovery without another player decision. Managed End uses the normal abort lifecycle; legacy callers can use the existing engine `end --result abort --operation-id <unique-id>` command after stopping the owning loop, then resume for lifecycle cleanup.

A crash during an unconfirmed child call stays unsafe. Parent death is not proof that its model child and inherited streams closed. Such a record does not authorize a replacement call; diagnose termination or end the session. A recorded proposed action already present in the engine is reconciled without reapplying it. Historical forced actions keep their original meaning.

Do not downgrade a store with a pending decision: older loops do not enforce this recovery contract. End the session with the compatible version before rollback. If an external engine mutation changes a preserved decision, retry fails stale; use End rather than deleting its evidence. New budgets are persisted during bootstrap, before the first model decision. The lobby polls the current state every second; soft wait and recovery do not depend on an unrelated command notification.

`loop.log` records `player-call`, `player-attempt`, `player-soft-wait`, and `player-recovery-required`. Call elapsed time is wall time, not reasoning-token time. TIMEOUT rows are censored and must be excluded from normal completion latency while retained in total-attempt/failure denominators. Response format and illegal-action failures are classified at the decision outcome boundary. No raw prompts, reasoning, or authentication tokens are included.

Runtime evidence: the real-child regression waits 26 seconds with soft=25 seconds/hard=35 seconds, applies exactly one action, and observes zero kills. This validates the timer/transport contract, not real-model completion distributions or poker learning effects.
