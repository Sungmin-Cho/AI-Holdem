# 게임 세션 Store Foundation 설계

날짜: 2026-08-31
상태: READY_FOR_PLAN — CRITICAL review 수렴, compensated depth human-approved
상위 방향: 게임은 init 시 영구 홈을 얻고 완료 시 이동·복사되지 않는다.

## 1. 범위

이 문서는 session-native persistence를 세 계약으로 나눈 첫 번째 설계다. 다음만
정의한다.

- rollback-safe store namespace와 schema
- public `gameId`와 concrete session identity
- 신규 session allocation, staging, readiness, current pointer commit
- 짧은 store transaction lock
- process crash recovery
- store/concrete path capability와 filesystem containment

PID, listener, token 전달, resume, force, abort, terminal, publisher, coach, legacy
adoption, practice-focus 추출, downgrade 실행은 후속 lifecycle/hardening 설계의
책임이다. 이 foundation은 그 기능이 사용할 명시적 API와 precondition만 제공한다.
`--store-dir`, `--expect-game-id`, `--manifest-file`의 CLI wiring은 후속
lifecycle/hardening 설계가 소유하지만 모든 소비자는 용도에 맞는 foundation
staging/selected-native/legacy resolver를 호출해야 한다.

기존 publisher와 coach가 공유하는 `publish.lock.d` 계약은 변경하지 않는다. 별도
`coach.lock.d`를 만들지 않는다.

## 2. 목표

1. 신규 게임은 current에 공개되기 전에 완전한 concrete session directory를 가진다.
2. current selector는 directory scan 없이 원자 pointer 하나만 읽는다.
3. 생성 도중 crash는 exact journal과 gameId로 멱등 복구된다.
4. current에 공개된 session directory는 foundation에서 이동·복사·삭제하지 않는다.
5. store root와 concrete session path를 추측하지 않고 capability로 검증한다.
6. store root를 대상으로 한 구버전 archive/vacate와 새 코드의 destructive entry가
   native sessions를 이동·삭제하지 못한다. 임의 session gameDir를 받는 구버전
   binary 방지는 rollback launcher 책임이다.

## 3. 비목표

- 활성 게임 판정과 process 종료
- terminal eligibility와 terminal manifest mutation
- legacy root/archive import 또는 resume
- history UI, multi-table, retention
- publisher/coach/server 동시성 변경
- runtime token pipe와 장기 writer inode fencing

`.recovery-*` forensic sibling은 foundation이 삭제하지 않으며 반복 crash 시 누적될
수 있다. 미공개 sessionToken을 포함할 수 있는 비밀 자료이므로 directory/file의
0700/0600 제한을 유지한다. 목록·retention·삭제는 후속 운영 설계의 책임이다.
선택 crash로 남은 orphan `lifecycle-legacy-capability-*.json`도 selector가 아니며 같은
후속 retention 설계가 정리한다.

## 4. 파일시스템 layout

```text
<storeDir>/
  loop.lock.d/                              # lifecycle 소유, foundation은 읽거나 쓰지 않음
  .session-store.lock.d/                    # persistent compatibility capsule
    store.json
    current.json                            # 항상 존재; none/native/legacy-root union
    pending-session.json                    # 생성 operation이 있을 때만
    last-operation.json                     # response-loss idempotency receipt
    transaction.lock.d/                     # strict named mutex, 2줄 pid+startTime owner
    sessions/
      .<gameId>.creating/                   # unpublished staging
        session.json                         # immutable identity manifest
        state.json
        players.json
        .engine-ready.json
        .extensions/                       # downstream artifacts 전용 namespace
        .session-ready.json                 # promotion 직전 최종 marker
      .recovery-<gameId>-<nonce>/           # 보존된 incomplete staging
      <gameId>/                             # published permanent home
        session.json                         # immutable identity manifest
        state.json
        players.json
        .engine-ready.json
        .extensions/
        .session-ready.json
```

`.session-store.lock.d`는 이름과 달리 lock record가 아니다. 구버전
`isReservedName(name.endsWith('.lock.d'))`이 통째로 보존하는 compatibility
namespace다. 이 디렉터리에 `pid` 파일을 두거나 `readOwnedLock`을 호출하지 않는다.
실제 lock은 그 안의 `transaction.lock.d`다.

store root의 기존 `state.json`, `archive/`, `review.md`, `hands/` 등은 이 slice가
읽거나 이동·복사·삭제하지 않는다.

## 5. identity

### 5.1 storeId와 gameId

`storeId`와 `gameId`는 각각 `crypto.randomUUID()`로 만든 소문자 UUID v4다.

```text
^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$
```

둘 다 공개 식별자이며 token이 아니다. `sessionToken`은 engine state 안에서 나중에
생성되며 store, pending, current, session manifest에 복제하지 않는다.

### 5.2 canonical paths

```text
capsuleRel = .session-store.lock.d
sessionsRel = .session-store.lock.d/sessions
stagingRel = .session-store.lock.d/sessions/.<gameId>.creating
sessionRel = .session-store.lock.d/sessions/<gameId>
stagingManifestRel = <stagingRel>/session.json
manifestRel = <sessionRel>/session.json
```

schema에서 저장한 상대경로는 위 공식으로 다시 계산한 문자열과 byte-for-byte 같아야
한다. 절대경로, `..`, 중복 separator, backslash, NUL, symlink 경로를 허용하지 않는다.
staging의 `session.json.relativeDir`도 항상 최종 `sessionRel`이다. promotion 때 manifest를
다시 쓰지 않는다. capability validator는 gameDir가 stagingRel 또는 sessionRel인지 별도로
판정하되 manifest.relativeDir는 sessionRel하고만 비교한다.

`layout: legacy-root`의 `relativeDir`는 정확히 `.` 하나이고 native 공식 대조 대상이
아니다. concrete directory는 `realpath(storeDir)` 자신이어야 한다.

## 6. schema

모든 JSON schema는 알려지지 않은 field를 거부한다. timestamp는 UTC ISO-8601
문자열이고 UUID와 경로는 §5 문법을 적용한다.

### 6.1 store.json

```json
{
  "schemaVersion": 1,
  "kind": "ai-holdem-session-store",
  "storeId": "8c36ea07-9a62-4d64-8b35-f186535ac923",
  "createdAt": "2026-08-31T07:00:00.000Z"
}
```

store marker는 capsule 초기화 뒤 처음 쓰는 persistent file이다. 기존 valid marker는
절대 다시 생성하지 않는다.

### 6.2 session.json

```json
{
  "schemaVersion": 1,
  "storeId": "8c36ea07-9a62-4d64-8b35-f186535ac923",
  "gameId": "ef6ec0a9-a851-4e88-853a-7bfd4d95e63b",
  "operationId": "4d970d18-6984-4e97-b64f-aa72e04baa02",
  "layout": "native",
  "relativeDir": ".session-store.lock.d/sessions/ef6ec0a9-a851-4e88-853a-7bfd4d95e63b",
  "createdAt": "2026-08-31T07:01:00.000Z"
}
```

`session.json`은 immutable identity manifest다. terminal이나 mutable phase를 넣지 않는다.
`operationId`는 allocation마다 새로 만든 UUID v4이며 pending/staging/final identity를
결합한다. 비밀이 아니고 진단에 노출될 수 있다. recovery는 같은 gameId만으로 기존
final을 채택하지 않고 operationId까지 일치해야 한다.
후속 lifecycle은 별도 lifecycle artifact/journal을 소유하며 current와 readiness가 bind한
identity manifest hash를 변경하지 않는다. foundation은 published session manifest를
수정하는 API를 제공하지 않는다.

### 6.3 pending-session.json

```json
{
  "schemaVersion": 1,
  "operationId": "4d970d18-6984-4e97-b64f-aa72e04baa02",
  "storeId": "8c36ea07-9a62-4d64-8b35-f186535ac923",
  "gameId": "ef6ec0a9-a851-4e88-853a-7bfd4d95e63b",
  "phase": "allocated",
  "createdAt": "2026-08-31T07:01:00.000Z",
  "stagingRel": ".session-store.lock.d/sessions/.ef6ec0a9-a851-4e88-853a-7bfd4d95e63b.creating",
  "sessionRel": ".session-store.lock.d/sessions/ef6ec0a9-a851-4e88-853a-7bfd4d95e63b",
  "previousCurrentSha256": "<none selector file sha256>",
  "init": {
    "aiCount": 3,
    "startStack": 5000,
    "blinds0": [25, 50],
    "levelEvery": 8
  },
  "requiredExtensions": [],
  "updatedAt": "2026-08-31T07:01:00.000Z"
}
```

`phase`는 `allocated`, `initializing`, `base_ready`, `extensions_ready`, `promoted`,
`selected` 중 하나이며 일반 경로에서는 이 순서로만 전진한다. 아래 두 recovery
API의 `allocated` reset만 명시적 예외다. `requiredExtensions`의 각 항목은 다음
닫힌 schema다.

