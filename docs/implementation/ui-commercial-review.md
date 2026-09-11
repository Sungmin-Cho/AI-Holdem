# UI 설계·구현 계획 검토 기록

2026-09-11 · 기준 소스 `161cd7a` · [설계](ui-commercial-design.md) · [계획](ui-commercial-plan.md) · [시각 시안](ui-commercial-preview.html).

최종 판정: **READY_FOR_IMPLEMENTATION — 구현 착수 가능**. 제품 구현은 시작하지 않았다. 설계·계획의 완료이며 상용 서비스 출시/실제 UI 테스트 통과 판정이 아니다.

## 라우팅과 실제 실행

요청된 model-router 1.14.0을 사용했다. 이미 작성한 산출물의 read-only REVIEW이며 저자는 확인 가능한 OpenAI family로 선언했다. 호스트는 GPT-6이며 세부 ID/effort는 런타임에서 확정되지 않아 라우터에 gpt-6(unrecognized), effort 미선언으로 기록했다. 임의로 gpt-6-astra라고 표시하지 않았다.

분류: complexity 2, uncertainty 1, blast radius 2, reversibility 1, public_api_change. risk 9/HIGH, execution 8/EASY, routing confidence 0.95. 실제 dispatch_seats는 Opus 5와 Fable 5.1 각 HIGH/high. 두 모델 모두 READY probe에서 실제 응답을 확인했다. 리뷰어 둘은 같은 Claude family이므로 다중 provider 리뷰라고 주장하지 않는다. 저자와는 다른 family이며 각각 별도 CLI 세션에 peer 결과를 주지 않았다.

dispatch_agent supervisor와 Darwin receipt guard를 적용했다. target hash, route fingerprint, policy hash, prompt hash, 완료/종료 상태를 보존한다. 1차 Opus는 600초에서 TIMED_OUT, termination_confirmed=true이며 verdict 없음이다. 이 시도는 검토 0건이다. 사용자 요청에 따라 후속 두 리뷰 모두 deadline 1200초로 늘렸다. Opus 무응답 재시도는 1회이며, 2차에는 전체 산출물과 관련 코드 발췌를 직접 제공하고 도구 탐색을 없앴다. 리뷰 기간 자체를 줄이거나 약한 모델로 바꾸지 않았다.

## 1차 의견 선별

[Fable 원문](ui-commercial-review-r1-fable.md): PASS_WITH_CHANGES, 0.80, 구현 착수 blocker 없음. 다음 항목은 단순히 verdict를 따르지 않고 실제 소스와 대조했다.

| 지적/발견 | 판단 | 근거와 조치 |
|---|---|---|
| F1 학습 서버 경로 오류 | 수용 | 실제 `tools/drill-server.js` STATIC map에 공통 CSS 한 항목 추가하도록 계획 정정 |
| F2 로비 validation 전달 누락 | 수용 | `shared/game-setup.js`와 순수 `player-budget.js`를 app allowlist에 함께 추가, normalizeSetup 재사용. 서버 검증 최종 권위 유지 |
| F3 캐시 남은 인원 표현 | 수용 | cash는 참가자 수, tournament만 생존 인원 |
| F4 완료 비공개 카드 처리 미정 | 수용 | 완료 뒷면 제거, 공개 reveal/머크만 유지. D는 진행 중에만 표시 |
| F5 외부 폰트/CSP 불일치 | 수용 | 외부 Google Fonts 제거와 시스템 폰트 통일. standalone 외부 요청 0건 검증 |
| F6 browser CI가 불명확 | 취지 수용, 제안 경로 조정 | node --test 래퍼로 실제 browser를 실행하자는 예시는 기존 NODE_TEST_CONTEXT inert 계약과 맞지 않음. 별도 UI browser job + 명시 CLI smoke로 확정 |
| F7 localStorage 지속 범위 과장 | 수용 | app-service port=0 확인. 같은 origin 한정, 새 포트/다른 서비스는 기본값 |
| F8 시안과 계약 차이 | 부분 수용 | 시안은 동작 구현물이 아님. 화면 미연결을 blocker로 취급하지 않되 고정 높이 산술·보조 단위 단순 숨김을 제품에 복사하지 않도록 P4에 명시 |
| 로그 자동 절단 가능성 | 관측 주장 기각 | 현재 자동 절단을 확인하지 못했다. 과거/불완전 snapshot의 방어 분기라고 정정 |
| agent-browser 실제 키 입력 미확인 | 신규 결함으로 미수용 | 기존 lobby journey가 press Escape를 실제 사용함. 전체 키보드 동작은 M8에서 검증 |
| 작성자: 최종 cash reset 예외 | 수용 | handLimit 도달은 reset 전에 gameOver. 다음 핸드 복원 안내는 진행 가능한 핸드 간에만 |
| 작성자: 미매칭 상위 기여액 | 2차에서 재수정 | 초기 `응답 대기 베팅` 제안에도 dead money가 섞일 수 있다는 검토를 수용. 최종안은 진행 중 합계만, 완료 정산에서 상세 표시 |
| 작성자: 잘못된 숫자 입력 변형 | 수용 | app.js의 비숫자 제거 대신 정수 grammar·invalid 제출 차단. 엔진 clamp 계산은 보존 |
| 작성자: 자동 리뷰 도착의 focus 방해 | 수용 | 읽는 dialog가 있으면 자동 리뷰를 보류하고 명시적 전환만 허용 |

