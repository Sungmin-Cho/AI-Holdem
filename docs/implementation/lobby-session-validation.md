# 웹 로비 구현 검증

로컬 구현·동작 검증 완료: 2026-09-09. 브랜치 `feat/web-lobby-session-controls`, 설계 기준 `cb838484c967f59133bd45ca34fa03c2bdab0a84`.

## 실행 근거

- 최초 전체 `npm run test:ci`: 2,213 PASS / 1 FAIL. 신규 relay 액션 게이트 import를 계층 가드에 명시하지 않은 실패였으며, 제어 게이트 named binding만 허용하도록 수정했다(최종 `withActionGate`/`retryControlWrite`).
- 두 번째 전체 `npm run test:ci`: 2,222 PASS / 0 FAIL. 리뷰 수정 후 최종 전체 검증은 **2,240 PASS / 0 FAIL / 0 SKIP**, 약 740초(Node v26.0.0). 중간 실행 1회는 async 선언 수정 중 실행되어 문법 오류로 실패했고, 선언을 수정한 고정 코드로 전체 재실행해 통과했다.
- `npm run benchmark:policies`: PASS. 정책 응답·프리플랍 grid·안전 시나리오 assertion 통과.
- `node tools/build-preflop-baseline.js --check`: PASS, v2 digest `1147b530a398c0b424379689d966d9be1fb60b665600b2600993689212fe02f7`.
- 실제 Chromium `agent-browser@0.36.0` 여정: 13개 필수 항목 PASS. cash AI5, pause/resume, 메뉴 닫기/Escape, 설정 복귀, 모바일 360px, 새로고침, 학습 창 왕복, 새 gameId 재시작, tournament AI8, abort 요약, cash AI1 자연 완료와 완료 기록 재열람, 실사용 store 불변, 소유 프로세스/임시 store 정리. 테스트 실행 중 모바일의 긴 폼 클릭을 브라우저 CLI가 실제 클릭 없이 성공 처리하는 문제가 있어 명시 scrollIntoView 뒤 물리 클릭으로 수정했다. 애플리케이션 submit을 우회하지 않는다.
- 실제 LLM smoke: 선택 사다리의 최종 runtime **codex**, outcome **accepted**, model round 약 5.73초, 전체 준비/판단/종료 약 39.0초. 강제 기본 행동이 아닌 LLM 응답 1건의 엔진·게시 반영 후 pause에서 tree hash 불변, `aborted` 종료와 owned cleanup 확인. 격리 임시 store만 사용했다.
- ESLint/Stryker는 설치되지 않은 센서이며 PASS로 기록하지 않는다.

## 리뷰와 채택 판단

model-router HIGH, 저자 가족 OpenAI 제외. Claude Opus 5와 Claude Fable 5.1을 별도 tool-free CLI 세션으로 배정했다. 두 reviewer는 같은 Claude 제공자이며 교차 제공자 리뷰라고 주장하지 않는다.

1차 실행은 600초 timeout 2건, 종료 확인 true, substantive verdict 없음. 짧은 연결 재검사 두 모델 모두 성공했다. timeout receipt와 recovery probe hash를 RouteRequestV1 `attempt_outcomes`에 넣고, 395KB 입력을 156KB 관련 코드로 줄여 재배정했다.

2차 substantive 결과는 두 건 모두 PASS_WITH_CHANGES였다. 다만 fenced YAML 및 숫자가 아닌 confidence 때문에 supervisor 상태는 INVALID_OUTPUT이며 이 결과를 최종 승인 증거로 사용하지 않는다. 내용은 다음과 같이 검증했다.

| 지적 | 판단과 반영 |
|---|---|
| 제어 락 경합이 pause/run 실패로 전파 | 수용. loop 측 async bounded retry, relay 측 503 유지. 실제 lock을 80ms 잡는 회귀 테스트. |
| bootstrap 실패 후 current 캐시/CAS 불일치 | 수용. 실패 시 selector 재조회와 상태 재판정. 실패 후 resume 성공 테스트. |
| error에서 유효한 메뉴가 사라짐/`stopped` 유출 | 수용. terminal/playing/paused/외부 소유 상태 재판정, pause 결과 allowlist. |
| 마지막 handOver 중 pause 미해소 | 수용. finalization 진입 전 pause 요청을 finalizing으로 해소. |
| 앱 종료가 pending부터 무기한 기다림 | 수용. 기동 중 loop도 추적하고 stop을 먼저 요청한 뒤 bounded settlement. **시간 초과에도 락을 무조건 풀라는 제안은 기각**: 미확인 자식과 소유권을 보존한다. |
| managed wait에서 relay 회복 경로 누락 | 수용. 비제어 fetch 실패를 기존 waitError/recoverServerForPublish 경로로 연결. |
| proxy backpressure 중 disconnect 대기 누수 | 수용. drain/close/error 경쟁과 listener 정리. |
| SSE 재접속 after=0 | 수용. 마지막 event ID를 재접속 cursor로 사용. 기존 app.js의 revision 중복 제거는 이미 존재했다. |
| committed game에 loop-state가 없으면 resume 실패 | 가정에 근거한 코드 변경은 기각. 재현 테스트에서 동일 gameId/token을 재초기화 없이 paused로 복원함을 확인. |
| aborted 복원 시 모델 호출/정리/상태 일관성 | 수용. 별도 abort lifecycle, 모델 probe 0회 테스트, 잔여 relay identity 확인 후 정리. |

