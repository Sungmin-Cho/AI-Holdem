# 멀티플레이 관전 기능 구현 계획

작성: 2026-09-20 · 기준 커밋: `0b6af8af9ae53c49b8fe42c6f30996e29ae05215`

정본 기능 계약은 [설계](multiplayer-spectator-design.md)다. 이 문서는 미래 구현 순서를 정한다. 이번 작업에서는 제품 코드·테스트 코드를 수정하지 않으며 실제 게임 서비스도 실행/중단하지 않는다. 기능 구현은 사용자 지시 이후 진행한다.

## 1. 구현 준비 판정 기준

- 사용자 정책 네 가지가 확정되고 F1–F8 수용 조건에 연결되어 있다.
- 입장 → 영속 room → 참가자 인증 → 릴레이 projection → snapshot/SSE → UI → 재접속/다음 게임까지 책임자가 정해져 있다.
- 현재 인간 전원 탈락 종료, cash-training 스택 리셋, 기존 seat 비공개 카드 계약을 보존한다.
- commit 실패, 복구 불일치, 관전 → 다음 게임 참가 권한 축소를 포함하는 실패 검증이 있다.
- 독립 검토에서 구현을 막는 미해결 결함이 없어야 한다. 리뷰 실행 성공만으로 승인 처리하지 않는다.

미래 구현의 위험도는 높다. 카드 접근 권한과 영속 room 상태, 실시간 연결 및 다음 게임 권한 전환을 함께 바꾼다. 문서 검토 완료는 기능 검증 완료가 아니다.

## 2. 구현 단위

### P1. 방 역할, 입장 및 다음 게임 참가

결과: 관전자가 엔진 좌석을 차지하지 않고 방에 존재하며, 게임 종료 후 직접 신청한 경우만 다음 좌석 명단에 들어간다. F1/F7/F8 담당.

수정 대상:

- `tools/room-manager.js`: schema 2, v1 입력 상향 변환, room revision, seated/spectator 목록 분리, role별 capacity/AI preview, join/seat-request 직렬화, code rotation, spectator revoke/remove, 탈락 seated 이탈의 roster 보존.
- `tools/session-manager.js`: 현재 game binding과 lifecycle을 room admission에 전달, start/restart/recover에 seated 명단만 사용, 게임 교체 중 입장 fence, paused resume의 최신 게시 준비 확인.
- `test/room-manager.test.js`, `test/participant-api.test.js` 및 필요시 새 `test/spectator-room.test.js`.

시작은 기존 `ROOM_LOCKED` 동작에 대한 실패 테스트부터 한다. 진행 중 입장자는 spectator/playerId=null이고 `players.json`/AI 수가 불변이어야 한다. v1 방을 읽고 쓰고 다시 읽어도 기존 token·seat identity가 동일해야 한다. 관전자 추가 후 recover가 ROOM_MISMATCH를 내지 않아야 하며 seated 누락/위조는 여전히 실패해야 한다. 구 schema 1에 없는 role 값을 임의로 추가한 손상 입력을 상향 변환으로 인정하지 않는다.

시작 명단 잠금과 seat-request 양쪽 순서를 재현한다. 신청 성공 후 start는 좌석 1개, start 선행은 ROOM_LOCKED, 두 관전자가 마지막 자리 신청 시 1명만 성공, 같은 신원의 재시도는 중복 없음. locked 역할 변경 금지, spectator 정원 20과 기존 좌석 정원 분리, token 폐기 및 열린 연결 종료도 검사한다. 낮은 관전 정원으로 바꾸려면 근거와 설계 수정을 함께 남긴다.

### P2. 관전 projection, 게시 및 복구

의존: P1의 게임 binding 계약. 결과: 전체 카드를 오직 인증된 관전 payload로 같은 commit 시점에 공급한다. F2/F3/F4/F5/F6 담당.

수정 대상:

- `engine/views.js`: allowlist 기반 순수 spectator projection. `viewFor` 및 CLI player views의 카드 계약은 유지한다.
- 새 `shared/viewer-access.js`: player/spectator/finished/unavailable 결정과 gameOver 우선순위. `isHumanSeat`, out 및 온라인 room context를 입력받는 순수 계약. 브라우저 입력이 권한 입력이 되지 않게 한다.
- `server/server.js`: 내부 viewer context 검증, spectator snapshot/frame, 매 commit 탈락 역할 재평가, commit 성공 후 frame 설치, card-free projection anchor 저장/검증, loadUiState/paused resume 준비 상태, 재접속 snapshot/full replace.
- `shared/multiplayer-publish.js`, `publish-contract.js`: 필요할 때 새 projection validator/re-export만 추가. 기존 인간 views key 집합과 이벤트 공개 정책을 약화하지 않는다.
- `tools/game-loop.js`: 실제 복구 경로상 relay projection이 준비되지 않으면 현재 canonical view를 재게시하는 최소 변경. 새 핸드를 시작하거나 pause를 푸는 방식으로 복구하지 않는다. 조사 결과 이미 준비 게시가 보장되면 이 파일은 수정하지 않는다.
- `test/views.test.js`, `test/relay-seat-scoping.test.js`, 새 `test/spectator-projection.test.js`, 새 `test/spectator-recovery.test.js` 및 기존 publish/recovery 테스트.

