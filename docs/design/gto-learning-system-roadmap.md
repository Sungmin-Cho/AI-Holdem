# AI-Holdem 개인화 GTO·Exploit 학습 시스템 정밀 분석 및 구현 로드맵

- 상태: 제안
- 작성일: 2026-08-31
- 대상 저장소: `Sungmin-Cho/AI-Holdem`
- 기준 브랜치: `main`
- 목적: 현재의 AI 홀덤 게임을 **측정 가능한 개인화 학습 시스템**으로 확장한다.

---

## 1. 결론

현재 AI-Holdem은 다음 기반이 이미 강하다.

1. 규칙 엔진, 사이드카, 서버가 분리되어 있다.
2. LLM 플레이어·코치·종합 리뷰가 단일 런타임 경계를 통해 호출된다.
3. 핸드 종료 후 코칭과 게임 종료 후 결과 독립적 리뷰가 있다.
4. 이전 리뷰의 연습 항목을 다음 게임의 `practiceFocus`로 전달한다.
5. 프로세스 생명주기, 재개, 게시 멱등성, 비공개 정보 차단을 매우 엄격하게 다룬다.

반면 실력 향상 관점의 핵심 부족점은 하나로 요약된다.

> 현재 코치는 공개된 핸드 기록과 기본 통계를 해석하지만, 사용자의 선택을 비교할 **기계적으로 검증 가능한 전략 기준선**이 없다.

따라서 다음 단계는 LLM을 더 크게 쓰는 것이 아니라, 아래 학습 루프를 추가하는 것이다.

```text
플레이/드릴
   ↓
정규화된 DecisionRecord
   ↓
전략 기준선 조회 또는 solver 평가
   ↓
빈도·EV·근거 수준이 포함된 StrategyGrade
   ↓
LLM 설명 + UI 피드백
   ↓
Skill Profile / Mistake Bank
   ↓
개인화 드릴
   ↓
재시험
```

가장 먼저 구현할 수직 슬라이스는 다음 네 항목이다.

1. **고정 100BB 6-max Training Mode**
2. **정규화된 결정/spot 스키마**
3. **출처가 명확한 프리플랍 전략 팩과 채점기**
4. **선택 후 즉시 피드백 및 세션별 누수 리포트**

이 네 항목이 완성되기 전에는 postflop solver, exploit trainer, 범위 시각화를 먼저 구현하지 않는다.

---

## 2. 목표와 비목표

### 2.1 목표

- 결과가 아니라 **의사결정 과정**을 반복 측정한다.
- 어떤 수치도 근거 없이 생성하지 않는다.
- 프리플랍부터 시작해 지원 범위를 점진적으로 확장한다.
- 사용자의 반복 실수를 영속적으로 추적하고 다음 훈련에 반영한다.
- GTO 기준과 상대 약점 공략 기준을 분리해 보여 준다.
- 현재의 보안·격리·재개·멱등성 불변식을 유지한다.
- 기존 Play Mode를 깨지 않고 별도의 Training Mode로 확장한다.

### 2.2 비목표

- 초기 단계에서 GTO Wizard 전체 기능을 재구현하지 않는다.
- LLM의 자연어 판단을 EV나 GTO 정답으로 취급하지 않는다.
- 라이선스가 불명확한 전략표나 상용 solver 데이터를 저장소에 포함하지 않는다.
- 초기 단계에서 임의의 멀티웨이 postflop spot을 모두 풀지 않는다.
- 기존 토너먼트형 Play Mode를 GTO 훈련에 억지로 맞추지 않는다.

---

## 3. 현재 코드 정밀 분석

## 3.1 `engine/hand.js`

현재 이 파일은 다음을 소유한다.

- 게임 생성과 좌석 상태
- 블라인드 레벨 상승
- 핸드 시작과 덱 처리
- 합법 액션 판정
- 베팅 라운드와 사이드팟
- 쇼다운과 스택 정산
- 기본 누적 통계

현재 기본 환경은 시작 스택 5,000, 블라인드 25/50, 8핸드마다 레벨 상승이다. 이는 재미있는 토너먼트형 게임에는 적합하지만 고정된 GTO spot을 반복 비교하기에는 변수가 많다.

기본 통계는 `hands`, `vpip`, `pfr`, `betsRaises`, `calls`, `showdowns`, `showdownWins`, `net` 수준이다. 행동 빈도는 알 수 있지만, 다음은 알 수 없다.

- 행동 기회가 몇 번 있었는가
- 포지션별 누수가 무엇인가
- 특정 preflop node에서 무엇을 틀렸는가
- 최선 행동과의 EV 차이가 얼마인가
- 동일 spot을 다시 만났을 때 개선했는가

### 판단

- 기존 규칙 상태기는 유지한다.
- 학습 채점 로직을 `engine/hand.js` 안에 넣지 않는다.
- 다만 engine이 **결정 시점의 공개 상태를 손실 없이 기록**할 수 있도록 이벤트/기록 스키마를 확장해야 한다.
- Training Mode를 위해 블라인드·스택 정책을 설정 가능하게 해야 한다.

