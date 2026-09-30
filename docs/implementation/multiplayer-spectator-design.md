# 멀티플레이 관전 기능 설계

작성: 2026-09-20 · 기준 커밋: `0b6af8af9ae53c49b8fe42c6f30996e29ae05215`

현재 단계는 설계와 구현 계획이다. 아래 내용은 목표 동작이며 구현 완료를 뜻하지 않는다. 구현 순서와 검증은 [구현 계획](multiplayer-spectator-plan.md)을 따른다.

## 1. 사용자 확정 정책

| 항목 | 확정 내용 |
| --- | --- |
| 늦은 입장 | 게임 시작 후 같은 참가 링크/코드로 들어오면 관전자로 입장한다. 진행 중 좌석은 추가하지 않는다. |
| 공개 카드 | 사람·AI 모두의 현재 홀카드를 실시간으로 공개한다. 폴드한 사람의 카드도 포함한다. |
| 신뢰 전제 | 지인 간 게임이다. 플레이어가 별도 신원으로 관전 접속하는 것을 계정 수준에서 차단하는 기능은 범위 밖이다. |
| 중간 탈락 | 호스트를 포함해 탈락 확정 후 자동 관전으로 전환한다. |
| 종료 조건 | 마지막 인간 플레이어 탈락 시 종료하는 현재 규칙을 유지한다. AI가 여럿 남아도 계속 진행하지 않는다. 마지막 1인 생존 종료도 유지한다. |
| 다음 게임 | 늦게 입장한 관전자는 관전을 유지한다. 직접 ‘다음 게임 참가’를 눌러야 좌석 참가자가 된다. |

게임은 한 핸드가 아니라 시작부터 종료까지의 세션을 뜻한다. 토너먼트의 ‘탈락’은 핸드 정산이 끝난 뒤 엔진의 `out === true`로 확정된다. 폴드, 연결 끊김, 액션 대기 시간 초과, 올인 중 `stack === 0`은 탈락이 아니다. cash-training의 스택 리셋은 관전 전환을 발생시키지 않는다.

## 2. 사용자 흐름

1. 로비에서 참가하면 기존처럼 좌석 대기자가 된다. 시작 직전 명단 잠금 중에는 ‘게임 준비 중, 잠시 후 다시 시도’로 안내한다.
2. 시작이 확정되어 `playing` 또는 `paused`인 온라인 방에 신규 입장하면 이름과 코드 검증 후 관전자가 된다. 화면에 ‘관전 중 · 모든 카드 공개’를 표시한다. 좌석이 가득 차도 별도 관전 정원 안에서는 입장할 수 있다.
3. 중간 탈락자는 핸드 정산 게시와 함께 관전 화면으로 자동 전환된다. ‘탈락하여 관전으로 전환되었습니다’를 한 번 알린다. 탈락한 호스트도 동일하지만 로비의 일시정지·재개·종료 관리 권한은 유지한다.
4. 관전자는 테이블, 플레이어 이름·스택·폴드/올인/탈락 상태, 블라인드·버튼·팟·보드·현재 행동자·남은 행동 시간과 공개 액션 로그를 본다. 베팅/의도 메모/힌트/개인 학습·코칭 조작은 제공하지 않는다.
5. 마지막 인간 탈락 또는 마지막 1인 생존으로 `gameOver`가 확정되면 자동 관전보다 종료가 우선한다. 마지막 인간 탈락은 ‘모든 인간 플레이어 탈락으로 종료’로 표시하며 AI 우승자를 임의로 만들지 않는다. 정산 완료 뒤 기존 최종 스택 결과로 이동한다. 중단은 ‘중단됨’으로 표시한다.
6. 다음 게임이 준비되면 신규 관전자는 관전 자격을 유지한다. 열린 로비에서 ‘다음 게임 참가’를 누르면 빈 인간 좌석을 즉시 확보한다. 별도 호스트 승인을 요구하는 대기열은 만들지 않는다. 가득 찼으면 관전을 유지하고 정원 초과를 안내한다. 진행 중에는 버튼을 비활성화하고 ‘게임 종료 후 신청 가능’을 표시한다.
7. 이전 게임에서 탈락한 기존 참가자는 좌석 참가 자격을 유지하므로 다음 게임에서 기존처럼 다시 플레이한다. ‘관전 유지’는 늦게 입장한 관전 전용 접속자에게 적용된다.

