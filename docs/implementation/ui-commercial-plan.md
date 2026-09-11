# UI 상품성 개선 구현 계획

날짜: 2026-09-11 · 설계 정본: [ui-commercial-design.md](ui-commercial-design.md).
이번 산출물은 구현 착수 전 계획이다. 아래 작업은 아직 실행하지 않았다.

## 1. 진행 순서와 변경 경계

`P1 데이터/포맷 계약 → P2 BB·탈락·팟 동작 → P3 공통 디자인·로비 → P4 테이블 반응형 → P5 읽기·접근성·종료 → P6 통합 검증/리뷰`.

각 단계는 별도 커밋 가능한 단위다. P3 토큰/로비 초안은 P1과 독립적으로 만들 수 있지만, 실제 동시 에이전트 작업은 구현 착수 시 별도 라우팅한다. P4는 P2/P3에 의존한다. P5는 P4의 DOM 구성을 사용한다. 중간 단계에서 새 기본 게임 동작이나 스킬 entrypoint를 바꾸지 않는다.

## 2. 단계별 작업

### P1 — 표시 계약과 공개 상태

대상: `engine/views.js`, 신규 `server/public/chip-format.js`, 신규 `server/public/seat-format.js`, `test/views.test.js`, 신규 `test/chip-format.test.js`, 신규 `test/seat-format.test.js`.

- publicSeat.out 및 view.handInProgress를 추가. handInProgress는 state.hand 존재와 engine state.phase==='in_hand'의 논리곱으로 legalFor의 idle 조건에 맞춘다. 기존 순서·공개 카드·state 저장 내용 보존.
- formatAmount(chips, bb, preference), formatSignedAmount, read/write preference, 순수 seatPresentation(view, seat)을 분리. 숫자 단위/유효성/미세 양·음수/근사 여부는 UI 재사용 가능한 결과로 돌려준다.
- preference I/O는 함수 호출 내부에서만 try/catch와 값 allowlist로 제한한다. 신규 순수 모듈은 최상위 DOM/localStorage 접근과 부작용이 없고 Node에서 import 가능해야 한다.
- seatPresentation은 out=true 우선, in-progress allIn/folded, unknown 분기를 명시한다. 완료 카드 공개 여부는 view.handNo와 일치하는 hand_start 그룹의 공개 showdown.reveals/mucks(기존 revealedCards 경로)와 view.myCards만 받으며 내부 holes 또는 replayReveal=all 카드를 인자로 받지 않는다. 소스 부재는 카드 없음이며 머크를 추론하지 않는다.
- 확인/회귀 경로는 `engine/cli.js` → `tools/publish.js`(buildBody) → `server/server.js`(publish, persistUiStateAtomic, loadUiState, publicSnapshot/SSE) → `tools/app-server.js`(live proxy/terminal snapshot) → `app.js`다. 현재 이 경로는 view 전체를 전달/저장/복원하며 view의 unknown field reject/필드 allowlist가 없다. 근거는 publish.js:166, server.js:586/775/801/1131과 app-server.js upstream 전달이다. 이 구조를 integration regression으로 고정하며 생산 코드를 불필요하게 바꾸지 않는다.
- viewFor 직접 호출은 `engine/cli.js`의 view/step, `engine/views.js`의 userView/turnSummary다. turnSummary는 명시 필드만 문자열화하며 새 필드를 넣지 않는다. `tools/player-runtime.js`, `tools/game-loop.js`, evaluator/coach/export 소비 경로도 검색하여 view 직렬화가 새 의미를 만들지 않는지 확인하고 기존 prompt/privacy tests를 실행한다. source→reload roundtrip과 현재 baseline reader의 unknown field 수용 테스트를 P2 선행 조건으로 둔다.
- producer→publish→persist→reload→app-proxy 전달에서 새 필드가 보존되는지 확인. 정확 view fixture는 실제 public projector를 사용하거나 명시 필드를 추가한다.

완료: 의미 있는 계약 단위 테스트 및 공개 view/기존 action 필드 회귀 통과. engine/hand.js의 베팅·정산 변경이 필요해지면 이번 UI 변경에서 분리하고 재설계한다.

### P2 — BB·탈락자·팟 표시

대상: `server/public/app.js`, `index.html`, 신규 `server/public/table-presentation.js`, 기존 `table-controls.js` 및 `test/table-ux.test.js`, `replay-format.js`(구조화 BB 문맥 연결이 필요할 때만), 신규 `test/table-presentation.test.js`, `test/replay-format.test.js`, 기존 UI 관련 테스트.