---

## 3.2 `engine/views.js`

현재 `turnSummary()`는 LLM 플레이어가 행동하기에 필요한 다음 공개 정보를 잘 제공한다.

- 핸드 번호와 street
- 포지션
- 홀카드와 보드
- 팟과 블라인드
- 좌석별 스택·베팅·상태
- 공개 액션 이력
- 합법 액션과 raise 범위

`redactRecord()`도 리뷰와 코치가 볼 수 있는 정보를 제한한다. 이 기반은 정규화된 `DecisionRecord`를 만드는 데 유용하다.

반면 `statsReport()`는 기본 게임 통계만 반환한다. 학습 시스템에서 필요한 통계는 엔진 기본 통계와 분리하는 편이 안전하다.

### 판단

- `turnSummary()` 문자열을 다시 파싱해 spot을 만들면 안 된다.
- 문자열 생성 이전의 구조화된 상태에서 `DecisionRecord`를 생성해야 한다.
- `statsReport()`는 기존 UI 호환을 위해 유지한다.
- GTO 정확도·EV loss·mastery는 별도 learner aggregation 계층이 소유한다.

---

## 3.3 `engine/personas.js`

현재 TAG, LAG, Nit, CallingStation, Maniac, Trickster 아키타입이 다음 메타데이터를 만든다.

- 말투
- 성격
- 블러프 빈도
- 3-bet 성향
- 틸트 여부

이 값은 LLM 플레이어 프롬프트에 들어간다. 따라서 캐릭터 표현과 대략적인 성향 유도에는 좋지만, 장기 행동 빈도가 실제로 해당 값에 수렴한다는 기계적 보장은 없다.

### 판단

- `Persona`와 `StrategyPolicy`를 분리한다.
- Persona는 표현 계층이다.
- StrategyPolicy는 액션 분포와 deviation을 기계적으로 정의한다.
- Exploit Training에서는 LLM이 액션 권한을 갖지 않고 policy가 액션을 결정해야 한다.
- 필요하면 LLM은 액션 이후의 캐릭터 문구만 생성한다.

---

## 3.4 `tools/player-prompt.md`와 `tools/player-runtime.js`

현재 플레이어 LLM은 공개 요약과 페르소나 카드만 받고 한 줄 JSON 액션을 반환한다. 파일·도구·네트워크 접근을 막고, 세션을 유지하며, 합법 액션을 엄격히 검증한다.

이 구조는 Play Mode에 적합하다. 그러나 고정된 상대 정책을 훈련해야 하는 모드에서는 LLM 출력 변동성이 학습 표본을 오염시킬 수 있다.

### 판단

플레이어 실행 방식을 mode별로 분리한다.

```text
play mode       → LLM player runtime
training mode   → baseline policy 또는 LLM 선택 가능
exploit mode    → deterministic/stochastic policy runtime
```

현재 `player-runtime.js`의 격리 경계는 유지하고, policy runtime은 별도 구현으로 둔다.

---

## 3.5 `tools/game-loop.js`

현재 사이드카는 다음을 모두 오케스트레이션한다.

- 게임 부트스트랩과 재개
- 사용자·AI 액션 루프
- 워치독과 forced default
- 매 핸드 코치
- 종료 evaluator와 synthesizer
- 게시·재시도·서버 복구
- 최종 리뷰 체크포인트

현재 핸드 코치 입력은 대략 다음과 같다.

- redacted hand
- 기본 stats
- 이전 리뷰에서 전달된 practiceFocus

코치는 사용자의 주요 결정 1~2개를 자연어로 평가한다. 상대 비공개 정보나 존재하지 않는 수치를 만들지 말라는 방어도 들어 있다.

이 설계는 안전하지만, 코치가 GTO 빈도나 EV를 실제 조회하지 않는다. 따라서 코치의 설명은 유용한 휴리스틱일 수 있으나 정답지 역할을 할 수 없다.

### 판단

현재 흐름을 다음과 같이 바꾼다.

```text
현재:
redacted hand + stats + practiceFocus
  → LLM coach

목표:
DecisionRecord
  → Strategy Evaluator
  → StrategyGrade
  → redacted hand + StrategyGrade + practiceFocus
  → LLM coach
```

LLM은 `StrategyGrade`의 수치를 설명할 수 있지만 수정하거나 새 수치를 만들 수 없다.

또한 사이드카의 재개·멱등성 수준에 맞춰 grading과 profile aggregation도 exactly-once로 설계해야 한다.

---

## 3.6 `server/public/`

현재 UI는 테이블, 액션, 로그, 코치 노트, 종합 리뷰를 보여 주는 기반을 갖는다.

학습 기능을 위해 다음 상태가 추가로 필요하다.