| writer | 허용 transition |
|---|---|
| public `recordPendingPhase` | 같은 phase idempotent 또는 정확히 다음 phase로 전진; 역행 금지 |
| `preserveIncompleteStaging` | 임의 pre-publish phase → allocated reset |
| `ensureStagingForOperation` recovery | staging/final 부재 상태에서 임의 pre-publish phase → allocated reset |
| `commitPreparedSession` internal | extensions_ready→promoted→selected; post-current 단계는 same operation current digest 권위 |

```json
{
  "name": "practice-focus",
  "relativePath": "practice-focus.json",
  "required": true,
  "maxBytes": 4096
}
```

foundation은 extension 내용을 만들지 않는다. allocation 호출자가 목록을 고정하고
commit이 existence, regular-file identity, byte cap과 receipt digest를 검증한다.

목록은 최대 16개다. `name`은 `^[a-z][a-z0-9-]{0,63}$`, `relativePath`는
`.extensions/` 바로 아래의 소문자 단일 파일명이며
`^[a-z0-9][a-z0-9._-]{0,127}$`를 만족해야 한다. slash, backslash, NUL,
`.`/`..`를 거부한다. 모든 extension은 `.extensions/<relativePath>`에만 쓰므로
`publish.lock.d`, state/manifest/marker 같은 session-root 이름과 충돌할 수 없다.

name과 relativePath는 각각 case-fold 기준으로 중복될 수 없다. `maxBytes`는 0 이상 1,048,576 이하
정수이고 file size `<= maxBytes`가 허용된다. maxBytes 0은 empty file만 허용한다.
`required:false` 파일이 없으면 receipt와 final readiness `extensions` 양쪽에서
생략하고, 존재하면 동일 검증을 적용한다.

pending에는 token, deck, persona archetype, 절대경로를 넣지 않는다.

### 6.4 .engine-ready.json

concrete engine staging initializer가 `session.json`, `state.json`, `players.json`을 모두
쓴 뒤 마지막에 기록한다.

```json
{
  "schemaVersion": 1,
  "storeId": "8c36ea07-9a62-4d64-8b35-f186535ac923",
  "gameId": "ef6ec0a9-a851-4e88-853a-7bfd4d95e63b",
  "operationId": "4d970d18-6984-4e97-b64f-aa72e04baa02",
  "stateSha256": "<64 lowercase hex>",
  "playersSha256": "<64 lowercase hex>",
  "createdAt": "2026-08-31T07:01:01.000Z"
}
```

engine marker가 없거나 hash가 다르면 base initialization은 완료되지 않았다.

### 6.5 .session-ready.json

foundation `commitPreparedSession`만 쓴다. base marker와 모든 extension receipt를
검증한 **뒤 마지막 staging write**로 기록한다.

```json
{
  "schemaVersion": 1,
  "storeId": "8c36ea07-9a62-4d64-8b35-f186535ac923",
  "gameId": "ef6ec0a9-a851-4e88-853a-7bfd4d95e63b",
  "operationId": "4d970d18-6984-4e97-b64f-aa72e04baa02",
  "manifestSha256": "<64 lowercase hex>",
  "stateSha256": "<64 lowercase hex>",
  "playersSha256": "<64 lowercase hex>",
  "extensions": [],
  "readyAt": "2026-08-31T07:01:02.000Z"
}
```

`extensions`에는 `{name, relativePath, sha256, bytes}`만 들어가며 `bytes`는 파일의
UTF-8 octet 길이다. readiness marker
자신은 digest 목록에 포함하지 않는다.

readiness 안 state/players/extension digest는 **current 선택 당시 생성 증거**다. runtime
mutation 뒤 `resolveCurrent`가 mutable state/extension body와 다시 비교하지 않는다.

### 6.6 current.json

store 생성 시 foundation은 다음 never-selected sentinel을 쓴다.

```json
{
  "schemaVersion": 1,
  "storeId": "8c36ea07-9a62-4d64-8b35-f186535ac923",
  "layout": "none",
  "selectionVersion": 0,
  "selectedAt": null
}
```

store marker가 있는데 current가 없으면, `ensureStore` bootstrap recovery가
pending/last-operation/legacy capability가 없고 sessions가 없거나 비어 있음을 증명한
경우에만 none sentinel을 만든다. 그 밖은 `BAD_CURRENT_SESSION`이고 sessions scan으로
복구하지 않는다. allocation with no game은 sentinel file digest를
`expectedCurrentSha256`로 사용한다.

```json
{
  "schemaVersion": 1,
  "storeId": "8c36ea07-9a62-4d64-8b35-f186535ac923",
  "gameId": "ef6ec0a9-a851-4e88-853a-7bfd4d95e63b",
  "operationId": "4d970d18-6984-4e97-b64f-aa72e04baa02",
  "layout": "native",
  "selectionVersion": 1,
  "relativeDir": ".session-store.lock.d/sessions/ef6ec0a9-a851-4e88-853a-7bfd4d95e63b",
  "manifestSha256": "<64 lowercase hex>",
  "readySha256": "<64 lowercase hex>",
  "selectedAt": "2026-08-31T07:01:03.000Z"
}
```

current는 final directory와 readiness marker를 검증한 뒤에만 쓴다. current 자체가
정상 session selector이며 sessions scan으로 대체하지 않는다.

legacy-root 변형은 후속 lifecycle이 제공한 immutable capsule legacy manifest와
binding evidence를 foundation `selectLegacySession`이 검증한 뒤에만 쓴다.

```json
{
  "schemaVersion": 1,
  "storeId": "8c36ea07-9a62-4d64-8b35-f186535ac923",
  "gameId": "ef6ec0a9-a851-4e88-853a-7bfd4d95e63b",
  "operationId": "<legacy selection operation UUID>",
  "layout": "legacy-root",
  "selectionVersion": 1,
  "relativeDir": ".",
  "manifestSha256": "<capsule legacy manifest digest>",
  "bindingSha256": "<lifecycle binding evidence digest>",
  "capabilityRel": ".session-store.lock.d/lifecycle-legacy-capability-<operationId>.json",
  "capabilitySha256": "<legacy capability file digest>",
  "selectedAt": "2026-08-31T07:01:03.000Z"
}
```

legacy current에는 `readySha256`가 없다. `resolveCurrent`는 §6.8 capability와 exact
legacy manifest/binding digest를 재검증한다. legacy manifest/binding 의미 작성은
lifecycle 책임이고 foundation은 child-verifiable capability와 pointer CAS를 소유한다.

`selectionVersion`은 current commit마다 이전 값+1이다. `layout:none`만 gameId,
operationId, relativeDir, digest field가 없고 native/legacy에는 모두 필수다.

### 6.7 last-operation.json

```json
{
  "schemaVersion": 1,
  "storeId": "<uuid>",
  "operationId": "<uuid>",
  "gameId": "<uuid>",
  "outcome": "published",
  "currentSha256": "<64 lowercase hex>",
  "finishedAt": "2026-08-31T07:01:03.000Z"
}
```

`outcome`은 `published|abandoned|legacy-selected`다. commit/abandon/legacy-select가 current 또는 no-change current를
확인한 뒤, pending unlink 전에 기록한다. response loss 후 pending이 없어도 같은
operationId의 last receipt와 current/tree 상태가 일치하면 idempotent result를 반환한다.

### 6.8 lifecycle-legacy-capability-`<operationId>`.json

capsule의 operation별 예약 이름 `lifecycle-legacy-capability-<operationId>.json`은 foundation
`selectLegacySession`이 마지막에 쓴다.

```json
{
  "schemaVersion": 1,
  "storeId": "<uuid>",
  "gameId": "<uuid>",
  "operationId": "<uuid>",
  "relativeDir": ".",
  "rootDev": "<decimal bigint string>",
  "rootIno": "<decimal bigint string>",
  "manifestRel": ".session-store.lock.d/lifecycle-legacy-session.json",
  "manifestSha256": "<64 lowercase hex>",
  "bindingRel": ".session-store.lock.d/lifecycle-legacy-binding.json",
  "bindingSha256": "<64 lowercase hex>",
  "issuedAt": "2026-08-31T07:01:03.000Z"
}
```

child process는 이 file과 current를 independently 읽어 store/game/operation, current
digest, root dev/ino, manifest/binding exact path+digest를 모두 재검증한다. binding의
semantic fields는 lifecycle 설계가 정의하지만 stale/copied bytes는 foundation digest
검증에서 거부된다.

## 7. mode와 capability 검증

### 7.1 store root

`--store-dir` target은 다음을 만족해야 한다.

- target 자체가 symlink가 아닌 directory
- target owner가 current uid. foreign owner는 `UNSAFE_STORE_PATH`
- `st_mode & 0o022 !== 0`이면 `UNSAFE_STORE_PATH`로 fail-closed한다. foreign UID나
  group/other writer가 capsule pathname을 rename/replace할 수 있는 store에서는 무결성을
  주장하지 않는다.
