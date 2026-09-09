# 웹 로비와 게임 제어 구현 계획

작성일: 2026-09-09. 기준 HEAD: `cb838484c967f59133bd45ca34fa03c2bdab0a84`.
계약: [설계서](lobby-session-design.md). 상태: **구현 착수 가능**. 계획 2차 독립 리뷰 PASS/PASS, 비차단 지적은 아래 테스트/문구에 반영했다. 상세 판단은 [검토 기록](lobby-session-review.md)에 있다.
이번 작업은 이 계획까지 작성한다. 아래 테스트·코드·릴리스 작업은 **아직 수행하지 않았다**.

## 1. 전달 순서와 완료 정의

`T1 설정/프로토콜 → T2 launcher 추출 → T3 pause → T4 abort/복구 → T5 관리 서비스 → T6 로비/메뉴 → T7a opt-in 진입 → T8 통합 검증/리뷰 → T7b 스킬 기본 전환`.

각 단계는 해당 계약을 깨뜨리는 테스트를 먼저 만들고 변경 후 통과를 확인한다. 리뷰는 상태·저장·보안 변경 묶음과 최종 제품 연결에서 수행한다. 사소한 표시 변경마다 리뷰 루프를 늘리지 않는다. 동시 작업이 필요해지면 파일 소유 경계를 분리하고 model-router로 실제 사용 가능한 모델을 배정한다. 아래 순서의 의존성을 무시하고 기존 게임 루프 위에 UI부터 활성화하지 않는다.

구현 완료는 U1~U9 및 아래 M1~M16의 증거, 관련 회귀 테스트, 전체 지원 CI, 독립 리뷰에서 미해결 blocker 없음으로 판정한다. 설계 승인이나 단위 테스트만으로 실제 브라우저 기능 완료를 선언하지 않는다.

## 2. 작업 항목

### T1. 설정 및 제어 프로토콜

주요 파일: 신규 `shared/game-setup.js`, `shared/session-control-contract.js`; 수정 `tools/game-loop.js`의 applyModeDefaults; 테스트 `test/game-setup.test.js`, `test/session-control-contract.test.js`.

- UI 입력을 `mode`, `aiCount`, `opponentRuntime`, 모드별 numeric 설정, `mirrorSelf`, `exploitSelf`, `hints`, 공개 범위로 제한한다. unknown key, 문자열 숫자 강제 변환, NaN/Infinity, 정수 overflow, raw shell flags를 거부한다.
- 로비 기본과 CLI 호환 기본을 shared module의 두 profile로 명시하고 applyModeDefaults는 CLI profile에 위임한다. 사용자 AI 수는 1~8; 현재 engine의 스택/블라인드 검증을 재사용한다. 엔진이 수용하는 최대값과 곱셈 safe integer 검사를 schema에 연결해 두 구현이 다르게 허용하지 않게 한다.
- 자기 상대 두 체크박스와 LLM 상충, AI 좌석 부족, 60핸드 자격, hint/기준표 지원 범위는 공개 capability DTO로 표시한다. 자격 산출은 서버 전용이며 UI는 source/session/private policy를 받지 않는다.
- control schema version, 명령 종류, request identity, app/session revision, 공개 DTO, 상태별 allowedCommands/error code를 확정한다. `test/session-control-contract.test.js`에 모든 상태×명령의 table-driven 양성/거부 사례를 둔다. control-state 누락(legacy)과 malformed/미지원 버전을 구분한다. setup은 start/replace-current 전용; resume/pause/end/restart에는 거부한다.

RED/GREEN: 숫자형 경계, AI=0/9, tournament+hands, stack+stackBb, 두 자기 상대+AI1, LLM+self, unknown keys; 스키마와 기존 엔진 검증의 대표 입력 결과가 같음. engine/cli.js의 process-exit validator를 import하지 않고 격리 store/child CLI의 table-driven 입력·종료 코드를 비교한다. `start game --mode tournament --ai 8`의 prefill 경로 테스트에서는 엔진 호출이 0회임을 별도로 확인한다.

