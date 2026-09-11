=== REVIEW ===
verdict: PASS_WITH_CHANGES
confidence: 0.8

**검증 요약(결함 아님, 근거 확인)**
- 공개 view 전달 경로에 필드 allowlist가 없어 additive 필드가 그대로 살아남는다: `engine/cli.js:324`(viewFor) → `tools/publish.js:166-167`(envelope.view 그대로) → `server/server.js:1130-1132`(body.view 저장) → `server/server.js:797-812`(persist) → `server/server.js:586`(reload) → `tools/app-server.js:228-237`(프록시 그대로). view를 읽는 검증기는 `publish-contract.js:214-218`(legal.decisionId만)과 `tools/hint-proof.js:78`(legal.decisionId/toAct만)뿐이라 `out`/`handInProgress` 추가는 안전하다. 설계 §4.1의 "allowlist·검증"은 view에는 존재하지 않으므로 과장된 문장이지만 해가 없다.
- 팟 분해 의미론: `engine/hand.js:732`가 액션마다 contribs를 갱신하고 `engine/sidepots.js:3-30`이 같은 eligible 집합의 층을 병합하므로, 진행 중 `sum(view.pots) == legal.potTotal`이 항상 성립하고, 정산 팟이 2개 이상이면 실제 올인 캡이 있었다는 설계 §6.1의 전제가 맞다. 25/50 → 50/25 분리 관측(`engine/views.js:26-34`, `app.js:242-250`)도 정확하다.
- 탈락/리셋 경계: `engine/hand.js:601-617`(cash는 stack·out 리셋, handLimit 도달 시 리셋 없이 gameOver), `619-626`(tournament만 out=true+bust 이벤트). `isLive`(`hand.js:150-152`)가 out을 제외해 다음 핸드 folded 목록에 안 들어가므로 현재 `app.js:300-305`의 뒷면 카드 규칙이 탈락자에게 카드를 그린다는 §2 관측이 정확하다. `handInProgress=false`일 때 view.folded/allIn이 lastHand에서 오는 것(`views.js:9-24`)도 설계 §4.2가 올바로 다룬다.
- BB 분모: idle 상태 `view.blinds`는 lastHand.blinds(`views.js:55-57`), `hand_start`에 blinds 포함(`hand.js:290-293`), replay는 record.blinds(`shared/hand-replay.js:86`, `replay-format.js:158`). 설계 §3.1 표와 일치한다.
- 테스트 발견: `test/helpers/ci-shards.mjs:23,33`이 미지정 `.test.js`를 자동으로 `rest` 샤드에 넣으므로 새 단위 테스트는 Windows 샤드에서 누락되지 않는다. 플랜이 인용한 `createBrowserWorkspace`/`runOwnedCommand`는 `test/helpers/learning-browser-fixture.mjs`에 실재하고 `test/browser-harness-contract.test.js:8`이 쓴다.

findings:

- id: F1
  severity: medium
  category: architecture-fit / path-accuracy
  description: 플랜 P3가 학습실 정적 asset 경로를 `server/drill-server.js`로 지정했으나 그 파일은 없다. 실제 학습 서버는 `tools/drill-server.js`이고, 정적 파일은 디렉터리 노출이 아니라 명시 route map으로만 제공된다. 설계가 요구하는 "design-tokens.css 1개만 명시 허용"은 이 map에 항목을 추가해야만 성립하며, 잘못된 파일명은 구현자가 존재하지 않는 파일을 찾게 만든다.
  evidence: `docs/implementation/ui-commercial-plan.md:41`("필요 시 `server/drill-server.js`"); 실재 파일 `tools/drill-server.js:13-17`(route map: `/drill.css`→`server/drill-public/drill.css` 등, `server/public/*` 항목 없음); `ls server` 결과에 drill-server.js 없음.
  required_fix: P3 대상 파일을 `tools/drill-server.js`로 정정하고, "`/design-tokens.css` → `server/public/design-tokens.css`, `text/css; charset=utf-8`" 한 항목을 route map에 추가하는 것을 명시 작업으로 적는다. `server/drill-public/drill.html`의 `<link>` 추가도 같은 항목에 묶는다. M12의 "세 서버 asset tests"에 study 서버의 이 단일 route와 그 외 `server/public/*` 비노출을 함께 검증하도록 적는다.
  blocks_implementation: no

