# AI-Holdem GTO 학습 시스템 정밀 코드 분석 및 구현 로드맵

- 상태: Proposed
- 분석 기준: 2026-08-31 `main`
- 대상: `Sungmin-Cho/AI-Holdem`
- 목적: 현재의 “AI와 플레이하고 LLM 코칭을 받는 게임”을 “결정 품질을 계량하고 약점을 반복 교정하는 개인화 홀덤 학습 시스템”으로 확장한다.

---

## 1. 결론

현재 저장소는 홀덤 학습 제품의 기반으로 상당히 좋은 구조를 이미 갖고 있다.

- `engine/`이 규칙·상태 전이·사이드팟·쇼다운을 소유한다.
- `tools/game-loop.js`가 게임 수명주기와 LLM 호출을 소유한다.
- `server/`는 중계와 UI만 담당한다.
- 핸드별 redacted 기록, 결과와 분리된 evaluator, 종합 리뷰, 다음 게임의 `practiceFocus` 전달이 이미 존재한다.
- 런타임 격리, 재개, 중복 게시 방지, fail-closed 종료 절차가 강하다.

그러나 실력 향상의 핵심 루프에는 한 가지 결정적인 공백이 있다.

> 현재 코치는 “무엇이 더 좋은 선택이었는지”를 검증된 전략 데이터나 EV로 계산하지 않고, redacted 핸드와 통계를 읽은 LLM이 자연어로 평가한다.

따라서 지금 시스템은 플레이 경험과 정성적 피드백에는 강하지만, 다음 질문에는 기계적으로 답하지 못한다.

- 내 선택의 EV 손실은 몇 BB였는가?
- 낮은 빈도의 혼합 전략을 선택했지만 EV상 정답이었는가?
- 내가 BTN RFI, BB 방어, 3-bet 대응 중 어디에서 반복적으로 손해를 보는가?
- 같은 실수를 충분한 간격으로 다시 풀었는가?
- GTO 기준으로는 맞지만 특정 Calling Station을 상대로는 놓친 exploit이었는가?

가장 먼저 구현해야 할 것은 완전한 postflop solver가 아니다. 다음 세 가지다.

1. **구조화된 `DecisionContext` 계약**
2. **고정 블라인드 6-max 훈련 환경과 preflop strategy lookup**
3. **EV-loss 기반 grading → leak 집계 → drill 재출제 루프**

이 기반을 먼저 만들면 현재 코치·리뷰·UI는 폐기하지 않고 더 신뢰할 수 있는 설명 계층으로 재사용할 수 있다.

---

## 2. 현재 코드의 학습 흐름

```text
engine/hand.js
  규칙과 액션 적용
        │
        ▼
engine/views.js
  turnSummary()가 한국어 문자열 생성
        │
        ▼
tools/game-loop.js
  LLM 플레이어 결정 → 액션 적용 → 핸드 종료
        │
        ├─ redacted hand + stats + practiceFocus
        ▼
  buildCoachPrompt()
        │
        ▼
  LLM 핸드 코치 1~2줄
        │
        ▼
  종료 evaluator → synthesizer → review.md
        │
        ▼
  “다음 게임에서 연습할 것”을 다음 세션 practiceFocus로 전달
```

이 흐름은 **설명과 회고**에는 유효하지만, **정답 산출과 계량**이 LLM에 암묵적으로 맡겨져 있다. 목표 구조는 다음과 같아야 한다.

```text
engine이 생성한 DecisionContext
        │
        ▼
strategy evaluator (순수·결정론적)
  - 지원 spot 판정
  - 전략 조회
  - action EV 비교
  - EV loss / tag 산출
        │
        ├───────────────┐
        ▼               ▼
DecisionGrade       analytics/learning
        │          leak·mastery·mistake card
        ▼               │
LLM Coach              drill scheduler
  숫자를 만들지 않고     │
  주어진 근거를 설명      ▼
        └────────── 다음 문제/다음 게임
```

핵심 원칙은 다음 한 문장이다.

> **LLM은 정답을 생성하지 않고, 검증된 정답을 이해하기 쉽게 설명한다.**

---

## 3. 정밀 코드 분석 결과

### F-01. 코치의 판정 근거가 GTO/EV 데이터에 연결돼 있지 않다 — P0

관련 코드:

- `tools/game-loop.js::buildCoachPrompt`
- `tools/game-loop.js::buildEvaluatorPrompt`
- `tools/game-loop.js::buildSynthesizerPrompt`
- `tools/coach-control.js::validateCoachOutput`