profile 차이의 테스트 소유자는 `test/game-setup.test.js`다. lobby tournament의 policy 기본과 기존 CLI tournament의 LLM 기본, 명시 상대 옵션 우선, applyModeDefaults 위임 전후 동일 입력/출력을 각각 고정한다.

### T2. 공유 launcher와 loop 수명 분리

파일: 신규 `tools/session-launcher.js`; 수정 `tools/game-loop.js`, `engine/session-catalog.js`; 테스트 `test/session-launcher.test.js`, 기존 `test/game-loop.test.js`, `test/session-catalog.test.js`.

- 현재 main의 store lock→prepare/init→commit→createGameLoop를 함수로 추출한다. `startSession`, `restoreSession`은 한 concrete gameDir 및 loop handle을 반환하고 run completion을 관찰 가능하게 한다. launcher/loop는 프로세스 signal handler/exit를 설치하지 않는다. standalone CLI main과 app-service entry가 각자 자신이 호스팅하는 프로세스의 핸들러를 한 번 설치한다.
- 기존 CLI는 동일 launcher를 호출한다. legacy game-dir, explicit arguments, practiceFocusFile 경로, 기존 runtime resolver 및 자기 상대 마커/derived configs 초기화를 보존한다.
- 생성 transaction에 command가 예약한 gameId/selectionVersion을 공급할 수 있게 한다. UUID/path binding, staging/committed identity 검증, current CAS를 유지하며 public arbitrary path는 허용하지 않는다. 기존 prepareSession 호출자는 기존 의미를 보존한다. init-complete digest 증거를 추가하고 설계 §5의 staging/finalDir/current 복구 표를 구현한다. incomplete staging은 보존+RECOVERY_REQUIRED이며 재초기화/자동 삭제하지 않는다. CURRENT_CHANGED 때 예약 버전 재발급은 하지 않는다.
- loop의 requestStop/run 완료는 app 프로세스를 종료하지 않는다. 락 보유 중 같은 프로세스 내 두 번째 loop 객체도 만들지 못하게 manager-level single-owner assert를 제공한다.
- managed 옵션은 `startPaused`, control identity와 public transport에 필요한 session metadata만 허용한다. 기존 `resume()`의 step/new-hand/AI 복원이 pause gate를 통과하도록 optional gate hook을 주입하는 구조를 준비한다. legacy만 no-op 기본을 쓰며 managed 진입은 T3 gate가 연결되기 전에는 활성화하지 않는다.

RED/GREEN: 기존 direct CLI 결과와 비교, bare launcher service 기동만으로 catalog current 불변, same process 이중 launch 거부, init 실패 current 보존, commit 뒤 실패 같은 gameId 유지, 기존 active loop/relay를 ACTIVE_GAME으로 보존, 순차 두 게임에서 이전 디렉터리 bytes 보존.

### T3. 안전 지점 pause / resume

파일: 신규 `tools/session-control.js`; 수정 `tools/game-loop.js`, `tools/publish.js`, `server/server.js`, `server/action-receipts.js`; 테스트 `test/session-pause.test.js`, `test/session-control-race.test.js`, 기존 `test/game-loop.test.js`, `test/publish.test.js`, `test/action-receipts.test.js`.

