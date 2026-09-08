# #147 사전 힌트 구현 플랜

2026-09-08 · 기준 main `6bc286ae1671d30e90f71e104439520736b5f51f` · `feat/pre-action-hints-147`.

계약 정본은 [설계](issue-147-design.md)다. 구현 전 계획이며, 아래 검증은 실행해야 할 항목이다. 현재 증거와 리뷰 판단은 [검증·준비 기록](issue-147-validation.md)에 남긴다.

## 1. 완료 기준

| ID | 관찰 가능한 결과 |
|---|---|
| H1 | 새/기존 off 게임은 모든 현재 decision에서 힌트 수치가 없고 사용자 입력 흐름이 기존과 같다. |
| H2 | on v2 user 차례에 pure query source와 같은 빈도·raise-to가 나타나고 chosen/outcome/private policy 변화에 영향을 받지 않는다. |
| H3 | native/투영/미지원/조회 불가가 구별되며 투영은 비채점, v1은 source 유지 및 사전 숫자 미지원이다. |
| H4 | 어떤 숫자 hint도 canonical durable exposure보다 먼저 공개되지 않는다. |
| H5 | stale/중복/retry/restart/reconnect/reject/빠른 액션에서 노출 기록의 유실·잘못된 decision 연결이 없다. |
| H6 | assistance가 canonical hand→detail→summary→authority→event에 결박되고 변조/누락으로 독립 점수에 들어가지 않는다. |
| H7 | 독립 점수/calibration/mistake/SRS/assessment/retest/process-review/자기 성향 입력에서 보조 표본이 제외된다. |
| H8 | v1 dataset/source/hash/기존 평가 golden, v1/v2 원본 저널 및 이전 연습·정책 identity가 보존된다. |
| H9 | token·상대 홀카드·policy fields 누출 없이 desktop/mobile에서 빈도·사이징·출처·점수 제외가 보이고 기존 액션 바가 작동한다. |
| H10 | hint 준비 오류와 미지원이 액션을 막지 않으며, 작업 자식/relay는 실제 종료가 확인된다. |

## 2. 구현 순서와 활성화 원칙

`T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8` 순서다. T1~T6까지 numeric publisher는 off다. 먼저 사전 노출의 저장·검증·학습 소비를 완성하고 T7에서 실제 사용자 게시에 연결한다. 각 단계에서 계약의 실패 fixture를 먼저 확인하고 최소 변경 후 집중 검증한다. 실패·범위 확장·리뷰에서 발견한 실제 위험이 없으면 전체 테스트를 반복하지 않는다.

### T1. 공개/노출/assistance 계약과 기존 바이트 고정

파일: 신규 `shared/hint-contract.js`, `shared/decision-observation.js`, `shared/assistance.js`; 변경 `publish-contract.js`, `training/public-view.js`; 신규 `test/hint-contract.test.js`, `test/assistance-contract.test.js`.

- hint supported/unsupported/unavailable DTO의 closed fields, 16KiB 상한, id/finite number/source triple/coverage/not-observed/legal/빈도 합을 검증한다. 서버의 canonical 재조회 검증과 단순 shape 검증을 다른 함수로 둔다.
- 설계 §5.1의 정확한 canonical JSON 입력/정렬/배열 순서/nullable/수치 규약으로 세 digest를 구현한다. engine이 training을 import하지 않게 shared에 순수 자료 변환만 둔다. 공개 engine fixture의 canonical JSON bytes/세 digest expected를 독립 산출해 고정하며 epoch는 동일 gameEpochOf export를 사용한다. 실행 중 구현으로 expected를 재생성하지 않는다.
- assistance union과 helper의 missing/legacy 판정을 명시한다. source나 grade를 바꾸어 제외하지 않는다. query coverage.metricEligible=false를 비교 evaluation eligibility와 혼동하지 않는다.
- 기존 v1·v2 summary/detail/event의 omission bytes, hash, score, active source, v1 drill/retest queue와 정책 seed 결과를 golden으로 잡는다. 새 필드가 없으면 과거 canonical JSON 순서/내용이 같아야 한다.

검증: unknown keys/NaN/Infinity/string/bad digest, actions 합 오류, forged metric flag, assistance false+nonnull id/true+null id, 원본 객체 불변 및 canonical deterministic tests. H2/H3/H6/H8.