## 2차 의견 선별

[Opus](ui-commercial-review-r2-opus.md): PASS_WITH_CHANGES 0.74. [Fable](ui-commercial-review-r2-fable.md): PASS_WITH_CHANGES 0.82. 두 리뷰 모두 정상 종료·verdict가 확인됐고, fingerprint/model/count/receipt guard 검증도 통과했다. 같은 개선 계약의 보완에는 작성자가 inline 수정했으며 리뷰어의 verdict를 PASS로 바꾸어 적지 않았다.

| 항목 | 판단 및 최종 조치 |
|---|---|
| Opus F1: 1명 eligible층을 응답 대기로 부르는 것은 잘못 | 수용. A=800, B=500(fold), C=300(all-in) 반례의 합계층은 dead money를 포함한다. 진행 중은 전부 합계만, 완료 정산에서 상세. 불필요한 public 반환액 필드/엔진 변경은 기각 |
| 두 리뷰: 입력 오류 수명/paint/focus/금액 선택 | 수용. 오류는 같은 decision의 재도장/blur/refocus/단위 전환에서 보존. slider/preset/화살표/새 decision은 명시적 유효 값 선택으로 해제. submit 즉시 파싱, 범위 보정 최초 click은 값 확인만, Enter는 제출하지 않음 |
| Opus F2/F3: 전달·relay 파일 누락이 high blocker | 문서 보완은 수용, 현재 코드 결함이라는 심각도는 미수용. 실제 경로에 view allowlist가 없고 relay는 public 하위 generic serveStatic. 경로·소비자·회귀 확인을 P1/P3에 구체화했으며 불필요한 서버 로직 변경은 하지 않음 |
| Fable F4: handInProgress와 legalFor idle 정합 | 수용. state.hand 존재 AND engine phase=in_hand로 정의. 별도 loop/pause 상태와 혼합하지 않음 |
| 두 리뷰: cash 복원 시점/손익 출처 | 수용. 이미 복원됐다고 안내. 현재 view 스택과 최종 핸드 기록 구분, 종료 스택 새 공개 필드 추가는 불필요 |
| Opus F10: 2–6인 모바일 배치 결정 부족 | 수용. 2–9인 전체 슬롯 표 추가. pixel perfection은 P4 실측으로 검증 |
| 낮은 높이에서 무스크롤 동시 노출 강제 | 부분 수용. 모든 좌석을 축소하는 요구는 채택하지 않음. 일반 배율에서도 세로 스크롤 허용, 액션 영역에 hero/팟 요약, sticky와 카드 비겹침 gate |
| parent dialog의 iframe inert | 취지 수용. 단순히 close 후 inert=false로 만드는 것은 paused 상태와 충돌하므로 기존 값+최신 lifecycle로 복원 |
| browser CLI inert/설치 절차, P2 검증 순서 | 수용. CLI export/sentinel과 fail-on-missing 명시. agent-browser install --with-deps를 실제 0.36.0 help로 확인. P2는 node/통합 계약, P6는 최종 browser 승인 |
| pure module의 top-level storage/DOM, CSS charset, 숫자 font | 수용. 최상위 부작용 금지, 공유 토큰 ASCII, 시스템 숫자 스택과 폭 확보 |
| Opus F14: 설계/보고서를 반드시 ignored 경로로 이동 | 기각. git ls-files에서 기존 docs/implementation의 설계·계획·검증 문서가 추적됨을 확인. 현재 사용자/AGENTS에 그런 제한 없음. 이번 턴은 commit 자체를 하지 않음 |

