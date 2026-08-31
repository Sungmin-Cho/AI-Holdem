# 게임 세션 lifecycle 설계

날짜: 2026-08-31
상태: READY_FOR_PLAN_WITH_GATES — R8 review ceiling, final findings 반영, independent final PASS 미획득, compensated continuation human-approved
상위 방향: 게임은 init 시 영구 홈을 얻고 완료 시 이동·복사되지 않는다.
선행 문서(권위): `docs/2026-08-31-session-store-foundation-design.md`

## 1. 범위

이 문서는 session-native persistence 세 계약 중 두 번째, **lifecycle/coordinator 계약**만 정의한다.

포함:

1. `tools/session-lifecycle.js`와 `tools/session-control.js`의 소유권, foundation store API 소비, immutable session identity 취급.
2. store 수명 `loop.lock.d`, legacy/downgrade session-local loop lock 탐지, "동시에 활성 게임 하나" 판정.
3. launcher 순서 — fresh bootId → store loop ownership 획득/force-stop → 이전 session pin → 현재 session 생성/해석 → concrete session root 하나와 이미 획득한 store loop ownership으로 `createGameLoop` 구성.
4. new, attach, resume, force, user abort, abandoned-session, 정상 finalization, cleanup failure, audited abandon 상태기계.
5. `lifecycle-*` namespace의 mutable lifecycle state와 store journal schema. foundation `session.json`은 절대 수정하지 않는다.
6. terminal 분류 matrix(자연 승패 보존), cross-file abort mutation 전 terminal journal 기록, engine result → lifecycle state → terminal manifest → done 관찰 → lock release의 멱등 crash recovery.
7. force quiescence — old loop/server/임시 relay/writing worker의 identity 확인 사망과 listener/lock retirement를 pointer 변경 전에 완료. logical publish/coach 증거만 명시적 expect-game-id 동의로 audited-abandon.
8. legacy-root 최초 채택과 migration matrix. byte 이동·복사·삭제 없음. foundation child-verifiable legacy capability 사용.
9. practice-focus 추출 — foundation `.extensions/practice-focus.json` 하나, 4096-byte cap, heading 규칙, forbidden-literal 거부, crash-durable predecessor descriptor.
10. dealer/store status와 boot handshake.
11. CLI/API schema, owner proof, path capability, lock 순서, 오류/notice, producer→persistence→reader→runtime 흐름.
12. 모든 process/crash/concurrency 경계의 RED gate와 현행 publisher/coach 공유 `publish.lock.d` 의미 호환.

제외:

- foundation store/pointer schema 재설계. 기존 API를 그대로 소비하되 lifecycle multi-artifact
  CAS를 위해 foundation-owned `transitionLifecycleArtifacts` primitive만 선행 문서에 추가한다.
- raw token fd 구현, runtime writer mode hardening, path-inode revalidation 구현 상세, downgrade launcher/revert 패키징 — hardening/rollback slice 소유. 이 문서는 **필요한 인터페이스와 precondition만** 고정한다(§21).
- history UI, archived-game resume/import, multi-table, retention.

## 2. 구속력 있는 결정

| # | 결정 |
|---|---|
| D1 | lifecycle mutable state는 immutable `session.json`과 물리적으로 분리된 파일에 둔다. |
| D2 | `tools/session-lifecycle.js`가 network/process/listener/token 검사를 소유한다. engine은 pinned-path pure persistence로 남는다. |
| D3 | `createGameLoop` 본체는 lifecycle이 session을 commit/resolve **한 뒤에만** 생성한다. `{storeDir, sessionDir, gameId, bootId, storeLoopHandle, serverSpawner, writerSpawner, capability, resolver, opts}`를 받고 `previousSessionDir`를 갖지 않으며 current를 다시 읽지 않는다. |
| D4 | 정상 terminal과 user-abort는 store loop lock을 해제한다. force는 old terminal과 새 session 준비 전 구간에서 같은 lock을 계속 보유한다. |
| D5 | 자연 win/lose와 finalization phase는 어떤 경로로도 abort가 되지 않는다. 명시적 finalization abandon은 result를 보존하고 degraded evidence를 기록한다. |
| D6 | audited abandon은 process 사망·listener/lock retirement를 우회할 수 없다. logical evidence quiescence만 우회한다. |
| D7 | legacy 자동 채택은 pristine-first 1회뿐이다. published current의 소실/torn 상태는 foundation restore API가 없으므로 이 slice에서 영구 fail-closed다. recover는 foundation pending 또는 valid none-sentinel의 unfinished first legacy select만 완결한다. |
| D8 | 직접 engine generic `init`은 lifecycle 진입점이 아니다. production 표면에서 제거한다. |

## 3. 소유권 경계

### 3.1 모듈 표

| 모듈 | 소유 |
|---|---|
| `engine/session-store.js` (foundation) | store mutation API, transaction lock, staging/extension secure writer. lifecycle은 소비만 한다. |
| `session-capability.js` (foundation, repo root) | read-only selector/capability resolver. lifecycle·tools·server가 이것만 import한다. |
| `engine/session-init.js` | `initializeStagingGame` — unpublished staging 전용 engine 초기화 정본. |
| `engine/cli.js` | concrete session pinned-path 명령만. pointer·process·network·loop-state를 읽거나 쓰지 않는다. |
| `tools/session-server-identity.js` (신규) | pid+startTime identity, listener 소유 검증, token-authenticated `/api/identity` challenge, server lock pin/quarantine/retire 원시. |
| `tools/session-server-spawner.js` (신규) | descriptor-bound server spawn의 유일한 표면. bootstrap, resume, D9 ensureServer, force relay가 공유. tokenChannel은 hardening injection. |
| `tools/session-writer-spawner.js` (신규) | engine/publish/coach-control mutation child를 GO-handshake runner로 실행하고 durable writer lease를 bind/release. |
| `tools/session-lifecycle.js` (신규) | store loop ownership, boot handshake, previous-session pin/quiescence/terminal, foundation API 조합, legacy 채택, practice-focus 추출, recovery 실행. |
| `tools/session-control.js` (신규) | 위 coordinator의 `status`/`stop`/`abort`/`abandon-finalization`/`inspect`/`recover`/`downgrade-guard` CLI. |
| `tools/game-loop.js` | 한 concrete session의 실행 루프. bind 이후의 server 감독·publish·coach·review·종료 phase. |

`tools/session-server-identity.js`는 현행 `tools/game-loop.js`의 `openServerLockPin`/`assertPinnedServerLock`/`retirePinnedServerLock`/`listenerOwnedBy`/`assertAuthenticatedServer`/`assertServerBinding`/`identityStillAlive`/`waitForIdentityDeath`/`sendSignal`을 **의미 무변경으로** 추출한 것이다. lifecycle은 lifecycle 경계(force, abort, quiescence, boot handshake)에서, game-loop은 실행 중 D9 자가치유에서 같은 원시를 쓴다. 두 벌 구현을 만들지 않는다.

### 3.2 engine에서 제거·이관되는 것

| 현행 | 조치 |
|---|---|
| `engine/cli.js init` | production 표면에서 제거. |
| `engine/cli.js end --result abort` | 제거. abort engine mutation은 `abort-from-intent`만. |
| `engine/game-archive.js::initGameDir` | production 경로에서 제거. legacy fixture/rollback 호환으로만 export 유지. |
| `assertLoopAllowsInit`(gameDir-relative) | production 경로에서 제거. 활성 판정은 lifecycle의 store-level both-pid 증명(§6.3)이 소유. |
| `vacateLive` / `closeOpenPartial` / `shouldArchive` / `stopServer` | production 경로에서 제거. 남은 export의 모든 destructive entry는 첫 mutation 전에 foundation `assertNotNativeSessionArchiveTarget(gameDir)`를 호출한다. |
| `resume-check`의 `loopPidAlive` | `sessionLocalLoopPidAlive`로 개명. store loop 생존을 주장하지 않는다. store-level 판정은 `session-control status`만 한다. |
| per-hand `writeHandArchive` / `rebuildArchive` | 유지. 문서에서 "hand record"로 명명해 game-level archive와 구분한다. |

### 3.3 ARCHITECTURE.md 갱신 항목

- codemap에 `tools/session-lifecycle.js`, `tools/session-control.js`, `tools/session-server-identity.js`, `engine/session-store.js`, `engine/session-init.js`, `session-capability.js` 추가.
- `game/` 정의를 "session store root"로 바꾸고 concrete session root를 별도 행으로 기술.
- both-pid 불변식을 store-level로 재기술: "활성 게임 여부는 store `loop.lock.d` owned identity와 current가 지목한 concrete session의 `lock.json` serverPid 양쪽으로만 증명한다. 관찰 명령은 `node tools/session-control.js status --store-dir game`이다."
- 의존 표에 `server/ → session-capability.js`를 `publish-contract.js`와 같은 예외로 추가.
- `tools/ → engine/` 행에 "`engine/session-store.js`의 store mutation API 직접 import 허용(lifecycle 한정), 게임 규칙 함수는 여전히 금지, staging engine 초기화는 `engine/cli.js init-staging` 자식 프로세스로만" 추가.
- `--resume`은 어떤 경로로도 `init`/`init-staging`을 호출하지 않는다(기존 불변식 강화).
- `.agents/skills/start-game/SKILL.md`, README, `test/tempo-skill-contract.test.js`를 이
  slice의 필수 deliverable로 갱신한다. production 명령은 `--store-dir`+fresh `--boot-id`,
  poll은 `session-control status`, attach/resume은 store-loop 판정, abort는
  `session-control stop → status guard → abort`를 사용한다. guard dirty면 사용자 승인 범위에
  따라 `abort --abandon-current` 또는 resume-to-drain 뒤 abort를 선택하고 항상
  `--expect-game-id`를 쓴다. `engine end`, store-root `--game-dir game`, dealer
  `--practice-focus-file`, `archivedTo` 문면을 제거한다. rollback 명령은 §21.4
  downgrade receipt와 hardening launcher interface만 참조한다.

## 4. 파일시스템과 namespace

```text
<storeDir>/                                     # session store root
  loop.lock.d/                                  # lifecycle 소유 store 수명 lock
  .session-store.lock.d/                        # foundation capsule
    store.json  current.json  pending-session.json  last-operation.json
    transaction.lock.d/
    sessions/
      .<gameId>.creating/                       # foundation staging
      <gameId>/                                 # concrete session root (영구)
        session.json  state.json  players.json
        .engine-ready.json  .session-ready.json
        .extensions/practice-focus.json
        hands/  loop-state.json  loop.log  lock.json
        publish.lock.d/  .mutex  ui-snapshot.json  review.md  …
    lifecycle-launch.json                       # §5.1
    lifecycle-session-<gameId>.json             # §5.2
    lifecycle-writers-<gameId>.json             # §5.8 durable mutation-child ledger
    lifecycle-quiescence-<gameId>.json          # §5.9 terminal admission receipt
    lifecycle-execution-<gameId>.json           # §5.10 sealed execution generation/leases
    lifecycle-server-binding-<gameId>.json      # §5.11 per-session server boot/generation
    lifecycle-terminal.json                     # §5.3
    lifecycle-inspection-<nonce>.json           # §5.4
    lifecycle-legacy-session.json               # §5.5 (foundation 고정 이름)
    lifecycle-legacy-binding.json               # §5.6 (foundation 고정 이름)
    lifecycle-legacy-capability-<operationId>.json   # foundation이 씀, lifecycle은 읽기만
  archive/  state.json  players.json  hands/  review.md  …   # legacy root, 불변
```

lifecycle이 capsule에 쓰는 이름은 모두 foundation이 허용한 예약 prefix `lifecycle-`을 만족한다. lifecycle은 capsule의 foundation 집합(`store.json`, `current.json`, `pending-session.json`, `last-operation.json`, `transaction.lock.d`, `sessions`)과 `.foundation-tmp-*`를 읽거나 쓰지 않는다. 예외는 foundation read-only API를 통한 읽기다.

**concrete session root에는 lifecycle mutable state를 두지 않는다.** 이유는 둘이다.

1. foundation의 pre-publish staging allow-list는 `{session.json, state.json, players.json, .engine-ready.json, .extensions}`(+재진입 시 `.session-ready.json`)로 닫혀 있어, publication 전에 session root에 lifecycle 파일을 쓰면 promotion이 `PRESERVE_REQUIRED`로 거부된다.
2. `layout: legacy-root`에서는 session root가 store root 자신이므로, session-root 기록은 legacy tree에 새 파일을 추가하는 것이 된다. §1의 "byte 이동·복사·삭제 없음"과 결이 다르고 구버전 `vacateLive`의 이동 대상이 된다.

따라서 native와 legacy 모두 mutable lifecycle state의 정본은 capsule `lifecycle-session-<gameId>.json` 하나다.

### 4.1 immutable manifest 두 개를 수정하지 않는 이유

- native `session.json`: foundation이 published manifest 수정 API를 제공하지 않고, current의 `manifestSha256`이 그 파일 전체 digest에 CAS로 묶여 있다.
- legacy `lifecycle-legacy-session.json`: legacy current의 `manifestSha256`과 §6.8 capability의 `manifestSha256`이 같은 파일에 묶여 있다. 내용을 바꾸면 모든 child의 `resolveLegacyConcreteSession`이 즉시 실패한다.

lifecycle은 이 둘을 **생성 시 1회**만 쓰고(legacy는 lifecycle이, native는 foundation이) 이후 read-only로만 취급한다. terminal을 포함한 모든 가변 사실은 `lifecycle-session-<gameId>.json`에 있다.

## 5. lifecycle schema

모든 lifecycle JSON은 알려지지 않은 field를 거부한다. timestamp는 UTC ISO-8601, UUID/경로는 foundation §5 문법을 그대로 쓴다. 모든 capsule lifecycle mutation은 foundation `writeLifecycleArtifact`/`removeLifecycleArtifact`/`transitionLifecycleArtifacts` CAS API만 사용한다. foundation stableJson과 `.foundation-tmp-*` secure writer를 재사용하고 lifecycle 자체 temp prefix나 ad-hoc writer를 만들지 않는다.

lifecycle CAS는 항상 "대상 파일의 현재 전체 sha256"이며, 파일 부재는 `null`이 아니라 인자 생략이 아닌 명시적 `absent` sentinel 문자열로 구분한다.

### 5.1 `lifecycle-launch.json`

launch 의도 하나를 담는 단일 파일. store loop ownership을 획득한 process만 쓴다.

```json
{
  "schemaVersion": 1,
  "kind": "ai-holdem-lifecycle-launch",
  "storeId": "8c36ea07-9a62-4d64-8b35-f186535ac923",
  "bootId": "b1c2d3e4-5f60-4a71-8b92-0c1d2e3f4a5b",
  "mode": "new",
  "phase": "starting",
  "requestedAt": "2026-08-31T07:00:00.000Z",
  "ownerPid": 41231,
  "ownerStartTime": "Sun Aug 31 07:00:00 2026",
  "previous": {
    "layout": "native",
    "gameId": "ef6ec0a9-a851-4e88-853a-7bfd4d95e63b",
    "operationId": "4d970d18-6984-4e97-b64f-aa72e04baa02",
    "sessionRel": ".session-store.lock.d/sessions/ef6ec0a9-a851-4e88-853a-7bfd4d95e63b",
    "currentSha256": "<64 lowercase hex>",
    "reviewRel": ".session-store.lock.d/sessions/ef6ec0a9-a851-4e88-853a-7bfd4d95e63b/review.md",
    "reviewSha256": "<64 lowercase hex>"
  },
  "operationId": null,
  "gameId": null,
  "practiceFocus": { "state": "pending", "sha256": null, "bytes": 0, "truncated": false },
  "halt": null,
  "updatedAt": "2026-08-31T07:00:00.000Z"
}
```

- `mode`: `new|resume|force`.
- `phase`: `starting|legacy-binding|binding|session-ready|failed`.
  `starting|legacy-binding|binding`은 성공이 아니다(§14).
- `previous`: 없으면 `null`(`layout:none` current). `reviewRel`/`reviewSha256`은 predecessor review가 없으면 각각 `null`.
- `practiceFocus.state`: `pending|absent|extracted|truncated|rejected|unavailable`.
- `halt`: `{ "code": "...", "message": "..." }` 또는 `null`. session 생성 **전** 실패의 유일한 관찰 지점이다.
- `ownerPid`/`ownerStartTime`은 진단용이며 권위가 아니다. 권위는 `loop.lock.d`의 owned record다.

**crash-durable predecessor descriptor**가 이 파일의 `previous`다. cold recovery process는 `classifyPendingRecovery`의 `previousCurrentSha256`와 `previous.currentSha256`이 같은지 대조해 launch 기록이 그 pending operation의 것임을 증명한다. 불일치는 `LIFECYCLE_STATE_CONFLICT`다.

### 5.2 `lifecycle-session-<gameId>.json`

session 하나의 mutable lifecycle 사실. 파일명의 `<gameId>`는 본문 `gameId`와 정확히 같아야 한다.

```json
{
  "schemaVersion": 1,
  "kind": "ai-holdem-lifecycle-session",
  "storeId": "8c36ea07-9a62-4d64-8b35-f186535ac923",
  "gameId": "ef6ec0a9-a851-4e88-853a-7bfd4d95e63b",
  "operationId": "4d970d18-6984-4e97-b64f-aa72e04baa02",
  "layout": "native",
  "sessionRel": ".session-store.lock.d/sessions/ef6ec0a9-a851-4e88-853a-7bfd4d95e63b",
  "manifestSha256": "<64 lowercase hex>",
  "createdAt": "2026-08-31T07:01:03.000Z",
  "adoptedAt": null,
  "activeEligible": true,
  "disposition": "active",
  "practiceFocus": { "state": "extracted", "sha256": "<64 lowercase hex>", "bytes": 812, "truncated": false,
                     "predecessorGameId": "7d7f7f5c-9b63-4c64-9b38-e6a1116a4040" },
  "terminal": null,
  "guard": { "publishAttempt": false, "coachActive": 0, "coachQueued": 0,
             "coachCleanupPending": 0 },
  "notices": [],
  "updatedAt": "2026-08-31T07:01:03.000Z"
}
```

`terminal` 확정 형태:

```json
{
  "kind": "completed",
  "result": "win",
  "reason": "normal",
  "degraded": false,
  "finishedAt": "2026-08-31T08:30:00.000Z",
  "engineStateVersion": 412,
  "intentSha256": "<64 lowercase hex>",
  "unresolvedEvidence": []
}
```

`activeEligible`은 boolean, `disposition`은 `active|terminal|preserved-unrecoverable`이다.
terminal commit은 같은 transition에서 `activeEligible:false,disposition:'terminal'`로
바꾼다. repair-required preservation만 terminal 없이 preserved-unrecoverable을 쓴다.

닫힌 조합:

| kind | result | reason | degraded |
|---|---|---|---|
| `completed` | `win` \| `lose` | `normal` | `false` |
| `completed` | `win` \| `lose` | `finalization-abandoned` | `true` |
| `aborted` | `abort` | `user-abort` | `false` |
| `aborted` | `abort` | `force-new-game` | `false` \| `true` |
| `aborted` | `abort` | `abandoned` | `false` \| `true` |

`degraded: true`이면 `unresolvedEvidence`가 비어 있으면 안 된다. `degraded: false`이면 반드시 빈 배열이다.

`unresolvedEvidence` 항목:

```json
{
  "kind": "publish-attempt",
  "handNo": 7,
  "generation": 3,
  "queueId": "5a1f2b7c",
  "relPath": ".coach-3f9a12bd4c7e-3d9f-h7-g3-a1.envelope.json",
  "sha256": "<64 lowercase hex>"
}
```

- `kind`: `publish-attempt|coach-queue|coach-active|coach-cleanup|coach-authority`.
- `relPath`는 **session 기준 상대경로**다. 절대경로, token, prompt/body 원문을 넣지 않는다.
- 무관한 field는 `null`, 배열은 빈 배열.

`notices`는 사용자 노출 한국어 문자열 배열이며 token과 절대경로를 담지 않는다.

### 5.3 `lifecycle-terminal.json`

cross-file terminal intent journal. 한 store에 최대 하나.

```json
{
  "schemaVersion": 1,
  "kind": "ai-holdem-lifecycle-terminal",
  "storeId": "8c36ea07-9a62-4d64-8b35-f186535ac923",
  "gameId": "ef6ec0a9-a851-4e88-853a-7bfd4d95e63b",
  "operationId": "4d970d18-6984-4e97-b64f-aa72e04baa02",
  "layout": "native",
  "sessionRel": ".session-store.lock.d/sessions/ef6ec0a9-a851-4e88-853a-7bfd4d95e63b",
  "currentSha256": "<64 lowercase hex>",
  "manifestSha256": "<64 lowercase hex>",
  "intent": {
    "kind": "aborted",
    "result": "abort",
    "reason": "force-new-game",
    "degraded": false,
    "expectedStateVersion": 88,
    "finishedAt": "2026-08-31T08:30:00.000Z",
    "unresolvedEvidence": []
  },
  "intentSha256": "<64 lowercase hex>",
  "writerQuiescenceSha256": "<64 lowercase hex>",
  "step": "intent",
  "engineDisposition": null,
  "engineAppliedStateVersion": null,
  "createdAt": "2026-08-31T08:30:00.000Z",
  "updatedAt": "2026-08-31T08:30:00.000Z"
}
```

