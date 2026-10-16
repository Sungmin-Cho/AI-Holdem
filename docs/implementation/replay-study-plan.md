# 리플레이 보관함 구현·검증 계획

작성: 2026-10-15 · 작성 모델: gpt-6-astra · 단계: 구현 전 설계·계획 (검토 결과는 replay-study-review.md 참조)

준비 상태: 조건부. 3차 PASS_WITH_CHANGES/PASS 이후 작성자 명확화가 포함되어 있으며 이 최종 수정본의 독립 재리뷰는 미실시다. 첫 구현 슬라이스에서 아래 잔여 gate를 검증하고 구현 diff 리뷰에 연결한다.

설계 정본: [replay-study-design.md](replay-study-design.md).
기준 코드: `b239dd72261070f8834ee36d3d7129f40f0fb546`.
이 단계는 설계·계획과 독립 리뷰까지다. 사용자가 요청한 구현 가능 단계 보고를 먼저 수행한다.

## 1. 착수 판단

기존 재생기·영구 세션·독립 학습 서비스가 있어 새 게임 엔진 없이 구현 가능하다. 구현 전 필요한 결정은 설계에서 정했다: 학습실 진입, 로컬 호스트 전용, 관리형 세션만 지원, 내 시점 기본, 공개 토글, 완료 핸드만 조회, 읽기 전용, 신규 답안/점수/북마크/시뮬레이션 제외.

설계의 주요 미해소 결함이 없고 독립 리뷰를 반영했을 때 “구현 착수 가능”으로 보고한다. 기능 완료/테스트 통과/배포 가능은 구현 후 별도 판정한다.

## 2. 순서와 완료 조건

### P0 — 계약/기준선 확인

- 현재 커밋과 clean/dirty 상태, 변경 파일, 알려진 schema/reveal/seat 규약 확인.
- `node --test test/hand-replay.test.js test/replay-model.test.js test/replay-format.test.js test/replay-facts.test.js test/replay-size.test.js test/session-catalog.test.js test/drill-server.test.js`를 최초 기준선으로 실행한다. 지금 설계 단계에서 실행한 결과가 있으면 검토 보고서에 별도 기록한다.
- 테스트 입력은 엔진 createGame/startHand/applyAction으로 완료한 임시 세션이다. 손으로 원하는 replay DTO만 만들고 실제 엔진 호환을 증명했다고 하지 않는다.
- 새 기능이 없어 실패하는 테스트는 관련 슬라이스에서 동작 RED 확인 후 구현한다. import missing만을 동작 RED 증거로 쓰지 않는다.

### P1 — 제한된 읽기와 공개 DTO

파일: 신규 `tools/replay-library.js`, 신규 `test/replay-library.test.js`.

- 세션 열거/페이지 읽기, 디렉터리/파일 확인, 완료 상한, archive/lastHand 읽기, seats/reveal 검증, 중첩까지 닫힌 DTO, 공개 DTO만 해시하는 revision. 숨긴 패/타인 note만 바뀌면 동일 revision, 공개 필드가 바뀌면 다른 revision을 검사한다.
- 공통 파일 helper를 약화하지 않고 openContained를 사용한다. reader는 prepare/commit/resume/rebuild/ensureSessionStore를 호출하지 않는다.
- 정상 두 세션+동일 handNo, current가 없는 기존 세션 목록, 진행 중 완료 핸드, abort, hand0, missing lastHand, missing archive fallback, corrupt archive no fallback, unknown version, legacy-only 상태. gameOver/result 조합 표에 캐시 완료·토너먼트 win/lose·중단·미종료·모순을 넣는다.
- symlink 조상/leaf, hardlink, 특수 파일, 읽는 중 교체, path traversal/encoded separator, unknown/hN seat kind, 다른 인간 private canary 및 유효한 AI 공개 양성 대조군. winner/decision/chosenAction/assistance 중첩 canary를 포함하고 설계 §5.4 표 밖 키가 출력 모든 깊이에서 0개인지 검사한다.
- engine writeHandArchive로 만든 1/9999/10000번 경로를 읽는 패리티, 세션 내 탈락/leaveEliminated/재접속 뒤 과거 좌석 이름·kind·ID 보존을 검사한다. user 탈락 뒤 hN이 살아 있는 핸드는 heroPosition=null/참여 안 함으로 정상 조회한다. startHand 이후에도 이전 lastHand 완료 상한이 보존됨을 실제 엔진 fixture로 확인한다.
- 페이지/항목/바이트/동시 처리 상한, 부분 실패 행, 파일마다 이벤트 루프 양보. yield를 보류한 대용량 목록 build 중 health가 먼저 완료됨과 실제 최대 파일 부하의 health 지연을 기존 플랫폼 HTTP_WAIT_MS 안에서 확인한다. 임의 큰 handNo 루프 금지.
- 완료: A1/A2/A3/A4의 reader 층을 실제 engine fixture와 원본 파일 해시 대조로 증명.