3차는 두 좌석 모두 SUCCEEDED / PASS_WITH_CHANGES(신뢰도 0.60 / 0.72)이며 모델·fingerprint·Darwin receipt guard를 지정한 verify-evidence가 exit 0으로 확인했다. 원문과 receipt는 `lobby-session-implementation-review-evidence.json`에 보존한다. 이는 무조건 PASS가 아니며, 최종 수정의 종결 판단은 아래 재현 및 회귀 증거에 근거한다.

| 3차 지적 | 판단과 검증 |
|---|---|
| 종료 실패 promise 재사용과 처리되지 않은 rejection | 수용. 재시도 가능한 close와 rejection 처리. 정리 미확인 시 락/리스너 보존 후 재시도 성공을 테스트했다. 무조건 finally에서 소유권을 해제하는 제안은 기각했다. |
| stop 60초와 manager 120/300초 한도 불일치 | 수용. 플랫폼별 125/305초로 정렬했다. |
| 외부 소유 종료 후 external 상태 고착 | 수용. 소유 프로세스 종료가 확인되면 current를 재조회하고 상태를 재판정한다. 실제 소유자 종료 테스트. |
| 이전 미완료 abort 감사 파일이 새 종료를 차단 | 수용. 이전 operation 감사 자료를 보존하고 새 종료를 진행한다. 재시도 및 동일 operation 멱등성 테스트. |
| 완료 기록 iframe이 inert라 상호작용 불가 | 수용. 기록 열람에서는 inert 해제. 실제 브라우저에서 리뷰 닫기 버튼 물리 클릭 확인. |
| relay 제어 락 경합 | 수용. 250ms bounded retry 안에서 decisionId 재검증. 80ms 경합 후 접수 액션 정확히 1회 반영 테스트. |
| 상태 재판정 예외가 journal 장애로 오분류 | 수용. 재판정 실패를 안전한 error로 격리했다. |
| aborted 복구 중 bootstrap loop 추적 누락 | 수용. 동일 onLoop 추적으로 종료 소유권을 유지한다. |
| 재접속 재전송 4xx가 pending에 남음 | 수용. 확정 4xx에서 pending 해제, 409 회귀 테스트. |
| 복구 pause 결과 무조건 paused 처리 | 수용. paused/finalizing 결과만 허용한다. |
| pause drain 중 relay 실패 회복 누락 | 수용. 기존 relay 회복과 view-only sync를 한 번 수행하고 재시도한다. 실제 소유 relay 종료 후 pause 복구 테스트. |

브라우저 및 실제 LLM의 비밀 없는 결과는 `lobby-session-runtime-evidence.json`에 보존한다. 기본 start-game 스킬과 기존 계약/계층 테스트 37개, CLI prefill 포함 서비스 테스트 4개도 통과했다.

## 테스트 구성

기존 테스트 파일을 재사용하고 가까운 시나리오를 묶었다. 계획의 pause/race/abort 사례는 `test/session-controls.test.js`, launcher/저널/commit recovery는 `test/app-command-store.test.js`, HTTP 보안은 `test/app-server-security.test.js`, 실제 서비스 경로는 `test/app-service.test.js`가 담당한다. `test/lobby-command-client.test.js`는 응답 유실과 reload의 동일 요청 재전송을 확인한다. Windows CI에 `npm run test:lobby:windows`를 별도 필수 step으로 추가했다. Windows 전체 suite를 실행했다고 주장하지 않는다.

## 한계와 계약

파일 fsync와 원자적 rename은 프로세스 중단 복구를 대상으로 한다. 전원 손실까지 견디는 디렉터리 fsync 기반 transaction 보장은 이번 계약에 포함하지 않는다. 명령 복구는 기존 current와 예약 identity의 CAS를 유지하고, 불완전한 준비 자료는 삭제하거나 재초기화하지 않는다. 기본 정책의 분석 수치는 실력·수익·GTO 정답을 증명하지 않는다.
