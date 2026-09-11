=== REVIEW ===
verdict: PASS_WITH_CHANGES
confidence: 0.74

findings:
- id: F1
  severity: high
  category: correctness / missing decision
  evidence: design §6.1 ("완료 핸드의 팟이 여러 개일 때만 … 엔진이 정산한 상세") vs `engine/views.js:11-21,26-34` — 완료 핸드 경로는 `state.lastHand.pots ?? []`만 쓰고 `contribs: new Map()`이므로 buildPots 복구가 불가능. `pots`가 비었거나 부재하면 `publicPots`는 `[]`를 반환해 합계 0이 된다. 이 상태에서 `legal`은 `state.hand` 없으면 아예 없으므로(views.js:50,67) §6.1의 `legal.potTotal` 정합성 검사와 `팟 정보 확인 중` 게이트가 동작하지 않는다.
  required_fix: 완료 핸드에서 `view.pots`가 비었거나 부재할 때의 표시를 명시(합계 0 금지 → 정보 확인 불가 또는 항목 숨김)하고, `lastHand.pots`가 정산 팟을 담는다는 전제를 P1 fixture로 고정.
  blocks_implementation: false
- id: F2
  severity: medium
  category: layout / 내부 불일치
  evidence: design §5.2 본문 "7–9인은 양쪽 3명 + 상단 2명 + 하단 hero" vs 같은 절 슬롯 표의 8인 행(L3,L2,L1,TC,R1,R2,R3 = 양쪽 3 + 상단 1, 총 8석).
  required_fix: 표를 정본으로 선언하거나 본문을 9-max 한정 서술로 수정.
  blocks_implementation: false
- id: F3
  severity: medium
  category: CI / rollback 외 운영
  evidence: plan §P6 "`npx --yes agent-browser@0.36.0 install --with-deps` … 설치 불가는 명시 실패". `--with-deps`는 apt 단계 실패 시 전체 실패(확인된 CLI 동작)이며 러너 권한/패키지 상태에 의존한다.
  required_fix: deps 설치 실패 시의 확정 행동(권한 처리 또는 `install`만으로 재시도 후에도 실패면 job 실패)을 플랜에 한 줄로 고정. skip을 PASS로 합산하지 않는 규칙은 유지.
  blocks_implementation: false
- id: F4
  severity: medium
  category: correctness / 데이터 출처 미지정
  evidence: design §4.2 "이미 공개된 쇼다운/사용자 카드는 탈락 직후에도 기존 reveal 권한대로" + plan P1 "seatPresentation은 기존 공개 reveal와 viewer 카드만 받는다". 그러나 `publicSeat`(views.js:36-46)에는 카드 필드가 없고 새 필드도 추가하지 않는다.
  required_fix: 완료 핸드 좌석 공개 카드의 정본 소스(handReplay/이벤트 중 무엇)를 한 곳으로 지정하고, 그 소스 부재 시 뒷면 없이 머크 텍스트만 남기는 것을 명시.
  blocks_implementation: false
- id: F5
  severity: low
  category: 입력 상태 모델
  evidence: design §3.1 — Enter는 "검증/커밋만", 명시적 해제는 slider/preset/arrows/새 decision뿐. 구문 오류 상태에서 Enter의 결과가 문면으로 확정되지 않았다(오류 보존은 추론 가능).
  required_fix: "구문 오류 + Enter = 오류 유지, 제출·정규화 없음"을 한 문장으로 명시.
  blocks_implementation: false

missing_tests:
- 완료 핸드 `pots` 부재/빈 배열 → 합계 0이 아님(F1)
- 신규 필드가 있는 persist 파일을 구버전 리더가 그대로 통과시키는 rollback 회귀(plan P1의 unknown-field 수용과 별개로 역방향)
- `turnSummary`/player prompt 직렬화에 `out`/`handInProgress`가 등장하지 않는다는 명시 assertion(기존 privacy 스위트 실행에 의존하지 말 것)
- 토너먼트에서 누적 손익 항목 자체가 숨겨짐(`—` 미노출)
- coach/리뷰/export 텍스트가 새 formatter로 변경되지 않음(문자열 동일성)
- relay `serveStatic`의 `.css` content-type로 design-tokens.css 200 서빙

uncertainties:
- `state.lastHand.pots`가 항상 정산 팟을 담는지(제공 excerpt 범위 밖)
- `views.js:113` 이후 turnSummary 본문이 view를 스프레드하지 않는지(사용자 진술로만 확인)
- app 서버 CSP 실체(plan M12가 참조하나 excerpt에 없음)
