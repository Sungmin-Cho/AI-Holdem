# 게임 세션 hardening / rollback 설계

날짜: 2026-09-01
상태: DEFERRED_FAIL_CLOSED — R2 독립 검토 FAIL; native dirfd/compat rollback 전제 미충족
선행 계약:

- `docs/2026-08-31-session-store-foundation-design.md`
- `docs/2026-08-31-session-lifecycle-design.md`

## 1. 범위와 결정

이 문서는 session-native persistence의 세 번째 계약이다. foundation/lifecycle state machine을
바꾸지 않고 다음 네 seam을 구현한다.

1. lifecycle-owned 모든 server spawn의 sessionToken 전달을 argv에서 one-shot fd로 바꾼다.
2. published session writer가 symlink/hardlink/root-recreation을 거부하고 mode `0600`을 보존한다.
3. 장기 runtime의 pinned session root inode를 mutation/spawn 경계마다 재검증한다.
4. `rollback-sealed` execution generation과 one-shot wrapper로 구버전 resume을 제한한다.

비목표: pointer/schema/terminal 순서 변경, archive/import/history/retention, engine rule/UI 변경.

현재 release 판정: 이 문서의 기능은 구현/활성화하지 않는다. Node-only `/dev/fd` pathname을
secure dirfd primitive로 가장하지 않고, token-fd 미지원 old binary rollback도 노출하지 않는다.
`downgrade-guard`/`issue-rollback-lease`/`rollback-exec`는 `HARDENING_UNAVAILABLE`로 fail-closed한다.
session persistence/lifecycle 구현은 기존 argv token과 pathname writer의 현재 위험을 새 안전
속성으로 주장하지 않으며, native helper와 호환 binary가 준비된 별도 PR에서 이 문서를 재개한다.

## 2. token fd

`tools/session-server-spawner.js`만 server를 spawn한다. route는 bindStart, resumeBound,
D9 ensureServer/finalization respawn, force Q6 relay 네 개다.

`session-server-spawner`가 authoritative FD allocator와 stdio builder를 소유한다. fd 0~2는
항상 `ignore`; extra fd는 충돌 없이 동적 할당한다.

| channel | consumer | lifetime |
|---|---|---|
| lease secret | runner only | CAS claim 직후 zeroize+close, server exec에 미상속 |
| bound receipt | server | capability/lease read-only 검증 직후 close |
| sessionToken | server | bounded read 직후 zeroize+close |

`tokenChannel`은 lifecycle §21.1의 methods `stdio()`, `argv()`, `transfer(child)`,
`describe()`를 그대로 구현하고 allocator가 선택한 fd를 `--token-fd <n>`에 넣는다. stdio
0~2를 교체하거나 stdout/stderr pipe를 만들지 않는다. token write는 runner spawn 후 GO 전,
runner는 token fd를 server exec까지 보존하며 secret fd만 닫는다.

- parent는 mutable Buffer의 64 lowercase hex token + newline(최대 65 bytes)을 정확히 한 번
  쓰고 `fill(0)` 후 close한다. JS string zeroize를 주장하지 않는다.
- server는 listen/mkdir/read 전 fd를 bounded read하고 즉시 close/CLOEXEC한다.
- argv/env/log/receipt/error에 raw token이 없다. coordinator에서 `--token`은 거부한다.
  manual human dev는 explicit `--allow-argv-token`과 `--token` 조합만 쓸 수 있다.
- fd EOF/oversize/extra bytes/invalid UTF-8은 `BAD_TOKEN_CHANNEL`, first I/O 0회다.
- server는 receipt/token fd를 listen 전 닫고 모든 grandchild fd table을 검사한다.

허용 durable token sink는 mode 0600의 selected session `state.json`, `loop-state.json`,
`lock.json` 세 곳뿐이다(기존 dealer/browser 계약). loop.log, halt/recovery, lifecycle capsule,
review, child envelope, stdout/stderr/error cause에는 token을 쓰지 않는다.

## 3. secure published writer

repository root `published-writer.js`에 writer를 둔다. server가 import할 수 있고 engine/tools
어느 쪽에도 의존하지 않는다.

```js
writePublishedJsonAtomic(descriptor, rel, value)
writePublishedTextAtomic(descriptor, rel, text)
```

published writer 계약:

