# #150 구현 플랜

2026-09-08 · 구현 기준 `2e1bda863d77f0b14208aaa391f6c4bc48226880` · 브랜치 `feat/preflop-reference-coverage-v2`.

계약: [설계](issue-150-design.md). 아래는 구현 및 검증 순서다. 세부 테스트는 동일 계약별 파일로 통합할 수 있으며, 검증 결과는 배포 보고서에 기록한다.

## 성공 조건과 범위

| ID | 구현 완료를 관찰하는 방법 |
|---|---|
| R1 | 기본 제품 경로에서 실제 결정/평가/프로필 수가 대응하고 first-failure+독립 blocker 분포를 재현 가능하게 기록 |
| R2 | 사전 query가 chosenAction 없이 동작하고, 미래 선택/결과/상대 홀카드 변화에 영향받지 않음 |
| R3 | 6/8/9인 canonical topology와 opener-before-hero 79쌍, RFI 20개가 169 hand class 모두를 조회 가능 |
| R4 | 80~120bb·2~3bb open·6.5~10.5bb 3bet의 bounded projection만 명시적으로 허용. 범위/합법성/모드 밖은 fail-closed |
| R5 | v1 bytes/hash/legacy score와 정책 행동 보존, v2 source registry·session source binding·선택 CLI·recovery 일치 |
| R6 | coverage가 detail→summary→authority→event→profile→study까지 결박. 조작/누락된 v2 provenance로 점수 또는 숫자를 얻을 수 없음 |
| R7 | exact/참고 가능/projected/비교 불가/unsupported/forced/provenance 실패를 별도로 집계. source 버전 간 score/calibration/assessment를 혼합하지 않음 |
| R8 | 새 위치·상황의 사후 card→native drill→answer→profile 흐름 완료, 과거 v1 drill/assessment 재개와 retest 보존 |
| R9 | #147에 source/actions/coverage/decision identity 계약을 인계. 이번 버전은 현재 핸드의 사용자에게 사전 힌트를 게시하지 않음 |

불변 조건: EV 필드 null; 외부 chart 복제 없음; opponent strength 소비 경계 유지; 표에 맞춰 엔진/legal/원시 액션을 변경하지 않음; source id/version/hash 완전 일치; 원본 이벤트 append-only; 불명확한 상태와 미완료 자식 종료를 성공 처리하지 않음.

구현 리스크는 **중상**이다. 순수 lookup보다 versioned persistence와 학습 통계 소비 경로가 중요하다. 첫 활성화는 새로운 v2 세션에서만 한다. 기존 런타임 store로 smoke하지 않고 모두 격리 store를 사용한다.

## 작업 순서

`T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8` 순서로 진행한다. T2~T4는 기본 경로를 전환하지 않는 내부 구현이고, T5~T7 연결 및 검증 후 T8에서 v2 기본값을 활성화한다. 각 단계는 RED 재현→최소 구현→해당 GREEN→해당 계약 리뷰를 거친다. 변경 없는 축의 반복 전체 검증은 하지 않는다.

### T1. 측정 도구와 v1 기준 동결

파일: 신규 `tools/measure-training-coverage.js`, `test/training-coverage.test.js`; 필요 시 `test/helpers/learning-integration-fixtures.mjs`. 이번 연구의 `measure-session.mjs`를 제품 source로 그대로 복사하지 말고 오류/정리/CLI 옵션을 제품 계약에 맞게 정리한다.

