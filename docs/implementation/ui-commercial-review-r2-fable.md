## 검토 요약

설계·플랜은 엔진 계약(정산 후 out, lastHand.blinds, buildPots 층 구조)과 현재 소스를 정확히 읽고 있고, 순서 P1→P6와 rollback(additive view + UI 역적용)은 실행 가능하다. 구현을 막는 모순은 없다. 다만 **레이즈 입력 오류 상태의 수명 주기**가 현재 app.js의 세 경로(매 paint의 필드 재작성, focus 시 값 덮어쓰기, slider/preset/화살표)와 충돌하는데 플랜이 이를 명시하지 않아, 그대로 구현하면 "오류 입력 보존"과 "SSE 갱신이 입력을 초기화하지 않음"이 깨진다. 이 부분과 몇 가지 정의 공백만 보완하면 착수 가능하다.

## 주요 발견

**입력 오류 상태 (설계 §3.1·§6.2, 플랜 P2)**
- `paintActionBar`는 매 SSE 렌더마다 `adoptDecision` → `syncRaisePanel` → `writeAmountField(raiseTo)`(app.js:431, 441)를 실행한다. 같은 decisionId 안에서 사용자가 입력 중이거나 오류 문자열을 남긴 채 갱신이 오면 필드가 raiseTo로 덮어써져 오류가 사라진다. 플랜은 "토글은 전체 paint 대신 표시 부분 갱신"만 말하고 SSE paint 경로의 보호를 말하지 않는다.
- focus 핸들러(app.js:955-958)가 `ev.target.value = String(raiseTo)`로 무조건 덮어쓴다. 오류 입력 → 단위 토글 클릭 → 입력란 복귀만으로 오류가 지워져 "단위 토글은 오류 입력을 보존"과 직접 모순된다.
- 오류 상태에서 slider·preset·ArrowUp/Down(app.js:985 이후)을 조작했을 때의 규칙이 없다. 또 현재 소스는 범위 밖 정수를 타이핑 중엔 invalid로 표시하고(970-972) blur 때 clamp하는데, 설계는 "범위 보정은 clamp 유지 + 보정값 명시"라고만 해 live 표시 규칙이 두 갈래다.
- 레이즈 제출 차단을 버튼 disabled에만 의존하면 mousedown→blur→disabled→click 순서에 기대는 셈이다. 제출 핸들러가 제출 시점에 필드를 재파싱해 차단하도록 명시해야 한다.
- fold/check/call과 pending receipt는 기존 `pendingAction` 게이트와 독립이라 설계 문면상 보존되지만, M3에 "레이즈 입력 오류 중 fold/call/check 버튼 활성·제출 성공"과 "오류 입력 + pending receipt 복구 중 decisionId/receipt 불변" assertion이 없다.

**상태 필드 정의 (설계 §4.1)**
- `handInProgress: Boolean(state.hand)`인데 `legalFor`의 idle 판정은 `!hand || state.phase !== 'in_hand'`(hand.js:680)다. hand가 있으면서 phase가 in_hand가 아닌 상태가 존재하면 UI는 진행 중 표시를, legal은 idle을 낸다. 정의를 legal과 같은 조건으로 맞추거나, state.hand 비null ⇒ phase in_hand를 테스트로 증명해야 한다.
- cash 핸드 경계에서는 정산 함수가 이미 `seat.stack = startStack`으로 되돌린 뒤(hand.js:613-616) 게시되고, `endStacks`는 공개 view에 없다. 따라서 "다음 핸드 스택 복원" 안내는 미래형이 아니라 "시작 스택으로 복원됨"이어야 하고, M5의 "중간 reset와 최종 스택 분리"는 view만으로는 해당 핸드의 종료 스택을 보여줄 수 없다. 종료 스택은 복기/sessionNet 증분으로 제공한다고 적거나 additive로 endStacks 공개를 결정해야 한다.

**팟 층 (설계 §6.1)**
- `awardPots`가 `eligible.length === 0`을 건너뛰는 것(sidepots.js:36)은 그런 층이 존재할 수 있다는 뜻이다. 설계는 eligible 1인 최상위 층과 2인 이상 층만 정의한다. eligible 0 층은 합계에만 포함하고 라벨을 붙이지 않는다고 명시하고, 합계 검증(legal.potTotal 대조)에 포함해야 한다.

