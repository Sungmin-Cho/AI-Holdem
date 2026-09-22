# JEV 구현 검증 기록

2026-09-22 · 구현·로컬 검증 완료. 브랜치 `feat/table-wide-jev`.

## 구현 범위

테이블 전체 JEV를 로비/legacy CLI에 추가했다. SDK 0.6.0과 `jev-1.13.0` 고정, 기존 policy 기본값 유지, 인간 좌석 유지. Node 내부 HTTP 플레이어이며 upper LLM 코치/리뷰와 분리한다. 공개 정보+행동자 패만 허용 목록으로 투영하고 이름/ID를 좌석 alias로 바꾼다. 후보는 엔진 legal을 따르며 금액은 코드로 계산한다.

신규 engine runtime/descriptor, internal restart journal, v3 pending, HTTP 중단/종료 확인, 명시 재시도, 크래시 reconciliation, private diagnostics, 참가자 전송 고지 및 UI를 포함한다. SDK 에러 원문/키는 sink에 보내지 않는다. active JEV store는 구버전으로 열지 않는다.

## 실제 provider 및 브라우저 플레이

- 계약 spike: 정상 합성 요청 1회, 전송 후 취소 1회. 정상 model/확률/usage 검증, 약 793ms. 취소는 약 30ms 내 로컬 settlement 확인. 별도 다중 후보 진단 1회 성공. 합성 요청 합계 3회.
- 첫 실제 브라우저 테스트: 7회 호출 후 `JEV_INVALID_RESPONSE`에서 복구 대기로 중단.
- 진단 재현: 4회 호출 후 동일 중단. HTTP 200 응답의 확률 합이 0.99임을 확인했다. 요청 상태/패/이름/키는 보고서에 저장하지 않았다.
- 저자 설계 보정: 모든 확률이 hundredth인 경우만 n×0.005+1e-6 합 오차 허용. 다른 정밀도는 기존 1e-6. 후보 key 집합·범위·confidence·model·usage·최대 선택 검증 유지. 정규화/자동 재시도/다른 플레이어 대체 없음.
- 보정 후 실제 플레이: 인간 1명 + JEV 2명, cash-training 2핸드 완료. 실제 JEV 10회 모두 HTTP 200. 두 AI actor(`seat_1`, `seat_2`) 확인. 응답 202–585ms, input 10,101/output 849 tokens. upper LLM은 비활성화하고 사실 기반 피드백을 사용했다. 게임 루프/앱/브라우저는 실제 경로다.
- 최종 수정본 실제 플레이도 인간 1명 + JEV 2명, 2핸드/10회 결정 모두 성공했다. 응답 212–611ms, input 9,524/output 706 tokens. 두 성공 실행 합계 4핸드/20회 결정이다.
- 플롭·턴·리버 합성 상태도 각 1회 실제 호출해 고정 모델/후보/응답 계약을 통과했다(225–608ms). 합성 요청 합계는 6회로 계획의 10회 상한 이내다.
- 실패 재현을 포함한 실제 플레이 호출은 총 31회(실행당 40회 상한), 계약 spike 포함 전체 원격 요청은 37회(취소 포함). 기존 `game/` 해시 불변, 전용 임시 store와 소유 서비스/브라우저 종료 확인.
- 로컬 증거: `output/playwright/jev-live-verified/result.json`, `jev-lobby.png`, `jev-completed.png`, `output/playwright/jev-live-final/result.json`, `output/playwright/jev-street-smoke/result.json`. 최초 실패와 진단도 별도 디렉터리에 보존했다. API 응답의 비밀정보 없는 결과와 원본 파일 해시는 [실제 API 증거](jev-player-live-evidence.json)에 포함했다. 보고서의 원격 성공은 포커 승률/solver/GTO 품질 증명이 아니다.

## 자동 검증