- offline 입력은 명시적인 session/store 절대 경로, 읽기 전용. 원본 `.training` 디렉터리에 진단 결과를 쓰지 않는다. `--out`은 별도 결과 경로.
- `<session>/training/evaluations.jsonl`과 canonical hand decisions를 evaluationId/decisionId로 결박한다. 원시 snapshot과 source/digest가 부족하면 진단 unavailable로 표시한다. 누락 평가, duplicate, conflict, forced 및 postflop을 분리한다.
- invalid input은 검증 오류. 유효 unsupported 입력은 primaryReason과 독립 blockers[]를 수집한다. 순서 변경만으로 blocker 총계가 바뀌지 않아야 한다.
- v1 JSON/SHA, 대표 lookup/grade/profile bytes, v1 policy 고정 seed 결과를 golden fixture로 동결한다. 새 지원 corpus와 negative corpus도 source revision/hash와 함께 저장한다. runtime token/deck/state 전체를 fixture에 복사하지 않는다. decision snapshot의 사용자 정보와 공개 액션만 필요한 범위로 남긴다.

RED: 잘못된 store-level evaluations 경로/중복 분모/첫 실패를 전체 원인으로 계산하는 경우. GREEN: 이번 고정 transcript의 38/24/8/4/7/5/14 분포와 stack=100 재현, 누락·충돌·잘못된 digest는 failure. 재계산은 기록한 source에 대해 수행하며 새 난수 run에 동일 count를 강제하지 않는다.

### T2. source registry와 version-aware 데이터/세션 선택

파일: `shared/reference.js`, `tools/preflop-dataset.js`, `tools/game-loop.js`, `tools/evaluate-cli.js`, `tools/training-pipeline.js`, `tools/training-control.js`; 신규 `tools/reference-source.js`; 테스트 `test/reference-source.test.js`, 기존 `test/training-cli.test.js`, `test/training-authority-v2.test.js`, `test/q3-training-flush-recovery.test.js`, `test/policy-distribution.test.js`.

- 우선 registry에 v1을 옮기되 canonical 기본값은 v1이다. T3의 실제 v2 hash를 registry에 추가한 후에도 T8까지 default는 v1로 둔다.
- 신규 source descriptor read/write/legacy-once binding을 lifecycle lock 아래 구현한다. descriptor의 경로 입력은 받지 않고 registry→bundled path만 사용한다.
- 세션의 baseline authority item와 descriptor를 검사하고, resume/flush/defaultEvaluate/sweep/evaluate CLI가 같은 source를 사용하도록 한다. v1 active session의 source를 v2로 바꾸는 API는 제공하지 않는다.
- `training/policies/baseline.js`와 `tools/policy-player.js`가 v1 data/normalizer를 명시적으로 선택하게 하여 평가 default와 독립시킨다. v2 opponent strategy에는 변경이 없다.

RED: descriptor 유실 후 v2→v1 silent fallback, mixed baseline source, missing/forged hash, symlink/FIFO/oversized descriptor, 같은 source라도 bytes 변경, current main dataset을 읽어 옛 drill/게임을 재평가하는 사례.

GREEN: v1/v2 loaded source가 정확히 요청한 triple과 동일, v1 policy seed 결과 보존, 중단 후 동일 source로 flush, postflop provider와 preflop binding 분리, conflicting baseline halt. 표준 실패 reason `REFERENCE_SOURCE_INVALID`, `REFERENCE_SOURCE_CONFLICT`, `SOURCE_UNAVAILABLE`를 고정한다.

### T3. shared spot model과 원본 v2 dataset

파일: 신규 `shared/preflop-key.js`, `training/data/preflop-baseline-v2.json`, `.sha256`, `training/data/legacy-preflop-recipe.js`; 변경 `tools/build-preflop-baseline.js`, `training/providers/preflop-json.js`, `training/data/README.md`, `shared/reference.js`; 신규 `test/preflop-key.test.js`, `test/preflop-baseline-v2.test.js`.

