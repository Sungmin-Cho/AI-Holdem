# 이슈 #270 — 앱 proxy의 relay identity 사전 검증 설계·구현 계획

브랜치: `fix/270-relay-proxy-identity` (기준 main `edb0b57`).

> **이슈 계약(부모가 #270 본문과 대조해 확인).** 앱 proxy는 relay의 세션 토큰을 *loop가 검증한 relay 프로세스*
> (pid·시작 시각 신원 + 해당 port listener 소유)에게만, 요청마다 다시 증명한 뒤 보낸다. 증명이 안 되는 모든 경우는
> listener 접촉 0(connection·request 모두)으로 거부한다. lock.json만 읽어 주소를 정하는 경로는 제거한다.

## 1. 결함 (기준 커밋)

`tools/app-server.js` `proxyGame`은 요청마다 `lock.json`·`state.json`을 *경로로* 읽어
`lock.serverPid === loop.serverPid`, `lock.sessionToken === engine.sessionToken`, `controlProtocolVersion === 1`만 비교한 뒤
(POST는 그 *뒤에* 본문을 기다리고) `fetch("http://127.0.0.1:${lock.port}/…")`에 세션 토큰을 헤더와 query로 실었다.

- `loop.serverPid`는 loop가 *검증했던* pid일 뿐, 지금 그 pid가 그 프로세스이고 그 port의 listener를 소유하는지 보지 않는다.
  relay가 죽고 pid가 재사용되거나 다른 프로세스가 같은 port를 잡으면 세션 토큰이 임의 프로세스로 간다.
- lock.json은 loop가 검증한 `serverBindingVerified`와 대조되지 않는다.
- POST는 본문 대기 동안 게임·세션·lock·epoch가 바뀌어도 낡은 값으로 전송한다.
- 전송은 undici 전역 풀을 쓰므로, 같은 port의 *이전 relay*에 열려 있던 keep-alive 소켓이 재사용될 수 있다.

## 2. 결정: loop가 소유한 요청 범위 capability

`loop.captureRelayAccess()`가 **불투명한 요청 범위 capability**를 돌려준다(`tools/relay-access.js`의 `createRelayAccess(deps).capture()`;
loop는 자기 클로저를 주입). capability는 `use({gameEpoch, revalidate}, send)` 메서드 하나만 가진다. 토큰·pid·port·startTime을 노출하는
getter·속성은 없다(`Object.keys(capability)` = `['use']`).

- **capture는 본문 대기 전에, 첫 동기 검사 직후 같은 tick에서 호출한다.** 이유: 본문을 기다린 *뒤*에 binding을 잡으면 같은 loop가
  재시작해 새 binding을 가진 경우 옛 요청이 새 relay로 들어간다. capture는 OS 호출 없이 동기 관측만 한다:
  `serverBindingVerified` **객체 참조**(ABA 방지 — 필드가 같아도 다른 incarnation), `lock.json` 바이트+dev/ino, `state.json` 토큰.
  capture 시점에 이미 거부 대상이면 그 거부를 기억하고 `use`가 던진다(요청 범위; 세계가 회복돼도 되살리지 않는다 — 재시도가 새 capture).
- **`use`** (본문 이후): `revalidate()`(app) → 재관측 → capture와 참조·바이트·inode 동일 확인 → 에포크 확인 → 동시성 슬롯 →
  `await listenerOwnedBy` → (이후 `await` 없음) 신원 판독 → `revalidate()`와 재관측 한 번 더 → **같은 동기 단계에서 `send(access)`**.
- 성공 인가는 어디에도 저장하지 않는다. 요청(GET·POST·SSE 연결)마다 capture부터 다시 한다. 슬롯 카운터 외 상태 없음, probe 합치기 없음.
- `captureRelayAccess`가 없거나 함수가 아닌 loop는 `503 RELAY_UNAVAILABLE`(fail-closed).
- 오류는 닫힌 집합: `RelayDenied { code: 'RELAY_UNAVAILABLE'|'STALE_GAME'(+app의 'GAME_PAUSED'), reason }`, `reason`은
  `RELAY_DENY_REASONS` 열거. 메시지는 code뿐이며 토큰·pid·port 없음. 응답 본문은 `{code}`만. 거부 텔레메트리 seam은 두지 않는다.

기각한 대안: loop가 토큰 포함 binding getter를 내주는 방식(토큰이 상시 노출), app 소유 helper가 lock.json만 다시 읽는 방식(binding 없는 반쪽 검증),
`useRelay(request, send)`를 본문 뒤에 한 번만 호출(위 재시작 경합).

## 3. 검증 알고리즘

관측(`observe`, 동기·OS 호출 없음): `isStopping` → 바인딩 존재·형식(pid·port·토큰·`validOwnedIdentity(startTime)`) →
`lock.json`(아래 "고정 읽기", 바이트+dev/ino 보관, JSON 객체) → lock의 `serverPid`·`port`·`sessionToken`·
`controlProtocolVersion`(`managed ? 1 : null`)이 binding과 동일, `serverStartTime`이 *있으면* `binding.startTime`과 문자열 동일 →
`state.json` 토큰이 binding 토큰과 동일(아니면 재시도 가능한 `CHANGED`). `use`는 `gameEpochOf(token) === request.gameEpoch`도 요구한다.

**고정 읽기(`readPinned`).** `tools/rejection-audit.js`의 관례를 따른다: `lstat`(일반 파일·nlink 1·상한 이하) → `open(O_RDONLY|O_NOFOLLOW|O_NONBLOCK)` →
`fstat`이 같은 조건이고 lstat와 dev/ino가 같아야 한다 → `fstat` 크기만큼 `readSync`. `O_NONBLOCK`은 경로에 FIFO·장치가 놓였을 때 요청이
`open(2)`에 묶이지 않게 하고(일반 파일 읽기에는 영향 없음), `O_NOFOLLOW`가 없는 플랫폼에서는 lstat/fstat 동일성이 심볼릭 링크 대체 수단이다.
lock.json은 64 KiB 상한(실제 수백 바이트)으로 할당을 묶고, state.json은 엔진 상태라 크기 상한을 두지 않는다. 어긋나면 모두 `LOCK_BAD`(lock) 또는 `CHANGED`/`LOCK_BAD`(state).

OS 검증(`use`): `listenerOwnedBy(pid, port, {timeoutMs: probeMs})`가 정확히 `true`여야 한다(`false`/그 외 → `LISTENER_MISMATCH`, throw·timeout →
`LISTENER_UNKNOWN`; 기존 `createListenerOwnedBy`의 monotonic deadline을 그대로 쓴다). 신원은
`ownedIdentityStatus(binding.pid, binding.startTime, startTimeOf) === 'alive'`일 때만 통과 — 기존 positive-identity 판정(kill 0 +
같은 owned kind의 동일 판독)을 그대로 재사용하며 타임스탬프·kind 규칙을 복제하지 않는다. `dead`·`unknown`·판독기 throw는 모두
일반 `IDENTITY_UNKNOWN` 한 가지로 거부한다. `relayMayBeAlive`(보호 방향 극성)는 인가에 쓰지 않는다.

거부는 어떤 상태도 바꾸지 않는다: binding을 지우지 않고, lock을 건드리지 않고, 시그널을 보내지 않고, 거부를 기억하지 않는다(다음 요청이 새로 평가).
Linux에서 `lstart` 불일치는 아무것도 증명하지 못하므로 `unknown`이 되어 거부 — 벽시계 점프 뒤 정상 relay도 503이 지속될 수 있고
새 relay와 일치하는 binding·lock을 확보해야 복구된다. 기존 lock stamp가 남아 있으면 단순 재개·재채택만으로는 복구되지 않을 수 있다
(수용; relay lock에 Linux lifetime evidence가 없어 쓰지 않는다 — 후속 후보).

`lock.serverStartTime` 호환: **없음**(채택된 레거시 relay) → loop가 listener·인증 probe로 검증한 binding이 권위(binding.startTime은 owned 형식이어야 함).
**있음** → binding.startTime과 정확히 같아야 한다. 따라서 레거시 raw 스탬프는 조용히 수락되지 않고 `LOCK_BINDING_MISMATCH`다.
pre-#257 raw 스탬프 relay를 채택한 게임은 proxy가 막힌다. 단순 resume은 같은 raw lock을 재채택할 수 있어 복구를 보장하지 않으며 새 relay가 필요하다(fail-closed 기본).

## 4. 허용/거부 매트릭스

모든 거부는 **listener 접촉 0**(connection·request 모두). 검증 가능한 기준은 응답 코드가 아니라 listener의 raw 카운터다.

| 조건 | 응답 | reason |
|---|---|---|
| 메서드/gameId/epoch/query/상태 사전검사(기존) | 405/409/400/409 | (기존) |
| session 없음: error/starting/…/finalizing | 503 SESSION_UNAVAILABLE | (기존) |
| session 없음: ended/completed (snapshot은 200) | 409 SESSION_INACTIVE | (기존, 불변) |
| session 있음, `captureRelayAccess` 없음 | 503 RELAY_UNAVAILABLE | (app가 직접 거부) |
| 정지 중 / binding 없음 / binding 형식 | 503 | `STOPPING`/`NO_BINDING`/`BAD_BINDING` |
| lock 없음(재시도 가능) / 손상·비정상 파일 | 503 | `LOCK_MISSING`/`LOCK_BAD` |
| lock pid·port·token·protocol·startTime ≠ binding | 503 | `LOCK_BINDING_MISMATCH` |
| engine token ≠ binding(앱의 현재 epoch는 요청과 같음) | 503 RELAY_UNAVAILABLE | `CHANGED` |
| 검증된 engine/binding epoch ≠ 요청 epoch | 409 STALE_GAME | `STALE` |
| capture 이후 binding 참조·lock 바이트/inode·state 토큰이 바뀜 | 503/409 | `CHANGED`/`STALE` |
| gameId·sessionDir·selectionVersion·epoch 변경 / 액션 상태 변경 / 인증 변경 | 409 STALE_GAME / GAME_PAUSED | `STALE` |
| 같은 선택 게임의 current·session·loop 객체만 교체됨 | 503 RELAY_UNAVAILABLE | `CHANGED` |
| listener가 pid 소유 아님/확인 불가 | 503 | `LISTENER_MISMATCH`/`LISTENER_UNKNOWN` |
| 신원 dead/unknown/판독 불가 | 503 | `IDENTITY_UNKNOWN` |
| 동시 검증 상한(8) 초과 | 503 | `BUSY` |
| 전부 통과 | 전송, upstream 응답 그대로 | — |

## 5. app-server 변경

- `proxyGame`: 사전 검사 → `loop.captureRelayAccess()`(동기, `await` 전) → (POST) 본문 → `capability.use({gameEpoch, revalidate}, send)`.
  `lock`/`state` 직접 읽기와 `lock.serverPid !== loop.serverPid`는 삭제.
- `reconcileFailure`는 같은 게임을 계속하면서 current 객체를 새로 만들 수 있다. 이런 참조 교체도 기존 요청은 거절하되 503으로 재시도하게 한다.
  실제 선택·epoch 변경의 409와 구분한다. 클라이언트는 STALE_GAME을 terminal로 처리하므로 참조 교체에 409를 쓰면 정상 복구 연결도 영구 종료된다.
- `revalidate`(동기): 클라이언트 연결(`res.destroyed`), `manager.current`·`manager.session`·`session.loop` 동일 객체, `gameId`·`sessionDir`,
  `snapshot.gameEpoch`, action이면 상태(playing/pausing/paused), 공개 라우트는 `participantAuth()`를 다시 불러 participantId·playerId·roomRole·boundGameId 동일.
- **전송은 새 연결 한 번**: `node:http` `request({agent:false})`. 요청마다 새 TCP 연결이라 풀링된 소켓이 이전 relay incarnation으로
  새로 검증된 listener를 인가하는 경로가 없다(`Connection: close` 단독은 유휴 소켓을 먼저 재사용할 수 있어 쓰지 않는다). `node:http`는
  redirect를 따르지 않으므로 토큰이 검증된 주소 밖으로 가지 않는다. 역압(`res.write` 대기)·abort(`signal`)·SSE 스트리밍은 `IncomingMessage` 이터레이션으로 그대로 유지.
  전송 오류는 코드 없는 `APP_UNAVAILABLE`로 정규화(기존 `fetch` 실패와 동일 매핑, errno 비노출).
- **SSE**: 연결 시작에서만 전체 검증. 청크마다 기존 gameId 검사에 `access.stillBound()`(메모리 비교: 정지·binding 참조 교체)를 더하고,
  실패하면 abort 후 정상 종료 → 재연결은 새 capture부터 전체 검증. relay heartbeat는 15s 간격이지만, downstream 역압이나 이벤트 루프 지연이
  청크 처리를 미룰 수 있으므로 이탈 감지의 시간 상한은 아니다. 스트림 중 OS 재검증은 범위 밖.
- **정정(원 설계 대비): 토큰은 query에서 제거하지 않는다.** relay는 `/api/snapshot`·`/api/events`·`/api/training-detail`에서 query 토큰만 받는다
  (`server/server.js`; 헤더도 받는 곳은 `/api/health`·`/api/action-status`·`/api/action`·`/api/publish`). 토큰은 검증된 loopback listener로 새 연결 위에서만 가며 redirect를 따르지 않는다.
  relay 쪽 헤더 수용 확대는 범위 밖.

## 6. loop 연결 (`tools/game-loop.js`)

`createRelayAccess({lockPath, statePath: engineStatePath, managed, binding: () => serverBindingVerified, isStopping: () => stopRequested,
startTimeOf: serverStartTimeOf, listenerOwnedBy: (pid, port, call) => listenerOwnedByFn(pid, port, {timeoutMs: min(call.timeoutMs, osVerifyMs)}),
probeMs: opts.relayVerifyMs ?? min(osVerifyMs, 3000), maxConcurrent: opts.relayMaxConcurrent})` 한 번, 반환 객체에 `captureRelayAccess: () => relayAccess.capture()`.
`listenerOwnedByFn`은 `onChild`로 `activeChildren`에 자식을 등록하므로 `requestStop`이 진행 중 lsof를 취소한다.

**finalization deadline을 적용하지 않는 결정.** loop 내부의 `listenerOwnedBy` 래퍼는 `assertAndBoundFinalizationMs(osVerifyMs)`로 probe를
finalization 예산에 묶지만(마감이 지나면 throw), proxy용 래퍼는 그러지 않는다. 그 마감은 loop *자신의* 종료 단계를 위한 것이고,
proxy probe는 요청 범위라 `probeMs`(≤3 s)로 이미 묶이며 `activeChildren` 등록으로 정지 시 취소된다. 적용했다면 finalization이 예산을 넘긴
순간부터 아직 살아 있는 relay에 대한 호스트의 snapshot·events proxy가 `LISTENER_UNKNOWN` 503으로 바뀐다 — 보호 이득 없이 결과 화면이 끊긴다.
`serverBindingVerified`의 쓰기/소거 지점·`ensureServer`·lock 회수·시그널 경로는 한 줄도 바꾸지 않는다(모든 대입이 객체를 교체하므로 참조 비교가 incarnation 비교다).

## 7. 비용·잔여 위험 (실제 한계만)

요청당: 동기 파일 읽기(lock·state 각 capture 1 + use 2회), `manager.snapshot()` 2회 추가, lsof/netstat 1회(비동기, 상한 `probeMs`), ps 1회(동기 — 기존 owned 리더의
자체 타임아웃이 상한이며 최악에는 이벤트 루프를 막는다). 기존 loop 수명 검사와 달리 이 변경은 HTTP 요청마다 그 비용을 낸다.
기본 listener 예산은 3초 이하이고 identity 판독 예산은 POSIX 10초 / Windows 15초(`platformTimeout` 배율 적용)로 별도다. 3초가 전체 요청 예산이라는 뜻이 아니다.
파일 읽기와 연결까지 포함하는 전체 요청 시간 상한도 보장하지 않는다. 동시 listener 검사는 기본 8개, 초과는 대기열 없이 재시도 가능한 503이다.
신원 판독은 동기이므로 앱·loop·다른 연결의 진행을 막을 수 있다. 성공 캐시는 도입하지 않고, 별도 프로세스를 relay로 둔 실제 OS 테스트가 요청 3회의 identity/listener/전체 시간을
`relay_proxy_os_cost` 진단으로 출력한다. macOS 로컬과 Linux/Windows CI의 측정은 검증 기록·PR/이슈 근거에서 구분한다. 느린 장비에서의 지연은 수용하는 제한이다.
Windows의 별도 PID 판독은 요청마다 PowerShell을 실행하는 고정 비용이다. action-status의 2.5초 재조정 폴링(해당 action phase일 때)도 이 비용을 내므로
여러 클라이언트의 폴링이 겹치면 앱·SSE·loop 진행을 지연시킬 수 있다. 병합 전 Windows CI의 실제 identityMs를 확인하며 macOS 표본으로 대체하지 않는다.
거부된 요청은 `observe`에서 끊기면 OS 호출 0회. state.json 파싱은 요청당 약 6회(기존 2회), loop-state.json 파싱은 약 3회(기존 1회)다.
같은 플랫폼 리더의 한계는 그대로 따른다(예: Linux `lstart`, pid namespace — listener 소유와 신원 동치가 함께 막는다).

잔여 TOCTOU는 **listener를 관찰한 때부터 실제 연결까지**다. 살아 있는 relay가 그 사이 listener만 닫고 다른 프로세스가 같은 port를 점유할 수 있어 PID 재사용이 필수 조건은 아니다.
listener 검사 완료 대기, 그 뒤의 동기 identity 판독(위의 10초/15초 예산), 파일·메모리 재확인, 비동기 TCP 연결 설정이 모두 이 창에 포함된다.
토큰은 단방향 공유 비밀이므로 별개의 OS 관찰은 연결 상대를 원자적으로 인증하지 못한다. 창의 크기를 수치로 보장하지 않고 완전한 PID·port 재사용 방지를 주장하지 않는다.
이전에는 마지막으로 신뢰한 lock 수명 전체가 전송 허가로 남았다. 이제 요청마다 관찰 실패·불일치를 거절하지만 이 관찰 후 교체 한계는 남는다.
`SO_REUSEPORT`로 같은 port를 두 프로세스가 잡는 경우 lsof의 "pid ∈ listener"는 막지 못한다 — 로컬 동일 사용자 공격으로 별도 위협.

## 8. 테스트 (모두 listener의 raw `connections`/`requests` 카운터로 누출 경계를 단언)

- `test/relay-access.test.js` — 팩토리 단위(결정적 seam): 성공/캐시 없음(use 3회 = OS 증거 3회), 채택 relay(stamp 없는 lock) 허용·비owned binding 거부(독립 rig),
  거부 표(사전 OS 0회; 디렉터리·상한 초과·POSIX 전용 심볼릭 링크/2중 하드 링크/writer 없는 FIFO 포함 — 테스트 프로세스가 `open`에 묶이지 않음이 증거), OS 증거 거부, dead pid,
  거부 비기억·상태 불변, capture~use 사이 교체(ABA·lock inode·state·정지)·비동기 검증 중 교체, revalidate 순서, 동기 무-await 증명(microtask), 슬롯 반납, `stillBound`, 토큰 비노출.
- `test/relay-proxy.test.js` — 앱 통합(실제 `http` listener): 거부 15종(GET/POST/events), 참가자·관전자 거부, 본문 대기 중 교체 8종(분할 POST, `loop.captured`로 결정적 동기화,
  OS 호출 0회 단언), 비동기 검증 중 교체 7종, 검증 중 실제 수명 취소 3종(잠금 중 허용되는 관전자 제거, 방 release 뒤 좌석 참가자 제거, 호스트 클라이언트 이탈 — 방 정책을 우회하지 않는다),
  upstream SSE 소켓 끊김(헤더 뒤 for-await 오류가 호스트 응답 `destroy`로 끝나고 다음 요청은 새 검증 연결), host/참가자/관전자 성공(요청당 새 연결·검증 1회·`connection: close`·헤더/`x-seat`/`note` 정리),
  실제 두 번째 listener를 둔 lock.port 불일치(양쪽 접촉 0), 같은 참가자 row의 값 변경, host/참가자/관전자 downstream 역압 중 이탈과 upstream 정리,
  SSE 새 연결과 binding 교체 시 종료·재연결 거부, redirect 미추종, 토큰 비노출. 이 파일은 신규 모듈을 import하지 않아 기준 커밋에서도 로드되어 트래픽 단언으로 실패한다.
- `test/relay-proxy-live.test.js` — 실제 OS seam(`createListenerOwnedBy`·`serverProcessStartTime`)으로 소유자만 인가하고, 테스트 소유 별도 자식의 잘못된 port 소유를 반드시 거절한다.
  별도 relay 자식에 대한 요청 3회의 실제 OS 비용을 진단한다(Windows 자기 프로세스 identity 캐시로 비용을 숨기지 않음). 생산 `createGameLoop`의 `captureRelayAccess`도 binding 없이 거부한다.
- 기존 이전: `participant-api`의 합성 loop 2건과 `app-server-security`의 lock 없음 단언은 fixture의 `makeLoop`(생산 팩토리 + 결정적 seam)로 교체. 공용 헬퍼 기본값은 약화하지 않았다.

## 9. 범위 밖

relay lock 회수·시그널·`ensureServer` 정책, `stopServer`, Linux lifetime evidence를 relay lock에 기록, ps의 비동기화, 스트림 중 OS 재검증,
relay의 헤더 토큰 수용 확대, `SO_REUSEPORT` 위협.
