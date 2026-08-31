# AI-Holdem GTO 기반 개인화 학습 시스템 분석 및 로드맵

- 분석일: 2026-08-31
- 기준 브랜치: `main`
- 기준 커밋: `443dd9cabc5f46e91af29b0d1002a926ad54298b`
- 대상: 엔진, 사이드카, LLM 런타임, 코치/리뷰, 게시 서버, 브라우저 UI, 테스트와 운영 문서
- 상위 추적 이슈: #17

## 1. 결론

현재 AI-Holdem은 **정확한 홀덤 규칙 엔진 위에서 LLM 페르소나와 대결하고, 핸드별 코칭과 종료 리뷰를 받는 시스템**으로는 이미 강한 기반을 갖고 있다. 특히 다음 설계는 그대로 유지할 가치가 크다.

- `engine/`이 네트워크와 LLM을 모르는 순수 상태 전이 계층이다.
- `tools/game-loop.js`가 detached sidecar로 게임 생명주기를 소유한다.
- LLM 호출은 `tools/player-runtime.js` 한 표면으로 격리된다.
- 사용자 관점 redaction, 상대 홀카드 비공개, tool-less runtime containment가 계약으로 고정돼 있다.
- 코치와 종합 리뷰가 게임 진행과 비동기로 분리되고, 결과를 모르는 evaluator와 결과를 아는 synthesizer가 나뉜다.
- 게시가 `publishId`, exact retry body, authority/proof, atomic snapshot으로 멱등성을 확보한다.
- 이전 리뷰의 연습 포커스를 다음 게임으로 넘기는 최소 학습 루프가 이미 있다.

그러나 **사용자의 홀덤 실력을 검증 가능하게 높이는 시스템**으로 발전하려면 핵심 권한을 다음처럼 바꿔야 한다.

```text
현재
Hand / Stats
  → LLM Coach
  → 자연어 평가

목표
Canonical Decision Snapshot
  → Versioned Strategy Provider / Solver
  → Machine Decision Evaluation
  → EV loss / frequency / source / unsupported reason
  → LLM explanation
  → Skill Profile / Leak Detector / Drill / Review
```

가장 중요한 원칙은 하나다.

> **LLM은 전략 정답과 수치를 생성하지 않는다.**
> 전략 데이터 또는 solver가 만든 기계 평가를 설명하고 개인화하는 역할만 맡는다.

구현 우선순위는 다음 순서가 적절하다.

1. `cash-training` 6-max 100BB 고정 환경
2. 사용자 결정 시점의 canonical snapshot
3. 지원 범위가 좁고 검증 가능한 preflop provider/evaluator
4. 구조화된 평가를 코치·게시·UI·리뷰에 연결
5. 기회 기반 Skill Profile, Leak Detector
6. Spot Drill, Mistake Bank, Spaced Repetition
7. Persona와 deterministic Strategy Policy 분리
8. GTO와 exploit 평가 분리
9. postflop solver adapter와 range view
10. 표준 hand-history export

## 2. 현재 시스템 구조

### 2.1 실행 계층

```text
Browser UI
  ↕ SSE / action / snapshot
server/server.js
  ↑ public publish only
 tools/publish.js
  ↑
tools/game-loop.js  ── lifecycle owner
  ├─ engine/cli.js child
  ├─ server/server.js child
  ├─ tools/coach-control.js child
  └─ tools/player-runtime.js
        └─ Claude / Codex / Grok tool-less CLI child
```

현재 경계의 장점은 명확하다.

- 규칙 엔진의 상태 변경은 `engine/cli.js`와 `withMutation()`을 거친다.
- 서버는 게임 규칙을 모르며 durable UI relay만 담당한다.
- sidecar가 죽거나 재개될 때도 engine state, archive, publish attempt, coach authority를 근거로 복구한다.
- LLM 자식은 저장소와 `game/` 밖의 임시 cwd에서 실행되고, `HOME`과 `PATH`만 상속한다.

새 학습 기능도 이 경계를 깨지 않아야 한다.

### 2.2 게임 상태와 핸드 기록

`engine/hand.js`의 `createGame()`은 현재 다음 설정을 소유한다.

```js
config: {
  aiCount,
  startStack,
  blinds0,
  levelEvery,
}
```

