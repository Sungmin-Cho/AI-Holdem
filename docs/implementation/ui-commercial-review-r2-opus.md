## 요약 판단

설계와 플랜 모두 대체로 실행 가능한 수준까지 구체화되어 있고, additive view 변경·rollback·privacy·CI 분리 같은 위험한 축을 명시적으로 다루고 있다. 다만 **공개 view만으로는 계산할 수 없는 팟 라벨 규칙 1건**, **P1/P3의 대상 파일 누락 2건**, **입력 오류 상태 수명 미정의 1건**이 착수 전 확정을 요구한다.

---

### 핵심 지적

**1) `응답 대기 베팅` 규칙이 사실과 어긋나고, 공개 view로 계산 불가 (blocker)**

`buildPots`(engine/sidepots.js:13-25)에서 층의 `amount`는 **폴드한 플레이어의 기여분까지 포함**한다. eligible이 1명인 최상위 층이 곧 "미응답/반환 예정 금액"이 아니다. 반례: A=800, B=500(폴드), C=300(올인). 층은 `{900, [A,C]}`, `{400,[A]}`, `{300,[A]}` → 뒤 둘이 병합되어 `{700,[A]}`. 이 700 중 200은 B의 dead money로 A가 **이미 확정적으로 이긴 돈**이고, 실제 uncalled 반환액은 300이다. 설계 §6.1대로면 700 전체를 "응답 대기"로 표시한다.

더 큰 문제는 정정 자체가 불가능하다는 점이다. `publicPots`는 `{amount, eligible}`만 내보내고(views.js:26-34), `publicSeat.bet`은 **현재 스트리트 베팅**일 뿐 누적 기여가 아니다(views.js:41). 즉 UI는 dead money와 uncalled 초과분을 분리할 정보를 갖고 있지 않다.

→ 둘 중 하나를 설계에서 확정할 것: (a) 1명 이하 eligible 층은 라벨을 붙이지 말고 `합계`에만 포함시키고, 확정 층(eligible ≥ 2)만 `메인/사이드 N`으로 표시한다, 또는 (b) 반환 가능액을 공개하려면 view에 명시 필드(예: `pendingUncalled`)를 추가하고 엔진 산식으로 계산한다 — 단 (b)는 §1의 "엔진 정산 변경 없음"과 P1의 "engine/hand.js 변경 시 분리" 조항을 트리거한다. `eligible.length === 0` 방어도 함께 명시할 것.

**2) P1 대상 파일에 전달 경로와 view 소비자가 빠져 있다 (blocker)**

설계 §4.1은 `producer → publish → ui-snapshot → snapshot/SSE → app proxy` 전 구간과 "allowlist·검증"을 언급하는데, 플랜 P1의 대상 목록은 `engine/views.js` + 신규 public 모듈 + 테스트뿐이다. 필드 allowlist가 존재한다면 `out`/`handInProgress`는 브라우저까지 도달하지 못하고, P2 전체가 빈 화면 위에서 돌아간다. 또한 `viewFor`는 user 전용이 아니라 **모든 좌석**에 쓰인다(views.js:48, `userView`는 래퍼). LLM 플레이어 프롬프트·코치·evaluator 페이로드·export가 같은 view를 직렬화한다면 프롬프트/스냅샷 골든이 깨진다.

→ P1에 (i) snapshot/publish/app-proxy의 실제 파일명과 allowlist 유무, (ii) `viewFor` 호출자 전수(플레이어 런타임 프롬프트 포함)와 각 소비자의 additive 내성 확인을 명시하고, 이 확인이 P2 착수의 선행 조건임을 못박을 것.

**3) standalone(relay) 서버가 P3 대상에 없다 (blocker for P3 완료 조건)**

P3 완료 조건은 "세 서비스 CSS 로드 성공"인데, 변경 대상으로 명시된 정적 경로는 `tools/app-server.js`의 shared allowlist와 `tools/drill-server.js` STATIC map뿐이다. relay 서버는 `server/public/*`를 자체 규칙으로 서빙하므로, `design-tokens.css`가 그 경로 규칙(파일명 정규식/맵)에 걸리는지 확인되지 않으면 standalone 테이블이 무토큰으로 렌더된다.