- pure projection/candidate/response, 실제 설치 SDK fake-fetch serialization/abort/no-retry/log privacy tests.
- 앱 start/pause/end-without-key/restart descriptor, AI-zero preflight=0, 잘못된 descriptor의 mutation 전 거부, byte/count bounded diagnostics, 손상 config explicit End.
- loop 전체 핸드, 두 AI alias, loop-state 유실, soft interrupt/명시 retry/fresh 거부, hard timeout, closure-unconfirmed와 late settlement, crash running/unsafe/retry-authorized/proposed/applied, pause exactly-once/stop zero-apply.
- `npm run benchmark:policies`: PASS.
- `npm run test:lobby:browser`: PASS.
- `npm run test:multiplayer:browser`: PASS.
- `node test/browser/jev-journey.mjs --out-dir output/playwright/ui-journey/jev`: PASS. fake HTTP의 soft wait → cancel → retry → key-free End, privacy 및 사용자 store/cleanup 확인. 외부 API 0회.
- 최종 수정본 `npm run test:ui:browser -- --ci`와 JEV recovery browser 재실행: PASS.
- Node 20 실제 SDK/runtime/projection/session 관련 13개 테스트: PASS.
- 최초 `npm run test:ci`: 2,888 tests, 2,881 pass, 7 fail. 새 runtime 저장 필드로 기존 fixture 2개, 잘못 확장한 pause/stop abort 분기(부모 포함 3개), opt-in live script를 CI journey로 발견한 2개였다. fixture를 명시하고 abort를 JEV stop에 한정했으며 opt-in 스크립트를 `jev-live-play.mjs`로 분리했다. 영향 테스트 재실행 PASS. 최초 실패 로그는 `/tmp/jev-test-ci.log`에 보존했다.
- 두 번째 전체 실행: 2,913개 중 2,911 PASS, 두 기대값 목록 실패(복구 종료 코드/Windows loop-b 분할). 실행 도중 수정된 fixture여서 해당 실행에는 반영되지 않았다. 두 테스트의 수정본 별도 검증 PASS, 원 로그 `/tmp/jev-test-ci-final.log` 보존.
- R3 수정 후 JEV recovery browser 재실행: PASS (`output/playwright/ui-journey/jev-reviewed`).
- 수정본 `npm run test:ci`: **2,919 PASS / 0 FAIL**, 약 1,214초 (`/tmp/jev-test-ci-clean.log`). 실행 중 R3의 마지막 stop 수정이 들어갔으므로 해당 공통 game-loop와 JEV session은 최종 코드로 **496 PASS / 0 FAIL** 별도 재실행했다. JEV 수정 테스트 27개와 browser도 최종 코드로 재실행 PASS.
- 원격 Linux Node 20/22, Windows Node 20/22 8 shards, publisher, UI browser, study lifecycle benchmark 결과는 이 브랜치 PR의 GitHub checks가 정본이다. 모두 성공한 뒤 병합한다. 이 로컬 보고서만으로 미실행 OS 성공을 주장하지 않는다.

## 독립 코드 리뷰 및 저자 판정

`deep-model-router:model-router` 1.14.0, HIGH, author gpt-6-astra 제외, Opus 5 + Sol 독립 subprocess, tools disabled, 같은 artifact hash, Darwin receipt guard를 사용했다.

R1: Opus는 600초 timeout, 종료 확인. Sol은 실제 지적을 반환했지만 저자 프롬프트가 `REQUEST_CHANGES`를 허용하여 router 판정 문법(PASS/PASS_WITH_CHANGES/FAIL)에 맞지 않아 INVALID_OUTPUT. 둘을 유효한 완료 판정으로 집계하지 않는다.

Sol의 내용 중 다음은 저자가 재현 가능한 결함으로 수용했다.

1. **수용:** 엔진 적용 성공 후 CLI 응답 유실에서 closeConfirmed=false로 바뀌면 기존 reconcile 조건이 이미 적용된 액션을 놓침. v3는 정확한 엔진 action 증거로 정리하고 HTTP closure와 engine receipt를 구분했다. applied proposal crash 테스트 추가.
2. **수용:** 손상 recovery record에 retryable=true와 proposedAction이 함께 있으면 재추론 가능. pending semantic validator와 retry/dispatch 양쪽에서 막았다.
3. **테스트 수용:** 각 후보 수에서 확률 반올림 허용/거부 상한 검사.
4. **증거 보완:** R1 bundle에 누락했던 package-lock을 R2에 포함.
5. 합계 반올림 보정 자체는 Sol도 수학적으로 허용 가능한 범위로 평가했다. 정책 선택의 최종 책임은 저자에게 있다.