- 단위 선택기를 추가하고 paintTop/Seats/Pots/ActionBar/Replay의 금액 생성 경로를 공통 formatter로 연결한다.
- action input은 명시적 칩 입력, BB 미리보기. 신규 parseChipInput은 정수/정확한 쉼표 문법만 허용하며 빈 값·소수·부호·지수·잘못된 쉼표는 레이즈 제출을 차단한다. 입력 이벤트에서 비숫자를 삭제해 다른 금액으로 바꾸지 않는다. 오류일 때 Enter/버튼/blur도 이전 유효 금액을 제출하지 않으며 다른 합법 액션은 보존한다. 입력 모델에 pendingCorrection을 두고 clamp 변경 시 설정, 첫 명시 raise click에서 해제만/미제출, 사용자 편집·slider/preset/화살표·새 decision에서 해제한다. SSE/refocus/단위 전환/잠긴 receipt는 이 플래그를 소비하지 않는다. setBtnLabel은 금액 DOM만 갱신하고 버튼 이벤트·disabled·focus를 보존한다. 토글은 전체 paint 대신 표시 부분을 갱신한다.
- 참가자 탭, 남은 인원, 탈락 뱃지, 카드/애니메이션 규칙. 전체 seat 배열과 hero anchor 유지. snapshot 재연결은 baseline으로 받고 기존 탈락자를 신규 알림으로 재방송하지 않는다.
- aggregatePot(view)와 showPotBreakdown(view)를 순수 함수로 분리. 모든 raw pot 층의 합계를 보존하고 handInProgress=false인 완료 정산에만 세부 라벨 생성. 진행 중 eligible 0/1층도 합계에 포함하지만 응답 대기/반환액 의미를 부여하지 않는다.
- 로그는 hand_start 기반 hand context map을 만든다. 구버전/불완전 snapshot에 시작 이벤트가 없으면(현재 로그 자동 절단을 관측한 것은 아님) handReplay의 같은 handNo 블라인드만 보완 허용하고 둘 다 없으면 칩만 표시한다. 충돌하는 블라인드는 변환 중단.
- 복기의 분모는 formatReplay().header.blinds만 사용. 원본 기록/코치 텍스트/export에는 손대지 않는다.

완료: M1–M6의 formatter/상태/receipt 단위·통합 검증을 먼저 통과한다. 기존 test/table-ux.test.js에 입력 상태 모델의 blur/Enter/focus/paint/slider/preset/화살표 전이를 추가해 P6 이전에도 검증한다. 단위 토글 전후 action payload 동일, 실제 publish/reload에서 out 유지. M1–M6의 실제 DOM 조작까지 포함한 최종 승인은 P6 browser에서 확인한다. 기존 팟 raise-to 계산 수정은 불필요하며 회귀만 검증한다.

### P3 — 공통 토큰과 로비

대상: 신규 `server/public/design-tokens.css`, `lobby.html`, `lobby.css`, `lobby.js`, `index.html`, `style.css`, `server/drill-public/drill.html`, `drill.css`, `tools/drill-server.js` 정적 map, `tools/app-server.js`의 shared allowlist, `server/server.js`의 serveStatic 확인/회귀, `test/drill-server.test.js`, `test/app-server-security.test.js`.