### T2. 엔진의 durable exposure와 completed hand 전파

파일: `engine/cli.js`, `engine/hand.js`, `engine/decision.js`, 필요 시 `engine/views.js`, 신규 `test/hint-exposure.test.js`; `test/decision.test.js` 등 기존 관련 테스트에 통합 가능.

- 새 config `hintContractVersion:1`, `hints:on|off`의 new-session 저장과 legacy omission을 분리한다. 새 CLI `hint-expose`를 engine mutation lock/expect-version 경로로 추가한다. 메타파일은 별도 `--hint-meta-file`, regular-file/no-symlink/bounded JSON, closed fields를 적용한다.
- 무상태 engine capabilities 명령과 resume-check의 hint capability를 추가한다. new init/contract-bearing resume mutation 전에 신 launcher가 old engine을 거절하는 fixture를 만들고 state/hand bytes 불변을 확인한다. 전체 구 launcher downgrade까지 막는다고 주장하지 않는다.
- canonical legal/decision/epoch/observation/source metadata를 확인한 뒤 hand.hintExposures에 한 번 기록한다. engine이 lock 안에서 직접 생성한 observationSnapshot(16KiB 이하)을 marker에 함께 보존하고 façade가 이를 query 입력으로 사용한다. 외부 meta snapshot/boolean은 받지 않는다. read-only peek는 그대로다.
- mark-before-act, actor/digest/version mismatch, 같은 요청 retry/다른 요청 conflict, marker commit 후 crash→step sync, illegal/forced action을 테스트한다. same-payload re-mark도 withMutation으로 V+1, 동일 exposure/마커1개이며 body는 새 V다. 정상 metadata 저장 외 같은 D의 betting observation을 바꾸는 정상 engine 전이가 없음을 검증한다.
- 모든 new-contract user snapshot에 explicit false/true assistance를 부여한다. engine/hand.js의 settlement `state.lastHand` allowlist에 contract 선언과 마커 map을 추가하고 writeHandArchive/recovery까지 보존한다. hand marker 권위와 snapshot 파생 참조가 일치해야 하며 previous decision/hand marker를 잘못 상속하지 않는다. #163 note/meta-file와 공존하며 둘이 서로 overwrite하지 않게 한다.

추가 검증: 16KiB 초과 snapshot은 marker 없이 unavailable; marker 내부 pre-exposure false는 decisions[].assistance 일치 비교에서 제외; 정상 same-D resync N회는 첫 mark 외 V 증가 없음.

검증: 실제 CLI subprocess·temp session에서 stateVersion/exposureId/chip/turn/actionIndex·archive 대응, mark 직후 kill/restart, hand 종료 후 late marker 거절. 전략/카드·칩 결과는 marker 외 동일. H4/H5/H6.

### T3. 순수 hint builder와 source-aware tool 준비

파일: 신규 `training/pre-action-hint.js`, `tools/hint-control.js`; `tools/preflop-dataset.js`, `tools/reference-source.js`는 필요할 때만 변경; 신규 `test/pre-action-hint.test.js`, `test/hint-control.test.js`; 기존 `test/policy-layer-boundary.test.js`.

- pinned v2 `resolvePreflopReference` 결과만 표현 DTO로 변환한다. fake chosenAction, compare/evaluator, policy strength import 없음. full triple로 immutable dataset 캐시한다.
- v1/legacy/postflop/malformed/source missing을 설계의 fixed code에 매핑한다. read 경로가 descriptor를 생성·수정하지 않는지 파일 bytes로 확인한다.
- source/lookup/engine mark/commit response 합성 API를 정의한다. 원래 step events/actionAck/handReplay를 보존하고 mark 이후 view/next/stateVersion을 사용한다. 모든 engine 호출은 기존 deadline/kill/termination 확인 adapter를 주입받는다.
- formatter 단위 테스트에서 2.5/8.5BB, SB actorBet, call 후 pot 정의, 정확한 all-in-raise/all-in-call, 0%와 unavailable를 구분한다. impossible positive raise는 전체 unsupported이며 clamp/renormalize하지 않는다.