R2: 두 좌석 모두 유효한 receipt와 종료 확인. Sol FAIL(confidence 0.96), Opus PASS_WITH_CHANGES(0.72). 판정을 그대로 승인으로 취급하지 않고 아래처럼 결정했다.

- Sol의 자동 stop 정리 금지 요구는 **기각**: 설계 §6.1은 이미 요청된 stop의 전체 cleanup 재실행을 요구한다. 명시 재시도가 필요한 것은 추론/액션이며 shutdown 완료와 다르다. 다만 stopPromise/cleanupError 기록 사이의 race는 **수용**하여 실패한 stopPromise settlement를 먼저 기다리도록 고쳤다. 락 유지→late settle→전체 cleanup→락 해제, 액션 0 테스트 PASS.
- Opus의 ENGINE_APPLY_UNCONFIRMED 막다른 길 지적은 **수용**: HTTP 미확인은 계속 모든 플레이 제어를 막지만, 엔진 제안 불확실성은 명시 End만 허용한다. 기존 엔진 end transaction이 stateVersion을 진행하고 hand를 비우므로 뒤늦은 old expect-version step은 종료 뒤 적용할 수 없다. 재시도/새 게임 허용은 추가하지 않았다.
- 취소와 runtime 선택 경합은 일반 경로에서 제시된 그대로 재현되지는 않았지만 **부분 수용**: 제안 이전 취소는 INTERRUPTED/retryable로 명시 분류했다. unsafe/제안 이후를 덮어쓰지 않는다.
- optional diagnostics 손상이 모든 lifecycle write를 막는 문제는 **수용**: 진단만 격리 리셋하고 historyIncomplete와 quarantine log를 남긴다. 종료/락 해제 테스트 PASS.
- 알 수 없는 archetype의 retryable 변환은 **기각**: 생성기는 동일한 6개 enum을 사용하며 손상 입력은 설계상 nonretryable/End다. 이름이나 다른 플레이 스타일로 대체하지 않는다.
- 제안 뒤 VERSION_MISMATCH 자동 resync는 **보류/기각**: 보수적으로 엔진 불확실성으로 남기고 End-only 또는 소유자 종료 후 reconciliation을 사용한다. 이전 차례를 자동 재추론하지 않는다.
- undocumented resume({opponentRuntime}) 인자 요구는 **기각**: 공개 resume 인자는 skipLock이고 실제 CLI/launcher의 explicit opts는 교차검사된다.
- cannot-check/zero-call 후보 상태는 **수용**하여 입력 오류로 거부한다.
- settled=null 경합은 두 대입 사이 await가 없어 도달 불가, 타이머는 settlement/finally에 정리된다. unref 제안은 단독 pending 작업을 사라지게 할 수 있어 **기각**.
- client 재생성이 연결 풀을 없앤다는 주장은 global fetch pooling과 다르므로 **기각**. 진단 비용 최적화는 256 KiB 상한이 있고 관측 성능 결함이 없어 보류한다.
- resume preflight 강제는 **기각**: 키/SDK 부재가 게임 복원과 End를 막지 않게 첫 결정에서 안전한 복구 오류를 남기는 설계다.

R3: 위 판단과 수정된 코드/계약을 동일 artifact로 두 독립 좌석에 전달했다.