- 결정 직후 간단한 판정
- 추천 행동과 빈도
- 수치 근거 수준
- EV loss가 존재하는 경우의 값
- 상세 설명
- 13×13 range matrix
- 세션 누수 요약
- 드릴 진행도와 복습 예정 항목

### 판단

처음부터 모든 패널을 만들지 않는다.

1차 UI는 다음만 제공한다.

```text
내 선택 / 기준 전략 / 근거 수준 / 판정 / EV loss(존재할 때만)
```

Range matrix는 데이터 모델과 채점기가 안정된 뒤 추가한다.

---

## 3.7 테스트와 문서 계약

현재 저장소는 Node 내장 test runner를 사용하고, 프로세스·락·게시·사이드카 계약을 폭넓게 검증한다. 문서 문면 자체를 검사하는 계약 테스트도 있으므로 실행 경로와 문서를 바꿀 때 README, AGENTS, skill 문서를 함께 갱신해야 한다.

### 판단

새 학습 기능도 다음 수준의 테스트를 가져야 한다.

- 순수 함수 단위 테스트
- JSON 스키마 계약 테스트
- golden fixture 테스트
- seed 기반 재현 테스트
- sidecar 통합 테스트
- 중단·재개 exactly-once 테스트
- 데이터 손상 fail-closed 테스트

---

## 4. 핵심 설계 원칙

## 4.1 권위 분리

| 역할 | 권위 |
|---|---|
| 엔진 | 게임 규칙, 합법 액션, 공개 상태 |
| 전략 데이터/solver | 액션 빈도와 EV |
| 채점기 | 사용자의 행동과 기준선 비교 |
| LLM 코치 | 검증된 결과를 이해하기 쉽게 설명 |
| Skill Profile | 장기 학습 상태와 mastery |
| UI | 표현만 담당 |

LLM 출력은 전략 수치의 source of truth가 될 수 없다.

## 4.2 근거 수준을 데이터에 포함

모든 평가에는 `evidenceLevel`이 있어야 한다.

```text
exact_ev       액션별 EV가 검증된 데이터에 포함됨
frequency_only 액션 빈도만 존재함
heuristic      명시된 규칙 기반 평가
unsupported    해당 spot을 지원하지 않음
```

중요 규칙:

- `frequency_only` 데이터로 EV loss를 계산하지 않는다.
- `heuristic`을 GTO라고 표시하지 않는다.
- 지원하지 않는 spot은 가장 그럴듯한 수치를 생성하지 않고 `unsupported`로 남긴다.
- LLM 프롬프트에도 이 경계를 명시한다.

## 4.3 현재 아키텍처 경계 유지

- `engine/`은 네트워크와 LLM을 모른다.
- strategy evaluator는 게임 상태를 변경하지 않는다.
- `tools/game-loop.js`는 engine 내부 함수를 직접 호출하지 않고 기존 CLI 경계를 유지한다.
- 외부 solver는 선택적 subprocess adapter로 격리한다.
- 개인 학습 데이터는 `game/state.json`에 섞지 않는다.

## 4.4 재현성과 멱등성

- Training Mode는 deck과 policy RNG seed를 받을 수 있어야 한다.
- 모든 결정은 `gameEpoch + decisionId`로 유일하게 식별한다.
- 채점 결과와 profile 반영은 중복 실행해도 한 번만 적용되어야 한다.
- crash 후 재개 시 grading artifact와 profile 적용 상태를 reconcile한다.

## 4.5 개인 데이터 분리

장기 학습 상태는 gitignore된 별도 디렉터리에 둔다.

제안:

```text
user-data/
  profile.json
  mistakes/
  sessions/
```

- 기본값은 저장소 로컬 `user-data/`
- CLI 옵션 `--profile-dir`로 외부 경로 지정 가능
- 저장은 원자적으로 수행
- schemaVersion 포함
- 상대의 비공개 홀카드는 mistake record에 저장하지 않음

---

## 5. 목표 아키텍처

```text
Browser
  │
  ├─ Play UI
  ├─ Decision Feedback
  ├─ Session Leak Report
  └─ Drill UI
  │
server/                      중계와 정적 UI
  │
tools/game-loop.js          오케스트레이션
  ├─ engine/cli.js           규칙·상태·DecisionRecord
  ├─ strategy/cli.js         기준선 조회·채점
  ├─ trainer/cli.js          profile·mistake·scheduler
  └─ player runtime
      ├─ LLM runtime
      └─ policy runtime

strategy/
  ├─ spot-schema.js
  ├─ normalize.js
  ├─ evaluator.js
  ├─ providers/
  │   ├─ preflop-pack.js
  │   └─ solver-process.js
  └─ data/preflop/<pack>/

trainer/
  ├─ profile-store.js
  ├─ aggregate.js
  ├─ leak-detector.js
  ├─ mistake-bank.js
  ├─ scheduler.js
  └─ drill-generator.js
```

### 프로세스 경계 제안