- 색·서체·간격·radius·focus·버튼 공통 토큰 정의. 공유 design-tokens.css는 ASCII 바이트만 사용해 기존 서버의 charset 유무 차이에도 같은 내용으로 파싱한다. index.html의 Google Fonts 링크와 preconnect를 제거하고 시스템 한국어/숫자 폰트로 통일한다. 로비/테이블/학습실 CSS에서 선택자 충돌 없이 참조.
- 현재 로비 id/name과 form serialization·pending command 복구를 보존하면서 모드 카드/핵심 설정 요약/상세 설정 그룹을 구성한다.
- LLM 대기 설정은 LLM 선택 시 노출. 폼의 ms 값은 유지하고 초·분 helper를 제공한다. 숨긴 값도 사용자 선택을 덮어쓰지 않는다.
- 앱 서버 shared allowlist에 `game-setup.js`와 그 순수 의존성 `player-budget.js`만 추가한다. 두 모듈은 현재 Node 전용 import 없이 브라우저에서 읽을 수 있다. lobby.js는 기존 form→setup 조립을 공통 함수로 뽑고 `normalizeSetup` 결과를 설정 요약에 사용한다. 서버 검증은 계속 최종 권위다. 설정 요약의 BB는 선택한 mode/blinds/stack 입력과 동일한 validation 결과를 사용한다. invalid 상태를 정상 설정처럼 요약하지 않는다.
- relay는 `server/server.js:894` serveStatic의 PUBLIC_DIR 하위 정규화/경계 검사로 design-tokens.css와 신규 public JS를 기존 방식으로 제공한다(코드 변경 불필요). app는 안전 단일 파일명 규칙으로 public asset을 제공하고 shared 두 파일만 allowlist 추가한다. study만 STATIC map에 CSS route를 추가한다. 신규 asset이 relay/app/study 세 서버에서 올바른 content-type으로 제공되는지 확인. study STATIC map에 `/design-tokens.css` → `server/public/design-tokens.css`, `text/css; charset=utf-8` 항목 1개를 명시 추가한다. drill.html은 해당 URL을 link한다. 다른 public 파일은 노출하지 않는다. 외부 CSS/새 CDN 의존성 없음.

완료: 시작 command body 이전 계약 동일, cash/tournament/LLM/유리한 딜/힌트 설정 변경 요약 일치, 세 서비스 CSS 로드 성공, 기본 font fallback 읽기 가능.

### P4 — 게임 테이블과 반응형

대상: `style.css`, `index.html`, `app.js` 좌석 레이아웃, `lobby.css` iframe shell.

- 데스크톱 넓은 테이블 + 오른쪽 보조 패널, tablet 단일 열, 모바일 세로 테이블 배치를 도입한다.
- 좌석 presentation을 data-player-id 키로 유지해 뷰 갱신/단위 전환이 상세 버튼 focus를 잃지 않게 한다. 배치 함수는 seat 수 2–9, hero 회전만 입력받고 out 수로 재배치하지 않는다.
- 모바일 핵심 스택 12px 이상, 내 BB 18px 이상, 컨트롤 44px 이상. 긴 이름은 시각적으로 줄이되 전체 이름을 상세에서 제공한다.
- 앱 헤더와 iframe 높이의 실제 여유 공간을 사용. standalone/embedded 각각 지원. sticky action의 공간을 확보하고 키보드/모달/힌트가 보일 때 overlap 방지.
- 9인 모바일에서 보조 칩은 좌석 상세로 이동 가능하나 hero/pot/action 두 단위는 항상 노출한다. 시안 CSS의 고정 헤더 산술과 보조 단위 단순 숨김은 제품에 복사하지 않는다. 실제 계약은 설계 §3.2·§5.2의 대체 상세/실측 shell이다.

완료: M7 viewport×seat 검증·스크린샷, 현재 화면 대비 숫자/컨트롤 크기 측정. 시안과 다르게 조정해야 한다면 같은 정보 구조·최소 가독성 기준을 유지하고 변경 이유 기록.

### P5 — 읽기 지속성·접근성·종료

대상: `app.js`, `index.html`, `lobby.js`, 신규 `server/public/dialog-controller.js`, 관련 CSS, 신규 dialog/reading browser cases.

- 로그·코치 render를 키 기반으로 변경하거나 동일 데이터 갱신을 생략. 기존 이벤트 데이터에 ID가 없으면 snapshot 내부 append index를 사용하고 새 snapshot 교체에서 handNo+offset 읽기 anchor로 복원한다. 같은 이벤트를 내용만으로 dedupe하지 않는다.
- 새 이벤트 버튼, unread count의 실제 새 데이터 기준, 기존 training details/annotation 검증 유지.
- native dialog 또는 동등한 단일 dialog controller로 focus trap/restore/Escape/background inert를 통일. overlay CSS 변경 시 자동 review reopen/dismissed 규칙을 보존한다.
- 탭 방향키·Home/End와 aria 상태, focus-visible, 상태별 짧은 aria-live. 전체 로그 반복 낭독 제거.
- 종료 화면을 normal done/aborted/review pending/machine feedback별로 구분하되 새로운 엔진 상태를 만들지 않는다. 프런트엔드 메뉴가 pause/resume를 우회하지 않는다.

완료: M8–M10 browser journey, 기존 action-controller 및 reviewDismissalAfterUpdate 회귀 통과.

### P6 — 통합 검증과 최종 리뷰