- Sol FAIL(0.94)의 복합 stop 오류 소실 지적은 **수용**: JEV close 미확인 뒤 다른 cleanup 실패가 있어도 첫 코드만 남던 경로를 보정했다. 각 stop 시도의 모든 오류 코드를 보존하고, 동일 시도에서 JEV closure 오류 단독임을 확인한 경우만 late observer가 전체 cleanup을 재실행한다. compound failure 주입에서 자동 재시도 없음/락 유지/오류 보존 및 명시 stop 재시도 뒤 로그 이력 유지 테스트 PASS.
- canCheck=true/callAmount>0의 상호 모순은 **수용**하여 후보 생성 전에 입력 오류로 거부한다. 실제 엔진은 이 조합을 생성하지 않지만 경계 검증을 강화했다. raise 범위는 short all-in(min>max)이 합법인 기존 계약을 유지한다.
- 마지막 수정 관련 27개 테스트 PASS. 변경된 공통 stop 경로의 기존 game-loop 전체 + JEV session 테스트 496개 재실행 PASS(약 533초).
- Opus PASS_WITH_CHANGES(0.62). 조건부/유지보수 제안은 아래처럼 실제 구현을 대조했다.
  - legacy runtime: **기각**. `requestedOpponentRuntime`은 기본 llm이고 `opponentRuntimeOf()`는 loop 값 또는 그 기본값을 반환한다. resume은 별도로 legacy resolver를 거쳐 resolver/restore 전에 runtime을 기록한다. `undefined`를 반환한다는 전제가 성립하지 않는다. 기존 fixture 두 수정은 새 명시 config의 정확한 비교/의도적인 policy 설정을 반영한 것이다.
  - CLI 대기 무한정 주장: **기각**. 발췌에 없던 runJsonChild는 execFile timeout(기본 60초)을 적용하며 현재 엔진은 SIGTERM을 무시하는 런타임이 아니다. 이미 소유한 atomic step은 정리 전에 settlement를 기다리는 기존 계약을 유지한다. 커널 수준 비정상 stall을 정상 shutdown 증거로 간주하지 않는다.
  - 좌석/성향/position 불일치: **기각**. normalizeSetup은 AI≤8·totalSeats≤9, 엔진 ARCHETYPES는 정확히 같은 6개, positionsOf는 현재 allowlist에 포함되는 label만 생성한다. 미지원 손상 입력을 임의 보정하지 않는다.
  - decisionId 포맷 공유: **유지보수 이월**. 현재 엔진 hand/decision 두 경로도 같은 포맷이며 실제 late-settlement 테스트가 동일성을 검사한다. 포맷 변경은 향후 저장 계약 변경으로 함께 다뤄야 한다.
  - 상대 경로 init: **기각**. 실제 CLI parser와 session-catalog가 경로를 resolve하며 prepared stagingDir은 절대 경로다. initializer를 문서화되지 않은 상대 경로로 직접 호출하는 확장은 범위 밖이다.
  - config 파일 오류 코드: **기각**. 앱/재시작은 validateJevConfig로 먼저 전용 오류를 내고, internal CLI의 잘못된 파일은 usage로 mutation 전에 거부한다.
  - 임의 SDK 생성 예외의 retryable 변환: **기각**. 실제 고정 SDK import/키 부재는 전용 retryable 코드이며, 나머지 프로그래밍/입력 오류에 반복 호출을 권하지 않는다. 키/원문 오류는 노출하지 않는다.
  - origin 거부 세분화: **이월**. 네트워크 오류로 분류되어도 redirect/origin 차단은 실제 테스트로 보장된다. SDK 임의 error.code를 신뢰해 통과시키는 제안은 수용하지 않는다.
  - diagnostics historyIncomplete: **기각**. 정상 절단은 정확한 dropped로, 손상은 손실량이 알려지지 않아 historyIncomplete로 구분한다. 전체 256 KiB 예산 내 성능 캐시는 관측 문제 없어 이월.
  - proposedAction 후 자동 복구/재시도: **기각**. 엔진 적용 불확실성의 보수적인 End-only 정책을 유지한다.
  - 추가 오류 문면: **이월**. HTTP 미확인/엔진 미확인/입력 오류는 실제 pause-message에 한국어 안내가 있고 일반 실패도 AI 복구 메시지로 표시된다. HTTP API 코드는 진단에 보존한다.
  - resume({opponentRuntime}) 항목: **기각**. 실제 resume의 인자는 skipLock이며 bootstrap과 혼동한 지적이다.

R2/R3 모두 `verify-evidence --require-receipt-guard --expect-fingerprint --expect-models` exit 0. R3 유효 판정은 FAIL + PASS_WITH_CHANGES이며 이를 두 승인으로 바꾸지 않는다. 저자는 재현 가능한 Sol 지적 두 건을 마지막 수정과 테스트로 해소했고, 조건부 Opus 지적을 위 증거로 판정했다. 리뷰 3라운드 후 추가 리뷰를 무한 반복하지 않으며 마지막 수정은 저자의 회귀 테스트 및 최종 CI로 검증한다. 원본 응답/receipt/수정 파일 해시는 [코드 리뷰 증거](jev-player-code-review-evidence.json)에 보존한다.
