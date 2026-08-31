# AI-Holdem GTO·Exploit 학습 시스템 정밀 분석 및 로드맵

> 분석 기준: `main` commit `443dd9cabc5f46e91af29b0d1002a926ad54298b`
>
> 목적: 현재의 안전한 AI 홀덤 게임을 유지하면서, 사용자의 실력을 `측정 → 진단 → 반복 훈련 → 재검증`하는 개인화 학습 시스템으로 확장한다.

## 1. 결론

AI-Holdem은 이미 다음 기반을 잘 갖추고 있다.

- 포커 규칙을 담당하는 순수 엔진
- 게임 생명주기와 AI 호출을 담당하는 detached sidecar
- 규칙을 모르는 HTTP/SSE relay 서버
- LLM의 비공개 정보 접근을 차단하는 player runtime containment
- 핸드 아카이브, redacted review 입력, 코치 authority, 멱등 publish·resume·finalization
- 핸드별 코치와 결과 독립적 종합 리뷰

따라서 새 프로젝트로 다시 만들 필요는 없다. 핵심 문제는 **게임 실행의 완성도**가 아니라 **학습 정답의 객관성 및 반복성**이다.

현재 코치는 공개된 핸드 기록과 통계를 바탕으로 LLM이 자연어 평가를 만든다. 그러나 다음 정보는 기계적으로 계산되지 않는다.

- 해당 spot의 권장 액션 빈도
- 액션별 EV
- 사용자가 선택한 액션의 EV loss
- 실수 등급과 누적 leak
- 동일 leak의 재출제 및 숙련도 변화
- GTO 기준과 상대별 exploit 기준의 차이

따라서 향후 중심 구조는 다음이어야 한다.

```text
Poker engine
  -> canonical decision snapshot
  -> deterministic strategy evaluator
  -> durable evaluation
  -> structured feedback
  -> skill profile / mistake bank
  -> personalized drill

LLM
  -> 위 결과를 설명하고 기억하기 쉽게 표현
  -> 빈도·EV·등급의 source of truth가 되지 않음
```

가장 먼저 구현할 범위는 다음 네 가지다.

1. 고정 6-max 100BB training mode
2. 재현 가능한 canonical decision snapshot
3. 라이선스 안전한 preflop strategy pack + EV evaluator
4. deterministic 결과를 코치와 UI에 연결

이 네 항목이 완료되면 AI-Holdem은 처음으로 **결과 운과 무관하게 사용자의 프리플랍 결정 품질을 측정하는 시스템**이 된다.

---

## 2. 현재 코드 구조

### 2.1 엔진 계층

`engine/`은 카드, 핸드 평가, 사이드팟, betting state transition, 저장과 공개 view를 담당한다.

핵심 파일:

- `engine/hand.js`
  - 게임 생성
  - 블라인드 레벨 계산
  - 핸드 시작 및 street 진행
  - legal action 계산
  - 액션 적용
  - showdown·pot award·통계·게임 종료
- `engine/views.js`
  - 사용자/AI별 공개 view
  - AI turn summary
  - redacted hand
  - 간단한 session stats
- `engine/cli.js`
  - 엔진의 외부 명령 표면
- `engine/state.js`
  - 원자적 JSON 저장
  - 핸드 아카이브
  - mutex·owned lock
- `engine/game-archive.js`
  - 게임 초기화와 이전 게임 archive
- `engine/personas.js`
  - AI persona/archetype 생성

이 경계는 유지해야 한다. 엔진은 앞으로도 네트워크, LLM, solver process를 알면 안 된다.

### 2.2 sidecar·도구 계층

`tools/game-loop.js`가 다음 전체 생명주기를 소유한다.

- bootstrap / resume
- 서버 기동·복구
- 사용자 action 대기
- AI player decision
- watchdog와 fallback
- hand coach 생성·게시
- 종합 review 생성·게시
- finalization과 종료

`tools/player-runtime.js`는 Claude Code, Codex, Grok CLI를 호출하는 유일한 표면이다. prompt는 stdin으로만 전달되고, child는 repository와 `game/` 밖의 격리된 임시 디렉터리에서 실행된다.