## 3. 역할과 데이터 모델

방의 좌석 참가 자격과 현재 게임 화면 역할은 서로 다르다. 영속적인 방 역할은 `roomRole: seated | spectator`, 게임별 읽기 권한은 `viewerRole: player | spectator | finished | unavailable`로 구분한다. 이름과 값은 구현 중 바꿀 수 있지만 이 구분은 유지한다.

| 신원/상태 | 방 역할 | 게임 화면 | 카드/행동 권한 |
| --- | --- | --- | --- |
| 생존 참가자 | seated | player | 본인 카드 및 기존 공개 카드, 본인 차례만 행동 |
| 중간 탈락 참가자/호스트 | seated | spectator | 전체 홀카드, 행동 불가 |
| 늦게 온 접속자 | spectator | spectator | 전체 홀카드, 행동 불가 |
| 종료된 게임 | 기존 역할 유지 | finished | 최종 결과, 새 행동 불가 |
| 복구 중이거나 상태 불일치 | 기존 역할 유지 | unavailable | 새로운 카드 공개와 행동을 보류 |

- `.app/room.json`은 schema 2로 확장한다. 기존 schema 1의 모든 유효 참가자는 `seated`로 해석한다. token hash/generation, participantId, 이름, 기존 seat mapping을 보존한다. 알 수 없는 schema/role은 오류로 처리한다.
- 호스트는 기존 로컬 호스트 인증을 유지한다. 관전 역할 때문에 참가자 토큰으로 바꾸지 않는다.
- 신규 관전자는 `playerId: null`이며 엔진의 `players.json`, `state.seats`, `humanCount`, 액션 루프, AI 수, 블라인드/팟/훈련 통계에 추가하지 않는다.
- `activeParticipants`를 인증·명단용과 좌석용으로 구분한다. `hostView`, 정원, `aiPreview`, `lockForStart`, `bind`, `recover`, `injectFromLock`은 각기 올바른 집합을 사용한다. 복구의 정확한 참가자 일치 검사는 active seated 집합에만 적용한다.
- 좌석 mapping은 `playerId`만 믿지 않고 현재 boundGameId와 고정된 게임 참가자 명단으로 검증한다. 직전 게임의 h1 등이 다음 게임의 권한으로 그대로 재사용되지 않도록 한다.
- `viewerRole`과 `out` 판정은 서버에서 현재 게임의 확정된 상태로 계산한다. 브라우저 query/body/header에서 역할을 선택할 수 없다.

## 4. 입장·참가 신청·관리 계약

`POST /api/join`은 코드·이름·rate limit을 통과한 후 서버 상태에서 역할을 정한다. `open`이면 seated, 현재 게임과 room binding이 일치하고 `playing/paused`이면 spectator다. `starting`, `ending`, 재시작/교체 요청 처리 중, room error/closed는 입장을 거절한다. 종료 후 방이 open이면 기존 신규 참가 동작을 유지한다. 클라이언트의 ‘관전’ 표시는 안내일 뿐 권한 입력이 아니다.

`GET /api/p/state`는 인증된 자신의 roomRole/viewerRole, 이유(`late-join`/`eliminated` 등), 현재 gameId/epoch, 참가 신청 가능 여부, 공개 관전자 수를 반환한다. 호스트 snapshot에도 자신의 viewerRole 및 분리된 관전자 명단을 제공한다. 외부 명단에는 token/hash·내부 경로·릴레이 자격 증명을 포함하지 않는다.

`POST /api/p/seat-request`는 열린 로비에서만 spectator → seated를 원자적으로 처리한다. 요청의 expected roomId 및 현재 room revision을 검증한다. 가입, 참가 신청, 제거, start 명단 잠금은 동일한 직렬화 경계에서 정원과 역할을 다시 확인한다. 이미 seated인 동일 신원의 재시도는 중복 좌석을 만들지 않는다. 시작 잠금이 먼저 잡히면 `ROOM_LOCKED`, 정원이 차면 `ROOM_FULL`, 오래된 방이면 `STALE_ROOM`으로 실패하고 관전 권한을 보존한다. 시작 전 선착순 확정이며 관전자의 참가가 빈 AI 예정 좌석을 대체한다.