검증: 실제 6/8/9인 snapshot, 80/100/112/120BB, 79/121BB, 2/2.5/3BB open, limp/콜러/4bet+/postflop/v1 matrix. chosen/결과/상대 홀카드 poison fixture, source mismatch, no spawned LLM/solver, cold/warm parse/lookup timing. H2/H3/H8/H10.

### T4. 봉인된 사후 평가와 assistance 권위

파일: `training/preflop-reference.js`의 evaluator wrapper, `training/decision-evaluator.js`, `tools/evaluate-cli.js`, `tools/training-pipeline.js`, `tools/training-control.js`, `training/public-view.js`, `publish-contract.js`, `training/explain.js`, `training/process-review.js`; 신규 `test/hint-assistance-authority.test.js`, 기존 authority/public-view/explain/process tests.

- pure query는 그대로 두고 사후 evaluator wrapper에 검증된 assistance를 전달한다. canonical query/compare의 reference grade 의미를 바꾸지 않는다.
- accept/materialize verification을 baseline-v2 조건 밖의 assistance 검증으로 확장한다. future postflop evaluation도 hinted hand/decision 메타를 조용히 버리지 않게 한다. v1 legacy omission은 기존 테스트/golden을 보존한다.
- summary canonical hash에 assistance가 있을 때만 추가한다. summary/detail/record/marker/version/source별 mismatch를 거절한다. 새 contract에서 도움 여부를 잃으면 pending/unavailable이며 old-style event로 downgrade하지 않는다.
- consumer helper를 `independentAssessmentEligibility`로 일원화하되 #150 `referenceAssessmentEligibility`와 coverage의 reference-only 의미는 유지한다. 사후 설명·종합 prompt에 도움 여부/비채점 이유를 전달하고 독립 성과 주장이나 grade 배지를 막는다.

검증: hintShown true→false 변조, summary-only/detail-only omission, marker 없는 exposureId, cross-decision/session/source 재사용, hand archive 누락/state.lastHand fallback, accepted detail 복구 재검증, legacy hash golden. H3/H6/H8.

### T5. profile schema 6 및 전체 학습 소비자 분리

파일: `training/profile-store.js`, `training/profile-aggregator.js`, `training/opportunities.js`, `training/mistake-bank.js`, `training/study-history.js`, `tools/study-summary.js`, `tools/profile-cli.js`, `tools/drill-cli.js`, `tools/measure-training-coverage.js`, `shared/study-contract.js`, `tools/training-pipeline.js`; 신규 `test/hint-learning-exclusion.test.js`, 기존 profile/study/drill/migration tests.

- schema 6 **모든** event에 assistance를 필수로 포함한다. legacy session·practice/drill/retest의 새 event는 검증된 false/null을 명시한다. 1~5 저널은 읽고 원본을 바꾸지 않으며 replay adapter만 legacy로 분류하고 derived profile을 새 schema로 rebuild한다. snapshot/evaluationId별 exactly-once와 payload conflict를 유지한다. old schema reader가 6을 거절하는 fixture를 둔다. hints를 한 번도 켜지 않은 store도 첫 T5 event가6이며 이때부터 roll-forward 경계임을 검증한다.
- game과 study 발급을 분리한다. tools/drill-cli의 저장 queue/source/studyRun/answer 검증 후 false/null을 발급하고 expected event/learningEventKey에 반영한다. request의 origin/assistance 주입은 거절한다. 새 drill session3+assistanceContractVersion1, 기존 session1/2의 hint-incapable 원본 capture shape를 구별한다. 원래 pending.profileEvent/bankEvent shape는 capture session schema로, committed event 전체는 prior event schema/assistance presence로 재산출하여 비교한다. legacy pending에서 아직 미append인 event만 현재 schema6 false로 처음 append한다. profile-store.apply duplicate도 같은 원본 schema 규칙을 쓰고 새 contract-bearing game/assisted payload를 legacy 투영하여 충돌을 숨기지 않는다. 도움 기능 없는 producer임을 검증하지 않은 practice/import의 schema6 발급은 거절한다.
- hinted native reference는 `referenceAvailable` raw coverage로 남기되 독립 supported/exactComparable/mix 집계/calibration/preferred/offPolicy/allowed/mastery/학습 성장/오답/SRS 후보에서 제외한다. native assisted의 mixObservation은 v2 reference 검증용으로 저장하고 집계 진입점에서 제외한다. projected에는 mix를 만들지 않는다. legacy/drill origin의 explicit false 발급 근거를 검사한다. coverage 측정 CLI는 source 기준 비교 가능 수와 독립 점수 가능 수를 별도 열로 내어 혼동하지 않게 한다.
- 현재 profile-store의 schema allowlist `[1,2,3,4,PROFILE_SCHEMA_VERSION]`와 schema1~4 rebuild 분기는 상수만 6으로 바꾸면 schema5를 탈락시킨다. show/apply/rebuild/digest migration 각 진입점에 schema5 원본 저널 fixture를 넣고 명시적으로 확장한다. assertProfileEvent는 1~6 허용·6 explicit assistance 필수, summarizeRun의 `[4,5]`를 `[4,5,6]`으로 확장한다. 실제 schema6 full assessment→due retest 완료를 검증한다.
- assisted/forced/projected 진단은 겹칠 수 있다. total과 배타적 independent/unsupported/non-comparable 분모는 한 번만 센다. 기존 source segment별 active/referenceAvailable 표시 규약을 보존한다.