현재 핸드 코치는 다음 입력을 사용한다.

- redacted hand
- 누적 stats
- 이전 리뷰에서 넘어온 practice focus
- 과폴드 코멘트 허용 여부

좋은 점은 상대 비공개 카드와 아키타입을 보지 못하고, 숫자를 함부로 만들지 말라는 제약이 있다는 것이다. 그러나 프롬프트에는 실제 strategy distribution, action EV, range equity, solver provenance가 없다. 결과적으로 코치가 “무난한 폴드”, “과도한 콜”이라고 말해도 그 판정의 정량 근거를 시스템이 재현하거나 테스트할 수 없다.

필요한 변화:

- LLM 호출 전에 `DecisionGrade`를 기계적으로 생성한다.
- 코치 프롬프트는 grade의 숫자와 근거만 설명하도록 제한한다.
- strategy가 지원하지 않는 spot은 `unsupported`로 표시하고 숫자·레인지를 생성하지 않는다.
- 코치 텍스트와 grade 원본을 분리해 보존한다.

---

### F-02. 액션 계약이 구조화된 상태를 문자열로 만든 뒤 다시 정규식으로 파싱한다 — P0

관련 코드:

- `engine/views.js::turnSummary`
- `tools/game-loop.js::legalFromMessage`
- `tools/game-loop.js::validatedDecision`

`turnSummary()`는 `legal 수치: canCheck=...` 형태의 한국어 문자열을 만든다. 이후 sidecar는 `legalFromMessage()`의 정규식으로 그 문자열을 다시 파싱해 LLM 응답을 검증한다.

현재 계약은 동작하지만 학습 시스템의 기반으로는 취약하다.

- UI 문구나 번역을 바꾸면 action validation이 깨질 수 있다.
- GTO evaluator가 필요한 position, effective stack, pot, action tree를 문자열에서 다시 복원해야 한다.
- 동일 결정의 정규화 결과를 테스트하기 어렵다.
- 자연어 프롬프트와 기계 계약이 결합돼 있다.

필요한 변화:

- `step` 응답의 `next`에 기계용 `decisionContext`와 `legal` 객체를 추가한다.
- 기존 `message`는 LLM 표시용으로 유지한다.
- sidecar는 `next.legal`을 직접 검증하고 `legalFromMessage()` 의존을 제거한다.
- context에는 `schemaVersion`과 안정적인 canonical position/action 표현이 있어야 한다.

이 작업은 GTO 기능 이전에 먼저 해야 하는 기반 공사다.

---

### F-03. 현재 기본 게임은 토너먼트형이라 정적 GTO 학습 spot과 직접 비교하기 어렵다 — P0

관련 코드:

- `engine/hand.js::createGame`
- `engine/hand.js::startHand`
- `engine/hand.js::blindsForLevel`
- `tools/game-loop.js::parseGameLoopArgs`
- `.agents/skills/start-game/SKILL.md`

현재 기본값은 다음과 같다.

- 시작 스택 5000
- 블라인드 25/50
- 기본 8핸드마다 레벨 상승
- 한 명이 bust할 때까지 스택이 계속 변함

게임으로서는 자연스럽지만 pre-solved training grid와 비교할 때 다음 변수가 동시에 바뀐다.

- effective stack
- blind level
- 남은 인원 수
- 포지션 구조
- 멀티웨이 진입
- action size tree

필요한 변화:

```text
mode = tournament | cash | drill
```

- `tournament`: 현재 동작을 그대로 유지한다.
- `cash`: 블라인드 고정, 스택 지속, 세션 단위 플레이.
- `drill`: 한 spot 또는 한 hand가 끝날 때 스택과 시나리오를 재설정한다.

Phase 1의 기준 환경은 `6-max / 100BB / fixed blinds / no ante`로 둔다. 단, 실제 핸드에서 depth가 변하거나 strategy tree와 맞지 않으면 evaluator는 명시적으로 unsupported를 반환해야 한다.

---

### F-04. 포지션 표기가 학습용 canonical key로는 충분하지 않다 — P0

관련 코드:

- `engine/views.js::positionsOf`

현재 함수는 버튼부터 순회하며 BTN/SB/BB와 `UTG`, `UTG+n`, 마지막 CO를 붙인다. 화면 표시에는 충분하지만 strategy lookup key에는 더 엄격한 규칙이 필요하다.

