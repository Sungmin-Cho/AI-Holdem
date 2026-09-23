# 테이블 전체 JEV 플레이어 설계

작성: 2026-09-22 · 상태: 구현 준비 완료 · 제품 코드 미구현 · 작성 모델: gpt-6-astra

이 문서는 의도적으로 `docs/implementation/`의 검토 가능한 프로젝트 산출물로 작성한다. 자동 커밋/공개는 하지 않는다. 기준 코드: `3a647c09780afe2971b7a4bf3097b52002db151c`.

## 1. 목표와 범위

로비의 상대 행동 방식에 `JEV 플레이어`를 추가한다. `opponentRuntime: "jev"`인 게임의 **모든 AI 좌석**은 JEV를 사용한다. 인간 호스트·온라인 참가자·관전자 역할은 기존과 같다. cash-training과 tournament, 싱글 및 온라인 테이블에 적용한다. AI 0명인 온라인 테이블에서는 SDK/키 검사와 호출을 생략한다.

사용자는 전체 JEV 모드와 설계 → 구현 플랜을 요청했고 나머지 구현 선택을 위임했다. 이 문서는 구현 승인 전 설계 산출물이다. 현재 기본값 `policy` 유지, 좌석별 혼합·진행 중 런타임 변경·JEV 코치·원격 모델 학습은 범위 밖이다. mirror-self/exploit-self는 계속 policy 전용이다. 코치·evaluator·종합 리뷰는 기존 upper LLM과 기계 피드백 경로를 사용한다.

## 2. 확인된 근거

- `shared/game-setup.js`: setup 검증이 policy/llm 두 값만 허용한다. 예산·pace는 저장된 setup으로 재시작한다.
- `tools/game-loop.js`: engineInitFlags, parseArgs, requestedOpponentRuntime, bootstrap/resolveForPhase/resume, 결정 실행 및 metrics가 두 런타임을 전제한다. `decideWithWatchdog`는 CLI 세션·교정·종료 증명과 강하게 결합되어 있다.
- `engine/cli.js:cmdDecisionPeek` → `engine/decision.js:snapshotDecision`: 행동자 패·공개 보드·공개 좌석·현재 핸드 액션·합법 범위를 읽을 수 있다. snapshot을 그대로 전송하면 안 된다. dealSelection 등의 학습용 내부 메타가 포함된다.
- `engine/game-archive.js`: policySeed만 engine state에 저장하고 opponentRuntime 자체는 현재 저장하지 않는다. loop-state가 사라지면 policySeed 또는 호출 인자로 런타임을 추정한다.
- `tools/session-manager.js`: 재시도/새 세션 UI 권한을 투영한다. 새 LLM 세션은 JEV에 의미가 없다.
- SDK 실측: Node v26.0.0, 전역 JS `@typesafe-ai/sdk@0.6.0`, Python `typesafe-sdk@0.7.1`, 현재 프로세스의 키 존재 확인. 프로젝트 import는 미해결이다. 키 값은 읽어 출력하지 않았다. 실제 API 인증·추론·지연은 미검증이다.

공식 문서(2026-09-22 확인):

1. https://docs.typesafe.ai/sdk/javascript — Node >=20, ESM 지원, TypeSafeClient/choice/systemOne.
2. https://docs.typesafe.ai/api — Choice 최대 255개, choice는 최고 확률 옵션, probabilities와 confidence, 401/422/429/529.
3. https://docs.typesafe.ai/confidence — confidence는 선택 분포의 통계이며 승률이나 EV가 아니다.
4. https://docs.typesafe.ai/model-jaggedness/jev-1.13 — 수치 계산·큰 무관 문맥·생성 작업의 한계, 적대적 입력 가능성.
5. https://docs.typesafe.ai/models — 버전 `jev-1.13.0`, 별칭 변동, 영어 우세, state+최장 질문 32k/전체 64k 토큰.
6. https://docs.typesafe.ai/sdk/javascript/api/interfaces/RequestOptions — AbortSignal, 시도별 timeout, 총 재시도 예산 없음.
7. https://docs.typesafe.ai/sdk/javascript/api/interfaces/RetryPolicy — 기본 2회 재시도, 408/429/5xx 등.

## 3. 확정 설계 선택

| 항목 | v1 결정 | 이유 |
|---|---|---|
| 연결 | Node 서버 내부 JS SDK 전용 어댑터 | Python/CLI 자식이나 LLM 세션 불필요 |
| 선택 | 합법 액션+금액 후보에 대한 Choice 한 개. 응답 검증은 v1 계약을 유지하고, 실행할 행동은 클라이언트가 검증된 확률의 행동 클래스를 시드로 추첨한다(v2 — §결정 규칙 v2) | API `choice`는 사이즈 수만큼 쪼개진 확률의 argmax 라벨이라 그대로 실행하면 레이즈가 과소 선택되고 혼합 전략이 없다. 추첨은 GTO 빈도의 주장이 아니다 |
| low confidence | 유효 응답은 실행, 호스트 진단에만 기록 | 임의 임계값으로 과도한 폴드/LLM 전환 방지 |
| 실패 | 일시정지 후 명시적 재시도/종료 | 자동 policy/LLM/check/fold 대체 없음 |
| 자동 HTTP 재시도 | SDK `maxRetries: 0` | 중복 추론·숨은 대기 억제, 기존 명시적 복구 UX 사용 |
| 예산 | 기존 soft=25s/hard=300s 및 설정/저장 규약 재사용 | 미측정 속도로 새 기본값을 가정하지 않음; soft는 취소 아님 |
| 모델 | `jev-1.13.0` 명시 고정 | SDK 환경변수/별칭으로 실험 의미가 변하지 않음 |
| 페르소나 | 기존 6 archetype을 허용 목록의 영어 문장으로 매핑 | 이름·자유 텍스트를 원격 지시로 쓰지 않음 |
| 설명 | 자유 생성 reason 없음 | JEV 선택을 LLM 설명처럼 꾸미지 않음 |
| 속도 | policy와 같은 최소 AI 액션 간격 적용 | API 응답이 빨라도 테이블 pace 유지 |