- descriptor root fd와 `(dev,ino)`를 pin하고 exact allow-listed relative path만 받는다.
- platform dirfd adapter는 macOS `/dev/fd/<dirfd>/<rel>` 또는 Linux
  `/proc/self/fd/<dirfd>/<rel>`의 fd-relative open/rename을 startup self-test로 검증한다.
  self-test가 root pathname swap과 symlink escape를 막지 못하거나 platform이 지원하지 않으면
  `FD_RELATIVE_IO_UNAVAILABLE`로 production bind를 fail-closed한다. pathname fallback은 없다.
- root/parent가 missing이면 만들지 않고 `STALE_SESSION_CAPABILITY`다.
- 모든 ancestor/parent/target은 fd-relative open 후 같은 fd `fstat`; symlink, `nlink>1`, foreign
  uid/mode, non-directory parent/non-regular target을 거부한다. lstat-then-open 판정은 쓰지 않는다.
- same-parent exclusive temp `0600` → fsync(file) → rename → fsync(parent).
- update는 mandatory expected inode+digest CAS, first-create는 mandatory expected absent +
  exclusive temp/target absence를 검증한다.
- production ship gate는 raw writer/recursive session-root mkdir call site 0개다.
- `hands/`만 pinned root 아래 mode 0700으로 fd-relative first-create가 허용된다. session root는
  만들지 않는다.
- `publish.lock.d`와 `.mutex`는 dedicated fd-relative directory lock primitive로 이관하되
  이름/1줄 pid 호환 의미는 바꾸지 않는다.

artifact mapping:

| owner | artifacts | admission/CAS |
|---|---|---|
| engine | state.json, players.json, hands/hand-*.json | mutation lease + .mutex; state/version CAS |
| game-loop | loop-state.json, review.md/.review.json, loop.log, canary, .player-sessions.json | store owner + descriptor; loop identity/version CAS |
| server | lock.json, ui-snapshot.json | server lease/binding; lock identity CAS |
| publish | .publish-attempt.json, ui-snapshot.json | publisher lease + publish.lock.d + attempt CAS |
| coach | .coach-authority.json, result/envelope/control files | coach lease + publish.lock.d + generation CAS |
| turn | .turn.json/.talk.json | engine/publisher lease by producer; version/digest CAS |

legacy/test `writeJsonAtomic`은 selected native descriptor에서 호출되면 거부되고 production
module graph에서 unreachable해야 한다.

## 4. pinned root runtime

`withPinnedSessionRoot(descriptor, fn)`은 root read-only fd와 dev/ino를 보존하고
`revalidate(reason)`을 제공한다.

필수 경계:

- createGameLoop bind 직전
- writerSpawner.run 및 terminal-engine runner 직전
- serverSpawner 네 route 직전
- terminal C1/C3, force Q4/Q8
- D9 self-heal과 Q6 relay
- resume generation takeover 및 rollback reopen

불일치는 `STALE_SESSION_CAPABILITY`; session root를 recreate/copy/rename하지 않는다. long-running
loop는 hand boundary와 finalization phase boundary에서도 revalidate한다.

## 5. rollback protocol

1. `downgrade-guard`는 schemaVersion 2 read-only eligible receipt를 낸다. execution은 open이며 argv 없음.
2. 단일 명령 `session-control rollback-exec`가 store lock을 잡고 guard/current를 재검증,
   sealForRollback + one-shot lease를 원자 생성한다.
3. 같은 process가 lease secret fd, wrapper nonce, pid/startTime/process group을 bind/claim한 뒤
   exact concrete sessionDir old resume argv를 exec한다. JSON receipt에는 secret이 없다.
5. new launcher는 rollback-sealed에서 `--ai`/abandoned를 거부한다.
6. wrapper는 종료 시 `rollback-handback.json`을 stateVersion/result/state+hands digest,
   old process identity/death, loop/server retirement와 함께 CAS 기록한다.
7. re-upgrade resume은 handback과 old loop/server death를 증명한다. active state만 같은 launch
   transaction에서 generation+1 open + new boot binding + resumeBound로 넘겨 abandoned가 관찰할
   open/dead window를 만들지 않는다. win/lose/abort/finalization은 reopen 전에 lifecycle terminal
   분류/복구로 보낸다.

