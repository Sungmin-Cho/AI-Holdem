# #147 설계·플랜 검증과 구현 준비

2026-09-08. **문서 단계 기록이며 기능 구현 완료 보고가 아니다.**

## 작업 기준

- 시작 워크트리: `/Users/sungmin/Dev/AI-Holdem/.worktrees/AI-Holdem/yabby`.
- 시작 branch/HEAD: `feat/preflop-reference-coverage-v2` / `7868f8d4e0455c3ff8fcd6e7aaa2749b6bbf260a`. tracked/untracked 변경 없음.
- `git fetch origin main` 후 `6bc286ae1671d30e90f71e104439520736b5f51f`에서 `feat/pre-action-hints-147`을 생성했다. 새 branch의 upstream은 아직 설정하지 않았다.
- PR #161은 MERGED, merge SHA `85665e3b2efcfa4dcf3d8ae0f2dede8c2a44573b`, mergedAt `2026-09-08T04:18:10Z`. 최신 기준은 이후 #162/#163도 포함한다.
- 이슈 원문/댓글, issue-150 design/plan/validation, 관련 위키 3개 및 현재 engine→sidecar→relay→training→profile/tendency source를 검토했다.

## 위키 증거 경계

`wiki-query`의 `wiki-runtime.js index read`가 기존 `TRANSACTION_RECOVERY_REQUIRED`(terminal scan-window prune quarantine)로 실패했다. 복구·수정은 하지 않고 아래 page 본문을 직접 읽었다. 본문 내용은 현재 소스와 대조했고, 정상 카탈로그 snapshot을 읽었다고 주장하지 않는다.

- `ai-holdem-issue-150-reference-v2-2026-09-08.md`: pure query, 99개 native 상황, 투영 비채점, full source pin, legacy preservation.
- `ai-holdem-gto-training-2026-09-01.md`: #21 사후 게시 경계, engine snapshot 소유, source/evaluation/LLM 역할 분리. 과거 지원 범위는 #150 현재 소스가 우선한다.
- `ai-holdem-issue-144-self-opponents-2026-09-08.md`: profile을 거치지 않는 raw hand 성향 추출, 최소 60핸드, derived policy identity와 resume 계약.

## 현재 실행한 검증

```sh
node --test test/preflop-reference.test.js test/reference-source.test.js \
  test/reference-coverage-authority.test.js test/policy-layer-boundary.test.js
```

기준 main에서 20 tests / 20 pass / 0 fail, exit 0. 기존 사전 API·출처·coverage·정책 경계만 검증한 결과다. 신규 힌트 구현/브라우저 여정/전체 suite/Node 20·22/Windows 검증은 실행하지 않았다. ESLint/Stryker는 미설치다.

## 리뷰 방법

`deep-model-router` 1.14.0의 기존 artifact REVIEW 경로를 사용한다. 분류 c=2/u=1/b=2/r=1 → risk 9 HIGH, execution 8 EASY, flags data_integrity_sensitive/concurrency_sensitive/public_api_change, confidence 0.95. 기능 경계가 정해진 설계 검토이며 구현·배포 요청을 대신하지 않는다. 요청된 리뷰 실행은 사용자 지시에 포함돼 있다.

설계 R1 target SHA256: `0023479d5e8af4c7a109f3a9584f61e9af5466331a596b5e025a736c813de781`.
라우터 `dispatch_seats`는 Claude Opus 5 HIGH + GPT-5.6 Sol HIGH다. 호출 전 각 모델에 ROUTER_OK 무변경 probe를 실행했고 둘 다 완료했다. Fable 5.1도 probe 완료했다. 설계 단계에는 dispatch하지 않았고, 뒤의 CRITICAL 플랜 route가 추가한 judge entry에서는 실행했다.

별도 fresh CLI session에 동일 frozen target/issue/source를 제공한다. 서로의 리뷰 출력/요약을 넘기지 않는다. bridge는 dispatch_agent 감독, 최초 설계 시도 600초·후속 검토 1,200초 deadline, darwin-sandbox-v1 receipt guard, target hash/decision fingerprint/policy hash를 사용한다. 실행 종료·verdict·출력 hash·프로세스 종료를 모두 확인한 후에만 리뷰 완료로 센다.

Sol 최초 시도는 nested macOS sandbox의 파일 읽기 실패로 `INVALID_OUTPUT`, 종료 확인 true였다. 소스를 보지 못한 FAIL/0 응답은 설계 판정에서 제외한다. 샌드박스를 완화하지 않고 같은 고정 소스/설계를 inline prompt에 넣는 무도구 재시도로 복구했다. 이 실패는 모델 추론 실패가 아닌 실행 환경 실패다. tool stdout review 문법은 최종 `=== REVIEW ===`/`verdict:`/`confidence:`를 사용한다.