- `intentSha256 = sha256(stableJson(intent))`. engine `abort-from-intent --intent-digest`가 받는 값과 byte 단위로 같다.
- `writerQuiescenceSha256`는 C0에서 생성한 §5.9 receipt digest이며 모든 terminal kind에
  필수다. `engineDisposition`은 `null|applied|idempotent|preexisting-abort`다.
- `step`: aborted는 `intent → engine → session → player-cleanup → done`, completed는
  `intent → session → player-cleanup → done`. completed journal에 step `engine`이 있으면 invalid다.
- `engineAppliedStateVersion`은 abort-from-intent 성공 응답 version이며 aborted step
  engine 이후 필수, 그 전과 completed intent에서는 null이다.
- token, 절대경로, engine state 본문을 담지 않는다.

### 5.4 `lifecycle-inspection-<nonce>.json`

```json
{
  "schemaVersion": 1,
  "kind": "ai-holdem-lifecycle-inspection",
  "storeId": "8c36ea07-9a62-4d64-8b35-f186535ac923",
  "nonce": "c3d4e5f6-0718-4293-8a4b-5c6d7e8f9a0b",
  "issuedAt": "2026-08-31T09:00:00.000Z",
  "current": { "sha256": "<hex>", "layout": "native", "gameId": "<uuid>|null", "operationId": "<uuid>|null",
               "selectionVersion": 3 },
  "pending": { "sha256": "<hex>", "action": "create_staging", "gameId": "<uuid>", "operationId": "<uuid>" },
  "lifecycleLaunchSha256": "<hex>",
  "lifecycleTerminalSha256": "<hex>",
  "lifecycleSessions": [ { "gameId": "<uuid>", "sha256": "<hex>", "terminal": "none|completed|aborted" } ],
  "candidates": [
    { "kind": "final", "gameId": "<uuid>", "relativeDir": "<store-relative>", "operationId": "<uuid>",
      "manifestSha256": "<hex>", "readySha256": "<hex>|null" }
  ],
  "legacySignals": { "stateJson": true, "playersJson": true, "reviewMd": false,
                     "handRecords": 3, "uiSnapshotJson": true, "archiveDir": true },
  "locks": { "storeLoop": "alive", "storeLoopPid": 41231,
             "sessionLoop": "same-path", "sessionLoopPid": null,
             "serverPidAlive": false, "port": 8877,
             "publishLockLive": false },
  "guard": { "publishAttempt": false, "coachActive": 0, "coachQueued": 0, "coachCleanupPending": 0 }
}
```

- `pending`은 없으면 전부 `null`.
- `candidates.kind`: `final|staging|recovery|legacy-root`. `pending` 부재 시의 orphan 열거는 이 inspect 표면에서만 하고, 정상 selector는 절대 scan하지 않는다.
- `locks.sessionLoop`: `absent|alive|dead|unknown|same-path`. `same-path`는 legacy-root라 store lock과 물리적으로 같은 directory인 경우다.
- 이 receipt는 `session-control recover`가 transaction 안에서 **전 field를 재검증**하는 CAS 뭉치다. 하나라도 다르면 `STALE_INSPECTION`이다.

### 5.5 `lifecycle-legacy-session.json`

foundation `selectLegacySession`이 digest로 소비하는 immutable legacy identity manifest.

```json
{
  "schemaVersion": 1,
  "kind": "ai-holdem-lifecycle-legacy-session",
  "storeId": "8c36ea07-9a62-4d64-8b35-f186535ac923",
  "gameId": "7d7f7f5c-9b63-4c64-9b38-e6a1116a4040",
  "operationId": "9e0f1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b",
  "layout": "legacy-root",
  "relativeDir": ".",
  "adoptedAt": "2026-08-31T07:00:00.000Z"
}
```

### 5.6 `lifecycle-legacy-binding.json`

채택 시점 관찰 증거. 파일 자신이 immutable이고, foundation은 이 **파일의 digest**만 current/capability에 묶는다. 본문이 참조하는 mutable runtime 파일(`state.json` 등)의 digest는 채택 시점 기록이며 이후 재검증 대상이 아니다 — 재검증하면 정상 플레이가 즉시 capability를 깨뜨린다.

```json
{
  "schemaVersion": 1,
  "kind": "ai-holdem-lifecycle-legacy-binding",
  "storeId": "8c36ea07-9a62-4d64-8b35-f186535ac923",
  "gameId": "7d7f7f5c-9b63-4c64-9b38-e6a1116a4040",
  "operationId": "9e0f1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b",
  "rootDev": "16777232",
  "rootIno": "12345678",
  "observedAt": "2026-08-31T07:00:00.000Z",
  "signals": {
    "stateJson":   { "present": true,  "sha256": "<hex>", "parsed": true,
                     "stateVersion": 12, "handNo": 3, "gameOver": false, "result": null },
    "playersJson": { "present": true,  "sha256": "<hex>" },
    "reviewMd":    { "present": false, "sha256": null },
    "uiSnapshot":  { "present": true,  "sha256": "<hex>" },
    "handRecords": { "count": 3, "lastRel": "hands/hand-0003.json", "lastSha256": "<hex>" },
    "loopState":   { "present": true,  "sha256": "<hex>", "phase": "playing" },
    "serverLock":  { "present": false, "sha256": null }
  },
  "resumability": "resumable"
}
```

`resumability`: `resumable|repair-required`. `stateJson.parsed === false`이면 항상 `repair-required`이고 채택은 가능하되 `LEGACY_REPAIR_REQUIRED` notice를 낸다.

`rootDev`/`rootIno`는 foundation §6.8이 재검증하는 유일한 물리 값이다.

채택 당시 살아 있는 pre-slice legacy server의 old `lock.json`에 새 identity field가 없는
경우 binding signals가 그 exact lock digest, state sessionToken digest, pid+startTime, port,
rootDev/rootIno를 함께 고정한다. 이 `legacy-v0` witness는 최초 force/stop에서만 허용되며
expected token+listener+pid identity를 모두 검증해 retire한 뒤 server binding state를
retired로 만든다. 새 schema server로 재기동하기 전 attach/success는 허용하지 않는다.
digest/identity 하나라도 다르면 `LEGACY_SERVER_RESTART_REQUIRED`로 fail-closed한다.

### 5.7 practice-focus extension body

`.extensions/practice-focus.json`. 파일 전체가 4096 bytes 이하여야 한다(foundation `maxBytes: 4096`).

```json
{
  "schemaVersion": 1,
  "predecessorGameId": "7d7f7f5c-9b63-4c64-9b38-e6a1116a4040",
  "heading": "다음 게임에서 연습할 것",
  "focus": "리버 블러프캐치 빈도를 낮춘다.\n포지션 없는 3벳 콜을 줄인다.",
  "truncated": false,
  "extractedAt": "2026-08-31T07:01:01.500Z"
}
```

### 5.8 `lifecycle-writers-<gameId>.json`

모든 mutation-capable engine/publish/coach-control child의 durable lease ledger다.

```json
{
  "schemaVersion": 1,
  "kind": "ai-holdem-lifecycle-writers",
  "storeId": "<uuid>",
  "gameId": "<uuid>",
  "generation": 17,
  "writers": {
    "<writerId-uuid>": {
      "writerKind": "engine|publisher|coach-control",
      "state": "reserved|bound|released",
      "bootId": "<uuid>",
      "spawnOwnerPid": 41000,
      "spawnOwnerStartTime": "…",
      "reservedAt": "<iso>",
      "runnerNonce": "<uuid>",
      "processGroupLeader": null,
      "pid": 41231,
      "startTime": "Sun Aug 31 07:00:00 2026",
      "commandSha256": "<token-free argv/capability digest>",
      "releasedAt": null
    }
  }
}
```

`writerSpawner.run()` 순서:

1. §5.10 execution lease와 foundation lifecycle artifact CAS로 reserved row를 같은
   generation에 기록하고 lease secret fd를 준비한다.
2. `tools/session-writer-runner.js`를 새 process group으로 spawn. runner는 실제 child를
   아직 실행하지 않고 GO pipe를 기다린다.
3. parent가 runner pid+startTime을 ledger에 bound로 CAS 기록.
4. 그 뒤에만 GO를 보내 runner가 exact command를 exec/spawn한다. parent가 GO 전에
   죽으면 EOF로 runner가 mutation 없이 종료한다.
5. child close와 process-group death 확인 뒤 released를 기록한다.

writer ledger의 writerId는 execution leaseId와 같고 generation도 execution generation과
같다. 두 artifact는 `transitionLifecycleArtifacts`로 함께 전진한다. 어느 한쪽만 있는
상태는 `BAD_LIFECYCLE_STATE`이며 mutation을 허용하지 않는다.

force/abort/terminal Q 단계는 ledger의 모든 non-released row를 열거해 pid+startTime
identity로 종료·사망 확인하고 released로 수렴시킨다. unknown/mismatch는
`WRITER_QUIESCENCE_UNCONFIRMED`이며 pointer/terminal mutation을 차단한다. audited
abandon도 이 process tier를 우회하지 못한다. server는 lock/listener 장기 수명 계약이라
이 ledger가 아니라 serverSpawner/lock으로 추적한다.

### 5.9 `lifecycle-quiescence-<gameId>.json`

`proveMutationWritersQuiesced`가 foundation CAS로 쓰는 admission receipt다. `{gameId,
operationId,writerLedgerSha256,executionSha256,executionGeneration,serverBindingSha256,
rows:[{writerId,pid,startTime,state:'released'}],coachHandles:[...],observedAt}`를 담고
stableJson digest를 반환한다. 모든 row/handle/server lease가
identity death 뒤 released인 경우에만 생성되며 unknown은 receipt를 만들지 않는다.
terminal journal은 이 receipt digest를 bind한다. C1/C3 transaction은 writer ledger/execution/server-binding digest와
receipt digest를 함께 재검증하므로 receipt 이후 새 bound writer가 생기면 전이가 실패한다.
new writer reserve는 terminal journal이 있거나 lifecycle terminal이 확정된 session에서
거부된다. receipt 자체는 audit artifact로 남기며 current selector가 아니다.

### 5.10 `lifecycle-execution-<gameId>.json`

selected-session capability는 경로/identity 증명일 뿐 mutation 권한이 아니다. 모든
engine/publish/coach/server mutation은 lifecycle-issued execution lease를 추가로 요구한다.

```json
{
  "schemaVersion": 1,
  "kind": "ai-holdem-lifecycle-execution",
  "storeId": "<uuid>", "gameId": "<uuid>", "operationId": "<uuid>",
  "generation": 4, "state": "open",
  "leases": {
    "<leaseId>": { "kind": "engine|publisher|coach-control|server|terminal-engine|rollback",
      "secretSha256": "<hex>", "state": "reserved|bound|released",
      "bootId": "<uuid>", "spawnOwnerPid": 41000, "spawnOwnerStartTime": "…",
      "reservedAt": "<iso>", "runnerNonce": "<uuid>",
      "processGroupLeader": 41231, "pid": 41231, "startTime": "…",
      "commandSha256": "<hex>", "capabilitySha256": "<hex>" }
  }
}
```

`issueExecutionLease`는 store loop handle + foundation transaction에서 current/descriptor와
`state:'open'`을 검증하고 random 256-bit secret의 digest만 기록한다. secret은 argv/env/file에
쓰지 않고 inherited fd로 runner에 1회 전달한다. runner가 자신의 pid+startTime을 CAS bind한
뒤에만 GO를 받고, runner가 foundation CAS claim까지 완료한 뒤 child를 exec한다. child는
first target I/O 전에 fd의 bound receipt를 read-only 검증한다. long-lived server/publisher/
coach event loop가 foundation mutation API를 호출하지 않는다. lease 없는 direct CLI/server entry는
`EXECUTION_LEASE_REQUIRED`, stale/replayed generation은 `STALE_EXECUTION_LEASE`로 I/O 전에
거부한다.

secret fd는 runner read 직후 zeroize+close하고 grandchild exec 전에 `FD_CLOEXEC`를 확인한다.
child가 받는 bound receipt fd에는 secret 원문이 없고 descriptor/generation/leaseId/runner
identity와 foundation CAS digest만 있다. fd 번호는 argv에 있어도 secret은 argv/env에 없다.
child는 first target I/O 검증 직후 receipt fd를 close하고, player/coach LLM 등 어떤 grandchild
exec 전에도 `FD_CLOEXEC`/closed를 단언한다. grandchild fd table에 lease/receipt fd가 남으면 실패다.

`state`는 `open|terminal-sealed|rollback-sealed`다. terminal admission은
`sealExecutionGeneration`으로 state를 `terminal-sealed`로 바꾸고 generation을
고정한다. seal은 Q6/Q7/Q8 이후 C1의 journal-first foundation transition 안에서만 실행된다.
active/reserved/bound lease가 없고 §5.9 receipt/ledger digest가 같을 때만 성공한다. aborted
intent이면 같은 transition이 exact intentSha256에 묶인 one-shot `terminal-engine` lease와
matching reserved writer-ledger row를 원자 생성한다. terminal runner가 bind→claim→GO 후
abort-from-intent를 exec하고 process-group death 뒤 lease/row를 함께 release한다. C2 종료 전
crash도 일반 writer recovery로 수렴한다. completed는 그 lease/row가 없다. 그 외 sealed generation에는 새 lease를 발급할 수 없으므로 C1 뒤 late direct
mutator race가 없다. 다음 session은 새 artifact/generation을 가진다. rollback은
`session-control issue-rollback-lease`가 full quiescence와 expect-game-id를 검증한 뒤 발급하는
별도 one-shot lease만 허용하며 capability+token만으로는 old code를 실행하지 않는다.

reserved recovery: runner가 스스로 bind/release한다. parent가 spawn 전 죽은 reserved row는
`spawnGraceMs = max(spawnWaitMs, forceStopMs) + clockSkewMs`의 닫힌 경계 이후
spawnOwner pid+startTime death와 matching runnerNonce binding 부재를
transaction에서 증명할 때만 `never-spawned` release한다. spawn 후 parent가 죽으면 runner는
bind한 뒤 GO pipe EOF를 보고 child 실행 없이 self-release한다. bound process-group은 exact
identity death 전 release할 수 없다.

writer와 server 모두 위 persisted spawn-ticket field를 공유한다. server는 writer ledger가
아니라 execution artifact+server binding에 ticket을 기록하지만 recovery 판정은 동일하다.

non-terminal rollback은 별도 `sealForRollback` transition이 full process/guard quiescence 뒤
`rollback-sealed`와 one-shot rollback lease를 원자 생성한다. 이 상태는 terminal이 아니지만
new play/server lease 발급을 막는다. compat wrapper 종료와 old-code store/session loop/server
death 증명 뒤 `reopenAfterRollback`이 generation+1, state:open, empty leases로 전진한다.
terminal C1 seal과 혼용하지 않는다.

### 5.11 `lifecycle-server-binding-<gameId>.json`

store-global launch가 덮여도 previous server의 권위를 잃지 않도록 session별로
`{gameId,operationId,bootId,serverGeneration,executionGeneration,leaseId,state:
'starting|listening|retired',port,updatedAt}`를 CAS 보존한다. spawn 전 starting과 bound server
lease를 먼저 기록한다. server가 listen한 뒤 lock/`/api/identity`와 같은 tuple로 listening을
CAS한다. Q4는 새 launch bootId가 아니라 이 previous binding을 expected witness로 쓴다.
resume은 old binding server를 Q4로 retired한 뒤 fresh bootId/generation binding을 만들고,
runtime D9는 같은 bootId에서 serverGeneration만 증가시킨다. lock 없는 listener도 bound
server lease pid+startTime으로만 종료할 수 있다; binding/lease identity가 없으면
`SERVER_PRESENCE_UNKNOWN`으로 계속 fail-closed한다.

## 6. 락과 소유권 증명

### 6.1 락 순서

```text
store loop.lock.d (lifetime, owned)
  → capsule transaction.lock.d (short, strict)
    → session-local lock (.mutex, publish.lock.d)
```

- session-local lock을 보유한 채 store transaction을 기다리지 않는다.
- store transaction을 보유한 채 child process, network, LLM, 프로세스 종료를 기다리지 않는다.
- store loop lock을 보유한 채 store transaction과 session-local lock을 기다리는 것은 허용된다(정상 경로).
- foundation `ensureStore`의 bootstrap transaction은 store loop lock 없이 단독 획득·완전 해제가 허용된다. lifecycle은 `ensureStore`를 store loop ownership 획득 **전에** 정확히 한 번 호출한다.

### 6.2 store loop lock

경로는 `<storeDir>/loop.lock.d`, 원시는 기존 `acquireOwnedLock`/`readOwnedLock`/`releaseOwnedLock` 그대로다. 현행 `tools/game-loop.js::acquireLoopLock`의 판정을 의미 변경 없이 lifecycle로 옮긴다.

```text
acquireStoreLoopOwnership({ storeDir, mode })
  mode: 'bootstrap' | 'resume'
```

1. `readOwnedLock(storeDir,'loop.lock.d')`의 `status === 'unknown'` → `LOOP_LOCK_UNKNOWN` (나이 무관 fail-closed).
2. `acquireOwnedLock` 성공 → 반환.
3. `IDENTITY_UNAVAILABLE`은 그대로 전파한다(부분 lock을 남기지 않는다).
4. `LOCKED`이면 owner를 다시 읽는다. `unknown` → `LOOP_LOCK_UNKNOWN`, `dead` → `LOOP_LOCK_UNRECLAIMABLE`.
5. `mode==='bootstrap'` → `ACTIVE_GAME`. force Q1/Q2는 이 함수 호출 전에 launcher가 수행한다.
6. `mode==='resume'` → `LOCKED`("다른 loop가 resume을 소유하고 있습니다").

4의 `dead`는 acquireOwnedLock이 정상적으로 reclaim을 시도한 뒤에도 identity/path 교체 때문에
재획득하지 못한 경우만 `LOOP_LOCK_UNRECLAIMABLE`이다. Q1/Q2 관찰에서 `absent|dead`는
already-quiesced 성공(무신호), `unknown`만 fail-closed, `alive` exact identity만 signal한다.

### 6.3 both-pid 활성 판정

활성 게임 판정은 **store loop identity**와 **current가 지목한 concrete session의 server identity** 양쪽으로만 한다. terminal은 여기에 더해지는 catalog 조건이지 두 pid 검사를 대체하지 않는다. 전체 identity/network 검사는 transaction 밖에서 수행하고, transaction 직후에는 아래 file/CAS subset만 두 번째로 검증한다.

| 신호 | 획득 방법 |
|---|---|
| store loop | `readOwnedLock(storeDir, 'loop.lock.d')` |
| session-local loop (downgrade) | `readOwnedLock(sessionDir, 'loop.lock.d')` — `sessionRel !== '.'`일 때만 |
| session server | `<sessionDir>/lock.json` strict schema → pid+startTime → `listenerOwnedBy` → token challenge |
| publish/coach lock holder | `hasLiveLockHolder(sessionDir)` (`publish.lock.d/pid`) |

server spawn 전 game-loop은 `loop-state.serverStartIntent = {bootId,port,at}`를 먼저
원자 기록하고 그 다음 child를 만든다. `lock.json` 부재는 다음처럼 판정한다.

- session이 server-start 가능 phase에 들어간 적 없고 intent도 없음: `absent`.
- intent가 있고 intended port listener가 없음: `absent`로 회수 가능하되 intent를
  retired로 기록한다.
- intent port에 listener가 있거나 phase상 server가 있었을 수 있는데 lock/port 증거가
  불충분: 먼저 matching §5.11 bound server lease pid+startTime/listener ownership을 검증해
  exact process만 Q4 ladder로 종료한다. lease identity도 없거나 mismatch면
  `SERVER_PRESENCE_UNKNOWN`.

unknown은 audited abandon을 포함해 terminal/current mutation을 차단한다. listener
absence 또는 authenticated lock retirement가 증명될 때만 진행한다.

pid/listener/token challenge 같은 느린 liveness probe는 transaction 밖에서 수행한다.
transaction 안의 두 번째 확인은 current/manifest digest, pinned `lock.json` dev/ino/bytes,
`serverStartIntent`, writer-ledger digest만 재검증한다. transaction mutex 아래에서 lsof
child, HTTP, signal 또는 death wait를 실행하지 않는다.

### 6.4 session-local loop lock 탐지 matrix

| current layout | store loop | session-local loop | 판정 |
|---|---|---|---|
| `none` | 임의 | 해당 없음 | store loop 하나로 판정 |
| `native` | alive | absent \| dead | 정상 활성 |
| `native` | alive | alive, 같은 pid+startTime | 불가능 조합 — `MULTIPLE_LOOP_OWNERS`(같은 process가 두 lock을 보유할 수 없다) |
| `native` | alive | alive, 다른 identity | `MULTIPLE_LOOP_OWNERS` fail-closed. force로도 자동 해소하지 않는다 |
| `native` | absent \| dead | alive | downgrade sidecar 활성. non-force → `ACTIVE_GAME`, force → §11 ladder를 session-local owner에 적용 후 store lock 획득 |
| `native` | 임의 | `unknown` | `LOOP_LOCK_UNKNOWN` fail-closed |
| `legacy-root` | 임의 | 같은 경로 | 하나의 lock으로 취급. `sessionLoop: "same-path"`로 보고하고 이중 owner 판정을 하지 않는다 |

session-local loop lock의 `dead`/`absent` 잔여 directory는 활성 신호가 아니며 자동 삭제하지 않는다. `LEGACY_LOOP_LOCK_RESIDUAL` notice만 낸다.