### P2 — 학습실 API와 정적 자원

파일: `tools/drill-server.js`, 신규 `test/replay-library-api.test.js`, `test/drill-server.test.js`.

- 세 GET route, 엄격한 query/path, 정식 오류 상태/문구, health capability 추가.
- 기존 auth/sameOrigin/beforeRequest/onActivity 이후만 reader 호출. 인증 거부에서는 reader spy 0회.
- loop/engine/LLM 시작 함수 호출 0, app·participant 토큰 거부, 알려지지 않은 method/path/query, no-store/referrer, 에러 원문/경로 누출 0.
- study STATIC에 새 replay 페이지와 재귀 import 의존성을 추가하고 app host/public 참가자 serveAsset, legacy relay serveStatic에서 공통 public JS/CSS 로드를 검증한다. 새 replay API는 study에만 제공한다.
- 기존 protocolVersion 1 service 정상 사용, replay capability 없는 service에서 **학습실 링크를 이동 전에** 안내/비활성으로 바꿈. 기존 drill.html/js는 새 정적 import/CSS를 추가하지 않는다. 구 handler + 새 디스크 drill.html/js 조합에서도 기존 드릴 정상, 모듈 404/uncaught 0, replay.html JSON 404로 이동하지 않음. 살아 있는 구버전 서비스 자동 종료 0.
- 완료: A1~A4를 실제 HTTP로 검증, `/api/summary`/drill 생성 경로를 새 페이지 초기화가 호출하지 않음.

### P3 — 표시 관점과 controller 추출

파일: 신규 `server/public/replay-controller.js`, `replay-perspective.js`; `replayer.js`, `replay-format.js`, `app.js`, 공통 replay CSS.
테스트: 신규 `test/replay-controller.test.js`, `test/replay-perspective.test.js`; 기존 replay/model/format/facts/table UX 테스트.