- loop API에 `requestPause`, `resumePlay`, `getControlSnapshot`을 추가한다. pause와 requestStop은 다른 상태/경로다. durable control gate와 admission generation을 모든 user/AI/new-hand 경로가 확인한다. run()은 control.waitUntilPlayable()에서 park하며 paused ACK promise와 run completion은 분리한다. resumePlay는 기존 실행을 깨우고 run 재진입은 하지 않는다. requestStop/endGame은 park도 깨운다.
- loop의 gate 닫기와 relay의 gate 검사+receipt accept를 공유한 짧은 락으로 직렬화한다. control→receipt 순서를 지키며 engine/publish/wait/LLM을 그 락 안에서 실행하지 않는다. 검증 가능한 owner 정보 및 기존 플랫폼 lock 어댑터를 사용한다.
- 현재 runAtomicStepPublish와 AI atomicUnit에서 **게시 완료 뒤 입력 wait를 분리**한다. 엔진 변경+게시 receipt까지는 여전히 recoverable unit이다. loop 소유 AbortController/fetch가 relay wait-action을 직접 호출하고 pause 취소를 typed control_interrupted로 변환한다. relay는 response/socket close에서 waiter를 제거한다. 독립 publish CLI의 --wait는 보존한다. control interrupt를 모든 user/AI/rejected-user wait 경로에서 error/timeout보다 먼저 처리한다.
- gate 전 admitted decision/accepted receipt만 한 번 drain한다. 파이프라인의 publish 중복 방지·stateVersion 검사·action ack를 보존한다. 현재 admitted AI의 watchdog fallback은 같은 outcome으로 완료를 허용하고 다음 decision의 watchdog만 막는다. fetch abort 직전에 delivered가 된 액션의 응답 유실은 private wait-action 재호출로 같은 requestId/digest/payload를 회수하고 status+engine 대조로 해소한다. 기존 action-receipts deliver의 재전달 계약을 보존한다.
- coach/training/hint의 예약, heartbeat timer, consume/reclaim 경로를 조사해 pause gate를 통합한다. 진행 중 작업은 제한 시간 안에 settle/cancel 후 증거를 대조한다. paused 상태에서 새 session 작업이 시작되지 않게 하고 resume 때 중단된 예약을 기존 generation/idempotency 규약으로 이어간다.
- engine state/decision/config와 action-controller의 pending receipt는 pause로 초기화하지 않는다. resumePlay는 gate 열기 전에 engine step 동기화/view-only 게시를 수행해 최신 out을 parked run에 인계한다. 내부 relay 재기동도 명시된 managed protocol/epoch/경로 identity를 검증한 뒤 durable gate를 먼저 읽는다. managed 모드를 control 파일 존재 여부로 추측하지 않는다.

RED/GREEN: 가짜 clock과 barrier로 wait / user accept / delivered / AI resolve / engine commit / publish commit / new-hand / background consume 직전과 직후를 모두 pause시킨다. paused ACK 뒤 여러 scheduler tick과 delayed response를 진행해 engine/receipt/publication/session job 수가 불변임을 확인한다. resume은 동일 decision 또는 이미 적용된 다음 decision을 정확히 한 번 진행한다.

### T4. 사용자 종료와 미완료 핸드의 기록

파일: 수정 `engine/cli.js`, 필요한 engine mutation/아카이브 helper, `tools/game-loop.js`, `tools/session-control.js`, `tools/coach-control.js`; 신규 `test/session-abort.test.js`; 관련 `test/coach-control.test.js`, `test/training-async-pipeline.test.js`, 기존 종료/복구 및 학습 요약 테스트.

- `endGame({operationId})`가 paused→stopping에서 durable abort operation ID/intent를 기록하고 parked run을 terminal branch로 깨운다. private partial snapshot/audit 기록과 end mutation을 재실행 가능한 순서로 처리한다. 엔진의 일반 end CLI 호환성을 유지하면서 managed abort를 idempotent하게 지원한다.
- 미완료 hand는 완료 archive와 분리하고, completedHandCount/완료 핸드 순손익/새 평가·profile 분모에서 제외한다. 카드/스택·미정산 팟을 공개 요약에 raw 노출하지 않는다. 완료 핸드 원본 이벤트/평가는 보존한다.
- terminal publish 뒤 기존 loop cleanup을 완주한다. loop-state는 `phase=aborted`, `result=abort`, `endedAt`를 쓰고 done/finishedAt를 만들지 않는다. resolveForPhase/run/resume 및 bootstrap recovery에서 별도 ABORTED_PHASES와 durable abort intent 또는 engine.result=abort를 FINAL_PHASES/gameOver보다 먼저 처리한다. resume-check/rollback-guard(`tools/coach-control.js` 포함) 소비자도 업데이트하고 legacy abort가 정상 리뷰로 진입하지 않게 한다. CLI --resume의 GAME_ENDED/exit0, upper/player adapter 생성 0건, 명시 study open을 검증한다. 사용자 종료는 `ended/abort`, 자연 종료는 기존 finalization→review→done 증거를 요구한다.
- abort 중 crash, 중복 end, late child write, cleanup error는 동일 operation의 복구로 돌아가며 resumePlay는 금지한다. 중단 요약은 app에서 저장된 공개 DTO로 보여주어 relay 종료 뒤에도 볼 수 있게 한다.