→ relay 서버 파일명을 P3 대상에 추가하고, 세 서버별 서빙 근거(정규식 통과 vs 맵 항목 추가)를 각각 기술할 것. 참고로 app-server 쪽 추가는 검증됨: 이름 정규식 `^[a-zA-Z0-9_.-]+$`(app-server.js:74)에 `game-setup.js`·`player-budget.js` 모두 통과하고, `game-setup.js`의 `./player-budget.js` 상대 import는 `/shared/player-budget.js`로 해석되어 allowlist와 일치한다. 두 모듈 모두 Node 전용 import가 없다.

**4) 레이즈 입력 오류 상태의 수명이 정의되지 않았다 (blocker, 소)**

새 규칙은 빈 값을 오류로 승격시킨다. 현재는 빈 값이 유효로 취급되고 blur 시 직전 `raiseTo`로 커밋된다(app.js:965-967, 408). 오류 상태에서 **slider 드래그 / preset 클릭 / 올인 버튼 / decisionId 교체 / SSE 재도장**이 각각 오류를 해제하고 필드를 덮어쓰는지가 어디에도 없다. 정의하지 않으면 "필드 비움 → 레이즈 영구 비활성"이 재현된다.

→ "프로그램적 금액 쓰기(slider/preset/allin/새 decision)는 필드 내용을 대체하고 오류를 해제한다. 사용자 타이핑만 오류를 생성한다. 비포커스 오류 상태는 재도장에서 보존된다(M3은 현재 포커스 중 보존만 규정)"를 §3.1에 추가. 또한 현재 Enter는 **커밋 전용이고 제출하지 않는다**(app.js:980-983). §3.1의 "Enter…제출하지 않는다" 문구가 신규 Enter-제출 도입을 뜻하는지 명시할 것 — 도입한다면 pending receipt/decisionId 계약을 함께 기술해야 한다. fold/check/call 보존은 `paintActionBar`가 `pendingAction`만으로 disabled를 결정하므로(app.js:445-449) 오류 상태를 거기에 섞지 않으면 자동 충족된다.

---

### 그 외 확정 필요

**5) `합계` 정의와 `legal.potTotal` 대조 실패 시 동작.** M6의 "25/50 합계 75"는 현재 스트리트 베팅을 포함한다는 뜻인데, 좌석 앞 bet 마커(app.js:354-361)도 동시에 그려지므로 사용자는 같은 칩을 두 번 읽을 수 있다. 그리고 `legal.potTotal`(hand.js:697)이 `publicPots` 합과 같은 정의인지 증거가 없고, `legal`은 내 차례에만 존재한다(views.js:67). → 라벨 문면("현재 베팅 포함 총액")을 확정하고, 불일치 시 동작(raw 합 우선, 사용자 노출 없음)을 §6.1에 적을 것. P1 테스트로 두 값의 동치를 고정할 것.

**6) rollback 방향의 호환성이 미검증.** "기존 consumer가 무시할 수 있다"는 주장인데, 검증기가 unknown 필드를 **거부**하는 구조면 롤백된 리더가 신규 스냅샷을 못 읽는다. → P1에서 "검증기는 unknown 필드를 무시한다"를 테스트로 고정하거나, 롤백 시 신규 스냅샷 처리 방침을 §4에 적을 것.

**7) 캐시 "다음 핸드 스택 복원" 안내 시점.** 엔진은 핸드 종료 즉시 스택을 리셋한다(hand.js:612-616). handInProgress=false 시점에는 **이미 복원이 끝난 숫자**가 좌석에 떠 있다. "복원 예정"으로 읽히는 문면은 오해를 만든다. → "표시 중인 스택은 이미 복원된 값이며 핸드 결과는 누적 손익/복기에서 읽는다"로 문면을 바꿀 것. `sessionNet`은 첫 핸드 종료 전에는 부재하므로(views.js:72) 그때의 표시(`0` vs 숨김)도 정할 것.

**8) 모바일 2–6인 레이아웃이 없다.** §5.2는 "명시적 2–9인"이라 선언하고 7–9인만 기술한다. M7은 2·6인을 검증한다. → P4 착수 전 2/3/4/5/6인 좌석 좌표 규칙을 표로 확정할 것(P4가 "seat 수 2–9만 입력받는 배치 함수"를 요구하므로 스펙 없이는 구현 불가).

