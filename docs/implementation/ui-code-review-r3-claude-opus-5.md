verdict: PASS_WITH_CHANGES

confidence: medium-high (정적 검사 기준). 소스·CSS·테스트·CI 배선을 직접 읽고 설계/플랜 수용 기준과 대조했다. 다만 이 좌석은 읽기 전용이라 테스트·브라우저를 실행하지 않았고, 렌더 결과의 실측(대비·픽셀 겹침·컨테이너 쿼리 적용)은 코드 추론과 과제 진술에 의존한다.

## 확인한 것 (검사로 뒷받침되는 부분)

- **BB 환산의 수치 정확성**: `server/public/chip-format.js:9-18`은 BigInt 정수 연산으로 반올림(half-up)과 `≈`(나머지≠0), `<0.01`(반올림 전 판정), 음수 부호, `0 BB`를 모두 설계 §3.1대로 처리한다. `Number.isSafeInteger` 게이트로 `'100'`·NaN·Infinity가 0으로 둔갑하지 않는다. 칩 정수는 어디서도 BB로 왕복되지 않는다(`amount-editor`는 칩 문자열만 파싱).
- **팟 합계 불변식**: `engine/sidepots.js:9-27`의 층 합은 `engine/hand.js:316-319`의 `potTotal`(=Σcontribs)과 항등이므로 `aggregatePot`의 `legal.potTotal` 교차 검사가 정상 진행 중에 거짓 `mismatch`를 만들지 않는다. 완료 핸드는 `lastHand.pots`를 그대로 쓰고(`engine/views.js:26-34`), `test/ui-public-contract.test.js:25-26`이 실제 정산과의 일치를 건다.
- **탈락/수명주기 계약**: `publicSeat.out`(`views.js:41`)과 `handInProgress`(`views.js:54`, `phase==='in_hand'`는 `hand.js:258`/`643`과 정합)는 순수 additive이고, publish→persist→reload→app-proxy 왕복 동일성이 `ui-public-contract.test.js:35-51`로 고정된다. `turnSummary` 바이트 불변도 같은 테스트에서 확인한다.
- **공개 카드 프라이버시**: `app.js:155-171`/`335-356`은 공개 showdown 로그와 `view.myCards`만 입력으로 받고 `handReplays`(replayReveal=all)를 테이블 reveal로 재사용하지 않는다. `seat-format.js:10-12`가 완료 화면의 생존 좌석 뒷면·탈락 좌석 뒷면·D·베팅 뱃지를 모두 차단한다.
- **자산/CSP/경계**: 앱 서버는 단일 파일명 규칙으로 신규 public 자산을 제공하고 shared allowlist는 `game-setup.js`/`player-budget.js` 2개만 추가됐다(`tools/app-server.js:78-92`). CSP에 외부 출처가 없고 index.html의 Google Fonts는 제거됐다. `test/boundaries.test.js:144-145`의 예외는 `normalizeSetup` 1개 바인딩으로 좁다. 스터디는 CSS 1개 route만 추가(`tools/drill-server.js:17`).
- **컨테이너 쿼리 이름 존재**: `@container stage (...)`(table-design.css:97,149)는 `style.css:153-154`의 `container-name: stage`에 바인딩된다. `.table-wrap`이 무명 inline-size 컨테이너가 되어도 이름 질의가 그것을 건너뛰므로 의도대로 동작하고, `--tw`에서 `100cqh`는 제거됐다.
- **모바일 슬롯표**는 설계 §5.2의 H/L/T/R 좌표와 2–9인 표를 1:1로 옮겼고, 중복 좌표 없음을 `test/seat-format.test.js:18-24`가 건다. `--ai`는 8 상한이므로 SLOTS 미정의 인원은 발생하지 않는다.
- **입력 상태 기계**: 구문 오류는 clamp/제출/정규화를 모두 거부하고, clamp 발생 시 `pendingCorrection`이 blur·SSE·단위 토글·잠긴 receipt를 넘어 보존되며 첫 명시 click은 소비만 하고 둘째 click에서만 제출한다(`amount-editor.js:26-40`, `app.js:1047-1054`). 설계 §3.1의 2단계 확인 규약과 일치한다.
- **CI 배선/증거 매니페스트**: `BROWSER_CHECK_PLAN`(verify-learning-release.js:32-52)과 `journeyScenarioPlan`, 실제 `check()` 호출부가 19건으로 일치하고 `replay-reading-context`가 세 곳 모두에 있다. 신규 CLI는 `NODE_TEST_CONTEXT`에서 불활성이며 `test/browser-harness-contract.test.js:12-17`이 이를 고정한다.

