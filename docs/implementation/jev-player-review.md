# JEV 설계·구현 플랜 독립 리뷰 및 작성자 판정

날짜: 2026-09-22 · 상태: READY_FOR_IMPLEMENTATION · 제품 코드 미구현
대상: [설계](jev-player-design.md), [구현 플랜](jev-player-plan.md)
기준 코드: `3a647c09780afe2971b7a4bf3097b52002db151c`

## 권한과 범위

사용자가 요청한 테이블 전체 JEV 모드의 설계와 구현 플랜만 작성했다. 제품 코드, 의존성, 게임 데이터, 실제 게임 프로세스, Git commit/PR은 변경하지 않았다. 구현 착수 및 실 API 호출은 이번 단계에 포함하지 않았다.

## 리뷰 방법

명시적으로 요청된 model-router 1.14.0을 사용했다. 분류 REVIEW: complexity=2, uncertainty=1, blast_radius=2, reversibility=1, security_sensitive/data_integrity_sensitive/concurrency_sensitive. risk=9 HIGH, execution=8 EASY. 이는 작업량과 별개로 데이터·복구 경계 때문에 강한 리뷰가 필요하다는 분류다. routing confidence=0.95; 저자 gpt-6-astra는 review_context에서 제외했다.

라우터가 배정한 두 좌석만 실행했다: claude-opus-5 HIGH, gpt-5.6-sol HIGH. 별도 비대화형 프로세스·새 세션·동일 artifact/코드 발췌, 도구 비활성화로 서로의 결과를 읽지 못하게 했다. Claude bridge는 같은 세션에서 실제 minimal probe 성공을 확인했다. Sol은 호스트 제공 모델 카탈로그 및 실제 리뷰 성공으로 확인했다. Grok은 이 리뷰에서 bridge 가용성을 확인하지 않아 후보에서 제외했다.

각 호출은 공식 dispatch_agent.py의 600초 deadline과 darwin-sandbox-v1 receipt guard를 사용했다. raw CLI 출력 전체를 제품 저장소에 복제하지 않고 [증거 JSON](jev-player-review-evidence.json)에 라우트·prompt/target hash·판정·시간·종료 및 guard 증거·리뷰 본문을 보존한다. receipt guard는 리뷰 기록 보호이며 공급자의 내부 모델 실행 방식에 대한 보장이 아니다.

## 1차 결과와 판정

- Sol: 유효한 PASS_WITH_CHANGES, confidence 0.91.
- Opus: 본문은 PASS_WITH_CHANGES였지만 fenced YAML 출력으로 supervisor가 INVALID_OUTPUT/schema_invalid 판정. **유효한 리뷰 완료나 승인으로 계산하지 않는다.** 아래 지적은 재검증할 후보로만 사용했고 소스/SDK와 대조했다. fresh 프로세스에서 수정본을 재검토하며 출력 형식도 교정했다. 이를 모델의 구현 실패로 입력하지 않았다.