`tools/coach-control.js`와 `tools/publish.js`는 코치 결과 및 UI 게시의 authority, retry, digest, idempotency를 강하게 보장한다.

이 안전 장치는 새 학습 데이터에도 그대로 적용해야 한다.

### 2.3 서버·UI 계층

`server/server.js`는 다음 상태만 relay한다.

- `view`
- `log`
- `coach`
- `review`

브라우저 UI는 `server/public/app.js`에서 이를 렌더링한다. 현재 코치 UI는 핸드 번호와 짧은 text만 표시한다.

향후에는 구조화된 `feedback`을 추가하되, 서버가 GTO 규칙이나 EV 계산을 이해하지 않도록 해야 한다.

---

## 3. 학습 관점의 핵심 제약

## 3.1 현재 게임은 비교 가능한 GTO 학습 환경이 아니다

현재 `engine/hand.js`의 config는 다음 중심이다.

- `aiCount`
- `startStack`
- `blinds0`
- `levelEvery`

핸드가 진행되면 블라인드가 상승하고, 스택은 다음 핸드로 이어지며, 칩이 0인 좌석은 탈락한다. 사용자가 탈락하거나 모든 AI가 탈락하면 게임이 끝난다.

이 구조는 토너먼트 게임으로는 자연스럽지만 학습 데이터에는 다음 변동을 만든다.

- effective stack이 핸드마다 달라짐
- blind level이 달라짐
- table size가 탈락에 따라 달라짐
- 동일한 hand class라도 정답 spot이 달라짐
- 세션 간 EV loss 비교가 어려움

따라서 기존 `tournament` 모드를 보존하면서 별도 `training` 모드를 두어야 한다.

초기 training contract:

- 사용자 1명 + AI 5명
- 50/100 고정 blind
- 매 핸드 100BB 재설정
- 탈락 없음
- 버튼 순환
- 기본 100핸드 후 `result: "completed"`