`startHand()`는 핸드 번호에 따라 레벨을 계산하고, `finishHand()`는 다음을 수행한다.

- uncalled chip 반환
- runout과 showdown
- pot/side-pot 분배
- VPIP/PFR/AF 관련 raw counter 갱신
- `lastHand` 생성
- stack 0 좌석 bust 처리
- 사용자 bust 또는 모든 AI 탈락 시 게임 종료

따라서 현재 게임은 본질적으로 **블라인드 상승과 탈락이 있는 토너먼트형 세션**이다. 같은 포지션·스택 깊이의 결정을 반복 측정하기에는 변수가 많다.

`applyAction()`은 상태 변경 전에 다음 정보를 action record에 저장한다.

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

이 기록은 좋은 출발점이지만 GTO spot 재현에 필요한 다음 정보가 부족하거나 여러 위치에서 역산돼야 한다.

- position과 active seat order
- actor hole cards
- effective stack의 명시적 정의와 값
- actor bet/current bet/contribution 구분
- folded/all-in/out 상태를 포함한 공개 seat snapshot
- 전체 prior action tree와 raise-size 단위
- mode, ante/rake, stack depth, provider tree에 필요한 context
- snapshot schema/version

핸드 종료 상태에서 이를 역산하면 uncalled return, bust, stack 이동, 공개 시점 차이 때문에 오류가 생길 수 있다. 따라서 action을 적용하기 직전 snapshot을 만들어야 한다.

### 2.3 공개 view와 redaction

`engine/views.js`는 다음을 제공한다.

- `viewFor(state, playerId)`
- `turnSummary(state, playerId)`
- `redactRecord(record, viewerId)`
- `statsReport(state)`
- position label 계산

현재 사용자 view는 본인 카드, 보드, pot, 공개 seat 상태와 legal action만 포함한다. `redactRecord()`는 사용자 홀카드만 기본적으로 남기고, showdown에서 실제 reveal된 상대 카드만 공개한다. 이 정보 경계는 decision snapshot과 training result에도 동일하게 적용돼야 한다.

position 계산은 현재 `views.js` 안에 있어 UI summary에만 가깝게 사용된다. 앞으로 snapshot, spot normalizer, export, drill이 같은 정의를 사용하려면 별도 순수 모듈로 이동하는 편이 맞다.

### 2.4 현재 통계의 한계

현재 `statsReport()`가 공개하는 지표는 다음과 같다.

- VPIP
- PFR
- AF
- Showdown Win
- Net
- Sample

이 지표는 플레이 스타일을 설명하지만 학습 진단에는 부족하다. 예를 들어 다음을 알 수 없다.

- BTN RFI 기회가 몇 번이었고 올바른 선택을 얼마나 했는가
- BB vs BTN open에서 누적 EV loss가 얼마인가
- 3-bet에 직면한 기회 중 지나치게 fold했는가
- 특정 leak이 표본 부족인지 반복적 손실인지
- provider가 지원하지 않은 결정이 전체의 몇 %인지

학습 통계는 action count가 아니라 **opportunity denominator + machine evaluation**을 기준으로 설계해야 한다.

### 2.5 현재 코칭과 리뷰

`tools/game-loop.js`의 코치 입력은 다음으로 구성된다.

- 해당 핸드의 redacted archive
- 같은 시점에 캡처한 stats
- 이전 리뷰에서 전달된 `practiceFocus`
- 제한적으로 허용되는 overfold 코멘트

코치 프롬프트는 상대 카드·archetype·스타일을 추정하지 말고, 공개 근거만 사용하도록 잘 제한돼 있다. 하지만 전략 provider나 solver를 조회하지 않으므로 다음을 검증할 객관적 근거가 없다.

- 권장 action frequency
- action별 EV
- 사용자의 EV loss
- mixed strategy에서 선택의 허용 범위
- 지원되지 않는 spot 여부

현재 overfold 탐지도 `sample >= 12 && vpip < 0.12`라는 전체 VPIP heuristic이다. position과 opportunity를 구분하지 않으므로 실제 leak taxonomy로 쓰기 어렵다.

종합 리뷰는 더 좋은 구조를 가지고 있다.