| 출처 | 내용 | 작성자 판정·반영 |
|---|---|---|
| Sol F1 / Opus F4 | legacy config 및 런타임 fallback 모호 | 수용. config 객체가 아니라 opponentRuntime 필드 부재를 기준으로 정확한 우선순위·충돌 표 작성. 835/7513/7692 분기 교체 지점 특정 |
| Sol F2 | live SDK 계약 검증이 P6에 너무 늦음 | 수용. P3 직후/P4 이전 최대 2회 합성 계약 spike, 실패 시 통합 중단. 총 10회 요청 예산에 포함 |
| Sol F3 / Opus F2–F3 | dispose ownership·abort 미종료 처리 | 수용. runtime 상태기/동시 1요청, loop 소유 dispose, 2초 settlement grace, 미확인 시 unsafe·적용 권한 폐기·락 유지·새 게임/재시도 거부. 프로세스 사망 확인 후 복구 |
| Sol F4 | 합성 좌석 ID 규칙 | 수용. 안정된 좌석 순서 seat_N map을 actor/seats/actions에 일관 적용. 기존 엔진 action의 실제 playerId를 삭제하라는 의미로 확대하지 않음 |
| Sol F5 | pause 테스트 oracle 모호 | 수용. 기존 소유 결정 1회 적용/게시 후 paused; interrupt/stop은 적용 경계 전 0회 |
| Opus F1 | !policyMode 분기 영향 목록 | 부분 수용. 이미 JEV upper-only/pace/metric 경로는 설계에 있었으나 구현 체크리스트가 추상적이었음. 능력 표와 코드 지점 추가. 광범위 공통 런타임 프레임워크는 도입하지 않음 |
| Opus F5 | descriptor producer→engine 전달 | 수용. 공유 상수/closed validator, 제한된 --jev-config-file, server command row→launcher→engine 최초 commit, restart 고정 명시 |
| Opus F6 | private 진단과 공개 metrics 혼동 | 수용. 별도 loop-state.jevDiagnostics와 cap/dropped 규약, 공개 summary/API/SSE/replay/export 제외, loop.log에 분포 중복 저장 금지 |
| Opus F7 | 확률/신뢰도 오류는 무시하고 선택 실행 | 제안한 완화는 기각. 공식 Choice 응답의 필수 필드가 깨지면 전체 요청을 거부하는 것이 선택한 계약. 그 가용성 비용을 설계에 명시하고 합 오차는 live gate에서 확인. unknown은 optional usage에만 허용 |
| Opus F8 | docs/design로 이동해야 함 | 기각. .gitignore가 해당 폴더를 제외하는 사실은 docs/implementation에 설계 문서를 금지한다는 근거가 아니다. 현재 AGENTS/CLAUDE에 금지 규칙 없음, 같은 위치의 기존 설계/플랜 확인. 의도적 프로젝트 산출물 위치와 미커밋 상태 명시 |
| 작성자 SDK 검사 | debug 환경에서 원격 본문이 로그에 출력 | 수용. 명시적 logLevel:off+no-op logger, baseURL/model/key 설정 통제, debug 환경 canary 테스트 추가 |
| 작성자 CI 검사 | dependency-free CI에는 설치 단계 없음 | 수용. SDK를 사용하는 CI job에 npm ci, Windows shard 테스트 배정 명시 |

리뷰어의 major/minor 표기는 기록 본문에 그대로 보존하되 처리 우선순위는 위 내용으로 직접 판단했다. verdict token을 자동 승인으로 사용하지 않았다.

## 검증 사실과 구현 게이트

설치된 JS SDK 0.6.0을 직접 import하여 합성 apiKey와 fake fetch로 검사했다. 실제 네트워크 요청은 0회다. systemOne Choice 요청 직렬화/응답 parsing, 명시 model 전달, logLevel=off, AbortSignal→fake fetch abort→APIUserAbortError가 확인됐다. 이는 API key 유효성·실 socket 종료·모델 전략 품질을 증명하지 않는다.

문서 로컬 링크와 whitespace를 확인했다. 제품 코드가 변경되지 않았으므로 전체 npm 테스트나 실제 브라우저 게임은 실행하지 않았다. P1–P6의 테스트, 실제 API 계약 spike, 코드 독립 리뷰는 구현 인수 게이트로 남긴다.

## 2차 결과와 판정

두 좌석 모두 SUCCEEDED/PASS_WITH_CHANGES(Opus 0.76, Sol 0.91). fingerprint/model/count/guard를 지정한 verify-evidence가 exit 0으로 완료됐다. 각 결과는 정상 프로세스 종료가 확인된 별도 세션의 판정이다.