원시 source snapshot/route/request/prompt/보호된 receipt는 로컬 `/tmp/issue147-review-20260908/`에 있다. 다른 reviewer의 output을 source snapshot에 넣지 않는다. 배포 문서에는 수용 판단과 필요한 hash/ID만 남긴다.

## 설계 리뷰와 수용 판단

설계 R1은 Sol inline `PASS_WITH_CHANGES`(0.89)를 받았다. Opus는 600초 안에 최종 응답을 못 내어 TIMED_OUT이며 프로세스 종료를 확인했다. 따라서 R1을 dual review 완료로 세지 않는다. 샌드박스 제한·무출력을 모델 능력 실패로 해석하지 않았다.

설계 R2 고정 target `7cd3f9c3f3bb8d09a32ad3bc1e439f255cf14cdebe6947a4b4df6f850223a36f`에 Opus `PASS_WITH_CHANGES`(0.72), Sol `PASS_WITH_CHANGES`(0.91)를 받았다. `verify-evidence --require-receipt-guard --expect-count 2 --expect-models claude-opus-5,gpt-5.6-sol --expect-fingerprint ...`가 exit 0으로 두 결과를 확인했다. 원래 source를 inline으로 제공하고 tools 없이 fresh session에서 검토했다.

| 지적 | 판단과 반영 |
|---|---|
| R1: digest 입력 모호 | 수용. 정확한 JSON 정렬·필드·array·nullable·순환 제외·golden 규약을 §5.1에 명시. |
| R1: 누락된 assistance의 legacy downgrade | 수용. schema6 explicit 필수, canonical session/hand/marker 교차 검증, schema1~5 원본만 legacy replay. |
| R1: 실패 코드·기존 v2 on 동작 불명 | 수용. fixed failure table과 pre-contract v1/v2 on startup 거절 matrix. |
| R2 Opus: settlement에서 마커 유실 | 보존 요구와 engine/hand 변경은 이미 계획에 있어 새로운 high blocker로는 보지 않았다. 실제 closed settlement allowlist와 marker→snapshot 권위 관계를 구체화했다. |
| R2 Opus: schema6 study 완료가 `[4,5]` gate에서 legacy 취급 | 코드 확인 후 수용. summarizeRun 4/5/6, assertProfileEvent 1~6, profile-store schema5 allowlist·full assessment/retest 검증 추가. |
| R2 Opus: relay의 query 재검증이 import 경계 위반 | 수용. resolver를 shared/public으로 옮기는 대신 `tools/hint-proof.js.verifyHintPublication` 하나의 read-only 예외를 명시. boundaries/ARCHITECTURE/8MiB dataset pin read를 플랜에 추가. |
| R2 Opus: publish 크기 초과 | 수용. 신규 pending 저장 전 실제 bytes 검사, hint만 제거, commit된 true 유지. 기존 exact retry body는 수정하지 않음. |
| R2 Opus: seenPairs와 goal이 같은 if | 수용. 노출 이력은 reference helper, 점수·오답·목표는 independent helper로 분기. |
| R2 Sol: hint wire 위치/replace/retain 불명 | 수용. top-level wire와 DTO/null, history 비저장, 현재 revision SSE 합성, reconnect snapshot 규약을 명시. |
| R2 Sol: stale exact body가 pending을 영구 유지 | 수용. hint strip 후 원래 body의 UI-anchor/receipt commit을 완료하고 200으로 retire, 최신 view 동기화. actionAck 검증 면제 없음. |
| R2 Sol: unknown-field와 allowed-but-unhashed 모순 | 수용. accepted root/nested 키와 chosenAction/assistance/forced 제외를 명시. forced-default 직전 노출도 같은 상황 hash. |
| R2 Sol: study false assistance 발급 권위 | 취지 수용. 별도 game-style proof 저장소를 만드는 제안은 채택하지 않고 현재 drill queue/answer/pending expected-event 검증을 확장한다. 클라이언트 origin/assistance를 신뢰하지 않는다. |
| R2 Sol: v1 on 결과 모순 | 수용. 현재 v1 lifecycle은 startup upgrade error 하나로 통일. 내부 builder의 source unsupported 결과와 구별. |