관련 이슈: [#29](https://github.com/Sungmin-Cho/AI-Holdem/issues/29)

## 3.2 현재 action record는 완전한 의사결정 재현 자료가 아니다

`engine/hand.js::applyAction()`은 액션 전 다음 일부 값을 저장한다.

- `decisionId`
- player/action/amount
- street
- pot total
- call amount
- min/max raise
- board
- seat stacks

그러나 strategy evaluator가 정확한 spot을 찾으려면 다음 정보도 필요하다.

- 버튼과 position
- 결정 직전 bets/contribs/current bet
- folded/all-in 집합
- legal action 전체
- 선행 action sequence와 size
- effective stack
- hero hole cards
- schema version

최종 hand archive만 보고 중간 상태를 사후 재구성하는 방식은 미래의 엔진 변경과 schema migration에 취약하다.

따라서 모든 action에 대해 **변경 불가능한 결정 직전 snapshot**을 먼저 만들고 선택 액션과 함께 저장해야 한다.

관련 이슈: [#30](https://github.com/Sungmin-Cho/AI-Holdem/issues/30)

## 3.3 LLM 코치는 GTO ground truth가 아니다

현재 `tools/game-loop.js`의 코치 prompt는 다음을 입력으로 사용한다.

- redacted hand
- session stats
- practice focus

그리고 LLM에 사용자의 주요 결정 1~2개를 짧게 평가하도록 한다. private card leakage를 막고 숫자를 함부로 만들지 않게 하는 제약은 잘 설계되어 있다.

다만 LLM은 실제 strategy table이나 solver 결과를 조회하지 않는다. 따라서 다음을 보장할 수 없다.

- 실제 권장 빈도
- 정확한 mixed strategy
- bet size별 EV
- EV loss
- 동일 입력에 대한 재현성

향후 LLM은 다음 input을 받아야 한다.

```text
redacted hand
+ exact deterministic evaluation JSON
+ cumulative skill context
```

그리고 `evaluation`에 존재하지 않는 수치를 새로 만들 수 없어야 한다.

관련 이슈:

- [#32](https://github.com/Sungmin-Cho/AI-Holdem/issues/32)
- [#33](https://github.com/Sungmin-Cho/AI-Holdem/issues/33)

## 3.4 현재 stats는 행동 성향만 보여주고 실력을 측정하지 않는다

`engine/views.js::statsReport()`의 현재 핵심 값은 다음이다.

- VPIP
- PFR
- AF
- showdown win
- net
- sample

이 값은 플레이 성향을 설명하지만, 어떤 spot에서 얼마나 손해를 보고 있는지는 알려주지 않는다.

학습 시스템의 핵심 지표는 다음이어야 한다.

```text
EV loss BB / 100 evaluated decisions
```

그리고 이를 position과 spot family별로 분해해야 한다.

예:

- `PREFLOP.RFI.BTN`
- `PREFLOP.BB_DEFENSE_VS_BTN`
- `PREFLOP.VS_THREE_BET`
- `PREFLOP.FOUR_BET`

관련 이슈: [#34](https://github.com/Sungmin-Cho/AI-Holdem/issues/34)

## 3.5 자연어 practice focus만으로는 누적 학습 상태가 부족하다

현재 이전 review의 `다음 게임에서 연습할 것`을 다음 게임의 practice focus로 전달하는 구조는 좋은 출발점이다.

그러나 자연어 파일 하나로는 다음을 관리하기 어렵다.

- skill별 표본 수
- 최근 정확도
- 누적 EV loss
- 개선/악화 추세
- 마지막 복습 시점
- 다음 출제일
- 동일 실수 반복 횟수

따라서 `game/` archive와 분리된 `learning/` 영속 저장소가 필요하다.

관련 이슈:

- [#34](https://github.com/Sungmin-Cho/AI-Holdem/issues/34)
- [#35](https://github.com/Sungmin-Cho/AI-Holdem/issues/35)

## 3.6 persona parameter는 실제 전략 분포를 보장하지 않는다

현재 persona에는 TAG/LAG/Nit/CallingStation/Maniac/Trickster와 다음 전략 힌트가 포함된다.

- bluff frequency
- 3-bet tendency
- tilt tendency

이 값은 LLM prompt에 전달되지만 실제 action distribution을 기계적으로 보장하지 않는다.

따라서 동일 Calling Station을 반복 상대해 exploit을 연습하려 해도 세션마다 전략이 달라질 수 있다.

훈련 상대는 다음처럼 분리해야 한다.

```text
Persona
  - 이름
  - 말투
  - 성격

Strategy policy
  - baseline range
  - action distribution deviation
  - size preference
  - seeded sampler
```

관련 이슈: [#37](https://github.com/Sungmin-Cho/AI-Holdem/issues/37)

## 3.7 현재 UI는 구조화된 피드백을 표현할 수 없다

현재 UI의 코치 항목은 사실상 다음 구조다.

```json
{"handNo": 12, "text": "..."}
```

향후에는 decision 단위로 다음을 보여야 한다.

- 선택 액션
- 권장 액션
- 액션별 frequency
- 액션별 EV
- EV loss
- grade
- 설명
- unsupported/error status

이를 기존 `coach` text에 모두 밀어 넣으면 merge·validation·UI 확장이 어려워진다. 별도 versioned `feedback` payload가 적합하다.

관련 이슈: [#33](https://github.com/Sungmin-Cho/AI-Holdem/issues/33)

## 3.8 외부 분석 도구와 연결할 표준 hand history가 없다

현재 archive JSON은 내부적으로 풍부하지만, 일반적인 포커 분석 도구가 읽는 text hand history는 아니다.

외부 formatter가 engine schema에 직접 결합하지 않도록 중립적인 canonical export model을 두고, 그 위에 PokerStars-style subset exporter를 구현하는 편이 안전하다.

특히 `lastHand.holes`에 있는 상대의 muck card가 export되지 않도록 negative test가 필수다.

관련 이슈: [#42](https://github.com/Sungmin-Cho/AI-Holdem/issues/42)

---

## 4. 목표 아키텍처

```text
┌─────────────────────────────────────────────────────────────┐
│ engine/                                                     │
│  rules + immutable decision snapshots + hand archives       │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ strategy/                                                   │
│  preflop normalizer                                        │
│  versioned strategy provider                               │
│  deterministic EV evaluator                                │
│  opponent policy / exploit evaluator                       │
│  optional postflop solver adapter                          │
└──────────────┬──────────────────────────┬───────────────────┘
               │                          │
               ▼                          ▼
┌─────────────────────────────┐  ┌────────────────────────────┐
│ learning/                   │  │ export/                    │
│  session aggregation        │  │  canonical hand model      │
│  skill profile              │  │  text HH formatter          │
│  mistake bank               │  └────────────────────────────┘
│  spaced repetition          │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────────────┐
│ tools/game-loop.js                                          │
│  orchestration only                                         │
│  evaluate -> persist -> publish -> explain                  │
└──────────────┬──────────────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────────────┐
│ publish.js -> server.js -> browser UI                       │
│  structured feedback relay, no poker strategy logic         │
└─────────────────────────────────────────────────────────────┘
```

### 유지해야 할 기존 경계

- `engine/`은 네트워크와 LLM을 모른다.
- engine state 변경은 `engine/cli.js`를 경유한다.
- LLM CLI는 `tools/player-runtime.js` 밖에서 직접 spawn하지 않는다.
- `server/server.js`는 게임 규칙이나 EV 계산을 하지 않는다.
- 게시 전 durable write, publish idempotency, resume checkpoint를 유지한다.
- 상대 미공개 카드와 persona private fields는 review 전 public payload에 포함하지 않는다.

### 새 계층의 책임

#### `strategy/`

- decision snapshot 검증
- spot normalization
- strategy data lookup
- EV loss 계산
- opponent policy 적용
- solver adapter

#### `learning/`

- session report
- skill profile
- leak ranking
- mistake bank
- scheduling/mastery

#### `export/`

- engine archive를 중립 model로 변환
- 외부 hand history formatter

새 계산 로직을 `tools/game-loop.js`에 직접 넣지 않는다. 이 파일은 이미 lifecycle·복구·게시·worker 관리 책임이 크므로, orchestration만 유지해야 한다.

---

## 5. 핵심 데이터 계약

## 5.1 Training config

```json
{
  "mode": "training",
  "aiCount": 5,
  "startStack": 10000,
  "blinds0": [50, 100],
  "levelEvery": null,
  "sessionHands": 100,
  "stackPolicy": "reset-each-hand"
}
```

## 5.2 Canonical decision snapshot

```json
{
  "schemaVersion": 1,
  "decisionId": "d-12-preflop-3",
  "handNo": 12,
  "actionIndex": 3,
  "playerId": "user",
  "street": "preflop",
  "buttonPlayerId": "p2",
  "position": "BTN",
  "holeCards": ["Ah", "Jd"],
  "board": [],
  "potTotal": 225,
  "currentBet": 200,
  "bets": {},
  "contribs": {},
  "stacks": {},
  "effectiveStack": 10000,
  "folded": [],
  "allIn": [],
  "priorActions": [],
  "legal": {
    "canCheck": false,
    "callAmount": 200,
    "canRaise": true,
    "minRaiseTo": 400,
    "maxRaiseTo": 10000
  },
  "chosen": {"action": "raise", "amount": 500}
}
```

## 5.3 Strategy evaluation

```json
{
  "schemaVersion": 1,
  "decisionId": "d-12-preflop-3",
  "status": "evaluated",
  "spotKey": "NLHE_6MAX_CASH:100:BTN:UNOPENED:AJo",
  "provider": {"id": "local-pack", "version": "2026.1"},
  "actions": {
    "fold": {"frequency": 0.04, "evBb": 0.0},
    "raise:2.5": {"frequency": 0.96, "evBb": 0.28}
  },
  "chosen": "fold",
  "bestAction": "raise:2.5",
  "evLossBb": 0.28,
  "grade": "mistake"
}
```

지원하지 않는 spot은 다음처럼 명시한다.

```json
{
  "decisionId": "...",
  "status": "unsupported_multiway",
  "evLossBb": null,
  "grade": null
}
```

가까운 stack이나 size로 자동 근사하지 않는다.

## 5.4 Structured feedback

```json
{
  "schemaVersion": 1,
  "decisionId": "d-12-preflop-3",
  "handNo": 12,
  "evaluationDigest": "...",
  "evaluation": {},
  "explanation": null
}
```

LLM explanation이 나중에 도착하더라도 `evaluationDigest`와 deterministic fields는 바뀔 수 없어야 한다.

## 5.5 Skill profile

```json
{
  "schemaVersion": 1,
  "totals": {
    "sessions": 12,
    "evaluated": 721,
    "evLossBb": 48.31,
    "evLossBbPer100": 6.70
  },
  "skills": {
    "PREFLOP.BB_DEFENSE_VS_BTN": {
      "sample": 47,
      "accuracy": 0.61,
      "evLossBbPer100": 12.30,
      "mastery": 54,
      "trend": "flat"
    }
  },
  "topLeaks": ["PREFLOP.BB_DEFENSE_VS_BTN"]
}
```

---

## 6. Strategy data와 라이선스 경계

이 저장소는 Apache-2.0이다. 따라서 strategy data 도입 시 코드와 데이터의 라이선스를 분리해서 관리해야 한다.

반드시 지킬 원칙:

- 상용 GTO 서비스의 chart/solution을 scraping하지 않는다.
- 상용 서비스 화면이나 export를 허가 없이 repository에 포함하지 않는다.
- repository에는 schema, loader, evaluator와 합성 테스트 fixture만 포함한다.
- 실제 pack은 사용자가 적법하게 보유한 로컬 파일로 로드할 수 있게 한다.
- 모든 pack에 다음 metadata를 강제한다.
  - source
  - license
  - version
  - game config
  - supported stack
  - supported sizes
- provenance가 없는 pack은 fail-closed한다.

Postflop solver도 동일하다.

- solver binary를 저장소에 복사하지 않는다.
- 로컬 process adapter로 연결한다.
- solver id/version/config digest를 evaluation에 보존한다.
- multiway, 미지원 size, missing range는 명시적 unsupported 상태로 처리한다.

관련 이슈:

- [#32](https://github.com/Sungmin-Cho/AI-Holdem/issues/32)
- [#45](https://github.com/Sungmin-Cho/AI-Holdem/issues/45)

---

## 7. 단계별 구현 로드맵

상위 추적 이슈: [#48](https://github.com/Sungmin-Cho/AI-Holdem/issues/48)

## Phase 0 — 측정 가능한 프리플랍 학습

| 이슈 | 목적 | 핵심 결과 |
|---|---|---|
| [#29](https://github.com/Sungmin-Cho/AI-Holdem/issues/29) | 6-max 100BB training mode | 세션 간 비교 가능한 환경 |
| [#30](https://github.com/Sungmin-Cho/AI-Holdem/issues/30) | canonical decision snapshot | 모든 평가의 재현 가능한 입력 |
| [#32](https://github.com/Sungmin-Cho/AI-Holdem/issues/32) | preflop strategy + EV evaluator | 빈도·EV·EV loss·grade |
| [#33](https://github.com/Sungmin-Cho/AI-Holdem/issues/33) | coach/UI integration | 객관적 피드백 + 선택적 LLM 설명 |

Phase 0 완료 시 사용자 경험:

1. 100BB 고정 세션을 시작한다.
2. 사용자가 프리플랍 액션을 선택한다.
3. 핸드 종료 후 액션별 빈도·EV와 EV loss를 확인한다.
4. LLM이 없어도 grade와 수치 피드백을 받는다.
5. 게임 결과와 별도로 decision score를 확인한다.

## Phase 1 — 개인화와 반복 학습

| 이슈 | 목적 | 핵심 결과 |
|---|---|---|
| [#34](https://github.com/Sungmin-Cho/AI-Holdem/issues/34) | skill profile | 누적 leak과 mastery |
| [#35](https://github.com/Sungmin-Cho/AI-Holdem/issues/35) | mistake drill | 틀린 spot 자동 복습 |
| [#37](https://github.com/Sungmin-Cho/AI-Holdem/issues/37) | deterministic opponent policy | 재현 가능한 훈련 상대 |
| [#42](https://github.com/Sungmin-Cho/AI-Holdem/issues/42) | hand history export | 외부 분석 도구 연계 |

## Phase 2 — Exploit 학습

| 이슈 | 목적 | 핵심 결과 |
|---|---|---|
| [#40](https://github.com/Sungmin-Cho/AI-Holdem/issues/40) | GTO·exploit 이중 평가 | 상대별 최적화와 read 평가 |

## Phase 3 — Postflop 확장

| 이슈 | 목적 | 핵심 결과 |
|---|---|---|
| [#45](https://github.com/Sungmin-Cho/AI-Holdem/issues/45) | local solver adapter | postflop EV와 range grid |

### 의존 관계

```text
#29 training mode ───────────────────────────────┐
                                                │
#30 decision snapshot                           │
  ├─> #32 preflop evaluator ─> #33 feedback ─> #34 profile ─> #35 drill
  ├─> #42 hand history export                   │
  └─> #37 opponent policy ─> #40 exploit ──────┘

#45 postflop solver는 Phase 0 인터페이스 안정화 후 시작
```

권장 병렬화:

1. #29와 #30 병렬
2. #32
3. #33과 #42 병렬
4. #34와 #37 병렬
5. #35와 #40
6. #45

---

## 8. 파일별 영향 지도

| 기존 파일 | 현재 책임 | 주요 변경 방향 |
|---|---|---|
| `engine/hand.js` | 게임·핸드 전이 | mode contract, immutable snapshot 생성 |
| `engine/views.js` | 공개 view·redaction·stats | snapshot redaction, session kind 표시 |
| `engine/cli.js` | 엔진 명령 표면 | training flags, snapshot 조회 |
| `engine/game-archive.js` | init/archive | mode config 전달 |
| `engine/state.js` | 원자 저장 | snapshot/evaluation archive helper 재사용 |
| `engine/personas.js` | persona+전략 힌트 | 표현과 policy reference 분리 |
| `tools/game-loop.js` | 전체 orchestration | evaluator/learning CLI 호출과 checkpoint만 추가 |
| `tools/player-runtime.js` | LLM adapter | explanation 역할은 유지, policy actor와 공통 actor 경계 |
| `tools/coach-control.js` | coach authority | feedback authority를 분리하거나 공통화 |
| `tools/publish.js` | public publish | versioned feedback payload whitelist |
| `server/server.js` | relay/state merge | feedback merge·digest validation |
| `server/public/app.js` | 게임 UI | feedback card, drill, range grid |
| `server/public/index.html` | UI skeleton | 학습/드릴 패널 |
| `server/public/style.css` | UI style | responsive feedback/drill layout |

신규 디렉터리:

```text
strategy/
learning/
export/
```

---

## 9. 검증 전략

기존 프로젝트는 process·lock·retry 통합 테스트가 강하다. 새 기능도 같은 수준으로 검증해야 한다.

## 9.1 Engine tests

- tournament mode 완전 회귀
- training stack reset
- fixed blind
- session hand limit
- 2~8인 position mapping
- fold/check/call/raise/short-all-in snapshot
- resume 후 snapshot 불변

## 9.2 Strategy tests

- pack schema fail-closed
- hand class normalization
- action sequence normalization
- size bucket exact match
- mixed strategy 처리
- EV loss 계산
- unsupported stack/size/multiway
- 동일 입력의 byte-equivalent output

## 9.3 Privacy tests

- redacted snapshot에 상대 hidden card 없음
- feedback에 persona private field 없음
- hand history export에 muck card 없음
- decision 확정 전 strategy result public publish 없음

## 9.4 Lifecycle tests

- evaluation durable write 후 publish
- publish 응답 유실 후 same-id retry
- resume 시 evaluation 중복 생성/게시 없음
- LLM explanation timeout에도 deterministic feedback 유지
- profile 동일 session 중복 반영 방지
- drill 중단·재개 idempotency

## 9.5 UI tests

- desktop/mobile feedback rendering
- structured error/unsupported 표시
- answer 전 정답 비노출
- range grid 169 class mapping
- screen reader label 및 keyboard action

공통 완료 명령:

```bash
node --test
npm run test:ci
```

---

## 10. 주요 위험과 완화책

## 10.1 `game-loop.js` 비대화

위험:

- 이미 lifecycle, recovery, publish, coach, review를 모두 담당한다.
- strategy와 learning 계산을 직접 넣으면 변경 위험과 테스트 비용이 급증한다.

완화:

- 계산은 `strategy/`, `learning/` 순수 모듈로 분리
- 필요하면 JSON CLI child로 경계 유지
- game-loop는 input/output path와 checkpoint만 소유

## 10.2 schema migration

위험:

- 기존 archive에는 새 snapshot이 없다.
- 과거와 새 profile/evaluation을 같은 형식으로 오해할 수 있다.

완화:

- 모든 새 구조에 `schemaVersion`
- legacy v0 명시
- 정보가 부족한 legacy hand는 unsupported로 처리
- migration 실패 시 원본을 덮어쓰지 않음

## 10.3 mixed strategy 오판

위험:

- 낮은 빈도 액션도 EV 차이가 거의 없을 수 있다.
- 빈도가 가장 높은 액션이 아니라고 무조건 오답 처리하면 잘못된 학습이 된다.

완화:

- grade는 EV loss 중심
- frequency는 설명과 calibration용
- EV가 없는 pack은 frequency-only임을 명시

## 10.4 bet size mismatch

위험:

- 실제 사용 size가 pack tree에 없을 수 있다.

완화:

- 자동 nearest-size 보간 금지
- `unsupported_size` 반환
- 추후 명시적 abstraction 정책을 도입할 때 version과 오차를 기록

## 10.5 private information leakage

위험:

- full archive에는 모든 hole card가 존재한다.
- solver/feedback/export 경로에서 상대 hidden card가 섞일 수 있다.

완화:

- full evaluator와 public projection을 분리
- redaction allowlist 사용
- forbidden literal뿐 아니라 nested schema negative test
- export는 showdown reveal만 신뢰

## 10.6 proprietary data contamination

위험:

- 공개 repository에 배포 권한 없는 chart/solver output이 들어갈 수 있다.

완화:

- repository fixture는 합성 데이터만
- pack metadata/provenance 필수
- local pack 경로는 gitignore
- 문서에 금지 행위를 명시

---

## 11. 첫 구현 단위 권장안

처음부터 전체 roadmap을 한 PR로 구현하지 않는다.

첫 번째 구현 cycle은 다음 두 작업을 병렬로 진행하는 것이 적합하다.

### A. Training mode — #29

독립적으로 테스트 가능한 결과:

- `--mode training`
- 6-max
- 100BB reset
- fixed blind
- 100핸드 completed

### B. Decision snapshot — #30

독립적으로 테스트 가능한 결과:

- 모든 사용자/AI action에 versioned snapshot
- full archive + redacted projection
- resume 불변

그다음 #32에서 synthetic test pack만 사용해 evaluator contract를 먼저 완성한다. 실제 strategy data를 준비하기 전에도 다음을 검증할 수 있다.

- spot normalization
- action frequency
- EV loss
- grade
- unsupported 처리

이후 #33에서 UI와 LLM explanation을 연결한다.

---

## 12. 전체 완료 정의

AI-Holdem이 GTO 기반 개인화 학습 시스템으로 전환되었다고 판단하려면 다음을 만족해야 한다.

- 동일한 decision은 언제 평가해도 동일한 결과를 낸다.
- 결과 운과 decision quality가 분리된다.
- LLM이 없어도 객관적 피드백을 받을 수 있다.
- LLM이 EV·frequency·grade를 변경할 수 없다.
- 세션을 넘어 top leak과 mastery가 누적된다.
- 실제 실수가 자동으로 반복 문제로 전환된다.
- GTO와 exploit 평가가 혼동되지 않는다.
- unsupported spot은 자신 있게 모른다고 표시한다.
- 상대 hidden card가 public feedback 또는 export에 유출되지 않는다.
- existing tournament mode, resume, retry, finalization이 회귀하지 않는다.
- strategy data와 solver의 라이선스 경계가 명확하다.

이 구조가 완성되면 프로젝트의 중심 가치는 단순히 "AI와 홀덤을 플레이한다"에서 다음으로 이동한다.

> **나의 결정을 객관적으로 측정하고, 가장 큰 leak을 자동으로 찾아, 틀린 spot을 다시 출제하며, GTO와 exploit을 구분해 가르치는 개인 포커 코치**