1. evaluator: redacted hands + stats만 보고 결과 독립적 과정 평가
2. synthesizer: evaluator output + game result + 실제 players/archetype으로 최종 해석

향후에는 evaluator 입력에 **machine evaluation aggregate**를 추가하고, synthesizer는 결과와 상대 policy를 별도 구획에서 해석해야 한다.

### 2.6 AI 상대 모델의 한계

`engine/personas.js`는 다음 archetype을 생성한다.

- TAG
- LAG
- Nit
- CallingStation
- Maniac
- Trickster

각 persona에는 `bluffFreq`, `threeBetFreq`, `tiltProne`이 있고 `tools/player-prompt.md`로 LLM 플레이어에게 전달된다. 그러나 prompt에 적힌 빈도는 실제 opportunity 기준 행동 분포를 보장하지 않는다.

예를 들어 `threeBetFreq: 0.30`은 다음을 보장하지 않는다.

- 3-bet 기회 중 정확히 30%에 가까운 행동
- 같은 seed/state에서 같은 action 재현
- 특정 spot에서 baseline 대비 deviation의 크기
- crash/resume 뒤 같은 결정 유지

따라서 exploit trainer를 만들려면 다음을 분리해야 한다.

```text
Persona
- 이름
- 말투
- 성격
- UI 표현

Strategy Policy
- policy id/version
- action distribution
- baseline 대비 deviation
- fallback
- deterministic seed
```

### 2.7 게시·서버·UI 계약

현재 공개 상태는 사실상 다음 네 축이다.

```js
{
  view,
  log,
  coach,
  review,
}
```

`tools/publish.js`는 사용자 view만 게시하고, public event만 필터링하며, exact retry body와 `publishId`를 통해 at-most-once처럼 보이는 멱등 동작을 만든다.

`server/server.js`는 다음 특성을 갖는다.

- snapshot atomic write
- publishId 단조 증가
- 이전 publishId 재시도 skip
- coach handNo merge와 proof 검증
- SSE history 재생
- stale decision action 거부

`server/public/app.js`는 현재 다음을 렌더링한다.

- 테이블, 카드, pot, 좌석, action bar
- 이벤트 로그
- 핸드별 자연어 coach note
- 게임 종료 review overlay

구조화된 decision evaluation을 넣으려면 server snapshot과 UI state에 `training` 계열을 추가해야 한다. 다만 postflop range matrix 전체를 publish body에 넣으면 현재 65,536-byte 상한을 넘을 수 있으므로 summary/detail 분리가 필요하다.

### 2.8 테스트와 CI

프로젝트는 외부 npm 의존성 없이 `node --test`를 사용한다. CI는 Node 20.x와 22.x에서 `npm run test:ci`를 실행하며, 파일 단위 concurrency를 1로 제한한다.

현재 테스트는 다음 경계를 폭넓게 고정한다.

- cards/evaluator/sidepots
- hand setup, betting, showdown
- CLI와 archive
- state lock과 pid identity
- server/publish/turn contract
- player runtime containment
- coach authority/fault matrix
- detached game-loop와 finalization/resume
- 운영 문서 계약

학습 기능은 새 모듈의 pure unit test만 추가하는 것으로 끝나지 않는다. 특히 다음 통합 경계를 테스트해야 한다.

- decision snapshot이 action 전 상태를 보존하는가
- archive/redaction에서 비공개 정보가 새지 않는가
- evaluation이 crash/resume 후 중복 반영되지 않는가
- publish retry와 profile aggregation이 같은 평가를 두 번 세지 않는가
- finalization budget과 기존 coach/review gate를 침범하지 않는가

## 3. 핵심 문제 정의

### 문제 A — 게임 결과가 실력 지표가 아니다

짧은 세션 chip net은 분산이 크다. 좋은 결정을 하고도 질 수 있고, 나쁜 결정을 하고도 이길 수 있다. 현재 review가 과정과 결과를 분리하려고 하지만 기계적인 과정 점수가 없다.

해결:

- action별 frequency/EV를 가진 provider 결과
- `EV Loss / 100 supported decisions`
- position/spot별 opportunity와 누적 loss
- unsupported coverage 별도 표기

### 문제 B — LLM 평가에 검증 가능한 정답지가 없다