추가 자체 검토: native assisted의 mixObservation을 삭제하면 v2 source 검증까지 실패하므로 원본 reference evidence로 보존하고 집계를 차단한다. engine epoch를 저장된 sessionToken에서 재산출하도록 명시했다. source coverage 측정 CLI에도 독립 평가 수를 분리하도록 했다. `training/contracts.js.assertSnapshot`은 snapshot root unknown-key closed validator가 아님을 현재 코드로 확인했으나 새 hint hash adapter는 별도 strict 규약을 따른다.

## 구현 플랜 최종 리뷰

플랜에서 profile schema6 재구축/호환 작업이 구체화되어 migration flag를 추가했다. risk score 9는 그대로지만 data_integrity_sensitive+ migration override로 **CRITICAL**, MAX 노력·security/edge_cases/rollback/test_adequacy/specification_compliance 점검으로 강화했다. 사용자 요청의 읽기 전용 설계·플랜 리뷰 범위에 대한 기존 승인을 적용하며, 이 승인을 구현·배포 승인으로 확대하지 않는다.

고정 target은 design text + `\n--- DESIGN THEN PLAN ---\n` + plan text의 UTF-8 SHA256 `5f59cabfc4e52d9aa7bcda3afce01d8f550331eb6b45b3c340f916856066f4c3`. 라우터의 dispatch_seats 전체는 Opus 5 MAX, Sol MAX, Fable 5.1 MAX(judge seat)다. 각 entry를 한 번씩 별도 세션에 dispatch하고 서로의 의견을 주지 않았다. judge라는 route seat 이름도 여기서는 제3의 독립 검토이며, peer finding을 읽은 중재로 간주하지 않는다.

### 플랜 R1: 수정 필요

| 모델 / MAX | 원문 verdict / confidence | session 또는 attempt | output SHA256 |
|---|---|---|---|
| Claude Opus 5 | PASS_WITH_CHANGES / 0.76 | c670ca9f-72e4-4195-b0f7-b29607ccea67 | 8b4b508d51c7190f9bce5e2c16fe779a7ba4a7ff4c80427be4c07aea9d05299c |
| GPT-5.6 Sol | FAIL / 0.95 | plan-r1-sol | 9d3aec05f6357b2a7649931f2e2dec20b5f7b3f5eb81492fa1858868940548cb |
| Claude Fable 5.1 | PASS_WITH_CHANGES / 0.74 | bc39275f-96ec-4de2-aea9-ef6d5eb0890c | 0e093534bb1d57959852bfbc96a6fb6d80ad36a76e944f652334b494644deba4 |

세 결과는 SUCCEEDED/exit 0/schema-valid/termination-confirmed이며 보호된 receipt 3개를 동일 fingerprint `f8fd7c42d5af4cde76ea6b9375414626d00d842d12e1cc53701ca5ecec015bb3`로 verify-evidence하여 exit 0을 확인했다. **Opus/Fable 본문에도 BLOCKER가 있으므로 PASS_WITH_CHANGES 토큰만 보고 승인으로 세지 않았다. R1의 실질 판정은 수정 필요다.**

| 지적 | 직접 판단과 수정 |
|---|---|
| 세 모델: relay가 canonical schema2/legal 입력 없이 pure query를 재현할 수 없음 | 수용. lock 안에서 engine이 만든 observationSnapshot을 private marker에 보존한다. publisher snapshot을 믿거나 서버에서 betting rules를 재현하는 대안은 채택하지 않았다. T2/T7/F21로 보존·재조회·위조 빈도 거절을 확인한다. |
| Opus/Fable: schema5 committed 답안이 schema6 expected와 달라 기존 drill 재개 불가 | 수용. committed 전체와 pending을 모두 prior event 원본 schema로 비교하고, raw pending capture와 최종 event schema를 분리했다. 새 session3 선언·신규 append6·기존 session1/2 무변경을 T5/F20에 명시했다. |
| Opus: assisted exact가 배타 집계 분할에서 빠짐 | 수용. nonComparableSupported를 독립 평가 제외로 정의하고 raw-supported지만 독립 점수가 없는 assisted exact를 포함한다. raw source 비교 가능 수는 별도 보존한다. |
| Opus/Fable: source history 전수 스캔이 live relay를 막음 | 수용. 기동 시 전수 검증, 요청 시 bounded descriptor identity 대조로 나눴다. 기존 #150 accept/flush 검증은 줄이지 않고 descriptor 변화는 restart 검증 전까지 unavailable다. |
| Opus/Fable: 실제 SSE 전달 함수·같은 revision 재전송 의미 불명 | 수용. 실제 sendCommitted/fanoutCommitted를 지목하고 hint만 ephemeral delivery-time 필드임을 명시했다. durable view/events/receipt 의미는 유지한다. |
| Fable: same-D re-mark V 증가·복구 publish 경로 불명 | 수용. 현재 withMutation의 V+1과 동일 exposureId를 명시하고, 최초 publish 및 직접 executePublish/BAD_ATTEMPT resync를 같은 prepare 경로로 모은다. |
| Sol: action 접수 직후 다른 탭에 힌트를 숨길 authority/전달 규약 없음 | 취지 수용. 새 UI revision transaction을 추가하는 대신 기존 durable action receipt를 근거로 no-id hint-clear를 전송하고 snapshot을 receipt phase로 gate한다. 제출 탭의 즉시 hide와 네트워크 전달 지연의 한계를 구별했다. T7/F22에 두 탭·commit/fanout crash를 추가했다. |
| Sol/Opus: old engine은 hint marker 보존 능력이 없고 relay capability만으로 부족 | 수용. 무상태 engine capabilities/resume-check gate를 별도로 추가했다. 신 launcher의 혼합 버전 실행을 mutation 전에 거절한다. 전체 구 launcher downgrade까지 안전하다는 주장은 제거하고 roll-forward 경계를 명시했다. |