위 값은 운영·제품 결정이지 포커 실력이나 응답속도 보장이 아니다. 별도 사용자 결정이 필요한 잔여 항목은 현재 없다.

## 4. 모듈 경계와 데이터 흐름

신규 `tools/jev-player.js`는 순수 함수 `projectJevState(snapshot, legal, archetype)`, `buildJevCandidates(snapshot, legal)`, `validateJevAnswer(response, candidates)`, `selectJevAction({probabilities, candidates, unit, apiChoice})`를 노출한다. 런타임은 전송·검증까지만 하고 선택 규칙을 모른다. 신규 `tools/jev-runtime.js`는 lazy SDK import, 서버 키 검사, `decide({state, candidates, signal, timeoutMs})`, `dispose()`를 제공한다. 클라이언트/fetch·시계는 테스트에서 주입 가능하다.

`game-loop`가 engine envelope identity 확정 → pending 저장 → decision-peek/projection/candidates → JEV 호출 → 응답/동일성 검증 → 선택 규칙 → 진단 entry와 proposedAction 단일 저장 → engine step → pending 제거 → 기존 publish를 소유한다. 엔진 legal과 `--expect-version`이 최종 실행 권한이다. JEV runtime에는 엔진 변경 API·파일 경로·state 전체를 주지 않는다.

런타임별 능력은 아래 표로 명시하며 `!policyMode`를 `llm`의 뜻으로 사용하지 않는다.

| 능력/경계 | policy | llm | jev |
|---|---|---|---|
| player CLI adapter 필요 / NO_PLAYER_RUNTIME 검사 | 아니오 | 예 | 아니오 |
| player warm/restore 및 session repair | 아니오 | 예 | 아니오 |
| policy stamping/self consistency | 예 | 아니오 | 아니오 |
| upper resolver 목적 | upper-only | player+upper | upper-only |
| remote decision budget/pending | 없음 | 기존 v1/v2 | v3 HTTP |
| AI pace 사전 대기 | 예 | 기존 동작 | 예 |
| metrics.runtime | policy | playerAdapter.kind | jev |

변경 지점은 bootstrap 7263/7316/7335/7345, resume 7503/7513/7516/7528, run 7952/7962/7990 및 이 호출들의 helper다(기준 코드 줄 번호). pace는 기존 policy와 동일하게 직전 게시 이후 결정 호출 **전에** 최소 간격만큼 대기한다. API 지연은 그 뒤 더해지며, 결과를 늦게 게시하기 위한 두 번째 대기는 없다.

기존 CLI LLM 어댑터의 create/restore/sessionId/repair/probe 규약에 JEV를 억지로 맞추지 않는다. 루프에는 `decideWithJev`를 추가하고, identity 비교·pending 저장·엔진 적용/복구처럼 실제로 공유되는 작은 경계만 추출한다. LLM 교정/CLI 자식 종료 로직의 대규모 일반화는 하지 않는다. 기존 pending v1/v2 동작은 회귀 테스트로 고정한다.

### 4.1 원격 전송 허용 목록

전송 객체는 닫힌 스키마로 새로 구성한다. snapshot spread 금지. publicSeats의 안정된 테이블 좌석 순서(index)를 기준으로 `seat_0`…`seat_8`을 만들고 actor/publicSeats/priorActions 전체를 같은 map으로 치환한다. 원래 participant/player ID와 이름은 state·question에 넣지 않는다. 로컬 기존 엔진 action의 playerId는 원래 계약대로 보존하며 원격 진단에는 별칭만 사용한다.

- gameMode, street, position, blinds, potBefore, currentBet, actorBet, toCall.
- 행동자 holeCards, 현재 공개 board; `publicSeats`의 합성 playerId/position/stack/bet/contribution/folded/allIn/out.
- 공개 priorActions의 playerId/action/amount/street/currentBet/potTotal만. 현재 핸드 내 최신 64개, `historyTruncated`와 전체 개수; 이전 핸드 대화/리뷰 없음.
- 검증된 legal 범위와 후보들의 정확한 action/raise-to/추가 투입 칩 설명, 허용된 영어 archetype 설명.
- 코드로 계산한 파생 숫자(projection v2): `bigBlind`, `actorStackBB`, `effectiveRemainingBB`, `seats[].stackBB`(소수 1자리)와 회수 가능 팟 기준 팟 오즈 `potOdds = toCall / (T + Σ_{상대} min(contribution, T))`(`T` = 행동자 기여 + toCall, 사이드팟 배제, toCall 0이면 0) 및 금액 단위 설명. equity·승률 추정은 범위 밖이다.

나머지 필드는 금지: 다른 플레이어의 비공개 패, deck/seed, 미공개 미래 보드, 이름·채팅·note·reason·성향 원문, dealSelection, assistance, 경로, 세션 토큰, API 키. JSON 직렬화 후 24 KiB 상한(토큰 수 보장이 아닌 자체 보호 한도); 초과는 `JEV_INPUT_TOO_LARGE`로 재시도 불가 복구 대기(`retryable:false`)다. 동일 입력의 결정론적 실패는 반복 호출하지 않고 현재 게임 종료만 허용한다. 카드 표기는 코드에서 영문 rank/suit로 변환한다. `decisionId/gameEpoch/stateVersion/generation`은 로컬 적용용이며 전송할 필요가 없다.