RED/GREEN: post-blinds/all-in/side-pot 진행 중 abort, 마지막 완료 핸드 뒤 abort, 0핸드 abort, partial audit 기록 뒤 crash, abort mutation 뒤 crash, terminal publish 실패, 자식 종료 미확인. `test/coach-control.test.js`에는 aborted+abort를 UNKNOWN_PHASE/done으로 오분류하는 RED와 pending publish/action/coach/training/cleanup 오류가 있으면 여전히 rollback gate가 실패하는 RED를 추가한다. 이전 원본 event bytes 및 완료 핸드 집계는 보존하고 중단 팟으로 수익/손실을 확정하지 않음.

### T5. 장수 앱 서비스, 명령 journal, 인증된 중계

파일: 신규 `tools/app-service.js`, `tools/session-manager.js`, `tools/app-command-store.js`, `server/app-server.js`; 수정 필요 시 `engine/session-catalog.js`; 테스트 `test/app-service.test.js`, `test/app-command-store.test.js`, `test/session-manager.test.js`, `test/app-server-security.test.js`.

- store당 app.lock/descriptor와 authenticated health를 구현한다. 기존 `study-service`/platform identity 패턴을 재사용하며 별도 수명/토큰/락을 유지한다. manager는 T2 launcher/loop handle을 같은 Node 프로세스에서 소유한다.
- app-service entry는 umask 0077와 signal handlers를 한 번 설치한다. signal은 current loop.requestStop 및 app cleanup으로 전달하고 session 교체 시 핸들러를 교체/누적하지 않는다. N회 loop create/stop 뒤 listener count 불변을 `test/app-service.test.js`에서 검증한다. descriptor/journal은 store의 `.app/descriptor.json`, `.app/commands/`에 두며 신규 app.lock.d는 store root다; private permissions와 로그 비노출을 검증한다.
- 명령 접수→journal durable write→202와 작업 실행을 분리한다. requestId+canonical payload를 키로 하는 중복 조회를 revision CAS보다 먼저 한다. 새 명령은 expected instance/game/revision/selectionVersion을 검사하고 직렬 처리한다.
- terminal operationId는 requestId로 고정하고 복합 명령 하위 단계는 `SHA256(requestId + ':end')`, `SHA256(requestId + ':start')`로 구분한다. 최초 journal에 함께 저장하며 재기동/재시도에서 새 ID를 만들지 않는다. HTTP 요청 ID의 문자/길이 검증은 T1 schema가 소유한다.
- accepted journal 쓰기를 마친 뒤 store loop 락을 얻고 current 재검증 후에만 gameId/version을 예약한다. prepare→init→commit→bootstrap 단계, replace-current의 old terminal→cleanup→new 단계, resume/pause/end의 단계와 error/outcome을 journal에 기록한다. journal lock을 잡고 loop 락을 기다리지 않는다. 로비에 pending 명령이 있어도 HTTP GET/SSE가 응답해야 한다.
- crash recovery는 **해당 operation이 예약한 경로/identity와 current만** 대조한다. current commit 뒤 journal 갱신 전에 죽어도 같은 gameId를 찾는다. journal-only pending end/restart/replace-current는 startPaused 복구 후 같은 operationId로 확인받은 작업을 자동 완주한다. current 변경은 CURRENT_CHANGED로 확정하고 예약 audit를 보존한다. 결과 불명은 recovery_required이고 새 게임 생성으로 탈출하지 않는다.
- startPaused restore는 새 hand/AI/user admission 전에 gate를 설치한다. old app owner가 살아 있으면 새 service로 takeover하지 않는다. unknown identity/selector/command 손상은 fail closed. relay 유실은 기존 recoverServerForPublish/ownership 검증으로 복구한다. restart 락 해제→재획득 사이 외부 CLI 승리는 ACTIVE_GAME 실패로 처리하며 락 handoff를 추가하지 않는다. cleanup 실패 시 새 launcher 호출은 금지다.
- app routes와 method allowlist를 구현한다. fragment→sessionStorage→Authorization 인증; same origin/Host validation 및 body limit; fetch SSE와 instance/revision resync. 로그는 credentials/body/private file paths를 기록하지 않는다.
- game proxy는 current gameId와 epoch에 결박하고 private token을 서버에서 주입한다. publish/wait-action/임의 upstream은 거부한다. gameEpochOf(sessionToken) 결과를 비밀이 아닌 identity로 DTO에서 제공해 기존 receipt/localStorage 결박을 보존한다. 오래된 연결/응답/SSE가 바뀐 gameId의 UI에 적용되지 않게 한다. relay 종료 뒤 current의 검증된 published snapshot을 읽을 수 있도록 loadUiState/publicSnapshot reader를 추출하고 live snapshot과 같은 privacy 검증을 적용한다. terminal review/abort 요약의 reload와 service restart를 검증한다.
- study open은 검증된 ensureStudyService만 호출한다. app:stop은 현재 loop의 정리가 끝난 뒤 app 서버/락을 정리하고, 독립 study 종료를 자동 실행하지 않는다.