- top-level `session.json` 부재
- target realpath가 어떤 capsule `sessions` realpath의 자손이 아님
- target 자신의 basename이 `.session-store.lock.d`가 아니고, target basename이
  `sessions`이면서 parent basename이 capsule인 경우도 아님
- ordinary resolve/mutation에서는 capsule이 symlink가 아닌 directory이고
  `store.json`이 valid

top-level native session 또는 sessions 자손을 store로 주면 `BAD_DIRECTORY_MODE`다.

`ensureStore`만 별도 bootstrap admission을 사용한다. store root/capsule의
non-symlink/realpath를 검증하고, markerless capsule은 허용 foundation entry 중
`transaction.lock.d`, `.foundation-tmp-*`, empty `sessions`만 있을 때 transaction을
획득해 다시 검증한 뒤 복구한다. ordinary resolver는 markerless capsule을 허용하지 않는다.

### 7.2 native concrete session

모든 native concrete 호출은 path 문자열 하나가 아니라 다음 capability를 받는다.

```text
storeDir + gameDir + expectGameId + expectOperationId + manifestFile
+ (expectedPendingSha256 | expectedCurrentSha256)
```

digest field는 staging 호출이 pending digest, selected production 호출이 current
digest다.

검증 순서:

1. store/capsule/store marker identity 검증
2. manifest regular file, non-symlink, `st_nlink === 1`
3. gameDir을 read-only fd로 pin한다. path `<gameDir>/session.json`과 supplied
   `manifestFile`을 각각 `O_NOFOLLOW`로 열어 같은 fd에서 fstat/read하고 두
   `(st_dev,st_ino)`가 같아야 한다. 검증 전후 gameDir pathname이 pinned directory
   inode를 계속 가리키는지 확인한다. copied/recovery/outside manifest는 거부한다.
4. manifest storeId/gameId/operationId/layout/relativeDir 검증
5. gameDir realpath가 공식 sessionRel 또는 공식 stagingRel과 일치하는지 검증
6. operation 종류가 staging 또는 published 중 어느 것을 허용하는지 검증

store root를 native concrete로 주거나 wrong manifest/gameId를 주면 mutation 전에
`BAD_DIRECTORY_MODE` 또는 `STALE_SESSION_CAPABILITY`다.

Node에 openat이 없으므로 fd-relative open을 주장하지 않는다. directory 구성요소 교체의
잔여 창은 협력 writer threat model에서 전후 inode revalidation으로 탐지한다.

### 7.3 legacy interface

foundation은 legacy를 만들거나 선택하지 않는다. 후속 lifecycle은
`layout: legacy-root` manifest capability를 제공해야 한다. native validator와 별도
분기로 들어가며, store root가 concrete로 허용되는 유일한 예외다. 그 예외는
`current.layout === legacy-root`, matching gameId, exact capsule legacy manifest,
그리고 lifecycle 설계가 정할 root-state binding evidence를 모두 요구한다.

legacy selection은 lifecycle이 manifest/binding 파일을 만들고 foundation
`selectLegacySession`에 data로 넘긴다. foundation은 §6.8 capability와 current를 쓴다.
각 low-level engine/publisher/coach/server child는 `--legacy-capability-file`을 받아
foundation `resolveLegacyConcreteSession`으로 독립 재검증한다. engine은 tools를
import하지 않고 capability bytes만 읽는다.

## 8. filesystem 안전 규칙

- 모든 containment 비교는 `realpath(storeDir)`에서 공식을 재계산한 절대경로끼리
  수행한다. nested-store 판정은 target realpath의 조상을 올라가며 basename이
  `sessions`이고 그 부모 basename이 `.session-store.lock.d`인 쌍이 있는지 확인한다.
- capsule, sessions, staging, final, `.recovery-*` directory는 current uid owner,
  `st_mode & 0o077 === 0`, non-symlink directory여야 한다. transaction 동안 read-only fd로 열어
  `(st_dev, st_ino)`를 pin하고 pathname이 transaction 끝까지 같은 inode를 가리키는지
  다시 확인한다.
- `.extensions/`도 mode `0700`, current uid, non-symlink directory여야 하며 별도 fd로
  pin해 extension read 전후와 promotion 직전에 pathname inode를 재검증한다.
- control/manifest/marker는 `O_NOFOLLOW`로 open한 **같은 fd**에서 fstat(regular file,
  `st_nlink === 1`, current uid owner)와 read/hash를 수행한다. path 기반
  `lstat → readFileSync`를 안전 증거로 쓰지 않는다.
- base engine artifact(state.json, players.json), `.engine-ready.json`, extension도
  commit 검증 시 같은 fd-bound regular/nlink/uid/mode/read/hash 절차를 적용한다.
- foundation이 만드는 control/manifest/marker JSON은 mode `0600`, capsule/sessions/
  staging/final directory는 `0700`이다. engine/extension artifact는 publication 전에
  `st_mode & 0o077 === 0`을 fd에서 검증하고 위반하면 fail-closed한다.
- 이 `0600`은 생성/commit 시점 속성이다. 현재 runtime `saveState` writer가 이후
  mode를 유지한다는 보장은 foundation 범위가 아니며, published mutation writer의
  secure temp/O_NOFOLLOW/mode 보존은 hardening 설계가 반드시 닫는다. foundation은
  이 제한을 숨기지 않는다.
- secure atomic writer는 same-directory temp를 `O_CREAT|O_EXCL|O_NOFOLLOW`, mode
  `0600`, unpredictable UUID 이름으로 만들고 full write, close, rename을 수행한다.
  capsule temp의 예약 prefix는 `.foundation-tmp-`다.
- CAS 대상 control JSON은 foundation `stableJson` 하나로 recursive lexicographic key
  ordering, compact UTF-8, trailing newline 없음으로 직렬화한다. parse-and-rewrite를
  허용하지 않고 valid existing file은 byte no-op으로 유지한다.
- 이 설계의 보장은 process-crash atomicity다. fsync power-loss durability와 store
  protocol을 무시하는 악의적 same-UID writer는 위협모델 밖이다. 협력 process와
  transaction 중 우발 path 교체는 fd/inode 재검증으로 탐지한다. 장기 runtime bind 후
  교체 방어는 hardening 설계가 소유한다.
- staging과 final은 같은 `sessions/` parent 아래다. rename 실패는 원인과 무관하게
  `SESSION_STORE_FAILED`; copy/delete fallback 없이 staging과 pending을 보존한다.
- final destination이 이미 있으면 collision로 fail-closed하고 덮어쓰지 않는다.
  Node/POSIX rename의 no-replace 부재 때문에 이 보장은 모든 writer가 transaction
  protocol을 따른다는 위 threat model 안의 precheck+inode recheck 계약이다.
- current pointer가 공개된 final directory는 foundation API로 rename/delete하지 않는다.
- capsule의 `.foundation-tmp-*` 잔여는 transaction lock 아래 fd identity와
  single-link/current-uid를 검증한 뒤 삭제할 수 있다. session staging 내부 temp는
  incomplete staging 전체와 함께 forensic preserve하며 개별 삭제하지 않는다.

## 9. transaction lock

capsule `transaction.lock.d`는 lifetime owned lock이 아니라 기존 short named mutex
판정 로직을 그대로 쓰는 새 sync wrapper
`withNamedLockSyncStrict(capsuleDir,'transaction.lock.d',fn,
{retryMs:100,timeoutMs:8000})`를 사용한다. `engine/state.js`가 기존 `acquireMutex`/
`releaseMutex`의 mkdir, inode pin, reclaim 원시를 재사용하되 strict owner 판정 분기를
별도로 구현해 export한다. 기존 default
`withNamedLock`은 1줄 pid와 기존 판정을 그대로 유지하고, strict adapter만
`pid\nstartTime` 2줄 owner record를 쓴다.

strict wrapper는 capsule parent directory inode를 pin하고, existing lock directory가
symlink/non-directory면 `UNSAFE_LOCK_PATH`로 거부하며, acquire 전후 pathname이 같은
parent/lock inode를 가리키는지 확인한다. 같은-UID 악성 swap은 threat model 밖이지만
outside-capsule symlink를 정상 입력으로 따라가지 않는다.

timeout은 pid-less staleness threshold 6000ms보다 길어 mkdir→pid write 전 crash도
다음 waiter가 mtime+inode 검증으로 회수한다. valid live pid owner는 나이와 무관하게
회수하지 않는다. strict 2줄 record의 startTime mismatch는 dead다. pid-less empty
lock과 torn/malformed owner record는 pid 외 foreign entry가 없고 mtime 6초를 넘겼을
때만 inode-verified reclaim한다. unreadable record 또는 foreign extra entry는
`LOCKED`로 fail-closed한다. owner write 도중 crash는 F4에 포함한다. 이 stricter 분기는 transaction lock에만 적용하며 기존
shared mutex 판정 로직을 수정하지 않는다.