`strategy/`와 `trainer/`는 순수 모듈이어야 한다. 사이드카와의 외부 계약은 CLI JSON envelope로 고정한다.

```bash
node strategy/cli.js grade --decision <file> --pack <id>
node trainer/cli.js apply-grade --grade <file> --profile-dir <dir>
node trainer/cli.js next-drill --profile-dir <dir> --count 20
```

장점:

- sidecar가 strategy 내부 구현에 결합되지 않는다.
- solver provider를 교체하기 쉽다.
- fixtures로 독립 테스트할 수 있다.
- 장애와 timeout을 기존 child-process 감독 방식에 맞출 수 있다.

---

## 6. 핵심 데이터 계약

## 6.1 `TrainingConfig`

```json
{
  "schemaVersion": 1,
  "mode": "cash-training",
  "tableSize": 6,
  "startStackBb": 100,
  "blindsBb": [0.5, 1],
  "blindPolicy": "fixed",
  "stackPolicy": "reset_each_hand",
  "anteBb": 0,
  "maxHands": 50,
  "deckSeed": "optional-string",
  "policySeed": "optional-string",
  "strategyPackId": "nlhe-6max-100bb-v1"
}
```

초기에는 `reset_each_hand`만 지원해 spot 깊이를 고정한다. 이후 실제 cash-session 모드를 별도로 추가한다.

## 6.2 `DecisionRecord`

```json
{
  "schemaVersion": 1,
  "decisionKey": "<gameEpoch>:<decisionId>",
  "gameEpoch": "...",
  "handNo": 12,
  "decisionId": "...",
  "mode": "cash-training",
  "variant": "NLHE",
  "tableSize": 6,
  "street": "preflop",
  "heroPosition": "BTN",
  "heroHand": "AJo",
  "board": [],
  "effectiveStackBb": 100,
  "potBb": 1.5,
  "toCallBb": 0,
  "actionHistory": [
    { "position": "UTG", "action": "fold" },
    { "position": "HJ", "action": "fold" },
    { "position": "CO", "action": "fold" }
  ],
  "legalActions": [
    { "action": "fold" },
    { "action": "raise", "minToBb": 2, "maxToBb": 100 }
  ],
  "heroAction": { "action": "raise", "toBb": 2.5 },
  "publicStateHash": "sha256..."
}
```

규칙:

- 칩 단위와 BB 단위를 혼용하지 않는다.
- spot key 생성에 필요한 값을 명시적으로 보존한다.
- 다른 플레이어의 비공개 카드는 포함하지 않는다.
- 문자열 `turnSummary()`를 파싱해 만들지 않는다.
- action size normalization 규칙을 versioning한다.

## 6.3 `StrategyPackManifest`

```json
{
  "schemaVersion": 1,
  "id": "nlhe-6max-100bb-v1",
  "displayName": "NLHE 6-max 100BB baseline v1",
  "variant": "NLHE",
  "tableSize": 6,
  "stackBb": 100,
  "anteBb": 0,
  "openSizeBb": 2.5,
  "evidenceLevel": "frequency_only",
  "source": {
    "name": "...",
    "version": "...",
    "license": "...",
    "url": "..."
  },
  "supportedNodes": ["RFI", "VS_RFI", "VS_3BET"],
  "contentSha256": "..."
}
```

필수 조건:

- source와 license가 비어 있으면 pack 로드를 거부한다.
- proprietary 데이터 scraping을 금지한다.
- 각 combo의 액션 빈도 합은 허용 오차 내에서 1이어야 한다.
- 지원하는 bet size와 node를 manifest가 명확히 선언한다.

## 6.4 `StrategyGrade`

```json
{
  "schemaVersion": 1,
  "decisionKey": "...",
  "provider": {
    "kind": "preflop-pack",
    "id": "nlhe-6max-100bb-v1",
    "version": "1",
    "contentSha256": "..."
  },
  "coverage": "exact",
  "evidenceLevel": "frequency_only",
  "spotKey": "6max:100:RFI:BTN:AJo:2.5",
  "strategy": {
    "fold": 0.04,
    "raise_2.5": 0.96
  },
  "chosenAction": "raise_2.5",
  "chosenFrequency": 0.96,
  "actionEvBb": null,
  "bestEvBb": null,
  "evLossBb": null,
  "classification": "strategy_match",
  "explanationFacts": [
    "BTN unopened pot",
    "AJo",
    "100BB"
  ]
}
```

EV 데이터가 있는 provider에서는 다음 필드를 채운다.

```json
{
  "evidenceLevel": "exact_ev",
  "actionEvBb": 0.21,
  "bestEvBb": 0.28,
  "evLossBb": 0.07,
  "classification": "inaccuracy"
}
```

분류 threshold는 코드 상수로 숨기지 않고 versioned policy로 둔다.

## 6.5 `LearnerProfile`