UI에는 “모든 AI가 JEV로 행동하며, 각 AI의 패와 공개 테이블 정보가 TypeSafe API로 전송됩니다.”를 선택 설명으로 표시한다. 온라인 참가자에게도 입장 전에 “호스트가 JEV를 선택하면 공개 좌석 정보와 플레이 액션이 TypeSafe로 전송됩니다. 참가자의 비공개 패·이름·계정 ID는 전송하지 않습니다.”를 표시한다. 호스트가 상대 방식을 정하며, 시작 시 잠긴 setup에서 파생한 공개 aiProvider=jev를 참가자 lobby/table에 표시한다. 입장 전 일반 고지와 실제 모드 표시를 함께 제공하고 별도 동의 체크박스/새 권한 체계는 만들지 않는다. API 키 입력 UI는 만들지 않는다. 게임 API·SSE·참가자 화면에 키나 원격 원문을 보내지 않는다.

### 4.2 후보 생성 (`legal-menu-v2`)

모든 칩 계산은 safe integer로 검사하고 금액은 raise-to 총액이다. `legal.canCheck`이면 check, 아니면 fold와 call(callAmount>0)부터 만든다. free-fold는 후보에서 제외한다. 모든 결과는 실행 전 최신 legal로 다시 검증한다.

- canRaise=false: raise 후보 없음.
- canRaise=true이고 minRaiseTo>maxRaiseTo: 엔진이 허용하는 short all-in `maxRaiseTo` 하나.
- 그 외 preflop, 오픈되지 않은 팟(currentBet ≤ BB, 림프·헤즈업 블라인드 포함): minRaiseTo, round(2.5×BB), 3×BB, 4×BB.
- 그 외 preflop, 레이즈 직면(currentBet > BB): minRaiseTo, round(2.5×currentBet), 3×currentBet, 4×currentBet.
- 그 외 postflop: minRaiseTo 및 `actorBet+toCall+round(f*(potBefore+toCall))`, f∈{1/3,2/3,1}.
- all-in(`maxRaiseTo`)은 (a) minRaiseTo>maxRaiseTo, (b) 유효 잔여 스택 ≤ 20BB, (c) maxRaiseTo ≤ 1.5 × (clamp 뒤 표준 사이즈 최댓값) 중 하나일 때만 후보다. 유효 잔여 스택 = `max(0, min(행동자 stack, max_{폴드·탈락 아닌 상대}(stack + bet) − 행동자 bet))`(올인 상대의 bet 포함). clamp로 maxRaiseTo에 닿은 표준 사이즈는 그대로 후보다.
- 후보 금액을 [minRaiseTo,maxRaiseTo]로 clamp하고 중복 제거 후 오름차순. `raise_to_<integer>` 키를 사용한다. short all-in도 엔진 action은 `raise`; call all-in은 `call`이다.
- 동일 금액의 이름만 다른 후보 금지. candidate 순서는 fold/check/call 다음 금액 오름차순으로 고정. 후보는 최대 7개(보통 더 적음).
- 후보가 하나면 HTTP만 생략한다. 동일 pending → proposedAction durable commit → atomic transition/expect-version → 결과 reconcile/clear/publish 경로를 반드시 거쳐 실행하며 outcome=`jev_single_legal`; JEV 판단으로 집계하지 않는다.

이는 유한한 베팅 메뉴를 가진 휴리스틱 플레이어다. 임의 금액 최적화나 solver와 동등한 행동 공간을 제공하지 않는다. descriptor는 최초 저장에 고정되며 알려진 v1은 재개 시 roll-forward된다(loop-state 마커, §5).

### 4.3 질문과 응답

하나의 영어 Choice 질문으로 “주어진 공개 상황, 자기 패, 플레이 스타일에서 지금 실행할 후보 하나”를 고른다. 후보 criteria에 실제 행동과 금액 의미를 설명한다. 질문 간 의존이나 Score의 소수 출력을 베팅 금액으로 보간하지 않는다.

응답 수용 조건: 객체/정확한 answer 이름과 type, 등록된 choice, 후보와 정확히 같은 probabilities 키 집합, 유한한 각 확률 [0,1], 합 1±1e-6 (모든 값이 0.01 단위이면 후보 수 × 0.005 + 1e-6의 반올림 상한 적용), confidence [0,1], 응답 model이 저장된 model과 일치, choice가 최대 확률(tolerance 1e-6; 동률이면 반환 choice 허용). usage는 있으면 비음수 safe integer로 검증하고 없으면 unknown이다. 분포·confidence도 공식 응답 계약의 일부로 엄격 검증한다. 합법 choice라도 필수 진단 필드가 손상되면 중단하는 가용성 대가를 의도적으로 수용한다. 이를 추후 완화하려면 별도 설계 변경으로 다룬다. 형식 불량은 `JEV_INVALID_RESPONSE`, 모델 불일치는 `JEV_MODEL_MISMATCH`; 응답 확률 자체를 조용히 고치지 않는다.

검증을 통과한 응답에서 API 라벨을 그대로 실행하지 않고 검증된 확률로 행동 클래스를 추첨한다(정규화는 클래스 질량에만, §결정 규칙 v2). 질문 지시문(`poker-choice-v2`)은 성향이 빈도만 바꾸고 핸드 서열·스택 깊이 원칙은 바꾸지 않는다고 명시한다.

선택 후 `{action, amount?}`만 엔진 경계로 전달한다. reason은 만들지 않는다. probabilities/confidence는 private 진단이며 human-facing 전략 정답·승률로 노출하지 않는다.

## 5. 영속 설정과 호환성