배타 분할의 nonComparableSupported는 이제 “독립 평가 제외”(raw supported && !independentEligible)로 정의하며 assisted exact가 이 bucket에 들어간다. raw reference 비교 가능 수와 구분하고 합계 불변식을 테스트한다. assisted라도 verified referenceAvailable이면 active source 갱신은 유지한다.
- study events의 canonical fingerprint, preTrackingExposure, assessment question set, source-selected v1 retest를 점검한다. 기존 studyHistory의 seenPairs와 gameGoal/practiceGoal 진입을 분리한다. verified assisted native의 source/spot/handClass는 이미 본 문항 집합에 남고, assisted라는 이유만으로 unknown-pretracking이 되지 않으며 점수/오답/성장 표본에서는 제외된다. 직접 grade 소비자를 전수 검색하고 결과를 validation에 기록한다.

검증: 고정 unassisted v1/v2 집계에 100개 assisted native 및 100개 assisted projected를 추가해도 독립 점수/mix/오답/연습 큐 불변; raw coverage와 assisted 진단만 변화. forced+assisted 중복 분모 없음, malformed/missing fail-closed, 중단 rebuild/consume replay exactly-once, v1 queue/retest 및 source별 score 동일. H3/H6/H7/H8.

### T6. 자기 성향·사후 공개 소비자까지 연결

파일: `training/tendency/extract.js`, `training/tendency/contracts.js`, `tools/self-opponents.js`, `tools/tendency-cli.js`, `training/tendency/compare.js`, `shared/hand-replay.js`, `engine/views.js`, `export/`, `server/public/training-format.js`, `server/drill-public/study-format.js`; 신규 `test/hint-tendency-exclusion.test.js`, 기존 tendency/self-opponents/replay/export/training-format tests.

- raw hand를 읽는 #144 경로에서 user hint가 하나라도 있는 hand는 독립 tendency 전체에서 제외한다. hand-level dealt/VPIP/PFR/WTSD 분모를 남겨 두고 action만 삭제하는 구현은 금지한다. assistance 불명확한 새 hand는 unavailable 제외 진단이다.
- 최소 60핸드 및 sources[].hands와 실제 입력 n을 일치시킨다. 새로운 derived model을 만들 때만 반영하고 현재 session의 sealed `.policy-configs.json`/players identity는 재작성하지 않는다.
- 비교 보고의 사용자 성향과 독립 self-mirror fidelity 분모에도 같은 기준을 적용한다. 화면/CLI에 excludedAssistedHands를 알린다. 관측에서 제외하는 것은 실제 칩 전적의 삭제가 아니다.
- 완료 hand replay/export 사용자 assistance 라벨을 보존한다. opponent hidden fields나 raw hint reference를 public action/priorActions로 유출하지 않는다. game-over/reveal 정책은 유지한다.
- hinted native 사후 카드는 independent grade 배지와 mistake drill 버튼을 숨기고 검증된 참고 빈도/출처 및 도움 여부를 표시한다. projected null grade와 detail 검증 전 수치 비노출을 유지한다.

