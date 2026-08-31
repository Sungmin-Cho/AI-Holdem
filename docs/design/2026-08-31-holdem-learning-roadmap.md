# AI Hold'em GTO·Exploit 학습 시스템 로드맵

- 작성일: 2026-08-31
- 분석 기준 커밋: `443dd9cabc5f46e91af29b0d1002a926ad54298b`
- 대상 저장소: `Sungmin-Cho/AI-Holdem`
- 상위 추적 이슈: [#36](https://github.com/Sungmin-Cho/AI-Holdem/issues/36)
- 문서 성격: 코드 변경 전 아키텍처 분석 및 구현 계획

## 1. 결론

현재 AI-Holdem은 이미 다음 기반을 잘 갖추고 있다.

- 규칙과 상태 전이를 담당하는 순수 `engine/`
- 게임 전체 생명주기를 담당하는 detached `tools/game-loop.js`
- LLM CLI 실행을 한곳에 격리한 `tools/player-runtime.js`
- 네트워크와 액션 전달만 담당하는 `server/`
- 핸드별 코칭과 결과 독립적 evaluator를 거치는 종합 리뷰
- crash/resume, publish retry, authority seal, process identity를 다루는 강한 운영 계약

따라서 새로 필요한 것은 또 하나의 “AI 코치 prompt”가 아니다. 실력 향상을 위해 가장 중요한 누락은 **정답 근거를 생성하는 기계적 학습 계층**이다.

현재 흐름은 다음과 같다.

```text
hand archive + basic stats
        ↓
       LLM
        ↓
자연어 코치 / 종합 리뷰
```

목표 흐름은 다음과 같아야 한다.

```text
hand/action archive
        ↓
DecisionContextV1
        ↓
StrategyProvider
        ↓
DecisionEvaluationV1
        ├─→ 구조화 피드백
        ├─→ LLM 설명
        ├─→ SkillProfile / Leak Detector
        └─→ Mistake Bank / Drill Scheduler
```

핵심 원칙은 단순하다.

> **LLM은 전략 정답을 만드는 계층이 아니라, 검증된 정답을 이해하고 기억할 수 있게 설명하는 계층이어야 한다.**

첫 실용 목표는 `6-max / 100BB / fixed blind / preflop`으로 제한한 뒤, 결정 단위의 평가와 반복 훈련을 완성하는 것이다. Postflop solver와 exploit nodelock은 그 계약 위에 나중에 연결한다.

---

## 2. 분석 범위

다음 실행 경로와 계약을 확인했다.

- `engine/hand.js`
- `engine/views.js`
- `engine/cli.js`
- `engine/state.js`
- `engine/game-archive.js`
- `engine/personas.js`
- `tools/player-prompt.md`
- `tools/player-runtime.js`
- `tools/game-loop.js`
- `tools/coach-control.js`
- `tools/publish.js`
- `publish-contract.js`
- `server/server.js`
- `server/public/index.html`
- `server/public/app.js`
- `server/public/style.css`
- `test/` 전체 구성
- `README.md`, `ARCHITECTURE.md`, start-game skill

분석 기준은 다음 질문이다.

1. 사용자가 결정을 내릴 당시의 공개 정보를 완전히 재현할 수 있는가?
2. 그 결정을 특정 strategy profile의 spot으로 정규화할 수 있는가?
3. 각 선택의 빈도와 EV를 출처·버전과 함께 제시할 수 있는가?
4. 게임 결과와 의사결정 품질을 분리할 수 있는가?
5. 누적 leak을 찾아 다음 훈련으로 연결할 수 있는가?
6. 기존 보안·재개·게시 불변식을 깨지 않고 추가할 수 있는가?

---

## 3. 현재 아키텍처에서 보존해야 할 것

### 3.1 `engine/`의 순수성

`engine/`은 덱, 핸드 평가, 베팅, 사이드팟, 상태 전이와 archive를 담당한다. 외부 solver, 네트워크, LLM을 이 계층에 넣으면 안 된다.

학습 기능을 추가하더라도 engine이 해야 할 일은 다음으로 제한한다.

- 결정 직전 상태를 완전하고 deterministic하게 기록
- 실제 선택을 archive에 연결
- 학습 모드의 게임 규칙을 상태 config로 표현

Strategy lookup, EV 계산, profile aggregation은 engine 밖에서 수행한다.

### 3.2 `tools/player-runtime.js`의 단일 책임

이 파일은 Claude/Codex/Grok CLI를 격리된 cwd와 제한된 env에서 실행하는 유일한 LLM adapter다. Solver나 deterministic opponent policy를 여기에 추가하지 않는다.

- LLM: `tools/player-runtime.js`
- deterministic opponent: 새 `tools/opponent-controller.js`
- strategy/solver process: 새 `tools/strategy-runtime.js`

세 종류의 process lifecycle과 trust boundary를 분리한다.

### 3.3 server의 relay-only 경계

`server/server.js`는 게임 규칙이나 solver를 몰라야 한다. 새 기능에서도 server는 다음만 담당한다.

- 인증
- schema/size 검증
- snapshot persistence
- idempotent publish
- SSE replay
- 사용자 입력 전달

### 3.4 결과와 과정의 분리

현재 final review는 evaluator가 결과와 실제 archetype을 모르는 상태에서 과정부터 평가하고, synthesizer가 뒤에서 결과와 실제 상대 정보를 결합한다. 이 설계는 유지할 가치가 높다.

향후 evaluator가 읽어야 할 정본은 LLM의 주관적 추론보다 `DecisionEvaluationV1`이다.

---

## 4. 파일별 정밀 분석

## 4.1 `engine/hand.js`

### 현재 제공하는 것

`applyAction()`의 action record에는 다음 정보가 있다.

- `decisionId`
- `playerId`
- `action`, `amount`
- `street`
- `potTotal`
- `callAmount`
- `minRaiseTo`, `maxRaiseTo`
- `board`
- 모든 seat의 `stacks`

완료된 hand archive에는 다음이 있다.

- hand/level/blinds/button
- holes/board/folded/allIn
- actions/pots/showdown
- startStacks/endStacks

이 데이터는 게임을 설명하고 베팅 결과를 검증하기에는 충분하다.

### GTO 평가에 부족한 것

결정 단위로 다음 정보가 고정돼 있지 않다.

- 포지션
- table size
- 게임 mode와 strategy profile
- effective stack과 BB 환산값
- 액션 직전 street bet/contribution
- active/folded/all-in 집합
- canonical action sequence
- opener, caller, 3-bettor 등 역할
- 합법 액션의 정확한 descriptor
- acting player의 hole cards와 결정 record의 명시적 연결
- context digest와 schema version

현재 `decisionId`는 hand/street/actionIndex로 결정되므로 게임 내부 idempotency에는 유용하다. 다만 provider 재평가 identity는 `decisionId`만으로 부족하고 `context digest + provider version`이 필요하다.

### 권장 변경

- 기존 `actions`를 깨지 않는다.
- 사용자 액션마다 `DecisionContextV1`을 생성한다.
- 완료 archive에 `decisions`를 추가한다.
- 기존 archive에서 `decisions`가 없는 경우를 허용한다.
- positions 계산을 UI 문면 생성에서 분리해 순수 공용 함수로 만든다.

## 4.2 `engine/views.js`

### 현재 제공하는 것

- seat와 공개 view
- 동적 포지션 라벨
- AI가 읽는 self-contained turn summary
- redacted hand record
- 기본 stats report

`turnSummary()`는 실제로 학습 context에 필요한 정보를 상당 부분 이미 문자열로 구성한다. 하지만 text parser를 학습 정본으로 삼으면 문면 변경이 data contract 변경이 된다.

### 권장 변경

- `turnSummary()`를 parse하지 않는다.
- summary 생성에 쓰는 구조화된 공개 context를 먼저 만들고, text summary와 DecisionContext가 이를 공유한다.
- `statsReport()`의 테이블 성향 통계와 학습 통계를 분리한다.
- 기존 VPIP/PFR/AF는 유지하되 EV-loss/accuracy는 learning store에서 제공한다.

## 4.3 `engine/cli.js`

현재 init 설정은 `--ai`, `--stack`, `--blinds`, `--level-every` 중심이다. 명시적인 mode/profile이 없다.

권장 CLI 확장:

```bash
node engine/cli.js init --ai 5 --mode training
node engine/cli.js hand 12 --decisions
```

다만 Strategy Provider command는 engine CLI에 넣지 않는다. 별도 `tools/training-cli.js`를 사용한다.

## 4.4 `engine/game-archive.js`

새 게임 init은 `game/`의 live entry를 archive로 이동한다. 따라서 장기 사용자 프로필을 `game/` 안에 두면 매 게임마다 현재 세션과 함께 archive된다.

권장 기본 위치:

```text
learning/
  profile.json
  sessions/
  evaluations/
  mistakes/
```

- repo root `learning/`을 `.gitignore` 처리
- `--learning-dir`로 외부 경로 지정 가능
- 기존 game archive와 별도 수명

## 4.5 `engine/state.js`

원자적 JSON write, hand archive, named/owned lock primitives가 이미 존재한다. 새 learning store도 별도 lock 구현을 만들지 말고 이 primitive를 재사용한다.

필수 조건:

- 동일 evaluation의 중복 ingest 방지
- context/evaluation digest 검증
- profile update 중 crash가 나도 이전 파일 보존
- provider version별 집계 분리

## 4.6 `engine/personas.js`와 `tools/player-prompt.md`

현재 archetype은 `bluffFreq`, `threeBetFreq`, `tiltProne`을 갖고 LLM prompt로 전달된다. 이 값은 행동 계약이 아니라 모델에 대한 지시다.

예를 들어 `threeBetFreq=0.30`은 다음을 보장하지 않는다.

- 3-bet opportunity의 정확한 정의
- 30%에 가까운 장기 발생률
- 같은 model/version에서의 재현성
- 다른 street에서의 상호 일관성

권장 분리:

```text
Persona
- name
- speech
- personality

Policy
- id/version
- opportunity-conditioned action distribution
- seedable action sampling
- private deviation metadata
```

LLM 상대는 Play Mode에서 유지하고, Training/Exploit Mode는 deterministic policy를 선택할 수 있게 한다.

## 4.7 `tools/game-loop.js`

이 파일은 이미 게임의 전체 생명주기와 복구를 소유하는 큰 orchestrator다.

### 현재 학습 관련 흐름

- hand 종료 후 redacted hand와 stats capture
- LLM coach spawn
- plain text note publish
- 종료 시 evaluator + synthesizer review
- 다음 game에 자연어 practice focus 전달

### 현재 공백

- 사용자 decision metric이 없음
- user action 적용 전/후 evaluation hook이 없음
- Strategy Provider 실행 경계가 없음
- evaluation artifact와 digest가 없음
- 구조화 feedback publish가 없음
- long-term learning store ingest가 없음

### 권장 삽입 지점

사용자 action이 성공적으로 engine step에 적용된 뒤, 같은 `decisionId`에 대해 비동기 평가를 시작한다.

```text
handleUserTurn
  → engine step 성공
  → publish next view
  → evaluate decision asynchronously
  → durable evaluation
  → structured feedback + coach
```

게임 진행을 provider latency가 막지 않도록 평가와 코치는 다음 hand 진행과 분리한다. 다만 shutdown/finalization은 기존 coach task처럼 소유한 task를 정리하거나 durable pending state로 넘겨야 한다.

새로운 domain 로직을 계속 `game-loop.js` 안에 작성하지 않는다.

- `training/`: 순수 정규화·평가·집계
- `tools/training-cli.js`: 파일 I/O command boundary
- `tools/drill-loop.js`: drill lifecycle
- `tools/opponent-controller.js`: opponent selection
- `tools/strategy-runtime.js`: optional solver process

## 4.8 `tools/coach-control.js`

현재 note 계약은 hand 단위의 다음 필드로 좁다.

```json
{
  "handNo": 12,
  "text": "...",
  "overfold": true,
  "unavailable": true
}
```

이 계약은 authority, generation, proof, publish queue와 강하게 연결돼 있다. 첫 단계에서 evaluation의 모든 구조화 데이터를 이 note schema에 밀어 넣지 않는다.

권장 방식:

- evaluation은 별도 durable artifact
- coach note는 evaluation을 설명하는 text
- structured feedback은 별도 publish field
- note proof와 feedback proof가 필요하다면 계약을 명시적으로 분리

## 4.9 `tools/publish.js`와 `publish-contract.js`

현재 publisher allowlist는 `view`, public events, messages, coach, review다. 새 field는 자동으로 전달되지 않으므로 명시적 계약 변경이 필요하다.

권장 새 field:

```json
{
  "decisionFeedback": []
}
```

주의점:

- `MAX_PUBLISH_BODY_BYTES` 유지
- retry exact-body semantics 유지
- 같은 decision의 중복 publish 방지
- provider revision을 key에 포함할지 결정
- 큰 range matrix는 일반 publish body에서 분리

## 4.10 `server/server.js`

현재 snapshot state는 view/log/coach/review 중심이다. 새 feedback을 plain log에 넣지 말고 first-class state로 둔다.

```text
state.decisionFeedback
  key: decisionId 또는 decisionId+providerRevision
  merge: validated upsert
  public snapshot: sorted array
```

server는 EV를 계산하거나 grade를 만들지 않는다. schema와 size만 검증한다.

## 4.11 `server/public/`

현재 side panel은 이벤트 로그와 코치 두 탭이고, coach card는 hand 번호와 text를 보여 준다.

권장 단계:

### Phase 1 UI

- grade badge
- chosen vs recommended action
- EV Loss
- 액션별 frequency bar
- provider/version
- unsupported reason
- explanation

### Phase 2 UI

- 훈련 탭
- session summary
- active leaks
- due review count
- drill flow

### Phase 4 UI

- 13×13 range matrix
- action frequency overlay
- current hand highlight
- tree/profile metadata

정답은 decision 제출 전에 표시하지 않는다.

## 4.12 테스트 구조

현재 테스트는 engine 단위부터 process-heavy integration까지 강하다. 특히 `test/game-loop.test.js`가 매우 크므로 새 순수 학습 로직은 별도 focused test로 분리한다.

권장 신규 테스트:

```text
test/decision-context.test.js
test/training-mode.test.js
test/spot-normalizer.test.js
test/preflop-provider.test.js
test/decision-evaluator.test.js
test/training-cli.test.js
test/grounded-coach.test.js
test/decision-feedback-ui-contract.test.js
test/learning-store.test.js
test/leak-detector.test.js
test/mistake-bank.test.js
test/drill-scheduler.test.js
test/policy-player.test.js
test/exploit-evaluator.test.js
test/hand-history-*.test.js
test/strategy-runtime.test.js
```

외부 npm 의존성 없이 `node --test`와 serial CI 계약을 유지한다.

---

## 5. 핵심 문제 정의

## 5.1 객관적 정답지가 없다

현재 LLM 코치는 합리적인 설명을 만들 수 있지만 action frequency와 EV의 정본이 아니다. 정량 수치를 LLM이 생성하게 두면 그럴듯하지만 검증 불가능한 코치가 된다.

해결:

- versioned Strategy Provider
- supported/unsupported를 명확히 구분
- provider 결과 밖의 숫자 생성 금지

## 5.2 학습 환경이 통제되지 않는다

기본 게임은 블라인드가 상승하고 stack이 hand 결과에 따라 바뀐다. 동일 preflop profile을 반복 평가하기 어렵다.

Training Mode v1 권장 규칙:

- 6-max
- 100BB
- fixed blinds
- ante 0
- 각 hand 시작 전 seat를 100BB로 reset 또는 auto top-up
- 정해진 hand count 또는 사용자가 종료할 때까지 반복

“100BB에서 시작한 뒤 stack이 계속 변하는 cash session”이 아니라, 첫 학습 버전은 **독립적인 100BB decision samples**를 만드는 것이 목적이다.

## 5.3 결정 기록이 strategy spot contract가 아니다

text summary가 풍부하더라도 parser에 의존하면 안 된다. 구조화 context가 먼저이고 summary는 projection이어야 한다.

## 5.4 사용자 decision metric이 없다

현재 latency metric은 AI decision 중심이다. 학습 시스템에는 다음 user metric이 필요하다.

- supported decision count
- grade distribution
- EV loss
- concept/position별 sample
- stale/illegal submission count
- decision time, 선택 변경 횟수는 optional

## 5.5 자연어 practice focus만 존재한다

자연어는 설명에는 좋지만 누적 집계와 scheduling key로 부적절하다.

해결:

```json
{
  "leakId": "BB_DEFENSE_VS_BTN",
  "sample": 38,
  "confidence": 0.81,
  "evLossBb": 4.9,
  "priority": 0.87
}
```

LLM은 이 id와 근거를 자연어로 설명한다.

## 5.6 Persona 빈도를 exploit ground truth로 쓸 수 없다

prompt의 bluff frequency는 실행 분포가 아니다. Exploit 훈련에는 반복 가능한 Policy가 필요하다.

## 5.7 UI 계약이 text 중심이다

정량 결과를 text에만 넣으면 sorting, graph, drill, revision 비교가 불가능하다. structure와 explanation을 분리한다.

---

## 6. 목표 모듈 구조

```text
training/
  contracts.js
  decision-context.js
  spot-normalizer.js
  strategy-provider.js
  preflop-provider.js
  decision-evaluator.js
  evaluation-store.js
  evaluation-summary.js
  learning-store.js
  skill-profile.js
  leak-detector.js
  drill-item.js
  mistake-bank.js
  drill-scheduler.js
  mastery.js
  exploit-contract.js
  exploit-evaluator.js
  opponent-read.js
  postflop-spot.js
  range-contract.js

opponents/
  policy-contract.js
  policy-player.js
  profiles/

tools/
  training-cli.js
  drill-loop.js
  opponent-controller.js
  strategy-runtime.js

hand-history/
  contracts.js
  canonical-formatter.js
  pokerstars-formatter.js

data/
  preflop/
    manifest.json
```

이 구조의 의도는 다음과 같다.

- `training/`: side effect 없는 도메인 로직
- `tools/`: process/file/network boundary
- `opponents/`: 실제 상대 행동 정책
- `hand-history/`: export formatter
- `engine/`: 게임 규칙과 결정 archive

---

## 7. 데이터 계약

## 7.1 GameConfig 확장

```json
{
  "schemaVersion": 2,
  "mode": "play|training|exploit",
  "aiCount": 5,
  "tableSize": 6,
  "startStack": 10000,
  "startingStackBb": 100,
  "blinds0": [50, 100],
  "blindSchedule": "progressive|fixed",
  "stackPolicy": "carry|reset-each-hand|auto-top-up",
  "levelEvery": 8,
  "ante": 0,
  "strategyProfile": "cash-6max-100bb-v1"
}
```

기존 schemaVersion 1 state의 resume 정책을 명확히 정의한다.

## 7.2 DecisionContextV1

필수 속성:

- immutable identity
- actor가 당시 볼 수 있었던 정보
- canonical position/action sequence
- exact legal actions
- chosen action
- pre/post state version
- mode/profile

비공개 opponent cards나 future board card는 포함하지 않는다.

## 7.3 StrategyProvider result

모든 결과는 다음 중 하나다.

- `supported`
- `unsupported`
- `failed`

`supported` 결과에는 반드시 다음이 있다.

- provider id/version
- strategy profile
- source/license manifest reference
- normalized spot key
- action frequencies
- EV가 제공되는 경우 unit이 BB임을 명시
- tree/sizing assumptions

## 7.4 DecisionEvaluationV1

```json
{
  "schemaVersion": 1,
  "decisionId": "...",
  "contextSha256": "...",
  "status": "supported",
  "provider": {},
  "spotKey": "...",
  "recommendedActions": [],
  "chosenAction": {},
  "bestEvBb": 0.0,
  "chosenEvBb": 0.0,
  "evLossBb": 0.0,
  "grade": "correct|inaccuracy|mistake|blunder",
  "conceptTags": [],
  "evaluatedAt": "..."
}
```

Grade threshold는 code/config에 versioned 상수로 두며 prompt 문면으로 정의하지 않는다.

## 7.5 SkillProfileV1

Provider/profile/version별로 분리 집계한다. 다음을 섞지 않는다.

- 다른 stack depth
- 다른 rake/profile
- 다른 provider version
- exact와 approximation
- GTO와 exploit evaluation

## 7.6 OpponentPolicyV1

Policy는 opportunity-conditioned distribution을 반환한다. 장기 빈도 검증도 opportunity를 분모로 한다.

예:

- `threeBetOpportunities`
- `threeBets`
- `foldToRiverBetOpportunities`
- `foldToRiverBets`

단순 전체 action 대비 비율을 사용하지 않는다.

---

## 8. Persistence와 idempotency

## 8.1 Evaluation identity

권장 key:

```text
sha256(context canonical JSON)
+ provider id/version/profile
+ evaluation contract version
```

`decisionId`는 사람이 읽고 hand에 연결하기 위한 key이고, evaluation content identity는 digest가 담당한다.

## 8.2 재개

- engine step이 적용됐으나 evaluation 전에 crash 가능
- hand archive의 unevaluated decision을 resume 시 재검색
- 기존 digest가 같은 evaluation은 재사용
- provider version이 바뀌면 새 revision 생성
- 기존 evaluation을 덮어쓰지 않음

## 8.3 게시

- structured feedback은 exact-body retry 지원
- server는 decision key로 idempotent merge
- publish response만 믿지 않고 snapshot reconcile 가능
- 큰 range artifact는 일반 publish queue와 분리

## 8.4 Learning store

- 별도 named lock
- atomic write
- ingest ledger로 중복 방지
- profile은 파생 데이터, 원본 evaluation은 보존
- profile 손상 시 evaluation ledger에서 rebuild 가능

---

## 9. 보안과 정보 공개

현재 프로젝트는 LLM 자식이 repo/game 파일을 읽지 못하도록 강한 containment를 둔다. 학습 계층도 이 철학을 유지한다.

### 공개 가능

- 사용자 hole cards
- 당시 공개 board/action
- 공개된 showdown cards
- 사용자 결정 평가
- provider profile/version

### 게임 중 비공개

- 상대의 mucked/non-showdown cards
- opponent policy id와 private parameters
- RNG roll
- future deck
- 전체 private engine state

### 종료 후 공개 가능

- 실제 opponent policy/archetype
- 사용자 read와의 비교
- 단, 비공개 hole cards는 기존 showdown 공개 규칙을 따른다.

Hand History exporter도 내부 archive에 존재한다는 이유만으로 상대 hole cards를 출력하면 안 된다.

---

## 10. Strategy data와 라이선스

프리플롭 chart나 solver output은 코드와 다른 라이선스를 가질 수 있다. 다음 manifest 없이는 데이터 파일을 main에 넣지 않는다.

```json
{
  "datasetId": "...",
  "version": "...",
  "source": "...",
  "license": "...",
  "redistributionAllowed": true,
  "profile": {
    "game": "NLHE",
    "players": 6,
    "stackBb": 100,
    "rake": "...",
    "openSizes": "..."
  },
  "contentSha256": "..."
}
```

불확실한 데이터는 다음 중 하나로 처리한다.

- 사용자가 로컬에서 가져오는 optional provider
- repository에 데이터 없이 adapter만 제공
- 재배포 가능한 자체 생성 데이터만 commit

LLM이 빈 표를 보완하거나 EV를 추정하는 fallback은 금지한다.

---

## 11. 단계별 구현 로드맵과 등록 이슈

## Epic

- [#36 — AI 홀덤을 GTO·Exploit 기반 개인 학습 시스템으로 확장](https://github.com/Sungmin-Cho/AI-Holdem/issues/36)

## Phase 0 — 측정 기반

- [#39 — 고정 6-max 100BB Training Mode와 게임 설정 계약 추가](https://github.com/Sungmin-Cho/AI-Holdem/issues/39)
- [#41 — DecisionContextV1 결정 원장과 사용자 액션 계측 추가](https://github.com/Sungmin-Cho/AI-Holdem/issues/41)

Phase 0 완료 기준:

- 같은 profile의 결정 표본을 반복 생성할 수 있다.
- 모든 사용자 선택을 정확한 당시 context와 연결할 수 있다.
- Strategy Provider가 없어도 기록 손실 없이 게임이 동작한다.

## Phase 1 — 프리플롭 GTO 코치

- [#43 — StrategyProvider 계약과 라이선스가 명확한 프리플롭 평가기 구현](https://github.com/Sungmin-Cho/AI-Holdem/issues/43)
- [#46 — DecisionEvaluationV1 기반 GTO-grounded 코치와 종합 리뷰 통합](https://github.com/Sungmin-Cho/AI-Holdem/issues/46)
- [#47 — 구조화된 결정 피드백의 publish/server/UI 계약 추가](https://github.com/Sungmin-Cho/AI-Holdem/issues/47)

Phase 1 완료 기준:

- 지원되는 preflop 결정마다 action frequency와 EV loss를 보여 준다.
- LLM은 provider에 없는 수치를 생성하지 않는다.
- unsupported spot은 명확하게 구분된다.
- 게임 결과와 과정 점수가 분리된다.

## Phase 2 — 적응형 학습

- [#49 — 학습 통계·SkillProfileV1·Leak Detector를 게임 수명과 분리해 영속화](https://github.com/Sungmin-Cho/AI-Holdem/issues/49)
- [#50 — Spot Drill·Mistake Bank·Spaced Repetition 학습 루프 구현](https://github.com/Sungmin-Cho/AI-Holdem/issues/50)

Phase 2 완료 기준:

- 다음 게임의 연습 내용이 자연어 기억이 아니라 누적 profile 근거로 선정된다.
- 실수한 spot이 자동 복습된다.
- mastery가 낮은 concept에 학습 시간을 집중한다.

## Phase 3 — Exploit

- [#51 — AI Persona와 실행 Strategy Policy를 분리하고 빈도를 검증 가능하게 만들기](https://github.com/Sungmin-Cho/AI-Holdem/issues/51)
- [#52 — GTO 점수와 상대별 Exploit 점수를 분리하는 평가기·훈련 모드 구현](https://github.com/Sungmin-Cho/AI-Holdem/issues/52)

Phase 3 완료 기준:

- 상대 누수를 반복 가능한 방식으로 연습한다.
- GTO baseline과 상대별 최적 대응을 혼동하지 않는다.
- 플레이 중 private policy는 공개되지 않는다.

## Phase 4 — 외부 분석과 Postflop

- [#53 — 표준 Hand History exporter와 외부 분석 도구 브리지 추가](https://github.com/Sungmin-Cho/AI-Holdem/issues/53)
- [#54 — Optional Postflop Solver Adapter와 range matrix 시각화 추가](https://github.com/Sungmin-Cho/AI-Holdem/issues/54)

Phase 4 완료 기준:

- 외부 분석 도구와 결과를 교차 검증할 수 있다.
- postflop provider를 core와 분리된 optional process로 연결한다.
- exact/approximation/unsupported를 UI에서 명확히 구분한다.

---

## 12. 의존성 그래프

```text
#39 Training Mode ───────┐
                         ├─→ #43 Preflop Provider ─→ #46 Grounded Coach ─→ #47 Feedback UI
#41 Decision Context ────┘             │                       │
        │                              ├─→ #49 Skill Profile ─→ #50 Drill
        │                              │
        ├─→ #53 HH Export              └─→ #51 Opponent Policy ─→ #52 Exploit
        │
        └───────────────────────────────→ #54 Postflop Adapter
```

권장 구현 순서:

1. #41
2. #39
3. #43
4. #46
5. #47
6. #49
7. #50
8. #51
9. #52
10. #53
11. #54

#41을 첫 번째로 권장하는 이유는 모든 후속 기능이 결정 당시 상태의 정확성에 의존하기 때문이다. #39는 #41과 병렬로 진행 가능하다.

---

## 13. 파일 영향 매트릭스

| 영역 | 주요 기존 파일 | 새 파일/모듈 | 주요 목적 |
|---|---|---|---|
| Training config | `engine/hand.js`, `engine/cli.js`, `engine/game-archive.js` | — | fixed profile과 mode |
| Decision ledger | `engine/hand.js`, `engine/views.js`, `engine/state.js` | `training/contracts.js`, `training/decision-context.js` | 재평가 가능한 결정 원장 |
| Preflop evaluation | `tools/game-loop.js` | `training/spot-normalizer.js`, `training/preflop-provider.js`, `tools/training-cli.js` | 빈도·EV·grade |
| Grounded coach | `tools/game-loop.js`, `tools/coach-control.js` | `training/evaluation-store.js` | LLM 설명을 정답과 분리 |
| Feedback transport | `tools/publish.js`, `server/server.js`, `server/public/*` | — | 구조화 UI |
| Adaptive learning | `.gitignore`, start-game skill | `training/learning-store.js`, `skill-profile.js`, `leak-detector.js` | 장기 숙련도 |
| Drill | `server/public/*` | `tools/drill-loop.js`, `mistake-bank.js`, `drill-scheduler.js` | 반복 학습 |
| Opponent policy | `engine/personas.js`, `tools/player-prompt.md`, `tools/game-loop.js` | `opponents/*`, `tools/opponent-controller.js` | 재현 가능한 상대 |
| Exploit | final review, feedback UI | `training/exploit-evaluator.js` | 이중 점수 |
| HH export | hand archive | `hand-history/*`, `tools/export-hand-history.js` | 외부 분석 |
| Postflop | feedback UI | `tools/strategy-runtime.js`, `training/range-contract.js` | optional solver |

---

## 14. 테스트 전략

## 14.1 순수 계약 테스트

- context canonical JSON과 digest
- position/action sequence normalization
- legal action encoding
- provider response validation
- frequency 합계
- EV loss와 grade
- profile aggregation
- scheduler interval
- policy sampling

## 14.2 Privacy 테스트

- redacted context에 상대 hole cards 없음
- pre-decision UI에 정답 없음
- public feedback에 private policy metadata 없음
- HH export에 mucked cards 없음
- range artifact endpoint token 검증

## 14.3 Crash/resume 테스트

- engine action 후 evaluation 전 crash
- evaluation write 후 feedback publish 전 crash
- feedback ack 후 snapshot/phase write 전 crash
- learning profile update 중 crash
- solver timeout과 unconfirmed child close

## 14.4 Golden fixtures

- RFI
- blind defense
- 3-bet pot
- mixed-frequency decision
- unsupported multiway spot
- exact zero EV-loss decision
- large mistake/blunder
- side pot HH export
- GTO-good/exploit-bad와 GTO-bad/exploit-good 사례

## 14.5 CI

- 기존 `node --test`
- process-heavy test의 serial CI 유지
- optional solver test는 fake executable fixture 사용
- 실제 solver integration은 별도 smoke 절차로 분리

---

## 15. 성공 지표

기능 완료 여부만으로는 학습 효과를 알기 어렵다. 다음 제품 지표를 저장한다.

### 정확성/신뢰성

- supported decision 비율
- provider failure 비율
- evaluation 재현율
- duplicate/missing evaluation 수
- feedback publish/reconcile 실패 수

### 사용자 학습

- EV Loss/100 supported decisions
- concept별 accuracy와 EV loss
- mistake 재발률
- spaced repetition 후 정답률
- active leak의 30/100 decision 이동 평균

### 플레이 품질

- Training Mode session당 supported samples
- preflop decision coverage
- GTO Score
- Exploit Score
- opponent read confidence

### 성능

- user action 적용은 provider를 기다리지 않음
- background evaluation latency
- feedback 표시 latency
- solver cache hit rate

---

## 16. 명시적 비목표

초기 단계에서는 다음을 하지 않는다.

- 모든 postflop tree를 직접 solve
- 지원되지 않는 spot에 heuristic EV 생성
- LLM이 GTO frequency/EV 생성
- 게임 중 선택 전에 정답 공개
- 온라인 포커 클라이언트 실시간 연동
- 상대의 비공개 카드나 future deck 활용
- 라이선스가 불명확한 chart/solution DB commit
- 새로운 외부 npm dependency를 무조건 도입
- 기존 player-runtime에 solver/opponent policy 책임 혼합

---

## 17. 최종 권고

가장 먼저 구현할 세 항목은 다음이다.

1. `DecisionContextV1` 결정 원장
2. 고정 6-max 100BB Training Mode
3. versioned Preflop Strategy Provider

그다음 grounded coach와 구조화 UI를 연결한다.

이 순서를 지키면 이후 Skill Profile, Drill, Exploit, Postflop이 모두 같은 contract 위에서 확장된다. 반대로 UI나 LLM prompt부터 확장하면 나중에 정답 기준과 데이터 schema를 다시 뜯어고쳐야 한다.

현재 저장소의 가장 큰 강점은 process safety와 명확한 경계다. 새 학습 기능도 같은 방식으로 설계해야 한다.

> **engine은 사실을 기록하고, provider는 전략을 평가하고, LLM은 설명하며, learning store는 변화량을 측정한다.**