- id: F2
  severity: medium
  category: correctness / plan-gap
  description: P3 "설정 요약의 BB는 선택한 mode/blinds/stack 입력과 동일한 validation 결과를 사용한다"는 구현 근거가 없다. 검증기는 `shared/game-setup.js`(`normalizeSetup`, `setupError`)에 있지만 앱 서버의 `/shared/` allowlist는 5개 파일만 내보내며 `game-setup.js`는 없다. 로비 JS에는 클라이언트 검증기가 전혀 없다. 이대로면 구현자가 별도 규칙을 복제해 서버 검증과 어긋난 요약(invalid를 정상처럼)을 만들 수 있다.
  evidence: `tools/app-server.js:78-90`(shared allowlist: reference.js, reference-coverage.js, preflop-key.js, assistance.js, deal-selection.js); `shared/game-setup.js:21-53`(setupError/normalizeSetup); `server/public/lobby.js:222-263`(onchange/onsubmit에 검증 없음, 서버 INVALID_SETUP 메시지만 표시 `127-128`).
  required_fix: 플랜에 결정 하나를 적는다 — (a) `game-setup.js`를 `/shared/` allowlist에 추가하고 로비에서 `normalizeSetup`을 import해 요약을 만든다(브라우저에서 import 가능한 순수 모듈인지 확인 조건 포함), 또는 (b) 요약은 "표시용 산술(blinds[1]로 나눈 값)"에 한정하고 invalid 여부는 서버 INVALID_SETUP 응답을 따른다고 범위를 낮춘다. 어느 쪽이든 P3 완료 조건 "설정 변경 요약 일치"에 그 결정을 반영한다.
  blocks_implementation: no

- id: F3
  severity: low
  category: correctness / edge-case
  description: 설계 §4.1은 "모든 좌석 out이 boolean일 때만 `남은 인원 N / 전체 M`"을 표시한다고 하지만 cash-training에서는 out이 항상 false로 리셋되므로 항상 "남은 인원 6 / 6"이 표시된다. 같은 화면의 "다음 핸드 스택 복원" 안내와 나란히 놓이면 탈락 개념이 있는 것처럼 읽힌다.
  evidence: `engine/hand.js:613-616`(cash: 매 핸드 `seat.out = false`); `docs/implementation/ui-commercial-design.md:62,93`.
  required_fix: 남은 인원 표기를 `view.mode !== 'cash-training'`(토너먼트) 조건에 한정하고, M4/M5 검증에 "cash view에서 남은 인원 항목 미표시"를 추가한다.
  blocks_implementation: no

- id: F4
  severity: low
  category: correctness / consistency
  description: 완료 핸드(handInProgress=false)에서 폴드하지도 공개하지도 않은 좌석의 카드 뒷면 처리가 설계에 없다. 현재는 `view.street`가 lastHand 값이라 뒷면이 계속 그려진다. 설계는 out 좌석에는 뒷면 금지, 이전 allIn/folded 뱃지 제거만 정하고 있어 구현자가 "완료 핸드 뒷면 전부 제거"와 "기존 유지" 중 임의로 고를 수 있다.
  evidence: `server/public/app.js:300-305`(`!seat.folded && view.street`), `engine/views.js:13`(idle에서도 street 비null); `docs/implementation/ui-commercial-design.md:72-75`.
  required_fix: §4.2 표에 "핸드 종료·out=false·비공개: 기존 뒷면 유지(핸드에 참여했다는 사실 표시)" 또는 "제거" 중 하나를 명시하고 M5에 그 케이스를 넣는다.
  blocks_implementation: no

- id: F5
  severity: low
  category: privacy / consistency
  description: `index.html`이 Google Fonts를 preconnect·link로 로드한다. 앱 호스팅 iframe에서는 CSP(`style-src 'self' 'unsafe-inline'`, font-src 없음)로 차단되고, standalone 릴레이에서는 외부 요청이 나간다. 설계는 "기존 한국어/시스템 fallback"만 쓰고 플랜은 "외부 CSS/새 CDN 의존성 없음"이라 하지만, P3의 index.html 작업 항목에 이 링크 제거가 없다. 남겨두면 두 모드의 타이포가 달라지고 M12 "한국어 offline fallback" 측정이 한 모드만 대표한다.
  evidence: `server/public/index.html:7-11`; `tools/app-server.js:57-60`(CSP); `docs/implementation/ui-commercial-plan.md:43,47`.
  required_fix: P3에 "index.html의 fonts.googleapis preconnect/link 제거, `--f-ui/--f-num` 스택을 시스템 폰트로 정리"를 명시하고, M12에 standalone 릴레이에서 외부 요청 0건 assertion을 추가한다.
  blocks_implementation: no

- id: F6
  severity: low
  category: verification-credibility
  description: M7–M9의 브라우저 증거가 CI에 들어가는지 로컬 보고서로만 남는지 플랜이 정하지 않았다. 현재 `test.yml`은 `npm run test:ci`/Windows 샤드만 실행하고 `test:lobby:browser`는 CI에 없다. 브라우저 여정은 `agent-browser@0.36.0`을 spawn하는 방식이라 `.mjs` 여정 자체는 `node --test`가 발견하지 못하며, `.test.js` 래퍼(예: `browser-harness-contract.test.js`)를 통해야만 CI에 들어간다. "필요 시 기존 gate에 최소 통합"은 결정이 아니다.
  evidence: `.github/workflows/test.yml:44,67-69,113-116`(browser 항목 없음); `package.json` scripts(`test:lobby:browser`만, `test:ui:browser` 없음); `test/browser/lobby-session-journey.mjs:42-47`(agent-browser); `docs/implementation/ui-commercial-plan.md:77-82`.
  required_fix: P6에 "M7 뷰포트×좌석 매트릭스 중 어떤 부분집합을 `.test.js` 래퍼로 CI에 넣고(예: 390/1440 × 6/9인), 나머지는 검증 보고서 첨부"라고 확정한다. `test:ui:browser`가 새 스크립트임을 명시한다.
  blocks_implementation: no