### 6.5 `publish.lock.d` 호환

현행 계약을 변경하지 않는다.

- `tools/publish.js`와 `tools/coach-control.js`는 같은 `LOCK_NAME = 'publish.lock.d'`를 계속 공유한다. **`coach.lock.d`를 만들지 않는다.**
- lock 경로 기준은 concrete `sessionDir`이며, `withNamedLock(sessionDir,'publish.lock.d',…)`의 timeout/staleness/reclaim 판정은 그대로다.
- lifecycle은 이 lock을 직접 잡지 않는다. quiescence 판정은
  `hasLiveLockHolder(sessionDir)`, `coach-control rollback-guard`, 그리고 shared
  `readCoachGuardEvidence`가 authority의 active/queued/reclaimableHandles/
  termination-unconfirmed cleanup rows를 직접 분류한 결과를 함께 쓴다. rollback-guard의
  현재 반환값만으로 `coachCleanupPending`을 추측하지 않는다.
- foundation strict transaction wrapper는 별도 분기이고 공유 mutex 판정 로직을 수정하지 않는다.

**절대경로 불변 요구:** `tools/coach-control.js::coachPaths`는 `path.join(gameDir, …)`로 절대 `exactResultPath`/`exactEnvelopePath`를 만들어 `.coach-authority.json`에 영속한다. `assertExactFile`은 그 경로가 `path.resolve(gameDir)` 아래인지 검사한다. 따라서 **session directory를 어떤 시점에도 이동·복사하지 않는다**는 것이 coach queue 재개 가능성의 필요조건이다. 이 설계가 byte 이동을 금지하는 두 번째 독립 근거다.

## 7. launcher 순서

`tools/game-loop.js`의 `main()`은 다음 순서를 지킨다. 각 단계 실패의 관찰 지점을 함께 명시한다.

| # | 단계 | 실패 시 관찰 |
|---|---|---|
| 0 | argv 파싱, `--store-dir`·`--boot-id` 필수 확인. `--boot-id`는 dealer가 만든 fresh UUID v4 | stderr envelope + `/tmp/ai-holdem-boot.log` |
| 1 | `ensureStore(storeDir)` — capsule/marker/none-sentinel/sessions/control temp 복구 | stderr envelope. capsule이 없으므로 halt를 쓸 수 없다 |
| 2 | `resolveCurrentSelector(storeDir)` read-only tentative previous pin | stderr + current code |
| 3 | force이면 tentative pin으로 Q1 store owner, Q2 session-local owner만 정지. non-force는 mutation 없음 | stderr; Q1/Q2 실패 시 pointer 불변 |
| 4 | `acquireStoreLoopOwnership({storeDir, mode})` — acquire가 Q4~Q9를 호출하지 않음 | stderr envelope |
| 5 | current를 다시 resolve하고 step 2 digest/tuple과 비교. 변경이면 `CURRENT_CHANGED` | stderr; lock은 정리 후 해제 |
| 5b | 기존 current의 server/writer/coach liveness를 claim 전 관찰. non-force에서 live/unknown이면 `ACTIVE_GAME`/`QUIESCENCE_UNCONFIRMED`로 launch bytes 불변 종료. rollback-sealed도 여기서 거부 | stderr; 기존 launch 불변 |
| 6 | `lifecycle-launch.json`을 `{bootId, mode, phase:'starting', previous:<pinned>}`로 CAS 기록 | 이 시점부터 실패는 launch halt |
| 7 | pending recovery 또는 post-publish binding recovery(§9.1), current none이면 pristine legacy adoption(§12). adoption 성공 시 current를 재-resolve하고 launch.previous를 adopted descriptor/review digest로 CAS 갱신 | launch halt |
| 8 | previous 처리 — resume bind / force Q4~Q9 / abandoned 수렴. attach는 launcher가 아니라 status 경로 | launch halt |
| 9 | practice-focus 추출과 predecessor digest를 launch에 고정 | launch halt |
| 10 | 신규면 `allocateSession` → staging/init/extension. **current commit 전** launch를 `{phase:'binding',operationId,gameId,practiceFocus}`로 CAS 기록 → `commitPreparedSession` | launch halt |
| 11 | foundation published tuple과 binding launch로 한 `transitionLifecycleArtifacts`에서 `lifecycle-session-<gameId>.json`, initial `lifecycle-execution-<gameId>.json`(generation:1,state:open,leases:{}), empty `lifecycle-writers-<gameId>.json`을 멱등 생성/복구하고 launch를 `session-ready`로 갱신 | launch halt |
| 12 | `createGameLoop({storeDir,sessionDir,gameId,bootId,storeLoopHandle,serverSpawner,writerSpawner,capability})` 구성 | launch halt |
| 13 | 신규는 `loop.bindStart()`, resume은 `loop.resumeBound()` → `loop.run()` | session loop-state halt |

단계 12 이전 실패의 정본은 capsule `lifecycle-launch.json.halt`, 이후 실패의 정본은 session `loop-state.json.halt`다. 두 위치에 동시에 halt를 쓰지 않는다.

launcher는 step 4의 handle 획득 직후부터 `try/finally`를 설치한다. `createGameLoop`과
`bindStart/resumeBound`가 ownership을 인수하기 전 step 5~12가 실패하면, claim이 있었다면
`haltLaunch`를 기록하고 exact handle을 release한 뒤 exit한다. claim 전 실패는 halt 없이
release한다. ownership 인수 후에는 game-loop `requestStop`만 release한다. force old-terminal
commit 후 allocate/pointer 실패도 pending recovery 정보를 보존하고 같은 finally로 handle을
해제한다. live failed launcher가 `ACTIVE_GAME`을 영구 유지하는 경로는 없다.

`haltLaunch`는 halt를 쓰는 같은 CAS에서 `phase:'failed'`로 바꾼다. `claimLaunch`가 recovery를
우선하는 범위는 `halt:null`이고 same bootId continuation 또는 prior owner death가 증명된
same-operation takeover인 existing
`starting|legacy-binding|binding`, 또는
`session-ready`이면서 lifecycle-session이 없거나 loop-state가 `absent|bootstrap`인 same
operation뿐이다. `session-ready` + `playing|FINAL_PHASES|done`, 또는 lifecycle terminal이
확정된 current는 과거 launch이며 새 `--ai`가 덮어쓰고 previous로 처리한다. terminal current는
재-terminalize하지 않고 곧바로 practice-focus/ALLOCATED로 진행한다. dead playing current는
§9.6 abandoned 판정을 거친다. foundation current/last-operation published인데
lifecycle-session이 없는 post-publish crash만 같은 gameId의 단계 11~13을 완성한다.
predecessor reviewRel/reviewSha256는 recovery 범위에서 기존 launch로부터 보존한다.
`phase:'failed'` 또는 non-null halt는 다음 `--ai`가 overwrite할 수 있으며 resume은 새 claim을
만든다. SESSION_TERMINAL/NO_GAME/RESUME_REQUIRED 같은 operator-gated failure가 store-global
launch를 독성 starting 상태로 남기지 않는다.

특히 `session-ready+playing` previous에서 store loop만 dead이고 authenticated server 또는
writer가 live/unknown이면 step 5b가 claim보다 먼저 차단한다. orphan server를 가진 healthy
launch의 bootId/phase/previous를 non-force probe가 덮어쓰지 않는다.

step 11 recovery는 lifecycle-session/execution/writers 세 artifact가 모두 absent면 한
transition으로 만들고, 모두 exact digest면 idempotent success다. 일부만 존재하면 same
operation/current와 생성 receipt를 검증해 missing artifact만 보완한다. identity/generation/
비-empty 예상 밖 상태는 `LIFECYCLE_STATE_CONFLICT`다. 첫 server lease는 이 세 artifact와
session-ready launch가 완결된 뒤에만 발급된다.

recovery launcher가 store loop ownership을 획득하면 same-operation launch의 bootId와
ownerPid/startTime만 새 live launcher 값으로 CAS 갱신하고 previous, operationId, gameId,
practiceFocus는 byte-equivalent로 보존한다. dealer handshake는 현재 store-loop owner의
bootId를 따른다.

최초 legacy adoption은 step 2의 none-sentinel을 predecessor로 고정하지 않는다. select 성공
직후 adopted current를 re-pin하고 `launch.previous={layout:'legacy-root',gameId,operationId,
reviewRel,reviewSha256}`로 durable 갱신한 뒤 abandoned/new 처리와 practice-focus 추출을
수행한다. select 직후 crash도 same `legacy-binding` operation이 이 갱신을 재생한다.

### 7.1 `createGameLoop`에 넘기는 것 전부

```js
createGameLoop({
  storeDir,          // canonical absolute store root
  sessionDir,        // canonical absolute concrete session root
  gameId,            // uuid v4
  bootId,            // current live launcher handshake id
  storeLoopHandle,   // acquireOwnedLock가 반환한 살아 있는 handle
  serverSpawner,     // descriptor-bound single spawn surface; D9 포함
  writerSpawner,     // durable writer-lease handshake surface
  capability: Object.freeze({
    layout: 'native',                 // 'native' | 'legacy-root'
    operationId,                      // native only
    manifestFile,                     // native only: <sessionDir>/session.json
    expectedCurrentSha256,            // native only
    legacyCapabilityFile,             // legacy only: capsule capability 절대경로
  }),
  resolver,
  opts,
})
```

- `root = path.resolve(sessionDir)`. 기존 `loopStatePath`, `engineStatePath`, `playersPath`, `sessionsPath`, `reviewPath`, `reviewEnvelopePath`, `publishAttemptPath`, `lockPath`, `turnPath`, `coachSnapshotPath`, `coach*Path`, `loop.log`, canary는 전부 이 `root`에서 그대로 파생된다.
- `previousSessionDir`, `current.json` 경로, capsule 경로는 **넘기지 않는다.** game-loop은 `resolveCurrentSelector`를 호출하지 않는다.
- `acquireLoopLock`/`stopExistingLoopForForce`/`stopRereadServerForForce`는 game-loop에서 제거된다. `releaseLock()`은 `releaseOwnedLock(storeLoopHandle)`이 되고, 이 호출은 `requestStop`의 마지막에 정확히 한 번만 일어난다.
- 모든 child argv에 `--store-dir <storeDir> --game-dir <sessionDir>`과 layout별 capability flag가
  붙고, mutation child/server에는 execution generation+leaseId와 secret fd가 추가된다(§5.10,
  §15.3). read-only `inspect-session|legal|view|hand|stats`만 execution lease가 불필요하다.
- game-loop `ensureServer`/D9는 직접 spawn하지 않고 injected `serverSpawner.spawn()`만
  호출하며 spawn 전 `loop-state.serverStartIntent={bootId,port,at}`를 기록한다.
- engine/publish/coach-control mutation child는 직접 spawn하지 않고 injected
  `writerSpawner.run()`만 호출한다(§5.8).
- serverSpawner/writerSpawner가 lease issue→runner bind/claim→GO를 완전히 캡슐화한다.
  game-loop에 raw lease issuer나 secret을 노출하지 않는다.

game-loop public runtime entry는 다음 둘로 교체한다.

- `bindStart()`: 이미 initialized+published concrete session에서 loop-state bootstrap,
  server/adapters/player warmup, `playing` 전이만 수행한다. init/init-staging/foundation
  mutation/store lock 획득/current resolve/force를 호출하지 않는다. same gameId의
  loop-state 또는 lock.json이 이미 있으면 덮어쓰거나 두 번째 server를 만들지 않고
  `resumeBound()`의 phase/adoption 경로로 위임한다.
- `resumeBound()`: 이미 선택된 same session의 persisted phase/server/player/coach를
  복구한다. init/init-staging/foundation allocation/store lock 획득을 호출하지 않는다.

기존 `bootstrap()`의 init/force/lock 전반은 lifecycle launcher로 이관하고 함수 이름을
production에서 제거한다.

### 7.2 force에서 store loop lock 유지

force는 단계 4에서 lock을 획득하고, 단계 8의 old terminal commit과 단계 10의 신규
session 준비 전 구간에서 **같은 handle을 계속 보유**한다. old terminal commit은 lock을
해제하지 않는다(D4). 단계 12에서 그 handle을 새 game-loop에 넘긴다. 정상 완료와
user-abort만 마지막에 해제한다.

## 8. store와 session의 상태 어휘

lifecycle이 판정에 쓰는 관찰값은 다음 다섯 축이다. 추측하지 않고 각각을 독립적으로 읽는다.

| 축 | 값 | 출처 |
|---|---|---|
| `currentLayout` | `none\|native\|legacy-root` | `resolveCurrentSelector` |
| `lifecycleTerminal` | `none\|completed\|aborted` | `lifecycle-session-<gameId>.json.terminal` |
| `enginePhase` | `active\|game-over-win\|game-over-lose\|game-over-abort` | pinned `state.json`의 `gameOver`/`result` |
| `loopPhase` | `absent\|bootstrap\|playing\|finalizing\|review_generated\|review_published\|done` | pinned `loop-state.json.phase` |
| `liveness` | `store-loop`, `session-loop`, `server`, `publish-lock` 각각 `alive\|dead\|absent\|unknown` | §6.3 |

보조 축:

- `guard`: `publishAttempt`(파일 존재), `coachActive`/`coachQueued`/`coachCleanupPending`(`rollback-guard` 및 authority 읽기).
- `cleanupFailed`: `loop-state.cleanupFailedAt` 존재 여부.

`readCoachGuardEvidence`의 closed schema:

```js
{
  authoritySha256, authorityEpoch,
  publishAttempt: { present, sha256 },
  active: [{ queueId, pid, startTime, state }],
  queued: [{ queueId, generation, envelopeSha256 }],
  cleanup: [{ queueId, state: 'released|pending|termination-unconfirmed|malformed' }],
  malformed: false,
  clean: true
}
```

`clean`은 publishAttempt absent, active/queued empty, cleanup 전부 released, malformed false일
때만 true다. authority missing은 다른 coach artifact도 전부 absent일 때만 empty clean이다.
unknown/malformed/termination-unconfirmed는 fail-closed다. authoritySha256/epoch와 이 evidence
digest는 §5.9 quiescence receipt에 bind하며 audited abandon은 logical rows를 unresolvedEvidence에
보존할 수 있지만 process identity death는 우회하지 않는다.

`halt`, `finalizing`, `cleanupFailed`는 terminal이 아니다. `REVIEW_FAILED`, `repair_failed`, `COACH_RECONCILE_PENDING`, `REVIEW_GATE_CLOSED`, `FINALIZATION_ABORTED`는 전부 재개 가능하며 `lifecycleTerminal`을 `none`으로 유지한다.

## 9. 상태기계

### 9.1 new (신규 게임)

```text
IDLE
 → LAUNCH_CLAIMED      (store loop lock 보유 + lifecycle-launch starting)
 → PREV_RESOLVED       (current pin, previous 처리 완료 또는 previous 없음)
 → ALLOCATED           (allocateSession: pending 최초 write)
 → STAGED              (ensureStagingForOperation: staging + immutable session.json)
 → ENGINE_READY        (init-staging → .engine-ready.json)
 → EXTENSIONS_READY    (writeSecureExtension(practice-focus) 또는 명시적 생략)
 → PUBLISHED           (commitPreparedSession: ready → rename → current → last-op → pending cleanup)
 → LIFECYCLE_BOUND     (lifecycle-session-<gameId>.json 생성, launch phase=session-ready)
 → LOOP_BOUND          (createGameLoop)
 → PLAYING             (loop-state.phase=playing)
```

phase 전진은 foundation `recordPendingPhase`의 `allocated → initializing → base_ready → extensions_ready → promoted → selected`와 1:1 대응한다. lifecycle은 `initializing`(단계 ENGINE_READY 직전), `base_ready`, `extensions_ready`만 직접 기록하고 나머지는 foundation commit이 기록한다.

전이 거부:

| 관찰 | 결과 |
|---|---|
| store loop alive, force 아님 | `ACTIVE_GAME` |
| session server alive, force 아님 | `ACTIVE_GAME` |
| current native/legacy, `lifecycleTerminal === none`, loop/server dead, guard dirty | `RESUME_REQUIRED` |
| current native/legacy, `lifecycleTerminal === none`, `enginePhase` 자연 승패 또는 `loopPhase ∈ {finalizing, review_generated, review_published}` | `RESUME_REQUIRED` (D5) |
| pending 존재, 다른 operation | `SESSION_CREATION_IN_PROGRESS` |
| `lifecycle-terminal.json` 존재 | `TERMINAL_CONFLICT` — recovery 먼저(§10.4) |

### 9.2 attach

launch 없이 관찰만 하는 경로. dealer가 `session-control status`로 판정한다.

```text
store loop alive  ∧  launch.phase === 'session-ready'
  ∧ loop-state.phase ∈ {playing, finalizing, review_generated, review_published}
  ∧ status.locks.server === 'alive' ∧ serverIdentityMatch
  ⇒ attach: 새 process를 띄우지 않는다
```

attach는 lifecycle mutation을 하지 않는다. `session-control status`는 read-only이며 store loop lock도 transaction lock도 잡지 않는다(foundation read-only API + pinned session 파일 읽기만).

launch 상태에서 sidecar를 다시 띄우면 단계 2에서 `ACTIVE_GAME`이 되어 attach만이 유일한 정상 경로임이 기계적으로 강제된다.

### 9.3 resume

```text
IDLE
 → LAUNCH_CLAIMED   (mode='resume', force 금지)
 → PREV_RESOLVED    (current native/legacy 필수)
 → RESUME_GATED     (terminal/guard 판정)
 → LOOP_BOUND       (같은 gameId, 같은 sessionDir)
 → 기존 loop.resume() 계약 그대로
```

게이트:

| 관찰 | 결과 |
|---|---|
| `currentLayout === 'none'` | `NO_GAME` |
| `lifecycleTerminal !== 'none'` | `SESSION_TERMINAL` — 끝난 게임은 재개하지 않는다 |
| `lifecycle-terminal.json` 존재 & step 미완 | 먼저 §10.4 recovery를 실행하고, 완료 후 `SESSION_TERMINAL` |
| pending 존재 | `SESSION_CREATION_IN_PROGRESS` — resume은 pending을 만들지도 지우지도 않는다 |
| execution `state:'rollback-sealed'` | old-code loop/server death를 §6.4로 증명한 re-upgrade resume만 `reopenAfterRollback` generation+1 후 진행. 일반 new/abandoned 금지 |
| engine `gameOver:true,result:'abort'` + lifecycle terminal 없음 | §10.1을 game-loop bind 전에 실행해 matching pending intent가 있으면 그 reason, 없으면 `aborted/abandoned`로 terminal 완결 후 `SESSION_TERMINAL` |
| 위 전부 통과 | resume 진행 |

resume bind 전에는 `PREV_GENERATION_TAKEOVER`를 수행한다. prior bootId/generation의 writer
ledger rows, server lease/binding, persisted coach handles를 Q4/Q5/Q5b 방식으로 death/release
증명하고, current CAS 아래 execution generation을 +1 open/empty로 회전한다. unknown 또는
live prior writer는 `WRITER_QUIESCENCE_UNCONFIRMED`; fresh generation 전에는 resumeBound가
어떤 mutation lease도 발급하지 않는다.

자연 win/lose/finalization phase는 terminal로 바꾸지 않고 `resumeBound()`가 기존 finalization을
계속한다. `--resume`은 `allocateSession`, `ensureStagingForOperation`, `init-staging`, `commitPreparedSession`, `selectLegacySession` 중 어느 것도 호출하지 않는다. current는 정확히 한 번 resolve하고 이후 다시 읽지 않는다.

resume의 orphan server adopt는 lock/`/api/identity`의 bootId/serverGeneration/leaseId가 현재
launcher용 per-session binding과 이미 일치할 때만 허용한다. 이전 boot의 healthy server는
Q4로 retire한 뒤 fresh bootId/generation lease로 respawn한다. 기존 "healthy external server
무조건 adopt" 계약은 의도적으로 교체하며 관련 테스트/문서를 갱신한다.

### 9.4 force

§11.1의 pre-lock Q1~Q2를 수행하고 Q3에서 store loop lock을 얻은 뒤, launch claim 후에는
§11.2의 post-lock Q4~Q9만 수행한다. store loop lock은 계속 보유한다.

```text
PREV_RESOLVED
 → PRELOCK_LOOP_QUIESCED   (foreign store/session-local loop 사망 확인)
 → STORE_LOCK_ACQUIRED_AND_REPINNED
 → LAUNCH_CLAIMED(force)
 → PREV_PROCESS_QUIESCED   (server/임시 relay/mutation writer/coach worker 사망 확인)
 → PREV_LISTENER_RETIRED   (lock.json retire, listener 부재, publish lock holder 부재)
 → PREV_EVIDENCE_RESOLVED  (drain+rollback-guard 통과)  |  PREV_EVIDENCE_ABANDONED (audited)
 → PREV_TERMINALIZED       (aborted/force-new-game 또는 completed/finalization-abandoned)
 → ALLOCATED → … → PLAYING
```

`PREV_PROCESS_QUIESCED`와 `PREV_LISTENER_RETIRED`는 어떤 flag로도 우회할 수 없다(D6). `PREV_EVIDENCE_RESOLVED`만 `--abandon-current --expect-game-id <id>`로 `PREV_EVIDENCE_ABANDONED`로 대체된다.

post-lock 함수는 Q1/Q2를 다시 호출하거나 현재 보유한 `storeLoopHandle`에 signal할 수 없다.

