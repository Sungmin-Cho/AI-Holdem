# 리플레이 설계·계획 검토 기록

작성: 2026-10-15 · 작성자: gpt-6-astra

**작성자 판단: 조건부 구현 착수 가능.** P1의 제한된 읽기 모듈부터 진행할 만큼 범위·계약·검증 계획을 구체화했다. 최종 독립 판정은 **PASS_WITH_CHANGES + PASS**이며, 3차 지적을 반영한 마지막 문면 수정은 독립 재리뷰 전이다. 전체 PASS나 신기능 검증 완료로 취급하지 않는다. 사용자가 요청한 구현 전 보고 단계에서 제품 코드 작성은 시작하지 않았다.

설계: [replay-study-design.md](replay-study-design.md) · 계획: [replay-study-plan.md](replay-study-plan.md) · 상세 증거: [replay-study-review-evidence.json](replay-study-review-evidence.json).

## 라우팅과 독립 검토

model-router 1.22.0: REVIEW c2/u1/b2/r1, risk=9/HIGH, auth_sensitive/security_sensitive/public_api_change. 실제 작성 모델 gpt-6-astra를 제외하고 사용 중단된 xai/Grok도 제외했다. 가용 모델 카탈로그와 Claude bridge를 확인한 후 dispatch_seats 두 개만 실행했다.

| 라운드 | Claude Opus 5.5 / high | GPT-6.1 Sol / high |
|---|---|---|
| R1 | PASS_WITH_CHANGES (0.74) | PASS (0.87) |
| R2 | PASS_WITH_CHANGES (0.72) | PASS (0.91) |
| R3 · 수정 경계 한정 검증 | PASS_WITH_CHANGES (0.72) | PASS (0.94) |

각 좌석은 별도 fresh CLI 프로세스에서 동일한 고정 source packet을 받았고 서로의 결과는 받지 않았다. reviewer는 도구/파일 조회/테스트를 실행하지 않았다. macOS receipt guard를 적용하고 Codex는 no-file-access nested-sandbox 계약으로 packet만 읽었다. 모든 6개 reviewer receipt는 SUCCEEDED·종료 확인·출력 계약 검증을 만족했다. verify-evidence로 라우트 fingerprint/모델 집합/guard를 검사했고 마지막 evidenced route의 review_independence는 enforced였다. 이는 실행 격리·증거 결박의 확인이며 내용이 전부 PASS라는 뜻은 아니다. Claude 모델은 served_models, Codex 모델은 CLI header의 선언 근거다.

model-router SKILL.md의 `max_review_rounds: 3`에 따라 문서 리뷰를 종료했다. 마지막 수정본은 작성자 검토만 반영했으며 다음 구현 diff 리뷰가 이 계약과 실제 동작을 함께 검증해야 한다.

## 검토 지적 처리

판정 토큰만으로 수용하지 않고 실제 소스와 대조했다. PASS와 PASS_WITH_CHANGES 조합은 router의 적용 후 재검토 경로를 따랐다. 서로 반대되는 구현 결론을 고집한 상황은 없어 별도 judge는 호출하지 않았다.