고정 덱의 현재 카드와 미래 deck/board를 서로 다른 sentinel로 검사한다. 사람/AI/fold 홀카드는 spectator에 모두 있고 살아 있는 player의 원시 JSON/SSE에는 타인의 비공개 카드가 없어야 한다. showdown 표준 공개와 현재 spectator full cards를 따로 검사한다. UI만 숨기는 검사로 대체하지 않는다.

최소 음성 시나리오: out=false/all-in stack=0, 동시 탈락, cash reset, 마지막 인간 탈락, 중간 호스트 탈락, 잘못된 epoch/version/handNo, projection 제작 후 저장 실패, receipt commit 실패, 구 snapshot anchor 없음, engine만 앞선 crash, 손상 상태. disk UI/history/export에서 holeCardsByPlayerId 및 spectator frame이 없어야 한다. 완전히 종료된 경로도 raw engine을 그대로 반환하지 않는다.

SSE 검증은 연결이 열린 상태에서 player → spectator, gameOver 우선, after=0/미래값/과거값, 200-frame ring 범위 초과, 네트워크 재연결을 포함한다. spectator 재접속은 과거 전체 카드 history 대신 현재 full snapshot으로 동기화한다. 실패한 publish의 candidate frame은 publish 직후와 재접속 어느 시점에도 읽을 수 없어야 한다.

### P3. 공개 API의 관전 권한과 lifecycle

의존: P1/P2. 결과: 관전 전용 신원 및 탈락자가 현재 게임을 읽되 행동할 수 없다. F1/F3/F5/F6/F7/F8 담당.

수정 대상:

- `tools/app-server.js`: join에 서버 lifecycle 전달, seat-request endpoint, p/state의 역할/가능 동작, trusted relay viewer context, host/current viewer 경로, no-store, readonly 오류, 토큰 revoke/current 교체 SSE 종료, 최종 결과.
- `tools/session-manager.js`: 역할 조회에 필요한 검증된 현재 binding/상태 인터페이스. engine private state를 브라우저로 보내지 않는다.
- `test/participant-api.test.js`, `test/app-server-security.test.js`, `test/app-service.test.js`, 새 `test/spectator-api.test.js`.

검사: 같은 참가 코드의 늦은 접속 snapshot/events 200; seat/role 위조 거절; spectator action/action-status 403 및 receipt/게임 상태 불변; 토큰 없음/폐기 401; stale game/epoch 409; missing projection VIEW_NOT_READY; public host/control/study/raw file 경로 404. 현재 observer이더라도 host auth의 pause/resume/abort는 그대로 가능해야 한다.

game start 전후, pause/resume, ending/finalizing, restart/replace-current 및 실패 rollback을 각각 재현한다. 마지막 인간 탈락의 엔진 종료와 app completed 사이에는 관전을 계속하는 새 게임이 생기지 않아야 한다. 기존 참가자가 탈락 후 새로고침해도 자동 관전이며 관전 전용 참가자의 접속이 기존 seated timer를 갱신하거나 액션으로 처리되지 않아야 한다.

### P4. 관전 화면 및 viewer 기준 테이블

의존: P2/P3. 결과: 늦은 관전자와 탈락자가 동일한 읽기 전용 테이블을 보고, 다음 게임의 권한에 맞게 화면이 교체된다. F2/F3/F4/F6/F7/F8 담당.

수정 대상:

- `server/public/app.js`, `seat-format.js`: 하드코딩 user 대신 viewer 기준 자기 좌석/카드/‘나’/턴/베팅; spectator whole-map 카드 렌더링, full replace, 관전 배너, 조작과 단축키 비활성화.
- `server/public/join.js`, `join.html`, `join-bootstrap.js`: 진행 중 관전 입장 안내, 관전 나가기/다음 게임 참가, 오류, 결과 및 iframe identity lifecycle.
- `server/public/lobby.js`, `lobby.html`: 플레이어/관전자 명단과 수, 진행 중 spectator 제거·코드 회전, host 상태 표시.
- `server/public/app-transport.js`: snapshot/reset 이벤트, 신원·game/epoch 전환 시 SSE 취소/revision 초기화. authorization은 서버에서 유지한다.
- `server/public/index.html`, `style.css`, `table-design.css`, `lobby.css`는 필요한 배너·role 상태 범위만 수정한다. 기존 디자인과 최대 9인 좌석 배치를 보존한다.
- `test/seat-format.test.js`, `test/lobby-markup-contract.test.js`, 관련 UI 계약 테스트 및 브라우저 journey.