검증: 59 독립+100 보조 hand로 self-opponent 60 gate 통과 금지; hand n/셀 n·사이징·postflop 분모 불변, mixed-source/history 및 이전 모델 resume 불변; replay redaction/모바일 카드 assistance. H7/H8/H9.

### T7. relay·sidecar·UI 연결과 numeric 활성화

파일: `tools/game-loop.js`, `tools/publish.js`, 신규 `tools/hint-proof.js`, `server/server.js`, `test/boundaries.test.js`, `server/public/app.js`, `server/public/index.html`, `server/public/style.css`, 신규 `server/public/hint-format.js`; 신규 `test/hint-publish.test.js`, `test/hint-loop.test.js`, `test/hint-ui.test.js`.

- 신규 옵션 parser/default/lifecycle commit/resume drift checks, hints capability probe/owned relay replacement를 연결한다. pre-contract v1/v2의 생략/off 무변경과 on 기동 전 거절, contract on/off 각각의 생략/동일/반대값 matrix를 고정한다. 모든 view 게시 진입을 한 곳에서 prepare하며 direct executePublish/resync 우회도 포함한다. `.turn`·pending exact body recovery와 stop cutoff를 깨지 않는다.
- relay는 `tools/hint-proof.js.verifyHintPublication` façade 하나로 marker.observationSnapshot 기반 query를 재산출해서 numeric body와 비교한다. boundaries/ARCHITECTURE에 이 export 및 필요한 pure shared hint 계약의 named import만 허용한다. façade no-spawn/no-mutation, dataset 8MiB pin read, publisher가 위조한 frequency와 그에 일치하는 marker digest를 함께 만든 공격도 재조회로 거절하는지 테스트한다. source 전수 검증은 sidecar/relay 기동당 1회, live 요청은 4KiB descriptor/현재 identity를 대조하며 변경 시 unavailable이다. large history fixture에서 live 요청에 detail/journal scan이 없고 heartbeat를 막지 않는지 검증한다. duplicate fast-path 전 hint 무효화 및 restore 재검증을 포함한다.
- tools/publish는 신규 body에 publishId까지 포함한 실제 길이를 pending attempt 저장 전에 재고 hint 때문에 한도를 넘으면 hint만 제거한다. 이미 commit한 marker는 유지한다. view/events/ack/replay가 남고 재시도 exact body를 변경하지 않는 near-limit fixture를 추가한다.
- top-level envelope/body/state/ui-snapshot/snapshot/SSE의 hint 위치와 omission/null 규약을 설계 §6대로 구현한다. view 포함 body는 replace/clear, view-less body는 omission만 허용하고 current identity match 때만 유지한다. history는 숫자 없이 저장하고 실제 sendCommitted/fanoutCommitted에서 현재 마지막 revision만 검증된 current hint를 합성한다. hint는 delivery-time 필드여서 같은 id의 과거 replay는 null일 수 있지만 durable view/events/receipt는 동일함을 테스트한다. SSE open마다 snapshot을 다시 읽고 revision이 역행하는 응답은 버린다.
- stale 정상형 pending body는 relay가 hint만 strip한 나머지를 commit한 뒤 200/hintDisposition=stale-stripped로 끝낸다. publisher는 기존 exact body를 retire하고 최신 view를 게시한다. UI commit 전/후·ack 유실·retire 직후 crash에서 terminal action receipt와 events/replay를 보존한다. 잘못된 actionAck를 성공시키지 않는다.
- UI는 percent/source/투영/비채점·raise-to/추가 투입·팟 비율을 렌더링한다. action submit/disconnect/identity change에 즉시 hide, same-D reject 후 검증된 hint 복원. focus/raise 입력/note/idempotent action receipt 흐름을 보존한다.
- durable action receipt accept 뒤 no-id/no-revision SSE hint-clear({gameEpoch,decisionId})를 모든 탭에 전송한다. snapshot/SSE current-hint projector는 동일 D의 accepted/delivered/consumed receipt 및 unreadable receipt를 null로 처리한다. commit 전/후 fanout 전 crash, reconnect, coach interleave, same-D rejected 복원, 두 탭을 검사한다. 기존 publishId/revision/receipt mutation 순서는 늘리지 않는다.