관전 전용 정원은 첫 버전에서 20명으로 고정한다. 이는 연결 수가 아니라 active spectator 자격 수이며 오프라인 접속자도 포함한다. 최대 9개 좌석에서 전환된 탈락자는 이 20명에 포함하지 않는다. 기존 전역/IP별 연결 제한과 신원별 SSE 제한은 유지한다. 정원 초과는 `SPECTATOR_FULL`로 표시한다. 정원은 성능 검증 결과에 따라 구현 검토에서 낮출 수 있으나 무제한으로 바꾸지 않는다.

호스트는 로비에 플레이어/관전자 명단과 연결 상태를 구분해 본다. 진행 중에도 관전 전용 접속자를 내보내고 참가 코드를 회전할 수 있다. 퇴장 시 토큰을 폐기하고 열린 snapshot/SSE 연결을 끊는다. 코드 회전은 새 입장에만 영향을 주며 기존 접속을 강제로 끊지 않는다. 회전이 기존 코드 보유자의 재입장을 차단할 뿐 개인을 영구 차단하지는 않는다.

관전 전용 접속자는 언제든 나갈 수 있다. 탈락자가 나가면 인증 토큰과 연결만 폐기하고 bound game의 seated 명단과 participantId/playerId는 유지해 복구 일치 검사가 깨지지 않게 한다. 생존 참가자의 게임 중 이탈/강제 제거 규칙은 확장하지 않는다. 기존 seated 토큰 재발급은 게임 중 허용하지 않으며 다음 열린 로비의 호스트 재발급으로 복귀한다. 관전자 제거와 seated roster 삭제를 같은 연산으로 구현하지 않는다.

## 5. 카드 공개와 실시간 전달

기존 `views`는 인간 플레이어별 자기 카드 projection으로 유지한다. 관전자를 가짜 seat ID로 추가하거나 플레이어 view에 전체 카드를 넣지 않는다. 릴레이가 게시 검증에 사용한 같은 엔진 상태로 별도 `spectatorView`를 만든다. 엔진 CLI/AI 플레이어 envelope에 전체 카드 필드를 추가할 필요가 없다.

관전 projection은 명시적 allowlist다: 현재 공개 테이블 필드 + `viewerRole: spectator` + `viewer: null` + `holeCardsByPlayerId`. `myCards`는 빈 배열이며 `legal`은 없다. 공개된 상태의 `hand.holes` 또는 직전 핸드 정산을 표시할 때 `lastHand.holes`만 복사한다. `deck`, RNG/seed, 아직 나오지 않은 board, 개인 note/코칭/훈련/힌트, 내부 경로·토큰은 복사하지 않는다.

- 현재 핸드에서 카드를 받은 사람은 폴드했어도 카드를 표시한다. 이전 핸드에서 이미 탈락해 이번 핸드의 holes에 없는 사람은 빈 카드 영역과 ‘탈락’을 표시한다.
- handNo 전환 시 카드 map 전체를 교체한다. 직전 카드의 merge/fallback으로 탈락자 카드를 다음 핸드에 남기지 않는다.
- 첫 접속/재접속은 현재 전체 snapshot으로 동기화한다. 관전자에게 과거 핸드 전체 카드 기록을 다시 전송하는 기능은 없다.
- spectator snapshot/SSE는 공개 로그만 제공한다. 일반 플레이어의 snapshot/SSE/로그/리플레이/export에는 관전 전용 카드 필드가 없다. 기존 공개 쇼다운 및 replayReveal 정책은 별도로 유지한다.
- 호스트가 탈락했을 때도 관전 테이블 payload에는 개인 코칭/힌트/훈련을 섞지 않는다. 기존 호스트 인증의 관리 기능과 종료 후 개인 리뷰 접근은 별도 기존 경로에 남는다. 외부 관전자에게 호스트 경로를 프록시하지 않는다.