신규 게임의 `state.config.opponentRuntime`을 모든 모드에서 명시한다. JEV에는 `state.config.jev={schemaVersion:1,model:"jev-1.13.0",questionVersion:"poker-choice-v2",candidateVersion:"legal-menu-v2",projectionVersion:2,selectionVersion:"class-sample-v1"}`을 최초 engine commit에 포함한다. 키/엔드포인트/원문은 저장하지 않는다.

알려진 v1 descriptor(재개 시 roll-forward 대상, `JEV_CONFIG_LEGACY`):

```json
{"schemaVersion":1,"model":"jev-1.13.0","questionVersion":"poker-choice-v1","candidateVersion":"legal-menu-v1","projectionVersion":1}
```

공유 `shared/opponent-runtime.js`가 descriptor 상수와 닫힌 validator를 소유한다. CLI `init --opponent-runtime jev`는 기본 상수를 사용하며, 선택적 `--jev-config-file <absolute-json-path>`로 지원 목록의 descriptor를 전달할 수 있다. 파일은 4 KiB 이하의 regular non-symlink JSON으로 읽고 extra key/미지원 모델·버전/잘못된 조합을 init mutation 전에 거부한다. JEV 아닌 모드에 이 flag를 주면 usage error. 설정 파일에는 비밀이 없다. `engineInitFlags`는 세 런타임을 명시적으로 전달하고 내부 전달된 descriptor가 있으면 준비된 session 디렉터리의 전용 파일을 사용한다. engine/game-archive.js도 최초 저장 전에 같은 validator를 사용한다.

restart는 브라우저 setup에 새 임의 모델 입력을 허용하지 않는다. session-manager가 기존 engine.config.jev를 읽어 **서버 내부 command row의 `jevConfig`**로 고정하고, launcher의 내부 opts → init config 파일로 전달한다. command row 복구도 저장된 descriptor를 재사용한다. 신규 게임 row는 현재 기본 descriptor를 고정한다. 같은 설정 restart는 새 게임이므로 알려진 v1 descriptor를 현재 descriptor로 시작하고, 모르는 descriptor는 `JEV_CONFIG_UNSUPPORTED`로 거부한다. 진행 중 store의 재개 roll-forward와 downgrade·완료 store 경계는 §결정 규칙 v2를 따른다. P1은 이 producer→journal→launcher→engine 경로를 완결한다.

런타임 해석 표:

| engine.config 상태 | 정본 및 교차 검사 |
|---|---|
| opponentRuntime 존재, 유효 | engine 값이 정본. loop-state, 저장 app setup, **사용자가 명시한** resume flag가 존재하면 모두 일치해야 함 |
| opponentRuntime 존재, unknown/null/잘못된 타입 | INVALID_OPPONENT_RUNTIME, fallback 없음 |
| opponentRuntime 필드 부재, jev 필드 존재 또는 다른 기록이 jev | JEV_CONFIG_UNSUPPORTED: 신규 descriptor 손상으로 간주; legacy 추정 금지 |
| opponentRuntime 필드 부재인 legacy, loop-state runtime 유효 | legacy loop-state 정본. policySeed가 있는데 runtime이 llm이면 충돌; app setup/명시 flag도 일치 검사 |
| 필드 부재인 legacy, loop runtime 없음, policySeed 존재 | policy; app setup/명시 flag가 다르면 충돌 |
| 필드 부재인 legacy, loop runtime 없음, policySeed 없음 | 기존 legacy 기본 llm; app setup/명시 flag가 다르면 충돌 |

여기서 legacy는 **config 객체 자체의 부재가 아니라 config.opponentRuntime 필드 부재**다. 과거 알 수 없는 loop runtime도 fail closed한다. 새 JEV descriptor는 완전한 exact shape와 지원 tuple이어야 한다. loop 사본은 현재 descriptor 또는 알려진 v1이어야 하며(재개 시 v2로 갱신), 엔진 사본은 출생 descriptor로 남는다. 새 게임·CLI 설정 파일·앱 start row·부트스트랩은 현재 descriptor와 정확히 같아야 한다. `OPPONENT_RUNTIME_MISMATCH`/`JEV_CONFIG_UNSUPPORTED`는 기록을 보존하고 자동 플레이를 막는다. 단 종료/abandon은 손상 config를 새 모델로 대체하지 않고 기존 안전 종료 경로를 사용한다.

`createGameLoop`의 policy-else-llm 기본값(835), resolveForPhase의 fallback(7513), loop-state 없는 resume의 policySeed 추정(7692)을 위 resolver 한 곳으로 대체한다. 코드가 만든 기본 인자는 사용자가 명시한 resume flag로 간주하지 않도록 explicitness를 parser부터 보존한다. loop-state 삭제 후 신규 JEV는 engine config에서 그대로 복원한다. completed/finalizing에서는 플레이어 SDK/키가 없어도 종료 표시·리뷰 복구 가능하다.

구형 바이너리가 이 확장을 막아 준다고 가정하지 않는다. **진행 중 JEV store를 구버전으로 downgrade하지 않는다.** 호환 버전에서 세션 종료 후 롤백하고 기록을 그대로 보존한다. 신규 버전이 구형 policy/llm을 읽는 호환성과 구형 코드가 JEV를 실행하는 역호환은 다른 계약이다.

## 6. 호출 수명·복구

JEV pending은 별도 v3 닫힌 스키마: `schemaVersion:3, runtime:"jev", executionKind:"http", gameEpoch, decisionId, stateVersion, playerId, generation, status, budget, startedAt, softWait?`, 및 선택적으로 `code, closeConfirmed, proposedAction, retryable`. retryable은 실패 시 명시하는 boolean이며 입력 오류에서는 false, 원격/네트워크 오류에서는 true다. status는 running/recovery_required/retry_authorized/unsafe. CLI diagnostics와 freshAuthorization은 불허. 소유 시도 identity는 기존처럼 메모리에 유지한다. 모든 pending 소비자는 schema별 validator로 dispatch하고 알 수 없는 버전은 fail closed한다.