## findings

### 1. 정산 팟 상세 `<details>`가 모든 재도장에서 접히고 포커스를 잃는다 — severity: medium (읽기 지속성 수용 기준 위반, 데이터 손상 아님)

- 파일: `server/public/app.js:288-300` (특히 290 `box.replaceChildren(...)`, 295-299 신규 `details` 생성), 호출부 `app.js:941`(paint) 및 `app.js:1149`(단위 토글).
- 문제: `paintPots`는 매 호출마다 `#pots`를 비우고 `<details class="pot-detail">`를 **새로 만든다**. 신규 요소는 항상 닫힌 상태이므로, 사용자가 "정산 팟 상세"를 펼쳐 읽는 중 아무 SSE 메시지(코치 노트, 학습 카드, narration, 다음 publish)나 단위 토글이 오면 상세가 접히고 `<summary>`에 있던 포커스는 body로 떨어진다. 설계 §6.2의 "단위 전환·SSE 갱신이 열림/선택/스크롤/포커스를 초기화하지 않는다"와 §7의 읽기 지속성 기준에 정면으로 어긋난다. 같은 화면의 학습 카드(`paintTraining`은 evaluationId 키로 노드 재사용)와 참가자 목록(`_signature` 게이팅)은 이 문제가 없어 `#pots`만 예외다.
- repro: 사이드팟이 2개 이상 생긴 올인 핸드가 정산된 직후(`handInProgress=false`, `pots.length>1`) 상세를 펼친다 → 코치 노트/다음 핸드 시작 이벤트 publish 1회 → 상세가 닫히고 `document.activeElement`가 `body`가 된다. 단위 선택기를 바꿔도 동일.
- 범위 한정 수정: `paintPots`에 `paintParticipants`와 같은 `_signature` 게이팅을 넣고(서명 = `[pot.kind, pot.total, view.handInProgress, view.pots, view.blinds, displayUnit]`) **추가로** 재구성 직전 `const open = box.querySelector('.pot-detail')?.open === true`를 캡처해 새 `details`에 `detail.open = open`으로 복원한다. 두 줄이면 SSE 재도장과 단위 전환 양쪽이 모두 보존된다. 엔진·금액 계산은 손대지 않는다.

### 2. 범위 밖 정수와 구문 오류가 같은 "오류"로 통보된다 — severity: low-medium (설계 문면 이탈, a11y)

- 파일: `server/public/amount-editor.js:20-25`(`invalid = n===null || clampRaiseTo(n,legal)!==n`), `server/public/app.js:455-459`(단일 메시지), `app.js:1086-1092`.
- 문제: 설계 §3.1은 "빈 값·소수·지수·부호·잘못된 쉼표는 **오류**로 표시하며 레이즈 제출을 막는다"와 "범위 밖 유효 정수는 입력 중 **경고**를 표시하고 blur/Enter에서 clamp한 실제 칩을 명시한다"를 구분한다. 구현은 두 상태를 하나의 `invalid` 플래그와 하나의 문구("칩 정수와 합법 범위를 확인해 주세요.")로 합치고 `aria-invalid="true"`를 똑같이 붙인다. 즉 합법 범위 100–1,000에서 `50`을 입력한 사용자는 `2.5`를 입력한 사용자와 같은 오류 취급을 받고, 합법 범위 값도 문면에 나오지 않는다. 동작 자체는 안전하다(제출 0회, commit에서 clamp, 2단계 확인 유지).
- repro: 내 차례, min 100 / max 1000 상태에서 `#raise-amount`에 `50` 입력 → `.amount-field.is-invalid` + `aria-invalid=true` + 구문 오류와 동일 문구. 스크린 리더에는 "잘못된 입력"으로만 전달된다.
- 범위 한정 수정: `edit()`가 `invalid`(구문 전용)와 `outOfRange`(clamp 필요)를 분리해 반환하되 **내부 게이팅은 지금 그대로 유지**한다(`outOfRange`일 때도 `state.value`를 갱신하지 말아야 슬라이더·버튼 라벨이 불법 금액을 보이지 않는다). `markAmountValid`만 분기해 `outOfRange`에는 `aria-invalid`를 붙이지 않고 `합법 범위 ${min}–${max} 칩 · 확인 시 보정됩니다`를 쓴다. `submit`/`commit`/`pendingCorrection` 로직은 무변경.