자기 startTime을 얻지 못하면 lock directory를 만들기 전에 `IDENTITY_UNAVAILABLE`로
실패한다. local pid/startTime 조회의 `ps`만 foundation의 외부-process 금지 예외다.

callback 성공/throw 모두 inode를 확인해 release한다. lock을 가진 동안 child process,
network, LLM, 장기 filesystem 작업을 기다리지 않는다. persistent capsule 자체에는
어떤 lock API도 적용하지 않는다. foundation mutation API는 sync이고 read-only API는
lock을 잡지 않는다. mutation API는 최대 8000ms 호출 thread를 block할 수 있으므로
server/publisher/coach 이벤트 루프는 직접 호출하지 않고 lifecycle process가 호출한다.
read-only API는 lock 대기 없이 즉시 완전한 old/new file 중 하나를 읽는다.

락 순서는 후속 lifecycle이 가진 store lifetime lock → transaction lock →
session-local lock이다. foundation은 lifetime lock을 획득하지 않는다. caller의
`expectedCurrentSha256`는 allocation 진입 CAS에만 쓰고 pending의
`previousCurrentSha256`로 봉인한다. 이후 commit/recovery의 current CAS 권위는
`pending.previousCurrentSha256 == 현재 current.json file sha256` 하나다.
이 순서는 동시에 보유하는 락에만 적용된다. 초기 `ensureStore`는 lifetime lock이 아직
없는 bootstrap에서 transaction mutex를 단독 획득하고 완전히 해제한 뒤 lifecycle
ownership 단계로 넘어갈 수 있다.

## 10. API

`engine/session-store.js`는 network/LLM/game child를 사용하지 않는다. strict lock의
local pid/startTime 조회 `ps`만 예외다. 다음 API를 export한다.

mutation API `ensureStore`, `allocateSession`, `ensureStagingForOperation`,
`recordPendingPhase`, `commitPreparedSession`, `preserveIncompleteStaging`,
`abandonPendingSession`, `selectLegacySession`은 내부에서 strict transaction mutex를
잡는다. root `session-capability.js`의 read-only API `resolveCurrentSelector`, `requireCurrentSession`,
`resolveStagingSession`, `resolveSelectedNativeSession`, `resolveLegacyConcreteSession`,
`inspectPreparedSession`, `classifyPendingRecovery`, `inspectNativeSession`는 lock을 잡지 않고 atomic rename의
이전/이후 완전한 파일 중 하나만 읽는다.
`writeSecureStagingJson`과 `writeSecureExtension`은 store transaction을 잡지 않는
staging writer이며 lifecycle 단일-executor precondition과 pending digest capability를
요구한다.

pending operation mutation은 `{operationId, expectedPendingSha256}`를 공통 capability로
받고 둘 다 transaction 안에서 재검증한다. 첫-process convenience로 sha를 생략하는
표면은 없다. pending을 유지하는 성공은 successor `pendingSha256`을 반환하고,
pending을 제거하는 commit/abandon은 last-operation/current 기반 terminal receipt를
반환한다.

인증 matrix:

- pending이 entry 시 존재하면 caller의 expectedPendingSha256가 exact match해야 한다.
- 같은 transaction 안의 internal phase write는 caller digest를 다시 검사하지 않고 새
  pending digest를 계산해 successor로 반환한다.
- crash 뒤 pending이 남으면 caller는 `classifyPendingRecovery`의 새 pendingSha256로 재진입한다.
- pending이 이미 없으면 old pending digest를 요구하지 않는다. commit은 exact selected
  authority tuple+published last-operation, abandon은 unchanged current+abandoned
  last-operation을 operationId로 검증해 idempotent 반환한다.
- pending-부재 재호출도 `expectedPendingSha256` 위치 인자는 필수이고 64-hex 문법만
  검사하며 값은 대조하지 않는다. caller는 직전에 받은 stale digest를 그대로 넘기고
  null은 허용하지 않는다.

### `ensureStore(storeDir)`

capsule을 secure mkdir한다. **capsule 내부** 허용 entry는 foundation 집합
`{store.json,current.json,pending-session.json,last-operation.json,transaction.lock.d,sessions}`,
`.foundation-tmp-*`, 그리고 lifecycle 예약 prefix `lifecycle-*`다. 그 밖은
`BAD_SESSION_STORE`다. capsule만 있고 marker/current/pending/sessions가 없는 crash
잔여는 transaction lock 아래 valid marker, `layout:none` current sentinel과 sessions
directory로 초기화한다.
marker만 있고 sessions가 없으면 sessions를 만들고, marker 없이 빈 sessions만 있으면
marker를 만든다. marker 없이 non-empty sessions면 fail-closed한다. capsule control
temp 잔여는 §8 검증 후 제거한다.
store root의 legacy state/archive/hands/review 등에는 allow-list를 적용하지 않는다.
storeDir가 없으면 그 parent가 존재하는 경우에만 mode `0700` 단일 mkdir로 만든다.
parent까지 recursive 생성하지 않는다. parent 부재/권한 실패는 `SESSION_STORE_FAILED`다.
여기서 empty capsule은 현재 호출이 획득한 `transaction.lock.d`를 제외하고 persistent
entry가 없다는 뜻이다.

store.json/current.json/sessions가 이미 valid면 pending 유무와 무관하게 store/current를
다시 쓰지 않는 byte+inode no-op다. current write는 §6.6 missing-sentinel bootstrap
predicate에서만 허용한다.
no-op/cleanup 판정도 strict transaction mutex 안에서 하므로 다른 live owner가 있으면
최대 8000ms 대기 후 `LOCKED`이고 lock 없이 우회 반환하지 않는다.

정상 bootstrap syscall 순서는 capsule mkdir → strict named transaction mutex → store.json
secure atomic write → none current sentinel → sessions mkdir → lock release다. 각 안정 중간 상태는 §11 표에
있다. transaction mutex mkdir/pid/unlink/rmdir crash는 §9 short-mutex staleness와
inode/rmdir 계약으로 복구하거나 fail-closed한다.

### `writeSecureStagingJson(descriptor, relativeName, value)`

validated staging descriptor와 닫힌 이름 `state.json|players.json|.engine-ready.json`만
받아 §8의 exclusive temp/fd/mode 계약으로 JSON을 원자 기록한다. foundation control과
manifest는 내부 secure writer를 사용하고, internal engine staging initializer는 이
API를 쓴다. 임의 path writer가 아니다. runtime mutation writer로의 확대는 별도 구현
판단이지만 published token-bearing state가 처음부터 `0600`이 되도록 staging init에는
필수다.

### `writeSecureExtension(input)`

`{storeDir,operationId,expectedPendingSha256,name,content}`를 받아 pending의 닫힌
requiredExtensions entry를 찾는다. `resolveStagingSession`과 pinned `.extensions/`
directory를 재검증하고 size cap, exact lowercase filename, current uid/mode를 확인한
뒤 exclusive same-directory temp→rename으로 `.extensions/<relativePath>`를 쓴다.
write 전후 `.extensions` pathname inode를 확인하고 outside path를 쓰지 않는다.
반환 receipt는 `{name,relativePath,sha256,bytes}`다. lifecycle이 임의 fs writer로
extension을 만들지 않는다.

아래 read-only selector/capability API는 repository root `session-capability.js`가
소유한다. `engine/session-store.js`, tools, server가 이 shared contract만 import하며
server가 engine/을 import하지 않는다. ARCHITECTURE.md 의존 표에는
`server/ → session-capability.js` 허용을 `publish-contract.js`와 같은 예외로 추가한다.
`session-capability.js`는 `node:fs`, `node:path`, `node:crypto`만 import하고
`engine/`·`tools/`를 import하지 않는다. read-only API는 transaction lock을 잡지 않는다.
ARCHITECTURE.md 불변식에도 이 import 폐쇄성을 추가한다.

### `resolveCurrentSelector(storeDir)`

current, manifest file digest, readiness file digest를 검증해
`{...descriptor,currentSha256}`를 반환한다. current의 `manifestSha256`과
`readySha256`만 각각 immutable `session.json`과 `.session-ready.json` 전체 file digest에
대조한다. readiness 안 mutable state/extension 생성 시점 digest는 다시 검사하지 않는다.
`layout:none`도 descriptor와 file digest를 정상 반환한다. current file 자체가 없으면
`BAD_CURRENT_SESSION`이다. directory scan fallback은 없다. legacy는 §6.8 capability를 사용한다.

### `requireCurrentSession(storeDir)`

selector가 none이면 `NO_CURRENT_SESSION`, 아니면 native/legacy frozen descriptor를
반환한다. 신규 allocation은 이 함수가 아니라 selector digest를 사용한다.

### `resolveStagingSession(input)`