### 6.1 정상·오류·사용자 조작

HTTP runtime은 idle/active/disposing/disposed/closure_unconfirmed 상태를 갖는다. active는 최대 1개, disposing 이후 새 decide는 거부한다. 루프가 runtime을 자신이 소유하는 disposable로 등록하고 requestStop에서 명시적으로 abort·settlement를 기다린다. resolver의 CLI adapters 집합에 들어갔다고 가정하지 않는다. JEV dispose 완료와 기존 atomic/engine/coach 종료를 모두 확인한 뒤에만 requestStop이 closeConfirmed와 락 해제를 기록할 수 있다.

abort 후 settlement grace는 2,000ms다. 초과 시 적용 capability를 먼저 폐기하고 pending을 unsafe/`JEV_REQUEST_CLOSE_UNCONFIRMED`, closeConfirmed=false/retryable=false로 기록한다. interrupt/stop 호출은 bounded error로 반환하며 성공이나 종료 확인을 보고하지 않는다. **응답 처리 continuation**은 revoked attempt에서 어떤 엔진/기록 변경도 할 수 없다. 별도의 loop 소유 closure observer만 실제 promise settlement를 관찰하고 아래 후처리를 할 수 있다. 미확인 동안 새 게임/재시도/일반 resume/End를 거부하고 소유 락을 유지한다.

- 뒤늦게 settle하면 runtime은 disposing 요청 여부에 따라 disposed 또는 idle로 전환한다. closure observer는 루프 락 소유·동일 전체 identity·unsafe 코드·proposedAction 없음·현재 엔진 차례가 여전히 일치함을 확인한 경우에만 recovery_required/INTERRUPTED/closeConfirmed=true/retryable=true로 전환한다. 여전히 자동 추론/적용은 금지한다. 불일치면 unsafe를 유지한다.
- interrupt 때문에 실패했다면 호스트에 paused/retry 가능 상태를 다시 알린다. stop 때문에 실패했다면 closure 오류에 한해 실패한 stop latch를 재시도 가능하게 하고 기존 requestStop의 전체 atomic/engine/coach cleanup을 다시 실행한다. observer 단독으로 락을 풀거나 다른 cleanup 실패를 지우지 않는다. disposed runtime은 후속 명시적 재시도/재개에서 새 인스턴스로 생성한다.
- 영원히 settle하지 않으면 자동 재기동/프로세스 kill은 하지 않는다. 호스트에 “JEV 요청 종료를 확인하지 못했습니다. 재시도와 새 게임을 막았습니다. 앱 서비스를 종료한 뒤 다시 열어 복구하세요.”를 표시한다. 운영 절차는 먼저 `npm run app:stop -- <absolute-store>`를 시도하고 실패/종료 미확인 시 descriptor와 앱 lock의 PID+startTime을 재검증한 운영자가 그 소유 앱 프로세스를 종료한 뒤 사망을 확인하는 것이다. 임의 node kill·락 파일 삭제는 금지한다. 이후 정상 앱 시작의 stale-owner 검증과 loop 락 인수 뒤 §6.2를 수행한다. 기존 stop 명령에 강제 종료가 내장됐다고 가정하지 않는다.

실제 SDK가 정상적인 abort에서 grace 안에 settle하지 못하면 P3 인수를 막고 transport 격리 방식부터 재설계한다. 위 예외 경로는 운영 출구이지 SDK 계약 검증을 대체하는 정상 경로가 아니다.

1. 현재 엔진 envelope의 next/stateVersion에서 전체 결정 identity를 확정하고 **decision-peek/projection/후보 생성 전에** running 기록을 commit한다. 이 저장 실패 시 추론/step은 0회다. 이후 peek의 VERSION_MISMATCH는 현재 run catch(7966–7974)의 step 조회→pending 제거→재게시 resync를 재사용한다. 이때 HTTP 미시작/자신이 저장한 running identity/proposedAction 없음만 확인해 해당 pending을 제거하며, 다른 세대의 pending은 지우지 않는다. 일반적인 임의 identity 불일치까지 자동 삭제로 확대하지 않는다. 그 외 입력 오류는 동일 pending을 recovery_required/closeConfirmed=true/retryable=false로 갱신한다(HTTP 미시작). 단일 후보 경로도 아래 5–6의 동일 engine commit 절차를 사용한다.
2. 한 번의 systemOne 호출. SDK timeout에 남은 hard budget, retry=0, AbortSignal을 전달하고 루프의 절대 deadline timer도 abort한다. HTTP 준비·호출·검증을 포함하며 SDK 기본 10s가 덮어쓰지 않도록 명시한다.
3. soft deadline은 softWait/진단을 갱신한다. host interrupt는 기존 LLM과 동일하게 running+현재 identity+softWait=true+proposedAction 없음일 때만 abort하고 grace 내 promise settle을 기다린다. soft deadline 이전 호출은 선언된 no-op `{interrupted:false}`이며 UI 버튼도 숨긴다. 사용자 pause/stop 계약은 이 게이트와 별개다. 일반 pause는 진행 중 결정을 완료한 후 pause barrier에서 멈춘다. stop/end는 abort 및 settle 후 소유권을 해제한다.
4. timeout/interrupt/401/403/422/429/5xx/네트워크/응답 검증 오류는 코드만 남기고 recovery_required+closeConfirmed=true로 전환한다. 입력 구성 오류 등 HTTP를 시작하지 않은 경우도 fetch=0 증거와 함께 closeConfirmed=true로 둘 수 있다. closeConfirmed는 **로컬 HTTP promise의 종료(또는 미시작)와 후속 적용 차단**만 의미하며 원격 서버 계산/과금 중단 증명이 아니다.
5. 정상 응답도 전체 identity+gameEpoch+stateVersion, stop/abort, 현재 요청 소유권을 다시 검사한다. proposedAction 저장 전 취소됐으면 적용하지 않는다. proposedAction 저장부터 engine step은 기존 atomic transition 경계로 보호한다. 중단 API는 적용 경계 진입 후 결정을 되돌리지 않는다.
6. proposedAction을 durable 저장한 뒤 expect-version으로 engine step, 성공 시 pending 제거. 게시 실패는 기존 재게시 복구이며 재추론하지 않는다.
7. 호스트의 일반 재시도는 retryable=true·closeConfirmed·현재 엔진 차례·전체 identity 검증 후 retry_authorized로 기록하고 generation을 올려 한 번 호출한다. 일반 Resume은 재시도 권한이 아니다. JEV에는 fresh-session 요청을 서버에서도 거부한다.