자연 승패/finalization phase의 previous session은 `PREV_TERMINALIZED`에서 abort core로 들어가지 않는다. `--abandon-finalization --expect-game-id <id>`가 없으면 `RESUME_REQUIRED`다.
이미 lifecycle terminal이 확정되고 journal이 없는 previous는 Q9 terminal commit을
idempotent-different intent로 재호출하지 않는다. process/guard가 clean임을 확인한 뒤 그
terminal을 그대로 predecessor로 두고 ALLOCATED로 진행한다. 즉 자연 완료 뒤 다음 게임에
`--force`가 필수는 아니다.

Q9/abandoned core가 새 terminal을 만든 경우 같은 launcher가 old loop-state D1과 F1/F2를
끝내 `lifecycle-terminal.json`을 제거한 뒤에만 `allocateSession`을 호출한다. force는 이
finish 동안 같은 store handle을 유지한다. F2 후 allocate 전 crash는 다음 launch가 확정된
old terminal을 predecessor로 보고 새 allocation을 시작한다. store-global journal을 새 game과
공유하지 않는다.

### 9.5 user abort

`node tools/session-control.js abort --store-dir <dir> --expect-game-id <uuid>`가 유일한 외부 abort 명령이다.

```text
1. ensureStore
2. acquireStoreLoopOwnership({mode:'bootstrap'})
     — 살아 있는 sidecar가 있으면 ACTIVE_GAME. abort는 남의 loop를 죽이지 않는다.
3. resolveCurrentSelector → concrete capability pin. --expect-game-id 불일치는 EXPECT_GAME_ID_MISMATCH
4. session server가 살아 있으면 SERVER_ALIVE (abort는 server를 죽이지 않는다)
5. `proveMutationWritersQuiesced`로 durable writer ledger와 persisted coach worker의
   death/release receipt를 만든다. unknown/mismatch는 WRITER_QUIESCENCE_UNCONFIRMED
6. guard 검사: publishAttempt / coachActive / coachQueued / coachCleanupPending 하나라도 있으면 RESUME_REQUIRED
7. enginePhase 자연 승패 또는 loopPhase ∈ FINAL_PHASES → RESUME_REQUIRED (D5)
8. terminal commit core (aborted/abort/user-abort), writer receipt digest를 C0/C1에 bind
9. store loop lock 해제 (D4)
```

dealer가 concrete `end`와 store terminal 명령을 따로 부르지 않는다. `engine/cli.js end`는 제거된다.

`--abandon-current`를 준 user abort는 step 6의 logical guard만 우회하고
`reason:'abandoned'`, `degraded:true`, 보존된 `unresolvedEvidence`로 commit한다. step 5의
writer/execution quiescence와 step 7의 자연 결과 보호는 절대 우회하지 않는다.

### 9.6 abandoned-session 수렴

current가 non-terminal인데 store loop·session-local loop·server가 모두 dead/absent이고
`proveMutationWritersQuiesced` receipt가 모든 mutation writer/coach worker의 death/release를
증명하며 guard가 깨끗한 상태.

execution `rollback-sealed`는 abandoned eligibility보다 먼저 판정하며 자동 abort/new를
절대 수행하지 않는다. non-force `--ai`는 `ROLLBACK_SESSION_SEALED`, resume은 old-code death
증명 후 reopen만, force/user-abort는 exact `--expect-game-id`가 있을 때만 별도 정책으로
진입한다.

| 조건 | 신규 launch(force 아님) 동작 |
|---|---|
| guard clean ∧ `enginePhase === 'active'` ∧ `loopPhase ∈ {absent, bootstrap, playing}` | `aborted/abort/abandoned`, `degraded:false`로 자동 수렴 후 신규 session 진행 |
| guard dirty | `RESUME_REQUIRED`. current를 바꾸지 않는다 |
| `enginePhase` 자연 승패 또는 `loopPhase ∈ FINAL_PHASES` | `RESUME_REQUIRED` (D5) |
| `cleanupFailed` | `RESUME_REQUIRED` — 정리 실패 원인 해소 후 `--resume` |
| liveness 또는 writers에 `unknown`/non-released가 하나라도 있음 | `LOOP_LOCK_UNKNOWN`/`QUIESCENCE_UNCONFIRMED`/`WRITER_QUIESCENCE_UNCONFIRMED` fail-closed |
| adopted legacy `resumability:'repair-required'` | process/writer death와 guard clean을 모두 증명한 뒤 `PREV_PRESERVED_UNRECOVERABLE`; abort terminal 없이 activeEligible:false/disposition 기록 후 native allocation. guard dirty면 `RESUME_REQUIRED`, explicit matching `--abandon-current`만 unresolvedEvidence를 보존하고 진행 |

자동 수렴은 process를 죽이지 않고 파일을 지우지 않는다. terminal commit core 하나만 실행한다.

### 9.7 정상 finalization

기존 phase chain `playing → finalizing → review_generated → review_published → done`을 유지한다. 변경은 `done` 확정 방식 하나다.

```text
runFinalization()
  finalize()               →  review_generated
  publishGeneratedReview() →  review_published
  finishDoneLifecycle():
     1. requestStop({ afterQuiesceBeforeFinalState, finalStatePatch, beforeRelease })
          afterQuiesceBeforeFinalState:
             // adapters/children/server death + listener/lock retirement 확인 뒤
             proveMutationWritersQuiesced() // 전 row released receipt
             commitTerminalCore({kind:'completed', result: engine.result, reason:'normal'},
                                { ownerHandle: storeLoopHandle, stopBeforeDone: true }) // intent → session
             remove `.player-sessions.json` idempotently // C3 session terminal 확정 뒤만
          finalStatePatch: { phase:'done', finishedAt, completion:{kind,result,reason,degraded} , halt: undefined }
          beforeRelease:   () => finishTerminalCore()   // step done → journal 제거
     2. releaseOwnedLock(storeLoopHandle)   // requestStop 내부, beforeRelease 성공 후에만
```

`requestStop`에 두 hook을 추가한다. `afterQuiesceBeforeFinalState`는 adapter/child/server
정리와 server listener/lock retirement 뒤, final loop-state write 전에 호출한다.
`beforeRelease`는 최종 loop-state write 뒤 store lock release 전에 호출한다. 어느 hook
실패든 `persistCleanupFailure`를 남기고 exact lock handle을 유지한다. 오류/SIGTERM
경로는 terminal hook을 설정하지 않는다.

현행 shared `stopPromise` merge에서 late `finalStatePatch.phase:'done'`를 hook 없는 in-flight
stop에 합치는 것은 금지한다. 첫 stop attempt가 terminal hooks를 소유하지 않았다면 late
finishDoneLifecycle은 `FINALIZATION_STOP_RACE`로 거부하고 `cleanupFailedAt`을 남기며 done과
lock release를 수행하지 않는다. hooks를 가진 같은 attempt에서만 finalStatePatch를 merge할
수 있고, `beforeRelease`가 journal F2 제거까지 성공하지 않으면 phase done/lock release가
함께 금지된다. SIGTERM vs review_published race도 done-without-terminal을 만들 수 없다.

`result` 권위는 pinned `state.json`의 `result`다. `win|lose`가 아니면 terminal을 쓰지 않고 `TERMINAL_CONFLICT`로 halt한다.
현행 finishDoneLifecycle의 `.player-sessions.json` unlink는 terminal C3 뒤로 이동한다. C1/C2/C3
실패 전에는 player resume state를 지우지 않으며, ENOENT만 idempotent success다.

### 9.8 cleanup failure

`loop-state.cleanupFailedAt`/`cleanupError`가 남고 process가 비정상 종료한 상태. 같은 process에서 재시도되지 않는다.

| terminal journal | lifecycle terminal | loop-state | 다음 `--resume` 동작 |
|---|---|---|---|
| 없음 | `none` | `phase != done` | 정상 resume. terminal 없음 |
| `step: intent` | `none` | 임의 | §10.4 recovery로 core 재실행 후 `SESSION_TERMINAL` |
| `step: session` | 확정 | `phase != done` | recovery가 player cleanup 후 done 기록 → journal 제거 → `SESSION_TERMINAL` |
| `step: player-cleanup` | 확정 | `phase != done` | recovery가 done 기록 → journal 제거 → `SESSION_TERMINAL` |
| `step: player-cleanup` | 확정 | `phase == done` | recovery가 F1/F2 roll-forward → `SESSION_TERMINAL` |
| `step: done` | 확정 | `phase == done` | recovery가 journal만 제거 → `SESSION_TERMINAL` |
| 없음 | 확정 | `phase == done` | 완결. `SESSION_TERMINAL` |

cleanup failure 자체는 절대 terminal을 만들지 않는다. terminal core가 이미 시작됐을 때만 journal이 존재한다.

### 9.9 audited abandon

두 종류만 있다.

| 명령 | intent | 우회하는 것 | 우회하지 못하는 것 |
|---|---|---|---|
| `--abandon-current --expect-game-id <id>` | 활성 session → `aborted/abort/(force-new-game\|abandoned)`, `degraded:true` | publish attempt·coach queue/active/cleanup의 논리적 해소, `rollback-guard` 통과 | store/session loop, server, mutation writers/coach worker 사망, listener 부재, `lock.json` retirement, `publish.lock.d` live holder 부재 |
| `--abandon-finalization --expect-game-id <id>` | 자연 승패 session → `completed/(win\|lose)/finalization-abandoned`, `degraded:true` | publish/coach 논리 증거와 review 생성/게시 완료 요구 | 위 process-death tier. result를 abort로 바꾸지 않는다 |

두 경로 모두:

- 어떤 파일/queue/attempt도 삭제하지 않는다.
- `unresolvedEvidence`에 각 미해소 행의 kind/handNo/generation/queueId/session-상대경로/digest를 보존한다.
- `notices`에 한국어 degraded 고지를 남기고 `session-control status`가 `terminal.degraded: true`로 노출한다.
- review 준비 완료를 주장하지 않는다.
- `--expect-game-id`가 pinned current gameId와 다르면 `EXPECT_GAME_ID_MISMATCH`, flag 없이 evidence가 더러우면 `ABANDON_CONSENT_REQUIRED`다.
- 두 flag 동시 지정은 `USAGE`다. active engine에는 `--abandon-current`만, 자연 win/lose에는
  `--abandon-finalization`만 유효하다. 후자는 Q6/Q7의 논리 증거와 review 완료 요구를
  우회하지만 Q1~Q5b/Q8 process-death tier는 우회하지 않는다.

## 10. terminal

### 10.1 분류 matrix

lifecycle은 terminal 요청 전에 다음을 순서대로 적용한다. 첫 일치 행이 답이다.

| # | 관찰 | 허용 terminal |
|---|---|---|
| 1 | `lifecycle-session.terminal` 존재 | 같은 값의 idempotent 확인만. 다른 값은 `TERMINAL_CONFLICT` |
| 2 | `lifecycle-terminal.json` 존재 | 새 요청 금지. exact intent recovery(§10.4)만 |
| 3 | liveness 또는 writers에 `unknown`/non-released 존재 | 없음 — `QUIESCENCE_UNCONFIRMED`/`WRITER_QUIESCENCE_UNCONFIRMED` |
| 4 | **foreign** store loop 또는 foreign session-local loop 또는 server가 `alive` | 없음 — `ACTIVE_GAME`/`LOOP_ALIVE`/`SERVER_ALIVE`. caller가 제시한 exact live storeLoopHandle과 같은 owner는 terminal authority이고 blocking liveness가 아니다. 모든 terminal core 진입 전 server/listener/lock은 dead/retired여야 한다 |
| 5 | `enginePhase === 'game-over-abort'` | `aborted/abort/(user-abort\|force-new-game\|abandoned)` — engine mutation 없이 idempotent |
| 6 | `enginePhase ∈ {game-over-win, game-over-lose}` 또는 `loopPhase ∈ {finalizing, review_generated, review_published}` | 정상 finalization의 `completed/normal`만. abort/force는 `RESUME_REQUIRED`. 명시적 `--abandon-finalization`은 `completed/finalization-abandoned` |
| 7 | `loopPhase === 'done'` ∧ terminal 없음 | `TERMINAL_CONFLICT` — done인데 terminal이 없으면 새 게임을 허용하지 않는다 |
| 8 | `enginePhase === 'active'` ∧ `loopPhase ∈ {absent, bootstrap, playing}` ∧ guard clean | `aborted/abort/(user-abort\|force-new-game\|abandoned)` |
| 9 | 8과 같으나 guard dirty | 기본 거부(`RESUME_REQUIRED`). `--abandon-current` 동의 시 `degraded:true` abort |

행 6이 D5의 기계적 구현이다. 자연 승패와 finalization phase는 어떤 flag로도 `result: 'abort'`가 되지 않는다.

### 10.2 terminal begin/finish core

입력: pinned `{layout, gameId, operationId, sessionRel, manifestSha256, currentSha256}` + `intent`.

```text
C0. (transaction 밖, observation-only) §10.1 matrix 판정, server/listener와 모든 writer
    quiescence 확인. `WriterQuiescenceReceipt`와 engine stateVersion을 읽되 mutation/seal 없음
C1. foundation `transitionLifecycleArtifacts` 호출
      · mutations 배열의 첫 항목으로 lifecycle-terminal step:'intent' write를 선언
      · current digest 재확인 (currentSha256 CAS)
      · writer ledger/receipt/open execution generation digest 재확인
      · lifecycle-session terminal 부재 재확인
      · lifecycle-terminal.json 부재 재확인
      · 같은 transaction에서 execution generation terminal-seal + aborted terminal-engine
        lease와 matching reserved writer row 원자 발급
    transaction 해제
C2. intent.kind === 'aborted' 인 경우에만:
      terminal writer runner가 reserved row를 bind/claim하고 GO 뒤 engine/cli.js abort-from-intent
        --game-dir <sessionDir> --store-dir <storeDir>
        (native)  --expect-game-id <id> --expect-operation-id <op> --manifest-file <m> --expect-current-sha256 <hex>
        (legacy)  --expect-game-id <id> --legacy-capability-file <cap>
        --intent-digest <intentSha256> --expect-version <expectedStateVersion>
      engine은 session .mutex 아래에서 result를 'abort'로 멱등 변경한다.
      첫 적용은 state에 `abortIntentSha256=intentSha256`을 함께 기록하고 saveState가
      stateVersion을 정확히 +1 한다. 이미 abort이고 digest가 같으면 no-op과 현재 version.
      이미 abort이고 abortIntentSha256가 absent(legacy/pre-slice abort)이면 engine mutation을
      건너뛰고 journal에 `engineDisposition:'preexisting-abort'`와 observed current version을
      기록한다. digest가 존재하면서 다르면 TERMINAL_CONFLICT다.
    child/process-group death 뒤 terminal lease+writer row를 released CAS하고 transaction 아래
    step:'engine', engineAppliedStateVersion=<returned version> 기록
C3. foundation `transitionLifecycleArtifacts` 호출
      · current/manifest digest 재확인
      · aborted는 `(digest 일치) OR (engineDisposition:'preexisting-abort' ∧ digest absent)`와
        engineAppliedStateVersion 및 terminal lease/writer row released 재확인
      · completed는 result win|lose + expectedStateVersion 불변 재확인(C2/engine step 금지)
      · lifecycle-session-<gameId>.json 의 terminal 을 intent 그대로 commit
      · step:'session' 기록
    transaction 해제
P1. `.player-sessions.json`을 idempotent unlink하고 journal step:'player-cleanup' 기록.
    unlink 오류는 cleanupFailedAt을 남기고 lock/journal을 유지하며 recovery가 재시도한다.
CALLER/D1. tools owner가 loop-state.json에 phase:'done', finishedAt, completion을 기록한다.
        normal finalization은 requestStop finalStatePatch가, 외부 abort/force는 lifecycle이 쓴다.
        engine layer는 loop-state를 쓰지 않는다.
F1. finishTerminalCore가 done 관찰과 lifecycle-session terminal/intention digest를 재검증하고
    foundation `transitionLifecycleArtifacts`로 journal step:'done' 기록
F2. foundation `transitionLifecycleArtifacts`로 lifecycle-terminal.json 제거
F3. caller 정책에 따라 store loop lock 해제 (D4); force는 해제하지 않음
```

- `abort-from-intent`는 engine의 유일한 abort mutation 표면이다. gameId·capability·intent digest·expected stateVersion 중 하나라도 다르면 mutation 전에 거부한다.
- `abort-from-intent` 자체도 observed state가 이미 `gameOver:true,result:win|lose`이면
  `TERMINAL_CONFLICT`로 무쓰기 거부한다. lifecycle 분류를 우회한 호출도 자연 결과를
  abort로 덮어쓸 수 없다.
- `completed` intent는 C2를 건너뛰고 pinned `state.json`을 read-only로 검증만 한다(`gameOver === true` ∧ `result ∈ {win, lose}` ∧ `stateVersion === expectedStateVersion`).
- C1이 **cross-file mutation 이전의 첫 write**다. engine을 먼저 바꾸는 순서는 금지한다.
- Lifecycle은 foundation transaction mutex를 직접 획득하지 않는다. C1/C3/F1/F2의 current,
  descriptor, writer ledger 및 lifecycle artifact digest precondition은 foundation의 한
  transaction-bound API 호출 안에서 첫 mutation 전에 전부 검증된다. C2 child는 transaction
  밖에서 실행되고 session mutex 해제/child 종료 후에만 다음 transition 호출을 한다.

### 10.3 crash truth table

`J`=lifecycle-terminal.json, `E`=engine result, `S`=lifecycle-session.terminal, `D`=loop-state done, `R`=journal 제거, `L`=lock 해제.

| crash 지점 | J | E | S | D | 재진입 관찰 | 복구 |
|---|---|---|---|---|---|---|
| C0 중/직후 | 없음 | 미변경 | 없음 | 미변경 | observation만 수행, execution open | §10.1/C0 처음부터 |
| C1 temp→rename 사이 | 없음 | 미변경 | 없음 | 미변경 | terminal 요청 흔적 없음 | §10.1 처음부터. engine 불변 |
| C1 journal write 후 seal/lease 전 | `intent` | 미변경 | 없음 | 미변경 | journal intent + execution open | 같은 transition preconditions로 seal/lease roll-forward 후 C2 |
| C1 직후 | `intent` | 미변경 | 없음 | 미변경 | journal step=intent + execution sealed | C2부터 재실행 |
| C2 engine 적용 전 | `intent` | 미변경 | 없음 | 미변경 | engine result != abort | `abort-from-intent` 재실행(멱등) |
| C2 engine 적용/skip 후, step 기록 전 | `intent` | abort | 없음 | 미변경 | digest 일치 또는 preexisting-abort+digest absent | disposition/version과 함께 step을 `engine`으로 올리고 C3 |
| C2 step 기록 후 | `engine` | abort | 없음 | 미변경 | — | C3부터 |
| C3 commit 전 | `engine` | 확정 | 없음 | 미변경 | — | C3 재실행 |
| C3 commit 후, step 전 | `engine` | 확정 | 확정 | 미변경 | session terminal == intent | step을 `session`으로 올리고 P1 |
| P1 cleanup 전/실패 | `session` | 확정 | 확정 | `phase != done` | player session 존재 가능 | cleanup 재실행; 실패면 lock 유지 |
| P1 cleanup 후, step 전 | `session` | 확정 | 확정 | `phase != done` | player session absent | step을 `player-cleanup`으로 올리고 D1 |
| D1 loop-state 쓰기 전 | `player-cleanup` | 확정 | 확정 | `phase != done` | — | D1 재실행 |
| D1 쓰기 후, step 전 | `player-cleanup` | 확정 | 확정 | `done` | done + intent 일치 | step을 `done`으로 올리고 F1 |
| F2 전 | `done` | 확정 | 확정 | `done` | 전부 일치 | journal 제거만 |
| F2 후, F3 전 | 없음 | 확정 | 확정 | `done` | 완결 | lock 해제만 |
| 임의 지점, intent와 관찰 불일치 | 임의 | 임의 | 임의 | 임의 | digest/stateVersion/gameId mismatch | `TERMINAL_CONFLICT` fail-closed. 아무것도 되돌리지 않는다 |

멱등성 근거: 모든 단계가 `{gameId, operationId, intentSha256, expectedStateVersion, currentSha256, manifestSha256}` 전체 일치를 전제로만 전진하고, 각 단계는 이미 적용된 상태를 no-op으로 인식한다.

위 C2/`engine` 행은 aborted intent 전용이다. completed intent에서 journal step
`intent`를 보면 C2를 호출하거나 `engine` step을 쓰지 않고 곧바로 C3으로 간다.
completed의 E는 전 행에서 original win|lose/version 불변이다. aborted C3는
expected+1을 가정하지 않고 journal `engineAppliedStateVersion`과 state의
abortIntentSha256를 권위로 쓴다. 단, journal이 `engineDisposition:'preexisting-abort'`를
기록한 legacy/pre-slice 행은 digest absence 자체를 고정된 관찰값으로 재확인한다.

### 10.4 journal recovery 진입점

`lifecycle-terminal.json`이 존재하는 store에서 new/resume/abort/force/status 어떤 진입점이든:

1. `status`는 recovery를 하지 않고 `pendingTerminal`로 보고만 한다(read-only).
2. mutation 진입점(new/resume/force/abort)은 자신의 작업 전에 §10.3에 따라 core를 완주시킨다.
3. 완주 후 `lifecycleTerminal`이 확정되므로 resume은 `SESSION_TERMINAL`, new/force는 정상 진행이다.
4. journal의 `gameId`가 current의 gameId와 다르면 `TERMINAL_CONFLICT`이고 자동 복구하지 않는다.