추가 수용 기준:
- façade 자체/새 helper의 named import와 no-write/no-spawn static 검사를 추가한다. 기존 혼합 모듈은 지정한 read export만 예외이고 import/runtime write 0회를 검증한다.
- dataset parse는 context당1회, 동일 marker query는 memoize한다. GET/SSE는 bounded async single-flight identity probe(engine state2MiB, descriptor/receipt각4KiB)를 유지하고 한 fanout에 공유한다. N회 GET의 parse/query0회·입력 상한·heartbeat/action 지연을 검사한다. engine이 publish 없이 advance한 fixture에서 메모리 cached hint가 노출되어서는 안 된다.
- hint-clear/local submit/disconnect 이전 generation 또는 이전 연결의 늦은 같은-revision 응답이 수치를 복원하지 못하게 한다. clear 이후 fresh rejected/unreceived reconciliation만 복원하고 재접수 중 더 새 clear를 덮어쓰지 않는다.
- unverifiable relay publish는 200 accept-and-strip/ack commit이고 sidecar readiness latch를 닫는다. capability와 ready를 구별하고 다음 D의 mark 전에 health ready를 확인한다. 손상 receipt의 GET은 view를 계속 제공하고 hint:null이다.

검증: bootstrap 사용자 선행, AI→user, new hand, retry same body, pending stale body, BAD_ATTEMPT/BAD_SNAPSHOT 복구, marker commit 직후 kill, publish commit 직후 kill, action-before-hint/stale V, multi-tab/reconnect, invalid action/resubmit, on/off resume conflict, hint off 시 전체 payload 수치 없음. H1/H4/H5/H6/H9/H10.

### T8. 통합 검증·문서·착수 이후 구현 판정

파일: `README.md`, `ARCHITECTURE.md`, `.agents/skills/start-game/SKILL.md`, `AGENTS.md`의 옵션 요약이 필요하면 함께; 신규 `test/browser/pre-action-hint-journey.mjs`; 이 문서와 validation의 실제 결과만 갱신한다.

1. 격리 temp store에서 실제 engine/sidecar/relay/user-action/publish/training consume를 실행한다. 고정 deck로 6/8/9인 supported 및 projected 상태를 확보하고 default off 세션과 비교한다. 실제 사용자 store·토큰·deck 전체를 fixture로 복사하지 않는다.
2. 브라우저 desktop 및 390×844에서 opt-in 수치/raise-to/pot 정의/출처 확인 → 사용자 액션 → 즉시 hide → 사후 도움 라벨 → profile 제외를 한 여정으로 검증한다. on 세션 restart와 off 게임 no-hint도 수행한다.
3. meaningful focused checks 뒤 `npm run test:ci`, `npm run benchmark:policies`, v1/v2 generator `--check`를 실행한다. 실패는 같은 소스에서 단독 재현해 baseline/flaky/regression을 구분한다. 지원 Node 20/22의 결과와 로컬 Node 26을 구별하고 Windows는 저장소의 플랫폼 게이트 범위만 주장한다.
4. cold/warm query, marker 포함 준비, relay publish latency를 따로 기록한다. timeout이나 종료 불명을 성공으로 세지 않는다. ESLint/Stryker는 현재 미설치이므로 PASS라고 기록하지 않는다.
5. 구현 diff에 model-router로 위험에 맞는 리뷰를 배정하고 실제 결함만 수용하여 집중 재검증한다. blocker 해소/전체 결과/브라우저 증거/남은 제한을 보고한다. PR 게시·병합·릴리스는 현재 설계·플랜 요청의 완료 조건에 포함하지 않는다.

## 3. 실패 주입 행렬