**9) 667px 수용 기준이 반증 불가능.** §7은 "액션 가림 없음"만 말하고 세로 스크롤 허용 여부를 200% 확대에 한정한다. 9인·667px에서 헤더+문맥+테이블+히어로+액션이 무스크롤로 들어간다는 보장은 없다(시안도 ≤600px에서 table-space 493px를 쓴다). → "스크롤 없이 동시에 보여야 하는 것 = 히어로 좌석·팟·액션 바"로 합격선을 좁힐 것.

**10) 신규 browser CLI의 inert 계약.** `test/browser-harness-contract.test.js:11-21`은 `learning-journey.mjs`의 `browserCliEnabled` export와 `BROWSER_CLI_DISABLED_UNDER_NODE_TEST_CONTEXT` 표준출력을 직접 assert한다. 신규 `ui-presentation-journey.mjs`도 동일 export/센티넬을 제공해야 하며, 계약 테스트를 확장해야 한다. 플랜은 파일만 나열하고 이 요구를 적지 않았다.

**11) parent dialog가 열렸을 때 iframe 포커스 격리.** §6.3은 "parent native dialog 우선"만 말한다. native `dialog`의 포커스 트랩은 iframe 내부로의 Tab 이동을 막지 못하는 경우가 있다. → parent가 dialog 표시 중 iframe 요소에 `inert`를 적용하고 닫을 때 해제·복원한다는 문장을 추가할 것(M8의 assertion 대상에도 포함).

**12) 순수 모듈의 Node import 안전성.** `chip-format.js`가 preference I/O를 같은 파일에 담으면 **모듈 최상위 `localStorage` 접근**에서 Node 테스트가 ReferenceError로 죽는다. → "storage 접근은 함수 내부에서만, 최상위 부작용 0"을 P1 수용 조건에 명시(`table-presentation.js`의 DOM 접근도 동일).

**13) tabular-nums 폴백.** Google Fonts 제거 후 Windows 기본 한글 폰트(Malgun Gothic)는 `font-variant-numeric: tabular-nums`를 지원하지 않을 수 있어 숫자 폭이 흔들리고 M7의 겹침 측정이 플랫폼별로 갈린다. → 숫자 전용 라틴 폰트를 스택 앞에 두거나 열 폭 고정(min-width)을 대안으로 명시. 시안의 선두 `Inter`는 로컬 설치 여부로 렌더가 갈리므로 제품 스택에서 제외 여부를 정할 것.

**14) 산출물 경로.** `docs/implementation/`의 세 파일과 `output/`이 git status에서 `??`(무시가 아니라 미추적)로 나온다. 이 리포의 관례는 설계/플랜/스크린샷을 무시되는 경로에만 두는 것이다. → 보고서·스크린샷 저장 위치를 무시 경로로 지정하고 커밋 금지를 플랜 §4에 명시할 것.

### 확인되어 문제없는 항목

- 복기 분모: `lastHand.blinds` 우선(views.js:55-57)과 `formatReplay().header.blinds` 전용 사용은 "다음 레벨 분모 금지"와 일치한다.
- 로그 분모: `hand_start`가 `blinds`를 싣고(hand.js:290-295) `level_up`보다 **먼저** 방출되며 두 값이 동일하므로, hand_start 기준 그룹핑은 충돌하지 않는다.
- 생존 수 계산: `out`은 정산 후에만 true가 되므로(hand.js:620-626) "0칩 올인은 생존"이 엔진과 일관된다. cash는 `out`을 false로만 유지한다(hand.js:615).
- 공개 카드: `revealedCards()`가 `hand_start`마다 맵을 비우므로(app.js:136-139) "다음 핸드에서 사라진다"가 성립하고, hole 직접 접근은 없다.
- 단위 취향 localStorage: 앱 포트 랜덤화로 origin이 바뀌는 문제를 설계가 이미 명시적으로 포기 선언했다.

---