## 11. force quiescence

pinned previous descriptor `P = {layout, gameId, operationId, sessionDir, manifestFile, currentSha256, legacyCapabilityFile?}` 하나로만 수행한다. store root에서 `lock.json`을 찾지 않는다. current resolve 실패는 early return이 아니라 `BAD_CURRENT_SESSION`이다.

### 11.1 pre-lock 순서

| # | 대상 | 절차 | 실패 코드 |
|---|---|---|---|
| Q1 | store loop owner | absent/dead는 already-quiesced 무신호 성공, unknown은 거부, alive면 `assertSameLoopOwner`(pid+startTime) → SIGTERM → `forceStopMs`(5s) identity death 확인 → 재확인 후 SIGKILL → `forceKillMs`(200ms) 확인 | `LOOP_IDENTITY_CHANGED`/`LOOP_IDENTITY_MISMATCH`/`LOOP_IDENTITY_UNAVAILABLE`/`LOOP_SIGNAL_FAILED`/`LOOP_ALIVE` |
| Q2 | session-local loop owner (`sessionRel !== '.'`) | Q1과 같은 closed liveness table을 `<sessionDir>/loop.lock.d`에 적용 | 동일 코드. store owner와 동시에 alive면 진입 전 `MULTIPLE_LOOP_OWNERS` |
| Q3 | store loop lock 획득 | `acquireOwnedLock(storeDir,'loop.lock.d')` | `LOCKED`/`LOOP_LOCK_UNKNOWN`/`LOOP_LOCK_UNRECLAIMABLE` |
| Q3b | current CAS 재-pin | Q3 직후 current를 다시 resolve해 tentative previous의 currentSha256/gameId/operationId와 동일한지 확인 | `CURRENT_CHANGED`; Q4 이하 실행 금지 |

### 11.2 post-lock 순서

Q4 이하만 현재 `storeLoopHandle`을 보유한 채 실행한다. Q1/Q2를 재실행하지 않으며
held handle의 pid+startTime과 같은 identity는 signal 대상에서 구조적으로 제외한다.

| # | 대상 | 절차 | 실패 코드 |
|---|---|---|---|
| Q4 | previous session server | loop 사망 확인 **후에** pinned capability와 per-session server binding으로 state의 expected sessionToken을 다시 읽고 `<sessionDir>/lock.json`을 pin → lock token과 timing-safe equality 확인 → pid+startTime/listenerOwnedBy → authenticated `/api/identity` tuple가 pinned descriptor와 **previous binding의 bootId/serverGeneration/leaseId**와 같은지 확인 → TERM/KILL death → pinned lock/binding/lease retire. token mismatch/unreadable이면 signal 없음 | `BAD_SERVER_LOCK`/`SERVER_TOKEN_MISMATCH`/`SERVER_LISTENER_*`/`SERVER_AUTH_*`/`SERVER_IDENTITY_*`/`SERVER_ALIVE`/`SERVER_LOCK_REPLACED` |
| Q5 | durable mutation writers/execution leases | writer ledger의 engine/publisher/coach-control rows와 execution artifact의 server lease, §5.11 binding을 process-group pid+startTime 종료·사망 확인 후 released/retired CAS. generation은 **seal하지 않고 open 유지** | `WRITER_QUIESCENCE_UNCONFIRMED`/`EXECUTION_LEASE_ACTIVE` |
| Q5b | persisted coach LLM worker | 현행 game-loop `parsePersistedCoachHandle` 의미를 shared helper로 추출해 `.coach-authority.json`의 `pid:startTime`을 검증하고 identity 사망까지 종료. 확인 불가 행은 남긴다 | `COACH_HANDLE_UNRESOLVED` → `QUIESCENCE_UNCONFIRMED` |
| Q6 | 임시 relay (필요 시) | 같은 sessionToken·같은 `sessionDir`로 `server/server.js` 재기동 → `.publish-attempt.json` `--retry` → coach `publishQueue` 각 행을 `exactEnvelopePath`로 게시 → `coach-control reconcile` → **relay 정지 및 lock retirement를 Q4와 같은 ladder로 수행** | 위 server 코드 + `PUBLISH_*` |
| Q7 | 논리 증거 | abandoned/new/abort와 동일한 `observeGuard`: rollback-guard ok + publishAttempt false + coach active/queued/cleanupPending 모두 0 | `ROLLBACK_REFUSED`/`RESUME_REQUIRED` |
| Q8 | listener/lock retirement 확정 | `<sessionDir>/lock.json` 부재, 기록된 port에 live listener 없음, `hasLiveLockHolder(sessionDir) === false` | `QUIESCENCE_UNCONFIRMED` |
| Q9 | terminal commit | §10.2 core, `aborted/abort/force-new-game` | §10 코드 |

Q1~Q5b, Q8은 **필수**다. Q6·Q7만 engine 상태에 맞는 exact consent
(`--abandon-current` 또는 `--abandon-finalization`)로 우회 가능하며, 그때도 Q6에서 띄운
relay가 있었다면 그 relay의 사망·lock retirement(Q4 ladder)는 반드시 확인한다.

`hasLiveLockHolder`의 publish lock은 현행 1줄 pid-only 계약을 유지한다. PID reuse는
false-dead가 아니라 false-live로 force를 차단하는 availability failure이므로 우회하지
않고 `QUIESCENCE_UNCONFIRMED`로 남긴다.

### 11.3 force commit point 두 개

| 지점 | 실패 시 상태 |
|---|---|
| old terminal commit **전** 실패 | old `lifecycle-session`/current/manifest 불변, 신규 session namespace 불변. store loop lock만 해제하고 종료 |
| old terminal commit **후** 신규 allocate/pointer 실패 | current는 old terminal session을 계속 가리킨다. pending journal이 있으면 foundation §11로 roll-forward. old terminal을 되돌리지 않으며 데이터 손실도 active 오판도 아니다 |

두 지점 사이에서 store loop lock은 계속 보유한다.

## 12. legacy 채택과 migration

### 12.1 자동 채택 precondition (전부 참)

1. capsule `current.json`이 `layout: none` sentinel이고 `selectionVersion === 0`이다.
2. `pending-session.json`, `last-operation.json`이 없다.
3. 최초 채택 시작 시 `lifecycle-legacy-session.json`, `lifecycle-legacy-binding.json`,
   `lifecycle-session-*.json`, `lifecycle-terminal.json`이 없다. 단 current none + matching
   halt:null `launch.phase:'legacy-binding'` + same operationId의 manifest/binding 일부 존재는
   두 번째 auto-adoption이 아니라 §12.2 in-flight recovery로 허용한다. matching intent가
   없거나 last-operation legacy-selected 뒤 pointer가 없으면 `BAD_CURRENT_SESSION`이다.
4. `sessions/`가 없거나 비어 있다.
5. store root에 top-level `session.json`이 없고, store root realpath가 어떤 capsule `sessions` realpath의 자손이 아니다(foundation §7.1).
6. store root에 legacy 보존 신호가 하나 이상 있다: `state.json`, `review.md`, 실제 `hands/hand-*.json`, `ui-snapshot.json`.

하나라도 어긋나면 자동 채택하지 않는다. 특히 2·3 중 하나라도 있는데 current가 `none`이면 `BAD_CURRENT_SESSION`이며 §12.4 수동 복구만 허용한다(D7).

### 12.2 채택 절차

```text
1. store loop lock 보유 상태에서 legacy 신호 전수 관찰 (§5.6 signals)
2. 새 gameId, operationId(UUID v4) 생성
3. lifecycle-launch를 `phase:'legacy-binding'`, 같은 gameId/operationId와 signals digest로
   CAS 기록. 이것이 manifest/binding 전 첫 durable adoption intent다.
4. lifecycle-legacy-session.json, lifecycle-legacy-binding.json을 foundation artifact API로 기록
5. foundation selectLegacySession({storeDir, expectedCurrentSha256, gameId, operationId,
     legacyManifestFile, legacyBindingFile})
     → capsule lifecycle-legacy-capability-<operationId>.json 기록 + legacy current CAS write
     → last-operation outcome 'legacy-selected'
6. lifecycle-session-<gameId>.json 생성 (adoptedAt 설정, terminal null)
7. launch를 session-ready로 갱신. 이후 모든 child 는 --legacy-capability-file 로 독립 재검증
```

어떤 legacy 파일도 이동·복사·삭제하지 않는다. store root에 `session.json`을 만들지 않는다. `archive/`와 `.partial`은 읽지도 병합하지도 승격하지도 않는다.

crash recovery: launch `legacy-binding`과 같은 operationId가 있으면 manifest-only,
binding-only, 둘 다 존재, current pre/post-select를 정확히 재검증해 4~7을 재실행한다.
두 파일이 생겼지만 current가 none인 상태는 두 번째 auto-adoption이 아니라 기존 intent
recovery다. `session-control recover --expect-layout legacy-root`도 matching inspection
receipt로 이 첫 select를 완결할 수 있다. `last-operation:legacy-selected` 이후 current가
소실된 경우에만 D7의 일반 pointer-loss fail-closed 규칙을 적용한다.

### 12.3 migration matrix

| legacy root 상태 | 채택 | 채택 후 판정 | notice |
|---|---|---|---|
| `state.json` active, loop/server dead, guard clean | 예 | `enginePhase: active`. resume 요청이면 그대로 bind. 신규 요청이면 §9.6 abandoned 수렴 후 신규 session | — |
| `state.json` active, loop 또는 server alive | 예 | `ACTIVE_GAME`(non-force) / §11 force ladder | — |
| `state.json` `gameOver: true, result: 'abort'` | 예 | terminal 없음 → core가 `aborted/abort/abandoned`를 engine mutation 없이 멱등 기록 | — |
| `state.json` `gameOver: true, result: 'win'` | 예 | `completed/win/normal` 후보. `loopPhase`가 `done`이면 즉시 terminal commit, 아니면 `RESUME_REQUIRED`(finalization 미완) | — |
| `state.json` `gameOver: true, result: 'lose'` | 예 | 위와 동일, `lose` | — |
| `loop-state.phase ∈ {finalizing, review_generated, review_published}` | 예 | `RESUME_REQUIRED`. abort 금지(D5) | `LEGACY_FINALIZATION_PENDING` |
| `loop-state.cleanupFailedAt` 존재 | 예 | `RESUME_REQUIRED` | `LEGACY_CLEANUP_FAILED` |
| `state.json` malformed/unparseable, 다른 보존 신호 존재 | 예 | `resumability: repair-required`. resume 불가, 신규 게임은 `aborted/abort/abandoned` 수렴 없이 **terminal을 쓰지 않고** legacy current를 그대로 둔 채 신규 native session으로 pointer 전환 | `LEGACY_REPAIR_REQUIRED` |
| `state.json` 없음, `review.md`만 | 예 | 위와 동일(보존 전용). privacy proof unverified이므로 practice-focus는 unavailable | `LEGACY_REPAIR_REQUIRED` |
| `state.json` 없음, `hands/hand-*.json`만 | 예 | 보존 전용 | `LEGACY_REPAIR_REQUIRED` |
| `state.json` 없음, `ui-snapshot.json`만 | 예 | 보존 전용 | `LEGACY_REPAIR_REQUIRED` |
| 보존 신호 없음, `archive/`만 존재 | 아니오 | pristine empty store로 계속. 신규 native session | — |
| capsule metadata 존재 + current 소실 | 아니오 | `BAD_CURRENT_SESSION` fail-closed | — |
| 기존 legacy manifest 존재 + current 소실 | 아니오 | `BAD_CURRENT_SESSION` fail-closed | — |
| 기존 legacy manifest 존재 + current가 다른 gameId를 legacy로 지목 | 아니오 | `LEGACY_BINDING_CONFLICT` | — |
| `rootDev`/`rootIno`가 binding과 다름 | 아니오 | foundation `STALE_SESSION_CAPABILITY` | — |
| store root에 top-level `session.json` 존재 | 아니오 | `BAD_DIRECTORY_MODE` | — |

"보존 전용" 행은 legacy session을 terminal로 만들지 않는다. launcher step 8의
`PREV_PRESERVED_UNRECOVERABLE` action이 process/writer death와 observeGuard를 먼저 적용한 뒤
current를 신규 native session으로 옮기고 legacy tree는 그대로 남긴다. dirty evidence는
reconcile 또는 exact audited abandon 전에는 pointer를 바꾸지 않는다. 그 legacy
`lifecycle-session-<gameId>.json`은 `terminal: null`, `notices: ["LEGACY_REPAIR_REQUIRED …"]`로 남는다.
대신 `activeEligible:false, disposition:'preserved-unrecoverable'`를 기록하며 active-game
catalog는 오직 current selector가 지목하고 `activeEligible !== false`인 session만 센다.
따라서 보존 artifact가 두 번째 active game으로 열거되지 않는다. malformed state라도 live
loop/server/writer가 있으면 liveness/process-death 행이 schema 분류보다 먼저 적용되어 pointer
전환은 금지된다.

업그레이드 중 live legacy는 non-force attach 성공으로 간주하지 않는다. status는
`ACTIVE_GAME`/`LEGACY_SERVER_RESTART_REQUIRED`를 보고하고 dealer 문서는 identity-checked
stop/force를 안내한다. force가 §5.6 legacy-v0 witness로 old process를 retire한 뒤에만 새
schema server binding을 만들 수 있다.

### 12.4 inspect/recover의 좁은 범위

```bash
node tools/session-control.js inspect --store-dir game --receipt-file <path>
node tools/session-control.js recover --store-dir game \
     --inspection-receipt <path> --expect-game-id <uuid> --expect-layout native|legacy-root
```

`recover`는 store loop ownership을 먼저 획득하고 live store/session loop, server,
`SERVER_PRESENCE_UNKNOWN`, publish holder가 있으면 거부한다. 허용 mutation은 셋뿐이다.
current가 none이 아니거나 pointer publish 가능성이 있는 operation은
`proveMutationWritersQuiesced` receipt까지 요구한다. pending/legacy select가 current를
바꾸기 전에도 old current의 receipt 또는 `layout:none` 증명이 없으면 거부한다.

1. foundation `pending-session.json`이 있는 operation을
   classifyPendingRecovery→foundation API로 완결.
2. valid `layout:none` current와 matching `lifecycle-launch.phase:legacy-binding`이 있는
   unfinished **첫** legacy select를 같은 operationId로 `selectLegacySession`까지 완결.
3. exact current의 loop-state가 done인데 lifecycle terminal/journal이 없고, pinned engine이
   gameOver win|lose이며 loop completion result/version이 같은 inspection receipt. full
   writer/server quiescence와 CAS를 재검증한 뒤 `completed/<result>/normal` terminal core를
   engine mutation 없이 생성하고 P1/D1/F1/F2로 완결한다. 불일치는 `TERMINAL_CONFLICT`.

published native/legacy current file이 missing/torn이거나 `last-operation`만 남은 상태에서
기존 final을 선택하는 restore는 foundation API가 없으므로 `POINTER_RESTORE_UNSUPPORTED`로
fail-closed한다. lifecycle이 current를 직접 쓰거나 sessions scan으로 선택하지 않는다.
inspection receipt는 current가 unreadable해도 raw current status와 candidates를 read-only로
보고할 수 있지만 mutation 권한을 만들지 않는다. 하나라도 CAS가 다르면
`STALE_INSPECTION`이다.

### 12.5 pending response-loss dispatch

`recoverPendingOperation`은 foundation classifier action을 다음처럼 빠짐없이 소비한다.

| action | lifecycle call |
|---|---|
| `create_staging` | `ensureStagingForOperation` |
| `preserve_and_recreate` | `preserveIncompleteStaging` → `ensureStagingForOperation` |
| `initialize_engine` | pending-authorized `init-staging` runner |
| `complete_extensions` | launch.previous로 `extractPracticeFocus` → optional `writeSecureExtension`; 그 뒤 receipt 포함 재분류 |
| `commit_ready|promote|select|cleanup_journal` | exact receipts로 `commitPreparedSession` 재호출 |
| `manual_recovery_required|bad_session_store` | fail-closed, 자동 mutation 없음 |
| `current_changed` | `CURRENT_CHANGED` |

recovery가 `complete_extensions` 이후 publish까지 끝냈으면 같은 operation의 launcher step 8~10은
no-op하고 step 11 lifecycle bind로 간다. first-game `launch.previous:null`은
`pending.previousCurrentSha256 === current none-sentinel digest`를 비교하며 존재하지 않는
`previous.currentSha256`를 요구하지 않는다. takeover는 기존 launch.previous/reviewSha256를
보존한다.

## 13. practice-focus 추출

### 13.1 요구 extension 선언

`allocateSession`의 `requiredExtensions`는 정확히 다음 한 항목이다.

```json
[ { "name": "practice-focus", "relativePath": "practice-focus.json", "required": false, "maxBytes": 4096 } ]
```

`required: false`는 의도적이다. predecessor review가 없거나 해당 section이 없을 때 파일과 receipt를 **둘 다 생략**해야 하고, foundation은 optional extension에 대해 정확히 그 규칙(둘 다 없을 때만 생략, 한쪽만 있으면 실패)을 강제한다.

### 13.2 source 결정

| previous | source |
|---|---|
| `null`(`layout:none`) | 없음 → `state: 'absent'` |
| `native` | `<previousSessionDir>/review.md` |
| `legacy-root` | `<storeDir>/review.md` |

source는 `lifecycle-launch.json.previous.reviewRel`/`reviewSha256`에 crash-durable하게 기록된다. cold recovery는 이 경로를 다시 읽어 digest가 같은지 확인한다. 다르면 `state: 'unavailable'` + notice이고 신규 session을 삭제하지 않는다.

privacy deny-source set(`players.json`과 relevant hand records)이 모두 schema-valid하게 읽힌
경우만 verified다. truly empty history는 explicit count:0 receipt로 verified한다. missing,
malformed, unreadable 또는 repair-required predecessor는 review가 있어도 privacy proof가
unverified이므로 `state:'unavailable'`로 extension을 생략한다. evidence 부재를 private literal
부재로 간주하지 않는다.

previous session은 이 시점에 이미 quiesced(신규·force) 또는 terminal이므로 `review.md`는 불변이며 재추출은 결정적이다.

### 13.3 heading 규칙

1. 대상 heading 정규식은 현행 `REVIEW_HEADING_PATTERNS`의 네 번째와 동일하다: `/^#{1,6}[ \t]+다음 게임에서 연습할 것(?:[ \t]|$)/m`.
2. 개행은 먼저 CRLF→LF로 정규화한다.
3. 그 heading 줄 **다음 줄**부터, 임의 level의 다음 ATX heading(`/^#{1,6}[ \t]/m`) 직전까지 또는 EOF까지가 본문이다.
4. 본문의 선행·후행 공백 줄을 제거한다. 내부 구조는 보존한다.
5. heading이 여러 번 나오면 **첫 번째**만 쓴다.
6. heading이 없거나 본문이 빈 문자열이면 `state: 'absent'`이고 파일을 만들지 않는다.
7. 다른 세 heading(`내 성향 통계`, `결정적 핸드`, `각 AI의 실제 아키타입 공개 + 읽기 평가`)의 본문은 어떤 경우에도 포함하지 않는다.

### 13.4 4096-byte cap

`stableJson(§5.7 body)`의 UTF-8 octet 길이가 4096 이하가 될 때까지 `focus` 문자열을 **코드 포인트 경계**에서 잘라낸다. 잘렸으면 `truncated: true`로 기록한다. 자른 뒤에도 4096을 넘길 수 없는 구조(고정 field만으로 초과)는 발생하지 않지만, 발생하면 `state: 'unavailable'`로 파일을 만들지 않는다.

파일 쓰기는 foundation `writeSecureExtension({storeDir, operationId,
expectedPendingSha256, name:'practice-focus', content: bodyObject})`만 사용한다. `content`는
serialized string이 아니라 §5.7 object이고 foundation이 stableJson을 정확히 한 번 적용한다.
file bytes는 `stableJson(bodyObject)`와 같아야 한다. lifecycle은 임의 fs writer로
extension을 쓰지 않는다.

### 13.5 forbidden-literal 거부

추출된 `focus` 본문이 predecessor의 비공개 literal을 하나라도 포함하면 **파일을 만들지 않고** `state: 'rejected'` + `PRACTICE_FOCUS_REJECTED` notice를 남긴다. 신규 session은 삭제하지 않는다.

deny 목록은 현행 `coachForbiddenLiterals`와 같은 원천에서 만든다.

- predecessor `players.json`의 `user` 아닌 각 항목에서 `COACH_PRIVATE_FIELDS = ['archetype','personality','bluffFreq','threeBetFreq','tiltProne']`의 비어 있지 않은 값.
- predecessor `state.json.lastHand` 및 `hands/hand-*.json` 전체의 `holes` 중 `user`가 아니고 그 핸드의 `showdown.reveals`로 공개되지 않은 카드 문자열.

비교는 부분 문자열 포함이고 대소문자를 구분한다. deny 목록이 비면(플레이 기록이 없는 predecessor) 거부 검사를 생략한다.

### 13.6 상태 전이와 crash