| 라운드/항목 | 처리 | 근거와 반영 |
|---|---|---|
| R1 F1 원본 record hash | 수용 | raw record에 hidden holes가 있으므로 공격의 정확한 비용 추정과 무관하게 공개 응답에 그 digest를 둘 필요가 없다. revision을 최종 공개 DTO+공개 메타데이터만으로 계산, hidden-only 변경의 digest 동일성 검사 |
| R1 F2 구 study handler | 수용 | static bytes는 매 요청 디스크에서 읽고 라우트는 구 프로세스에 고정. 학습실에서 이동 전 health capability gate |
| R1 F3 미래 단계 수 | 수용 | prefix timeline, 분모 없는 단계 번호, 미래 행/끝 버튼 제거, DOM 차분 검사 |
| R1 F4 상태 표시 | 부분 수용 | 매핑을 명시하되 gameOver의 win/lose를 aborted로 분류하는 예시는 기각. 엔진 win/lose/completed는 완료, abort만 중단, 그 외 미종료/불명 |
| R1 F5 return/runout | 수용 | 첫 showdown/result index-1을 cap으로 고정하고 그 전의 return/runout 포함, 무액션 블라인드 올인 검사 |
| R1 F6 경로 규칙 | 수용 | engine/state.js의 private handFile 확인. 무조건 export하는 대신 엔진이 쓴 1/9999/10000번 파일 reader parity를 P1에 배정 |
| R1 F7 세션 좌석 | 수용 | engine/hand.js의 out 갱신, room-manager의 locked 제거 금지/leaveEliminated roster 보존 확인. 탈락·이탈·재접속 fixture |
| R1 F8 이벤트 루프 | 수용 | 파일 1건마다 yield, 열거 25건마다 yield. health 선행 완료와 플랫폼 예산 내 관측을 분리 |
| R1 Sol 검증 gate 3개 | 수용 | 중첩 DTO 비밀 제거, 구 서비스 진입, 공통화 후 live 회귀를 P1/P2/P3/P5에 구체화 |
| R2 F1 정적 자원 | 부분 수용 | 공개 포트에 새 API 없음으로 문면 정정. app host/public serveAsset와 relay serveStatic는 public 파일명 allowlist 방식이 아니므로 무조건 allowlist를 추가하라는 부분은 적용하지 않음. study STATIC만 명시 추가. 기존 drill에 새 import/CSS 없음, 구 handler 혼합 버전·참가자 로드 검증 |
| R2 F2 다음 결정 버튼 | 수용 | root 자체 검토에서도 같은 충돌 확인. cap 이전 활성 상태는 미래 user 액션 유무와 무관, 없으면 클릭 시 cap으로 이동. prefix 동일성에 disabled 상태 포함 |
| R2 F3 거짓 코치 대기 | 수용 | 실제 formatReplay가 null coach를 pending으로 표현. feedback=omit 옵션과 보관함 양쪽 관점의 문구/학습 카드 부재 검사 |
| R2 F4 facts/projection | 수용 | facts는 원본 전체 모델로 계산 후 표시만 gate. renderer 원본 접근 제거, 단계 키로 행 갱신, focus/scroll 및 facts 동일성 검사 |
| R2 F5 중첩 DTO | 수용 | 설계 §5.4 필드/타입/필수 표. 미사용 assistance/힌트/딜 계열/선택 액션 필드를 새 보관함 응답에서 제외, 원본·기존 live 응답 보존 |
| R2 F6 호스트 미참여 | 수용 | startStacks에는 실제 딜 좌석만, endStacks에는 전체 세션 좌석이 존재. 참여 안 함/빈 내 패/권한 주체 user와 배치 기준 분리 |
| R2 F7 Windows rename | 구현 gate 수용 | engine/state.js의 Windows retry 확인. 활성 게임 저장과 보관함 반복 읽기를 겹치는 CI 회귀에 배정, macOS 결과로 대체하지 않음 |
| R2 F8 초기 커서 | 수용 | 재생 시작 위치가 결정 직전이면 첫 진입도 1회 통과하도록 고정 |

R2 신규 지적은 정적 파일/formatter/호스트 미참여 표면과 직전 수정의 제어/facts/DTO 정합 문제로 나뉜다. R3은 이 수정 경계의 한정 검증으로 진행했다. 문서 리뷰는 3라운드에서 종료하며, 새로운 구현 탐색은 P1~P6의 코드/테스트 증거로 다룬다.

## 직접 확인한 증거

- 브랜치: `Sungmin-Cho/replay-feature-design-review` → `Sungmin-Cho/replay-study-library`.
- 시작 HEAD: `b239dd72261070f8834ee36d3d7129f40f0fb546`. 시작 트리는 clean이었다.
- 기존 기준선: `node --test test/hand-replay.test.js test/replay-model.test.js test/replay-format.test.js test/replay-facts.test.js test/replay-size.test.js test/session-catalog.test.js test/drill-server.test.js` → **78 passed, 0 failed**, Node v26.0.0/macOS.
- 메모리 내 호환성 probe 2개 통과: synthetic 호스트 탈락 핸드의 buildReplaySteps 성공; 다음 startHand 이후 이전 lastHand 보존. 이 probe는 새 보관함 기능/실제 탈락 전체 여정의 증명이 아니다.
- probe 최초 시도는 테스트 입력에 participantId가 없어 BAD_CONFIG로 종료됐다. fixture 필수값을 채워 재실행했고 두 검사가 통과했다. 제품 결함으로 분류하지 않았다.
- model-router 최초 요청은 isolation을 잘못된 최상위 키에 넣어 exit 2였다. 문서/실제 schema에 따라 availability_snapshot.isolation으로 수정했다. 모델 실패/리뷰 라운드로 세지 않았다.
- 리뷰 중 각 소스 manifest를 재확인해 대상 파일 변경이 없음을 검사했다. 최종 설계·계획의 묶음 hash는 아래 증거 JSON에 기록한다.