=== REVIEW ===
verdict: PASS_WITH_CHANGES
confidence: 0.74
findings:
- id: F1
  severity: high
  category: correctness
  evidence: design §6.1 "eligible이 1명인 최상위 층은 …응답 대기 베팅"; engine/sidepots.js:13-25; engine/views.js:26-34,41
  required_fix: 1명 이하 eligible 층은 폴드한 플레이어의 dead money를 포함하므로 반환 예정액과 동일하지 않고, publicPots({amount,eligible})와 publicSeat.bet(현재 스트리트 전용)만으로는 분리 불가하다. 라벨을 제거하고 합계에만 포함시키거나(권장), 반환 가능액을 표시하려면 엔진 산식으로 계산한 명시 필드를 view에 추가하도록 §6.1을 개정. eligible.length===0 방어 규칙도 추가.
  blocks_implementation: true
- id: F2
  severity: high
  category: source/persistence/reader compatibility
  evidence: plan §P1 대상 목록; design §4.1 전달 경로; engine/views.js:48 viewFor는 전 좌석 공용
  required_fix: P1 대상에 publish/ui-snapshot/SSE/app-proxy 실제 파일과 필드 allowlist·검증기 존재 여부를 명시하고, viewFor/userView 소비자 전수(LLM 플레이어 프롬프트·코치·evaluator·export)의 additive 내성 확인을 P2 선행 조건으로 못박을 것.
  blocks_implementation: true
- id: F3
  severity: high
  category: executable order
  evidence: plan §P3 대상 목록과 완료 조건("세 서비스 CSS 로드"); tools/drill-server.js:12-20 STATIC map 패턴
  required_fix: standalone relay 서버 파일을 P3 대상에 추가하고 design-tokens.css가 세 서버 각각에서 서빙되는 근거(맵 항목 추가 vs 기존 정규식 통과)를 개별 기술.
  blocks_implementation: true
- id: F4
  severity: high
  category: correctness/edge cases
  evidence: design §3.1 입력 UX 보완; plan §P2 parseChipInput; server/public/app.js:408,955-983
  required_fix: 오류 상태 수명 규정 추가 — slider/preset/올인/새 decisionId/프로그램적 쓰기는 필드를 대체하고 오류를 해제, 사용자 타이핑만 오류 생성, 비포커스 오류도 재도장에서 보존. Enter가 커밋 전용인지 신규 제출인지 확정(현재는 커밋 전용).
  blocks_implementation: true
- id: F5
  severity: medium
  category: correctness
  evidence: design §6.1 "legal.potTotal이 있으면 정합성 확인"; engine/hand.js:697; engine/views.js:60,67
  required_fix: 합계가 현재 스트리트 베팅을 포함함을 라벨 문면으로 확정(좌석 bet 마커와 이중 계수 방지), potTotal과 publicPots 합의 동치를 P1 테스트로 고정, 불일치 시 동작(raw 합 우선·사용자 경고 없음)을 명시.
  blocks_implementation: false
- id: F6
  severity: medium
  category: rollback
  evidence: plan §4 "추가 public 필드는 기존 consumer가 무시할 수 있다"
  required_fix: 검증기가 unknown 필드를 거부하지 않음을 P1 테스트로 고정하거나, 롤백 시 신규 스냅샷 처리 방침을 기술.
  blocks_implementation: false
- id: F7
  severity: medium
  category: correctness/UX
  evidence: design §4.2 "다음 핸드 스택 복원" 행; engine/hand.js:601-617
  required_fix: 리셋은 핸드 종료 시점에 이미 완료되므로 문면을 "표시 중 스택은 복원된 값, 결과는 누적 손익/복기에서 확인"으로 교정. sessionNet 부재(첫 핸드 전) 표시 규칙 추가.
  blocks_implementation: false
- id: F8
  severity: medium
  category: test adequacy
  evidence: test/browser-harness-contract.test.js:11-21; plan §P6
  required_fix: ui-presentation-journey.mjs가 browserCliEnabled export와 BROWSER_CLI_DISABLED_UNDER_NODE_TEST_CONTEXT 센티넬을 동일하게 제공하고 계약 테스트를 확장한다는 요구를 P6에 명시.
  blocks_implementation: false