### 플랜 R2: 수정본 독립 확인

설계+같은 구분자+플랜의 고정 target SHA256은 `a3b8242ca0f69cc5323044d0f3b73d26d03a3a378b6ac710f90509be37280f25`다. 동일 CRITICAL route의 3개 MAX seat에 최신 문서와 관련 baseline 소스만 제공했다. 이전 reviewer 의견과 과거 target 지시문은 포함하지 않았다. 세 모델 모두 PASS_WITH_CHANGES였으며 본문에 미해소 BLOCKER가 없음을 직접 확인했다.

| 모델 / MAX | confidence | session 또는 attempt | output SHA256 |
|---|---|---|---|
| Claude Opus 5 | 0.78 | 9ef66378-5526-454b-8392-5828ac6a3c2d | 70d9047a8748028b265515de89c8f55f37ba54aedf0c3d1d5f359b7a79c0e950 |
| GPT-5.6 Sol | 0.95 | plan-r2-sol | 701a6860a98a0913b0d7c2995c719772986361f609a197b72d88fc89d7c088fb |
| Claude Fable 5.1 | 0.80 | 6ee2eec4-aeae-4169-972f-77cf06e833f9 | 746c8a094358ea634c6f5f6c8f59ca77d08eb3a842a47ed3a2625c7d0ac397d5 |

보호 receipt 3개 전부 SUCCEEDED/exit0/schema-valid/termination-confirmed이며 `verify-evidence --require-receipt-guard --expect-count 3 --expect-models claude-opus-5,gpt-5.6-sol,claude-fable-5-1 --expect-fingerprint e3370b9050b85f6f9459bc7576db5d945b002998167c07bebd1b6692997db035`는 exit0이다. policy SHA256은 `78b8f3ce0814566b5795e264723c04c5447d7c975dfd604a75554541ee9cb2a3`. Claude envelope modelUsage에는 요청 모델과 부수 Haiku가 함께 있고, Sol은 CLI의 요청 모델 선언을 확인했다. verify-evidence의 model 비교는 declared identity 검사이며 독립적인 provider served-model 증명으로 확대하지 않는다.

### R2 수용 판단 및 저자 최종 수정