### 3. 캐시 트레이닝에서 `out` 부재 좌석이 "상태 확인 불가"로 표시된다 — severity: low

- 파일: `server/public/seat-format.js:8-9` (unknown 분기가 mode를 보지 않음), 대조군 `seat-format.js:16`(participantSummary는 cash에서 unknown을 쓰지 않음).
- 문제: 설계 §4.1은 "cash-training은 `참가자 M명`으로 표시하고 남은 인원/탈락 개념을 사용하지 않는다"이다. 그런데 `out` 필드가 없는 구버전 view가 cash 모드로 들어오면 좌석 뱃지와 참가자 탭 행이 전원 "상태 확인 불가"가 되고, 요약줄만 "참가자 3명"이라 한 화면에서 모순된 메시지가 된다. cash에는 탈락 개념 자체가 없으므로 unknown을 말할 근거가 없다.
- repro: 이번 변경 이전에 publish된 `ui-snapshot.json`(mode=cash-training, seats에 `out` 없음)을 가진 store를 resume/새 브라우저 접속 → 다음 정상 publish 전까지 전 좌석 "상태 확인 불가".
- 범위 한정 수정: `seat-format.js:9`의 unknown 분기를 `view?.mode !== 'cash-training' && typeof seat.out !== 'boolean'`로 좁히고 cash에서는 `'플레이 중'`으로 떨어뜨린다(추론이 아니라 그 모드에 탈락 상태가 정의되지 않기 때문). `participantSummary`는 이미 올바르므로 무변경.

### 4. UI 여정의 `finally`가 증거 파일보다 먼저 단정해 실패를 삼킨다 — severity: low (하네스 신뢰성; 실store 불변 미입증과 직결)

- 파일: `test/browser/ui-presentation-journey.mjs:161-168` (특히 164 `assert.equal(hashTree(protectedStore),before)`가 165 `workspace.close()`와 167 `result.json` 기록보다 앞).
- 문제: 보호 store(`./game`)가 무관한 동시 세션에 의해 바뀌면 `finally` 안에서 AssertionError가 던져지고, 그 결과 (a) 원래 실패 원인이 교체되며 (b) `workspace.close()`가 실행되지 않아 임시 워크스페이스가 남고 (c) `result.json`이 아예 기록되지 않아 통과한 18개 체크의 증거가 사라진다. `learning-journey`는 같은 사실을 `result.userStore.{before,after,unchanged}`로 결과에 실어 보내는 구조라 대비된다. 과제에 적힌 "real store invariance not established (observed external changes)"가 이 구조 때문에 증거 없는 중단으로 나타난다.
- repro: 여정 실행 중 다른 세션이 `game/` 아래 파일 1개를 쓴다 → 프로세스는 `hashTree` 단정으로 죽고 `outDir/result.json`이 없다.
- 범위 한정 수정: `after = hashTree(protectedStore)`를 계산해 `result.json`에 `userStore:{before,after,unchanged}`로 먼저 기록하고, `workspace.close()`를 자체 try로 감싼 뒤, `unchanged===false`일 때 `pending`/`failure`로 승격해 마지막에 던진다. `requiredJourneyChecks`에 `real-user-store-unchanged` 계열 체크를 추가해도 좋다(선택).

### 5. 재사용된 구버전 study 프로세스에서 학습실 팔레트가 무효화된다 — severity: low