예를 들어 6-max는 항상 다음 집합으로 정규화돼야 한다.

```text
UTG / HJ / CO / BTN / SB / BB
```

또한 bust로 인원이 줄었을 때 같은 seat가 어떤 포지션이 되는지, heads-up BTN/SB 규칙, dead seat 처리도 하나의 canonical 함수로 고정해야 한다.

필요한 변화:

- 표시 문자열과 strategy key를 분리한다.
- `canonicalPositionsOf(state)`를 엔진 소유의 순수 함수로 만든다.
- `DecisionContext.hero.position`과 action history의 actor position에 동일 함수를 사용한다.
- 2~9 handed fixture를 고정한다.

---

### F-05. 현재 통계는 플레이 스타일 요약에는 충분하지만 leak 진단에는 부족하다 — P1

관련 코드:

- `engine/hand.js::emptyStats`
- `engine/hand.js::updateStats`
- `engine/views.js::statsReport`

현재 노출 지표는 주로 다음이다.

- VPIP
- PFR
- AF
- Showdown Win
- Net
- Sample

문제는 다음과 같다.

- 포지션별 분해가 없다.
- 3-bet, fold-to-3-bet, steal, blind defense 등의 **기회(opportunity)** 분모가 없다.
- postflop street별 c-bet, fold, check-raise가 없다.
- 결과 기반 net과 결정 품질이 분리되지 않는다.
- EV loss가 없다.

핵심 학습 지표는 다음과 같아야 한다.

```text
EV Loss / 100 decisions
```

권장 방향:

- core state에 모든 파생 통계를 즉시 추가하기보다 archived hand와 `DecisionGrade`에서 feature를 파생하는 `analytics/` 계층을 만든다.
- 통계는 `count / opportunities` 구조로 저장한다.
- position, stack bucket, spot tag, street별로 집계한다.
- 표본 수와 신뢰도를 함께 노출한다.

---

### F-06. `practiceFocus`는 좋은 씨앗이지만 영속 Skill Profile은 아니다 — P1

관련 코드:

- `.agents/skills/start-game/SKILL.md`
- `tools/game-loop.js`의 `--practice-focus-file`
- `tools/game-loop.js::buildCoachPrompt`
- 종합 리뷰의 `## 다음 게임에서 연습할 것`

현재는 이전 리뷰의 자연어 항목을 다음 게임에 전달한다. 이 방식은 사람이 읽기 좋지만 다음 기능을 안정적으로 구현하기 어렵다.

- 어떤 skill의 mastery가 개선됐는지 비교
- 같은 leak의 누적 EV loss 집계
- 틀린 spot 재출제
- 복습 간격 계산
- 표본 수·최근성·난이도 반영

필요한 변화:

- `game/`의 일회성 상태와 별도로 gitignored 영속 학습 저장소를 둔다.
- 자연어 focus는 profile에서 파생한다.
- profile schema를 versioning하고 atomic write한다.

예시:

```json
{
  "schemaVersion": 1,
  "skills": {
    "preflop.rfi.btn": {
      "opportunities": 42,
      "graded": 42,
      "totalEvLossBb": 0.84,
      "mastery": 0.91,
      "lastPracticedAt": "2026-08-31T00:00:00Z"
    },
    "preflop.bb_defense.vs_btn": {
      "opportunities": 31,
      "graded": 28,
      "totalEvLossBb": 4.12,
      "mastery": 0.54,
      "lastPracticedAt": "2026-08-30T00:00:00Z"
    }
  }
}
```

---

### F-07. 현재 AI archetype은 행동 정책을 보장하지 않는다 — P1

관련 코드:

- `engine/personas.js`
- `tools/player-prompt.md`
- `tools/player-runtime.js`

현재 persona에는 다음 값이 들어간다.

- archetype
- bluff frequency
- 3-bet tendency
- tilt tendency
- speech/personality

그러나 이 값은 LLM 프롬프트의 성향 힌트다. 장기적으로 정확한 3-bet 빈도나 river call deviation을 보장하는 policy가 아니다. 따라서 “Calling Station을 exploit하는 훈련”에서 상대가 실제로 정해진 약점을 반복한다는 보장이 없다.

필요한 변화:

```text
Persona Layer
  이름, 말투, 성격

Strategy Policy Layer
  baseline strategy + deviation + seeded sampler
```

권장 controller:

```text
opponentController = llm | policy | hybrid
```