입력은 `{storeDir,gameDir,expectGameId,expectOperationId,manifestFile,
expectedPendingSha256}`다. pending과 staging §7 capability를 fd-bound로 검증한다.
internal initializer/extension writer만 사용한다.

### `resolveSelectedNativeSession(input)`

입력은 `{storeDir,gameDir,expectGameId,expectOperationId,manifestFile,
expectedCurrentSha256}`다. current의 selected authority tuple
`{storeId,gameId,operationId,sessionRel,manifestSha256,readySha256,currentSha256}`와
target manifest/readiness가 모두 일치해야 한다. engine/publisher/coach/server production
child는 이 함수만 사용한다. ready final이 있어도 current가 선택하지 않았으면 거부한다.

unselected historical final inspection은 별도 read-only `inspectNativeSession`이며 production
mutation capability를 반환하지 않는다. CLI flag wiring은 lifecycle/hardening 책임이다.

### `assertNotNativeSessionArchiveTarget(gameDir)`

realpath가 (a) capsule 자신, (b) capsule의 `sessions` 자신, (c) 그 아래 임의
staging/final/recovery descendant면 marker 존재 전에도 legacy
`initGameDir`/`vacateLive`/`closeOpenPartial` target으로 쓰지 못하고
`BAD_DIRECTORY_MODE`다. §7.1 capsule/sessions basename+ancestor 술어를 그대로
재사용하고 manifest/readiness 검사는 defense in depth다. 새 코드의
destructive archive entry가 첫 mutation 전에 호출한다. 구버전 rollback binary의
우회 방지는 compatibility launcher 설계 책임이다.

### `resolveLegacyConcreteSession(input)`

`{storeDir,gameDir,expectGameId,legacyCapabilityFile}`을 받아 §6.8 current/capability/
manifest/binding/root inode를 independently 검증한다. `gameDir`는 store root 자신이어야
한다. frozen descriptor를 반환하며 child process마다 같은 검증을 반복한다.

### `allocateSession(input)`

입력:

```text
storeDir, expectedCurrentSha256(64 hex), init config, requiredExtensions
```

transaction 안에서 current CAS와 pending 부재를 확인하고 UUID를 만든 뒤
`pending-session.json`을 operation-specific **첫 persistent write**로 기록한다.
staging과 manifest는 만들지 않는다. 반환:

```json
{
  "kind": "allocated",
  "storeId": "<uuid>",
  "operationId": "<uuid>",
  "gameId": "<uuid>",
  "stagingRel": ".session-store.lock.d/sessions/.<gameId>.creating",
  "sessionRel": ".session-store.lock.d/sessions/<gameId>",
  "stagingManifestRel": ".session-store.lock.d/sessions/.<gameId>.creating/session.json",
  "sessionManifestRel": ".session-store.lock.d/sessions/<gameId>/session.json",
  "previousCurrentSha256": "<64 lowercase hex>",
  "pendingSha256": "<64 lowercase hex>"
}
```

pending이 이미 있으면 `SESSION_CREATION_IN_PROGRESS`, current CAS가 다르면
`CURRENT_CHANGED`다.
allocation은 journal 전에 candidate staging/final이 모두 absent인지 fd/parent identity
아래 확인한다. 충돌하면 새 UUID를 최대 8회 생성하고, 모두 충돌하면
`SESSION_ID_EXHAUSTED`다. 기존 staging/final을 같은 gameId라는 이유로 채택하지 않는다.
operationId도 last-operation과 lifecycle capability filename에 충돌하지 않는지 확인하고
충돌 시 새 operationId를 생성한다.

### `ensureStagingForOperation(storeDir, operationId, expectedPendingSha256)`

transaction 안에서 pending/current CAS/gameId를 재검증한다. 진입 첫 검사에서 exact
final directory가 존재하면 staging을 만들거나
수정하지 않고 `SESSION_RECOVERY_REQUIRED`로 거부한다. 그 뒤 staging이 없으면 mode
0700으로 만들고 `.extensions/` mode 0700과 immutable session.json을 secure write한 뒤
pending phase를 allocated로 reset한다.

staging이 있으면 다음 순서로 전수 판정한다.

| manifest | `.extensions/` | 그 밖의 entry | 결과 |
|---|---|---|---|
| 없음 | 없음 또는 valid empty dir | 없음 | missing dir 생성 + manifest write |
| 없음 | 임의 | 하나 이상 | `PRESERVE_REQUIRED` |
| invalid | 임의 | 임의 | `PRESERVE_REQUIRED` |
| valid | 없음 | foundation/base entry만 | extensions dir 생성 후 success |
| valid | valid dir, 열거 file만 | foundation/base entry만 | idempotent success |
| valid | valid dir, 열거 file만 | valid same-operation `.session-ready.json` 포함 | idempotent ready success |
| valid | 임의 | invalid/mismatched `.session-ready.json` 포함 | `PRESERVE_REQUIRED` |
| valid | symlink/foreign/invalid dir | 임의 | `PRESERVE_REQUIRED` |
| 임의 | temp/미등재 file 포함 | 임의 | `PRESERVE_REQUIRED` 최우선 |
| 임의 | 임의 | temp 또는 미등재 root entry | `PRESERVE_REQUIRED` 최우선 |

base entry는 state.json, players.json, .engine-ready.json이고 재진입 시 valid
.session-ready.json도 허용한다. 이 함수는 base 내용
완전성을 판단하지 않고 recovery classifier가 다음 action을 정한다.

### `recordPendingPhase(storeDir, operationId, expectedPendingSha256, expectedPhase, nextPhase)`

정확한 operation/gameId/current CAS를 재검증하고 단조 phase만 기록한다.

### `inspectPreparedSession(storeDir, operationId, expectedPendingSha256, extensionReceipts)`

base marker와 extension identity/digest를 read-only 검증하고 readiness payload를
반환한다. 파일을 쓰지 않는다.

### `commitPreparedSession(storeDir, operationId, expectedPendingSha256, extensionReceipts)`

transaction 안에서 pending에 봉인된 current CAS, staging containment,
immutable manifest의 exact storeId/gameId/operationId/layout/relativeDir,
base/extension digest와 artifact mode를 fd-bound로 다시 검증한다. `.session-ready.json`을 마지막
staging write로 기록하고 검증한 뒤 staging을 final로 rename한다. commit entry에 valid
same-operation `.session-ready.json`이 이미 있으면 expected readiness payload/digest와
대조해 같을 때 byte no-op으로 재사용하고, 다르면 `PRESERVE_REQUIRED`다. rename 뒤 phase
`promoted`를 진단 hint로 기록하고 current를 원자 교체한다. exact selected tuple을
재검증한 뒤 last-operation outcome `published`, phase `selected`, pending unlink 순서로
기록한다. current가 같은 gameId+operationId를 이미 가리키면 idempotent recovery로
나머지 receipt/cleanup을 완성한다. recovery 판정의 권위는 filesystem/current 관찰이며 pending
phase는 단조 진단 hint다.

commit 진입 내부 분기:

| staging | exact final | current | 동작 |
|---|---|---|---|
| 있음 | 없음 | previous CAS | validate→ready→rename→select |
| 없음 | 있음(same operation) | previous CAS | final 검증 후 select부터 재개 |
| 없음 | 있음(same operation) | same selected tuple | receipt/phase/pending cleanup 재개 |
| 있음 | 있음 | 임의 | `SESSION_RECOVERY_REQUIRED`, 둘 다 보존 |
| 없음 | 없음 | 임의 | pending classifier action으로 반환, commit mutation 없음 |
| 임의 | mismatch final/current | 임의 | fail-closed |

readiness write 전 staging root 허용 entry는
`{session.json,state.json,players.json,.engine-ready.json,.extensions}`이고, 재진입에 한해
valid same-operation `.session-ready.json` 하나를 추가로 허용한다.
`.extensions/` 아래는 requiredExtensions가 열거해 실제 존재하는 파일만 허용한다.
foundation temp나 미등재 entry가 하나라도 있으면 promotion하지 않고
`PRESERVE_REQUIRED` action을 반환한다. `BAD_SESSION_STORE`는 storeId/gameId/
operationId/digest/containment 위반에 예약한다. readiness write 뒤에는 위 집합에 `.session-ready.json` 하나만 추가된 상태를
재검증한다. runtime이 이후 final session에 추가할 hands, locks, review 등은 이 pre-publish
staging allow-list 대상이 아니다.

current commit 전 phase는 봉인된 previousCurrentSha256 CAS를 사용한다. current를 같은
gameId+operationId로 교체한 뒤의 `published` receipt, `selected` 기록과 cleanup은 selected
authority tuple 전체 일치를 권위로 사용한다. post-commit에 이전 current digest를 다시
요구하지 않는다.

성공 반환은 `{kind:'published',storeId,operationId,gameId,sessionRel,
sessionManifestRel,currentSha256,idempotent,pendingCleaned}`다. response loss로
재호출할 때 pending이 이미 없어도 current.operationId와 final manifest/readiness
digest가 모두 같으면 같은 descriptor를 `idempotent:true`로 반환한다. 다른
operation/current는 거부한다.