- 원본 모델은 불변. 사실 카드는 전체 검증 모델/replay로 계산 후 projection에서 시점만 제한하고 같은 결정의 두 관점 facts 줄/decisionId/seed 동일성을 검사한다. renderer에는 표시 DTO만 전달해 원본 replay 우회 접근을 제거한다. 타임라인은 step.index 키로 append/remove하고 포커스·스크롤 보존을 테스트한다. 전체 복기 기본값으로 기존 live 출력 유지.
- 가짜 시계로 타이머 하나, autoplay 정지/재개, 첫/끝, 속도, manual step, 각 user index-1 탐색, forced, no-user, dispose 후 callback을 검증한다. 최초 cursor=0이 user 직전이면 첫 재생이 그 결정을 통과함을 고정한다.
- 모든 단계에서 상대 카드/미래 보드/미래 액션/최종 winner/net/설명 canary가 내 시점 표시 DTO와 DOM에 없음을 검사. 이미 지난 공개 액션/내 패/현재 팟이 남는 양성 검사도 수행한다. 미래 행/전체 단계 분모/끝 버튼 부재 및 공개 prefix가 같고 미래 액션 수만 다른 두 핸드의 동일 커서 DOM·접근성 텍스트 동일성을 검사한다. 미래 user 결정 유무만 다른 쌍에서도 다음 버튼의 disabled 상태가 동일하고, 검색 후 결정 없으면 cap 이동/중립 안내가 나온다.
- 선택적 이유/메모/facts는 action 직전과 action 이후를 구분. 전체 모드 복귀/BB 단위 변경/핸드 전환의 상태 규칙 테스트.
- formatReplay의 feedback=omit에서 코치 대기/학습 카드/summary를 생성하지 않고, live 기본값에서 실제 연결을 유지한다. 보관함 두 관점 DOM에서 코치 대기 문구/학습 카드가 없다. user 미참여 핸드는 합성 좌석/홀카드/사실 카드 없이 정상 재생한다.
- 모델 실패 시 내 시점 raw 목록 노출 없음, 전체 복기에는 기존 텍스트 fallback. final cap은 fold/uncalled-return/all-in/runout/side-pot/split/muck 및 블라인드 올인으로 액션 없이 끝난 사례를 포함한다. return/runout은 cap 이전 순서대로 재생되며 showdown/result는 명시적 공개 전 숨긴다.
- 완료: A5/A6와 기존 라이브 복기 회귀. 공통 controller의 검증을 기존 live 호출 경로 연결 테스트로 보강한다.

### P4 — 보관함 화면

파일: 신규 `server/drill-public/replay.html`, `replay.js`, `replay.css`; `drill.html`/필요한 최소 링크 로직.
테스트: 신규 `test/replay-library-ui.test.js`(순수 컨트롤러/요청 상태), P5 브라우저.

- 게임·핸드 목록, offset/새로고침, empty/legacy/unavailable/limit/capability 안내, 기본 내 시점, 내 결정 버튼.
- fragment 토큰 왕복, token query 정리, 클릭 기반 탐색. 원본 게임 데이터·공개 상태의 localStorage 저장 없음.
- 선택 세대/AbortController로 A→B 요청 역전 폐기, handNo만으로 캐시하지 않음. 새 선택은 이전 모델/타이머 제거 후 로딩 화면.
- 목록 복귀 시 포커스 복원, mobile 390px, 9좌석, 빈 결정, 스크린리더 상태 알림.
- 완료: A1/A5/A6 UI 통합. 보관함 부수 효과가 없는지 A3를 다시 확인.

### P5 — 통합 여정과 문서

- 신규 `test/browser/replay-library-journey.mjs`를 기존 `journey-exit`/owned fixture 관례로 작성한다. 시나리오 필수 집합/누락 시 fail/자기검증을 유지한다.
- 전용 임시 store에 과거 2게임과 현재 진행 게임을 만든다. game relay 없이 학습 서비스만으로 기록 열기, 현재 게임과 공존, 학습실→보관함→다른 게임→내 결정→전체 복기→다른 핸드 초기화→학습실 복귀.
- 데스크톱 1280x900/모바일 390x844, keyboard, 2/9인, 토너먼트/캐시, multiplayer host privacy, 호스트 탈락 후 미참여 핸드, reload, 늦은 HTTP, asset 404/uncaught error, 구 handler+새 정적 파일의 기존 드릴 동작/capability missing 링크 gate, 손상 한 건의 부분 실패를 포함한다. 공통 controller/CSS 추출 후 참가자(hN)/관전자 페이지 로드와 기존 라이브 복기도 회귀 검증한다.
- 원본 selector/state/hands/loop-state/training 파일의 before/after 해시, loop/LLM 호출 없음, 서비스 수명 메타데이터 변화만 허용. 브라우저 테스트는 실제 사용자 `/Users/sungmin/Dev/AI-Holdem/game`를 쓰지 않는다.
- `README.md`, `README.ko.md`, `docs/operations.ko.md`의 실제 존재와 문맥을 확인해 진입/지원 범위/내 시점 의미/구버전 study 재기동 안내를 갱신한다. AGENTS/start-game 변경은 새 진입 사실을 적는 최소 변경만 필요 여부를 판단한다.