- design §4의 topology/key parser와 §5의 원본 recipe/계수를 그대로 구현한다. position 역할과 opener를 구조체로 다루며 regex만으로 dataset support를 인정하지 않는다.
- parser는 schema 1과 2를 분리한다. v2에는 explicit capabilities, recipe version, spots, per-key native metadata, table/order, native stack/tree가 필요하다. 99×169 completeness, duplicate/unknown action, size absence, integer frequency units, sum=1, EV-null을 엄격 검증한다.
- v1 generator bytes/SHA 동일성은 release check에서 고정한다. builder의 출력 dir는 fixture dir로 지정 가능하고 `--check`는 무변경 검증이다. source triple·JSON·SHA·README를 한 변경으로 처리한다.
- 새 v2 file size를 측정하고 순수 parse/lookup benchmark를 남긴다. JSON 전체를 요청마다 읽지 않고 tool layer에서 immutable parsed dataset을 캐시한다. 캐시 key는 full source triple이고 stale/path alias로 다른 source가 재사용되면 안 된다.

RED/GREEN: 99 keys, 16,731 valid rows, invalid pair 없음, 모든 hero/opener를 분리, malformed/pin mismatch reject, coefficients/rounding deterministic, early-position premium override, 실제 native bounds 내 모든 액션 합법, v1 byte 동일. 전략 성질 검증은 recipe에 대한 관찰이며 수익률/최적성 테스트가 아니다.

### T4. 사전 조회와 선택 비교, bounded projection

파일: 신규 `training/preflop-reference.js`, `shared/reference-coverage.js`; 변경 `training/preflop-spot.js`, `training/decision-evaluator.js`, `tools/evaluate-cli.js`, `tools/preflop-dataset.js`; 테스트 신규 `test/preflop-reference.test.js`, `test/reference-projection.test.js`, 기존 `test/decision-evaluator.test.js`, `test/policy-layer-boundary.test.js`.

- 기존 `normalizePreflopSpot`는 legacy v1용으로 유지하거나 명시적 alias로 분리하여 옛 정책/평가가 새 key를 반환하지 않게 한다. 새 query는 별도 implementation이다.
- schema 2 decision-time public snapshot으로 context 검증→native spot resolve→provider lookup→전체 legal 검증→immutable reference 결박 순서를 따른다.
- chosenAction 검사는 compare 단계에서만 수행한다. `reference.coverage`를 raw observation과 reference caps에서 재계산하고 호출자가 제공한 metricEligible를 신뢰하지 않는다.
- design의 수치 경계/모드/topology/zero-frequency 행동/다중 match 거절 규칙을 구현한다. grade 및 chosen.frequency가 null이어야 하는 branch를 분명히 한다.

RED/GREEN: 아래 '필수 경계 행렬' M1~M7 전부. 특히 같은 선택 전 snapshot에 서로 다른 chosenAction을 얹어도 query output이 같고, maxRaiseTo가 native action보다 작으면 clamp하지 않고 unsupported다.

### T5. coverage를 봉인·게시·소비하는 계약

파일: `publish-contract.js`, `training/public-view.js`, `tools/training-control.js`, `tools/training-pipeline.js`, `tools/game-loop.js`, `training/profile-store.js`, `training/explain.js`, `server/public/training-format.js`; 테스트 신규 `test/reference-coverage-authority.test.js`, 기존 `test/training-publish.test.js`, `test/training-public-view.test.js`, `test/proof-profile.test.js`, `test/training-authority-migration.test.js`, `test/training-authority-v2.test.js`, `test/training-explain.test.js`, `test/decision-time-review.test.js`.