### `classifyPendingRecovery(storeDir)`

exact pending이 지목한 path만 읽고 다음 frozen descriptor를 반환한다. mutation하지 않는다.
pending-session.json이 없으면 `NO_PENDING_SESSION`을 throw하고 `sessions/` children을
읽지 않는다. §11의 pending-부재 idle/diagnostic 행은 ensureStore 또는 별도 operator
inspection 소관이며 이 classifier가 scan해 추측하지 않는다.

```json
{
  "action": "create_staging",
  "pendingSha256": "<64 lowercase hex>",
  "storeId": "<uuid>",
  "operationId": "<uuid>",
  "gameId": "<uuid>",
  "phase": "allocated",
  "init": {"aiCount":3,"startStack":5000,"blinds0":[25,50],"levelEvery":8},
  "requiredExtensions": [],
  "previousCurrentSha256": "<64 lowercase hex>",
  "stagingRel": "<canonical relative path>",
  "sessionRel": "<canonical relative path>",
  "observed": {"staging":"absent","final":"absent","currentLayout":"none"}
}
```

fresh lifecycle process는 이 descriptor만으로 engine/extension work를 다시 구성한다.
모든 pending mutation API는 operationId와 required `expectedPendingSha256`를 받아
transaction 안에서 descriptor가 stale하지 않은지 재검증한다.

`observed`의 닫힌 field는 다음과 같다.

```text
staging: absent|present
final: absent|present
currentLayout: none|native|legacy-root
currentOperationId: uuid|null
manifest: absent|valid|invalid
manifestOperationId: uuid|null
rootUnexpectedEntries: [relativeName]
extensionUnexpectedEntries: [relativeName]
engineArtifacts: [state.json|players.json|.engine-ready.json]
engineReadyValid: boolean
extensionsComplete: [name]
extensionReceipts: [{name,relativePath,sha256,bytes}]
sessionReadyValid: boolean
finalOperationId: uuid|null
```

action별로 관련 field를 모두 채우고 무관한 배열은 빈 배열, 무관한 scalar는 null을
쓴다. lifecycle이 별도 scan으로 action을 재구성하지 않는다.

classifier의 닫힌 action enum은 `create_staging`, `preserve_and_recreate`,
`initialize_engine`, `complete_extensions`, `commit_ready`, `promote`, `select`,
`cleanup_journal`, `manual_recovery_required`, `current_changed`, `bad_session_store`다.
API return action `PRESERVE_REQUIRED`는 classifier의 `preserve_and_recreate`와 같은
상태를 뜻한다. `commit_ready` cold process는 descriptor의 extensionReceipts를 그대로
commit에 전달하거나 foundation writer로 동일 receipt를 재생성한다.

### `preserveIncompleteStaging(storeDir, operationId, expectedPendingSha256)`

pending과 exact staging identity가 일치하고 final/current가 그 gameId를 공개하지
않았을 때만 staging을 unpredictable `.recovery-*` sibling으로 rename한다. delete하지
않는다. 같은 transaction에서 pending.phase를 `allocated`로 되돌린다. rename 뒤 phase
reset 전 crash가 나면 classifier는 phase와
무관하게 `pending valid + staging/final 없음`을 `create_staging`으로 판정하고
ensureStaging이 allocated를 복구한다.

recovery destination도 final과 같은 cooperative-writer no-replace 계약을 쓴다. random
nonce path의 absence를 parent inode 아래 확인하고 collision이면 새 nonce를 생성하며,
existing empty/non-empty recovery directory를 rename으로 덮어쓰지 않는다.

### `abandonPendingSession(storeDir, operationId, expectedPendingSha256)`

preserve가 완료됐거나 staging/final이 없고, current가 pending gameId를 공개하지 않으며
pending에 봉인된 current CAS가 같은 경우에만 pending을 제거해 store를 idle로 돌린다.
published session/final directory는 건드리지 않는다. classifier가 자동 선택하는 action이
아니며 lifecycle이 명시적 정책으로만 호출한다. pending unlink 전에
last-operation outcome `abandoned`를 기록하므로 response loss 후 같은 operation retry는
idempotent success다.

### `selectLegacySession(input)`

`{storeDir,expectedCurrentSha256,gameId,operationId,legacyManifestFile,
legacyBindingFile}`을 받아 transaction 안에서 exact lifecycle-prefix path, regular/nlink/
uid/mode, digest와 root inode를 검증한다. native pending이 없어야 하며 있으면
`SESSION_CREATION_IN_PROGRESS`다. operation별 §6.8 capability file을 먼저 쓰고
그 digest를 담은 legacy current를 CAS write한다. foundation이 current의 유일한 writer다.
legacy binding semantic schema/행동은 lifecycle이 정하지만 pointer write 우회는
허용하지 않는다. current 검증 뒤 last-operation outcome `legacy-selected`를 기록한다.
response loss는 same operation current+capability+last receipt digest로 멱등 반환한다.

## 11. 생성과 recovery truth table

| 관찰 상태 | action | mutation owner |
|---|---|---|
| capsule 없음 | `initialize_store` | `ensureStore` |
| empty capsule, marker 없음 | `initialize_store` | `ensureStore` |
| marker valid, current sentinel 없음 | `create_none_current` | `ensureStore` only when no session/pending/last-op exists; otherwise BAD_CURRENT_SESSION |
| marker+none current valid, sessions 없음 | `create_sessions` | `ensureStore` |
| marker 없음, empty sessions 존재 | `initialize_store` | `ensureStore` |
| marker 없음, non-empty sessions 존재 | `bad_session_store` | 자동 mutation 없음 |
| capsule `.foundation-tmp-*` 잔여 | `cleanup_control_temp` | `ensureStore`가 fd 검증 후 제거 |
| marker+current valid, pending 없음 | `idle` | 없음 |
| pending phase promoted/selected인데 exact final 없음 | `bad_session_store` | 자동 재생성 없음 |
| valid pending pre-publish phase, staging/final 없음 | `create_staging` | `ensureStagingForOperation` |
| staging root 또는 `.extensions/`에 temp/미등재 entry 존재 | `preserve_and_recreate` | artifact 상태보다 먼저 판정 |
| staging 존재, entry 없음 또는 empty `.extensions/`만 존재 | `create_staging` | `ensureStagingForOperation`이 missing manifest만 보완 |
| staging 존재, session manifest 없음/invalid + 다른 entry 존재 | `preserve_and_recreate` | lifecycle가 preserve 후 foundation ensureStaging 호출 |
| manifest valid, engine artifacts 전부 없음 | `initialize_engine` | lifecycle가 internal engine staging init 호출 |
| engine artifact 일부 존재, valid engine-ready 없음 | `preserve_and_recreate` | lifecycle |
| engine-ready 존재하지만 hash mismatch | `preserve_and_recreate` | lifecycle |
| engine-ready valid, required extension 미완료 | `complete_extensions` | lifecycle |
| base/extensions valid, session-ready 없음 | `commit_ready` | foundation commit API |
| session-ready valid, staging만 존재 | `promote` | foundation commit API |
| exact operationId final 존재, current가 previous, staging 없음 | `select` | foundation commit API |
| current가 같은 gameId+operationId, exact final, staging 없음, pending 존재 | `cleanup_journal` | foundation commit API |
| staging과 final 동시 존재(current 여부 무관) | `manual_recovery_required` | 자동 mutation 없음 |
| current가 다른 값으로 CAS 변경 | `current_changed` | 자동 mutation 없음 |
| storeId/gameId/path/digest 불일치 | `bad_session_store` | 자동 mutation 없음 |
| pending 없이 orphan staging/final | `diagnostic_only` | 정상 selector는 무시 |

판정 precedence는 다음 순서다: pending/schema/containment 검증 → staging+final 동시
존재 → current same-operation 여부 → current changed 여부 → final-only → staging temp/
미등재 entry → staging-only 내부 상태. final/select/cleanup은 immutable manifest의 operationId가 pending과
같을 때만 허용한다. gameId만 같은 pre-existing artifact는 collision이다.

`preserve_and_recreate`는 old staging bytes를 보존한 뒤 새 exact staging과
`session.json`만 만든다. token/state/persona가 current에 공개된 적 없으므로 engine은
새 값을 생성할 수 있다. recovery directory는 자동 selector나 current 후보가 아니다.

`pending-session.json`이 없어졌는데 orphan이 남은 경우 normal path가 scan해 선택하지
않는다. 후속 `session-inspect`가 forensic 후보와 digest를 보고하고, manual recovery는
inspect receipt를 transaction 안에서 재검증해야 한다.

## 12. 신규 session sequence