RED/GREEN: multi-tab start race, duplicate payload mismatch, 응답 유실 후 같은 requestId, app restart 후 재조회, 단계별 injected crash, relay-only orphan, current corrupt, disk full, same PID identity mismatch. 보안 반례는 잘못된 토큰/Origin/Host, traversal, internal API, old game, query token 전달, hidden card string, SSE cross-game event를 포함한다.

### T6. 로비, 테이블 transport, 일시정지 메뉴

파일: 신규 `server/public/lobby.js`, `server/public/session-menu.js`, `server/public/app-transport.js`, `server/public/lobby.html`; 수정 `server/public/app.js`, `server/public/action-controller.js`, `server/public/index.html`, `server/public/style.css`; 테스트 `test/lobby-controller.test.js`, `test/session-menu.test.js`, 기존 action-controller/table-controls 테스트.

- shell/router는 app-server의 같은 origin에서 lobby/table 상태를 렌더링한다. 기존 direct relay UI는 token adapter를 유지하고 managed 모드는 app transport를 주입한다. 설정·network·DOM 렌더러를 분리한다.
- 선택 필드와 요약은 T1 schema를 소비한다. capability unavailable·pending과 insufficient를 구분하며 preflight 실패 후 입력을 유지한다. 숫자 입력은 모바일/키보드로 조작할 수 있어야 한다.
- 클릭 즉시 메뉴는 열되 server paused ACK 전까지 버튼 상태는 pausing이다. action-controller는 별도 lifecycle lock을 합성해 조작을 막고 기존 pending receipt 저장/복구를 유지한다.
- modal 하나만 활성화하고 focus/aria-live/Escape/배경 단축키 차단을 구현한다. 새 게임 확인은 먼저 control state를 재검증하고 같은 requestId로 보낸다. 취소는 paused로 돌아온다.
- setup 탐색 중 `메뉴로 돌아가기`(paused 유지), `이어서 하기`, `선택한 설정으로 새 게임`을 구분한다. 메뉴 닫기/Escape 뒤 `일시정지됨 · 메뉴` 버튼으로 재진입한다. 학습실은 게임 모드 카드와 별도 영역이며 새 탭을 열고 현재 paused 게임을 보존한다. restart는 resolved original setup을 복제하고 새 session seed를 사용한다. 종료 후에도 `같은 설정으로 새 게임` 라벨을 통일한다. terminal review 생성 중/실패/완료와 abort 요약을 구분한다.
- 연결 유실 시 조작 차단→same instance snapshot/command status→필요한 action receipt reconcile 순서다. 페이지 재로드는 start/resume command를 자동 제출하지 않는다.