- 파일: `server/drill-public/drill.css:1,4`(모든 값이 `var(--ui-*)` 무조건 참조), 신규 route `tools/drill-server.js:17`, 재사용 판정 `tools/study-service.js:303-305`.
- 문제: study 서비스는 store별로 오래 살고 재사용된다(AGENTS.md). 재사용 검증은 `protocolVersion===1`·`capabilities.study`·pid/instanceId 동일성만 보고, 이 값들은 이번 변경으로 바뀌지 않았다. 따라서 변경 이전에 뜬 study 프로세스는 그대로 재사용되고, 그 프로세스의 메모리 내 `STATIC` 맵에는 `/design-tokens.css`가 없어 404가 난다. 그러면 `--bg/--ink/--line`이 전부 guaranteed-invalid가 되어 배경·본문색·경계가 초기값으로 떨어진다(내용은 남지만 다크 테마가 붕괴). 설계 §5.1·M12의 "기본 fallback 읽기 가능" 취지에 어긋난다.
- repro: 이 브랜치 이전 코드로 `npm run study -- /absolute/store`를 띄워 둔 상태에서 새 코드로 학습실을 다시 열면 `/design-tokens.css`가 404이고 drill 화면 색이 사라진다.
- 범위 한정 수정: `drill.css`의 토큰 참조에 폴백을 넣는다 — `--bg: var(--ui-bg,#0b1118)` 식으로 6개 변수(`drill.css:1`)와 `font-family: var(--ui-font, system-ui, sans-serif)`(`drill.css:4`). 서버·수명주기·프로토콜 버전은 건드리지 않는다.

### 6. (정보) 릴레이가 서비스하는 `lobby.html`은 이제 부팅하지 못한다

- 파일: `server/public/lobby.js:2`(`import {normalizeSetup} from '../../shared/game-setup.js'` → `/shared/game-setup.js`로 해석) 대 `server/server.js:895`(shared allowlist에 `game-setup.js` 없음).
- 로비의 정본 호스트는 앱 서비스이고 거기에는 allowlist가 추가되어 있어 **정상 경로에는 결함이 없다.** 다만 릴레이 포트로 `/lobby.html`을 직접 열면 모듈 import가 404가 되어 lobby.js 전체가 실행되지 않는다(변경 전에는 `lobby-command-client.js`만 필요했으므로 동작했다). 릴레이가 로비를 호스팅할 의도가 없다면 조치 불필요이고, 의도가 있다면 `server.js:895` 목록에 `game-setup.js`/`player-budget.js` 2개를 추가하는 것이 최소 수정이다. 판단만 명시해 두는 편이 좋다.

### 7. (정보) 로그 블라인드 보완 경로의 한쪽은 도달 불가

- 파일: `server/public/table-presentation.js:13-20`.
- `handNo`는 `hand_start`에서만 세팅되므로, 설계 §P2가 허용한 "시작 이벤트가 없을 때 handReplay 블라인드로 보완"은 실제로 발화하지 않고 `null`(칩만)로 떨어진다. 보완이 동작하는 경우는 `hand_start`가 있으나 `blinds`가 없을 때뿐이다. **방향이 안전한 쪽**이고(잘못된 분모를 절대 쓰지 않음) 설계의 "둘 다 없으면 칩만" 분기와도 모순되지 않으므로 수정 요구는 하지 않는다. 다만 이 경로가 있다고 문서·리뷰에서 주장하지 않는 편이 정확하다.

### 비결함으로 판단해 기각한 것

- 모바일 일반 흐름 액션 바(`position:relative`)와 좁은 컨테이너 좌석 리스트 폴백: 측정된 의도적 조정으로 접수. 액션 위치에서 `#action-summary`가 내 스택·팟·내 카드를 함께 제공하고(`app.js:513`) 여정이 문면을 단정한다(`ui-presentation-journey.mjs:86`).
- 모바일에서 `.bet-marker`/`.plate .amount-secondary` 숨김: 설계 §3.2가 허용한 "좌석 상세로 이동"이며 상세 다이얼로그가 두 단위와 이번 스트리트 베팅을 텍스트로 제공한다(`app.js:217`). hover/title 전용 정보가 아니다.
- `paintCoach`의 전체 재생성: 플랜 §P5가 "키 기반 **또는** 동일 데이터 갱신 생략"을 허용하고 후자를 구현했으며 해당 패널에 포커스 가능 요소가 없다.
- `reviewDismissalAfterUpdate`의 인자 축소, `.pot-item` 죽은 CSS, `writeAmountField(value)`의 미사용 매개변수: 무해한 잔여물.