### 게시 일관성과 복구

현재 릴레이의 UI 저장 → receipt 저장 → 메모리 반영 → fanout 순서를 보존한다. 관전 projection과 seat별 frame은 candidate로만 준비한 뒤 durable commit 성공 이후 공개한다. 현재 `participantFrames.push`가 persist보다 앞에 있는 부분도 이 경계 안에서 조정한다. 실패한 게시의 카드·탈락 역할은 snapshot/SSE 어느 쪽에도 노출하지 않는다.

projection에는 session epoch, engine stateVersion, handNo, publishId, UI revision의 일치 기준을 둔다. 전체 카드가 없는 이 anchor만 `ui-snapshot.json`에 저장한다. 카드 map, 관전 frame, 관전 역할이 적용된 host 화면을 디스크의 기존 host history에 기록하지 않는다. 기존 canonical player view 저장과 관전 전용 전달을 구분한다.

릴레이 재시작 시 검증한 엔진과 durable UI anchor가 정확히 일치할 때에만 관전 projection을 재생성한다. anchor가 없는 구 snapshot 또는 엔진이 앞서 간 경우 `VIEW_NOT_READY` 상태로 대기하고 game-loop의 정상 최신 view 재게시로 복구한다. paused resume에서도 입력을 다시 열기 전에 현재 상태 게시를 보장한다. 디스크 최신 state를 과거 UI revision에 임의로 붙이지 않는다. 손상된 엔진이나 잘못된 room binding은 일반 player view로 우회하지 않고 실패한다.

SSE의 spectator 경로는 현재 projection snapshot으로 시작하고 이후 commit된 변경만 전송한다. 재접속의 `after` 값은 관전 권한이나 과거 전체 카드 replay 범위를 넓히지 않는다. seat 구독이 탈락하면 다음 commit에서 같은 연결을 spectator로 전환하고 UI에 full replace를 지시한다. `gameOver`가 같은 commit이면 finished가 우선한다. 새로운 gameId/epoch에서는 기존 연결을 닫고 snapshot·revision·카드 map·액션 receipt 상태를 초기화한다. 다음 게임의 seated 신원이 과거 spectator frame을 받는 경로를 허용하지 않는다.

## 6. 서버 권한 경계

관전 전용 신원은 `snapshot/events`만 허용한다. `action/action-status`는 `403 SPECTATOR_READ_ONLY`이며 요청 body를 읽고 액션 receipt를 만드는 것보다 먼저 거절한다. 호스트와 기존 seated 신원의 경우에는 릴레이에서 현재 확정된 탈락/종료 상태를 재검사한다. hand 진행 중 stack=0이라도 out=false이면 일반 player 권한을 유지하며 기존 action turn 검사가 적용된다.

앱 gateway는 참가 토큰과 room binding으로 내부 viewer context를 만든다. 모든 사용자 제공 seat/role 관련 값은 제거하거나 거절한다. 릴레이 세션 토큰과 검증된 내부 context로만 spectator projection에 접근한다. 일반 seat 요청이 spectator context로 승격되지 않으며 외부 `/api/commands`, `/api/room`, `/api/study`, raw state/players 파일은 기존처럼 차단한다. 호스트의 로비 일시정지·재개·종료는 별도 호스트 인증으로 계속 허용한다.

순서: 인증 → room/game/epoch binding → 역할 및 endpoint 허용 검사 → projection 준비 여부 → 응답. 지속 연결도 revoke, current 교체 및 epoch 변경을 반영한다. 토큰 없는 요청은 전체 카드가 없는 401이며, stale game은 409이다. 관전자의 snapshot은 기존처럼 no-store로 제공한다.

## 7. 화면 구현 원칙

기존 테이블을 재사용한다. ‘나’, 자기 카드 위치, 좌석 회전, 턴 강조, 베팅 금액 기준을 하드코딩된 `user` 대신 인증된 `view.viewer`로 결정한다. 일반 guest의 자기 카드는 자기 좌석에 놓인다. spectator의 viewer는 null이며 호스트 자리를 ‘나’로 표시하지 않는다. 관전자 테이블은 고정된 원래 좌석 순서를 유지한다.

