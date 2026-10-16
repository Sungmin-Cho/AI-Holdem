# #270 relay proxy 검증 기록

기준 main: `edb0b57bdb07d46718776f0a30446062521455a9`. 브랜치: `fix/270-relay-proxy-identity`.
환경: macOS 27.0.1 arm64, Node 26.0.0 및 22.23.2. 사용자 `game/`·실행 중 서비스는 사용하지 않았고, 테스트 소유 임시 store·자식·자동 배정 포트를 사용했다.
이 파일은 PR 제출 전 로컬 기록이다. 원격 CI와 최종 검증 SHA는 PR 및 이슈 #270의 병합 기록에서 확인한다. 로컬 전체 실행과 분리 재실행 결과는 아래에 구분했다. 원격 CI는 아직 완료되지 않았다.

## 실행 결과

| 대상 | 런타임 | 결과 |
|---|---|---|
| 수정 전 app-server-security + participant-api + session-controls | Node 26 | 54 pass, 0 fail, 0 skip (80.97s) |
| 첫 신규 3파일 | Node 26 | 70 pass, 3 fail, 0 skip |
| 수정 후 기존 집중 세트 | Node 26 | 54 pass, 0 fail, 0 skip (78.69s) |
| 첫 보완 후 신규 3파일 | Node 22.23.2 | 81 pass, 0 fail, 0 skip (1.06s) |
| 추가 검증 하네스 첫 실행 | Node 22.23.2 | 85 pass, 4 fail, 0 skip |
| 하네스 교정 후 신규 3파일 | Node 22.23.2 | 89 pass, 0 fail, 0 skip (1.17s) |
| 복구 응답 계약 보완 후 신규 3파일 | Node 22.23.2 | 91 pass, 1 fail (구 기대 reason 1건) → **92 pass, 0 fail, 0 skip** (1.12s) |
| 로컬 전체 자동 탐색 실행 | Node 22.23.2 | 3,930 tests: 3,911 pass, 18 skip, 1 timeout cancelled (1,809.77s); 전체 통과 아님 |
| timeout 테스트 분리 실행: 기준 / 현재 | Node 22.23.2 | 각 1 pass, 0 fail, 0 skip (테스트 본문 2.36s / 2.25s) |

첫 3건은 테스트 오류였다: use 호출 3회를 4회로 계산, 앞선 성공의 sent 배열을 음성 단언에 재사용, 잠긴 방에서 금지된 좌석 제거를 호출해 경합에 도달하지 못함.
각각 정확한 호출 수·독립 rig·실제 허용되는 수명 취소로 교정했다. 공용 거부 단언과 방 정책은 약화하지 않았다.
추가 4건은 `room.authenticate()`가 반환한 **복사본**을 바꾼 하네스 오류였다. `requireRoom()`은 structuredClone을 반환한다.
OS 게이트 진입 뒤 `room.load()`의 현재 상태를 바꿔 재인증이 실제 변경을 관찰하도록 교정했으며, 제품 코드의 불필요한 추가 복사는 넣지 않았다.

실행 명령(신규):

```sh
node --test --test-concurrency=1 test/relay-access.test.js test/relay-proxy.test.js test/relay-proxy-live.test.js
```

92개는 POSIX 전용 파일 거부 3건을 포함한다. Windows에서는 이 세 POSIX 파일 생성 시험을 정의하지 않으므로 같은 합계를 요구하지 않는다.
실제 판독 테스트는 lsof가 없는 POSIX에서 명시적으로 skip한다. 별도 자식의 identity를 읽지 못하는 음성 검사를 조용히 생략하지 않는다.

## 수정 전 실제 누출 검출

기준 커밋 detached 사본에 `relay-proxy.test.js`와 fixture만 복사했다. 새 생산 모듈을 정적 import하지 않으므로 수집/import 실패가 RED 근거가 아니다.

- 최초 거부 조건 15회: 14 fail / 1 pass. **9건은 가짜 listener의 connections=1, requests=1**로 실패, 5건은 기존 차단 경로의 상태 등 다른 단언에서 실패했다.
  통과 1건은 missing lock(기존에도 재시도 가능 거절)이었다.