RED/GREEN: double click, stale response, app instance change, conflicting multi-tab operation, localStorage 실패, dialog 취소, 메뉴 뒤 fold shortcut, 모바일 360px, 지원 범위 메시지, LLM error 후 설정 보존.

### T7a. opt-in 앱 진입과 문서 준비

파일: `.agents/skills/start-game/SKILL.md`, `AGENTS.md`, `CLAUDE.md`(실제 파일/링크 확인 후), `README.md`, `ARCHITECTURE.md`, `package.json`; 테스트 신규 `test/start-game-lobby-contract.test.js`, 기존 `test/tempo-skill-contract.test.js`.

- `npm run app -- /absolute/store`와 `app:stop` entry를 추가한다. **이 명시 npm entry 자체가 opt-in**이다. T7a에서는 SKILL.md 기본 동작을 유지하며 로비 스킬 교체 문면/contract fixture만 준비한다. T8 뒤 T7b에서 node 버전/서비스 identity 확인→ensure app service→로비 open→보고로 기본을 바꾼다. 새 로비 경로에서 loop bootstrap/init을 자동 호출하지 않는다.
- 옵션은 server-validated prefill로 전달한다. 모델이 만든 임의 문장을 argv로 넣지 않는다. runtime 값만 host별 claude/codex/grok으로 정하고 파일/구조화 입력을 사용한다.
- T7b에 적용할 스킬의 active game 처리는 웹 이어하기/새 게임 선택으로 이동한다. 구 direct CLI loop가 살아 있으면 ownership 보존 및 legacy 안내, 명시 resume은 기존 semantics 유지. legacy가 자동 제어 지원으로 보이지 않게 한다.
- 앱 ready와 게임 started를 구분해서 보고한다. `로비를 열었습니다`가 `게임 시작 완료`가 되지 않는다. 완료는 여전히 done/finishedAt/review 증거다.

RED/GREEN: bare start에 current/session engine file/LLM process가 생기지 않음, 명시 옵션 prefill 보존, 기존 standalone command parsing 유지, managed active attach에서 추가 loop 없음, 호스트별 문면 일치.

### T8. 실제 제품 경로, CI, 구현 보고

파일: 신규 `test/browser/lobby-session-journey.mjs`, `test/helpers/lobby-session-fixtures.mjs`, `test/lobby-release.test.js`, `docs/implementation/lobby-session-validation.md`; 필요 시 `.github/workflows/test.yml`의 기존 지원 축에 필수 테스트 연결.

실행 계약: fixture는 기존 `test/helpers/learning-browser-fixture.mjs`의 productionDependencies/runOwnedCommand/hashTree 및 owned cleanup을 조합한다. 기존 learning-journey의 browserCliEnabled 패턴을 유지해 node --test의 파일 탐색이 실제 브라우저를 중복 기동하지 않게 한다. 신규 `test:lobby:browser` 스크립트는 `node test/browser/lobby-session-journey.mjs`이고, 실행 명령은 `npm run test:lobby:browser -- --out-dir <격리 결과 디렉터리>`다. requiredJourneyChecks는 `bare-lobby-no-init`, `mode-ai-selection`, `pause-resume`, `setup-back-no-resume`, `menu-close-reopen`, `restart-new-id`, `abort-summary`, `completed-review-reload`, `command-reconnect`, `study-paused-roundtrip`, `keyboard-mobile`, `real-user-store-unchanged`, `owned-cleanup`으로 고정한다. `test/lobby-release.test.js`가 목록/필수 결과 누락·실제 실행과 fixture-only 결과 혼동을 거부한다.