```json
{
  "schemaVersion": 1,
  "profileId": "default",
  "appliedDecisionKeys": ["..."],
  "summary": {
    "decisions": 120,
    "supported": 93,
    "exactEvDecisions": 41,
    "evLossBb": 7.84
  },
  "skills": {
    "preflop.rfi.btn": {
      "attempts": 18,
      "strategyMatch": 15,
      "evLossBb": 0.42,
      "mastery": 0.82,
      "lastSeenAt": "..."
    }
  },
  "leaks": [
    {
      "id": "preflop.bb_defense_vs_btn",
      "severity": 0.78,
      "confidence": 0.64,
      "sample": 17
    }
  ]
}
```

`appliedDecisionKeys`는 무한히 커질 수 있으므로 실제 구현에서는 compact index 또는 session ledger를 사용한다.

## 6.6 `MistakeRecord`

```json
{
  "schemaVersion": 1,
  "id": "...",
  "decisionKey": "...",
  "spotFamily": "preflop.bb_defense_vs_btn",
  "decision": {},
  "grade": {},
  "mastery": 0.25,
  "intervalDays": 1,
  "dueAt": "...",
  "reviewCount": 0
}
```

---

## 7. 모드 설계

## 7.1 기존 Play Mode

- 현재 토너먼트형 진행 유지
- LLM 페르소나 유지
- 기존 per-hand coach와 final review 유지
- 전략 provider가 지원하는 결정만 선택적으로 채점 가능

## 7.2 GTO Training Mode

초기 고정 조건:

- NLHE
- 6-max
- 100BB
- ante 없음
- fixed blinds
- 매 핸드 100BB reset
- 정해진 preflop sizing tree
- 사용자가 정한 핸드 수 후 종료

이 조건을 벗어나면 provider가 `unsupported`를 반환한다.

## 7.3 Spot Drill Mode

전체 핸드를 진행하지 않고 하나의 결정 node를 반복한다.

초기 scope:

- RFI
- BB vs BTN open
- SB vs BTN open
- CO/BTN vs 3-bet

각 문제는 다음 순서로 동작한다.

```text
문제 표시 → 사용자 선택 → StrategyGrade → 짧은 피드백 → 다음 문제
```

## 7.4 Exploit Training Mode

- 상대 아키타입은 처음에는 숨김
- 실제 액션은 StrategyPolicy가 결정
- baseline과 policy deviation을 모두 보존
- 종료 후 GTO 점수와 exploit 점수를 분리 표시

예:

```text
GTO 기준: river bluff 빈도 정상
상대 정책 기준: Calling Station에게는 bluff 과다
```

---

## 8. 구현 단계

## Phase 0 — 학습 계약 기반

### 산출물

- `DecisionRecord` 스키마
- spot normalizer
- strategy provider 인터페이스
- evidence-level 규칙
- golden fixtures

### 완료 기준

- 같은 공개 상태와 액션은 항상 같은 `DecisionRecord`와 `spotKey`를 만든다.
- 문자열 prompt를 파싱하지 않는다.
- 다른 플레이어 비공개 카드가 포함되지 않는다.
- 지원하지 않는 node를 명시적으로 구분한다.

---

## Phase 1 — 프리플랍 GTO Training MVP

### 산출물

- 고정 100BB 6-max Training Mode
- 출처·license가 포함된 preflop strategy pack
- strategy grader
- 선택 후 간단한 UI 피드백
- 세션 summary

### 완료 기준

- 기존 Play Mode 회귀 없음
- seed를 고정하면 동일 핸드와 동일 policy 행동 재현
- 지원 spot의 strategy frequency를 정확히 반환
- EV가 없는 pack에서 EV loss를 절대 노출하지 않음
- decision별 판정이 재개 후 중복 집계되지 않음

---

## Phase 2 — 개인화 학습 루프

### 산출물

- 영속 LearnerProfile
- opportunity 기반 세부 통계
- Leak Detector
- Mistake Bank
- Spot Drill
- spaced repetition scheduler
- 다음 세션 자동 practice focus

### 완료 기준

- 가장 큰 누수 1~3개가 표본 수와 confidence와 함께 제시됨
- 동일 실수가 복습 큐에 중복 폭증하지 않음
- due 문제 우선, 취약 skill 우선 규칙이 deterministic함
- profile 손상 시 조용히 초기화하지 않고 fail-closed 또는 복구 안내

---

## Phase 3 — Postflop provider

### 초기 scope

- heads-up
- single-raised pot
- 100BB
- 제한된 bet-size tree
- flop부터 단계적으로 확장

### provider 계약

```json
{
  "requestId": "...",
  "spot": {},
  "treeConfig": {},
  "timeoutMs": 300000
}
```

```json
{
  "requestId": "...",
  "status": "ok",
  "strategy": {},
  "ev": {},
  "source": {},
  "solveMeta": {}
}
```

### 규칙