- v2 coverage closed projector를 summary canonical hash에 포함한다. v1 optional omission의 기존 digest golden을 유지한다.
- accept/materialize에서 detail와 summary의 coverage/full source/decision identity를 교차 결박한다. forged summary→true metric flag, detail-only tamper, source-only swap을 모두 거절한다.
- accept는 canonical completed hand의 user snapshot에서 query/compare를 재계산한다. coverage.input의 chip/BB, raw/computed effective stack, legal, opponentTotals와 reference.sizing의 intended/represented size를 모두 비교한다. hand/source missing은 pending/unavailable이며 fabricated context를 받아들이지 않는다.
- v2 profile event를 schema 5로 출력한다. 기존 1~4 이벤트는 읽고 새 필드 없이 v1으로만 해석한다. source v2에 coverage가 없는데 legacy fallback으로 점수를 주지 않는다.
- buildExplanationPrompt에 coverage/eligibility를 전달하고 training/explain의 projected/choice-unavailable branch는 수치 주장을 거절한다(handNo 예외만 유지). 112bb→100bb와 참고 빈도는 검증된 기계 카드가 렌더링한다. 정확한 projected 수치를 LLM에 쓰게 하고 기존 validator가 NUMBER_CONTRADICTION으로 거절하는 혼합 설계를 만들지 않는다. 설명 부재는 사실 기반 card를 제공하고, summary만 받은 브라우저는 verified detail이 오기 전 숫자/grade를 노출하지 않는다.
- aggregateProcessRows/trainingAggregate/process-review도 reference-supported와 exact comparison count를 분리하고 game-loop 종합 evaluator의 qualified reference grades는 exact만 받게 한다. 구현 시 `status === 'supported'`, sourceQuality, matchReferenceAction 소비자를 전수 검색해 audit 표로 기록한다.

RED/GREEN: 동일 v1 artifact가 이전과 동일 digest/grade, v2 metadata 하나만 바꾸면 proof failure, summary/details/source 불일치가 profile에 들어가지 않음, 설명 unavailable 시 정확한 기계 카드, publication body size/bounded read 유지.

### T6. 프로필·study·mistake·assessment의 버전 및 표본 분리

파일: `training/profile-aggregator.js`, `training/profile-store.js`, `training/study-history.js`, `training/mistake-bank.js`, `training/opportunities.js`, `tools/study-summary.js`, `tools/profile-cli.js`, `training/process-review.js`, `shared/study-contract.js`; 테스트 기존 `test/profile-aggregator.test.js`, `test/profile-store.test.js`, `test/profile-exactly-once.test.js`, `test/learning-metrics.test.js`, `test/drill-learning.test.js`, 신규 `test/reference-version-coexistence.test.js`.

- R7 field별 분모 및 합산 규약을 구현한다. source identity alone를 근거로 집계하지 않고 shared eligibility helper를 사용한다.
- source segment, active segment 선택, score/calibration과 raw coverage를 분리한다. projected 및 unavailable input은 행동 mix/성장/mistake evidence에 들어가지 않는다.
- v1/v2 mixed store의 원본 event bytes는 유지하고 profile projection만 schema 5로 rebuild한다. 동일 evaluationId/payloadSha256 재소비는 no-op, 다른 payload는 conflict다.
- 과거 assessment/retest는 exact source triple를 유지한다. v2 문제로 치환해서 재시험 개선을 계산하지 않는다. native v2에서 같은 source/question set인 경우에만 retest가 성립한다.

RED/GREEN: 100개 projected를 추가해도 exact score/calibration 표본과 mistake 후보는 변하지 않음; raw coverage만 변함. v1 native+v2 native 혼합 시 source segment별 수치 유지 및 UI active source 표시. interrupted rebuild/retry는 원본 event를 중복 append하지 않음.

### T7. source-aware drill와 사후 UI

파일: `training/drill-generator.js`, `training/drill-evaluator.js`, `tools/drill-cli.js`, `tools/drill-server.js`, `tools/study-summary.js`, `server/public/training-format.js`, `server/public/app.js`, `server/drill-public/study-format.js`, `server/drill-public/drill.js`, `tools/game-loop.js`, `README.md`, `ARCHITECTURE.md`, `.agents/skills/start-game/SKILL.md`; 테스트 기존 `test/drill-generator.test.js`, `test/drill-cli.test.js`, `test/drill-server.test.js`, `test/training-cards.test.js`, `test/study-format.test.js`, 신규 `test/browser/reference-coverage-journey.mjs`.