관전 배너에는 실시간 전체 공개임을 명시한다. 액션 바·키보드 행동 단축키·의도 메모·힌트는 관전 전환 시 제거/해제하고 전송 중 UI 상태를 초기화한다. 서버의 쓰기 금지가 최종 권한 경계다. fold 스타일의 흐림/숨김이 전체 카드 가독성을 없애지 않게 한다. 모바일 9인 테이블에서도 카드와 상태를 구분할 수 있어야 한다.

`join.js`의 iframe은 `(gameId, gameEpoch, 신원 권한 세대)`가 바뀌면 이전 iframe을 정리하고 새 테이블로 교체한다. 종료 시 기존 결과 화면을 보여주고, 로비에서 참가 신청 가능 여부를 갱신한다. 관전 → 다음 게임 seated 전환 시 구 관전 카드 DOM·캐시·SSE를 먼저 제거한 다음 새 player snapshot을 받는다. 단순 새로고침 없이 다음 게임을 볼 수 있어야 한다.

## 8. 실패 및 경계 상황

| 상황 | 기대 결과 |
| --- | --- |
| all-in stack 0, hand 미정산 | 탈락/관전 전환 없음 |
| 동시 다중 탈락 + 아직 인간 생존 | 해당 탈락자 모두 관전, 생존자 카드 권한 유지 |
| 마지막 인간까지 동시 탈락 | finished 우선, 가짜 우승자/새 핸드 없음 |
| 진행 중 신규 접속과 재시작 경합 | 한 game binding으로만 성공하거나 재시도 오류, 중간 seated 삽입 없음 |
| 관전자 존재 상태에서 앱 재시작 | seated 명단만 players와 대조, ROOM_MISMATCH 오검출 없음 |
| full card 생성 후 persist 실패 | 카드와 role candidate 미전파, recovery 상태 유지 |
| SSE 유실/재접속·pause 중 접속 | 동일 game/epoch의 현재 snapshot으로 복원 |
| 관전 → 참가 후 다음 게임 | spectator 연결/캐시 폐기, 자기 카드만 수신 |
| 관전 정원 초과 | 좌석/게임에는 영향 없이 SPECTATOR_FULL |
| spectator 퇴장/토큰 폐기 | 연결 종료, 이후 401, 현재 게임 엔진 불변 |
| 구버전 room/snapshot | role을 안전하게 상향 변환, anchor 없는 전체 카드 공개는 최신 재게시까지 대기 |
| 마지막 인간 탈락 후 AI 복수 생존 | 기존 lose 종료, AI끼리 계속 진행하지 않음 |

## 9. 수용 조건과 제외 범위

F1: 시작 후 접속자는 같은 게임을 관전하며 엔진 좌석·AI 수가 변하지 않는다.

F2: 사람·AI·폴드 좌석의 현재 홀카드가 관전자에게 보이고, 새로운 핸드에 이전 카드가 남지 않는다.

F3: 중간 탈락자는 호스트 포함 자동 관전하며, 올인/폴드/연결 끊김을 탈락으로 오인하지 않는다.

F4: 마지막 인간 탈락/마지막 1인 생존/중단의 기존 종료 의미를 보존한다.

F5: 모든 HTTP/SSE/복구/종료 경로에서 플레이어 비공개 카드 규칙과 관전자 읽기 전용 권한을 지킨다.

F6: 재접속·일시정지·앱/릴레이 복구·다음 게임에서 동일한 역할과 카드 기준을 사용한다.

F7: 관전 전용 신원은 다음 게임에도 관전을 유지하고 로비에서 직접 신청한 경우만 좌석을 차지한다.

F8: 관전자 명단·정원·퇴장·코드 회전이 좌석 및 game-loop 수명에 영향을 주지 않는다.

채팅, 승률/GTO 표시, 관전자용 개인 학습/리플레이/export, 게임 도중 참가/재구매, 사전 관전 전용 신규 입장 선택, 별도 링크/계정 체계, AI만 남은 게임 연장은 이번 구현에서 제외한다. 기존 관전자의 로비 잔류는 지원한다. 정책 결정에 필요한 미해결 사용자 질문은 없다.