| ID | 재현 | 반드시 확인할 결과 |
|---|---|---|
| F1 | hints off, actor AI, wrong D/V/epoch | 현재 사전 숫자 없음; stale 입력으로 노출 마커 생성 없음 |
| F2 | pure query에 다른 chosen/outcome/private field 추가 | 동일 reference; 가짜 행동/evaluation side effect 없음 |
| F3 | projected/native/unsupported/불법 positive raise | 정확한 상태·source, 투영 비채점, clamp/추정/0% 오표시 없음 |
| F4 | query 성공→mark 전 crash | 수치 미공개, false snapshot 허용 |
| F5 | mark commit→publish 전 crash/timeout | true 유지, 재개 동일 exposure, 독립 점수 제외 |
| F6 | publish 성공→ack 유실/relay restart | 원래 receipt 동작 유지, 마커 보존, stale snapshot 수치 제거 |
| F7 | action apply→old hint exact publish retry | 이전 숫자 미공개, 최신 view 동기화, actionAck/events/replay 유실 없음 |
| F8 | false/omission/source/coverage/digest 각 1필드 변조 | accept/materialize/restore fail-closed, original event 무변경 |
| F9 | 100 assisted exact + 100 assisted projected + forced | 독립 분모/점수/오답/성향 불변, raw/assisted 진단만 증가 |
| F10 | v1/v2/schema1~5 혼합 원본으로 schema6 rebuild 중 종료 | 원본 bytes/source/ID 보존, 복구 exactly-once, derived-only 무추정 |
| F11 | own relay old capability / foreign relay | ownership 확인 교체 / foreign 보존, silent hint bypass 없음 |
| F12 | SB/BB call/raise-to/all-in·0.01% 소수 | 기준 빈도 질량 보존, check/call 및 all-in call/raise 구분, 팟 정의 일치 |
| F13 | new hand contract 선언+assistance 누락 | legacy false로 간주하지 않음, 점수/성향 unavailable |
| F14 | #163 note, invalid action, resubmit, multi-tab | 노출 identity 불변, note와 assistance 독립, legal action 계속 가능 |
| F15 | 모든 설계 §8 실패 코드/선행 오류 조합 | status/source nullability·마커 보존·retry/continue/recovery 동작이 표와 동일 |
| F16 | schema6 assistance 누락, contract 선언 한 군데만 존재, schema1~5 원본 | 신규 누락은 unavailable/reject, 검증된 legacy만 기존 점수 유지 |
| F17 | assisted native를 소비한 studyHistory | 이미 본 source/spot/handClass에 남고 독립 성적·오답·성장에는 들어가지 않음 |
| F18 | premark/postmark/archived chosen/forced-default snapshot | 허용-but-unhashed 선택·도움·forced 변화는 동일 observation hash, unknown root/nested keys는 오류 |
| F19 | schema6 study full assessment→due retest, forged origin/assistance | 실제 큐·답안·pending proof로 발급한 false만 완료, schema6가 LEGACY_EVIDENCE가 되지 않음 |
| F20 | schema5 committed 답안 여러 개+legacy captured pending, 새 binary next/answer/start/summary | 원래 답안·source·hash 보존, 원본 schema로 expected 비교, 신규 확정만6, PENDING_UNRESOLVED/PROFILE_EVENT_CONFLICT 오검출 없음 |
| F21 | 임의 frequency와 일치하는 recommendation digest를 engine marker에 발급 | 저장 canonical observation 재조회로 relay가 거절, 새 수치 없음·게임 계속 |
| F22 | 두 탭, accept/fanout crash, clear 뒤 같은 revision의 지연 snapshot 및 재접수 | 이전 generation 수치 복원 금지, GET/reconnect null; fresh rejected/unreceived 확인 뒤에만 복원; receipt terminal 유지 |
| F23 | 신 launcher+구 engine / 전체 구 설치 | 전자는 mutation 전 capability 거절; 후자는 지원 불가·원본 복원/roll-forward 경계 명시 |
| F24 | relay dataset/context unavailable인 ack-bearing publish, 다음 사용자 D | 200/unverifiable로 ack commit·hint strip; ready 회복 전 다음 D marker 없음 |
| F25 | marker snapshot 16KiB 초과, state2MiB 초과, 반복 GET/SSE fanout, DTO handNo 위조 | 수치 없이 게임 계속; query/parse 재실행 없음·bounded identity 확인 유지; handNo mismatch 거절 |

## 4. 구현에 넘길 증거

최신 main SHA와 설계/플랜 hash, review route와 target/모델/session/receipt, 수용·기각 사유, 실제 실행 명령·종료 결과를 validation에 남긴다. 구현자가 새 main으로 옮기면 #162/#163 및 출처/게시/학습 authority 변경 여부를 확인해 계획을 갱신한다. 구현 가능 판정은 전략 품질·학습 효과·모든 턴 힌트 지원의 증거가 아니다.