자연어 코치는 유용하지만 수치와 range를 만들 권한이 없어야 한다.

해결:

- provider/solver source, version, license, digest
- machine evaluation을 immutable evidence로 전달
- LLM 출력은 `evaluationId + explanation`만 허용
- unsupported spot에는 정답 수치를 생성하지 않음

### 문제 C — 현재 세션은 반복 측정 환경이 아니다

블라인드가 상승하고 좌석이 탈락하며 stack depth가 매 핸드 바뀐다.

해결:

- 기본 tournament 동작 유지
- 별도 `cash-training` mode
- 6-max, fixed blind, 100BB top-up, hand limit
- 누적 net과 table stack 분리

### 문제 D — 특정 leak을 반복 교정할 수 없다

현재 `practiceFocus`는 자연어 조언이며 문제 생성/복습 일정과 연결되지 않는다.

해결:

- Skill Profile
- Leak Detector
- Mistake Bank
- Spot Drill
- Spaced Repetition

### 문제 E — exploit의 ground truth가 없다

LLM persona의 성향 파라미터는 실제 policy가 아니다.

해결:

- deterministic Strategy Policy
- explicit deviation
- policy ID/version/seed
- 종료 전 redaction, 종료 후 공개
- GTO evaluation과 exploit evaluation 분리

## 4. 목표 아키텍처

```text
                         ┌──────────────────────┐
                         │ engine/              │
                         │ rules + snapshots    │
                         └──────────┬───────────┘
                                    │ completed hand / decision snapshot
                                    ▼
                         ┌──────────────────────┐
                         │ training/            │
                         │ pure contracts       │
                         │ normalizers          │
                         │ providers/evaluator  │
                         └──────┬────────┬──────┘
                                │        │
                    evaluation │        │ opportunity/profile events
                                ▼        ▼
                   ┌────────────────┐  ┌─────────────────────┐
                   │ tools/         │  │ .ai-holdem/         │
                   │ training ctrl  │  │ profile/mistakes    │
                   │ solver runtime │  │ long-lived local    │
                   └───────┬────────┘  └──────────┬──────────┘
                           │                       │
                           ▼                       ▼
                  coach/review evidence      drill generator
                           │                       │
                           └──────────┬────────────┘
                                      ▼
                           publish/server/browser
```

### 4.1 책임 배치

#### `engine/`

허용:

- game mode와 정확한 규칙 상태 전이
- action 직전 canonical decision snapshot
- position과 public state projection
- archive schema/version

금지:

- 전략 데이터 파일 로드
- solver 실행
- 네트워크/API 호출
- LLM 설명 생성
- 장기 profile 관리

#### `training/`

새로운 순수 학습 계층이다.

- starting hand normalization
- preflop spot normalization
- strategy provider contract
- action matching, EV loss, grade
- opportunity taxonomy
- profile aggregate와 leak scoring pure functions
- drill/spaced repetition pure functions
- postflop problem/result normalization

가능하면 파일 I/O와 child lifecycle은 넣지 않는다.

#### `tools/`

- training CLI/control authority
- provider dataset load
- profile store atomic I/O
- solver child lifecycle
- sidecar integration
- durable pending/retry/resume

`tools/game-loop.js`는 이미 책임이 크므로 학습 세부 로직을 직접 추가하지 않고 별도 control/CLI에 위임한다.

#### `server/`와 UI

- public training summary merge
- evaluation ID/digest conflict 검증
- authenticated detail artifact 조회
- decision review, profile, drill UI

서버가 strategy를 계산하거나 profile을 직접 수정하지 않는다.

## 5. 핵심 데이터 계약

### 5.1 Canonical Decision Snapshot

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

불변식:

- action 적용 직전 state를 나타낸다.
- 사용자 snapshot에는 사용자 hole cards만 있다.
- showdown에서 나중에 공개된 정보가 과거 snapshot에 역으로 들어가지 않는다.
- raise amount는 engine과 동일하게 raise-to다.
- 칩 단위 정수를 저장하고 evaluator가 BB 단위로 바꾼다.
- 기존 archive에 snapshot이 없어도 읽을 수 있다.

### 5.2 Decision Evaluation