카드 레이아웃은 host/guest/late spectator/eliminated host/eliminated guest 모두 확인한다. 관전 화면에서 host가 ‘나’로 표시되지 않고 folded 카드가 읽히며, 다음 hand에서 이미 탈락한 사람의 이전 카드가 없어야 한다. keyboard/click 전송 경로 모두 막고 stale pendingAction을 정리한다. 모바일 390px와 데스크톱 1280px, 최대 9인 좌석을 검사한다.

iframe/SSE 전환은 spectator game A → 로비 → game B spectator와 spectator game A → 좌석 신청 → game B player를 별도로 검사한다. URL/iframe/DOM/full card cache/action controller revision이 새 identity를 사용해야 하며 사용자 수동 새로고침을 성공 조건으로 삼지 않는다.

### P5. 통합 회귀 및 독립 구현 검토

의존: P1–P4. 결과: 실제 앱·릴레이·브라우저 경로의 F1–F8 수용 조건을 증명한다.

- 기존 `test/browser/multiplayer-journey.mjs`를 확장하거나 같은 owned workspace helper를 쓰는 `test/browser/spectator-journey.mjs`를 추가한다. AI는 deterministic policy 또는 테스트용 고정 덱을 사용하고 외부 LLM 호출을 요구하지 않는다.
- 독립 브라우저 context로 host, 생존 guest, 탈락 guest, 늦은 spectator를 동시 관찰한다. 네트워크 응답과 렌더링을 둘 다 검사한다.
- 실사용 `game/` 트리의 before/after hash 불변과 생성한 서버·브라우저·study service의 정상 종료를 검증한다. 고정 공개 포트 8899를 빼앗거나 현재 세션을 종료하지 않는다.
- 전체 `npm run test:ci`, 기존 multiplayer/lobby/UI browser journey와 새 관전 journey를 수행한다. Windows의 private file/프로세스/앱 복구 경로는 기존 CI 분할로 확인한다. 설치되지 않은 ESLint/Stryker를 임의 설치하거나 없는 센서 결과를 PASS로 보고하지 않는다.
- 독립 구현 리뷰는 auth/projection 경계와 lifecycle/recovery를 중점으로 한다. 발견 사항은 재현/추적 후 선택 반영한다. 중요한 미해결 발견, 테스트 timeout 또는 unavailable 판정은 완료로 취급하지 않는다.

## 3. 수용 조건과 검증 대응

| 조건 | 주요 검증 |
| --- | --- |
| F1 늦은 입장/좌석 불변 | room unit + participant API + real browser late join |
| F2 전체 카드/hand reset | fixed-deck projection + raw snapshot/SSE + fold/mobile UI |
| F3 정확한 탈락 전환 | all-in/fold/settlement 엔진 fixture + 지속 SSE + host/guest UI |
| F4 종료 의미 | 기존 multi-human-engine 종료 테스트 + finalizing/result UI |
| F5 권한/비공개 | forged role, readonly action, host API 차단, live player payload 부재, disk history 부재 |
| F6 복구/다음 게임 | persist fault, anchor mismatch, paused resume, app restart, epoch reset/browser cache 검사 |
| F7 다음 게임 신청 | start와 신청 경합, 중복 요청, 정원, 실제 game B player/spectator 분기 |
| F8 명단/관리 | count/capacity, spectator kick/leave/code rotation, seated recovery 일치, game-loop 불변 |

## 4. 호환성과 복구 방침

room v1 → v2는 참가자 토큰과 좌석 명단을 보존하는 상향 변환이다. 구 프로그램으로의 downgrade 호환을 약속하지 않는다. live room v2를 구버전 schema로 덮어쓰지 않는다. snapshot anchor 없는 기존 게임은 정상 상태 재게시로 roll-forward하며 상태 손상은 기존 오류 경로를 따른다.

실패 시 현재 game identity와 영속 action receipt를 보존한다. 관전 projection만 unavailable로 만들 수 있어야 하며 게임을 재초기화하거나 pending action을 지워 복구하지 않는다. 구현 변경 회수는 해당 코드 변경만 되돌리고 사용자의 game/store/토큰을 조작하지 않는다. schema 2 저장이 생긴 실제 배포 뒤에는 호환 reader가 있는 버전으로 복구한다.

## 5. 준비 상태

사용자 정책 질문은 해결됐다. 구현 시작 여부의 최종 판정은 별도 [설계 검토 기록](multiplayer-spectator-review.md)에 남긴다. 현재 문서는 제품 테스트 PASS나 배포 가능 상태를 주장하지 않는다.