실패 코드는 허용 목록으로 번역한다. SDK Error.message/body/headers는 로그·notice에 복사하지 않는다. 401/403은 서버 키 설정 안내, 429/529는 잠시 후 재시도 안내. SDK import/키 부재는 `JEV_SDK_UNAVAILABLE`/`JEV_API_KEY_MISSING`이다.

v3의 입력 오류는 retryable=false, 그 외 정상 종료된 원격 실패는 true로 저장한다. v3 validator에서 status=running이면 retryable 부재를 허용하고, 존재하면 boolean이어야 한다. recovery_required/retry_authorized/unsafe에는 boolean을 필수로 한다. running을 recovery로 전환하는 trusted 복구 경로는 항상 retryable을 명시한다. 그 외 부재/타입 오류는 검증 실패다. session-manager의 v3 투영은 CLI validateDiagnostics를 호출하지 않고 diagnosticsQuarantined=false, retryWillCorrect=false, freshSessionAvailable=false를 명시한다. allowedCommands는 입력 실패에서 End만(재시작은 End 완료 후 로비에서), closure 미확인에서는 플레이 제어 명령 없음, 검증된 일시 오류에서는 retry/end다. 읽기·상태 갱신과 별도 앱 서비스 종료 기능은 유지한다. 일반 pause 중에는 기존 resume/end 허용을 유지한다.

### 6.2 프로세스 크래시

기존 loop 소유자 종료/락 인수가 검증된 뒤, engine 결과를 먼저 확인한다.

| 저장된 상황 | 재개 처리 |
|---|---|
| proposedAction과 정확히 일치하는 엔진 action 존재 | pending 제거, API/step 재실행 없음 |
| running, proposedAction 없음 | HTTP가 엔진을 변경할 권한이 없으므로 recovery_required/INTERRUPTED로 전환; 자동 호출 없이 사용자 재시도 대기 |
| proposedAction 있음, 적용 증거 없음/불일치 | 엔진 CLI 자식이 뒤늦게 적용할 수 있으므로 unsafe, 재시도 금지; 기존 진단/안전 종료 경로 |
| unsafe, JEV_REQUEST_CLOSE_UNCONFIRMED, proposedAction 없음 | 이전 소유 프로세스 사망 검증 후 HTTP 미적용임을 확인하고 recovery_required; 자동 호출 없음 |
| recovery_required | 유지 |
| retry_authorized | 권한 소멸, recovery_required로 복귀 |
| 스키마/identity 손상 | 원문 보존, BAD_PLAYER_RECOVERY, 호출 금지 |

CLI LLM pending v1/v2의 `CHILD_CLOSE_UNCONFIRMED` 규칙은 유지한다. HTTP에는 같은 child 세션이 없으므로 구분하되, engine CLI의 불확실한 실행까지 HTTP 취소로 해결했다고 주장하지 않는다.

## 7. 부트스트랩·키·UI·운영

- package.json에 SDK 0.6.0 정확 버전 및 package-lock을 추가한다. 실제 사용 API는 설치 버전 계약으로 테스트한다. 정적 SDK import로 policy/llm 시작을 막지 않는다. Node >=20의 지원 CI와 일치시킨다.
- 새 JEV game은 파괴적 init/기존 선택 변경 전에 SDK import와 서버 환경 키 존재를 검사한다. launcher 공통 경계에서 앱/legacy를 함께 처리한다. 인증 유효성은 첫 추론 요청에서 확인하며 models.list 추가 호출을 강제하지 않는다. AI 0이면 생략한다.
- SDK에는 `baseURL:"https://api.typesafe.ai"`, `logLevel:"off"`, no-op logger를 명시하여 TYPESAFE_BASE_URL/TYPESAFE_LOG_LEVEL을 덮어쓴다. fetch wrapper는 redirect:error를 사용한다. 키는 서버의 `TYPESAFE_API_KEY`를 trim/비어있음 검사 후 apiKey로 명시 주입한다. upper CLI ENV_ALLOWLIST를 확대하지 않는다.
- playing resume의 키 부재는 세션 삭제나 종료가 아니라 복구 오류 표시다. 종료/abandon/finalizing/done는 JEV 인증과 독립적으로 동작해야 한다.
- JEV는 upper-only resolver를 사용하고 player warm/restore/canary는 수행하지 않는다. upper가 없으면 기존 기계 피드백. coach reclaim/authority 정리는 non-LLM 경로에도 유지한다.
- lobby select·setup summary·상태·재시도 문구는 JEV 지원. 원격 AI 대기 UI를 llm/jev 양쪽에 표시하고 “새 LLM 세션”은 llm에만 표시. 참가자는 retry/interrupt를 호출할 수 없다.
- 공개 투영 가능한 기존 metrics에는 runtime=jev, outcome=jev_accepted/jev_single_legal 또는 실패 코드, modelMs/전체 지연/censored만 추가한다. 기존 5,000건/metricsDropped 의미를 유지한다.
- 별도 `loop-state.jevDiagnostics={schemaVersion:1,entries:[],dropped:0}`에 safe model/version(question·candidate·projection·`selectionVersion`), decisionId, generation, 합성 actor alias, confidence, candidate key별 확률, usage(unknown 허용), API 라벨 `apiChoice`, 선택 기록 `selection`(`rule, unit, classMass, pruned, sampled, sizeRule, selectedKey, apiChoice`)을 저장한다. entry와 proposedAction은 같은 loop-state write의 형제 키다. 최근 5,000개 entry, overflow는 dropped 증가. 이 필드는 loop-state 내부 전용이며 summary/SSE/export/replay/app snapshot에는 명시적으로 제외한다. raw state/request/response/키/패는 저장하지 않는다. loop.log에는 코드·latency·identity만 남기고 확률은 복제하지 않는다. loop-state 유실로 재구성되면 진단도 0부터이며 전체 이력이라고 주장하지 않는다.