```json
{
  "schemaVersion": 1,
  "evaluationId": "<gameEpoch>:<decisionId>:<providerVersion>",
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
    },
    {
      "action": "fold",
      "frequency": 0.04,
      "evBb": 0.0
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
    "license": "declared-license",
    "contentSha256": "..."
  }
}
```

불변식:

- EV가 provider에 없으면 EV 관련 필드는 `null`이다.
- frequency를 EV로 환산하지 않는다.
- 지원 범위 밖은 `unsupported`와 reason code로 남긴다.
- 같은 snapshot/provider version은 같은 결과를 만든다.
- source/version/license/digest가 없는 dataset은 fail-closed한다.

### 5.3 장기 Skill Profile

장기 profile은 `game/`이 아니라 기본적으로 `.ai-holdem/`에 둔다. `game/`은 새 게임 시작 시 archive/vacate되기 때문이다.

핵심 필드:

- processed evaluation ID와 digest
- supported/unsupported coverage
- total EV loss와 EV loss/100
- skill key별 opportunities
- provider/version segment
- mastery와 confidence
- 설명 가능한 leak 구성 요소

멱등성:

- 동일 ID + 동일 digest: no-op
- 동일 ID + 다른 digest: conflict
- event stream으로 aggregate rebuild 가능

### 5.4 Public Summary와 Detail Artifact

일반 publish에는 다음만 포함한다.

- 선택과 추천 action
- frequency와 가능한 경우 EV loss
- grade
- source ID/version
- 짧은 explanation
- detail digest/reference

큰 range matrix와 solver tree는 다음처럼 분리한다.

```text
game/training/details/<evaluation-id>.json
```

브라우저가 필요할 때 authenticated endpoint로 조회하고 summary의 digest와 비교한다.

## 6. GTO 정확성 범위

"GTO"는 하나의 보편적 표가 아니다. 다음 조건에 따라 solution이 달라진다.

- player count
- stack depth
- ante/rake
- open/3-bet/4-bet size tree
- position definition
- postflop bet tree
- multiway 여부

따라서 MVP는 다음으로 제한한다.

- 6-max
- 100BB
- ante/rake 없음
- 합의된 preflop size tree
- local versioned dataset

다음은 조용히 근사하지 않는다.

- 다른 stack depth
- 다른 player count
- multiway branch
- unsupported raise size
- tournament/ICM
- provider에 없는 EV

사용자에게는 unsupported 비율을 숨기지 않는다.

## 7. 단계별 로드맵과 이슈

### Phase 0 — 측정 가능한 기반

#### #18 `cash-training` 100BB 6-max mode

목적:

- 고정 blind/stack 환경
- hand limit 기반 세션
- hand 사이 top-up
- tournament 기본 동작 회귀 없음

주요 파일:

- `engine/hand.js`
- `engine/cli.js`
- `engine/game-archive.js`
- `engine/views.js`
- `tools/game-loop.js`
- 실행 문서와 관련 테스트

#### #19 canonical decision snapshot

목적:

- action 전 상태를 자기완결적으로 보존
- position/effective stack/public seat/prior actions/hole cards 계약
- redaction과 archive compatibility

주요 파일:

- 신규 `engine/positions.js`
- 신규 `engine/decision.js`
- `engine/hand.js`
- `engine/views.js`
- `engine/state.js`
- archive/CLI/hand tests

### Phase 1 — Preflop Ground Truth

#### #20 Preflop provider와 evaluator

목적:

- 169 starting hand normalization
- supported spot canonical key
- frequency/EV-aware 평가
- dataset provenance와 unsupported 처리

주요 신규 영역:

- `training/`
- `training/providers/`
- `training/data/`
- `training/cli.js`

#### #21 코치·게시·UI·리뷰 연결

목적:

- machine evaluation과 LLM explanation 권한 분리
- durable training authority와 evaluationId 멱등성
- 핸드 종료 후 structured feedback
- final review에 aggregate 연결

주의:

- 기존 coach authority와 training authority를 하나로 합치지 않는다.
- `tools/game-loop.js`에 세부 상태기계를 직접 누적하지 않는다.
- 기존 reliability 이슈 #7–#11과 같은 lifecycle 영역을 건드리므로 통합 전 충돌 검토가 필요하다.

### Phase 2 — Adaptive Learning