- 본문 대기·비동기 검사 조건 15회: 15 fail. **14건은 실제 listener 접촉** 단언, game 교체 1건은 socket hang up(ECONNRESET)이므로 누출 증거로 세지 않았다.
- 합계 30회 중 **23건의 실제 접촉 검출**을 확인했다. 모든 실패를 토큰 누출로 계산하지 않는다.
- 최종 port 불일치 시험은 실제 두 번째 listener를 띄우고, binding listener와 lock.port listener 양쪽의 connection/request가 0인지 확인한다.

거절 통합 시험은 응답 코드보다 raw listener 카운터를 먼저 단언한다. 본문 대기는 capture 신호, 비동기 검사는 Promise 게이트로 동기화한다.
클라이언트 이탈은 서버 소켓 close와 capability.use의 정산을 기다려 확인하며 임의의 정착 sleep을 쓰지 않는다.

## 실제 OS 비용

별도 Node 자식이 loopback listener를 소유하고, 요청 3회마다 기존 생산 identity/listener 판독기를 새로 호출했다. Windows의 자기 프로세스 identity 캐시로 비용이 숨겨지지 않는 구성이다.
`relay_proxy_os_cost` 진단은 OS·Node·샘플 수·identityMs·listenerMs·roundTripMs를 출력한다. 주입 시험이나 대규모 부하 시험과 구분한다.

macOS Node 22.23.2에서 관측한 3개 표본:

- identity: 2.67 / 2.57 / 2.58 ms
- listener: 37.92 / 38.10 / 39.13 ms
- HTTP 전체: 45.23 / 43.41 / 45.27 ms

이 실행 때 별도 전체 테스트도 진행 중이었다. 이 값은 표본 관측이며 최대 지연·처리량의 보장이 아니다. Linux/Windows 실제 값은 CI 로그에서 별도로 확인한다.
listener 기본 예산은 최대 3초, 동기 identity는 POSIX 10초 / Windows 15초(`platformTimeout` 배율 적용)로 별도이며 이벤트 루프를 막을 수 있다.
검사 슬롯 기본 8개와 초과 BUSY 거부는 결정적 단위 시험으로 확인했다. 실제 동시 부하에서의 BUSY 비율을 측정한 것은 아니다.

## 검증 범위와 한계

- PID 숫자뿐 아니라 loop가 검증한 binding 참조, lock의 pid/port/token/protocol/identity·바이트·inode, engine token/epoch, 현재 앱 세대와 인증을 검사한다.
- POST 본문 전에 capability를 capture하고 본문 뒤 및 비동기 OS 검사 뒤 다시 확인한다. 마지막 동기 재확인과 전송 함수 호출 사이에 await가 없다.
- unknown·조회 실패·불일치는 전송 전에 거절한다. legacy raw stamp는 거절하고 stamp가 없는 채택 lock은 qualified loop binding을 요구한다.
- 정상 host/참가자/관전자, 좌석·note 필터, paused action, GET/POST/SSE, 재연결, redirect 미추종을 확인한다. 요청마다 agent:false 새 연결을 쓴다.
- host/참가자/관전자 SSE의 write(false)/drain 구간에 압력 seam을 두고, 실제 소켓 이탈 → upstream close → 대기 리스너 제거 → 새 검증 연결을 확인한다.
  이는 실제 HTTP transport와 제어한 downstream 압력 분기를 검증하며 OS 소켓 버퍼의 부하 벤치마크는 아니다.
- SSE 외 요청에는 5분 socket 유휴 예산을 두고 SSE는 장기 연결을 유지한다.
- 원자적 peer 인증은 아니다. **listener 관찰부터 연결까지**, 살아 있는 relay가 listener만 닫고 다른 프로세스가 port를 점유할 수도 있다.
  이 창은 뒤따르는 동기 identity 판독 시간도 포함한다. PID 재사용이 필수 조건은 아니며 완전한 PID·port 재사용 방지를 주장하지 않는다.
