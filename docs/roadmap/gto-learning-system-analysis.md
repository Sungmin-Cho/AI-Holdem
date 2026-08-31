# GTO 기반 개인화 홀덤 학습 시스템 정밀 분석

> 기준 브랜치: `main`  
> 기준 커밋: `443dd9cabc5f46e91af29b0d1002a926ad54298b`  
> 분석일: 2026-08-31  
> 상위 추적 이슈: [#17](https://github.com/Sungmin-Cho/AI-Holdem/issues/17)

## 1. 결론

AI-Holdem은 이미 다음 기반을 갖추고 있다.

- 네트워크와 LLM을 모르는 순수 홀덤 엔진
- 액션·사이드팟·쇼다운·아카이브를 검증하는 테스트
- detached sidecar가 소유하는 게임 생명주기
- LLM 플레이어와 코치의 파일·도구 격리
- 핸드별 코칭과 결과 독립적 종합 리뷰
- publish ID, digest, authority 상태를 이용한 중복 게시 및 재개 안전성
- 이전 리뷰의 연습 항목을 다음 세션에 넘기는 `practiceFocus`

현재 병목은 게임 실행이나 LLM 오케스트레이션이 아니다. **사용자의 각 결정을 객관적으로 평가하는 전략 정답지와, 그 평가를 누적 학습으로 연결하는 구조가 없다.**

따라서 목표 구조는 다음과 같다.

```text
현재
Hand → LLM Coach → 자연어 평가

목표
Hand
  → Canonical Decision Snapshot
  → Versioned Strategy Provider / Solver
  → Machine Decision Evaluation
  → LLM Explanation
  → Skill Profile / Leak Detector
  → Spot Drill / Mistake Bank
  → 다음 게임
```

핵심 원칙은 **LLM이 정답을 만들지 않는 것**이다. 액션 빈도, action EV, EV loss, grade, 지원 범위, source metadata는 deterministic evaluator가 만들고, LLM은 그 결과를 사용자가 이해하기 쉬운 설명으로 바꾸는 역할만 담당한다.

---

## 2. 현재 코드의 실제 구조

### 2.1 엔진 계층

관련 파일:

- `engine/hand.js`
- `engine/views.js`
- `engine/cli.js`
- `engine/state.js`
- `engine/game-archive.js`
- `engine/evaluator.js`
- `engine/sidepots.js`

`engine/hand.js`의 `createGame()`은 현재 다음 설정을 소유한다.

```js
{
  aiCount,
  startStack,
  blinds0,
  levelEvery,
}
```

`startHand()`는 핸드 번호를 기준으로 블라인드 레벨을 올리고, 사용자의 스택이 0이면 새 핸드를 시작하지 않는다. `finishHand()`는 스택이 0인 좌석을 `out`으로 표시하고 사용자가 탈락하거나 모든 AI가 탈락하면 `win|lose`로 게임을 종료한다. 즉, 현재 state machine은 명시적으로 이름 붙이지 않았지만 **토너먼트 모델**이다.

`applyAction()`은 상태를 변경하기 전에 다음 action record를 만든다.

```js
{
  decisionId,
  playerId,
  action,
  amount,
  street,
  potTotal,
  callAmount,
  minRaiseTo,
  maxRaiseTo,
  board,
  stacks,
}
```

이 기록은 학습 시스템의 좋은 출발점이지만 GTO spot을 사후 재현하기에는 다음 정보가 부족하다.

- decision 시점의 position
- actor의 홀카드
- effective stack
- seat별 contribution, folded/all-in/out 상태
- 전체 선행 액션과 street 경계
- game mode와 stack/blind 단위
- 선택 직전 `currentBet`, actor bet, pot geometry

핸드 종료 상태에서 이를 역산하면 uncalled bet 반환, all-in, fold, stack 이동 때문에 정확성을 보장하기 어렵다. 따라서 snapshot은 **액션 적용 전** 생성해야 한다.

`engine/views.js`는 사용자 관점 공개 뷰와 redaction을 책임진다. 현재 position 계산도 이 파일에 포함되어 있고, `statsReport()`가 제공하는 장기 지표는 다음 정도다.

- VPIP
- PFR
- AF
- Showdown Win
- Net
- Sample

이 통계는 플레이 스타일을 보는 데는 유용하지만 `BTN RFI`, `BB vs BTN`, `vs 3-bet`처럼 **기회 분모(opportunity denominator)**가 필요한 학습 진단에는 부족하다.

### 2.2 사이드카와 LLM 경계

관련 파일:

- `tools/game-loop.js`
- `tools/player-runtime.js`
- `tools/player-prompt.md`
- `tools/coach-control.js`

`tools/game-loop.js`는 약 164KB 규모의 핵심 오케스트레이터다. 다음을 한 프로세스에서 소유한다.

- bootstrap과 resume
- 서버 시작·복구·종료
- 사용자 action 대기
- AI action watchdog
- hand archive 검증
- 핸드별 coach pipeline
- finalization
- evaluator와 synthesizer를 통한 종합 리뷰
- 게시 재시도와 종료 checkpoint

이 파일은 이미 생명주기와 장애 복구 책임이 크다. 학습 알고리즘, dataset lookup, profile 집계, drill 생성까지 직접 추가하면 변경 위험과 테스트 비용이 급격히 커진다. 따라서 새로운 학습 기능은 `training/`의 pure module과 별도 CLI/control layer로 분리하고, `game-loop.js`는 **생명주기 연결만** 담당해야 한다.

현재 핸드 코치는 다음 입력을 사용한다.

- redacted hand
- 현재 stats
- `practiceFocus`
- 과폴드 코멘트 사용 가능 여부

출력은 `{handNo, text}` 중심의 짧은 자연어 코칭이다. 이 구조는 비공개 정보 차단과 설명 품질에는 강하지만, 실제 전략 빈도나 EV를 조회하지 않으므로 객관적 정답을 보장하지 않는다.

종합 리뷰는 두 단계로 나뉜다.

1. evaluator: 결과와 상대 archetype을 보지 않고 공개 정보만으로 과정 평가
2. synthesizer: evaluator 출력을 보존하면서 게임 결과와 실제 archetype을 분리 해석

이 **결과와 과정의 분리**는 유지해야 한다. machine evaluation은 evaluator 단계에 추가하고, 결과·상대 policy 공개는 synthesizer 단계에서만 결합하는 것이 맞다.

`tools/coach-control.js`는 `gameEpoch`, owner, generation, queue, seal, digest로 background LLM 결과를 멱등적으로 처리한다. 향후 `training-control`은 이 패턴을 참고하되 coach authority와 학습 authority를 한 파일에 섞지 않는 편이 좋다.

### 2.3 게시·서버·UI

관련 파일:

- `publish-contract.js`
- `tools/publish.js`
- `server/server.js`
- `server/public/index.html`
- `server/public/app.js`
- `server/public/style.css`

현재 서버 snapshot의 주요 공개 상태는 다음 네 종류다.

```js
{
  view,
  log,
  coach,
  review,
}
```

서버는 `publishId`를 단조 증가시키고, 이미 적용된 ID 재전송을 성공으로 처리한다. snapshot을 디스크에 먼저 원자적으로 기록한 뒤 메모리를 갱신하며, coach는 `handNo` 기준으로 deterministic merge한다. 이 구조는 training evaluation에도 그대로 적용할 가치가 있다.

다만 `publish-contract.js`의 body 상한은 65,536 bytes다. preflop summary는 충분히 작지만 postflop 13×13 range matrix, combo별 전략, action EV 전체를 매 SSE payload에 넣으면 상한을 넘기기 쉽다.

권장 방식:

- 공개 summary: 선택, 추천, 빈도, EV loss, grade, source
- detail artifact: range matrix와 combo별 결과
- authenticated detail endpoint: 사용자가 펼칠 때만 조회
- summary에 detail digest 포함

현재 브라우저의 `ui` 상태도 `view/log/coach/review`만 보유한다. 핸드별 coach note UI가 이미 있으므로 Phase 1에서는 여기에 decision review를 결합하거나 별도 `학습` 탭을 추가할 수 있다. 그러나 range visualization은 summary UI와 분리하는 편이 안전하다.

### 2.4 AI 상대 모델

관련 파일:

- `engine/personas.js`
- `tools/player-prompt.md`

현재 archetype은 다음과 같다.

- TAG
- LAG
- Nit
- CallingStation
- Maniac
- Trickster

각 persona에는 `bluffFreq`, `threeBetFreq`, `tiltProne` 등이 있고, LLM 플레이어 prompt에 전달된다. 그러나 `threeBetFreq: 0.30`이라는 문구는 실제 3-bet opportunity의 30%를 선택하도록 기계적으로 보장하지 않는다.

따라서 현재 archetype은 **재미있는 상대 캐릭터**로서는 유효하지만, exploit 학습의 ground truth로는 사용할 수 없다. exploit 단계에서는 다음을 분리해야 한다.

```text
AI Seat
  ├─ Persona: 이름, 말투, 성격, UI 표현
  └─ Strategy Policy: action distribution, deviation, seed, version
```

### 2.5 테스트와 운영 제약

`package.json`은 외부 npm dependency 없이 Node built-in test runner를 사용한다.

```bash
node --test
npm run test:ci
```

현재 테스트는 엔진, archive, CLI, server, publish, player runtime, coach control, game loop까지 넓게 덮는다. 특히 `test/game-loop.test.js`는 매우 크고 process-heavy하다.

새 학습 계층은 다음처럼 테스트 비용을 분리해야 한다.

- pure unit: normalization, EV loss, grade, schedule, profile aggregation
- contract test: provider schema, digest, license metadata
- engine integration: snapshot 생성과 archive
- process integration: training CLI/control/resume
- publish/server: merge, conflict, redaction
- UI: formatter를 pure function으로 분리해 Node에서 검증
- end-to-end: fixed training session의 닫힌 학습 루프

---

## 3. 현재 기능과 목표의 차이

| 영역 | 현재 | 목표 |
|---|---|---|
| 플레이 형식 | 블라인드 상승·탈락 기반 토너먼트 | 기존 모드 유지 + 6-max 100BB fixed cash-training |
| 결정 기록 | action record | 액션 전 canonical decision snapshot |
| 전략 정답 | LLM 판단 | versioned provider/solver 결과 |
| 지원 범위 | 암묵적 | `supported|unsupported` 명시 |
| 평가 | 자연어 코칭 | action frequency, EV, EV loss, deterministic grade |
| LLM 역할 | 평가와 설명을 함께 수행 | machine result 설명만 수행 |
| 통계 | VPIP/PFR/AF/Net | opportunity, coverage, EV Loss/100, skill mastery |
| 다음 학습 | 자연어 `practiceFocus` | structured leak → drill allocation |
| 복습 | 없음 | Mistake Bank + Spaced Repetition |
| 상대 모델 | LLM persona | persona + deterministic policy |
| Exploit | 정성적 추측 | GTO vs exploit 이중 평가 |
| Postflop | LLM 코칭 | provider-neutral solver adapter |
| 외부 분석 | JSON archive | canonical/PokerStars-style HH export |

---

## 4. 설계 원칙

### 4.1 Machine truth, LLM explanation

다음 필드는 machine layer만 생성한다.

- normalized spot key
- action frequency
- action EV
- best EV
- EV loss
- grade
- source ID/version/license/digest
- supported/unsupported reason

LLM은 `evaluationId + explanation`만 반환하게 하고 machine field를 수정하지 못하게 한다.

### 4.2 결정 당시 정보만 사용

평가는 해당 decision 시점에 사용자가 알 수 있었던 정보만 사용한다.

포함 가능:

- 사용자 홀카드
- 공개 board
- 공개 action
- stack, bet, pot, position
- 당시 legal action

포함 금지:

- 이후 showdown에서 공개된 정보를 과거 snapshot에 역주입
- 상대의 비공개 홀카드
- 실제 persona/policy/deviation
- 미래 street 정보

### 4.3 Unsupported는 정상 상태

지원하지 않는 spot을 가장 가까운 chart나 size에 조용히 맞추지 않는다.

예:

- `UNSUPPORTED_PLAYER_COUNT`
- `UNSUPPORTED_STACK`
- `UNSUPPORTED_ANTE`
- `UNSUPPORTED_ACTION_TREE`
- `UNSUPPORTED_SIZE`
- `UNSUPPORTED_MULTIWAY`
- `UNSUPPORTED_POSTFLOP_TREE`

unsupported 결과도 영속화하여 같은 입력을 반복 호출하지 않게 한다.

### 4.4 모든 숫자에 provenance를 남긴다

모든 evaluation은 다음 metadata를 포함한다.

```json
{
  "source": {
    "id": "local-preflop-baseline",
    "version": "1.0.0",
    "license": "...",
    "contentSha256": "..."
  }
}
```

외부 solver는 solver version, config digest, problem digest까지 포함한다.

### 4.5 멱등성

권장 ID:

```text
evaluationId = gameEpoch + decisionId + providerVersion
```

규칙:

- 같은 ID + 같은 digest: no-op
- 같은 ID + 다른 digest: semantic conflict
- resume 뒤 같은 decision 재평가: 중복 집계 없음
- profile event 반영도 evaluationId 기준 정확히 한 번

### 4.6 엔진 순수성 유지

`engine/`은 legal state transition과 canonical game record를 소유한다. dataset I/O, solver process, profile, drill은 `training/`·`tools/`에 둔다.

엔진에 들어갈 수 있는 것은 다음 정도다.

- position 계산 pure function
- action 전 snapshot 생성
- mode state transition
- archive에 필요한 canonical record

### 4.7 게임 진행과 평가를 분리

전략 evaluator나 solver가 현재 hand action loop를 블로킹하면 안 된다.

- 일반 게임: 핸드 종료 후 비동기 평가
- Spot Drill: 별도 실행 경로에서 즉시 평가
- solver timeout/failure: 게임 상태 손상 없음
- finalization: pending evaluation의 durable 상태와 resume 정책 필요

---

## 5. 목표 아키텍처

```text
Browser
  ├─ Game UI
  ├─ Decision Review
  ├─ Skill Profile
  └─ Drill UI
          ▲
          │ authenticated snapshot/SSE/detail
          ▼
server/
  ├─ existing game relay
  ├─ training summary merge
  └─ training detail read endpoint
          ▲
          │ publish envelopes
          ▼
tools/game-loop.js
  ├─ existing game lifecycle
  ├─ completed-hand training trigger
  └─ finalization integration
          │
          ├───────────────┐
          ▼               ▼
tools/training-control.js  tools/profile-cli.js
          │               │
          ▼               ▼
training/
  ├─ contracts
  ├─ decision evaluator
  ├─ preflop spot normalizer
  ├─ strategy providers
  ├─ opportunity classifier
  ├─ profile/leak detector
  ├─ mistake bank
  ├─ drill generator
  ├─ spaced repetition
  ├─ opponent policies
  └─ postflop adapter contracts
          ▲
          │ canonical decision snapshots
          ▼
engine/
  ├─ rules/state transition
  ├─ positions
  ├─ decision snapshot
  └─ hand archive
```

장기 사용자 데이터는 `game/` 밖에 둔다.

```text
.ai-holdem/
  profile-events.jsonl
  profile.json
  mistakes.json
  drill-history.jsonl
```

`game/`은 현재 세션과 archive lifecycle의 소유물이므로 장기 profile 저장소로 사용하면 안 된다.

---

## 6. 핵심 데이터 계약

### 6.1 DecisionSnapshotV1

```json
{
  "schemaVersion": 1,
  "decisionId": "d-17-preflop-3",
  "gameMode": "cash-training",
  "handNo": 17,
  "actorId": "user",
  "street": "preflop",
  "position": "BTN",
  "holeCards": ["Ah", "Jd"],
  "board": [],
  "blinds": [50, 100],
  "potBefore": 150,
  "currentBet": 100,
  "actorBet": 0,
  "toCall": 100,
  "minRaiseTo": 200,
  "maxRaiseTo": 10000,
  "effectiveStack": 10000,
  "publicSeats": [],
  "priorActions": [],
  "chosenAction": {
    "action": "raise",
    "amount": 250
  }
}
```

칩 단위는 정수로 저장하고 evaluator가 BB 단위로 변환한다. raise amount는 현재 엔진과 동일하게 `raise-to`다.

### 6.2 DecisionEvaluationV1

```json
{
  "schemaVersion": 1,
  "evaluationId": "<gameEpoch>:d-17-preflop-3:baseline-v1",
  "decisionId": "d-17-preflop-3",
  "status": "supported",
  "street": "preflop",
  "spotKey": "6max-100bb-btn-rfi-unopened",
  "handClass": "AJo",
  "recommended": [
    {
      "action": "raise",
      "sizeBb": 2.5,
      "frequency": 0.96,
      "evBb": 0.28
    }
  ],
  "chosen": {
    "action": "fold",
    "frequency": 0.04,
    "evBb": 0.0
  },
  "bestEvBb": 0.28,
  "evLossBb": 0.28,
  "grade": "mistake",
  "source": {
    "id": "local-preflop-baseline",
    "version": "1.0.0",
    "license": "...",
    "contentSha256": "..."
  }
}
```

provider에 EV가 없다면 EV 관련 필드는 `null`이어야 하며 빈도에서 가짜 EV를 환산하지 않는다.

### 6.3 SkillProfileV1

```json
{
  "schemaVersion": 1,
  "overall": {
    "evaluatedDecisions": 182,
    "supportedDecisions": 164,
    "unsupportedDecisions": 18,
    "evLossBb": 12.42,
    "evLossBbPer100": 7.57
  },
  "skills": {
    "preflop.bbDefense.vsBTN": {
      "opportunities": 31,
      "supported": 29,
      "evLossBb": 4.9,
      "evLossBbPer100": 16.9,
      "mastery": 51,
      "confidence": 0.69
    }
  },
  "leaks": []
}
```

unsupported decision은 coverage에는 포함하지만 accuracy·EV denominator에는 섞지 않는다.

### 6.4 OpponentPolicyV1

```json
{
  "policyId": "calling-station-v1",
  "version": "1.0.0",
  "base": "baseline-v1",
  "seed": "...",
  "deviations": [
    {
      "selector": {
        "street": "river",
        "facingBet": true
      },
      "operation": "shift",
      "from": "fold",
      "to": "call",
      "probability": 0.2
    }
  ]
}
```

같은 state, policy version, seed, decision ID는 같은 action을 재현해야 한다.

---

## 7. 파일별 변경 지도

### `engine/hand.js`

필요한 변경:

- `mode`별 game-over/top-up 규칙 분리
- 사용자 액션 전 decision snapshot 생성
- `lastHand.decisions` 영속화
- 누적 session net과 cash-training top-up 분리

주의:

- snapshot 생성 이후 기존 betting semantics가 바뀌지 않아야 한다.
- top-up은 hand 종료와 다음 hand 시작 사이에 정확히 한 번 실행한다.
- 기존 tournament 기본 동작은 옵션 미지정 시 동일해야 한다.

### `engine/views.js`

필요한 변경:

- position 계산을 공용 pure module로 이동
- redacted hand에 안전한 user decision snapshot 포함
- mode/hand limit/session net 공개
- 기존 스타일 통계와 training 통계를 섞지 않음

### `engine/cli.js`

필요한 변경:

- `--mode`, `--stack-bb`, `--hands`
- hand output에 `decisions`
- 이후 training CLI와 engine CLI 책임 분리

### `engine/state.js`, `engine/game-archive.js`

필요한 변경:

- 이전 archive schema 호환
- decisions가 없는 legacy hand 허용
- archive iterator/export helper
- mode config 보존과 resume 검증

### `tools/game-loop.js`

필요한 변경:

- 새 bootstrap mode 옵션 전달
- completed hand마다 training pipeline trigger
- machine evaluation을 coach prompt에 read-only evidence로 전달
- finalization에서 training queue completeness 처리
- profile event를 정확히 한 번 반영
- policy player mode 선택

금지:

- spot normalization, EV 계산, leak 공식, schedule 공식을 이 파일에 직접 구현

### `tools/coach-control.js`

직접 확장보다 패턴 재사용을 권장한다. training result는 별도 `tools/training-control.js`가 authority를 소유해야 한다.

### `publish-contract.js`, `tools/publish.js`, `server/server.js`

필요한 변경:

- `training` summary payload schema
- evaluationId/digest 기반 merge와 semantic conflict
- snapshot persistence
- detail artifact endpoint의 인증과 digest 검증
- publish byte 상한 유지

### `server/public/*`

Phase 1:

- 핸드별 decision summary
- chosen/recommended/frequency/EV loss/grade/source
- unsupported reason

Phase 2:

- skill profile와 leak
- drill 화면

Phase 4:

- range matrix detail view

### `engine/personas.js`, `tools/player-prompt.md`

필요한 변경:

- persona 표현과 strategy policy 분리
- LLM mode에서 persona field만 전달
- policy metadata는 게임 종료 전 공개 금지

### 신규 `training/`

권장 하위 구조:

```text
training/
  contracts.js
  cards.js
  preflop-spot.js
  decision-evaluator.js
  public-view.js
  opportunities.js
  profile-store.js
  profile-aggregator.js
  leak-detector.js
  mastery.js
  mistake-bank.js
  drill-generator.js
  drill-evaluator.js
  spaced-repetition.js
  providers/
  policies/
  exploit/
  postflop/
  data/
```

### 신규 `export/`

```text
export/
  contracts.js
  hand-normalizer.js
  pokerstars.js
  manifest.js
```

---

## 8. 이슈와 구현 패키지

| Phase | 이슈 | 핵심 산출물 | 주요 선행 |
|---|---|---|---|
| 0 | [#18](https://github.com/Sungmin-Cho/AI-Holdem/issues/18) | 고정 100BB 6-max cash-training | 없음 |
| 0 | [#19](https://github.com/Sungmin-Cho/AI-Holdem/issues/19) | canonical decision snapshot | 없음, #18 config 반영 |
| 1 | [#20](https://github.com/Sungmin-Cho/AI-Holdem/issues/20) | preflop provider + EV evaluator | #19 |
| 1 | [#21](https://github.com/Sungmin-Cho/AI-Holdem/issues/21) | coach/publish/server/UI 연결 | #19, #20 |
| 2 | [#22](https://github.com/Sungmin-Cho/AI-Holdem/issues/22) | opportunity stats, profile, leak | #19, #20 |
| 2 | [#23](https://github.com/Sungmin-Cho/AI-Holdem/issues/23) | Spot Drill, Mistake Bank, SRS | #20, #22 |
| 3 | [#24](https://github.com/Sungmin-Cho/AI-Holdem/issues/24) | persona/policy 분리 | #18, 선택적으로 #20 |
| 3 | [#25](https://github.com/Sungmin-Cho/AI-Holdem/issues/25) | GTO vs exploit 이중 평가 | #20, #24 |
| 4 | [#26](https://github.com/Sungmin-Cho/AI-Holdem/issues/26) | postflop solver adapter/range UI | #19, #20, #21 |
| 4 | [#27](https://github.com/Sungmin-Cho/AI-Holdem/issues/27) | canonical/PokerStars-style HH export | 독립, metadata는 #19~#21 후 확장 |

의존 그래프:

```text
#18 ───────────────┐
                   ├─> #24 ─> #25
#19 ─> #20 ─> #21 ├─> #26
          └─> #22 ─> #23

#27은 기본 export를 독립 개발 가능하며,
#19/#20/#21 완료 후 training metadata를 추가한다.
```

---

## 9. 권장 구현 순서

### Milestone A — 측정 가능한 Preflop MVP

1. #18 cash-training
2. #19 canonical snapshot
3. #20 preflop provider/evaluator
4. #21 structured feedback

완료 시 사용자 경험:

```text
6-max 100BB fixed session 플레이
→ 핸드 종료
→ 각 preflop 결정의 추천 빈도/EV loss 확인
→ 세션 종료 시 EV Loss / 100 확인
```

이 단계만으로도 현재 자연어 코치와 비교해 실력 향상 측정 가능성이 크게 높아진다.

### Milestone B — 개인화 학습 루프

5. #22 skill profile/leak
6. #23 drill/mistake/SRS

완료 시:

```text
실전 실수
→ leak 우선순위
→ 자동 drill
→ 복습 일정
→ mastery 갱신
→ 다음 세션 focus
```

### Milestone C — Exploit

7. #24 deterministic policy
8. #25 GTO/exploit comparison

이 단계부터 “GTO적으로는 괜찮지만 이 상대에게는 수익을 놓쳤다”를 구분할 수 있다.

### Milestone D — 확장

9. #26 postflop solver adapter
10. #27 external hand-history export

postflop은 tree 정의, 계산 비용, 라이선스, payload 크기가 얽혀 있으므로 preflop MVP보다 먼저 구현하지 않는 것이 좋다.

---

## 10. 테스트 전략

### Pure unit

- 169 starting hand normalization
- position and spot key
- action matching
- EV loss and grade
- opportunity taxonomy
- profile aggregation and rebuild
- leak severity components
- spaced repetition schedule
- deterministic policy RNG
- exploit comparison codes

### Engine integration

- action 전 snapshot
- fold/check/call/raise/short all-in
- heads-up와 3~9인 position
- multiway/all-in seat state
- cash top-up and net
- hand limit completion
- legacy archive compatibility

### Security/redaction

- 상대 비공개 홀카드 없음
- persona/policy metadata 없음
- internal provider path 없음
- postflop detail endpoint token 검증
- export에 session token 없음

### Durability

- evaluation queue crash/resume
- same ID same digest no-op
- same ID different digest conflict
- profile event replay
- server publish retry
- finalization pending evaluation

### Statistical/reproducibility

- same snapshot/provider version → byte-stable evaluation
- same policy state/seed/version → same action
- deviation distribution test
- simulation seed/sample/confidence metadata

### 명령

```bash
node --test test/<target>.test.js
node --test
npm run test:ci
```

process-heavy 테스트는 현재 CI 원칙처럼 파일 단위 직렬 실행을 유지한다.

---

## 11. 주요 위험과 대응

### 11.1 전략 데이터 라이선스

위험:

- proprietary chart 또는 유료 서비스 결과 복제
- 출처 불명 데이터로 정확한 GTO라고 주장

대응:

- dataset README에 출처, 생성법, 라이선스, 지원 tree 기록
- license metadata가 없으면 provider load 실패
- GTO Wizard 결과 scraping/reverse engineering 금지

### 11.2 Solver 라이선스와 배포

위험:

- 강한 copyleft solver를 저장소에 직접 결합
- solver output 재배포 조건 불명확

대응:

- child process adapter
- solver binary/source를 repo에서 분리
- 설치형 runtime과 명시적 license doc
- 실제 채택 전 별도 법적/라이선스 검토

### 11.3 잘못된 spot mapping

위험:

- 90BB를 100BB chart에 자동 매핑
- 2.2BB raise를 2.5BB tree로 조용히 변환
- multiway를 heads-up 해답으로 평가

대응:

- strict normalizer
- 명시적 tolerance
- unsupported code
- mapping fixture를 독립 테스트

### 11.4 Mixed strategy 왜곡

위험:

- 저빈도 합법 선택을 무조건 오답 처리
- frequency-only 결과를 EV 손실처럼 표시

대응:

- chosen frequency와 EV를 함께 표시
- EV가 없으면 `ungraded|mixed|low-frequency` 등 별도 체계
- drill에서도 이분법적 정오답을 피함

### 11.5 Hindsight leakage

위험:

- showdown 카드나 실제 policy를 과거 decision 평가에 사용

대응:

- action 전 snapshot
- provider input whitelist
- forbidden literal/redaction test
- exploit policy는 게임 종료 후 별도 평가에서만 사용

### 11.6 `game-loop.js` 복잡도 증가

위험:

- 기존 장애 복구 경로와 학습 로직 결합

대응:

- `training/` pure module
- `training-control` authority
- sidecar는 trigger/await/publish만 담당
- 각 단계 독립 CLI와 contract test

### 11.7 Payload 크기

위험:

- range matrix가 65,536-byte publish limit 초과

대응:

- summary/detail 분리
- artifact digest
- on-demand authenticated fetch

### 11.8 장기 profile 손상

위험:

- 중복 반영
- provider version 혼합
- aggregate write 실패

대응:

- append-only event 또는 replay 가능한 event map
- evaluationId/digest
- atomic write
- rebuild command
- provider-version segment

---

## 12. 완료 기준

Epic #17은 다음이 모두 충족될 때 완료한다.

- [ ] 기존 tournament mode가 기본값에서 회귀하지 않는다.
- [ ] 6-max 100BB fixed cash-training 세션을 실행할 수 있다.
- [ ] 모든 사용자 action에 action 전 canonical snapshot이 하나씩 남는다.
- [ ] 지원 preflop spot의 빈도와 가능한 경우 EV loss를 기계적으로 계산한다.
- [ ] unsupported spot에 가짜 숫자를 만들지 않는다.
- [ ] LLM failure와 무관하게 machine evaluation이 보존된다.
- [ ] UI에서 선택, 추천, 빈도, EV loss, grade, source를 확인할 수 있다.
- [ ] `EV Loss / 100 supported decisions`를 세션과 skill별로 계산한다.
- [ ] profile이 여러 게임에 걸쳐 유지되고 event에서 rebuild 가능하다.
- [ ] 상위 leak이 drill queue로 연결된다.
- [ ] mistake bank와 spaced repetition이 멱등적으로 동작한다.
- [ ] deterministic opponent policy를 같은 seed로 재현할 수 있다.
- [ ] GTO와 exploit 평가의 근거 수준을 구분한다.
- [ ] postflop solver 실패가 게임 루프를 손상시키지 않는다.
- [ ] hand history export가 비공개 정보를 유출하지 않는다.
- [ ] `node --test`와 `npm run test:ci`가 통과한다.

---

## 13. 제품 KPI 제안

초기에는 승패나 칩 수익보다 다음 학습 지표를 우선한다.

- supported decision coverage
- EV Loss / 100 supported decisions
- skill별 EV Loss / 100
- preferred action rate
- mistake/blunder recurrence
- drill retention after 1/7/30 days
- mastery change
- 동일 leak의 실제 게임 재발률
- opponent read accuracy와 exploit adjustment 적용률

표본이 작을 때는 점수보다 `참고용`, coverage, confidence를 함께 표시한다.

---

## 14. 최종 권고

첫 구현 범위는 #18~#21로 제한한다.

```text
Cash Training
+ Canonical Decision Snapshot
+ Preflop Strategy Provider
+ EV-aware Decision Evaluation
+ Structured UI Feedback
```

이 조합은 가장 작은 범위로 다음 가설을 검증한다.

> “AI-Holdem에서 플레이한 실제 결정이 객관적으로 평가되고, 사용자가 그 피드백을 이해하며 다음 세션에서 개선되는가?”

이 가설이 검증된 뒤 profile/drill, exploit, postflop 순으로 확장하는 것이 개발 위험과 학습 효과의 균형이 가장 좋다.
