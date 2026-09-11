=== REVIEW ===
verdict: PASS_WITH_CHANGES
confidence: 0.82
findings:
- id: F1
  severity: medium
  category: correctness / 입력 상태 모델
  evidence: 설계 §3.1 "범위 밖 유효 정수는 blur/Enter에서 clamp한 실제 칩을 명시" + "범위 보정이 그 순간 처음 필요하다면 값만 보정해 보여주고 다시 명시적으로 레이즈를 눌렀을 때 제출(blur 이벤트 순서에만 의존하지 않음)"; 현재 app.js:975 blur→commitAmount. 버튼 mousedown이 blur를 먼저 일으켜 clamp를 끝내면 click 재파싱은 이미 유효 값을 보므로 첫 클릭이 그대로 제출된다. 두 문장이 함께 성립하려면 "보정이 방금 적용됨"을 기억하는 명시 상태(예: pendingCorrection: clamp가 값을 바꿀 때 set, 사용자 편집·slider/preset/화살표·새 decision·소비하는 클릭에서 clear)가 필요한데 설계·플랜·M3 어디에도 그 상태와 clear 조건이 없다.
  required_fix: P2 입력 상태 모델에 보정 플래그와 전이(설정/해제/소비)를 명시하고 M3에 "blur-clamp 후 첫 클릭 미제출·둘째 클릭 제출" 케이스를 추가.
  blocks_implementation: false
- id: F2
  severity: low
  category: privacy / 데이터 입력 정의
  evidence: 플랜 P1 "완료 카드 공개 여부는 기존 공개 reveal와 viewer 카드만 받으며 내부 holes를 인자로 받지 않는다"; 그러나 제시된 viewFor(views.js:51–73)에는 myCards 외 쇼다운 공개 카드 필드가 없다(lastHand.holes는 currentHandData에만 있고 노출 안 됨). seatPresentation이 어떤 소스(로그 showdown 이벤트, handReplay, 별도 view 필드)에서 "기존 reveal"을 받는지 결정되지 않았다.
  required_fix: P1 착수 전 reveal 입력의 정확한 소스와 형태를 한 줄로 확정하고 view 필드 추가가 필요하다면 additive 목록에 포함.
  blocks_implementation: false
- id: F3
  severity: low
  category: correctness / 완료 팟 상세
  evidence: views.js:20 `pots: state.lastHand.pots ?? []`는 항상 배열이므로 publicPots는 lastHand에 대해 buildPots를 절대 호출하지 않는다. 엔진이 정산 시 lastHand.pots를 저장하는지 제시 근거에 없다. 저장하지 않으면 완료 화면 합계가 0, 상세는 영구 미표시.
  required_fix: M6 real settle fixture에 "완료 view.pots 합 == 정산 총액, 길이 == 정산 팟 수" assertion을 명시(현재 문면 "분배 합계 불변"만으로는 view.pots 존재를 증명하지 않음).
  blocks_implementation: false
- id: F4
  severity: low
  category: compatibility / CI
  evidence: 플랜 P6 "브라우저 자동화는 현재 저장소 도구 버전/실행 패턴을 재사용" vs 동일 절 "npx --yes agent-browser@0.36.0 install --with-deps" 고정. 저장소 devDependency/하네스가 다른 버전을 쓰면 설치된 Chromium과 하네스 CLI 버전이 어긋날 수 있다.
  required_fix: package.json/기존 하네스의 agent-browser 버전을 확인해 pin을 그 값과 일치시키거나 불일치 시 우선순위를 문서화.
  blocks_implementation: false
missing_tests:
- blur-clamp 직후 첫 raise 클릭 미제출/둘째 클릭 제출(F1), 및 보정 상태가 slider/preset/새 decision에서 해제되는지.
- 진행 중 모든 스트리트에서 sum(view.pots)==legal.potTotal(sidepots.js 층 합 보존) 검증과, 인위적 불일치 fixture에서 "팟 정보 확인 중" 진입·정상 갱신 회복.
- 완료 view.pots 존재/합계(F3).
- tournament 다음 핸드(handInProgress=true, out=true) 좌석에 bet 뱃지·toAct 강조·카드 뒷면 0건(M4는 "카드 없음"만 명시).
- turnSummary/플레이어 프롬프트 직렬화가 out/handInProgress 추가 뒤에도 바이트 동일한 회귀(플랜은 "실행"만 언급, 스냅샷 기준 필요).
uncertainties:
- 정합성 확인은 legal이 있는 hero 차례에서만 가능(설계 문면 "있으면"과 일치)하나, 상대 차례의 불일치는 감지 불가함을 명시적으로 수용했는지.
- state.hand 존재 && phase≠'in_hand'인 중간 상태가 실제로 게시되는지(settle는 동기적으로 idle/null 처리하므로 낮은 확률).
- app-server/relay의 CSP 헤더 유무와 신규 module/CSS 허용 여부는 제시 근거 밖(플랜은 확인 항목으로만 둠).
- 1/200=0.005 BB의 "<0.01" 규칙은 반올림 전 크기 판정으로만 성립하므로 formatter 구현 순서에 의존.