## 8. 수용 기준

1. UI/CLI에서 JEV 선택, AI 전원 JEV, 인간 불변, policy 기본 유지.
2. 모델 입력의 비공개 정보 차단 및 합법 금액/불완전 all-in/raise 권한 강제.
3. 오류·취소·늦은 응답·중복 재시도에서 액션/칩 중복 변경 0.
4. 재개·재시작·loop-state 유실에서 런타임은 고정되고, 알려진 v1 버전은 재개·재구성 시 v2로 roll-forward(마커 기록)하며 모르는 버전은 거부한다. 불확실한 engine 적용은 unsafe. 단일 후보도 같은 engine commit/복구 계약을 준수한다.
5. 키/SDK 없어도 기존 모드, 종료 및 완료 화면 사용 가능.
6. JEV 미사용 시 네트워크 호출 0; key/원문/확률의 host summary·참가자 API·SSE·export·replay·notice 유출 0.
7. LLM v1/v2 복구와 policy/멀티플레이어/코치 기존 테스트 통과.
8. 실제 SDK 소규모 smoke로 연결/응답 shape/취소를 확인한다. 테스트 승리는 포커 우위·GTO·학습 효과를 증명하지 않는다.

## 9. 구현 시 검증으로 남기는 항목

SDK 0.6.0의 실제 ESM import, Choice serialization/응답 parsing, fetch 주입, off 로그 레벨, abort→APIUserAbortError는 2026-09-22 fake-fetch 오프라인 probe에서 확인했다(네트워크 0, 합성 키). 이는 실제 네트워크 handle 종료를 증명하지 않는다. P3 직후 P4 진입 전에 합성 입력 최대 2개로 실제 API 계약 spike를 실시한다. model ID/확률 필수필드·정규화 오차/usage와 abort settlement를 확인하며 실패 시 P4를 진행하지 않고 설계를 재판정한다. 이 2개는 P6의 총 10개 API 요청 예산에 포함한다. 실제 지연/토큰 사용, 액션 선호/페르소나 차별화는 후속 구현 검증에서 측정한다. 라이브 API는 합성 상태로만 소규모 실행하며 사용자의 진행 중 게임을 재개하거나 변경하지 않는다. 전략 품질이 낮으면 공개적으로 한계를 기록하고, 정책을 조용히 섞지 않는다.

## 구현 중 실제 API 계약 보정 (2026-09-22)