- heartbeat 15초는 정상 소비 시 전송 간격이며, 역압·이벤트 루프 지연을 포함하는 이탈 감지 상한은 아니다.
- 기존 공개 SSE의 upstream abrupt-close 뒤 응답 정리 문제는 이 변경에서 새로 도입하지 않았으며 범위 밖으로 남긴다. downstream 이탈 정리는 위 시험으로 별도 확인했다.
- 저장 형식·relay lock 회수·신호 정책·binding 생성/소거 지점은 바꾸지 않았다. rollback은 app-server/game-loop와 신규 모듈을 함께 되돌리는 것이며 원래 취약 경로도 복원된다.

## 전체 실행의 timeout과 최종 검증 조건

`test/training-async-pipeline.test.js`의 `R1: a held-back hand stays recorded until its re-registered pipeline finishes`가 전체 실행에서 120초 timeout으로 취소됐다.
기준 edb0b57 사본과 현재 코드에서 같은 이름을 각각 분리 실행해 1개가 실제 실행·통과했음을 확인했다. 최초 timeout의 원인은 미확정이며 기존 결함으로 단정하지 않는다.
이 시험은 직접 game-loop/training을 쓰고 app relay proxy는 호출하지 않는다. proxy capability의 생성은 I/O 없는 클로저 생성이며 training 코드·정책을 변경하지 않았다.
로컬 전체 실행 도중 후속 문서·집중 시험 보완도 진행됐으므로 이 실행을 최종 커밋 전체의 green 증명으로 사용하지 않는다. 최종 커밋의 Linux/Windows 전체 CI를 별도로 완료해야 한다.

같은 gameId/sessionDir/selectionVersion/epoch에서 current·session·loop 참조만 바뀐 요청은 upstream 0을 유지하며 503 RELAY_UNAVAILABLE로 거절한다.
실제 게임/epoch 변경의 409 STALE_GAME과 구분해 클라이언트가 정상 복구 세션을 영구 종료하지 않게 한다. 현재 요청 epoch와 engine은 같고 binding만 뒤처진 경우도 503이다.
앱 세대 확인을 관측 전후에 하고, 최종 동기 구간에서 다시 파일/binding을 확인한 다음 await 없이 전송 함수를 호출한다.

`.github/workflows/test.yml`은 Linux Node20/22와 Windows rest Node20/22에 신규 3파일을 명시한 단계를 추가했다.
전체 자동 탐색과 별도로 대상 시험 실행 수·실제 adapter 및 relay_proxy_os_cost 진단을 직접 확인할 수 있다. 기존 전체 시험·샤드·게이트는 유지한다.

성공 배선의 실제 loop/relay 근거는 기존 `test/jev-session.test.js`의 canary 여정이다: host/참가자 GET·POST, host/참가자/관전자 snapshot·SSE를 실제 앱·loop로 통과시킨다.
`test/participant-api.test.js`도 실제 정책 세션의 참가자·관전자 proxy 및 재개를 확인한다. 합성 listener 시험과 이 실제 배선 시험을 서로 대체하는 증거로 쓰지 않는다.

최종 회귀 세트의 기준 코드 재실행(Node26, 새 current-객체 교체 2건 포함): 32 tests, 1 pass / 31 fail. 이 중 **26건은 실제 listener connections=1, requests=1**로 실패했다.
나머지 실패를 누출로 집계하지 않는다. 별도 foreign listener의 접촉도 이 수에 포함한다.

최종 관련 집중 실행(Node22.23.2): app-server-security, participant-api, session-controls, jev-session, process-identity, server-signal-identity — 104 tests, **102 pass, 0 fail, 0 cancelled, 2 skip**, 116.39s.
두 skip은 macOS에서 실행하지 않는 Windows 전용 서버 신호 시험이며, 실제 loop/relay의 host·참가자·관전자 canary 여정은 실행·통과했다.

선택적 잔여 사항: SSE의 응답 헤더가 오기 전 대기에는 별도 deadline이 없어 검증된 listener가 응답하지 않으면 downstream 이탈까지 기다릴 수 있다.
state 파일 크기·전체 요청 시간·실제 동시 폴링 처리량에 새 보장을 부여하지 않는다. 단위 슬롯 상한과 실제 OS 3회 표본을 부하 시험으로 해석하지 않는다.