wrapper는 old binary가 execution lease를 이해한다고 가정하지 않는다. 안전 주장은 wrapper가
검증한 concrete sessionDir/argv/process group에만 적용되며 direct old binary 실행에는 없다.

## 6. rollback artifact와 redaction

receipt schemaVersion은 2다. storeId/gameId/operationId/layout/sessionRel, current/manifest/readiness/lifecycle/
engine/loop/execution/guard digests, engine stateVersion/result, process quiescence, generation,
issuedAt만 포함한다. token, secret, 절대경로(legacyArgv의 실행용 concrete path 제외), prompt,
card/player private content는 포함하지 않는다. receipt file mode는 `0600`이다. final receipt는
leaseId/generation/wrapper nonce digest만 포함하고 secret은 fd에만 존재한다.

## 7. rollback order

```text
new code open generation
  → quiesce Q1..Q8
  → rollback-sealed + one-shot lease
  → compat wrapper / old session-local loop
  → old loop/server death
  → generation+1 open
  → new-code resumeBound
```

crash recovery:

- seal 전 crash: open, old binary 미실행. guard 재시도.
- seal 후 wrapper 전: rollback-sealed 유지. `--ai` 불가, issue command idempotent.
- wrapper claim 후 exec 전: lease claim receipt로 retry/refuse를 판정; 두 old process 금지.
- old process 실행 중: session-local loop/server identity가 권위.
- old death 후 handback 전: rollback-sealed 유지, wrapper/recovery가 handback을 완성.
- handback 후 bind 전: rollback-sealed 유지. new resume 한 transaction이 reopen+boot binding을
  만들고 ownership을 즉시 resumeBound에 인수한다.

## 8. RED gates

### H1 token

- 네 server route 모두 argv/env raw token 0개, fd로만 전달한다.
- fd allocator가 lease secret/receipt/token을 서로 다른 extra fd로 배치하고 stdio 0~2는 ignore다.
- EOF/oversize/invalid/duplicate transfer는 listen/fs I/O 전에 실패한다.
- `/proc`/`ps` argv와 child environment dump에 token이 없다.
- loop.log/halt/recovery/capsule/stdout/stderr/error cause token scan은 0건이고 허용 세 파일만 0600이다.

### H2 writer/path

- published root/parent 삭제 뒤 writer가 mkdir하지 않고 fail-closed한다.
- dirfd adapter self-test가 실패한 platform은 production bind 자체가 실패한다.
- root/target symlink, hardlink, inode swap, uid/mode 위반을 모두 거부한다.
- successful writes와 temp가 `0600`, atomic rename/fsync 순서를 지킨다.
- artifact mapping 전 production call site가 공용 writer를 통과하며 raw/recursive writer count가 0이다.
- existing state/publish/coach/turn tests와 `publish.lock.d` 계약이 유지된다.

### H3 pinning

- 각 필수 경계 사이 root inode swap을 주입해 mutation/spawn 0회를 단언한다.
- hand/finalization 장기 경계에서도 stale descriptor가 거부된다.

### H4 rollback

- open preliminary receipt에는 argv가 없고 final rollback-sealed receipt만 argv를 가진다.
- rollback-sealed에서 `--ai`/abandoned/current switch는 전부 거부된다.
- 같은 receipt/lease로 old process 두 개를 시작할 수 없다.
- store-root legacy init argv는 어떤 layout에서도 나오지 않는다.
- old death 전 reopen 불가, death 뒤 generation+1 open 및 same gameId resume 성공.
- rollback handback active/win/lose/abort/finalization 각각이 resume 또는 lifecycle terminal
  core의 정확한 한 경로로만 간다.
- crash matrix 각 행이 정확히 open 또는 rollback-sealed 한 상태로 수렴한다.

## 9. 수용 기준

1. production server spawn argv/env에서 raw sessionToken이 사라진다.
2. published session root와 files는 replacement/recreation 공격에서 fail-closed한다.
3. runtime mutation은 pinned root와 execution lease를 동시에 만족해야 한다.
4. rollback은 quiesced native concrete session resume만 허용하고 store root archive/init을 열지 않는다.
5. rollback window에 new code가 abandoned/force로 current를 바꾸지 않는다.
6. lifecycle terminal/pointer order와 existing publish/coach lock semantics는 변하지 않는다.