반대 의견을 임의로 무시하거나 모델 판정을 평균내지 않았다. 산술 반례와 입력 상태의 실제 코드 문제는 닫고, 제공된 source excerpt 부족에서 나온 미확인을 기존 코드 결함으로 확대하지 않았다. 핵심 설계가 확정되어 3차는 수정된 최종 설계·계획만 검증한다. 원문을 포함한 시안은 2차 target에서 검토됐고 최종 확인 target은 설계+계획으로 한정했다.

## 3차 판정과 종료

[Opus 최종](ui-commercial-review-r3-opus.md)은 PASS_WITH_CHANGES(0.74), [Fable 최종](ui-commercial-review-r3-fable.md)은 PASS_WITH_CHANGES(0.82)이며 두 보고서 모두 blocks_implementation=true 항목이 없다. fingerprint/model/count/receipt guard/정상 종료 검증을 완료했다. 1차의 무응답 재시도까지 포함해 총 3라운드에서 종료한다.

- pendingCorrection 상태를 명시해 blur가 첫 click 전에 clamp해도 곧바로 제출되지 않게 한다. 첫 raise click은 보정 확인만, 다음 명시 click에 제출. 편집·금액 선택·새 decision의 해제/재설정 규칙과 M3을 추가했다.
- 공개 카드는 현재 hand_start 그룹의 공개 showdown.reveals/mucks와 view.myCards로 확정했다. 소스 부재를 머크라고 추정하자는 부분은 기각하고 실제 mucks만 표시한다. replayReveal=all은 테이블 공개 권한으로 사용하지 않는다.
- 완료 pots 부재/빈 배열은 0 대신 정보 없음. 실제 hand.js:593의 lastHand.pots=potRecords를 재확인했고 완료 view의 개수/합 assertion을 추가했다. 정상 엔진에 정산 팟 저장이 없다는 가정은 기각했다.
- 7–9인 일반 서술을 9인 설명으로 정정하고 전체 슬롯 표를 정본으로 삼았다.
- 설치 실패는 기존 계획대로 job 실패다. 권한/apt 오류를 축소 설치 재시도로 우회하자는 제안은 채택하지 않았다. 현재 lobby/learning harness의 0.36.0 pin을 확인하고 설치와 실행 버전 일치를 명시했다.
- 입력 미세 경계·기존 reader 역방향 호환·prompt/원문 보존·누락 팟·탈락 강조 제거는 각 P/M 테스트에 명시했다.

마지막 보완은 직전 추가 문장의 상태 전이·표현 정합과 검증 소유 지정이다. 작성자가 코드 근거로 반영했으며 **이 보완 뒤의 최종 bytes까지 독립 리뷰어가 다시 읽었다고 주장하지 않는다**. 검토 target SHA와 최종 문서 SHA를 [증거 파일](ui-commercial-review-evidence.json)에 구분했다. 추가 제품 선택/아키텍처 blocker는 없고 나머지는 P1–P6 구현과 기계 검증으로 넘긴다.

## 현재까지의 측정

- 기존 기준선: `node --test test/table-ux.test.js test/views.test.js test/replay-format.test.js` — 56 passed, 0 failed. 새 기능 테스트 결과는 아니다.
- 순수 메모리 fixture에서 out=true/stack=0 좌석의 public view에 out 필드가 없음을 재현했다. 25/50 블라인드 pot layers 50+25도 확인했다.
- 실제 CSS/HTML을 별도 정적 로컬 서버와 메모리 fixture로 관찰했다. 실사용 store·LLM·실제 app lifecycle 실행 없이 화면만 확인했다.
- 시안 9석: 360/390/768/1024/1440px에서 scrollWidth=viewport width. 모바일 일반 스택14px, hero18px. 완료/힌트/큰 금액/실제 iframe 상태별 성공을 뜻하지 않는다.
- 제안 기본 색 조합의 산술 대비: 본문/패널15.20, 보조/패널8.40, primary 글자/배경10.13, hero 금색/표면7.73. 실제 전체 UI 대비 검사와는 별개다.
- 로비/테이블 데스크톱·모바일 시안 캡처는 `output/playwright/beluga-proposed-*.png`. 출발 화면은 `beluga-current-*.png`.
- 화면 확인용 서버/브라우저를 종료했다. 제품 코드, 엔진 상태, 게임 기록, 학습 데이터, Git commit/PR은 변경하지 않았다.

## 구현 이후 남는 검증

P1–P6 및 M1–M12의 신규 구현·실제 브라우저 여정·지원 OS CI·접근성 측정·최종 diff 독립 리뷰가 필요하다. 문서 판정은 상용 서비스 출시나 포커 학습 효과의 증거가 아니다.