| 지적 | 판단 |
|---|---|
| Sol MAJOR/Fable MINOR: clear 뒤 같은 revision 지연 snapshot이 hint 복원 | 수용. 저자도 app.js:933의 equal-revision 허용에서 독립 확인했다. epoch/D별 generation과 요청/연결 세대를 결박하고 fresh reconciliation에만 복원을 허용했다. 단순 strictly-greater revision만 요구하면 정상 같은-revision 복구를 막을 수 있어 그 제안 대신 generation 규약을 택했다. T7/F22에 지연·재접수 순서를 추가했다. |
| Opus MAJOR: façade 자신은 static scan 밖 | 수용. façade와 신규 helper의 import/write/spawn 검사를 추가했다. 기존 reference-source에는 의도적인 writer가 있으므로 기존 transitive 모듈 전체를 no-write 검사하자는 제안은 채택하지 않았다. 지정 read export 예외와 import/runtime 무변경 검증으로 경계를 명시했다. |
| Opus MAJOR/Fable 보완: snapshot/fanout 검증 비용 | 취지 수용. engine identity를 전혀 읽지 않는 순수 메모리 캐시는 publish 전 엔진 전진을 놓치므로 기각했다. dataset parse/query memo와 bounded async single-flight identity read, fanout 공유, 입력 상한·heartbeat 지연 검사로 대체했다. 비용을 실제 검증했다고 주장하지 않는다. |
| Fable MAJOR: relay 장기 검증 장애 동안 보이지 않는 힌트의 true 마커 누적 | 수용. 기반 시설 unavailable에는 200/unverifiable accept-and-strip 및 ack 해소, capability와 ready 분리, sidecar latch/다음 mark 전 health gate를 추가했다. 이미 commit된 보수적 true는 지우지 않는다. T7/F24에 수용 기준을 추가했다. |
| Opus MINOR: off store도 T5부터 downgrade 불가 | 수용. schema6 첫 append가 모든 store의 roll-forward 경계임을 명시하고 hints-never-enabled fixture를 추가했다. |
| Fable MINOR: epoch/tuple 문면 불일치 | 현재 gameEpochOf가 raw SHA256인 점을 코드로 확인해 현행 결함으로 보지는 않았다. 향후 drift를 막기 위해 동일 export 사용·§5.1 규범·epoch golden을 명시했다. |
| 기타: marker 내부 pre-exposure false, handNo, cap, resync 횟수 | 모호성 제거로 수용. decisions[].assistance만 marker와 대조하고, handNo/D 교차 검증·16KiB 초과·정상 resync V 무증가를 T2/T7/F25에 추가했다. all-in call은 현재 query에서 미지원인 방어적 표시 규칙이라고 명확히 했다. |

이 최종 수정은 R2 권고를 저자가 현재 소스와 대조해 반영한 것이다. **아래 최종 파일 hash가 다시 세 모델의 무조건 PASS를 받았다는 뜻은 아니다.** 설계 2회와 플랜 2회의 실질 검토, 마지막 비차단 권고의 수용/대안 판단으로 문서 단계를 마무리한다. 구현 diff 검토는 T8의 별도 gate다.

추가 read-only 확인: v2 dataset은 1,034,995 bytes이며 19,385개 frequency 모두 1/10000 단위다(허용 오차 1e-8). primitive golden SHA256을 독립 Python hashlib로 확인했다. SAFE_ACTION_KEYS와 schema2 snapshot 필드도 현재 코드에서 확인했다. plan의 기존 테스트 경로는 실제 `test/decision.test.js`로 정정했다.

## 최종 판정

**READY_FOR_IMPLEMENTATION_WITH_BOUNDED_SCOPE — 구현 착수 가능.**

기본 off·v2 프리플랍 pure query·투영 비채점·v1 출처/원본 유지·durable exposure·독립 학습/성향 제외에 대한 계약, 변경 파일/순서와 H1~H10 및 F1~F25 검증을 연결했다. 현재 변경은 문서 3개뿐이고 기능 코드는 구현하지 않았다. 최종 판정은 저자의 구현 가능성 판단이며 실제 브라우저·장애 복구·성능·학습 효과의 완료 증거가 아니다.

문서의 로컬 링크·공백 검사를 완료했다. 원격 main은 마지막 재확인도 `6bc286ae1671d30e90f71e104439520736b5f51f`다. 소스 기준 20/20 PASS 외 전체 테스트·CI를 추가 실행한 것으로 기록하지 않는다.

최종 문서 SHA256(검증 문서 자체 제외):

- design: `4ca8cbbd686e7cec949c1e780c44bb8b33408c449da4a1184bd13b0c8550dd02`
- plan: `b2e21052c997713fb1006c70eaf8f12c66e576921a66ce44593f2e9bc7f26a46`
- combined(design + 동일 구분자 + plan): `5fe022a48d0dd3a90f7651dd8ffda0635e02e6a2387ab3ba8ea6d8c2e8fc0e4e`

## 구현 검증 진행 — 2026-09-08

브랜치 `feat/pre-action-hints-147-delivery`, 기준 main `6bc286ae1671d30e90f71e104439520736b5f51f`. 사용자가 구현·PR·merge·wiki ingest·완료 판단 후 이슈 종료를 승인했다.

구현은 engine durable exposure → sidecar 순수 v2 조회 → relay 재검증 → 현재 snapshot/SSE → 브라우저 억제 세대와, archive assistance → accept/materialize → schema6 → 독립 학습 소비자를 연결한다. v1 dataset 원본과 digest를 수정하지 않는다.