- `llm`: 현재 재미 중심 모드
- `policy`: 결정론적 훈련 상대
- `hybrid`: policy가 액션을 결정하고 LLM은 캐릭터 표현만 담당

Exploit 학습은 `policy` 또는 `hybrid`에서만 점수화해야 한다.

---

### F-08. 전체 게임은 있지만 특정 약점을 반복하는 drill 루프가 없다 — P1

현재 게임 종료 리뷰는 다음 연습 항목을 제안하지만, 그 항목을 즉시 문제로 변환하지 않는다.

필요한 구성:

- Spot generator
- Seeded scenario fixture
- Mistake Bank
- 복습 scheduler
- mastery update
- 세션 구성기

예:

```text
오늘의 20문제
- 어제 틀린 문제 6
- mastery가 낮은 BB defense 8
- 유지용 BTN RFI 4
- 새 유형 2
```

게임과 drill은 동일한 `DecisionContext`와 `DecisionGrade`를 사용해야 한다. 별도의 평가 규칙을 만들면 두 모드가 곧 어긋난다.

---

### F-09. 피드백 UI가 자연어 중심이며 정답·근거·range를 단계적으로 탐색할 수 없다 — P1

관련 코드:

- `server/public/app.js`
- `server/public/index.html`
- `server/public/style.css`

권장 피드백 계층:

1. **즉시 요약**: chosen / recommended / grade / EV loss
2. **Why**: pot odds, stack, public action tree, 핵심 이유
3. **Strategy**: action frequency와 EV
4. **Range**: 데이터가 실제로 제공될 때만 13×13 matrix

중요한 제품 규칙:

- 사용자가 액션하기 전에는 답을 노출하지 않는다.
- 다음 street의 비공개 정보로 이전 결정을 재평가하지 않는다.
- unsupported spot에는 그럴듯한 숫자 대신 이유를 표시한다.
- 세션 결과와 decision quality를 별도 카드로 보여 준다.

또한 `app.js`에 모든 기능을 계속 추가하지 말고, build tool 없이 사용할 수 있는 ES module 단위로 training UI를 분리하는 편이 안전하다.

---

### F-10. 표준 Hand History export 경계가 없다 — P2

관련 코드:

- `game/hands/hand-####.json` 아카이브
- `engine/views.js::redactRecord`
- `engine/cli.js`의 hand 조회

현재 내부 hand record는 export의 좋은 원천이다. 다만 외부 분석기와 연동하려면 다음을 명시해야 한다.

- table size와 seat 번호
- blinds/ante
- button
- dealt cards
- street별 action 및 raise-to 의미
- uncalled bet 반환
- side pot
- showdown/muck
- 결과와 rake

처음부터 특정 상용 서비스 API에 결합하지 말고, 순수 exporter와 golden fixture를 만든다. 외부 도구 호환성은 fixture로 검증한다.

---

### F-11. postflop solver를 바로 sidecar에 넣으면 현재의 강한 경계가 무너질 수 있다 — P2

`tools/game-loop.js`는 이미 부트스트랩, 액션, 워치독, 코치, 게시, 복구, finalization을 소유하는 큰 파일이다. 여기에 strategy parsing, spot matching, solver process 관리, profile update까지 직접 넣으면 회귀 위험이 크다.

필요한 변화:

- strategy 계산은 sidecar 밖의 순수 모듈로 분리한다.
- 외부 solver가 필요하면 adapter interface 뒤에 둔다.
- engine은 solver와 네트워크를 몰라야 한다.
- sidecar는 입력/출력과 deadline만 orchestration한다.
- solver가 지원하지 않는 tree는 fail-closed한다.

---

### F-12. 현재 테스트 철학은 강하며, 학습 기능도 같은 수준의 계약 테스트가 필요하다 — P0

현재 저장소는 built-in `node:test`, process/lock integration, 문서 문면 계약까지 활용한다. 새 학습 계층은 다음을 테스트해야 한다.

- position fixture
- action history normalization
- chip ↔ BB 변환
- mixed strategy에서 frequency와 EV 판정 분리
- unsupported fail-closed
- strategy provenance/checksum
- resume 시 grade 중복 생성·중복 profile 반영 방지
- 액션 이전 UI 답 노출 금지
- hand history golden file
- deterministic seed 재현

---

## 4. 목표 아키텍처