- id: F9
  severity: medium
  category: layout feasibility
  evidence: design §7 "낮은 높이 667px"; plan M7
  required_fix: 667px·9인에서 무스크롤로 동시 가시해야 할 요소(히어로 좌석·팟·액션 바)로 합격선을 좁히고 그 외 세로 스크롤 허용을 명시.
  blocks_implementation: false
- id: F10
  severity: medium
  category: accessibility
  evidence: design §5.2 "명시적 2–9인 레이아웃"(7–9인만 기술); plan §P4 "seat 수 2–9만 입력받는 배치 함수"
  required_fix: 2/3/4/5/6인 모바일 좌석 배치 규칙을 P4 착수 전 표로 확정.
  blocks_implementation: true
- id: F11
  severity: low
  category: accessibility
  evidence: design §6.3 "parent native dialog가 우선"
  required_fix: parent dialog 표시 중 iframe 요소에 inert 적용·해제·포커스 복원을 명문화하고 M8 assertion에 포함.
  blocks_implementation: false
- id: F12
  severity: low
  category: correctness
  evidence: plan §P1 "preference I/O는 try/catch와 값 allowlist로 제한"
  required_fix: 최상위 localStorage/DOM 접근 금지(모듈 최상위 부작용 0)를 P1 수용 조건으로 추가 — Node 단위 테스트 import 가능성 보장.
  blocks_implementation: false
- id: F13
  severity: low
  category: layout
  evidence: design §5.1 "숫자는 tabular-nums"; preview font-family 선두 Inter
  required_fix: tabular-nums 미지원 한글 폰트(Windows)를 위한 폴백(숫자용 라틴 폰트 우선 또는 열 폭 고정)을 지정하고 제품 폰트 스택에서 Inter 사용 여부를 확정.
  blocks_implementation: false
- id: F14
  severity: low
  category: privacy/process
  evidence: git status의 `?? docs/implementation/*`, `?? output/`
  required_fix: 설계·플랜·검증 보고서·스크린샷 저장 위치를 무시되는 경로로 지정하고 커밋 금지를 플랜 §4에 명시.
  blocks_implementation: false
missing_tests:
- M6 확장 — 폴드한 플레이어의 기여가 2위 생존 기여를 초과하는 케이스(예: A=800, B=500 폴드, C=300 올인)에서 1-eligible 층 금액 ≠ uncalled 반환액임을 고정
- M3 확장 — 유효 `1,250` 수용, 선행 0(`007`), `1,2500`, 전각 숫자, 붙여넣기, 그리고 "오류 텍스트 상태에서 slider/preset/올인 클릭 시 오류 해제 + 필드 대체"
- M3 확장 — 비포커스 오류 상태가 SSE 재도장 후에도 보존되는지(현재 M3은 포커스 중 보존만 규정)
- 롤백 호환 — 구버전 리더/검증기가 out·handInProgress가 포함된 스냅샷을 거부하지 않음
- 취향 저장소 — `holdem.display-unit.v1`이 'bb'|'chips' 외 값이면 기본값으로 폴백(M11에 allowlist 케이스 명시)
- 탈락 announce — 재연결/스냅샷 baseline 수신 시 기존 탈락자의 알림이 재방송되지 않음(out=false→true 전이 1회)
- viewFor 소비자 회귀 — LLM 플레이어 프롬프트 페이로드/export 스키마가 신규 필드로 깨지지 않음
uncertainties:
- `potTotal(hand)`(engine/hand.js:697) 구현이 제시되지 않아 publicPots 합과 동일 정의인지 확인 불가
- publish/ui-snapshot/app-proxy의 필드 allowlist 존재 여부와 검증기의 unknown 필드 처리 정책이 제시된 증거에 없음
- standalone relay 서버의 정적 서빙 규칙(파일명 정규식 vs 명시 맵)이 제시되지 않아 design-tokens.css 서빙 가능 여부 미확인
- `writeAmountField`/`setBtnLabel`/`markAmountValid`/`formatChip` 구현이 제시되지 않아 포커스 중 필드 덮어쓰기 방지가 이미 존재하는지 미확인
- 좌석 초기화 시점의 `seat.out` 기본값 설정 코드가 제시되지 않음(undefined→Boolean(false)로 안전하다고 가정)
- 시안의 360/390px 무오버플로 보고는 주어진 전제로 수용했고 직접 측정하지 않음