## missing_tests

1. **팟 상세 열림/포커스 보존**: 위 finding 1을 잡는 테스트가 없다. 정산 멀티팟 → `details.open=true` → publish 1회 → `open===true` 및 `activeElement`가 `summary`임을 단정하는 케이스(여정 `pot-recovery` 인근)와, 단위 토글 후 동일 단정.
2. **범위 경고 vs 구문 오류 구분**: `amount-editor` 단위 테스트가 두 상태를 같은 `invalid`로만 확인한다. 문구/`aria-invalid` 분리를 고정하는 단정이 없다.
3. **cash + `out` 부재**: `test/seat-format.test.js`에 `{mode:'cash-training', seats:[{}]}`의 좌석 status 기대값이 없다(현재는 '상태 확인 불가'가 통과해 버린다).
4. **재연결 시 탈락 알림 비반복(M11)**: 여정은 reload 후 `#seat-announcement`가 빈 것만 본다(새 페이지라 자명). 이미 `out=true`인 baseline snapshot 수신 → 이어서 같은 view의 SSE publish에서 announce가 다시 쓰이지 않는지(=`render` 경로) 검증하는 케이스가 없다.
5. **CI 모드의 반응형 커버리지 구멍**: `--ci`는 390/1440만 돌므로 `@container stage (min-width:601px) and (max-width:800px)`(768px·8/9인)와 `@container stage (max-width:300px)` 순차 폴백이 CI에서 한 번도 평가되지 않는다. 전체 폭 매트릭스는 로컬 전용이라 회귀가 CI를 통과할 수 있다. 최소한 768px 1점을 `--ci`에 넣거나, 좁은 컨테이너 폴백에 대해 "좌석 겹침 0 + DOM 순서 = 시각 순서" 단정을 추가.
6. **`dialog-controller.js`의 기본 스위트 커버리지 0**: 포커스 트랩/inert 복원/Escape/모달 교체는 전부 별도 `ui-browser` job에만 의존한다. `node --test`에서 도는 최소 DOM 더블(문서 스텁) 단위 테스트가 있으면 회귀 감지가 앞당겨진다.
7. **긴 이름·큰 금액 조합의 겹침**: 여정은 그 조합에서 가로 스크롤만 보고(`:127-133`) 좌석 겹침 매트릭스는 기본 이름에서만 돌린다.

## uncertainties

- 이 좌석은 읽기 전용이라 **어떤 테스트도 실행하지 않았다.** "browser reviewed-ci 통과", "learning-final 19체크 통과", "full Node 스위트 진행 중" 같은 진술은 검증하지 않았고, 대신 매니페스트 정합성(`BROWSER_CHECK_PLAN` ↔ `journeyScenarioPlan` ↔ `check()` 호출부 19건)과 릴리스 검증기의 required-check 논리를 정적으로 확인했다. 전체 스위트 최종 결과가 아직이라면 그 결과는 이 판정에 반영되지 않았다.
- **실측 영역**: 대비비는 토큰 값으로 산술 확인했고 본문·주요 컨트롤은 4.5:1/3:1을 넉넉히 넘지만, 펠트 배경 위 `.plate` 외곽(`#61758b` on `#17473e`, 약 2.2:1)은 경계 대비가 낮은 쪽이다. 플레이트 내부 대비(≈3.6:1)로 식별되므로 결함으로 올리지 않았으나, 실제 측정 보고서가 이 쌍을 포함했는지는 확인하지 못했다.
- **컨테이너 쿼리와 zoom의 상호작용**: `body.style.zoom='2'`에서 stage 유효 폭이 300px 미만이 되어 순차 폴백이 발화한다고 추론했지만 브라우저별 zoom 해석 차이는 실측으로만 확정된다.
- **실 store 불변성**: finding 4 때문에 이 여정은 `./game`이 외부에서 바뀌면 증거 없이 중단된다. 따라서 현재 증거로는 "실 store를 건드리지 않았다"가 입증되었다고 말할 수 없다 — 미입증이지 위반의 증거는 아니다.
- 지시대로 `ui-code-review*`, `ui-commercial-review*`, 구현 진행 보고서는 읽지 않았다. 그쪽에서 이미 지적/기각된 항목과 중복될 수 있다.