```text
┌─────────────────────────────────────────────────────────────┐
│ engine/                                                     │
│ rules, state transition, canonical DecisionContext          │
│ strategy/solver/network를 모름                              │
└───────────────────────┬─────────────────────────────────────┘
                        │ structured step envelope
                        ▼
┌─────────────────────────────────────────────────────────────┐
│ strategy/ (new, pure/read-only)                             │
│ schema · spot normalizer · preflop store · decision grader  │
│ 외부 I/O는 명시적 adapter 외 금지                           │
└───────────────────────┬─────────────────────────────────────┘
                        │ DecisionGrade
             ┌──────────┴──────────┐
             ▼                     ▼
┌──────────────────────┐  ┌──────────────────────────────────┐
│ tools/               │  │ analytics/ + learning/ (new)    │
│ orchestration        │  │ features, profile, mistakes,    │
│ coach explanation    │  │ scheduler                       │
└──────────┬───────────┘  └──────────────┬───────────────────┘
           │ publish                      │ next focus/drill
           └──────────────┬───────────────┘
                          ▼
┌─────────────────────────────────────────────────────────────┐
│ server/public                                               │
│ play UI + post-decision feedback + drill + progress         │
└─────────────────────────────────────────────────────────────┘
```

### 레이어 규칙

1. `engine/`은 여전히 규칙과 상태의 유일한 권위다.
2. `strategy/`는 engine state를 쓰지 않는 순수 계층이다.
3. `tools/`는 strategy output을 받아 게시·코치·profile update를 orchestration한다.
4. LLM은 `DecisionGrade`에 없는 수치나 range를 추가하지 못한다.
5. 사용자 profile은 `game/`과 분리하고 atomic/versioned하게 저장한다.
6. 모든 grade에는 strategy source/version/checksum이 붙는다.

---

## 5. 핵심 데이터 계약

### 5.1 `DecisionContext`

```json
{
  "schemaVersion": 1,
  "decisionId": "...",
  "handNo": 12,
  "mode": "cash",
  "street": "preflop",
  "seatCount": 6,
  "hero": {
    "playerId": "user",
    "position": "BB",
    "holeCards": ["Ah", "8d"],
    "stackChips": 4875,
    "stackBb": 97.5,
    "investedStreetChips": 50
  },
  "table": {
    "buttonPlayerId": "p3",
    "smallBlindChips": 25,
    "bigBlindChips": 50,
    "anteChips": 0,
    "potChips": 175,
    "effectiveStackBb": 97.5
  },
  "board": [],
  "actionHistory": [
    {
      "street": "preflop",
      "actorPlayerId": "p3",
      "actorPosition": "BTN",
      "action": "raise",
      "raiseToChips": 125,
      "raiseToBb": 2.5
    }
  ],
  "legal": {
    "canFold": true,
    "canCheck": false,
    "callChips": 75,
    "canRaise": true,
    "minRaiseToChips": 200,
    "maxRaiseToChips": 4925
  }
}
```

규칙:

- engine의 정수 chip 값이 원본이다.
- BB 값은 평가·표시용 파생값이다.
- hero가 실제 결정 시점에 알 수 있었던 정보만 포함한다.
- user grade용 context는 user hole cards를 포함하지만 상대 비공개 카드는 포함하지 않는다.
- `decisionId`로 action, grade, profile update의 exactly-once key를 만든다.

### 5.2 `StrategyQuery`

```json
{
  "game": "NLHE",
  "street": "preflop",
  "seatCount": 6,
  "heroPosition": "BB",
  "effectiveStackBucketBb": 100,
  "anteBb": 0,
  "actionTree": [
    { "position": "BTN", "action": "raise", "sizeBb": 2.5 }
  ],
  "handClass": "A8o"
}
```

정규화 규칙은 versioning해야 한다. 다른 open size를 임의로 가장 가까운 tree에 매핑하지 말고, 명시적으로 허용된 tolerance나 mapping policy가 없으면 unsupported로 처리한다.

### 5.3 `DecisionGrade`

```json
{
  "schemaVersion": 1,
  "decisionId": "...",
  "status": "supported",
  "chosen": { "action": "fold" },
  "actions": {
    "fold": { "frequency": 0.05, "evBb": 0.0 },
    "call": { "frequency": 0.78, "evBb": 0.18 },
    "raise": { "frequency": 0.17, "evBb": 0.21 }
  },
  "bestEvBb": 0.21,
  "chosenEvBb": 0.0,
  "evLossBb": 0.21,
  "grade": "mistake",
  "skillTags": ["preflop.bb_defense.vs_btn"],
  "source": {
    "strategyId": "6max-100bb-noante-btn25-v1",
    "version": 1,
    "checksum": "sha256:...",
    "license": "user-provided"
  }
}
```