- 고정 8개 key/regex/label parser/DEFAULT_DATASET를 pinned source catalog 선택으로 바꾼다. schema 2 stored drill의 exact source로 dataset을 resolve하고 v1 queue/ID/정답을 보존한다.
- 8/9인 포지션·오프너·100bb native 상황을 질문 prompt/actionHistory/legalActions에 정확하게 넣는다. 새로운 key를 넣고 여전히 6-max 고정 prompt를 보이면 실패다.
- 카드/summary에 exact/projected/비교 불가/source version을 표시하고, projected metadata가 검증되지 않으면 수치를 숨긴다. 큰 데이터 목록을 모두 DOM에 렌더링하지 않는다.
- native v2 카드→drill→answer→profile 연결, v1 pending drill resume, v1 retest, mixed source history, mobile display를 검증한다.
- gtoEvalNotice/README/skill의 실제 지원 범위를 일치시킨다. 게임 중 현재 decision에 사전 정답이 없다는 기존 공개 경계는 유지한다.

RED/GREEN: HJ/CO vs-open과 8/9인 카드에서 source/key/문제 생성 일치, v1 재개 SOURCE_CHANGED 오검출 없음, projected 카드에서 점수/후보 버튼 오노출 없음, 100bb native로 별도 시작할 때 original 112bb 재현이라고 쓰지 않음.

### T8. 활성화, 통합 검증, 구현 보고

파일: v2 default 전환에 필요한 `shared/reference.js`, `tools/reference-source.js`, `tools/preflop-dataset.js` 및 신규 `test/reference-coverage-release.test.js`, `test/helpers/reference-coverage-fixtures.mjs`; 이전 단계에서 소유한 파일의 검증 수정만 허용한다. 범위 확장 발견 시 해당 단계 설계와 증거를 갱신한다.

1. v2의 source/default를 새 세션에만 활성화한다. v1 active session/legacy policy/study session의 source가 바뀌지 않는 통합 테스트를 먼저 통과시킨다.
2. 이번 고정 24개 preflop snapshot을 v1/v2 evaluator에 replay한다. v1 8 supported를 모두 보존하는지와 새 HJ/CO 4건이 exact로 비교되는지 확인한다. 예상 upper-bound 12/24는 **확정 테스트 목표**로 쓰되, 실패 시 reason을 조사하고 dataset/통계 규칙을 완화해 통과시키지 않는다. 기존 12개 limp/4bet+은 unsupported 유지. 전체14 postflop도 그대로다.
3. 6/8/9인 ×100bb native smoke, projected boundary corpus, v1→v2 new session/mixed store, 중간 종료/restart/evaluate flush/profile consume 경로를 통합 실행한다. 새 난수 20핸드 run은 terminal/provenance/누락/cleanup 조건을 확인하고 지원률은 보고값으로만 남긴다.
4. 구현에 맞는 기존 테스트 및 신규 경계 테스트를 통과한 뒤 `npm run test:ci`, `npm run benchmark:policies`와 `node tools/build-preflop-baseline.js --check`를 실행한다. CI에서 저장소의 지원 Node 20/22 및 Windows 축을 terminal receipt까지 확인한다. local Node 26 결과를 해당 CI 결과로 대신하지 않는다.
5. 실제 브라우저에서 T7 경로를 검증한다. 기능 성공·단순 reliability·전략 품질·사람의 학습 효과를 분리해 release report에 쓴다. lint/mutation 센서는 현재 미설치이므로 PASS로 기록하지 않는다. 설치가 필요해지면 별도 실제 준비 후 실행한다.
6. PR/merge/배포는 이번 설계 요청에 포함되지 않는다. 이후 구현 작업에서 사용자 승인 범위와 repo 규칙에 따라 진행한다. 이 단계의 완료가 #147 구현/모든턴 지원을 뜻하지 않는다.

## 필수 경계 행렬