- id: F7
  severity: low
  category: correctness / claim-accuracy
  description: 설계 §3.1 "세션이 달라도 표시 취향만 재사용"은 localStorage가 origin 단위라는 전제에 기대는데, 앱 서버는 `port = 0`(임시 포트)으로 시작하도록 되어 있어 기동마다 origin이 바뀌면 취향이 유지되지 않는다(기본값으로 조용히 복귀하므로 오동작은 아니다). standalone 릴레이(8877)와 앱 origin 사이에서도 공유되지 않는다.
  evidence: `tools/app-server.js:40,291-293`; `server/server.js:820`(릴레이 기본 8877); `docs/implementation/ui-commercial-design.md:36`.
  required_fix: 앱 서비스가 포트를 고정하는지 확인해 문장을 "같은 origin에서 재사용"으로 한정하거나, 포트가 유동이면 지속 보장을 약속하지 않는다고 적는다. M11 "storage 불가 default"에 origin 변경 케이스를 한 줄 추가한다.
  blocks_implementation: no

- id: F8
  severity: low
  category: preview-divergence (비계약 산출물)
  description: 시안이 설계와 어긋나는 지점 두 곳. (1) `header{height:76px}` + `.game-shell{min-height:calc(100dvh - 112px)}`로 헤더 실측 대신 고정 산술을 쓰는데 설계 §5.2는 이를 금지한다. (2) 모바일에서 비-hero 좌석의 보조 단위(`.seat small`)를 `display:none`으로 숨기지만 §3.2가 요구하는 키보드/터치 대체 경로(좌석 상세)가 시안에 없다. 시안은 방향 예시라 결함은 아니지만, 구현자가 시안 CSS를 복사하면 계약 위반이 된다.
  evidence: `docs/implementation/ui-commercial-preview.html:4`(header 76px, game-shell 계산), `:5`(`.seat small{display:none}`); `docs/implementation/ui-commercial-design.md:54,100`.
  required_fix: 설계 문서의 시안 링크 옆 또는 플랜 P4에 "시안 CSS의 헤더 고정 산술과 보조 단위 숨김은 복사 금지, 계약은 §3.2·§5.2"를 한 줄 명시한다.
  blocks_implementation: no

missing_tests:
- 레벨 업 경계의 로그 분모: 핸드 N(50/100)과 N+1(100/200)이 같은 로그에 있을 때 각 그룹이 자기 hand_start/level_up 분모를 쓰는지(M2는 복기만 다룸). `level_up` 이벤트(`engine/hand.js:297`)를 포함한 fixture 필요.
- cash-training에서 "남은 인원" 미표시(F3).
- 완료 핸드에서 out 좌석에 딜러 버튼이 남는 경우(`views.js:44`는 state.button 기준이라 방금 탈락한 좌석이 D를 가질 수 있음)의 표현 결정과 회귀.
- standalone 릴레이에서 외부 네트워크 요청 0건(F5) 및 앱 CSP 하 새 CSS/모듈 로드 성공.
- `terminal=1` 기록 보기 경로(`app.js:1096-1098`)에서 새 필드 유무 양쪽 렌더(구 완료 게임 = 필드 없음 → 참가자 탭 unknown 표현).
- 학습 서버 `/design-tokens.css` 단일 route 제공과 `server/public/` 다른 파일 비노출(F1).

uncertainties:
- `agent-browser@0.36.0`이 Tab/Escape/Arrow 키 입력을 지원하는지 확인하지 못했다. 지원하지 않으면 M8 "실제 키 조작"은 `eval`로 KeyboardEvent를 dispatch하는 방식이 되고, 그 방식은 네이티브 Tab 포커스 이동을 재현하지 못한다.
- 앱 서비스(`tools/app-service.js`)가 앱 서버 포트를 고정하는지 읽지 않았다(F7의 전제).
- `shared/game-setup.js`가 Node 전용 import 없이 브라우저에서 import 가능한지 확인하지 않았다(F2의 선택지 a 조건).
- 플랜 P2가 전제한 "snapshot truncation으로 hand_start 없음" 사례를 코드에서 찾지 못했다. `server/server.js`에는 handReplays trim(`171`)만 있고 log trim은 없다. 방어 코드로 두는 것은 무해하나 관측된 사례로 기술하면 안 된다.