0. `ensureStore`가 capsule/store marker/none current/sessions와 control temp recovery를 끝낸다.
1. lifecycle이 store lifetime ownership과 이전-session eligibility를 해결한다.
2. `allocateSession`이 pending을 첫 operation write로 만들고 transaction lock을 해제한다.
3. `ensureStagingForOperation`이 staging+immutable manifest를 만든다.
4. lifecycle이 phase를 `initializing`으로 전진시키고 internal engine staging initializer를 호출한다.
5. engine은 foundation secure writer로 state/players를 쓰고 `.engine-ready.json`을 마지막에 쓴다.
6. lifecycle이 phase를 `base_ready`로 전진시키고 foundation `writeSecureExtension`으로
   required extensions와 receipt를 만든 뒤 `extensions_ready`로 전진시킨다.
7. `commitPreparedSession`이 base/extensions를 검증하고 `.session-ready.json`을 쓴다.
8. same-parent staging→final rename.
9. current atomic commit.
10. pending cleanup.
11. lifecycle이 반환된 frozen descriptor로 game-loop를 만든다.

foundation transaction lock은 2~3, 7~10의 짧은 metadata 구간에서만 잡는다. engine과
extension 생성 중에는 잡지 않는다.

internal initializer의 정본은 `engine/session-init.js::initializeStagingGame`이다.
unpublished staging에 `withMutation`/`runExclusive`를
호출하지 않아 `.mutex`를 만들지 않는다. staging capability와 foundation secure writer가
그 예외 경계를 소유한다. published state mutation은 기존 `withMutation` 불변식을 유지한다.
`createGame`의 version 0을 명시적으로 1로 올린 exact initial object를
`writeSecureStagingJson`으로 한 번 쓰며 `saveState`/기존 `writeJsonAtomic`을 호출하지
않는다. 따라서 첫 published stateVersion은 현행 init과 같은 1이다.
ARCHITECTURE.md codemap/상태 불변식/락 재사용 문면을 이 예외와 strict wrapper에 맞게 갱신한다.

## 13. 오류 코드

| code | type | 의미 |
|---|---|---|
| `BAD_DIRECTORY_MODE` | throw | store와 concrete mode가 반대이거나 중첩 store 위험 |
| `BAD_SESSION_STORE` | throw | schema, identity, containment, digest 불일치 |
| `BAD_CURRENT_SESSION` | throw | store marker는 있으나 current가 없거나 invalid |
| `STALE_SESSION_CAPABILITY` | throw | gameId/manifest/path/capability 불일치 |
| `SESSION_CREATION_IN_PROGRESS` | throw | 다른 pending operation 존재 |
| `CURRENT_CHANGED` | throw | expected current CAS 실패 |
| `SESSION_STORE_FAILED` | throw | secure mkdir/write/rename I/O 실패 |
| `UNSAFE_LOCK_PATH` | throw | transaction lock이 capsule 밖/symlink/foreign path |
| `UNSAFE_STORE_PATH` | throw | store root가 foreign owner 또는 unsafe type |
| `LOCKED` | throw | live/unknown/extra-entry transaction owner가 timeout까지 유지 |
| `IDENTITY_UNAVAILABLE` | throw | 호출자 startTime을 얻지 못해 lock 생성 전 중단 |
| `SESSION_RECOVERY_REQUIRED` | throw | 해당 API로는 진행 불가; classifier가 지정한 다른 API 또는 manual recovery 필요 |
| `SESSION_ID_EXHAUSTED` | throw | 8개 UUID candidate가 모두 기존 path와 충돌 |
| `NO_CURRENT_SESSION` | throw | valid layout:none sentinel; engine CLI `NO_GAME`과 구분 |
| `NO_PENDING_SESSION` | throw | pending classifier 호출 시 journal 부재; sessions scan 없음 |
| `PRESERVE_REQUIRED` | return action | incomplete staging을 forensic preserve한 뒤 재시도 |

오류는 token, absolute path, file body를 포함하지 않는다. 진단 detail은 store-relative
path와 gameId/operationId만 허용한다.
exported throw code는 이 표의 `throw` 행에 닫혀 있어야 한다.

## 14. RED gates

### Gate F1 — layout과 identity

- empty store `ensureStore`는 capsule store.json/layout:none current.json/sessions만,
  `allocateSession`은 pending만,
  `ensureStagingForOperation`이 capsule 안 staging/manifest/extensions만 만든다.
  어느 단계도 root `state.json`/`archive/`를 만들지 않는다.
- UUID/schema/path/capability와 token 부재를 검증한다.
- store/session/pending/current/engine-ready/session-ready의 unknown field,
  schemaVersion, kind/layout 불일치를 거부한다.
- never-selected none sentinel과 선택 후 current 삭제를 구분해 전자만 NO_CURRENT_SESSION/새 allocation,
  후자는 BAD_CURRENT_SESSION이고 scan fallback이 없음을 검증한다.
- capsule은 구버전 `vacateLive`의 archive/delete 양쪽에서 inode/bytes 불변이다.
- 구버전 `initGameDir` 전체와 open partial `closeOpenPartial` 경로에서도 capsule
  inode/bytes가 불변이다.
- capsule 자체에 pid 파일을 만들거나 owned-lock API/reclaim을 적용하지 않는지 surface로 검증한다.
- 새 archive entry는 capsule 자신, capsule/sessions 자신, 그 아래 staging/final/
  recovery descendant gameDir를 `BAD_DIRECTORY_MODE`로 거부해 store/session bytes를
  이동·삭제하지 않는다.

### Gate F2 — transaction과 CAS

- 두 allocation race에서 pending은 하나뿐이고 loser는 current/session을 쓰지 않는다.
- valid current와 in-flight pending이 있는 store에서 ensureStore 재호출이
  store/current inode, bytes, digest, selectedAt, selectionVersion을 바꾸지 않는다.
- valid store/current와 capsule control temp가 함께 있으면 temp만 정리하고
  store/current inode/bytes를 바꾸지 않는다.
- live 2-line owner timeout, startTime mismatch/dead owner 즉시 회수, pid-less mkdir
  crash 6초 회수, malformed/unreadable/extra-entry transaction lock `LOCKED`를 검증한다.
- strict adapter의 lock-directory symlink/outside sentinel 거부를 검증하고 기존
  state/publish/coach/archive lock 테스트를 전량 통과시켜 shared primitive semantics
  무변경을 고정한다.
- valid store를 다른 process가 transaction 보유 중 ensureStore하면 timeout 뒤 LOCKED이며 우회 no-op하지 않는다.
- 8회 gameId collision의 SESSION_ID_EXHAUSTED와 self startTime 실패의
  IDENTITY_UNAVAILABLE-before-mkdir를 검증한다.
- public phase 역행을 거부하고 preserve/ensureStaging의 allocated reset 두 예외만 허용한다.
- resolveCurrent가 currentSha256을 반환하고 allocation에서만 caller CAS를 받아 pending에
  봉인하며, commit은 봉인값만 권위로 쓰는지 검증한다.
- current commit 뒤 phase/cleanup 전 재진입은 same-operation idempotent success이고 다른
  current면 `CURRENT_CHANGED`다.
- selectionVersion은 none 0에서 각 successful native/legacy selection마다 정확히 1 증가한다.
- ready final-before-current, orphan final, same gameId/different operationId는
  `resolveSelectedNativeSession` production capability를 얻지 못한다.
- abandon은 staging/final 존재, current가 pending gameId 공개, 봉인 CAS 불일치에서
  거부하고 valid no-artifact 상태에서 last-operation+pending unlink response loss를 멱등 복구한다.

### Gate F3 — readiness

- state/players/engine marker 일부 조합은 current에 공개되지 않는다.
- extension 미완료 상태도 promotion되지 않는다.
- final readiness marker가 모든 foundation/base/extension artifact 뒤 마지막 write다.
- hash/size/nlink mismatch가 current commit 전에 실패한다.
- extension count/grammar, duplicate name/path, traversal, core/marker alias를 allocation에서 거부한다.
- maxBytes 0/정확 cap/cap+1과 extension count 16/17 경계를 검증한다.
- optional extension은 file/receipt 둘 다 없을 때만 생략되고 한쪽만 있으면 실패한다.
- `.extensions/`는 foundation이 `0700`으로 만들고, 미등재 extension/root entry나
  staging temp가 있으면 promotion을 거부한다.

### Gate F4 — crash matrix

- §11 각 자동 action을 failure injection으로 재현하고 정확히 한 gameId로 수렴한다.
- staging mkdir 뒤 manifest 전, players 뒤 state 전, engine-ready 전, ready marker 전,
  allocate pending 뒤 staging 전, atomic temp 뒤 target rename 전, rename 전/후,
  current 전/후, pending cleanup 전/후를 포함한다.
- transaction lock mkdir 뒤 pid write 전, 2줄 owner write 도중 torn record,
  pid unlink/rmdir release 사이 crash를 포함한다.
- incomplete bytes는 forensic sibling에 남고 delete되지 않는다.
- valid same-operation `.session-ready.json` write 뒤 rename 전 crash는 marker를 byte
  no-op 재사용해 idempotent publication으로 수렴한다.