## 구현에 이월하는 검증

이 항목들은 설계 미결정이 아니라 구현 후 반드시 통과해야 하는 인수 조건이다.

- 새 API의 인증/경로/예산/중첩 DTO/숨긴 정보 revision 비의존성 및 원본 게임·학습 파일 불변.
- 실제 브라우저 DOM·접근성의 결과/미래 정보 비노출, 전체 모델을 우회 조회하는 renderer 코드 제거.
- 타이머·늦은 응답 폐기, facts 동일성, live/참가자/관전자/legacy/드릴 회귀.
- 구 handler와 새 디스크 UI의 혼합 버전, 정적 import 전체 제공, 공식 학습 서비스 재기동.
- macOS 외 Node 20/22·Windows CI, 활성 저장 중 반복 reader의 Windows rename 회귀.

새 기능 코드는 아직 작성하지 않았고 신기능 인수/전체 suite/브라우저 여정/원격 CI를 통과했다고 주장하지 않는다. 다음 작업은 계획 P1의 읽기 reader부터 실제 risk를 재분류해 model-router 구현·검증 루프를 시작하는 것이다.

## R3 최종 지적 처리와 검토 한계

| 항목 | 처리 | 최종 반영 |
|---|---|---|
| F1 실제로 동작하는 재기동 안내 | 수용 | 서비스 종료 후 다시 열기 문구, 공식 study:stop 도움말, ensure 재사용 시나리오 |
| F2 관점 전환 소유권 | 수용 | 내→전체 커서 보존/정지, 전체→내 0/정지, cap 재생 비활성, 모델·facts 유지/컨트롤 영역 갱신 표 |
| F3 formatted view 우회 | 수용 | display header/seat/step/row/controls 닫힌 표, 상대 reasonKind·정책 범례/태그 전체 복기 전용, 미래 정책 액션 쌍 검사 |
| F4 공개 숫자와 결과 구분 | 수용 | 공개 현재 팟/보드 허용. 결과 객체의 awards/winner/endStacks/net 등 출처 기준, 숫자 단순 일치로 누출 오탐 금지 |
| F5 정상 파일 교체 | 부분 수용 | 안전한 leaf 교체를 확인해도 그 요청 데이터는 버리고 REPLAY_BUSY로 사용자 재시도. 자동 재시도로 읽기 예산을 늘리지 않음. 원 helper의 거부/링크 규칙 보존. 구현 경합 증거는 P1에 이월 |
| F6 구 앱/relay import | 부분 수용 | 공통 클라이언트는 기준 app/relay shared 교집합, 구 drill 폐포 불변. 새 보관함 전용 study STATIC까지 기존 study 목록의 교집합으로 제한하라는 부분은 기능 추가에 불필요하므로 채택하지 않음 |
| F7 optional 필드 실패 | 부분 수용 | decisions 항목 순서/수 유지·무효 leaf만 생략, 초과 note/reason만 생략. 유효 입력 live 패리티와 손상 입력의 두 보관함 관점 동일성을 구분. 손상 원본 live와 동일 출력은 보장하지 않음 |
| 혼합 버전 fixture | 수용 | 서버 생성 시 privileged static/capability seam, HTTP로 변경 불가, 작업 트리 파일/과거 Git history 의존 없음 |
| 핸드 페이지 예산/idle | 수용 | 32 MiB, visible heartbeat/pagehide 중단을 명시하고 주기·idle fixture는 현재 서비스 코드 기준 구현 gate |

마지막 reviewed target SHA-256: `e083520eba2a7c2bfd0461630b87f5d342011523cebc9940e75b27491a585158`.
현재 설계·계획 target SHA-256: `8cbd1affae2c3208ff457a08776b42f8cd4d4e186d2851f51b9bedfa010a0f24`.
해시 방법: 파일 경로 UTF-8 + NUL + 파일 바이트 + NUL을 design, plan 순서로 연결해 SHA-256.
두 값이 다르므로 R3의 판정은 마지막 작성자 수정본에 대한 독립 승인으로 재사용하지 않는다. 최종 수정본은 문서 링크/형식/상호 참조와 소스 근거를 작성자가 확인했다.

R3에서 critical/high 지적은 없었지만 medium 명확화와 구현 gate는 있었다. 위 계약을 구현으로 검증하기 전에는 제품 완료·검증 완료·배포 준비 완료로 판정할 수 없다.