대상: `test/browser/ui-presentation-journey.mjs` 신규, `test/browser/lobby-session-journey.mjs`, `test/browser-harness-contract.test.js`, `package.json`의 `test:ui:browser`, `.github/workflows/test.yml`에 별도 UI browser job 추가, 검증 보고서.

- 기존 `createBrowserWorkspace`, runOwnedCommand, app-service fixture를 사용해 실사용 `game`을 건드리지 않는 여정 구성. DOM/static mock 테스트와 실제 app/relay 여정을 구분한다.
- 신규 `test:ui:browser`에 assertion/check list/스크린샷/cleanup 결과를 남기고 누락된 required check로 성공하지 않도록 harness contract 검증. 일반 node --test에서는 .mjs browser CLI를 자동 실행하지 않는다. 기존 harness의 NODE_TEST_CONTEXT inert 계약을 유지한다. 신규 CLI도 browserCliEnabled를 export하고 해당 환경에서 BROWSER_CLI_DISABLED_UNDER_NODE_TEST_CONTEXT를 출력한 뒤 브라우저/fixture 없이 종료하도록 기존 contract test를 확장한다.
- CI는 기존 Linux/Windows suite를 유지하고 Ubuntu/Node 22의 별도 `UI browser` job(20분 상한)을 추가한다. `npx --yes agent-browser@0.36.0 install --with-deps`(현재 CLI help 확인)로 Chromium을 준비한 뒤 `npm run test:ui:browser -- --ci`를 실행한다. --ci는 390/1440px × 6/9인에서 M3/M4/M6/M8/M9의 실제 browser smoke와 asset 로드를 수행한다. 신규 shared allowlist asset/CSP도 확인한다. 나머지 M7 전체 폭·2/8인·키보드/긴 이름/큰 금액/확대 조합은 구현 완료 전 로컬 전체 모드로 실행하고 보고서에 첨부한다. 현재 lobby/learning harness가 모두 agent-browser@0.36.0을 사용함을 확인했다. 새 harness/설치 명령도 이 pin을 같이 사용한다. 의존성 설치(권한/apt 포함)·브라우저 기동 불가 또는 required check 누락은 job 실패이며 skip/무의존 설치 재시도로 PASS를 만들지 않는다. CI job 추가와 branch protection 필수-check 설정 변경은 구분하며 보호 규칙은 변경하지 않는다.
- focused tests → 기존 lobby/learning journey → `npm run test:ci` 순으로 수행한다. 의존성이 없는 ESLint/Stryker를 이 작업을 위해 새 설치하지 않는다.
- 지원 OS별 기존 CI를 유지하고 새 UI contract tests가 CI discovery에서 누락되지 않게 한다. 브라우저 자동화는 현재 저장소 도구 버전/실행 패턴을 재사용한다. Chromium 자동 테스트 + 실제 설치된 WebKit/Safari 가능 시 확인; 미실행 브라우저는 보고서에 표시한다.
- model-router로 최종 diff를 재분류하고 독립 리뷰. design review 결과를 code review로 대체하지 않는다. 통합 전 기능·접근성·공개 데이터 회귀 blocker 0 확인.

## 3. 검증 매트릭스