- 외부 solver는 JSON stdin/stdout subprocess로 호출한다.
- network는 기본 금지한다.
- timeout과 종료 확인 없이는 대체 solver를 동시에 실행하지 않는다.
- 결과 cache key에 spot, tree config, solver version, strategy pack version을 포함한다.
- 라이선스 검토 전 solver 코드를 저장소에 복사하지 않는다.

---

## Phase 4 — Exploit Trainer

### 산출물

- StrategyPolicy schema
- seed 기반 policy sampling
- baseline deviation 모델
- 상대 읽기 점수
- GTO score / exploit score 분리

### 완료 기준

- 설정된 빈도가 대규모 seed simulation에서 허용 오차 내에 수렴
- LLM이 policy 액션을 바꾸지 못함
- 상대 정책을 게임 중 UI와 코치에 유출하지 않음
- 종료 리뷰에서 실제 policy와 사용자의 대응을 분리 분석

---

## 9. 파일별 변경 제안

## 9.1 기존 파일

### `engine/hand.js`

- `config.mode` 추가
- fixed blind policy 지원
- reset-each-hand stack policy 지원
- 결정 당시 구조화된 공개 snapshot을 action record에 보존
- seed 주입 경계 명시
- 기존 schema와 archive 호환 유지

### `engine/views.js`

- `decisionRecordFor(state, playerId, action)` 또는 동등한 순수 projection 추가
- BB normalization helper 추가
- 기존 `turnSummary()`는 projection 결과를 표현하는 방향으로 점진 정리
- 기본 stats와 learner stats의 책임 분리

### `engine/cli.js`

후보 명령:

```text
decision <decisionId> --action ...
training-config
```

실제 명령 형태는 step envelope와 중복되지 않도록 구현 전에 결정한다. 가장 좋은 선택은 user action 직전 snapshot과 적용 action을 같은 원자 전이에 포함해 반환하는 것이다.

### `engine/personas.js`

- persona가 presentation metadata임을 명시
- `policyId`는 별도 연결 정보로만 보존
- 수치 이름이 실제 보장 빈도로 오인되지 않도록 문서화

### `tools/game-loop.js`

- user decision 이후 grade pipeline 실행
- grade artifact 원자 저장
- profile apply/reconcile
- 코치 prompt에 검증된 `StrategyGrade`만 전달
- unsupported spot 처리
- final review에 세션 leak summary 전달
- play-time 게시와 grading의 장애 격리 정책 정의

권장 정책:

- strategy grading 실패가 게임 규칙 진행을 막지 않음
- Training Mode에서는 피드백 unavailable을 명확히 표시
- profile write 실패는 데이터 유실을 숨기지 않고 notice/halt 정책을 명시

### `tools/player-prompt.md`

Play Mode에서는 현재 계약 유지. policy mode에서는 사용하지 않는다.

### `server/public/app.js`

- decision feedback state
- session summary state
- drill state
- range grid는 후속 단계

### `server/public/index.html`, `style.css`

- feedback drawer
- evidence badge
- EV 표시 조건
- 접근 가능한 range matrix

### `.gitignore`

- `user-data/`
- strategy cache
- solver temporary files

### `README.md`, `AGENTS.md`, start-game skill

- mode별 실행법
- profile directory
- strategy pack
- solver optional dependency
- resume 및 데이터 보존 규칙

---

## 9.2 신규 파일/디렉터리

```text
strategy/
  cli.js
  schema.js
  normalize.js
  evaluator.js
  grade-policy.js
  providers/
    preflop-pack.js
    solver-process.js
  data/
    README.md
    <pack-id>/manifest.json

trainer/
  cli.js
  profile-store.js
  aggregate.js
  leak-detector.js
  mistake-bank.js
  scheduler.js
  drill-generator.js

schema/
  decision-record.schema.json
  strategy-grade.schema.json
  learner-profile.schema.json
  mistake-record.schema.json

test/fixtures/strategy/
test/fixtures/trainer/
```

외부 npm 의존성을 추가하지 않아도 JSON schema의 최소 validator를 직접 계약 테스트로 구현할 수 있다. 정식 validator가 필요해질 때 dependency 정책을 별도 결정한다.

---

## 10. 채점 정책

## 10.1 빈도 기반 판정

빈도만 존재하는 pack에서는 다음과 같이 표현한다.

- `strategy_match`: 선택한 액션이 의미 있는 빈도로 존재
- `rare_mix`: 매우 낮은 빈도의 mix
- `off_strategy`: 기준선에 없는 액션
- `unsupported`: node 또는 size 미지원

이 분류를 `mistake/blunder`라는 EV 의미의 용어와 혼용하지 않는다.

## 10.2 EV 기반 판정

EV가 존재할 때만 다음을 계산한다.

```text
evLossBb = bestEvBb - chosenEvBb
```

분류 threshold 예시 값은 provider와 별도 versioned policy에 둔다. 프로젝트 전역 하드코딩을 피한다.

## 10.3 sizing 처리

사용자가 기준 tree에 없는 sizing을 쓸 수 있으므로 다음을 구분한다.