**검증 순서·테스트 (플랜 P2·P6)**
- P2 완료 기준이 M1–M6인데 M3 증거는 P6에서야 생기는 browser 여정뿐이다. P2 안에서 `parseChipInput`과 blur/Enter/focus/paint-guard 의미를 기존 `test/table-ux.test.js` 방식의 node 테스트로 닫아야 P2가 독립 커밋으로 검증된다.
- M7의 "핵심 겹침 assertion"에 667px 높이에서 sticky 액션 바와 hero 좌석·hero 카드의 bounding box 비교차를 명시해야 한다. 시안처럼 hero가 펠트 하단(top:100%)에 붙으면 하단 여백 없이는 가려진다.

**자산·전달 (플랜 P1·P3)**
- app-server는 `.css`를 charset 없는 `text/css`로 내보내고(app-server.js:98-104) drill-server는 `text/css; charset=utf-8`이다. design-tokens.css를 ASCII로 제한하거나 charset을 통일해야 "올바른 content-type"이 정의된다.
- `viewFor`는 LLM 플레이어 view에도 쓰인다. 새 필드가 player-runtime 프롬프트 직렬화와 정확 일치 fixture에도 흘러가므로 P1 확인 범위에 public/ui-snapshot 외에 플레이어 view 계약을 포함해야 한다.
- CI의 agent-browser@0.36.0 Chromium 준비 절차는 확인되지 않았다. 브라우저 부재 시 required check 누락으로 실패하도록 harness contract에 명시하는 것이 안전하다.

=== REVIEW ===
verdict: PASS_WITH_CHANGES
confidence: 0.82
findings:
- id: F1
  severity: high
  category: correctness/contradiction
  evidence: 설계 §3.1·§6.2, 플랜 P2; app.js:431 writeAmountField(raiseTo), app.js:441 adoptDecision in paintActionBar
  required_fix: 같은 decisionId 안에서 필드에 사용자 텍스트(포커스 중 또는 오류)가 있으면 SSE paint가 입력값을 재작성하지 않는다는 규칙을 P2에 명시하고 테스트한다.
  blocks_implementation: false
- id: F2
  severity: medium
  category: correctness/contradiction
  evidence: 설계 §3.1 "단위 토글은 오류 입력을 보존"; app.js:955-958 focus 핸들러가 String(raiseTo)로 덮어씀
  required_fix: focus 시 필드 텍스트가 formatChip(raiseTo)와 동등할 때만 정규화하고, 그 외에는 유지하도록 P2에 명시한다.
  blocks_implementation: false
- id: F3
  severity: medium
  category: edge-case/spec gap
  evidence: 설계 §3.1 clamp 문단; app.js:965-972(live 범위 밖 invalid), 403-411(blur clamp), 985+(화살표)
  required_fix: (a) 구문 오류=제출 차단, 범위 밖 정수=경고+커밋 시 clamp 표시로 두 규칙을 분리 명시 (b) slider/preset/화살표는 필드를 새 값으로 교체하고 오류를 해제 (c) 레이즈 제출 핸들러가 제출 시점에 재파싱해 차단(disabled에만 의존 금지).
  blocks_implementation: false
- id: F4
  severity: medium
  category: correctness
  evidence: 설계 §4.1 handInProgress=Boolean(state.hand); hand.js:680 idle = !hand || phase !== 'in_hand'
  required_fix: handInProgress를 legalFor의 idle 부정과 동일 조건으로 정의하거나, state.hand 비null ⇒ phase in_hand 불변식을 views 테스트로 증명한다.
  blocks_implementation: false
- id: F5
  severity: medium
  category: correctness/spec gap
  evidence: 설계 §4.2 cash reset 행, M5; hand.js:601-617 정산 시 stack 즉시 복원, endStacks는 view 미포함
  required_fix: 경계 안내 문구를 "시작 스택으로 복원됨"으로 바꾸고, 해당 핸드 종료 스택의 출처(복기/sessionNet 증분 또는 additive endStacks 공개)를 결정해 M5 기대값을 그에 맞춘다.
  blocks_implementation: false