판정 규칙:

- frequency가 낮다는 이유만으로 오답 처리하지 않는다.
- 가능한 경우 action EV 차이로 평가한다.
- EV가 제공되지 않는 데이터셋은 `frequency-only` capability를 명시하고 EV loss를 만들지 않는다.
- threshold는 설정과 버전에 포함한다.
- 지원되지 않는 spot은 다음처럼 명시한다.

```json
{
  "status": "unsupported",
  "reason": "MULTIWAY_NOT_SUPPORTED"
}
```

### 5.4 `MistakeCard`

```json
{
  "schemaVersion": 1,
  "id": "decision:<decisionId>",
  "skillTags": ["preflop.bb_defense.vs_btn"],
  "contextRef": "...",
  "gradeRef": "...",
  "firstSeenAt": "...",
  "lastReviewedAt": "...",
  "nextReviewAt": "...",
  "intervalDays": 3,
  "ease": 2.3,
  "attempts": 2,
  "lapses": 1
}
```

원본 상대 이름이나 세션 결과보다 normalized spot을 복습 단위로 사용한다.

### 5.5 `OpponentPolicy`

```json
{
  "schemaVersion": 1,
  "policyId": "calling-station-v1",
  "baseline": "gto",
  "deviations": [
    {
      "spotTag": "river.vs_75pct_bet",
      "action": "call",
      "frequencyDelta": 0.22
    }
  ],
  "seed": "session-seed"
}
```

정책은 표본을 통해 실제 deviation을 재현할 수 있어야 한다. persona 문구만으로 policy를 대신하지 않는다.

---

## 6. 파일별 변경 계획

| 파일/영역 | 현재 역할 | 제안 변경 |
|---|---|---|
| `engine/hand.js` | 게임 설정·상태 전이·통계 원시값 | `mode`, fixed blind/ante config, drill reset 경계. GTO 로직은 넣지 않음 |
| `engine/views.js` | view, position, turn summary, redaction, stats | canonical position과 `decisionContextFor()` 추가. 표시 문자열과 기계 계약 분리 |
| `engine/cli.js` | 엔진 외부 계약 | `step` envelope에 structured context 추가. 필요 시 `decision-context` 조회 제공 |
| `engine/personas.js` | LLM persona 생성 | persona와 policy id를 분리. 기존 LLM mode 호환 유지 |
| `tools/game-loop.js` | 전체 orchestration | `legalFromMessage()` 제거, evaluation pipeline 호출, grade publish/profile exactly-once orchestration. 계산 로직은 새 모듈로 추출 |
| `tools/player-prompt.md` | LLM player action 계약 | structured legal을 프롬프트로 직렬화하되 기계 검증은 객체 사용. policy mode와 분리 |
| `tools/coach-control.js` | 코치 authority·중복 방지 | coach text의 권위는 유지. grade 원본은 별도 immutable artifact/ref로 연결 |
| `server/public/app.js` | 현재 UI 상태·렌더링 | feedback/drill/progress 모듈을 ES module로 분리 |
| `server/public/index.html` | UI shell | training panel, session score, review queue 추가 |
| `server/public/style.css` | UI 스타일 | grade·range·progress 반응형 스타일 추가 |
| `README.md` | 실행·운영 | mode, strategy data 준비, 학습 흐름, privacy 안내 |
| `ARCHITECTURE.md` | 경계 불변식 | `strategy/`, `analytics/`, `learning/` 경계 추가 |
| `.gitignore` | runtime 제외 | 개인 profile, strategy cache, exported HH의 기본 정책 추가 |

권장 신규 파일:

```text
strategy/
  schema.js
  hand-class.js
  spot-normalizer.js
  preflop-store.js
  decision-grader.js
  provenance.js

analytics/
  hand-features.js
  opportunity-stats.js
  leak-detector.js

learning/
  profile-store.js
  mistake-bank.js
  scheduler.js
  session-planner.js

opponents/
  policy-schema.js
  policy-engine.js
  policies/

export/
  hand-history.js

tools/
  evaluation-pipeline.js
  export-hand-history.js
```

외부 solver는 훗날 다음 인터페이스 뒤에 둔다.

```js
export interface StrategyProvider {
  capabilities(): StrategyCapabilities;
  evaluate(query, { signal, deadlineMs }): Promise<StrategyResult>;
}
```