| 시점 crash | 관찰 | 복구 |
|---|---|---|
| launch `previous` 기록 전 | launch에 previous 없음 | 재실행 시 current에서 다시 pin |
| 추출 후 `writeSecureExtension` 전 | staging `.extensions/` 비어 있음 | 같은 source·digest로 재추출(결정적) |
| extension temp→rename 사이 | foundation이 미등재 temp를 감지 | `PRESERVE_REQUIRED` → preserve 후 재생성 |
| extension 기록 후 `extensions_ready` 전 | receipt 재계산 가능 | `classifyPendingRecovery.observed.extensionReceipts`로 그대로 commit |
| commit 후 | `.session-ready.json.extensions`에 digest 고정 | 완결 |

pointer commit 직전/직후 어느 crash에서도 focus digest는 같다.

### 13.7 reader 변경

`tools/game-loop.js::buildCoachPrompt`의 읽기 경로를 `<root>/.practice-focus.json`에서 `<root>/.extensions/practice-focus.json`으로 바꾸고, 파싱해 `focus` field만 프롬프트에 인라인한다(전체 JSON을 넣지 않는다). 파일 부재는 지금처럼 `'없음'`이다.

`tools/game-loop.js`의 `--practice-focus-file` argv와 `fs.copyFileSync` 경로는 제거한다. dealer가 review에서 문자열을 뽑아 `game/` 밖에 쓰던 절차도 제거한다 — source가 하나로 줄고, 모델 유래 문자열이 argv에 실릴 마지막 표면이 사라진다.

## 14. status와 boot handshake

### 14.1 `session-control status` 출력

```json
{
  "ok": true,
  "storeId": "8c36ea07-9a62-4d64-8b35-f186535ac923",
  "current": {
    "layout": "native",
    "gameId": "ef6ec0a9-a851-4e88-853a-7bfd4d95e63b",
    "operationId": "4d970d18-6984-4e97-b64f-aa72e04baa02",
    "sessionRel": ".session-store.lock.d/sessions/ef6ec0a9-a851-4e88-853a-7bfd4d95e63b",
    "selectionVersion": 3,
    "currentSha256": "<hex>"
  },
  "launch": { "bootId": "<uuid>", "mode": "new", "phase": "session-ready",
              "gameId": "<uuid>", "halt": null },
  "locks": { "storeLoop": "alive", "storeLoopPid": 41231,
             "sessionLoop": "absent", "sessionLoopPid": null,
             "server": "alive", "serverPidAlive": true, "serverIdentityMatch": true,
             "port": 8877, "publishLockLive": false },
  "loop": { "gameId": "<uuid>", "operationId": "<uuid>", "bootId": "<uuid>",
            "phase": "playing", "handNo": 4, "port": 8877,
            "sessionToken": "<token>", "startedAt": "…", "finishedAt": null,
            "halt": null, "cleanupFailedAt": null, "notices": [], "metrics": [] },
  "engine": { "stateVersion": 88, "phase": "flop", "toAct": "user",
              "gameOver": false, "result": null,
              "archiveStatus": "healthy",
              "sessionLocalLoopPidAlive": false },
  "terminal": null,
  "pendingSession": null,
  "pendingTerminal": null,
  "notices": []
}
```

- `sessionToken`은 dealer가 브라우저 URL을 만들기 위한 기존 허용 표면이다. store artifact(current/manifest/pending/journal)에는 절대 복제하지 않는다.
- `terminal`은 `lifecycle-session-<gameId>.json.terminal` 그대로.
- `current.layout === 'none'`이면 `current.gameId` 이하가 전부 `null`이고 `loop`/`engine`은 `null`이다.
- `status`는 read-only다. store loop lock도 transaction lock도 잡지 않고, recovery를 실행하지 않으며, `sessions/`를 scan하지 않는다.
- capsule/store root가 실제로 absent 또는 완전히 empty이면 mutation 없이
  `{ok:true,storeState:'absent',current:null,...}`를 반환한다. capsule은 없지만 legacy 보존
  신호가 있으면 `storeState:'legacy-uninitialized'`로 보고 current null을 반환한다. capsule
  일부/invalid metadata는 `BAD_SESSION_STORE`; status는 none sentinel을 만들지 않는다.
- status는 hot full-file digest가 아니라 closed identity tuple
  `{currentSha256,current.gameId/current.operationId,launch.bootId/phase/gameId,
  loop.gameId/operationId/bootId,serverBinding.bootId/serverGeneration/leaseId,
  lock pid/startTime/bootId/serverGeneration/leaseId,execution.generation/state,
  lifecycleTerminal presence+intentSha256}`를 S1/S2로 비교한다. lease maps, metrics, handNo,
  notices와 inspect-session payload는 equality에서 제외한다. identity tuple이 다르면 최대 3회
  전체 read를 재시도하고 계속 바뀌면 `STATUS_RACE`로 fail-closed한다. identity가 stable이면
  hot observational fields는 S2 identity에 결합된 last-writer-wins 값으로 반환한다.
- loop-state는 gameId/operationId/bootId를 포함하고 status는 current와 join한다. attach는
  current.gameId===loop.gameId이고 launch가 현재 operation을 가리키는 경우 launch.gameId도
  같아야 한다. A/B mixed aggregate를 ok로 반환하지 않는다.
- `engine` 블록은 새 concrete `engine/cli.js inspect-session` read-only 명령을
  capability와 함께 호출해 얻는다. 이 명령은 state/legal/hand-record presence만 읽고
  `rebuildArchive`, writeHandArchive, mutation lock, repair를 호출하지 않는다.
  mutating hand-record repair는 resume 진입의 기존 `resume-check`에만 남는다.
- status의 `archiveStatus`는 inspect-session의 `healthy|missing|unreadable`을 그대로 노출한다.
  `missing`/`unreadable`을 healthy나 repaired로 번역하지 않고 `archiveRepaired` field는
  제거한다. repair 여부는 resumeBound의 별도 resume-check 결과에서만 관찰한다.
- guard block은 observeGuard의 raw counts를 read-only 노출해 dealer가 stop 뒤
  `abort|abort --abandon-current|resume-to-drain`을 결정하게 한다.
- `MULTIPLE_LOOP_OWNERS` 조건이면 `ok:false`와 그 code로 fail-closed한다.
- `locks.server`는 `alive|absent|unknown|mismatch` closed enum이며 pinned lock,
  pid+startTime, listener ownership, expected token, `/api/identity`, per-session binding을 모두
  통과한 경우만 alive다. `serverPidAlive` boolean만으로 attach/success를 판정하지 않는다.

### 14.2 boot handshake

dealer는 launch 전에 current gameId(또는 부재)를 읽고 fresh `bootId`를 argv로 넘긴다.

```text
prevGameId = status().current.gameId            // 없으면 null
bootId     = fresh uuid v4
node tools/game-loop.js --store-dir game --boot-id <bootId> …
```

성공 판정식(전부 참일 때만 성공):

```text
S = status()
success_new    ≡ S.launch.bootId === bootId
               ∧ S.launch.phase  === 'session-ready'
               ∧ S.launch.halt   === null
               ∧ S.locks.storeLoop === 'alive'
               ∧ S.current.gameId !== null ∧ S.current.gameId !== prevGameId
               ∧ S.current.gameId === S.launch.gameId
               ∧ S.loop.gameId === S.current.gameId
               ∧ S.loop.operationId === S.current.operationId
               ∧ S.loop.bootId === S.launch.bootId
               ∧ S.loop.phase ∈ {playing, finalizing, review_generated, review_published}
               ∧ S.locks.server === 'alive' ∧ S.locks.serverIdentityMatch === true
               ∧ Number.isInteger(S.loop.port) ∧ S.loop.port > 0
               ∧ typeof S.loop.sessionToken === 'string' ∧ S.loop.sessionToken.length > 0
               ∧ S.loop.halt === null
               ∧ S.terminal === null

success_resume ≡ (위와 같되)  S.current.gameId === prevGameId
```

post-publish bind recovery를 `--ai`가 same gameId로 완성한 경우는 내부적으로
`success_resume` 판정식을 사용한다. 일반 새 게임은 반드시 다른 gameId다. `done`은 성공
phase가 아니며 matching lifecycle terminal을 completion으로 보고하고, terminal 없이 done은
`TERMINAL_CONFLICT`다.

명시적 부정:

- `S.launch.phase === 'starting'`은 성공이 아니다. `bootstrap`은 여전히 "기동 중"이다.
- `S.loop.phase === 'bootstrap'`은 성공이 아니다.
- 이전 session의 stale `terminal`, stale `phase:'done'`, stale `finishedAt`, stale `port`, stale `sessionToken`은 어떤 조합으로도 새 launch의 성공을 만족시키지 못한다. 새 launch는 반드시 **다른 gameId**를 요구하기 때문이다.
- `S.launch.bootId !== bootId`이고 store loop이 dead면 launch가 lock 획득 전에 실패한 것이다. `/tmp/ai-holdem-boot.log`와 stderr envelope로 판정한다.
- `S.launch.halt !== null` ∧ matching bootId → session 생성 전 실패. 그 code/message가 정본이다.
- `S.loop.halt !== null` → session 생성 후 실패. 그 code/message가 정본이다.

폴링 종료 조건(기존 §2 구조 확장):

1. matching bootId의 `launch.halt` 또는 `loop.halt` 기록.
2. `success_new` 또는 `success_resume` 성립.
3. `locks.storeLoop !== 'alive'`이고 위 둘 다 아님 → sidecar 사망. boot log로 판정.
4. `locks.storeLoop === 'alive'`이고 `launch.bootId !== bootId` → 이 호출이 소유한 launch가
   아니다. matching current가 이미 playing이면 attach 응답, 아니면 `ACTIVE_GAME`으로 즉시
   종료한다. foreign bootId를 기다리며 무한 poll하지 않는다.

## 15. CLI와 API 계약

### 15.1 `tools/game-loop.js` argv

```text
node tools/game-loop.js
  --store-dir <dir>              # 필수. store root. --game-dir alias 제거
  --boot-id <uuid v4>            # 필수
  ( --ai <1..8> | --resume )     # 필수 택일
  [--stack <int>] [--level-every <int>] [--blinds <SB/BB>]
  [--force]
  [--abandon-current --expect-game-id <uuid>]
  [--abandon-finalization --expect-game-id <uuid>]
  [--player-runtime claude|codex|grok]
```

제거: `--game-dir`(store alias), `--practice-focus-file`.
`--abandon-*`는 `--force` 또는 신규 launch에서만 유효하고 `--expect-game-id`를 반드시 동반한다. `--resume`과 `--force`/`--abandon-*` 동시 지정은 `USAGE`다.

### 15.2 `tools/session-control.js`

```text
node tools/session-control.js status  --store-dir <dir> [--boot-id <uuid>] [--expect-game-id <uuid>]
node tools/session-control.js stop    --store-dir <dir> --expect-game-id <uuid>
node tools/session-control.js abort   --store-dir <dir> --expect-game-id <uuid>
                                      [--abandon-current]
node tools/session-control.js abandon-finalization --store-dir <dir> --expect-game-id <uuid>
node tools/session-control.js inspect --store-dir <dir> --receipt-file <path>
node tools/session-control.js recover --store-dir <dir> --inspection-receipt <path>
                                      --expect-game-id <uuid> --expect-layout native|legacy-root
node tools/session-control.js downgrade-guard --store-dir <dir> --expect-game-id <uuid>
                                      [--receipt-file <path>]
node tools/session-control.js issue-rollback-lease --store-dir <dir> --expect-game-id <uuid>
                                      --receipt-sha256 <hex>
```

전 명령이 JSON 한 줄 envelope를 stdout에 낸다. 실패는 `{ok:false, code, message}`이며 exit 1(`USAGE`는 2)이다.

`downgrade-guard`는 mutation을 하지 않는다. 출력은 §21.4의 receipt다.

`stop`은 current와 store-loop owner를 pin하고 Q1/Q2 뒤 Q3 store lock acquire + Q3b current
CAS re-pin을 수행한 다음 process-death tier Q4/Q5/Q5b/Q8을 전부 실행한다. 즉 sidecar death 뒤 lock을 다시 pin해 authenticated
orphan server를 TERM/KILL+retire하고, lock이 없는 listener는 §5.11 bound server lease
identity로만 종료하며, writer/coach process-group death receipt까지 완성한다. Q6/Q7과
terminal/current mutation은 실행하지 않는다. engine/terminal/current는
바꾸지 않는다. start-game user abort 절차는 `stop` 성공 뒤 `abort`이며 dealer가 raw
PID에 직접 signal하지 않는다. `abort`는 새 store loop handle을 획득해 current CAS와
quiescence를 다시 확인한다. stop은 execution generation을 open으로 남기므로 이후 abort가
C1 terminal-engine lease를 만들거나 `--resume`이 fresh play/server lease를 발급할 수 있다.
successor resume/new가 Q3b 전에 current/binding을 바꾸면 `CURRENT_CHANGED`로 실패하고 그
successor identity에는 signal하지 않는다. stop 완료 후 exact handle을 해제한다.

### 15.3 `engine/cli.js` — concrete session only

`--game-dir`의 기본값 `'game'`을 제거해 필수 인자로 만든다. 모든 명령이 layout에 맞는 capability를 요구한다.

```text
# native capability (모든 명령 공통)
--store-dir <dir> --game-dir <sessionDir> --expect-game-id <uuid>
--expect-operation-id <uuid> --manifest-file <path>
( --expect-current-sha256 <hex>  |  --expect-pending-sha256 <hex> )

# legacy capability
--store-dir <dir> --game-dir <storeDir> --expect-game-id <uuid>
--legacy-capability-file <path>

# mutation 명령 추가 admission (argv에는 secret 없음)
--execution-generation <int> --lease-id <uuid> --lease-fd <fd>
```

| 명령 | capability | 비고 |
|---|---|---|
| `init-staging --ai N [--stack] [--blinds] [--level-every]` | native pending authorization + `--expect-pending-sha256` | staging 전용. published execution lease의 명시적 예외. store loop owner가 staging runner를 spawn하고 `resolveStagingSession`으로 pending/current/operation을 first I/O 전 검증. `.session-ready.json`/final/기존 engine state가 있으면 거부 |
| `step`, `new-hand`, `apply` | selected(`--expect-current-sha256`) 또는 legacy + execution lease | `resolveSelectedNativeSession`/`resolveLegacyConcreteSession` 뒤 first I/O 전 lease claim |
| `legal`, `view`, `hand`, `stats` | selected 또는 legacy | read-only, execution lease 불필요 |
| `inspect-session` | 위와 동일 | 완전 read-only; state/legal/hand-record presence와 `archiveStatus:healthy|missing|unreadable`만 반환, repair/lock/write 없음. status 전용 |
| `resume-check` | 위 + execution lease | mutating hand repair 가능; `loopPidAlive` → `sessionLocalLoopPidAlive`로 개명 |
| `abort-from-intent --intent-digest <hex> --expect-version <int>` | 위 + terminal 전용 execution lease | 유일한 abort mutation |
| `init` | — | 제거 |
| `end` | — | 제거 |

`init-staging`은 `engine/session-init.js::initializeStagingGame`의 얇은 CLI wrapper다. lifecycle은 이것을 **자식 프로세스로** 호출해 "상태 변경은 항상 `engine/cli.js` 서브커맨드를 거친다"는 기존 아키텍처 불변식을 유지한다. staging에는 `withMutation`/`runExclusive`를 쓰지 않아 `.mutex`를 만들지 않고, foundation `writeSecureStagingJson`으로 state/players/`.engine-ready.json`을 쓴다.
staging runner는 lifecycle-execution이 아직 없는 pre-publication 전용이며 store-loop handle,
operationId, expectedPendingSha256를 parent/child 양쪽에서 검증한다. parent death 뒤 child가
완료해도 unpublished staging만 남고 foundation classifier가 validate/preserve한다; current를
직접 publish할 권한은 없다. 일반 writerSpawner의 published lease/ledger 계약과 섞지 않는다.

### 15.4 `tools/publish.js`, `tools/coach-control.js`, `server/server.js`

- `--game-dir` 기본값 `'game'` 제거, 필수화. 값은 항상 concrete `sessionDir`.
- 위 §15.3의 capability flag를 동일하게 받고, 첫 I/O 전에 `session-capability.js`로 검증한다.
- publish/coach/server mutation은 이어서 §5.10 execution lease를 claim해야 하며, direct 실행도
  lease 없이는 첫 mkdir/read/write/listen 전에 실패한다.
- `server/server.js`는 target을 `mkdir -p`하지 않는다. session identity/state가 없으면 `NO_GAME`으로 거부한다.
- 모든 published-session writer도 concrete session root를 mkdir/recreate하지 않는다.
  game-loop `openLog`/canary와 runtime `writeJsonAtomic`의 recursive parent mkdir을 제거하고,
  missing/replaced root는 `NO_GAME`/`STALE_SESSION_CAPABILITY`다. atomic temp→rename은 기존
  parent 안에서만 수행한다. D9와 writerSpawner.run은 spawn 직전 root inode를 재검증한다.
- `server/server.js`는 `session-capability.js`만 추가 import한다(`engine/`·`tools/` import 금지).
- `server/server.js`는 capability에서 얻은 immutable identity를 lock과 authenticated endpoint에
  생산한다. `lock.json` strict schema는 기존 필드에 `gameId`, `operationId`(legacy도 selection operation UUID),
  `gameEpoch=sha256(sessionToken)`, `bootId`, `serverGeneration`, `leaseId`를 추가한다.
  token-authenticated `GET /api/identity`는
  `{gameId,operationId,gameEpoch,bootId,serverGeneration,leaseId}`만 반환하며
  `/api/snapshot`과 분리한다. Q4는 pinned
  lock token이 state expected token과 timing-safe equal인 경우에만 이 endpoint를 읽고,
  모든 identity field가 descriptor/per-session binding과 같아야 signal/retire할 수 있다.
- lock `startedAt`은 wall-clock spawn timestamp가 아니라 identity helper가 읽은 OS process
  startTime canonical string과 별도 `listeningAt`을 구분한다. pid reuse 검증은 startedAt을 쓴다.
- `publish.lock.d` 이름·의미·timeout·attempt 계약, `publish-contract.js` 상수, `gameEpoch = sha256(sessionToken)` 파생은 변경하지 않는다.
- coach의 `exactResultPath`/`exactEnvelopePath` 생성 규칙과 `assertExactFile` containment 검사는 변경하지 않는다. 기준 root가 concrete `sessionDir`이 된다.
- `coach-control watch-accept --publish` nested `spawnSync(tools/publish.js)` production 표면은
  제거하고 해당 flag는 `USAGE`로 거부한다. watch-accept는 result/envelope까지만 만들고,
  game-loop/Q6가 별도 writerSpawner publisher lease로 exact envelope를 게시한다.

### 15.5 `tools/session-lifecycle.js` API

lifecycle 내부 API. `session-control.js`와 `game-loop.js`의 launcher만 호출한다.

```js
// store 준비와 소유권
ensureStoreReady(storeDir): { storeId, currentSelector }
acquireStoreLoopOwnership({ storeDir, mode }): { handle, storeDir }
releaseStoreLoopOwnership(handle): void

// 관찰
readStoreStatus({ storeDir, bootId?, expectGameId? }): StatusEnvelope   // §14.1, read-only
pinCurrentSession({ storeDir, expectGameId? }): SessionDescriptor|null  // frozen
observeLiveness({ storeDir, descriptor }): LivenessReport               // §6.3
observeGuard({ descriptor }): GuardReport                               // publish/coach 증거
proveMutationWritersQuiesced({ storeDir, descriptor, mode }): WriterQuiescenceReceipt // §5.8
issueExecutionLease({ storeDir, handle, descriptor, kind, intentSha256? }): ExecutionLease // §5.10
sealExecutionGeneration({ storeDir, handle, descriptor, writerReceipt, intent }): SealedExecution
sealForRollback({ storeDir, handle, descriptor, guardReceipt }): RollbackSeal
reopenAfterRollback({ storeDir, handle, descriptor, oldGeneration, deathReceipt }): ExecutionGeneration
retireServerBinding({ storeDir, handle, descriptor, binding }): ServerBinding           // §5.11

// launch 기록
claimLaunch({ storeDir, handle, bootId, mode }): LaunchRecord
recordLaunchPrevious({ storeDir, launch, previous }): LaunchRecord
haltLaunch({ storeDir, launch, code, message }): LaunchRecord
completeLaunch({ storeDir, launch, gameId, operationId }): LaunchRecord

// 이전 session 처리
quiescePreviousLoopsBeforeLock({ storeDir, descriptor }): PreLockQuiescence       // §11.1 Q1..Q2
acquireAndRepinPrevious({ storeDir, descriptor }): { handle, descriptor }          // §11.1 Q3..Q3b
quiesceBoundPreviousAfterLock({ storeDir, handle, descriptor, abandonMode }): QuiescenceReport // §11.2 Q4..Q9; held handle signal 금지
classifyTerminal({ descriptor, liveness, guard, requested }): TerminalDecision              // §10.1
commitTerminal({ storeDir, handle, descriptor, intent }): TerminalReceipt                   // §10.2 C1..C3
finishTerminal({ storeDir, descriptor, receipt }): void                                     // §10.2 D1,F1,F2
recoverTerminalJournal({ storeDir, handle }): TerminalReceipt|null                          // §10.4

// 신규 session
prepareNewSession({ storeDir, handle, launch, init, previous }): SessionDescriptor          // §9.1
recoverPendingOperation({ storeDir, handle }): PendingRecoveryOutcome                       // launcher step 7 + foundation classifyPendingRecovery
convergeAbandonedCurrent({ storeDir, handle, descriptor, writerReceipt }): TerminalReceipt  // §9.6

// legacy
adoptLegacyRootIfPristine({ storeDir, handle }): SessionDescriptor|null                     // §12
recoverFromInspection({ storeDir, handle, receipt, expectGameId, expectLayout }): SessionDescriptor

// practice focus
extractPracticeFocus({ previous }): { state, body|null, sha256|null, bytes, truncated }     // §13
```