### P6 — 최종 검증과 구현 diff 독립 리뷰

- 신규·영향 테스트를 먼저 실행하고 통과 뒤 `npm run test:ci` 1회, replay 여정 및 기존 learning/UI 여정을 실행한다. 동일 전체 suite를 reviewer와 동시에 돌리지 않는다.
- ESLint/stryker는 현재 설치되지 않았다. 형식 검증은 `git diff --check`, JS syntax/관련 Node tests로 한다. 설치되지 않은 도구를 통과로 표시하거나 이 기능 때문에 임의 도입하지 않는다.
- Node 20/22 및 Windows는 현행 CI에서 확인한다. 로컬 macOS 결과를 그 플랫폼 검증으로 대신하지 않는다. 이 단계에 원격 CI 실행이 없으면 미검증으로 기록한다.
- Windows에는 활성 엔진 saveState와 보관함 목록/상세 반복 읽기를 겹쳐 rename 재시도 소진/저장 실패가 0인지 확인하는 회귀를 포함한다. 기존 파일 공유/권한 helper를 완화하지 않는다.
- 구현/검증 실패는 아래 model-router 절차로 수정하고 영향 테스트를 재실행한다. 마지막 수정 후 정확한 diff를 재리뷰한다.
- 완료 보고: 실제 검증 명령·결과, 미검증 플랫폼, 새 UX, 지원 범위, 남은 제한. PR/merge는 별도 요청 범위에 맞춘다.

## 3. model-router 실행·검증 루프

1. 위임마다 최신 사용 가능 모델을 확인하고 RouteRequestV1으로 분류한다. Grok/xai는 사용자 설정에 따라 제외한다. 이번 문서 작성은 호스트 inline 작업이며 라우터의 대상은 독립 리뷰다.
2. 문서 리뷰는 REVIEW c2/u1/b2/r1, reasoning_centric=true, auth_sensitive/security_sensitive/public_api_change로 HIGH. 제한된 읽기 API/두 화면 통합이며 저장 마이그레이션은 없다. HIGH 정책의 두 독립 좌석을 사용한다.
3. design+plan의 경로와 정확한 바이트를 해시한 target_sha256, 실제 작성 모델 gpt-6-astra를 review_context에 선언한다. dispatch_seats만 실행하고 작성자를 제외한다. 각 좌석은 서로의 결과를 받지 않는다.
4. subprocess 좌석은 dispatch_agent.py의 시간 제한/종료 확인/출력 계약을 사용한다. macOS에서는 receipt guard를 적용한다. Codex nested sandbox 리뷰는 파일 접근 없는 고정 소스 packet을 사용하고 그 제한을 명시한다. 검증 영수증과 원본 packet은 별도 로컬 산출물, 요약·해시·판정은 검토 문서에 남긴다.
5. 작업 트리를 리뷰 중 동결한다. 근거를 확인하여 findings를 수용/부분 수용/기각하고 이유를 기록한다. 수정 후 새 해시로 재리뷰, 최대 3라운드. 구현으로 확인해야 하는 항목은 해당 P/A gate로 이월하고 문서 통과로 덮지 않는다.
6. 구현 착수 후에는 각 P 슬라이스의 실제 risk/uncertainty를 재분류한다. reader/API는 최소 HIGH, 표시/순수 controller도 실제 영향에 따라 라우팅한다. 실제 구현자 ID를 implementer에 선언하여 재리뷰한다. 사전에 모든 구현 좌석을 한 모델로 고정하지 않는다.
7. 실패/무응답/종료 미확인은 PASS가 아니다. 모델 해석 실패는 unavailable로 재라우팅한다. 알고리즘 실패는 실제 prior_model 및 실패 횟수로 승격한다. 검증 조건을 낮춰 통과시키지 않는다.