- exact size
- supported bucket에 매핑 가능
- nearest-size heuristic
- unsupported

`nearest-size heuristic`은 exact GTO 결과로 표시하지 않는다.

---

## 11. Skill Profile과 누수 탐지

기존 VPIP/PFR은 유지하되 학습 통계는 **opportunity denominator**를 갖는다.

예:

```text
RFI opportunities / attempts
3-bet opportunities / attempts
fold-to-3bet opportunities / folds
BB defend opportunities / calls / 3-bets / folds
flop c-bet opportunities / bets
river bluff-catch opportunities / calls
```

누수 severity는 최소한 다음을 고려한다.

```text
severity = impact × recurrence × confidence
```

- impact: EV loss가 있으면 EV, 없으면 off-strategy 정도
- recurrence: 반복 횟수
- confidence: 표본 수와 provider coverage

표본이 적을 때 단정적인 누수로 표시하지 않는다.

---

## 12. Mistake Bank와 spaced repetition

### 저장 기준

다음 중 하나일 때 mistake candidate로 저장한다.

- EV loss threshold 초과
- off-strategy
- 사용자가 수동 bookmark
- 같은 skill에서 반복 실패

### dedupe 기준

`decisionKey`는 사건 중복을 막고, `spotFamily + handClass + actionContext`는 학습 항목 중복을 줄인다.

### 스케줄링

초기에는 복잡한 ML보다 deterministic scheduler를 사용한다.

- 처음 틀림: 1일
- 다시 틀림: interval reset 또는 축소
- 맞음: interval 증가
- mastery가 낮고 severity가 높은 항목 우선

알고리즘과 파라미터를 versioning해 결과 재현이 가능해야 한다.

---

## 13. Hand History와 외부 연동

두 단계로 구현한다.

### 1단계: canonical JSON export

- 모든 내부 의사결정 정보 보존
- strategy grade와 source version 선택 포함
- 테스트와 데이터 이동의 기준 포맷

### 2단계: PokerStars-like text adapter

- 외부 도구 호환을 위한 표현 계층
- fixture 기반 parser round-trip 테스트
- 특정 외부 서비스 호환을 주장하기 전에 실제 업로드 검증
- unsupported multiway/stack/sizing을 사용자에게 명확히 표시

외부 서비스의 사양 변경에 core schema가 종속되지 않도록 한다.

---

## 14. exactly-once와 crash recovery

현재 저장소가 게시와 리뷰에서 지키는 수준을 learner pipeline에도 적용한다.

권장 순서:

```text
1. engine이 DecisionRecord를 생성
2. game/analysis/<decisionKey>.decision.json 원자 저장
3. strategy evaluator가 grade 생성
4. game/analysis/<decisionKey>.grade.json 원자 저장
5. trainer가 profile ledger에 decisionKey 반영
6. profile snapshot 원자 저장
7. UI publish
```

재개 시:

```text
- decision은 있고 grade가 없으면 재채점
- grade는 있고 profile ledger에 없으면 재적용
- ledger에 있으면 중복 적용 금지
- provider version이 달라져도 과거 grade를 조용히 덮어쓰지 않음
```

재채점은 별도 명령으로 명시적으로 수행한다.

---

## 15. 테스트 전략

## 15.1 Strategy

- 169 hand class coverage
- frequency 합 검증
- manifest hash 검증
- unsupported node
- size normalization
- exact/frequency/heuristic 경계
- EV nullability

## 15.2 DecisionRecord

- position 계산
- effective stack 계산
- heads-up와 6-max
- short all-in
- limp/raise/3-bet/4-bet action history
- 다른 플레이어 비공개 카드 부재
- 동일 input의 stable hash

## 15.3 Training Mode

- fixed blind
- hand별 stack reset
- elimination 없음
- maxHands 종료
- seed 재현
- 기존 tournament mode 회귀

## 15.4 Trainer

- duplicate decisionKey idempotency
- atomic write failure
- profile corruption
- leak confidence
- mistake dedupe
- scheduler determinism

## 15.5 Sidecar

- grading child timeout
- grading unavailable notice
- crash between grade write and profile apply
- resume reconcile
- coach가 grade 값을 변조하지 않음
- private literal 방어 유지

## 15.6 UI

- EV 없는 평가에서 EV 영역 숨김
- unsupported badge
- decision 이후에만 답 노출
- mobile layout
- keyboard/accessibility

---

## 16. 성능 목표

초기 목표:

| 항목 | 목표 |
|---|---:|
| preflop lookup p95 | 10ms 이하 |
| decision normalization p95 | 5ms 이하 |
| profile apply p95 | 20ms 이하 |
| grading 실패 시 게임 진행 지연 상한 | 명시적 bounded timeout |
| seed 재현성 | 동일 fixture에서 100% |

Postflop solver는 별도 latency class로 취급하고 일반 플레이 액션 경로의 지연 목표와 섞지 않는다.