`SessionDescriptor`는 frozen이고 다음만 포함한다.

```js
{ layout, gameId, operationId, storeDir, sessionDir, sessionRel,
  manifestFile|null, manifestSha256, currentSha256,
  legacyCapabilityFile|null, readySha256|null }
```

token, pid, phase, 절대 임시경로를 포함하지 않는다.

### 15.6 owner proof 요약

| 행위 | 요구 증명 |
|---|---|
| `lifecycle-launch.json` 쓰기 | 살아 있는 store loop lock handle |
| `lifecycle-session-*.json` 쓰기 | store loop lock handle + capsule transaction + descriptor digest 일치 |
| `lifecycle-terminal.json` 쓰기/전진/제거 | 위 + `intentSha256` 일치 |
| `lifecycle-inspection-<nonce>.json` 쓰기 | capsule transaction CAS. store loop handle 불필요; recovery 권한은 만들지 않음 |
| legacy manifest/binding 쓰기 | store loop lock handle + §12.1 pristine precondition |
| `current.json` 쓰기 | 없음 — foundation만 쓴다 |
| engine result 변경 | `abort-from-intent` + capability + intent digest + expected stateVersion |
| session 파일 mutation | 기존 session-local lock 계약 그대로 |
| pointer 변경 전 previous 종료 | §11 pre/post-lock process tier와 guard/consent 전부 |

## 16. producer → persistence → reader → runtime

| artifact | producer | persistence | reader | runtime 소비 |
|---|---|---|---|---|
| `store.json`, `current.json`, `pending-session.json`, `last-operation.json` | foundation | capsule transaction + secure atomic write | `session-capability.js` | lifecycle 판정, child capability 검증 |
| `sessions/<gameId>/session.json` | foundation(promotion 전 1회) | secure write, 이후 immutable | 모든 child의 capability resolver | 경로/identity 증명 |
| `state.json`, `players.json`, `.engine-ready.json` | `engine/cli.js init-staging` → foundation `writeSecureStagingJson` | staging secure write | `engine/cli.js`, `tools/game-loop.js`(read-only) | 게임 규칙, terminal 판정 |
| `.extensions/practice-focus.json` | lifecycle 추출 → foundation `writeSecureExtension` | staging secure write, promotion 시 digest 고정 | `tools/game-loop.js::buildCoachPrompt` | 코치 프롬프트 인라인 |
| `.session-ready.json` | foundation commit | staging 마지막 write | `resolveCurrentSelector`, `resolveSelectedNativeSession` | current 선택 증거 |
| `lifecycle-launch.json` | lifecycle | capsule secure write + CAS | `session-control status`, cold recovery | boot handshake, pre-session halt, predecessor descriptor |
| `lifecycle-session-<gameId>.json` | lifecycle | capsule secure write + CAS | `session-control status`, launch 판정 | terminal/degraded/notice 정본 |
| `lifecycle-terminal.json` | lifecycle | capsule secure write + CAS | 모든 mutation 진입점 | cross-file terminal intent |
| `lifecycle-writers-<gameId>.json` | `tools/session-writer-spawner.js` | foundation lifecycle artifact CAS | force/abort/terminal quiescence | mutation child identity와 death/release 증명 |
| `lifecycle-quiescence-<gameId>.json` | `proveMutationWritersQuiesced` | foundation lifecycle artifact CAS | terminal/recover transition precondition | 모든 mutation writer/coach identity의 death/release admission receipt |
| `lifecycle-execution-<gameId>.json` | lifecycle lease issuer + runner | foundation multi-artifact CAS | 모든 mutation CLI/server, terminal admission | nonreplayable execution generation/lease와 seal |
| `lifecycle-server-binding-<gameId>.json` | serverSpawner/server runner | foundation lifecycle artifact CAS | status/Q4/D9/resume | per-session expected bootId/serverGeneration/lease identity |
| `lifecycle-legacy-session.json` / `-binding.json` | lifecycle(채택 1회) | capsule secure write, 이후 immutable | foundation `selectLegacySession`/`resolveLegacyConcreteSession` | legacy capability |
| `lifecycle-legacy-capability-<op>.json` | foundation | capsule secure write | 모든 legacy child | legacy 경로 증명 |
| `lifecycle-inspection-<nonce>.json` | `session-control inspect` | capsule secure write | `session-control recover` | 수동 복구 CAS |
| `loop-state.json` | `tools/game-loop.js`(+ terminal core의 done 기록) | `writeJsonAtomic` | dealer, `session-control status`, resume | 관찰 지점, phase 체크포인트 |
| `lock.json`, authenticated `/api/identity` | `server/server.js` + validated session capability | `writeJsonAtomic`; HTTP response는 비영속 | lifecycle quiescence, game-loop D9, `tools/publish.js` | pid/port/token과 gameId/operationId/gameEpoch/bootId identity witness |
| `.publish-attempt.json`, `ui-snapshot.json`, `.coach-authority.json`, `.coach-*` | `tools/publish.js` / `tools/coach-control.js` | 기존 계약 그대로 | 동일 | guard 증거, 재개 |
| `review.md`, `.review.json` | `tools/game-loop.js` | `writeTextAtomic`/`writeJsonAtomic` | 다음 게임의 practice-focus 추출, UI | 리뷰 |
| `hands/hand-*.json` | `engine/state.js::writeHandArchive` | `writeJsonAtomic` | coach, evaluator, `resume-check` 복구 | 핸드 기록 |

## 17. 오류 코드와 notice

### 17.1 lifecycle 신규 코드

| code | type | 의미 |
|---|---|---|
| `RESUME_REQUIRED` | throw | 비-terminal session의 publish/coach/cleanup 또는 finalization을 먼저 해소해야 한다 |
| `TERMINAL_CONFLICT` | throw | store intent, engine result, lifecycle terminal, done 관찰이 불일치 |
| `SESSION_TERMINAL` | throw | 이미 terminal인 session을 resume하려 함 |
| `SERVER_PRESENCE_UNKNOWN` | throw | server start 가능 증거는 있으나 lock/listener identity로 absence를 증명하지 못함 |
| `SERVER_TOKEN_MISMATCH` | throw | pinned session expected token과 lock/authenticated `/api/identity` witness가 불일치 |
| `PREVIOUS_SESSION_UNTERMINATED` | throw | 신규 launch가 이전 session의 terminal 자격을 얻지 못함 |
| `MULTIPLE_LOOP_OWNERS` | throw | store loop과 session-local loop이 서로 다른 identity로 동시 생존 |
| `QUIESCENCE_UNCONFIRMED` | throw | process/listener/lock retirement를 증명하지 못함 |
| `WRITER_QUIESCENCE_UNCONFIRMED` | throw | durable writer ledger의 non-released identity가 사망/release로 증명되지 않음 |
| `EXECUTION_LEASE_REQUIRED` | throw | mutation/server entry에 lifecycle-issued lease가 없음 |
| `STALE_EXECUTION_LEASE` | throw | lease secret/generation/descriptor/pid identity 불일치 또는 replay |
| `EXECUTION_LEASE_ACTIVE` | throw | terminal seal 시 active/reserved/bound lease가 남음 |
| `ABANDON_CONSENT_REQUIRED` | throw | 미해소 증거가 있는데 `--abandon-*` 동의가 없음 |
| `EXPECT_GAME_ID_MISMATCH` | throw | CLI 동의 gameId가 pinned current gameId와 다름 |
| `STALE_INSPECTION` | throw | recovery receipt 관찰값이 transaction 시점과 다름 |
| `STATUS_RACE` | throw | selector S1/S2가 3회 연속 달라 단일 current tuple 집계에 실패 |
| `POINTER_RESTORE_UNSUPPORTED` | throw | published current pointer 소실을 scan/추측으로 복구하려는 요청 |
| `DOWNGRADE_LEGACY_ROOT_UNSUPPORTED` | throw | legacy-root를 구버전 신규 init 대상으로 노출할 수 없음 |
| `FINALIZATION_STOP_RACE` | throw | hook 없는 in-flight stop에 late done patch가 합쳐지려 함 |
| `ROLLBACK_SESSION_SEALED` | throw | rollback-sealed session에 일반 new/abandoned/resume mutation 시도 |
| `LIFECYCLE_STATE_CONFLICT` | throw | launch/pending/session lifecycle 기록이 서로 모순 |
| `BAD_LIFECYCLE_STATE` | throw | lifecycle JSON schema/identity/digest 위반 |
| `LEGACY_ADOPTION_REFUSED` | throw | pristine precondition 미충족 상태의 채택 시도 |
| `LEGACY_BINDING_CONFLICT` | throw | legacy manifest/binding/current gameId 불일치 |
| `LEGACY_SERVER_RESTART_REQUIRED` | throw | pre-slice legacy server witness를 안전하게 retire/restart할 수 없음 |
| `BOOT_ID_MISMATCH` | throw | `--expect-boot-id` 검증 실패 |
| `CURRENT_SESSION_MISSING` | throw | current가 지목한 concrete dir이 없음 |

### 17.2 그대로 유지·전파하는 코드

foundation: `BAD_DIRECTORY_MODE`, `BAD_SESSION_STORE`, `BAD_CURRENT_SESSION`, `STALE_SESSION_CAPABILITY`, `SESSION_CREATION_IN_PROGRESS`, `CURRENT_CHANGED`, `LIFECYCLE_ARTIFACT_CHANGED`, `SESSION_STORE_FAILED`, `UNSAFE_LOCK_PATH`, `UNSAFE_STORE_PATH`, `LOCKED`, `IDENTITY_UNAVAILABLE`, `SESSION_RECOVERY_REQUIRED`, `SESSION_ID_EXHAUSTED`, `NO_CURRENT_SESSION`, `NO_PENDING_SESSION`, `PRESERVE_REQUIRED`(action).

기존 런타임: `ACTIVE_GAME`, `LOOP_ALIVE`, `SERVER_ALIVE`, `LOOP_LOCK_UNKNOWN`, `LOOP_LOCK_UNRECLAIMABLE`, `LOOP_IDENTITY_*`, `SERVER_IDENTITY_*`, `SERVER_LOCK_*`, `SERVER_LISTENER_*`, `SERVER_AUTH_*`, `NO_GAME`, `BAD_LOOP_PHASE`, `NO_PLAYER_RUNTIME`, `repair_failed`, `REVIEW_FAILED`, `REVIEW_GATE_CLOSED`, `FINALIZATION_ABORTED`, `COACH_RECONCILE_PENDING`, `ROLLBACK_REFUSED`.

exit code 대응은 기존 `exitCodeFor` 표를 유지한다(`USAGE`/`repair_failed`=2, `REVIEW_FAILED`=3, `NO_PLAYER_RUNTIME`=4, 그 밖=5). lifecycle 신규 코드는 전부 5다.

### 17.3 notice 코드

사용자 노출 한국어 문자열과 함께 `lifecycle-session.notices` 또는 `loop-state.notices`에 남는다. throw하지 않는다.

`LEGACY_REPAIR_REQUIRED`, `LEGACY_FINALIZATION_PENDING`, `LEGACY_CLEANUP_FAILED`, `LEGACY_LOOP_LOCK_RESIDUAL`, `PRACTICE_FOCUS_ABSENT`, `PRACTICE_FOCUS_TRUNCATED`, `PRACTICE_FOCUS_REJECTED`, `PRACTICE_FOCUS_UNAVAILABLE`, `TERMINAL_DEGRADED`, `PUBLISHED_STATE_MODE_UNVERIFIED`(§21.2).

### 17.4 redaction

모든 lifecycle 오류·notice·journal은 token, 절대경로, 파일 본문을 포함하지 않는다. 진단 detail은 store-상대 또는 session-상대 경로와 gameId/operationId/bootId/nonce만 허용한다. stack은 envelope에 넣지 않는다.

## 18. RED gates

### Gate L1 — 소유권과 mode

- `--store-dir`에 concrete native session을 주면 `BAD_DIRECTORY_MODE`이고 nested capsule/current를 만들지 않는다.
- store root를 concrete `--game-dir`로 주면 mutation 전에 `BAD_DIRECTORY_MODE`다(legacy 예외는 legacy capability를 동반한 store root 하나뿐).
- `engine/cli.js`에 `init`·`end` 서브커맨드가 존재하지 않는다.
- `engine/`이 `current.json`을 읽거나 process signal을 보내거나 `loop-state.json`을 쓰지 않는다(호출 흔적 부정 검증).
- `tools/session-lifecycle.js`가 `engine/hand.js` 등 게임 규칙 모듈을 import하지 않는다.
- `server/server.js`의 import가 `publish-contract.js`와 `session-capability.js`로 닫혀 있다.
- 남은 archive family(`initGameDir`/`vacateLive`/`closeOpenPartial`)의 모든 entry가 첫 mutation 전에 `assertNotNativeSessionArchiveTarget`을 호출한다.
- adopted legacy-root current에서 위 세 entry에 storeDir를 넘겨도 `BAD_DIRECTORY_MODE`이고
  capsule뿐 아니라 state/review/hands inode/bytes 전부 불변이다.

### Gate L2 — launcher 순서와 pinning

- launcher는 `ensureStore → tentative current pin → force Q1/Q2 → store lock acquire → current re-pin → claimLaunch → recovery/adoption → previous 처리 → binding intent → commit → lifecycle bind → createGameLoop` 순서로만 진행한다. 각 단계 사이에 checkpoint를 주입한다.
- `createGameLoop` 인자에 `previousSessionDir`가 없고, game-loop이 `resolveCurrentSelector`/`current.json`을 한 번도 읽지 않는다.
- bind 후 current를 다른 gameId로 바꾸는 fixture에서도 engine/publish/coach/server child argv의 `--game-dir`·`--expect-game-id`가 최초 값 그대로다.
- `createGameLoop`이 `acquireOwnedLock`을 호출하지 않고, 넘겨받은 handle을 `requestStop` 마지막에 정확히 한 번 해제한다.
- store loop lock 하나가 두 bootstrap을 직렬화하고, 두 process race에서 정확히 한 owner만 남는다.
- `--resume`이 `init-staging`/`allocateSession`/`commitPreparedSession`/`selectLegacySession`을 한 번도 호출하지 않는다.
- resume takeover는 prior boot writer/coach/server death와 generation+1 open을 증명하기 전
  resumeBound mutation lease를 발급하지 않는다.
- post-publish/pre-lifecycle-session crash는 same current+last-operation+binding launch로
  같은 gameId를 bind하고 predecessor focus를 보존하며 abandoned로 바꾸지 않는다.
- `bindStart`/`resumeBound` 이후 init/init-staging/foundation mutation/store lock acquire 호출은 0회다.
- completed current 뒤 두 번째 `--ai` launch는 새 gameId/session을 만들고 첫 session path/inode/
  핵심 bytes를 보존한다. prior session-ready launch를 recovery로 오인하지 않는다.
- step 2 preflight status는 absent/empty store에서 read-only `storeState:'absent'`를 반환하고
  어떤 디렉터리/none sentinel도 만들지 않는다.

### Gate L3 — new / attach / resume / abandoned

- 빈 store launch가 `sessions/<uuid>/state.json`과 current를 만들고 store root에 `state.json`/`archive/`를 만들지 않는다.
- 두 번째 launch가 첫 session의 경로·inode·`session.json`/`state.json`/`players.json`/`.session-ready.json` bytes를 바꾸지 않고 current만 바뀐다.
- store loop alive에서 두 번째 launch는 `ACTIVE_GAME`이고 전체 tree가 불변이다.
- session server alive에서 non-force launch는 `ACTIVE_GAME`이다.
- terminal session에 대한 `--resume`은 `SESSION_TERMINAL`이고 새 hand를 시작하지 않는다.
- abandoned(둘 다 dead, guard clean, engine active) → 자동 `aborted/abandoned` 수렴 후 신규 session. guard dirty → `RESUME_REQUIRED`이고 current 불변.
- abandoned인데 engine이 자연 승패이거나 loopPhase가 FINAL_PHASES → `RESUME_REQUIRED`.
- `cleanupFailedAt`이 있는 store의 신규 launch는 `RESUME_REQUIRED`이고, 새 `--resume` process가 lock·server·미해소 게시를 다시 들고 정리한다.

### Gate L4 — terminal 분류와 crash matrix

- §10.1 matrix 각 행을 fixture로 재현하고 허용/거부가 정확히 일치한다.
- 자연 win/lose 및 `finalizing`/`review_generated`/`review_published`/cleanup-failed 상태가 non-force, force, user-abort, abandoned 어느 판정에서도 `result: 'abort'`가 되지 않는다.
- `--abandon-finalization`은 `result`를 보존하고 `reason: 'finalization-abandoned'`, `degraded: true`, 비어 있지 않은 `unresolvedEvidence`를 남긴다.
- terminal core의 `J → E → S → D → R → L` 각 경계(그리고 각 원자 write의 temp→rename 사이)에 crash를 주입해 §10.3 표대로 정확히 하나의 terminal로 수렴한다.
- `lifecycle-terminal.json`이 cross-file mutation보다 **먼저** 존재함을 syscall 순서로 단언한다(engine 먼저 변경하는 구현은 실패).
- engine result가 이미 abort인 재진입은 `abort-from-intent`가 no-op 성공이고 `stateVersion`을 올리지 않는다.
- C1 aborted partial-write/recovery에서 terminal-engine lease와 matching writer row가 항상
  함께 나타나고 bind/GO/death/release로 수렴한다. 한쪽만 있으면 C2/C3가 거부된다.
- intent digest/stateVersion/gameId 불일치는 `TERMINAL_CONFLICT`이고 어떤 파일도 되돌리지 않는다.
- `phase:'done'`인데 lifecycle terminal이 없는 store는 신규 launch를 `TERMINAL_CONFLICT`로 거부한다.
- `requestStop`의 `beforeRelease` 실패는 lock을 유지하고 `cleanupFailedAt`을 남긴다.
- SIGTERM hookless stop과 review_published finishDoneLifecycle race는 done patch를 merge하지 않고
  FINALIZATION_STOP_RACE/cleanupFailedAt으로 남으며 terminal 없는 done을 만들지 않는다.
- self-owner store loop handle은 terminal authority로 허용되고 foreign live owner는 차단된다.
  normal finalizer는 server death/retirement 뒤 terminal begin을 호출한다.
- aborted C3는 engineAppliedStateVersion과 digest 일치 또는 preexisting-abort disposition을
  검증하고, completed
  step:intent recovery는 abort-from-intent/engine step 없이 C3으로 간다.
- `abort-from-intent`를 win/lose state에 직접 호출하면 `TERMINAL_CONFLICT`이고 state bytes와
  stateVersion이 불변이다.
- user abort, abandoned convergence, normal finalization, force, pending/legacy recover 각각이
  writer-quiescence receipt 없이는 C1/current mutation에 진입하지 못한다.

### Gate L5 — force quiescence

- pre-lock Q1/Q2/Q3/Q3b와 post-lock Q4~Q8 각 단계 실패를 개별 주입하고, 어떤 실패에서도 current pointer가 바뀌지 않고 신규 session namespace가 생기지 않는다.
- post-lock quiesce가 held storeLoopHandle identity에 signal을 시도하면 테스트가 즉시 실패한다.
- dead/absent store-loop + live authenticated orphan server에서 Q1은 무신호 성공, Q3는 dead
  lock을 reclaim하고 Q4가 server를 identity-kill한 뒤에만 terminal/current가 전진한다.
- force가 loop 사망 확인 **후에** `lock.json`을 다시 읽어 교체된 server identity를 대상으로 삼는다(기존 force 테스트 의미 보존).
- 위조된 무관 live pid를 가리키는 `lock.json`은 signal·retire·archive 어느 것도 유발하지 않는다.
- listener 소유·token challenge·pinned lock identity 중 하나라도 실패하면 signal하지 않는다.
- retirement 직전 inode/bytes 교체는 quarantine 복구로 두 경로를 모두 보존하고 `SERVER_LOCK_REPLACED`로 실패한다.
- 임시 relay를 띄운 경로는 relay 사망과 그 `lock.json` retirement를 같은 ladder로 확인한다.
- dirty publish/coach force에서 execution generation은 Q6 relay lease 발급 동안 open이고,
  relay/publisher/coach lease가 모두 released된 Q8 뒤 C1에서만 seal된다. Q6 전 seal은 실패다.
- `--abandon-current`가 Q6·Q7만 우회하고 Q1·Q2·Q3·Q4·Q5·Q8은 우회하지 못한다(각각 독립 실패 주입).
- audited abandon이 `.publish-attempt.json`, coach queue 파일, `.coach-authority.json` 행 중 무엇도 삭제하지 않고 digest를 `unresolvedEvidence`에 보존한다.
- force old-terminal commit **전** 실패: old lifecycle-session/current/manifest와 신규 namespace 불변.
- force old-terminal commit **후** 신규 실패: current가 old terminal session을 계속 가리키고 pending journal 재호출이 수렴한다.
- force 전 구간에서 store loop lock이 한 번도 해제되지 않는다.
- serverStartIntent가 있으나 lock.json이 없고 listener가 있으면 matching bound server lease
  identity만 종료할 수 있다. lease가 없거나 mismatch/unknown이면 SERVER_PRESENCE_UNKNOWN이고
  current/terminal이 불변이다.