| ID | 양성 사례 | 반례 / 실패 계약 |
|---|---|---|
| M1 | snapshot schema2, public topology/actor/opener/decisionId 일치 | malformed/null/string/NaN/Infinity, duplicate actor/opener, position mismatch, no authoritative legal |
| M2 | 6 HJ vs UTG; 8 LJ vs UTG1; 9 HJ vs LJ, 모든 legal pair | out 좌석 count를 active hand folded count로 오해, 9 UTG+1을 HJ로 매핑, BB unopened, already acted hero |
| M3 | RFI 0 raise 또는 1 raise/no call | limp/cold-call/squeeze/4bet+, incomplete action sequence, tournament/ICM, unsupported seat counts |
| M4 | stack100 exact,80/120 projected |79.999/120.001 unsupported, 비균질 stack, opener effective와 table maximum 혼동 |
| M5 | exact ±0.05bb, open2/3,3bet6.5/10.5 projected | 범위밖 epsilon, ambiguous multiple matches, impossible native raise, all-in clamp, nonrepresentable integer chips |
| M6 | query chosenAction 없이 반환, compare 후 exact grade | chosenAction을 바꿔 query 추천 변화, invalid/forged reference object, hand outcome/상대 hidden cards 소비 |
| M7 | positive action 합법, legal한 zero-frequency 선택은 exact off-policy | canRaise false인데 raise권고, canCheck true인데 call권고, illegal mass를 삭제/정규화해서 success |
| M8 | v1/v2 source triple 및 동일 세션 source 고정 | hash/version mismatch, metadata deletion, forged source or path, stale cache keyed only by provider id |
| M9 | exact proof→metric, projected proof→참고 coverage |coverage 누락/summary-detail 불일치/metricEligible=true 위조/source only rename→score, canonical snapshot와 raw/computed/칩·BB 불일치 |
| M10 | v1 bytes/old profile score 유지, mixed source별 집계 |v1을 unverified로 강등, v1/v2 합산 calibration, projection을 mistake/retest에 사용 |
| M11 | source-aware native question, old queue/resume |8/9 key에6max prompt, fixed8 allowlist 탈락, pending v1을v2로 재채점 |
| M12 | accept→publish→consume 각 interruption 후 exactly once |중복 event, conflict 묵인, old binary로v2 state 변환/무시 |
| M13 | live default20 terminal + owned relay/study 정리 |run timeout/불명확한 process death를 성공으로 기록 |
| M14 | projected 수치는 기계 카드, 해설은 비수치·비채점, 종합 분모는 exact만 | coverage 없는 v2 설명, projected를 qualified grade로 전달, LLM이 투영을 숨기거나 112bb/100bb/빈도 숫자를 새로 주장 |

## 구현 시작 체크

- 이 문서와 design의 최신 SHA/소스 HEAD를 다시 고정한다. concurrent commit이 있으면 영향을 확인하고 stale reference를 수정한다.
- 관련 source 파일만 바꾸며 현재 worktree의 사용자가 만든 파일/런타임 store를 보존한다.
- 로컬 연구 자료는 git ignored다. 향후 PR에 넣을 문서/비밀 없는 fixture 경로를 명시적으로 정하고, 런타임 세션 전체를 force-add하지 않는다.
- 미지원 범위/투영 폭/원본 recipe는 결정 완료다. 계수를 개선하려면 source version/설계 재검토가 필요하다. 엔진 top-up 추가나 hand-strength boundary 개방은 작업에 포함하지 않는다.

## 현재 검증 증거

연구 단계에서 기존 관련 테스트 **75 passed / 0 failed** (`focused-tests.log`) 및 격리 default 20-hand terminal run을 확인했다. 구현 후 테스트 T1~T8/M1~M14은 아직 실행되지 않았다. 미래 코드의 GREEN이나 릴리스 완료로 해석하지 않는다. 독립 리뷰 결과와 최종 구현 준비 판정은 `readiness.md`에 기록한다.