---

## 17. 라이선스와 데이터 출처

이 프로젝트는 Apache-2.0이다. 전략 데이터와 solver 통합은 코드보다 먼저 라이선스를 확인한다.

필수 규칙:

- 전략 pack마다 manifest에 source/license/version/hash 기록
- 상용 서비스 결과를 허가 없이 배포하지 않음
- 웹 scraping으로 proprietary range를 수집하지 않음
- AGPL 등 강한 copyleft solver는 배포·연결 방식 검토 후 결정
- 외부 executable 방식이 모든 라이선스 문제를 자동 해결한다고 가정하지 않음
- 불명확하면 optional local adapter만 제공하고 binary/data는 사용자가 별도 설치

---

## 18. 주요 위험과 대응

| 위험 | 대응 |
|---|---|
| LLM이 EV를 만들어 냄 | StrategyGrade 필드만 인용, 새 숫자 금지, output validator |
| frequency chart를 EV로 오인 | evidenceLevel 필수, EV 필드 null 계약 |
| 지원하지 않는 sizing을 억지 매핑 | coverage와 mapping kind 노출 |
| 학습 데이터가 재개 중 중복 집계 | decisionKey ledger와 reconcile |
| training 변경이 Play Mode를 깨뜨림 | mode 분리와 회귀 테스트 |
| persona 수치가 실제 policy로 오인 | Persona/Policy 타입 분리 |
| 외부 solver가 게임을 멈춤 | subprocess timeout, async cache, fail-open/notice 정책 |
| 개인 핸드 기록이 Git에 올라감 | user-data와 cache gitignore, startup warning |
| 적은 표본을 누수로 단정 | confidence와 minimum sample |
| 데이터 라이선스 문제 | manifest gate와 리뷰 체크리스트 |

---

## 19. 기존 신뢰성 이슈와의 관계

현재 열려 있는 프로세스·재개·deadline·session 안전성 이슈는 이 로드맵과 독립적으로 중요하다. 특히 `tools/game-loop.js`에 grading/profile child를 추가하기 전에 다음 원칙을 지킨다.

- 기존 child 종료 확인 규약 재사용
- deadline 이후 side effect 금지
- persisted worker와 새 worker 중첩 금지
- rollback/quiescence 판단에 learner pending write 포함 검토
- session ID 및 argv 안전 규약 유지

새 학습 기능이 기존의 안전성 작업을 우회하는 별도 실행 경로를 만들면 안 된다.

---

## 20. 이슈 분해와 의존 관계

```text
Epic
 ├─ A. Training Mode
 ├─ B. Decision/Spot Schema + Strategy Pack
 │    └─ C. Grader + EV/Frequency Contract
 │          └─ D. Coach/UI Integration
 ├─ E. Skill Profile + Leak Detector
 │    └─ F. Drill + Mistake Bank + SRS
 ├─ G. Hand History Export
 ├─ H. Postflop Solver Adapter
 └─ I. Opponent Policy + Exploit Evaluator
```

권장 순서:

1. A와 B를 병렬 시작
2. C
3. D
4. E
5. F
6. G
7. H와 I는 독립 연구 후 진행

---

## 21. 첫 번째 PR 권장 범위

첫 구현 PR은 기능을 크게 넣지 말고 계약 기반만 만든다.

### 포함

- `DecisionRecord` schema와 순수 normalizer
- 10~20개의 golden fixtures
- `StrategyProvider` 인터페이스
- `StrategyGrade` evidence-level 계약
- unsupported provider stub
- architecture 문서 갱신

### 제외

- 실제 preflop 데이터
- UI
- profile
- solver
- exploit policy

이렇게 해야 이후 모든 기능이 동일한 spot/grade 계약 위에서 개발된다.

---

## 22. 최종 성공 기준

프로젝트가 다음 질문에 기계적으로 답할 수 있을 때 1차 목표가 달성된다.

1. 사용자가 어떤 공개 정보에서 어떤 선택을 했는가?
2. 해당 spot은 어떤 provider와 version으로 평가됐는가?
3. 지원 범위는 exact, bucketed, heuristic, unsupported 중 무엇인가?
4. 추천 행동의 빈도와 EV는 실제 데이터에 있는가?
5. EV가 없다면 시스템이 이를 솔직하게 표시하는가?
6. 사용자의 반복 누수는 무엇이며 표본 신뢰도는 얼마인가?
7. 다음 훈련은 그 누수를 실제로 더 자주 출제하는가?
8. 같은 결정을 crash/resume 후 두 번 집계하지 않는가?
9. 상대 전략과 비공개 정보가 게임 중 유출되지 않는가?
10. 기존 Play Mode와 프로세스 안전성 불변식이 유지되는가?

이 기준을 만족하면 AI-Holdem은 단순히 AI와 플레이하는 게임을 넘어, **근거가 추적되고 반복 학습이 가능한 개인화 포커 훈련 시스템**이 된다.