실제 브라우저 플레이에서 정상 HTTP 200/model pin/choice 최대값 응답이 probabilities 합 0.99를 반환했다. 값은 0.57,0.10,0,0.04,0.07,0.21로 모두 0.01 단위였다. [공식 Choice 문서](https://docs.typesafe.ai/primitives/choice)는 합 1을 설명하지만, 관측 응답은 항목별 반올림과 일치한다. 사용자의 구현 판단 위임에 따라 저자가 수용한 변경: 모든 값이 hundredth에 1e-8 이내로 놓일 때만 n×0.005+1e-6 합 오차를 허용한다. 그 외 정밀도는 기존 1e-6, 필수 키/범위/최대 choice/model/usage 검증은 유지한다. 응답 합은 원본대로 private diagnostics에 기록하고, 선택은 v2 규칙(§결정 규칙 v2)을 따른다. 이 보정은 구현 독립 리뷰 대상으로 포함한다.

사용자가 실제 테스트 플레이와 PR/merge를 추가 승인했다. 기존 합성 smoke 10회 한도와 별도로 실제 브라우저 게임은 실행당 40회 하드 한도, 2핸드로 제한한다. 처음 두 시도는 응답 합 검증 실패로 각각 7회/4회에서 중단했다. 기존 사용자 store는 사용하지 않는다.

진단 크기 보정: 앱 private JSON reader의 기존 2 MiB 상한을 유지하기 위해 JEV diagnostics는 최대 5,000건 외에 256 KiB 및 전체 loop 파일의 64 KiB 여유를 적용한다. 매 loop-state 저장에서 오래된 entry부터 제거하고 dropped를 누적한다. 독립 리뷰와 테스트에서 이 경계를 확인한다.

최종 복구 세부화: HTTP 종료 미확인은 모든 플레이 제어를 계속 막는다. 이미 HTTP가 끝나 제안이 저장된 ENGINE_APPLY_UNCONFIRMED는 명시 End만 허용하며 추론 재시도/새 게임은 막는다. End는 기존 엔진 트랜잭션과 전체 stop cleanup을 통과한다. 부가 진단이 손상되면 진단만 격리하고 historyIncomplete=true를 남기며 pending/engine authority는 그대로 검증한다. 종료 요청이 있던 late settlement observer는 먼저 기존 stopPromise가 실패·해제될 때까지 기다린 뒤 closure-only 오류일 때만 전체 cleanup을 재실행한다.

## 결정 규칙 v2 (2026-09-22)

v1 게임 3개(230결정)의 기록에서 런타임·후보·검증·적용 경로의 결함은 없었지만, 응답에서 행동을 고르는 규칙과 성향 문구가 문제였다. API `choice`는 후보별 확률의 argmax 라벨이다. 레이즈는 사이즈 3~4개로 확률이 쪼개지고 fold/call/all-in은 슬롯이 하나라 레이즈 클래스가 과소 선택되거나 all-in 슬롯이 이겼고(결정의 약 10%), 항상 argmax라 혼합 전략이 없었다. 성향 문구가 핸드 강도를 압도해 깊은 스택 올인 연쇄와 조기 탈락이 반복됐다. v2는 API 응답 계약 검증(`validateJevAnswer`)을 바꾸지 않고 "검증된 확률에서 무엇을 실행하느냐"와 입력·후보·문구를 바꾼다.

- **선택 규칙 `class-sample-v1`**(`selectJevAction`): 후보 확률을 행동 클래스(fold/check/call/raise)별로 합산하고, 질량 0.05 미만 클래스를 뺀 나머지를 합 1로 맞춘 뒤 고정 순서 `[fold, check, call, raise]`로 추첨한다. 레이즈가 뽑히면 레이즈 후보를 금액 오름차순으로 놓고 누적 확률이 레이즈 질량의 절반에 처음 닿는 사이즈(확률 가중 중앙값)를 고른다. 추첨값은 응답 전에 `(gameEpoch, decisionId, generation)`에서 sha256으로 파생하므로 원격 응답이 추첨을 조종할 수 없고 기록만으로 재계산할 수 있다. 재시도(세대 +1)는 새 추첨이다. 선택 결과 하나가 pending `proposedAction`과 엔진 `step` 양쪽에 쓰인다. 후보가 하나면 HTTP도 선택도 없다.
- **후보 메뉴 `legal-menu-v2`**(§4.2): 표준 사이즈 프리플랍 min/2.5×/3×/4×, 포스트플랍 min/⅓/⅔/pot. all-in은 min>max·유효 잔여 스택 20BB 이하·팟 사이즈 레이즈의 1.5배 이내일 때만 후보다.
- **투영 `projectionVersion 2`**(§4.1): bb 환산 스택, 유효 잔여 스택, 회수 가능 팟 기준 `potOdds`. 전부 기존 허용 필드에서 파생한 숫자이며 새 원천 정보는 없다. 24 KiB 상한과 금지 필드는 그대로다.
- **지시문 `poker-choice-v2`와 성향 문구**: 성향은 팟 참여·블러프·콜·레이즈 빈도만 바꾸고 핸드 서열은 바꾸지 않으며, 유효 잔여 스택 40BB 초과에서 가망 없는 핸드로 스택을 걸지 않고, 숏스택이나 매우 강한 핸드가 아니면 all-in보다 표준 사이즈를 선호하라고 지시한다. 6개 성향 문구는 허용 목록의 영어 상수다.
- **진단**: entry에 `apiChoice`, `selection`, `selectionVersion`을 더한다(`jevDiagnostics.schemaVersion`은 1 유지). entry와 제안은 같은 write라 제안 없는 entry나 entry 없는 제안이 생기지 않는다. `selection`이 있는 entry의 각 decisionId에서 최고 generation entry의 `selectedKey`가 아카이브에 적용된 액션이다. 확률·추첨값·선택 기록은 loop-state 밖(앱 스냅샷·SSE·요약·export·replay·notice·log)으로 나가지 않는다.
- **descriptor roll-forward**: 현재 descriptor는 §5의 v2다. 알려진 v1 descriptor(§5의 목록)로 진행 중인 store는 재개할 때 loop-state 사본만 v2로 한 번 갱신하고 `jevRolledForward {from, at}` 마커, notice 한 줄, `jev-config-rolled-forward` log를 남긴다. 판정 기준은 loop 사본이므로 두 번째 재개부터는 아무것도 기록하지 않는다. 엔진 `state.config.jev`와 핸드 아카이브·기존 진단 entry·pending은 바꾸지 않는다. 한 게임 안의 v1·v2 결정은 entry의 버전 필드로 구별한다. `loop-state.notices`는 현재 로비·참가자 화면에 표시되지 않는다(기록만). 모르는 descriptor는 v1과 같이 `JEV_CONFIG_UNSUPPORTED`다.
- **downgrade·완료 store 경계**: v2 코드가 만든 store와 roll-forward한 진행 중 store는 v1 코드가 재개를 거부한다(End는 가능, v1에서 태어난 store의 같은 설정 재시작도 가능). abort로 끝난 store는 descriptor 검사 전에 종료 처리되어 어느 코드로도 열린다. 정상 완료된 store는 앱의 완료 화면·기록 보기가 되지만 v1 코드의 루프 재개는 거부된다. v1에서 태어나 loop-state를 잃은 store는 엔진 descriptor(v1)로 재구성되므로 v1 코드에서도 이어 갈 수 있다(결정 규칙만 다르고 저장 형식은 같아 손상은 없다). 되돌릴 때는 진행 중 JEV 게임을 v2 코드에서 End한 뒤 revert한다. 특히 v2에서 태어나 loop-state를 잃은 store는 v1 코드로 End할 수 없으므로 revert 전에 End한다.
- 이 규칙과 상수(0.05·20BB·1.5×·가중 중앙값)는 휴리스틱이다. 값을 바꾸면 descriptor 버전을 올린다. 결과는 포커 실력·수익·GTO의 증명이 아니다.