- SIGKILL된 sidecar가 orphan engine/publisher/coach-control runner를 남기면 durable writer
  ledger 전 row death/released 확인 전 terminal/current가 전진하지 않는다.
- reserved-before-spawn, spawned-before-bind, bound-before-GO, GO-after-parent-death 각 crash에서
  §5.10 규칙대로 no-child release 또는 exact process-group death로 수렴한다.
- direct engine/publish/coach/server를 capability만으로 실행하면 EXECUTION_LEASE_REQUIRED이며
  first I/O가 0회다. C0와 C1 사이 새 legitimate lease race는 C1 digest precondition을
  실패시켜 journal/pointer를 쓰지 않고 다시 quiesce하며, C1 seal 뒤 stale generation은 거부된다.
- `coach-control watch-accept --publish`는 USAGE이고 nested direct publisher spawn은 0회다.
- lock.json token과 pinned state expected token이 다르거나 authenticated `/api/identity`의
  gameId/operationId/gameEpoch/bootId/serverGeneration/leaseId가 다르면 Q4는 signal하지 않고
  전체 tree 불변이다.
- lsof/token/HTTP/death wait가 foundation transaction 안에서 호출되면 lock-order test가 실패한다.

### Gate L6 — legacy 채택과 migration

- §12.1의 여섯 precondition 각각을 하나씩 깨뜨린 fixture가 전부 자동 채택을 거부한다.
- 채택은 legacy tree(`state.json`, `players.json`, `hands/`, `review.md`, `ui-snapshot.json`, `archive/`, `.partial`)의 inode와 bytes를 전혀 바꾸지 않는다.
- 채택 후 store root에 `session.json`이 생기지 않는다.
- §12.3의 모든 행(active/abort/win/lose/finalizing/review checkpoint/malformed/부분 신호/신호 없음)을 fixture로 분류하고 기대 결과와 notice가 일치한다.
- capsule metadata 또는 native session이 있는 store에서 current를 지운 뒤 launch하면 `BAD_CURRENT_SESSION`이고 legacy를 자동 재선택하지 않는다.
- legacy terminal은 `lifecycle-session-<gameId>.json`만 갱신하고 `lifecycle-legacy-session.json`/`-binding.json`의 digest를 바꾸지 않는다(바꾸면 child capability가 즉시 실패함을 별도 단언).
- legacy child가 stale current/binding/복사된 manifest/root inode 변경을 독립적으로 거부한다.
- legacy-root에서 store lock과 session-local lock이 같은 경로임을 인식하고 `MULTIPLE_LOOP_OWNERS`를 내지 않는다.
- native session에 downgrade sidecar가 session-local `loop.lock.d`를 잡고 있으면 `ACTIVE_GAME`이고, store owner와 동시에 alive면 `MULTIPLE_LOOP_OWNERS`다.
- session-local loop lock이 `unknown`이면 나이와 무관하게 `LOOP_LOCK_UNKNOWN`이다.
- legacy-binding intent 뒤 manifest-only/binding-only/select 전 crash가 같은 operationId로 수렴한다.
- pristine legacy review가 있는 new launch는 select 직후 launch.previous를 adopted session으로
  갱신하고, 그 review의 practice-focus를 다음 native session에 전달한다. select 직후 crash도 같다.

### Gate L7 — practice-focus

- 네 heading이 모두 있는 review에서 `다음 게임에서 연습할 것` 본문만 추출되고 나머지 세 section 문자열이 결과에 없다.
- heading이 여러 번 나오면 첫 번째만 쓴다.
- 다음 heading이 없는 마지막 section은 EOF까지 추출된다.
- heading 부재/빈 본문은 `state:'absent'`이고 `.extensions/`가 비어 있으며 commit이 성공한다(optional extension 생략 경로).
- 4096 byte 경계: cap 정확 일치, cap+1(잘림 + `truncated:true`), 멀티바이트 문자 경계에서 잘려도 UTF-8이 깨지지 않음.
- forbidden literal(상대 archetype/personality/수치/비공개 홀카드)이 하나라도 포함되면 파일을 만들지 않고 `PRACTICE_FOCUS_REJECTED` notice만 남으며 session은 정상 commit된다.
- pointer commit 직전·직후 crash에서 focus digest가 동일하고 재추출이 결정적이다.
- launch의 `previous.reviewSha256`과 실제 파일 digest가 다르면 `state:'unavailable'`이고 session을 삭제하지 않는다.
- 코치 프롬프트가 `.extensions/practice-focus.json`의 `focus` field만 인라인하고 전체 JSON을 넣지 않는다.
- `--practice-focus-file` argv가 존재하지 않고, `.practice-focus.json`을 session root에 만드는 경로가 없다.

### Gate L8 — boot handshake와 status

- `launch.phase === 'starting'`과 `loop.phase === 'bootstrap'`은 성공으로 관찰되지 않는다.
- stale terminal current(이전 게임의 `done`/`finishedAt`/`port`/`sessionToken`)만 있는 store에 새 launch를 걸면, matching bootId와 **다른** gameId가 나타나기 전에는 성공 판정이 성립하지 않는다.
- resume launch는 matching bootId와 **같은** gameId를 요구한다.
- session 생성 전 실패는 matching bootId의 `lifecycle-launch.json.halt`로, 생성 후 실패는 session `loop-state.json.halt`로 관찰되며 둘이 동시에 기록되지 않는다.
- lock 획득 실패(`ACTIVE_GAME`)는 launch 기록을 남기지 않고 이전 bootId를 덮어쓰지 않는다.
- `status`가 store loop lock도 transaction lock도 잡지 않고 `sessions/` readdir을 호출하지 않는다.
- `status`는 inspect-session만 사용하고 resume-check/rebuildArchive/writeHandArchive를 호출하지 않는다.
- `status`의 token은 stdout에만 나오고 어떤 store artifact에도 복제되지 않는다.
- `MULTIPLE_LOOP_OWNERS` 조건에서 `status`가 `ok:false`로 fail-closed한다.
- status S1 read와 S2 recheck 사이 force/current switch를 주입해 STATUS_RACE 또는 retry된
  단일 tuple만 반환하고 A/B aggregate를 반환하지 않는다.
- current가 같아도 launch/loop/server-binding/lock/execution/lifecycle-session 중 하나가 S1/S2
  사이 바뀌면 STATUS_RACE 또는 완전 재시도이며 mixed tuple을 반환하지 않는다.
- live store loop에서 foreign bootId를 관찰하면 attach 또는 ACTIVE_GAME으로 즉시 종료하며 poll이 지속되지 않는다.
- missing/unreadable last hand는 inspect-session에서 같은 archiveStatus로 노출되고 repair를 호출하지 않는다.
- playing/FINAL_PHASES success는 authenticated matching server binding이 alive일 때만 성립한다.
  stale playing loop-state + dead/unknown/mismatched server는 성공/attach가 아니다.
- live metrics/handNo/lease-map churn은 stable identity tuple status를 STATUS_RACE로 만들지 않고,
  bootId/generation/state identity 변경만 retry/fail한다.
- session-ready+playing, dead store-loop, live orphan server non-force launch는 step 5b에서
  ACTIVE_GAME이고 기존 launch bytes가 불변이다.

### Gate L9 — 동시성과 호환

- `publish.lock.d` 이름이 유일하고 `coach.lock.d`가 어디에도 생기지 않는다.
- 기존 state/publish/coach/archive lock 테스트와 `test/turn-contract.test.js` 전량이 통과한다(공유 mutex 의미 무변경).
- `withNamedLock`의 1줄 pid record 판정이 변경되지 않고, foundation strict 2줄 분기만 별도로 존재한다.
- session directory를 어떤 lifecycle 경로도 rename/copy/delete하지 않으며, coach `publishQueue`의 절대 `exactEnvelopePath`가 force·terminal·신규 session 생성 뒤에도 그대로 열린다.
- store transaction을 보유한 채 child spawn/network/LLM/프로세스 종료 대기가 일어나지 않는다(호출 흔적 부정 검증).
- session-local lock 보유 중 store transaction 대기가 일어나지 않는다.
- 두 process가 동시에 `session-control abort`와 launch를 시도하면 store loop lock으로 직렬화되고 terminal은 하나만 기록된다.
- foundation transaction 보유 중 lifecycle 호출은 8초 후 `LOCKED`이고 우회 no-op하지 않는다.
- lifecycle JSON 전부에 symlink/hardlink/`nlink>1`/realpath escape/permission failure를 주입해 fail-closed한다.
- lifecycle이 만든 capsule 파일 mode가 `0600`, 오류/notice/journal에 token·절대경로·본문이 없다.
- crashed lifecycle artifact temp는 foundation artifact API로 수렴하고 ensureStore가 BAD_SESSION_STORE로 실패하지 않는다.
- start-game/README/ARCHITECTURE/tempo-skill-contract가 session-control status,
  --store-dir, --boot-id, bindStart/resumeBound, session-control abort를 정본으로 검사한다.
- bindStart/resumeBound/D9 ensureServer/Q6 relay 모두 injected serverSpawner 한 곳만 쓰고
  direct server spawn은 0회다. fd mode에서는 네 route argv/env raw token이 0개다.
- every mutation child가 GO 전에 durable writer bound row를 갖고 released 전 force가 pointer를 바꾸지 않는다.
- manual rollback도 `issue-rollback-lease` one-shot 없이는 mutation할 수 없고 downgrade receipt는
  sealed/open execution generation과 모든 lease/coach/server quiescence를 포함한다.
- foundation `transitionLifecycleArtifacts`는 모든 digest precondition을 첫 write 전에 검사하고,
  lifecycle이 transaction mutex를 직접 획득하거나 transaction 안에서 child/network를 기다리는 경로가 없다.
- step 4~12 각 경계 throw에서 launcher가 claim 위치에 맞는 단일 halt를 남기고 exact store
  handle을 해제한다. createGameLoop ownership 인수 뒤에는 launcher finally가 이중 해제하지 않는다.
- pending classifier 모든 action은 §12.5 exact dispatch로 실행되고 first-game previous:null,
  complete_extensions crash/takeover가 동일 focus digest로 수렴한다.
- adopted legacy-root에서 남은 archive exports는 store root mutation 전에 BAD_DIRECTORY_MODE다.
- rollback guard는 open/eligible preliminary만 반환하고 issue-rollback-lease가 rollback-sealed
  final receipt를 만든다. compat death 뒤 generation+1 open으로만 re-upgrade한다.
- rollback-sealed 직후/old death 직후 `--ai`는 ROLLBACK_SESSION_SEALED이고 current/engine/
  bytes 불변이다. re-upgrade resume만 reopenAfterRollback한다.
- writer/server spawn ticket의 모든 required identity field가 schema에 존재하고 grace 경계
  직전 runner는 release되지 않으며, 경계 후 owner death+nonce absence만 never-spawned release다.
- matching legacy-binding in-flight artifacts는 자동 select recovery, intent 없는 동일 files는
  BAD_CURRENT_SESSION이다.

## 19. 수용 기준

1. 두 게임을 연속 실행해도 첫 session directory의 위치·inode·핵심 파일 bytes가 바뀌지 않는다.
2. 정상 완료·abort·force 어디에도 game-level rename/copy/delete 호출이 없다.
3. 실행 중 모든 하위 프로세스가 동일한 concrete session dir과 동일한 capability를 쓴다. bind 후 current 변경이 그것을 바꾸지 못한다.
4. 자연 win/lose와 finalization phase가 어떤 경로로도 abort로 재기록되지 않는다.
5. terminal은 §10.3의 모든 crash 지점에서 정확히 하나로 수렴하거나 명시적 `TERMINAL_CONFLICT`로 fail-closed한다.
6. force가 pointer를 바꾸기 전에 old loop/session-local loop/server/임시 relay/coach worker의 사망과 listener·lock retirement가 identity로 증명된다.
7. audited abandon은 어떤 파일·queue도 삭제하지 않고 자연 결과를 보존하며 `unresolvedEvidence`를 남긴다.
8. legacy 라이브·archive 데이터가 삭제·덮어쓰기·암묵 import되지 않고, pointer 소실은 자동 재채택 없이 fail-closed한다.
9. 이전 session review의 `다음 게임에서 연습할 것` section만 4096 bytes 이하로 다음 session에 전달되고, 다른 section과 비공개 literal은 전달되지 않는다.
10. dealer가 `bootId`와 gameId 변화만으로 launch 성공/실패를 판정할 수 있고, stale terminal 관찰로는 성공이 성립하지 않는다.
11. 기존 publisher/coach 공유 `publish.lock.d` 의미와 `node --test` 전체 suite가 녹색이다.

## 20. 비목표

- foundation schema·transaction·capability 검증 로직의 재설계.
- raw token fd 전달, 장기 writer mode 보존, 실행 중 path-inode 재검증의 **구현**.
- downgrade launcher·revert 패키징의 **구현**.
- history UI, 지난 게임 목록·replay, archived-game resume/import.
- multi-table, 동시 다중 게임.
- retention, 압축, 외부 cold storage, `.recovery-*`/orphan `lifecycle-*` 정리 정책.
- engine rule, 베팅, 카드, UI 레이아웃, LLM 모델·프롬프트·코치 내용 변경.

## 21. hardening/rollback slice에 넘기는 인터페이스

lifecycle은 아래 hardening seam을 **단일 호출 지점**으로 좁혀 두고, 의미를 바꾸지 않는 교체가 가능하도록 인터페이스만 고정한다. 구현은 hardening slice가 소유한다.

### 21.1 token 전달 channel

lifecycle/game-loop의 server spawn route는 `bindStart`, `resumeBound`, runtime D9
`ensureServer` self-heal/finalization respawn, force Q6 relay 네 종류다. 모두 injected
`session-server-spawner.js` 하나를 호출하며 direct `spawn(server/server.js)`는 금지한다.

```js
serverSpawner.spawn({ sessionDir, storeDir, gameId, operationId, capability,
                      bootId, port, tokenChannel, executionLease, serverBinding, reason })
```

`tokenChannel` 계약:

```js
{
  // child spawn 옵션에 병합될 stdio 배열 조각. 현재 구현은 [] 를 반환한다.
  stdio(): Array,
  // child argv 에 병합될 조각. 현재 구현은 ['--token', token] 을 반환한다.
  argv(): string[],
  // spawn 직후 1회 호출. 현재 구현은 no-op, fd 구현은 write+close 를 수행한다.
  transfer(child): void,
  // 진단용. token 을 절대 반환하지 않는다.
  describe(): { mode: 'argv' | 'fd' }
}
```

precondition(hardening이 충족시켜야 하는 것):

- `server/server.js`가 `mode:'fd'`에서 지정 fd로부터 token을 한 번 읽고 즉시 닫는다.
- `describe().mode === 'fd'`인 동안 lifecycle·game-loop의 어떤 child argv/env에도 token 문자열이 없다.
- 수동 human dev/rollback의 `--token`만 호환 표면으로 남고 lifecycle/coordinator는 쓰지 않는다.

server spawner는 filesystem action 전에 selected native/legacy capability와 execution lease를
검증하고, `loop-state.serverStartIntent`와 per-session server binding을 spawn 전에 쓴다.
direct server entry도 같은 capability+lease를 필수로 받아 검증 전 mkdir/lock/UI write/listen을
하지 않는다. 이 slice에서는 sessionToken `mode:'argv'`
구현을 유지하되 네 route 모두 이 spawner만 통과함을 RED로 고정한다.

### 21.2 published state writer mode

foundation은 promotion 시점 `0600`만 보장하고, 이후 `engine/state.js::saveState`의 `writeJsonAtomic`이 mode를 유지한다고 주장하지 않는다. lifecycle은 이 한계를 숨기지 않고 관찰만 한다.

```js
assertPublishedArtifactMode(descriptor): { ok, offending: [relPath] }
```

- lifecycle이 bind 직전 1회 호출한다.
- `ok === false`이면 `PUBLISHED_STATE_MODE_UNVERIFIED` notice를 `lifecycle-session.notices`에 남기고 **진행한다**(게임을 막지 않는다).
- hardening이 `writeJsonAtomic`을 secure temp/`O_NOFOLLOW`/mode 보존 writer로 교체하면 이 probe는 항상 `ok:true`가 되고 notice가 사라진다.

### 21.3 pinned session root 재검증

```js
withPinnedSessionRoot(descriptor, fn)
```

- 진입 시 `sessionDir`를 read-only fd로 pin하고 `(st_dev, st_ino)`를 기록한다.
- `fn`에 `revalidate()` 콜백을 전달한다. 이 slice의 구현은 pathname의 dev/ino를 다시 stat해 불일치 시 `STALE_SESSION_CAPABILITY`를 던지는 것까지만 한다.
- lifecycle은 다음 경계에서 `revalidate()`를 호출한다: terminal core C1/C3 진입, force Q4·Q8 진입, `createGameLoop` bind 직전.
- 추가로 D9 ensureServer, writerSpawner.run, Q6 relay, abort-from-intent lease issue 직전에
  호출한다. published root를 다시 만드는 mkdir은 hardening 전후 모두 금지다.
- hardening은 장기 runtime 중 주기적 재검증과 fd-relative 접근으로 이 구현을 강화한다. 호출 지점 목록은 이 문서가 고정한다.

### 21.4 downgrade guard receipt

`session-control issue-rollback-lease --store-dir <dir> --expect-game-id <uuid>
--receipt-sha256 <hex>`의 **final** 출력 schema를 여기서 고정한다. read-only
`downgrade-guard`는 같은 digests/quiescence에 `executionState:'open', eligible:true`를 반환하되
`legacyArgv`는 내지 않는다. 패키징(`launch-old`, revert 순서, compat launcher)은
hardening/rollback slice 소유다.

```json
{
  "ok": true,
  "schemaVersion": 1,
  "kind": "ai-holdem-downgrade-receipt",
  "storeId": "<uuid>",
  "gameId": "<uuid>",
  "layout": "native",
  "issuedAt": "2026-08-31T10:00:00.000Z",
  "sessionRel": ".session-store.lock.d/sessions/<gameId>",
  "digests": {
    "current": "<hex>", "manifest": "<hex>", "sessionReady": "<hex>|null",
    "lifecycleSession": "<hex>", "engineState": "<hex>", "loopState": "<hex>|null"
  },
  "engine": { "stateVersion": 88, "gameOver": false, "result": null },
  "quiescence": {
    "storeLoop": "dead", "sessionLoop": "absent", "serverPidAlive": false,
    "serverBinding": "retired", "writerLeases": "released", "coachHandles": "released",
    "executionGeneration": 4, "executionState": "rollback-sealed",
    "publishLockLive": false, "publishAttempt": false, "rollbackGuard": "ok"
  },
  "rollbackLeaseRequired": true,
  "legacyArgv": ["--resume", "--game-dir", "<absolute concrete sessionDir>"]
}
```

- `quiescence`의 어느 항목이라도 미충족이면 `ok:false`와 사유 code로 fail-closed하고 `legacyArgv`를 내지 않는다.
- `legacyArgv`는 quiesced+resumable native session의 구버전 resume만 표현한다. init/ai
  flag를 포함하지 않는다. legacy-root(store root)에는 `ok:false,
  DOWNGRADE_LEGACY_ROOT_UNSUPPORTED`이고 argv를 내지 않는다. store root를 구버전 신규
  init 대상으로 내주지 않는다.
- `downgrade-guard` 자체는 read-only preliminary receipt다. `issue-rollback-lease`가 같은
  digests/quiescence를 다시 확인하고 §5.10 `sealForRollback`을 수행해 final receipt를 낸다.
  실제 compat wrapper는 final receipt만으로도 old binary를 실행하지 않고 fresh one-shot
  `issue-rollback-lease`를 받아 wrapper 자체가 검증·claim한 뒤 exact old resume argv를 exec한다.
  old binary가 lease protocol을 이해할 필요는 없지만 wrapper 밖 direct old binary 실행은
  지원하지 않으며 안전을 주장하지 않는다.
- re-upgrade 전 old-code sidecar와 session-local loop/server 사망 확인은 §6.4 matrix가 그대로 판정한다.
- re-upgrade는 그 death 확인 뒤 `reopenAfterRollback`으로 generation을 증가시키고 open으로
  되돌린다. rollback-sealed는 lifecycle terminal을 만들지 않아 resumable engine과 양립한다.

### 21.5 hardening이 만족시켜야 할 precondition 요약

1. token fd 구현은 §21.1의 네 호출 지점 밖에 새 spawn 지점을 만들지 않는다.
2. writer mode hardening은 `engine/state.js::writeJsonAtomic`의 same-parent temp→rename 원자성을
   유지하되 published runtime에서는 parent-existing precondition을 강제하고 recursive mkdir을
   제거한다. mode/`O_NOFOLLOW`도 함께 강화한다.
3. path-inode 재검증 강화는 §21.3의 호출 지점 목록을 줄이지 않는다.
4. downgrade 패키징은 §21.4 receipt를 소비만 하고 schema를 확장할 때 `schemaVersion`을 올린다.
5. 어떤 hardening 변경도 `publish.lock.d` 이름·의미, `publish-contract.js` 상수, `gameEpoch` 파생, terminal core의 `J → E → S → D → R → L` 순서를 바꾸지 않는다.