## 4. 중단·롤백

권한 밖 카드/메모 노출, 잘못된 핸드 혼합, 원본 게임/학습 데이터 변경, live 회귀는 구현 완료를 막는다. 불완전 기록은 복구를 자동 시도하지 않고 unavailable로 남긴다.

저장 스키마/게임 엔진을 바꾸지 않으므로 rollback은 신규 화면/링크/API 및 공통 UI 변경을 되돌리는 코드 rollback이다. 실제 저장 게임을 과거 버전으로 변환하지 않는다. 이미 실행 중인 학습 서비스의 코드 전환은 공식 stop/start 절차로 검증한다.

## 4.1 최종 리뷰에서 구체화한 구현 gate

- P1: 정상 saveState atomic rename과 reader 교체 검사 경합을 주입한다. 거부된 바이트 반환 0, 안전한 leaf 교체가 관측되면 REPLAY_BUSY/명시 재시도, 링크/특수 파일은 unavailable 거부 유지. POSIX 실제 저장 반복과 읽기도 겹쳐 영구 손상으로 캐시하지 않음을 확인한다. 핸드 페이지 총 읽기 32 MiB 상한을 검사한다.
- P1/P3: user decisions 항목 수/순서를 보존하고 무효 optional 필드만 생략, 초과 reason/note만 생략. 유효 입력은 live facts 패리티, 무효 decisionId 입력은 보관함 두 관점 동일성/fallback을 검사한다. 현재 엔진의 160자/바이트 상한을 확인한 정상 최대 입력도 포함한다.
- P2/P5: createDrillHandler의 privileged 구성 주입 seam(static asset map 및 replay capability/route enable 설정)으로 구 handler 계약+새 디스크 drill.html/js를 재현한다. HTTP 사용자가 이 옵션을 바꿀 수 없고 기본은 정규 서버 계약이다. ensure 재호출이 구 service를 재사용함을 확인하고 안내가 공식 stop→열기 절차를 지칭하는지 검사한다. fixture용 Git history 조회나 작업 트리 파일 교체는 사용하지 않는다.
- P2/P5: app/relay 공통 클라이언트의 shared import 폐포는 기준 allowlist 안, 기존 drill import 폐포는 불변, 새 보관함만 새 study STATIC을 사용함을 세 서버별 import 그래프로 검사한다.
- P3: 설계 관점 전이 표의 커서/정지/cache 유지/컨트롤 교체/focus 복구, cap 재생 비활성, 전체 끝 재생 초기화를 fake clock/DOM으로 검사한다.
- P3: 표시 projection 표 밖 필드 0, header 최종 board/winners 제거, 상대 reasonKind/정책 범례·태그 제거. 미래에만 정책 AI가 행동하는 쌍의 prefix DOM 동일성. 공개 현재 팟/보드와 결과의 같은 숫자를 오탐하지 않고 고유 handName/미공개 카드 등으로 음성 대조군을 만든다.
- P4/P5: visible 페이지 heartbeat 및 pagehide 중단, 짧은 fixture idle 예산, 토큰 만료/재연결, 게임·드릴 생성 0. 실제 운영 주기 값은 현재 study-service idle 계약을 확인한 뒤 코드에 고정한다.

이 항목들은 3차 리뷰 후 명확화한 최종 문면이며 독립 재리뷰 통과로 표기하지 않는다. 구현 중 계약 결함이 드러나면 해당 슬라이스를 멈추고 설계를 수정한 뒤 새 구현 리뷰 라우트로 판단한다.

## 5. 구현 전 보고와 남은 검증

문서 리뷰 완료 뒤 설계/계획/검토 문서를 링크하고, 브랜치와 “구현 착수 가능/미해소 사항 있음”을 보고한다. 현재 단계의 테스트는 기존 기반 검증이며 A1~A8 신기능 인수가 아니다. 사용자가 요청한 이 중간 보고를 마친 다음 구현 단계로 이어간다.