| 출처 | 내용 | 작성자 판정·반영 |
|---|---|---|
| Sol JEV-001 | 입력 오류 전에 durable pending이 없고 단일 후보의 commit 순서 불명확 | 수용. engine envelope identity로 fallible peek/projection 전에 pending commit, 단일 후보도 proposedAction/atomic expect-version/reconcile 경로 공통 |
| Sol JEV-002 / Opus F3 | 종료 미확인의 수렴/운영 출구 | 수용. trusted closure observer만 late settlement 후 동일 identity/락/엔진 차례를 검사해 recovery로 전환. stop은 closure 전용 실패 latch를 재시도하고 전체 cleanup 수행. 영구 미종료는 앱 서비스 stop→검증된 소유 PID 종료→사망 검증→앱 재개의 운영 안내, 락 삭제 금지 |
| Sol JEV-003 | 참가자에게 원격 처리 고지 | 수용. 입장 전 일반 고지와 잠긴 setup의 실제 aiProvider 표시. 새 동의 체크박스나 권한 체계는 추가하지 않음 |
| Opus F1 | 입력 크기 오류의 의미 없는 반복 재시도 | 수용. 결정론적 입력 오류는 retryable=false 및 End만 허용. 실제 24 KiB 초과 때 silent truncation/fallback은 하지 않음 |
| Opus F2 | softWait 이전 interrupt 의미 | 수용. 기존 게이트 승계: 25초 전 no-op/버튼 숨김, 이후 host interrupt. pause/stop은 별도 계약 |
| Opus F4 | 문서 위치 재지적 | 기각 유지. 새 코드 근거 없는 비차단 선호이며 파일 작성 위치는 사용자 승인 범위. 커밋을 실행하지 않았다는 실제 상태로 확인 |

v3 UI projection(기존 CLI diagnostics와 혼동 금지), 입력/단일 후보 crash, late settle/영구 stall, 참가자 고지 테스트를 P4/P5에 반영했다. 2차 신규 지적은 대부분 직전 문면의 복구 경계 명확화였으므로 최종 검토는 해당 변경 범위로 한정한다. 문서 수정을 무한 반복하는 대신 구현의 기계 검증 게이트로 넘긴다.

## 최종 결과

3차 최종 범위 검토: Sol **PASS**, Opus **PASS_WITH_CHANGES**(0.72). Sol은 confidence를 숫자 대신 `high`로 반환했으며 숫자로 변환하지 않았다. 양쪽 모두 supervisor SUCCEEDED·정상 종료 확인, fingerprint/model/count/receipt guard 검증 exit 0. 원격 SDK 미검증은 이미 P3 게이트이므로 두 리뷰 모두 설계 준비를 막는 불확실성으로 분류하지 않았다.

최종 작성자 판정:

- Opus F1의 “기존 resync는 pending을 모른다”는 결함 주장은 **기각**. 실제 tools/game-loop.js:7965–7975는 VERSION_MISMATCH 후 step 조회, 7969에서 pending 제거, view 재게시를 이미 수행한다. 발췌에 해당 catch가 빠져 생긴 오판이다. 설계에는 기존 경로 재사용 및 자신의 running identity/HTTP 미시작/proposed 없음 guard, SDK 0회 회귀 테스트를 명시했다. 일반 identity 불일치 기록의 무차별 삭제는 허용하지 않았다.
- Opus F2는 **수용**. §4의 요약 데이터 흐름을 이미 확정한 §6/P4의 pending-before-projection 순서에 맞췄다.
- Opus F3는 **명확화 수용**. 기존 running 예외를 괄호 대신 상태별 validator 계약으로 적었다. running에서는 retryable 부재 허용, 그 외 boolean 필수. durable write 실패와 running crash fixture도 명시했다.

마지막 반영은 기존 원칙의 문면 정합·테스트 oracle 명확화다. 새 기능/복구 메커니즘은 추가하지 않았다. 3차 판정 이후 이 소규모 수정은 작성자가 직접 검증했고 추가 독립 리뷰는 실행하지 않았다. 리뷰 대상 hash와 최종 파일 hash의 차이는 evidence JSON에 별도로 남겼다. 따라서 “두 리뷰어 모두 최종 파일에 PASS”라고 주장하지 않는다.

**작성자 최종 상태: READY_FOR_IMPLEMENTATION.** 미해소 설계 blocker나 사용자 결정 대기 없음. P1→P2→P3(실 API 계약 gate)→P4→P5→P6 순서로 구현할 수 있다. 실제 API 연결, SDK의 실 네트워크 종료, 코드 회귀 및 플랫폼 검증을 완료했다는 뜻은 아니다. 구현 코드는 아직 작성하지 않았다.