| ID | 실제로 입증할 것 | 테스트/증거 |
|---|---|---|
| M1 | 5000/50=100, 125/50=2.5, 1/200<0.01, 0, 음수, 1/3 근사, null/NaN/Infinity/unsafe 분모 | chip-format 단위 테스트 |
| M2 | BB=50 핸드 복기를 BB=100 현재 테이블에서 열어도 50으로 계산; hand_start→level_up이 포함된 두 핸드 로그도 각 분모 사용; 분모 없는 로그는 칩만 | replay/table-presentation + 브라우저 |
| M3 | 토글/갱신/입력 focus 동안 칩 입력·선택·decisionId·note 유지, POST body 칩 동일; 2.5/-5/1e3/1,2/빈 값은 변형 없이 오류, 레이즈 POST 0회; 오류 중 fold/check/call 합법 동작과 pending receipt 불변 | controller 연결 browser; min/max·short all-in·preset 포함; 오류 뒤 slider/preset/새 decision 해제, focus 밖 SSE는 오류 보존, Enter는 제출 0회; blur-clamp→첫 click 미제출→둘째 click 제출, 1,250/007 수용·전각 숫자 오류 |
| M4 | out=false·stack=0 올인 생존, out=true 탈락, fold 비탈락, 다중 동시 탈락, 다음 핸드 카드 없음 | engine 실제 정산 fixture→userView→publish→SSE→DOM |
| M5 | cash 남은 인원 숨김·중간 reset와 최종 스택 분리, 과거 allIn/D 배지 제거, 완료 비공개 뒷면 제거, 마지막 공개 쇼다운 보존, 미공개 상대 카드 없음 | cash/views/public/replay privacy 회귀 |
| M6 | 25/50 블라인드 합계75·사이드 라벨 없음, 진행 중 dead money를 포함한 0/1 eligible층도 합계만 표시, 완료 multi pot와 분배 합계 불변; A=800/B=500(fold)/C=300(all-in) 층을 반환액으로 표기하지 않음; 완료 view.pots 개수/합==lastHand 정산 기록, 완료 pots 부재/빈 배열은 정보 없음; 모든 street 합/불일치 회복 | pot presentation + real settle fixture |
| M7 | 2/6/8/9인×360/390/768/1024/1440px + 667px 높이, 긴 이름·큰 칩·힌트 ON·양 단위·200% 확대 | DOM bounding boxes/font size 및 screenshot 검토; 667px에서 sticky action과 hero 카드/좌석 겹침 0 및 액션 영역 요약 확인; 모든 조합의 핵심 겹침 assertion |
| M8 | 키보드 탭/모달·focus 복원·iframe 메뉴 inert와 paused 보존·Escape·단위 선택·좌석 상세 | browser activeElement assertion + 실제 키 조작 |
| M9 | 과거 로그 읽는 중 SSE, 열린 training details, review dismissed, 복기 선택·scroll 보존 | delayed publish/reconnect browser 여정 |
| M10 | pause/resume/restart/abort/study 왕복·unknown action 복구·종료 리뷰의 기존 계약 | 기존 lobby/learning journey 및 receipt 테스트 |
| M11 | 새 out/handInProgress persist/reload, terminal=1의 새/구 snapshot, old 필드 누락은 추측 안 함, storage 불가/다른 origin/invalid 취향값은 default, 재연결 탈락 알림 반복 없음 | relay/app integration + browser storage fault |
| M12 | 새 CSS/module 정상 serve·app CSP 준수, study는 지정 CSS 외 public 파일 비노출, standalone 외부 요청 0건, 대비·focus·reduced-motion·한국어 offline fallback | 세 서버 asset tests + 측정표 + browser |

기존 controller·금액 테스트는 `test/table-ux.test.js`다. 현재 `test/views.test.js`, `test/replay-format.test.js`, `test/cash-training.test.js`, `test/app-server-security.test.js`, `test/browser-harness-contract.test.js`가 존재하며 새 테스트는 위 이름으로 만든다. 검증 비용은 formatter의 단순 HTML 문자열 스냅샷보다 상태·금액·전송 계약에 집중한다.

## 4. 위험·중단점·복구

- 위험: public view field를 transport가 제거, BB 분모 혼용, stale allIn/out 우선순위, 좁은 화면 한계, iframe focus/height, 재렌더로 금액·읽기 상태 소실.
- 제어: P1/P2 계약을 먼저 확정, P4는 실제 9인 화면으로 판단, P6 데이터 privacy/receipt 회귀를 필수 gate로 둔다.
- 변경은 additive view + UI다. P1에는 현재 baseline reader가 추가 필드를 가진 snapshot을 읽는 역방향 호환 fixture와 turnSummary/플레이어 프롬프트의 기존 바이트 동일성 assertion을 둔다. M4는 탈락 좌석 bet/toAct 강조/카드 뒷면 0건, M5는 tournament 손익 항목 숨김, P2는 coach/리뷰/export 본문 미변경도 확인한다. 저장된 칩/state/history의 migration 없음. UI rollback은 해당 커밋을 역적용하고 추가 public 필드는 기존 consumer가 무시할 수 있다. hard reset/기록 삭제/구버전 policy 변환 없음.
- 로그 가상화, 전체 app.js 분해, 독립 학습실 정보 구조 재설계, 점수 체계, 실제 LLM 지연/모델 조정은 후속 후보다. 이번 UI 필요성 없이 범위를 넓히지 않는다.
- 최종 완료 증거는 소스 diff, 테스트 결과, 화면 비교, 접근성 측정, 독립 검토 및 수용/기각 로그다. 구현 준비 판정과 제품 출시 완료는 구분한다.