JavaScript에는 실제 `interface` 문법 대신 문서화된 object contract와 runtime validator를 사용한다.

---

## 7. 단계별 구현 로드맵

### Phase 0 — Contract Foundation

목표:

- structured `DecisionContext`
- canonical positions
- text 재파싱 제거
- decision/grade exactly-once key

완료 후에도 게임 플레이는 기존과 동일해야 한다.

### Phase 1 — Preflop GTO Fundamentals

목표:

- `tournament | cash | drill` 모드
- 6-max fixed-blind 환경
- strategy dataset schema/provenance
- preflop lookup
- EV-loss grading
- 액션 후 feedback UI
- unsupported fail-closed

이 단계만 완료해도 프로젝트는 정성적 코치에서 계량형 preflop trainer로 전환된다.

### Phase 2 — Adaptive Learning

목표:

- opportunity stats
- durable Skill Profile
- leak detector
- Mistake Bank
- spaced repetition
- personalized drill session

### Phase 3 — Deterministic Opponents and Exploit

목표:

- persona/policy 분리
- policy controller
- opponent reading assessment
- GTO score와 exploit score 이중 표시

### Phase 4 — Interop and Postflop

목표:

- standard hand-history export
- provider interface
- postflop solver adapter
- range visualization
- tree/depth mismatch fail-closed

---

## 8. Phase 1 완료 조건

기능:

- [ ] 현재 tournament 모드는 회귀 없이 유지된다.
- [ ] `cash`에서 blind level이 상승하지 않는다.
- [ ] `drill`은 seeded fixture로 동일 문제를 재현한다.
- [ ] 2~9 handed position fixture가 canonical key를 반환한다.
- [ ] sidecar가 한국어 `legal 수치` 문자열을 파싱하지 않는다.
- [ ] 지원되는 preflop spot은 strategy source와 함께 grade된다.
- [ ] mixed strategy에서 선택 빈도와 EV를 구분한다.
- [ ] action EV가 없으면 EV loss를 만들지 않는다.
- [ ] 멀티웨이, 미지원 stack, 미지원 size는 unsupported가 된다.
- [ ] LLM coach는 grade에 없는 숫자를 생성하지 않는다.
- [ ] feedback은 사용자 액션 확정 뒤에만 나타난다.
- [ ] game resume 후 같은 decision이 profile에 두 번 반영되지 않는다.

품질:

- [ ] `node --test` 통과
- [ ] `npm run test:ci` 통과
- [ ] strategy fixture checksum 검증
- [ ] malformed/unknown schema fail-closed
- [ ] no external npm dependency 원칙 유지 또는 변경 시 별도 의사결정 기록
- [ ] README/ARCHITECTURE/skill contract 동기화

---

## 9. 테스트 계획

### 단위 테스트

```text
test/decision-context.test.js
test/positions.test.js
test/spot-normalizer.test.js
test/preflop-store.test.js
test/decision-grader.test.js
test/opportunity-stats.test.js
test/profile-store.test.js
test/mistake-bank.test.js
test/policy-engine.test.js
test/hand-history-export.test.js
```

필수 case:

- BTN/SB heads-up 규칙
- 6-max UTG/HJ/CO/BTN/SB/BB
- short all-in raise
- raise-to와 raise-by 혼동 방지
- 2.5BB open과 다른 size tree mismatch
- suited/offsuit/pair hand-class canonicalization
- 동일 EV의 mixed action
- frequency는 낮지만 EV loss 0인 action
- unsupported multiway
- strategy checksum mismatch
- profile crash-safe atomic write
- same decisionId duplicate ingest

### 통합 테스트

- `step → decisionContext → action → grade → publish`
- game-loop resume 중 grade exactly-once
- coach가 grade artifact만 설명
- fixed blind session에서 level-up event 0회
- drill seed 재현
- UI snapshot에 액션 전 answer 미포함
- final review가 result와 process score를 분리

### Golden fixture

- preflop dataset fixture
- decision grade fixture
- PokerStars-like HH fixture
- UI snapshot fixture

---

## 10. 라이선스·데이터 정책

GTO 데이터는 코드보다 출처와 사용권이 더 중요하다.

원칙:

1. 상용 solver/트레이너 데이터를 스크래핑하거나 저장소에 재배포하지 않는다.
2. strategy file마다 provenance를 강제한다.
3. `source`, `version`, `checksum`, `license`, `capabilities`가 없으면 로드하지 않는다.
4. 사용자 제공 데이터는 기본적으로 gitignored 경로에 둔다.
5. 오픈소스 solver adapter를 추가할 때는 코드 라이선스와 생성 데이터의 사용 조건을 별도로 검토한다.
6. 정확한 EV가 없는 데이터로 EV loss를 표시하지 않는다.

권장 경로:

```text
user-data/strategies/     # 기본 gitignore
fixtures/strategies/      # 테스트용 소형 synthetic dataset만 commit
```

---

## 11. 주요 위험과 완화책

| 위험 | 영향 | 완화 |
|---|---|---|
| strategy tree mismatch를 억지 매핑 | 잘못된 확신 | unsupported fail-closed, mapping versioning |
| sidecar 비대화 | 복구·종료 회귀 | 순수 모듈과 pipeline 추출, orchestration만 유지 |
| LLM이 숫자를 보정·창작 | 코칭 신뢰 하락 | 허용 숫자 목록, structured input, output validator |
| 결과를 보고 이전 결정을 평가 | 결과 편향 | decision-time context snapshot 사용 |
| profile 중복 반영 | mastery 왜곡 | decisionId idempotency ledger |
| 작은 표본으로 leak 단정 | 잘못된 drill | opportunities와 confidence 노출 |
| persona와 policy 혼동 | exploit 훈련 불안정 | controller mode와 policy provenance 표시 |
| proprietary data 포함 | 법적/운영 위험 | gitignore, provenance, license gate |
| range UI가 unsupported data를 암시 | 사용자 오해 | capability 기반 UI, 없는 값 숨김 |

---

## 12. 이슈 분해와 의존성

```text
[GTO-01] DecisionContext + canonical position
   ├─ [GTO-02] game modes / fixed-blind 6-max
   └─ [GTO-03] preflop strategy store + EV grader
          └─ [GTO-04] grounded coach + feedback UI
                 └─ [GTO-05] opportunity analytics + Skill Profile
                        └─ [GTO-06] drill + Mistake Bank + spaced repetition

[GTO-03] ── [GTO-07] persona/policy separation
                  └─ [GTO-08] exploit trainer + dual score

[GTO-01] ── [GTO-09] hand history export
[GTO-03] ── [GTO-10] postflop provider interface
```

권장 우선순위:

1. GTO-01
2. GTO-02와 GTO-03 병렬
3. GTO-04
4. GTO-05
5. GTO-06
6. GTO-07 → GTO-08
7. GTO-09
8. GTO-10

---

## 13. 제품 수준의 성공 지표

개발 완료 여부보다 학습 효과를 측정해야 한다.

세션 지표:

- graded decisions
- supported coverage
- EV loss / 100 decisions
- spot별 EV loss
- repeat mistake rate
- drill retention at 1/3/7/14 days
- calibration: high-confidence recommendation의 재현성

사용자 개선 지표:

- 동일 skill tag의 rolling EV loss 감소
- BB defense, RFI, vs 3-bet 등 핵심 skill mastery 상승
- mistake 재발 간격 증가
- GTO score와 exploit score의 독립 개선

운영 지표:

- evaluator latency
- unsupported reason distribution
- strategy load/checksum failure
- duplicate grade/profile ingest 0건
- resume/finalization 회귀 0건

---

## 14. 최종 권고

현재 저장소의 가장 큰 자산은 이미 만들어진 브라우저 게임이나 LLM 페르소나만이 아니다. **규칙 엔진, redaction, 프로세스 격리, 재개, 결과와 과정의 분리**라는 신뢰 기반이다.

따라서 다음 단계에서 solver를 중심에 두거나 모든 것을 재작성할 필요가 없다.

- 엔진이 결정 시점의 사실을 구조화한다.
- strategy 계층이 지원 가능한 범위에서 정답과 EV를 계산한다.
- analytics/learning이 장기 약점을 기억한다.
- LLM은 그 근거를 설명하고 연습 계획을 언어화한다.
- UI는 정답 → 이유 → 전략 → 복습으로 깊이를 조절한다.

이 순서를 지키면 AI-Holdem은 현재의 강한 운영 안정성을 유지하면서 다음 제품으로 발전할 수 있다.

> **플레이한 모든 결정을 측정하고, 가장 큰 누수를 찾아, 다시 틀리지 않을 때까지 개인화해 출제하는 AI 홀덤 코치.**