- preserve 뒤 recovery directory는 current uid + group/other 접근 없음, 내부 token-bearing
  JSON도 group/other 접근 없음이 유지된다.
- rename EXDEV/EIO/collision은 copy fallback 없이 staging+pending 보존이다.

| API | injected boundary | terminal 관찰/재시도 |
|---|---|---|
| ensureStore | storeDir/capsule mkdir, lock mkdir→pid, store temp→rename, none-current temp→rename, sessions mkdir, lock pid unlink→rmdir | §11 bootstrap 행으로 수렴; outside inode 불변 |
| allocateSession | pending temp create/write/rename | pending 없음 또는 valid allocated 하나; staging 없음 |
| ensureStaging | staging mkdir, extensions mkdir, manifest temp/rename | empty skeleton roll-forward 또는 preserve-required |
| ensureStaging with exact final | current previous/selected, staging absent/present | `SESSION_RECOVERY_REQUIRED`; 새 staging mutation 없음, final inode/bytes 불변 |
| engine staging | state, players, engine-ready 각각 temp/rename | valid marker 전에는 publication 없음 |
| extension writer | 각 extension temp/rename | receipt/file exact match 전에는 publication 없음 |
| commit | session-ready temp/rename, staging→final, promoted phase, current temp/rename, published last-operation temp/rename, selected phase, pending unlink | operationId+digest 기반 same descriptor idempotent retry |
| preserve | staging→recovery rename, phase reset | no final/current; create_staging으로 재진입 |
| recordPendingPhase | pending temp/rename과 response loss | expectedPendingSha CAS와 transition table 기반 idempotent/거부 |
| abandonPendingSession | last-operation temp/rename, pending unlink | published bytes 불변; same operation idempotent abandoned receipt |
| selectLegacySession | capability temp/rename, legacy current temp/rename | old current 또는 fully bound legacy current; orphan capability는 selector 아님 |

각 boundary는 EIO/permission error와 process death를 별도로 주입하고 exact surviving
paths, inode/bytes 불변, error redaction을 단언한다.
- allocation response를 버린 fresh process가 PendingRecoveryDescriptor만으로 같은
  operationId/gameId/init/extensions를 재개한다.
- classifier의 pending-존재 모든 state가 닫힌 action enum 하나를 반환하는지 검증한다.
- staging+final 동시 존재는 current none/same/different 모두 manual recovery이고 둘 다 보존한다.
- recovery nonce collision은 기존 recovery bytes를 덮지 않고 새 nonce 또는 fail-closed한다.

### Gate F5 — path와 mode

- store-as-concrete, concrete-as-store, wrong gameId/manifest/storeId를 mutation 전에
  거부한다.
- capsule 자신과 capsule/sessions를 storeDir로 주는 nested-store 시도를 거부한다.
- gameDir 밖 copied/recovery/staging manifest로 published dir을 인가할 수 없고
  manifestFile은 gameDir/session.json exact inode여야 한다.
- native staging/selected-published mode와 serialized legacy capability/select CAS를 각각
  valid/missing/stale binding으로 검증한다.
- child process의 serialized legacy capability가 stale current/binding/copied manifest/
  root inode 변경을 독립 거부한다.
- native pending 존재 중 selectLegacySession은 SESSION_CREATION_IN_PROGRESS이고 pending/current 불변이다.
- inspectNativeSession descriptor는 selected production resolver를 대체하거나 mutation에
  사용할 수 없다.
- capsule/session/control file symlink, hardlink, nlink>1, traversal, realpath escape,
  permissions failure를 주입한다.
- `.extensions/` directory symlink/parent swap/foreign owner/mode와 outside sentinel을 검증한다.
- file 검증 뒤 read 직전 pathname을 바꾸어 fd-bound implementation만 통과하도록 한다.
- case-insensitive filesystem에서 대문자 alias extension을 schema 단계에서 거부한다.
- directory/JSON의 `st_mode & 0o077 === 0`과 필요한 owner read/write/execute bit,
  token-free error를 검증한다(umask가 더 좁히는 것은 허용).
- foreign-owned 또는 group/other-writable store는 `UNSAFE_STORE_PATH`로 거부한다.
- 모든 serialized error message/cause chain/envelope가 absolute path, file body, token을
  포함하지 않고 stack은 envelope에 포함하지 않는지 검증한다.
- commit 직후 state `0600`을 확인하고 현행 runtime saveState의 mode 동작을
  특성화해 hardening 설계 입력으로 남긴다; foundation이 게시 후 mode 보존을 주장하지 않는다.

### Gate F6 — current 불변성

- 첫 session current commit 뒤 두 번째 allocation/commit이 첫 session의 path, inode,
  manifest/state/players/readiness bytes를 변경하지 않는다.
- current가 가리키는 final을 foundation API로 rename/delete할 수 없다.
- normal resolution은 orphan/recovery directory를 선택하지 않는다.
- pending 부재 classify는 NO_PENDING_SESSION이고 sessions readdir를 호출하지 않는다.
- promotion 중 concurrent resolve는 old current 또는 fully promoted new current만 보고
  missing directory를 가리키는 pointer를 관찰하지 않는다.
- state.json runtime mutation 뒤에도 immutable manifest/readiness file digest가 같으면
  resolveCurrent가 성공하고 creation-time state digest를 다시 강제하지 않는다.

## 15. 수용 기준

1. foundation API만으로 empty store에서 ready current native session을 만들 수 있다.
2. 모든 생성 crash point가 exact pending metadata로 자동 수렴하거나 명시적
   fail-closed 상태와 preserved evidence를 남긴다.
3. partial session은 current에 공개되지 않는다.
4. current resolution은 pointer와 manifest/readiness digest만 사용하고 scan하지 않는다.
5. published session bytes는 후속 session 생성 때문에 이동·복사·삭제되지 않는다.
6. 기존 root live/archive bytes와 shared publish/coach lock semantics는 변하지 않는다.

## 16. 후속 lifecycle 설계에 제공하는 계약

lifecycle은 다음 precondition을 책임진다.

- store lifetime ownership과 active/previous-session eligibility
- current pointer를 다른 session으로 바꾸기 전에 이전 selected session의 모든
  engine/publisher/coach/server writer를 quiesce한다는 precondition. current 변경 뒤 old
  child capability가 실패하는 것은 의도된 fence다.
- store lifetime lock을 보유한 단일 실행자만 한 operationId의 engine/extension 구간을
  진행한다는 **foundation 밖의 unenforced precondition**. foundation digest/CAS는 일부
  충돌을 탐지하지만 두 writer가 만든 자기정합적 결과까지 fence한다고 주장하지 않는다.
- `expectedCurrentSha256`
- validated init config
- required extension 목록과 receipt
- internal engine staging initializer 호출
- recovery action 실행 순서
- PID reuse/unknown으로 영구 LOCKED인 transaction mutex의 operator inspection/recovery는
  lifecycle/hardening 소유이며 foundation이 자동 강탈하지 않는다는 계약
- native staging/published session dir은 legacy archive/vacate target으로 절대 넘기지
  않고 foundation archive-target guard를 모든 새 entry에서 호출하는 계약
- lifecycle mutable state는 `lifecycle-*` reserved namespace 또는 session 내부 별도
  artifact에 두고 immutable `session.json`을 수정하지 않는 계약
- legacy manifest/binding files와 foundation child-verifiable capability input

foundation은 lifecycle에 다음을 반환한다.

- immutable `storeId`, `operationId`, `gameId`
- canonical storeDir와 store-relative `loop.lock.d` lifetime-lock 경로. native layout에서
  기존 gameDir-relative `assertLoopAllowsInit`/`resume-check` 재배선은 lifecycle 필수 작업
- canonical store-relative staging/final/manifest paths
- frozen current descriptor와 digest
- full PendingRecoveryDescriptor와 pending digest
- staging/selected-native/legacy concrete capability validators
- recovery action enum
- mutation 뒤 검증 가능한 readiness/current receipts
- `selectLegacySession` CAS pointer primitive

child capability의 비밀 아닌 전체 필드:

- native staging: `storeDir`, `gameDir`, `expectGameId`, `expectOperationId`,
  `manifestFile`, `expectedPendingSha256`
- selected native production: `storeDir`, `gameDir`, `expectGameId`,
  `expectOperationId`, `manifestFile`, `expectedCurrentSha256`;
  `expectedPendingSha256`는 포함하지 않음
- legacy production: `storeDir`, `gameDir`, `expectGameId`, `legacyCapabilityFile`

CLI flag 이름 배선만 lifecycle/hardening 설계가 정한다. 이 필드에는 sessionToken이 없고
token transport와 분리된다.

lifecycle은 이 descriptor를 새 game-loop에 한 번 bind한다. foundation은 이후
current가 가리키는 session의 runtime 수명주기를 알거나 변경하지 않는다.