#### #22 Opportunity Stats, Skill Profile, Leak Detector

목적:

- opportunity denominator
- EV Loss / 100
- position/spot taxonomy
- confidence와 source version segment
- 다음 세션 structured practice focus

#### #23 Spot Drill, Mistake Bank, Spaced Repetition

목적:

- 실전 mistake를 복습 항목으로 저장
- leak/mistake/due/free drill
- mixed strategy를 단순 정오답으로 왜곡하지 않음
- provider version pinned feedback

### Phase 3 — Exploit Training

#### #24 Persona와 deterministic Strategy Policy 분리

목적:

- 캐릭터 표현과 실제 행동 분포 분리
- policy ID/version/seed
- reproducible action sampling
- training mode를 LLM runtime 없이 실행 가능

#### #25 GTO와 exploit 병렬 평가

목적:

- GTO baseline 품질과 상대별 exploit 품질 분리
- exact/simulated/heuristic 근거 수준
- heuristic에 가짜 EV 금지
- opponent note와 실제 read 정확도 평가

### Phase 4 — 확장과 외부 연동

#### #26 Postflop solver adapter와 range/EV view

목적:

- provider-neutral child-process solver adapter
- heads-up supported tree
- timeout/memory/output limit
- range matrix detail artifact
- solver 라이선스/배포 경계

#### #27 Hand History export

목적:

- canonical JSON export
- PokerStars-style play-money text export
- side pot, short all-in, uncalled return, showdown/muck 정확성
- private card/policy/session token 유출 방지

이 이슈는 기본 export만 먼저 병렬 개발할 수 있고, #19–#21이 완료되면 학습 metadata를 확장할 수 있다.

## 8. 의존성

```text
#18 cash-training ───────────────────────────────┐
                                                 │
#19 decision snapshot ──> #20 preflop evaluator ─┼─> #21 UI/coach/review
                              │                  │
                              ├─> #22 profile ──> #23 drill
                              │
                              └─> #24 policy ──> #25 exploit

#19 + #20 + #21 ──> #26 postflop solver

#27 export: 기본 기능은 독립, decision/evaluation 포함은 #19–#21 후속
```

권장 merge 순서:

1. #19
2. #18
3. #20
4. #22의 pure taxonomy/store 기반
5. #21 durable integration
6. #23
7. #24
8. #25
9. #27 기본 export
10. #26

#18과 #19는 병렬 개발할 수 있지만 archive/config 충돌을 줄이려면 작은 PR로 순차 merge하는 편이 안전하다.

## 9. 파일별 영향 분석

| 파일/영역 | 현재 책임 | 학습 시스템 영향 | 권장 방향 |
|---|---|---|---|
| `engine/hand.js` | 규칙 상태 전이, 기록, stats, game over | mode와 decision snapshot이 필요 | snapshot 생성과 mode 규칙만 추가; provider 로직 금지 |
| `engine/views.js` | public view, summary, redaction, stats | position 재사용, decision redaction | position helper 분리; public decision projection 추가 |
| `engine/cli.js` | engine 유일 외부 표면 | mode flags, hand decision output | 옵션/validation 추가; training 계산은 별도 CLI |
| `engine/game-archive.js` | vacate/archive, game init, personas | mode config, player/policy metadata | 공개 persona와 비공개 policy metadata 분리 |
| `engine/state.js` | atomic state/hand I/O와 locks | archive schema compatibility | generic atomic helper 재사용, profile storage 책임은 넣지 않음 |
| `engine/personas.js` | persona+frequency hint 생성 | exploit ground truth 부족 | persona schema와 policy assignment 분리 |
| `tools/player-prompt.md` | LLM player persona/action 계약 | deterministic policy와 역할 중복 | LLM mode는 표현/legacy용으로 명확화 |
| `tools/player-runtime.js` | LLM child containment | solver/policy와 lifecycle 유사 | solver는 별도 runtime; LLM adapter 계약 오염 금지 |
| `tools/game-loop.js` | 전체 lifecycle와 orchestration | 학습 pipeline 연결점 | 별도 training control/CLI 호출만; 내부 로직 최소화 |
| `tools/coach-control.js` | coach authority와 exact publication | training 결과와 유사한 멱등 문제 | authority를 합치지 말고 패턴만 재사용 |
| `publish-contract.js` | byte/digest/proof 공용 계약 | training summary/digest 필요 | schema별 canonicalizer 추가; coach 계약 회귀 금지 |
| `tools/publish.js` | public filter, attempt/retry, publishId | training summary publish | side payload validation 추가; exact retry 보존 |
| `server/server.js` | snapshot/SSE/action relay | training merge/detail endpoint | evaluationId/digest conflict와 token 인증 |
| `server/public/app.js` | table/coach/review UI | structured decision feedback | formatter를 pure module로 분리해 Node test 가능하게 |
| `test/game-loop.test.js` | detached lifecycle 통합 | 직접 확대 시 유지비 급증 | training control fake와 focused integration test로 분산 |
| `.agents/skills/start-game/SKILL.md` | 운영 절차 정본 | 새 mode/profile/review 안내 | 실제 자동화와 문면을 함께 갱신 |