1. 격리 임시 store에서 app-service를 실행해 bare lobby→cash AI5→pause→resume→restart→mode tournament AI8→abort→study 여정을 완주한다. current/gameId·receipt·terminal·lock 증거를 browser action과 대응시킨다.
2. AI 1/5/8, policy/명시 LLM, 부족/충족 self 자격, startPaused recovery, 자연 종료 후 review overlay 및 relay cleanup 뒤 로비 지속을 검증한다. 정책 테스트에는 고정 seed, LLM 지연 경계에는 가짜 adapter를 사용한다. 실제 LLM smoke는 한 번의 시작/판단/정지를 별도로 측정한다. 통과 조건은 명시 LLM 보존·적격 실제 runtime의 응답으로 AI decision 1건 엔진/게시 반영(강제 기본 액션만으로는 미충족)·이어서 pause ACK 이후 상태 불변·end 및 자식 종료 확인이다. 지연은 기존 runtime watchdog/cleanup deadline 이내인지 기록하고 새 성능 목표를 지어내지 않는다. unavailable/timeout은 미실행 또는 실패로 보고하며 fake adapter로 실제 LLM 증거를 대체하지 않는다.
3. 노트북/실사용 store의 원본 상태·token·deck을 fixture로 복사하지 않는다. 자식/relay/study 정리는 테스트가 소유한 instance identity로만 한다. 끝에 orphan process와 남은 lock을 확인한다.
4. 관련 집중 테스트 통과 후 `npm run test:ci`, `npm run benchmark:policies`, `node tools/build-preflop-baseline.js --check`를 실행한다. 지원 Node 20/22 및 Windows CI가 terminal success인지 확인한다. **현재 `.github/workflows/test.yml`은 Windows 전체 suite를 건너뛰고 플랫폼 gate만 실행한다.** 신규 `test:lobby:windows`는 `node --test --test-concurrency=1 --test-timeout=900000 test/app-service.test.js test/app-command-store.test.js test/session-launcher.test.js test/session-control-race.test.js test/session-pause.test.js test/session-abort.test.js test/app-server-security.test.js`로 고정한다. 기존 Windows matrix에 `if: runner.os == 'Windows'`인 `Lobby lifecycle gates` step을 추가해 이 스크립트를 실행한다. `test/lobby-release.test.js`가 workflow/script 누락을 잡는다. 기존 Windows job의 초록색만으로 기능 검증을 대체하지 않는다. 전체 Windows suite 복원은 기존 이슈 범위이고 이번 기능의 필수 Windows 경계 검증은 생략하지 않는다. 현재 ESLint/Stryker는 미설치이므로 PASS로 기록하지 않는다.
5. 최종 diff와 최신 문서/HEAD를 고정해 model-router 독립 리뷰를 수행한다. HIGH+ 상태/보안 지적을 근거별로 처리하고 필요한 회귀 테스트만 재실행한다. 구현 중 범위가 커지면 재분류한다.
6. validation 문서에 실제 실행 명령·환경·성공/실패·미실행 항목·프로세스 정리·리뷰 수용/기각을 기록한다. 전체 통합/리뷰 완료 뒤 T7b에서 스킬 default를 전환하고 start-game-lobby-contract/tempo-skill-contract와 bare start smoke를 확인한다. 이 최종 문서 전환은 되돌릴 수 있지만 이미 생성한 control/runtime 데이터의 구버전 실행은 별도의 quiescent/roll-forward 계약을 따른다. PR/merge/배포는 이후 구현 요청의 승인 범위에 따른다.