현재 관측한 검증:
- 엔진/primitive/기존 reference 25개, 학습 회귀 146개 통과.
- 최신 힌트 게시/경계 24개 통과: durable-before-publish, resync 무변경, 재접속, 위조 빈도 거부, stale strip, 액션 receipt 숨김, source 장애, query memo와 매번 identity 재검증.
- 독립 판단 20개에 보조 판단 100개를 더해도 점수·skills·오답 후보·분포가 같고 진단 집계만 늘어난다.
- 독립 59핸드 + 보조 100핸드는 자기 성향 60핸드 gate 미달을 유지한다.
- schema2 drill/schema5 journal의 기존 답안 replay는 원본 바이트를 유지하고 신규 답안만 schema6을 append한다.
- 실제 policy sidecar bootstrap/resume/run 사용자 경계 게시 테스트 통과.
- Playwright 실제 브라우저: 데스크톱 렌더, 390×844 가로 넘침 없음, 클릭 직후 hint hidden 및 내용 제거. 콘솔의 유일한 오류는 favicon 404. 세션 토큰은 이 문서에 기록하지 않는다.
- `node tools/build-preflop-baseline.js --check`, `--version 1 --check` 통과. v1 SHA256 `7df129ed8503a3df45058a13a52e05b1f8db8d8dd029dd65c31d98c94a9e9eaf` 유지.
- `node tools/benchmark-policies.js --assert --json` 통과. 이는 정책 휴리스틱 회귀 증거이며 실력·수익·GTO 품질 증거가 아니다.
- 전체 `npm run test:ci` 진행 중. 초기 실패 중 새 diagnostic 필드 기대값과 schema3 pending fixture 5개를 고쳤고 집중 재실행 5/5 통과. 초기 병렬 실행의 재개 timeout 6개는 단독 실행에서 통과. 최종 전체 결과는 아래 완료 기록으로 확정한다.

Model-router 구현 R1은 고정 diff/new-file pack SHA256 `0882871eb86264b6dede199ec7a455b19bd56b6814ac16b778bd7f6461e86fe6`, CRITICAL, MAX, Opus 5/Sol/Fable 5.1 세 좌석에 제출했다. 실행 종료·receipt·판정 및 수용 여부는 아직 미확정이다. 리뷰 도중 root가 추가 검증과 수정한 부분은 다음 고정 대상에 포함한다. 현재 기록은 merge 승인 근거가 아니다.

### 구현 리뷰 수용 판단과 재검증

R1은 Opus/Fable의 첫 출력이 schema-invalid였고, 같은 세션에서 정해진 형식으로 다시 받은 판정은 FAIL이었다. Sol 첫 실행은 1,200초 timeout 뒤 종료 확인됐다. 이를 승인으로 세지 않았다. R2 고정 pack `559dba8d1f6e2b8a8690c41f82ea0d72fa6edcadc2701a8393aba90d5629294a`에 대한 Opus/Fable은 PASS_WITH_CHANGES, Sol은 두 concrete blocker로 FAIL이었다.

| 지적 | root 판단과 조치 |
|---|---|
| hints 검증이 숫자 파서 안에 있어 실행되지 않음 | 수용. 옵션 파서로 이동, invalid/legacy on 거부 테스트. |
| omitted resume의 resolved hints가 relay gate에 전달되지 않음 | 수용. durable config의 반환값을 runtime opts에 반영. |
| off 게시가 추가 state 읽기에 의존함 | 수용. production enabled gate에서 기존 envelope를 그대로 반환. |
| source parse와 descriptor capture 사이 파일 교체 | 수용. 초기화 전후 bounded bytes/dev/inode 일치를 검사한 뒤 context를 확정. relay/sidecar 양쪽의 실제 rename fault 주입 테스트, source 오류는 restart까지 latch. |
| schema5 practice 원본 재시도가 새 assistance guard에 막힘 | 수용. 기존 id를 먼저 찾고 검증된 prior의 과거 형식으로만 비교. 새 undeclared practice는 거부하고 과거 저널은 무변경. |
| schema>=6 helper 일치, recovery view guard, non-string error.code | 방어 보강으로 수용. |
| SSE await 때문에 lastRevision 중복/역전 | 기각. lastRevision 검사는 await 이후 동기 루프 안에 있어 stale 사전 읽기가 아니다. 실제 overlapping SSE 1,2,3 고유 순서 테스트 통과. |
| potTotal과 potBefore의 의미가 다를 수 있음 | 기각. 두 엔진 함수 모두 현재 hand.contribs 합계이며 호출 전 팟이다. |
| 특정 새 테스트 파일명이 없으므로 기능 검증 없음 | 파일명 요구는 기각하고 실제 경로 검증 요구는 수용. 기존 suite 확장과 새 authority/relay/sidecar 테스트 및 실제 브라우저 증거로 검증. |
| 모든 새 store의 one-way profile 경계 | 의도된 계약. schema1~5 profile을 읽어 schema6 derived profile로 재구축하는 시점도 roll-forward 경계다. 저널의 과거 바이트를 강제 변환하거나 구 binary로 내려가는 복구는 지원하지 않는다. |