## 10. 주요 리스크와 대응

### 10.1 전략 데이터 라이선스

리스크:

- proprietary chart 또는 유료 서비스 결과를 복제할 수 있다.
- 공개 repository에 재배포할 권리가 없는 dataset일 수 있다.

대응:

- source/version/license/digest 필수
- `training/data/README.md`에서 생성법과 지원 tree 문서화
- GTO Wizard scraping/reverse engineering 금지
- 재배포 불가능한 solver/data는 사용자 설치형 adapter로 분리

### 10.2 EV가 없는 데이터

리스크:

- frequency만 있는 chart로 가짜 EV loss를 만들 수 있다.

대응:

- EV 필드를 nullable로 정의
- frequency-based feedback와 EV-based grade를 별도 체계로 표시
- LLM이 숫자를 보완하지 못하도록 validator 적용

### 10.3 지원 범위 오인

리스크:

- 6-max 100BB chart를 multiway/tournament에 적용할 수 있다.

대응:

- strict spot normalizer
- `UNSUPPORTED_SPOT`, `UNSUPPORTED_SIZE`, `UNSUPPORTED_STACK` 명시
- coverage를 UI/profile에 노출

### 10.4 resume와 중복 집계

리스크:

- hand 재개, publish retry, finalization 재진입에서 profile과 mistake bank가 두 번 증가할 수 있다.

대응:

- `evaluationId` + digest
- durable control queue
- 같은 ID/같은 digest no-op
- 같은 ID/다른 digest fail-closed
- event replay/rebuild test

### 10.5 finalization 시간과 solver 비용

리스크:

- 현재 coach cutoff/review gate에 느린 solver를 묶으면 종료가 불안정해진다.

대응:

- preflop lookup은 빠른 local path
- postflop solve는 durable deferred task
- finalization에서 무한 대기하지 않음
- pending/timeout/unsupported를 정직하게 표시

### 10.6 비공개 정보 누출

리스크:

- decision snapshot, solver problem, export, exploit review에 상대 hole cards나 숨겨진 policy가 섞일 수 있다.

대응:

- user snapshot에 user cards만
- play-time public payload에서 opponent policy 숨김
- post-game 공개 시점 명시
- forbidden literal/redaction 회귀 테스트 확대

### 10.7 `tools/game-loop.js` 비대화

리스크:

- 현재도 lifecycle, runtime, coach, review, recovery가 집중돼 있다.

대응:

- `training-control.js`, `profile-cli.js`, `solver-runtime.js` 등으로 책임 분리
- game loop는 child orchestration과 phase checkpoint만 소유
- 새 상태기계를 기존 coach-control 안에 억지로 합치지 않음

## 11. 테스트 전략

### 11.1 Pure unit tests

- 169 hand-class normalization
- position/seat order
- spot key normalization
- action-size matching
- EV loss/grade
- opportunity taxonomy
- mastery/confidence/leak priority
- spaced repetition
- deterministic policy RNG/deviation
- postflop problem/result normalization

### 11.2 Contract tests

- snapshot schema round-trip
- provider metadata와 digest
- unsupported/error codes
- public training redaction
- summary/detail digest
- profile event idempotency
- export schema와 text semantics

### 11.3 Engine integration