T8 추가 필수 사례: 자연 종료/finalization과 pause 경쟁은 finalizing/completed가 이기고 paused를 만들지 않음; managed relay control 파일 삭제/손상과 lock 경합은 503, standalone relay는 기존 동작; accepted journal 뒤 외부 current 변경 시 동일 requestId가 CURRENT_CHANGED로 고정; paused 학습실 왕복은 resume command 0회이고 bare lobby의 study open은 engine init 0회. loop의 입력 wait는 기존 pinned server identity 검증으로 얻은 port/token을 사용하고, descriptor 값을 검증 없이 직접 사용하지 않는다.

## 3. 필수 경계 행렬

| ID | 정상 경로 | 반드시 막거나 복구해야 할 반례 |
|---|---|---|
| M1 | bare start→로비, explicit setup prefill | 자동 init/카드 배분/LLM probe, reload로 자동 start |
| M2 | cash/tournament × AI1..8 | AI0/9, incompatible flags, 수치 overflow, self 표본/좌석 부족 |
| M3 | user wait→pause→same decision resume | 무한 wait 때문에 pause 정체, pause를 폴드로 변환 |
| M4 | accept 전후 pause 선형화 | gate read/receipt write 사이 race, receipt 유실/중복 적용 |
| M5 | AI in-flight 하나 drain | late response 이중 반영, pause 뒤 watchdog fallback/new decision |
| M6 | step+publish 완료→pause | engine commit만 되고 publish 유실, publish retry 새 ID |
| M7 | hand boundary와 background 작업 drain | new hand/블라인드 증가/coach heartbeat가 paused 뒤 실행 |
| M8 | resume pending work 1회 | stale hint/coach/training generation 소비, 카드 재배분 |
| M9 | abort partial audit→terminal→cleanup | incomplete hand를 학습 완료/손익으로 계산, 이전 이벤트 삭제 |
| M10 | restart old ended→new gameId | old cleanup 전 새 init, 실패를 전체 rollback으로 오표시 |
| M11 | command duplicate 동일 결과 | multi-tab 동시 start, reply loss 후 2개 session, payload conflict |
| M12 | app crash→startPaused recovery | current commit/journal gap 중복 생성, 오류를 빈 로비로 위장 |
| M13 | app/loop/relay/study 별도 수명 | foreign PID kill, paused lock 해제, 게임 끝에 로비/study 사망 |
| M14 | 제한적 인증 중계와 epoch 경계 | internal publish/wait 노출, token/private state 누출, old SSE 새 게임 적용 |
| M15 | legacy CLI와 v1/v2 원본 보존 | 새 기본값을 resume에 주입, old binary가 pause 무시 |
| M16 | keyboard/mobile/end-to-end UI | modal 뒤 액션, optimistic started/paused, 오류 뒤 조작 허용 |

## 4. 변경·실행 범위와 구현 착수 조건

- 최초 checkout은 지정된 `turbot`이다. 착수 시 HEAD/작업 파일/문서 digest를 다시 고정하고 동시 사용자 변경을 보존한다.
- 로컬 문서만 변경하는 이번 단계에서는 전체 테스트를 실행하지 않는다. 위 명령은 구현 이후 gate다. 기존 제품/게임 프로세스는 시작·정지하지 않는다.
- 가장 위험한 변경은 T3의 publish/wait 분리와 T5의 인증 중계다. 각각 집중 회귀 증거가 없으면 로비 기본값을 켜지 않는다.
- 기능 flag/opt-in entry로 시작해 T8 완료 후 기본 진입을 바꾼다. 런타임 metadata를 만든 뒤 단순 git revert로 활성 게임을 되돌리지 않는다. 정지/정리 확인과 호환성 검증 또는 roll-forward를 사용한다.
- 구현자가 추가 제품 결정을 요청해야 하는 항목을 남기지 않는 것이 이 계획의 목표다. scheduling/락·file adapter의 구체 API는 기존 구현을 따라 선택하고 M3~M14로 증명한다. 검증이 안 된 안전성은 미완료로 기록한다.

리뷰 및 최종 구현 준비 판정은 [검토 기록](lobby-session-review.md)에 작성한다.