Claude R3 후속 요청은 실제 API 429 session limit으로 종료되어 판정 없음으로 기록했다. 유효한 R2 보고서를 보존하고, Sol의 두 blocker 수정은 해당 Sol 세션의 bounded R3 후속 검증에 제출했다. 그 고정 pack은 `c26ac6ee602c2e95df9d1fdd94e1e7667071980c9efdf0d95c299974128a43c4`이다. root는 각 지적을 코드·재현으로 판단했으며, 모든 좌석이 최종 동일 tree에 PASS했다고 주장하지 않는다.

### 실제 검증 범위

로컬 Node 26 전체 2차 실행: **2,166건 중 2,165 pass, 0 fail, 1 cancelled**. 취소된 `cutoff-marker write failure still fail-closed when terminate throws`는 120초 timeout이며, 같은 코드 단독 재실행에서 8.2초로 통과했다. 초기 전체 실행의 기본값/schema/pending fixture 오류와 legacy reader 오류는 수정했다. `training-async-pipeline` 전체 단독 12/12, reader 91/91, migration/release 61/61, practice/legacy 54/54가 통과했다. 이 기록을 로컬 전체 green으로 바꾸지 않는다.

C1 10,000파일 보안 검증은 기준 main과 현재 소스의 단독 실행이 각각 약 1.2초와 1.3초로 통과했다. 앞선 전체/병렬 실행의 timeout은 단독 결과와 구분한다. 마지막 제품 변경 이후의 지원 Node 20/22 Linux 전체 suite와 Windows 플랫폼 게이트가 모두 성공해야 PR을 ready/merge한다. 원격 결과의 정본은 [PR #166 checks](https://github.com/Sungmin-Cho/AI-Holdem/pull/166/checks)다. Windows 전체 suite는 저장소 #149에 따라 이번 증거 범위 밖이다. ESLint/Stryker는 미설치이며 실행했다고 기록하지 않는다.

실제 브라우저 흐름은 힌트 → 폴드 클릭/즉시 숨김 → 실제 engine hand 완료 → accept/materialize → 학습 카드 detail 검증/도움 라벨 → profile 독립 0·보조 1을 확인했다. 이 수동 fixture는 액션 소비 ack까지 sidecar가 처리하는 전체 게임 종료를 주장하지 않는다. 별도 실제 policy sidecar bootstrap/resume/run 테스트가 그 게시 통합 경로를 다룬다. 390×844 screenshot 검토에서 발견한 테이블 축소·로그 패널의 버튼 가림은 min-content 높이와 세로 스크롤로 수정했고, 테이블 높이 231px·버튼 hit-test·가로폭 390px을 재확인했다.

합성 source history 10,000행(6,798,890 bytes)의 로컬 timing: source 검증 restart 9.8ms, 마커 포함 준비 209.1ms, 게시 14.8ms, snapshot 50회 p95 1.16ms, 순수 warm query 100회 p95 0.12ms. 한 머신의 측정이며 배포 환경 지연 보장은 아니다. 실제 사용자 store·토큰을 복사하지 않았다.

### 마지막 root 수정 판정

Sol R3는 과거 practice blocker 해소를 확인했고 source의 A→B→A 교체를 추가 지적했다. 수용하여 `readSessionReference`가 초기 bounded descriptor의 **검증된 full triple**과 자신이 실제 읽은 descriptor의 source를 직접 비교하도록 했다. 앞뒤 bytes/inode가 같아져도 중간 parser가 B를 읽으면 `REFERENCE_SOURCE_CONFLICT`다. 캡처 raw는 기존 closed descriptor validator로 검증한다. 실제 원래 inode를 보관→B로 교체→parser read→원래 inode 복원하는 양쪽 fault test가 통과했다. 출처 오류 후 bytes 복원만으로 sidecar latch가 풀리지 않는 것도 검증했다.

model-router의 `max_review_rounds: 3`에 따라 추가 모델 리뷰를 종료했다. R3 뒤의 이 제한된 source fix는 root가 코드와 실패 주입으로 판정했으며 모델 PASS라고 기록하지 않는다. R2의 세 영수증은 `verify-evidence --require-receipt-guard --expect-count 3` 및 모델 multiset·decision fingerprint 검증 exit 0이었다. 이는 FAIL 판정을 PASS로 바꾸는 검사가 아니라 실행 증거의 무결성 검사다.

마지막 focused authority/publication 검증은 14/14 통과(ABA 하위 2개 포함), 앞선 주요 boundary/profile/drill/hint 묶음은 89/89 통과했다. 원격 Node22에서 SSE 테스트가 concurrent HTTP 3-before-2의 정상 중복 처리로 id 2를 기다리던 결함을 확인했다. publish commit 순서를 보장하면서 proof I/O를 지연시켜 fanout 자체를 중첩시키는 테스트로 고쳤다. 같은 원격 실행의 기존 exploit action-driver timeout은 별도로 남겨 두고, 최신 커밋 CI에서 재검증한다.

### 최신 main 통합과 CI 드라이버 보정

main의 코치 PR #165 (`900469a`)를 `b674bb5`에 통합했다. 소스 회귀 86/86, 코치·힌트·policy·턴 계약 61/61, v2 99 × 169 = 16,731개 순수 조회 조합이 통과했다.

CI run `34207017686`의 Node 20 Ubuntu 전체 suite와 Windows 20/22 플랫폼 게이트는 성공했다. Node 22 첫 실행은 코치 카드 게시 대기와 evaluator 재개에서 실패했고, 같은 코드 및 별도 main의 단독 실행은 통과했다. main 기준 반복 5회는 통과했지만 현재 코드 추가 반복에서는 pending 기록 대기 실패가 있었다. 실패 축만 재실행했을 때 첫 두 테스트는 통과했고 대신 exploit 액션 드라이버와 cutoff 실패 주입이 timeout으로 실패했다. 이 결과를 전체 green으로 간주하지 않았다.

두 학습 테스트 드라이버가 `canRaise`이면 무조건 `minRaiseTo`를 전송하고 접수 결과 전부터 해당 decision을 전송 완료로 기록하는 결함을 확인했다. 엔진의 합법적인 숏 올인(`minRaiseTo > maxRaiseTo`)에서는 액션이 거부되고 드라이버가 사용자 차례에서 멈출 수 있었다. 실제 UI처럼 `min(minRaiseTo,maxRaiseTo)`를 사용하고, `ok:true` 이후에만 전송 완료로 기록하는 공유 테스트 helper로 보정했다. 실제 short-stack 엔진 fixture에서 기존 액션의 거부와 수정 액션의 다음 결정 진행을 검증하고, 거부된 POST의 재시도 및 성공 후 중복 방지까지 2/2 통과했다. training 드라이버도 deadline 이후 조용히 반환해 `running`을 무한 대기하지 않고 명시적으로 실패한다.

코치 카드 공개 범위 테스트는 단일 cash-training 핸드로 고정하고 정상 종료까지 기다린다. 무작위 다음 핸드의 카드 충돌로 합법적인 deferred 경로에 들어가는 변수를 제거하며, deferred 자체의 별도 검증은 유지한다. 위 네 CI 실패 테스트는 Node 22 집중 실행에서 4/4 통과했다. 제품 코드, timeout 예산과 계약 단언은 이 보정으로 변경하지 않았다. 최종 원격 CI는 이 테스트 보정 커밋에 대해 다시 확인한다.

### PR #167 UI 통합

`395d32f`의 CI run `34211025376` 네 축은 모두 성공했다(Node 22 전체 2,198/2,198, 취소 0). 병합 시점에 main의 PR #167 (`92b10f6`, 복기 overlay·의도 메모)이 들어와 UI 충돌 두 곳을 통합했다. `ui`는 hint와 handReplays를 함께 보존하고, `sendAction`은 힌트를 숨긴 뒤 intent note를 action controller에 넘긴다.

리플레이·액션 controller·힌트 관련 27/27 테스트가 통과했다. 모바일 Chromium 390×844에서 힌트·메모 입력·액션 바 배치를 확인했고, 실제 클릭 후 힌트 숨김 및 접수 기록의 메모 보존을 검증했다. 같은 fixture에서 실제 엔진 완료·assistance materialize 후 독립 0/도움받은 1을 유지하고, 서버가 재산출한 handReplay를 모바일 overlay로 열어 메모가 보존된 것을 확인했다. 이 수동 fixture는 전체 사이드카의 actionAck 소비까지 재현했다는 증거는 아니다. 통합 커밋의 전체 CI를 다시 확인한 뒤 병합한다.