- action 적용 전 snapshot
- fold/check/call/raise/short all-in
- heads-up/3–9인 position
- side-pot 직전 public state
- cash top-up의 정확히 한 번 적용
- tournament 기본 동작 회귀

### 11.4 Lifecycle integration

- sidecar crash → resume → evaluation exactly once
- unresolved publish attempt 후 training body retry
- coach와 training queue ordering
- finalization 중 pending evaluation
- profile write failure와 rebuild
- solver timeout/kill/malformed output

### 11.5 Security/privacy

- 상대 private card literal 미포함
- persona/policy/deviation의 공개 시점
- session token/internal path 미포함
- detail endpoint token 검사
- export symlink/path traversal/overwrite fail-closed

### 11.6 CI

- 현재 Node 20/22 matrix 유지
- 외부 solver 없이 fake deterministic adapter로 전체 CI 통과
- process-heavy integration은 기존 `test:ci` 직렬 정책 유지
- 실제 solver와 실제 LLM은 별도 opt-in smoke test로 분리

## 12. MVP 완료 정의

최소한 다음 닫힌 루프가 증명돼야 한다.

```text
cash-training 6-max 100BB 플레이
  → user decision snapshot
  → supported preflop evaluation
  → hand 종료 후 UI feedback
  → profile aggregate
  → top leak 선택
  → spot drill 생성
  → drill 결과로 mastery 갱신
  → 다음 세션 practice focus 반영
```

정량 완료 조건:

- 100개 이상의 supported user decisions를 중복 없이 집계
- overall 및 skill별 `EV Loss / 100 supported decisions`
- unsupported coverage 표시
- 상위 leak 1–3개 생성
- mistake/due drill queue 생성
- crash/resume/publish retry 뒤 byte-stable 또는 semantic-stable 결과
- 기존 tournament game, coach proof, final review, archive 동작 회귀 없음

## 13. 범위 밖

이 로드맵은 다음을 목표로 하지 않는다.

- 온라인 포커 클라이언트의 실시간 조언/HUD
- 상대의 비공개 정보를 이용한 분석
- 유료 서비스 API reverse engineering
- GTO Wizard 전체 재구현
- multiway postflop full solving
- ICM/MTT payout 모델
- 실제 화폐, 결제, 도박 서비스
- 사람 상대 데이터 자동 수집

## 14. 이슈 인덱스

- [ ] #18 `[GTO-01] 고정 100BB 6-max Cash Training Mode를 추가한다`
- [ ] #19 `[GTO-02] 사용자 결정 시점의 canonical decision snapshot을 영속화한다`
- [ ] #20 `[GTO-03] Preflop baseline provider와 EV-aware decision evaluator를 추가한다`
- [ ] #21 `[GTO-04] 구조화된 GTO 평가를 코치·게시 계약·UI·리뷰에 연결한다`
- [ ] #22 `[GTO-05] 기회 기반 통계, Skill Profile, Leak Detector를 추가한다`
- [ ] #23 `[GTO-06] Spot Drill, Mistake Bank, Spaced Repetition 학습 루프를 추가한다`
- [ ] #24 `[GTO-07] AI Persona와 deterministic Strategy Policy를 분리한다`
- [ ] #25 `[GTO-08] GTO 기준과 상대별 exploit 기준을 함께 평가한다`
- [ ] #26 `[GTO-09] Postflop solver adapter와 range/EV 시각화를 추가한다`
- [ ] #27 `[GTO-10] 표준 Hand History export와 외부 분석기 연동을 추가한다`

## 15. 최종 권고

첫 구현 PR은 #19 canonical decision snapshot이 가장 적절하다.

이유:

- 이후 evaluator/profile/drill/export가 모두 소비하는 공통 계약이다.
- 전략 dataset 라이선스 결정을 기다리지 않고 구현할 수 있다.
- engine action 기록과 redaction의 정확성을 먼저 고정할 수 있다.
- cash-training mode와 병렬 개발이 가능하다.
- 잘못 설계된 snapshot 위에 학습 계층을 쌓는 재작업을 피할 수 있다.

그다음 #18과 #20을 완료해 **재현 가능한 6-max 100BB preflop 학습 MVP**를 만든 뒤, #21–#23으로 닫힌 개인화 학습 루프를 완성하는 순서를 권장한다.