- id: F6
  severity: low
  category: edge-case
  evidence: 설계 §6.1; sidepots.js:36 eligible.length===0 가드
  required_fix: eligible 0 층은 합계에만 포함하고 라벨 없음으로 명시, M6 합계 검증에 포함한다.
  blocks_implementation: false
- id: F7
  severity: medium
  category: test adequacy/order
  evidence: 플랜 P2 완료 기준 M1–M6 vs M3 증거가 P6 browser 전용; M3 문면
  required_fix: P2에 parseChipInput·blur/Enter/focus/paint-guard의 node 테스트를 추가하고, M3에 "오류 입력 중 fold/check/call 활성·제출 성공"과 "오류 입력+pending receipt 중 decisionId·receipt 불변" assertion을 추가한다.
  blocks_implementation: false
- id: F8
  severity: low
  category: layout feasibility/test adequacy
  evidence: 설계 §7 "액션 가림 없음", 플랜 M7; 시안 hero top:100%
  required_fix: M7에 667px 높이에서 sticky 액션 바와 hero 좌석/카드 bounding box 비교차 assertion을 명시하고 P4에 테이블 하단 여백 ≥ 액션 바 높이를 요구한다.
  blocks_implementation: false
- id: F9
  severity: low
  category: source/asset compatibility
  evidence: app-server.js:98-104 text/css(무 charset) vs drill-server.js:16 charset=utf-8
  required_fix: design-tokens.css를 ASCII 전용으로 제한하거나 세 서버의 CSS charset을 통일하고 M12에 포함한다.
  blocks_implementation: false
- id: F10
  severity: low
  category: reader compatibility
  evidence: views.js:48 viewFor가 AI 플레이어 view에도 사용됨; 플랜 P1 확인 범위는 public/ui-snapshot 경로만
  required_fix: P1 확인 범위에 player-runtime 프롬프트 직렬화와 플레이어 view 정확 일치 fixture를 추가한다.
  blocks_implementation: false
- id: F11
  severity: low
  category: executable order/CI
  evidence: 플랜 P6 agent-browser@0.36.0 Ubuntu Chromium 설치 절차 미확인
  required_fix: 설치 명령을 고정하고 브라우저 부재 시 required check 누락으로 명시 실패하도록 harness contract에 포함한다.
  blocks_implementation: false
missing_tests:
- 오류 입력 보존: 오류 문자열 상태에서 SSE 갱신·단위 토글·focus 이탈/복귀 후 필드 텍스트와 오류 표시 유지, 레이즈 POST 0회
- 오류 입력 중 fold/check/call 버튼 활성 및 제출 성공, 다른 액션 payload 불변
- 오류 입력 + pendingAction/unknown action 복구 중 decisionId·receipt 불변, 새 decision 도착 시 adoptDecision 초기화
- 범위 밖 정수 입력의 live 표시와 커밋 시 clamp 값 명시 표시
- slider/preset/화살표 조작이 오류 상태를 해제하고 필드를 교체함
- handInProgress와 legal.handOver/toAct 정합성(상태 phase 변형 포함)
- eligible 0 층 포함 view.pots 합계 == potTotal, 라벨 미부여
- cash 경계 view의 stack==startStack과 lastHand/sessionNet 증분 분리 표시
- 667px 높이에서 액션 바와 hero 좌석/카드 비교차(2/6/8/9인)
- 플레이어 view(viewFor 비user) 직렬화에 새 필드 추가 시 기존 fixture/프롬프트 계약 통과
- 세 서버 CSS charset/content-type 일치
uncertainties:
- state.phase에 'in_hand' 외 값(일시정지 등)이 state.hand 비null과 공존하는지 미확인
- writeAmountField가 이미 포커스 상태를 보호하는지 소스 미제시
- 진행 중 hand.contribs가 plain object인지(Map이면 publicPots가 빈 배열) 미확인
- standalone relay 서버의 정적 파일 allowlist와 study/drill 서버 CSP 미제시
- agent-browser@0.36.0의 Ubuntu Chromium 설치 절차 미검증
