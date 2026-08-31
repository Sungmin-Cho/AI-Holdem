# AI-Holdem GTO 기반 개인화 학습 시스템 분석 및 로드맵

- 분석일: 2026-08-31
- 기준 브랜치: `main`
- 기준 커밋: `443dd9cabc5f46e91af29b0d1002a926ad54298b`
- 상위 이슈: #17

## 1. 결론

AI-Holdem은 이미 다음 기반을 갖춘 완성도 높은 **AI 홀덤 플레이 시스템**이다.

- 네트워크와 LLM을 모르는 순수 규칙 엔진
- detached sidecar가 소유하는 게임 생명주기
- 사용자 관점 redaction과 private-card containment
- LLM player session 유지, watchdog, runtime fallback
- 핸드별 비동기 코칭
- 결과를 모르는 evaluator와 결과·persona를 나중에 결합하는 종합 리뷰
- crash/resume, archive repair, publication idempotence, process identity 검증

현재 실력 향상 기능의 병목은 플레이 경험이나 LLM 품질이 아니라 **전략 평가의 기계적 정답지와 장기 학습 상태가 없다는 점**이다. 현재 코치는 공개된 핸드 기록과 기본 통계를 읽고 자연어로 판단하지만, 추천 액션 빈도·action EV·EV loss의 출처가 되는 strategy provider 또는 solver가 없다.

따라서 다음 구조로 확장하는 것이 가장 안전하다.

```text
현재
Hand → LLM Coach → 자연어 평가

목표
Hand
  → Canonical Decision Snapshot
  → Strategy Provider / Solver
  → Machine Decision Evaluation
  → LLM Explanation
  → Skill Profile / Leak Detector
  → Spot Drill / Mistake Review
  → 다음 게임
```

핵심 원칙은 **LLM이 정답을 생성하지 않는 것**이다. LLM은 출처·버전·라이선스가 명확한 machine evaluation을 설명하는 역할만 맡는다.

---

## 2. 현재 코드 구조 분석

### 2.1 엔진 계층

주요 파일:

- `engine/hand.js`
- `engine/views.js`
- `engine/cli.js`
- `engine/state.js`
- `engine/game-archive.js`
- `engine/personas.js`

`engine/hand.js`는 게임 생성, 블라인드 상승, 핸드 시작, legal action, action 적용, street 전이, showdown, pot 분배, 탈락과 게임 종료를 소유한다. 현재 `createGame()`의 핵심 설정은 다음과 같다.

```text
aiCount
startStack
blinds0
levelEvery
```

기본 블라인드는 25/50이고, `levelEvery` 기본값은 8이다. 핸드 번호에 따라 블라인드가 상승하며 stack이 0인 좌석은 `out` 처리된다. 사용자가 bust되거나 모든 AI가 bust되면 게임이 종료된다. 즉 현재 엔진은 명확한 토너먼트 모델이다.

`applyAction()`은 각 액션에 다음 정보를 저장한다.

```text
decisionId
playerId
action
amount
street
potTotal
callAmount
minRaiseTo
maxRaiseTo
board
stacks
```

이 기록은 강한 출발점이지만 GTO spot을 재현하기에는 부족하다. 특히 position, actor hole cards, effective stack, contribution, fold/all-in 상태, 전체 선행 액션과 게임 mode가 결정 시점 snapshot으로 고정되어 있지 않다. 핸드가 끝난 뒤 final state에서 역산하면 uncalled return, fold, all-in, street reset 때문에 오차가 생길 수 있다.

`engine/views.js`는 다음 책임을 갖는다.

- 사용자/AI별 공개 view
- position label 계산
- AI turn summary
- hand record redaction
- 기본 통계

현재 통계는 VPIP, PFR, AF, showdown win, net, sample이다. 플레이 스타일 요약에는 유용하지만, `BTN RFI 기회`, `BB vs BTN open 방어`, `vs 3-bet` 같은 opportunity denominator와 decision quality를 알 수 없다.

`engine/game-archive.js`는 새 게임 시작 시 `game/`의 기존 runtime 산출물을 archive로 이동한다. 따라서 여러 세션에 걸친 skill profile과 mistake bank를 `game/` 안에 두면 새 게임마다 archive된다. 장기 데이터는 별도 로컬 디렉터리로 분리해야 한다.

### 2.2 sidecar와 LLM 계층

주요 파일:

- `tools/game-loop.js`
- `tools/player-runtime.js`
- `tools/player-prompt.md`
- `tools/coach-control.js`
- `tools/publish.js`

`tools/game-loop.js`는 bootstrap부터 playing, finalizing, review, done까지 전체 lifecycle을 소유한다. AI action은 LLM player adapter를 통해 수행하며, 사용자 action은 relay에서 받아 engine CLI에 적용한다.

현재 핸드 코치 입력은 다음 세 가지다.

1. 사용자 관점으로 redacted된 hand record
2. 기본 stats
3. 이전 review에서 전달된 `practiceFocus`

코치 프롬프트는 사용자의 주요 결정 1~2개를 1~2줄로 평가하도록 요구하고, 상대 range나 숫자를 지어내지 말라고 제한한다. 이 제한은 좋지만, 반대로 말하면 코치에게 실제 GTO frequency 또는 action EV가 제공되지 않는다.

종합 리뷰는 두 단계다.

1. evaluator: 실제 결과와 상대 archetype을 모른 채 redacted hand와 stats로 과정 평가
2. synthesizer: evaluator 결과에 게임 결과와 실제 AI archetype을 나중에 결합

결과 편향을 줄이는 구조는 유지해야 한다. 향후 machine evaluation은 1단계 evaluator의 근거로 들어가고, 실제 opponent policy와 exploit 해석은 2단계에서 별도 구획으로 결합하는 것이 맞다.

`tools/player-runtime.js`는 LLM CLI를 부르는 유일한 표면이며, cwd/env/tool containment와 process lifecycle을 강하게 검증한다. strategy provider 또는 solver는 이 파일에 억지로 합치지 말고 별도 runtime/adapter로 분리해야 한다.

### 2.3 AI persona

`engine/personas.js`는 다음 archetype을 생성한다.

```text
TAG
LAG
Nit
CallingStation
Maniac
Trickster
```

각 profile에는 `bluffFreq`, `threeBetFreq`, `tiltProne` 등이 있고, `tools/player-prompt.md`를 통해 LLM에게 전달된다.

문제는 이 숫자가 실제 opportunity별 행동 확률을 보장하지 않는다는 점이다. `threeBetFreq: 0.30`이라는 prompt가 장기적으로 30% 3-bet을 의미하지는 않는다. exploit trainer를 만들려면 캐릭터 표현인 Persona와 실제 행동 분포인 Strategy Policy를 분리해야 한다.

### 2.4 게시와 UI

주요 파일:

- `publish-contract.js`
- `tools/publish.js`
- `server/server.js`
- `server/public/index.html`
- `server/public/app.js`
- `server/public/style.css`

현재 공개 상태는 대체로 다음 구조다.

```text
view
log/events/messages
coach
review
```

서버 snapshot도 `view`, `log`, `coach`, `review`, `publishId`, `history`를 저장한다. coach note는 hand number와 text 중심이며, UI는 이벤트 로그/코치 탭과 최종 review overlay를 제공한다.

구조화된 decision evaluation을 추가하려면 `training` payload 계약과 merge/idempotence 규칙이 필요하다. 모든 range matrix를 SSE body에 넣으면 현재 65,536-byte publish 상한을 넘을 수 있으므로 summary와 detail artifact를 분리해야 한다.

### 2.5 테스트와 운영 안정성

현재 테스트는 engine 단위 테스트뿐 아니라 process, lock, publication, resume, coach fault matrix까지 폭넓게 다룬다. 특히 `tools/game-loop.js`와 관련 테스트는 이미 매우 큰 lifecycle state machine이다.

따라서 새 학습 기능은 다음 방식으로 격리해야 한다.

- pure transformation은 `training/`
- child process 경계는 `training/cli.js`, `tools/solver-runtime.js` 등
- durable queue/profile은 전용 control/store
- `tools/game-loop.js`는 호출과 lifecycle 조정만 담당
- engine은 canonical fact를 기록하고 전략 판단은 하지 않음

---

## 3. 핵심 격차

### 3.1 비교 가능한 학습 환경 부재

토너먼트에서는 stack depth, player count, blind level이 계속 바뀐다. 장기 정확도와 EV loss를 비교하려면 고정된 6-max 100BB cash-training preset이 필요하다.

해결: #18

### 3.2 decision-time ground truth 입력 부재

현재 action record는 많은 정보를 담지만 결정 당시 전체 public state를 자기완결적으로 재현하지 못한다.

해결: #19

### 3.3 전략 provider와 EV evaluator 부재

현재 코치 판단은 LLM 자연어 reasoning이며 action frequency/EV source가 없다.

해결: #20

### 3.4 machine evaluation을 공개하는 durable 계약 부재

현재 coach/review 계약만 있어 structured evaluation을 안전하게 게시·resume·merge할 수 없다.

해결: #21

### 3.5 장기 skill state 부재

기본 stats는 스타일 통계이며 opportunity, coverage, EV loss, mastery, confidence를 저장하지 않는다.

해결: #22

### 3.6 반복 학습 루프 부재

자연어 `practiceFocus`는 있지만 mistake bank, drill queue, spaced repetition이 없다.

해결: #23

### 3.7 상대 전략의 ground truth 부재

LLM persona prompt는 실제 행동 분포를 보장하지 않아 상대별 exploit 평가가 불가능하다.

해결: #24, #25

### 3.8 postflop 전략 계산과 range UI 부재

postflop은 정적 chart로 해결할 수 없으며 solver tree, range, EV가 필요하다.

해결: #26

### 3.9 외부 학습 도구 연결 부재

완료 hand는 JSON archive로 남지만 표준 hand history export가 없다.

해결: #27

---

## 4. 목표 아키텍처

```text
┌──────────────────────────── Engine ────────────────────────────┐
│ legal state transition                                        │
│ canonical hand/action/decision facts                          │
│ private/public information boundary                           │
└───────────────────────┬────────────────────────────────────────┘
                        │ completed hand / decision snapshot
                        ▼
┌────────────────────── Training ────────────────────────────────┐
│ spot normalizer                                                │
│ strategy provider interface                                    │
│ preflop JSON provider / postflop solver adapter                │
│ decision evaluator                                             │
│ opportunity classifier / profile / leak detector               │
│ mistake bank / drill / spaced repetition                       │
│ exploit evaluator                                              │
└───────────────┬──────────────────────┬──────────────────────────┘
                │ machine evidence     │ persistent local profile
                ▼                      ▼
┌──────────────────────── Tools/Sidecar ─────────────────────────┐
│ durable training-control queue                                 │
│ coach explanation generation                                  │
│ lifecycle, resume, publication                                 │
└───────────────────────┬────────────────────────────────────────┘
                        │ public summary + detail digest
                        ▼
┌────────────────────── Server/UI ───────────────────────────────┐
│ training summary merge                                        │
│ authenticated detail endpoint                                 │
│ decision review / range view / skill profile / drill           │
└────────────────────────────────────────────────────────────────┘
```

### 4.1 소유권 원칙

#### Engine이 소유할 것

- 실제 게임 상태와 legal action
- 액션 적용 전 canonical decision snapshot
- 완료 hand archive
- redaction에 필요한 공개 사실

#### Training이 소유할 것

- spot normalization
- baseline/solver provider
- frequency/EV/grade 계산
- opportunity taxonomy
- skill profile와 leak
- drill과 mistake review

#### LLM이 소유할 것

- machine result를 한국어로 설명
- 실제 숫자를 수정하지 않는 코칭 문장
- 결과와 과정이 분리된 narrative synthesis

#### Server/UI가 소유할 것

- 공개 가능한 summary 저장과 전달
- 상세 range artifact의 인증된 조회
- 사용자의 decision review 경험

---

## 5. 핵심 데이터 계약

### 5.1 DecisionSnapshot

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
  "chosenAction": { "action": "raise", "amount": 250 }
}
```

정보 경계:

- actor가 user라면 user hole cards만 포함
- 상대 private cards/persona/policy 제외
- 이후 showdown 정보를 과거 snapshot에 역으로 추가하지 않음

### 5.2 DecisionEvaluation

```json
{
  "schemaVersion": 1,
  "evaluationId": "<gameEpoch>:<decisionId>:<provider-version>",
  "decisionId": "d-17-preflop-3",
  "status": "supported",
  "spotKey": "6max-100bb-btn-rfi-unopened",
  "handClass": "AJo",
  "recommended": [],
  "chosen": {},
  "bestEvBb": 0.28,
  "evLossBb": 0.28,
  "grade": "mistake",
  "source": {
    "id": "local-preflop-baseline",
    "version": "1.0.0",
    "license": "declared",
    "contentSha256": "..."
  }
}
```

정확성 규칙:

- provider에 EV가 없으면 EV 필드는 `null`
- frequency를 EV로 변환하지 않음
- unsupported spot은 명시적 reason code
- source/version/license/digest 필수

### 5.3 SkillProfile

장기 데이터는 `.ai-holdem/`에 두고 `game/` archive lifecycle과 분리한다.

멱등 키는 `evaluationId`, conflict 판정은 payload digest로 한다.

### 5.4 공개 TrainingSummary

SSE에는 작은 summary만 보낸다.

- chosen/recommended action
- frequency
- EV loss/grade, 존재할 때만
- source ID/version
- explanation
- detail digest/endpoint reference

13×13 matrix와 combo range는 인증된 detail endpoint에서 요청 시 조회한다.

---

## 6. 전략 데이터와 라이선스

이 로드맵에서 가장 큰 비코드 의존성은 preflop baseline dataset이다.

필수 조건:

1. 데이터 출처가 명시되어야 한다.
2. repo와 사용자 용도에 맞는 라이선스여야 한다.
3. 지원 player count, stack, ante, rake, raise-size tree가 문서화되어야 한다.
4. action frequency만 있는지 action EV도 있는지 구분해야 한다.
5. content digest와 version으로 평가 재현성이 있어야 한다.

금지:

- proprietary chart 복제
- GTO Wizard 화면/결과 scraping
- 유료 서비스 비공식 API reverse engineering
- LLM이 누락된 range/EV를 생성

합법적인 실제 dataset이 확정되기 전에는 작은 synthetic fixture로 provider 계약과 테스트를 먼저 구현할 수 있다. synthetic fixture 결과는 사용자에게 실제 GTO 데이터로 표시해서는 안 된다.

---

## 7. 단계별 로드맵과 GitHub 이슈

### Phase 0 — 학습 가능한 상태 만들기

- #18 `[GTO-01] 고정 100BB 6-max Cash Training Mode를 추가한다`
- #19 `[GTO-02] 사용자 결정 시점의 canonical decision snapshot을 영속화한다`

Phase 0 완료 조건:

- 동일한 100BB 환경에서 반복 플레이 가능
- 모든 사용자 decision을 사후 재현 가능
- 기존 tournament mode와 redaction 회귀 없음

### Phase 1 — Preflop GTO MVP

- #20 `[GTO-03] Preflop baseline provider와 EV-aware decision evaluator를 추가한다`
- #21 `[GTO-04] 구조화된 GTO 평가를 코치·게시 계약·UI·리뷰에 연결한다`

Phase 1 완료 조건:

- 지원 preflop spot에서 machine evaluation 생성
- 핸드 종료 후 UI에 recommended action/frequency/EV loss 표시
- unsupported와 missing EV를 정직하게 표시
- LLM failure와 무관하게 machine result 유지

### Phase 2 — 개인화 학습

- #22 `[GTO-05] 기회 기반 통계, Skill Profile, Leak Detector를 추가한다`
- #23 `[GTO-06] Spot Drill, Mistake Bank, Spaced Repetition 학습 루프를 추가한다`

Phase 2 완료 조건:

- 여러 세션에 걸친 skill profile
- 상위 leak과 confidence
- leak 기반 drill queue
- 실제 mistake의 반복 복습

### Phase 3 — Exploit 학습

- #24 `[GTO-07] AI Persona와 deterministic Strategy Policy를 분리한다`
- #25 `[GTO-08] GTO 기준과 상대별 exploit 기준을 함께 평가한다`

Phase 3 완료 조건:

- 상대의 실제 deviation이 재현 가능
- GTO 품질과 상대별 exploit 품질을 분리 평가
- game 중 정책 정보 비공개, 종료 후 공개
- exact/simulated/heuristic 근거 수준 표시

### Phase 4 — Postflop 및 외부 연결

- #26 `[GTO-09] Postflop solver adapter와 range/EV 시각화를 추가한다`
- #27 `[GTO-10] 표준 Hand History export와 외부 분석기 연동을 추가한다`

Phase 4 완료 조건:

- 지원 heads-up postflop tree에서 solver-backed 평가
- range matrix detail UI
- 표준 hand history export와 privacy 검증

---

## 8. 의존성 그래프

```text
#18 Cash Training ──────────────┐
                               ├── 통합 학습 환경
#19 Decision Snapshot ──┬──────┘
                        ├── #20 Preflop Evaluator ──┬── #21 UI/Coach
                        │                            ├── #22 Profile ── #23 Drill
                        │                            └── #26 Postflop Solver
                        └── #27 HH Export

#18 + #20 ── #24 Deterministic Policy ── #25 Exploit Evaluation
#26 ──────────────────────────────────────┘ exact postflop 확장
```

권장 구현 순서:

```text
#19 → #18 → #20 → #21 → #22 → #23 → #24 → #25 → #27 → #26
```

이유:

- #19는 모든 평가 기능의 데이터 기반이다.
- #18은 통합 측정 환경이지만 #19와 병렬 개발 가능하다.
- #20/#21이 첫 사용자 가치인 preflop 피드백을 만든다.
- #22/#23이 개인화 학습의 닫힌 루프를 완성한다.
- #26은 비용·라이선스·범위가 가장 커서 마지막이 안전하다.
- #27은 비교적 독립적이라 필요에 따라 앞당길 수 있다.

---

## 9. 파일 영향 지도

| 영역 | 현재 파일 | 권장 변화 |
|---|---|---|
| 게임 모드 | `engine/hand.js`, `engine/cli.js`, `engine/game-archive.js` | tournament/cash-training 규칙 분리 |
| 결정 기록 | `engine/hand.js`, `engine/views.js` | `engine/decision.js`, `engine/positions.js` 추가 |
| Preflop 평가 | 없음 | `training/preflop-spot.js`, provider, evaluator, CLI |
| 학습 publication | coach/review 전용 | `tools/training-control.js`, training publish contract |
| 장기 profile | 없음 | `.ai-holdem/`, profile store/aggregator/leak detector |
| Drill | 없음 | drill generator/evaluator/UI/server 또는 route module |
| AI 전략 | `engine/personas.js`, LLM prompt | persona/policy schema 분리, deterministic policy adapter |
| Exploit | 없음 | policy model, comparative evaluator, opponent notes |
| Postflop | 없음 | problem builder, solver runtime, range view |
| Export | hand JSON archive | export-neutral normalizer와 text renderer |
| UI | log/coach/review | decision review, profile, drill, range detail |

### `tools/game-loop.js` 비대화 방지

새 기능을 모두 sidecar 파일에 직접 넣으면 lifecycle과 학습 로직이 결합된다. 다음 함수 수준의 adapter만 sidecar에 남기는 것이 좋다.

```text
launchTrainingForHand(handNo)
drainTrainingPublications()
applyEvaluationsToProfile()
loadPracticeFocus()
```

spot normalization, evaluation, profile 계산, scheduling은 별도 모듈/CLI가 담당한다.

---

## 10. 테스트 전략

### 10.1 Pure unit tests

- position/hand-class/spot key normalization
- EV loss와 grade
- unsupported reason
- opportunity taxonomy
- profile aggregation
- leak severity 구성 요소
- spaced repetition schedule
- deterministic policy sampling
- export rendering

### 10.2 Contract tests

- snapshot schema
- provider schema/license/digest
- evaluation schema
- public redaction
- publish body size
- same ID/same digest no-op
- same ID/different digest fail-closed

### 10.3 Lifecycle integration tests

- hand completion → evaluation → coach → publish
- crash before/after evaluation write
- crash before/after publish acknowledgement
- resume에서 duplicate evaluation/profile increment 없음
- finalization 중 pending training task 처리
- provider/solver timeout에도 game lifecycle 보존

### 10.4 Security/privacy tests

- 상대 private hole-card forbidden literal
- persona/policy metadata pre-game 공개 금지
- internal dataset/solver path 공개 금지
- sessionToken export 금지
- authenticated detail endpoint

### 10.5 Statistical/reproducibility tests

- deterministic seed로 동일 action
- 여러 independent decision key에서 target deviation 오차 범위
- simulated exploit 결과의 seed/sample metadata
- provider/version 변경 시 profile 혼합 방지

---

## 11. 성공 지표

기술 지표:

- evaluation coverage: supported / total user decisions
- duplicate evaluation/profile event: 0
- private information leak: 0
- unsupported spot에서 fabricated numeric result: 0
- 기존 lifecycle/engine 테스트 회귀: 0

학습 지표:

- supported decisions 기준 EV Loss / 100
- skill별 opportunity와 mastery
- 상위 leak의 누적 EV impact와 confidence
- drill 후 동일 skill의 최근 EV loss 변화
- mistake recurrence/lapse 감소

사용자에게는 session result와 learning result를 분리해서 보여 줘야 한다.

```text
게임 결과: +38BB
의사결정 품질: EV Loss 6.2BB / 100
가장 큰 leak: BB vs BTN open
```

좋은 결과가 나쁜 decision을 가리거나, 나쁜 결과가 좋은 decision을 비난하지 않게 한다.

---

## 12. 주요 위험과 완화

### 전략 데이터 라이선스

위험: 합법적으로 배포할 수 있는 preflop frequency/EV 데이터가 없을 수 있다.

완화:

- provider interface부터 구현
- source/license 필수
- synthetic fixture를 실제 GTO로 표시하지 않음
- local user-supplied licensed dataset 지원

### false precision

위험: frequency-only 또는 heuristic 결과를 정확한 EV처럼 표시할 수 있다.

완화:

- nullable EV
- `exact/simulated/heuristic` 근거 수준
- LLM의 numeric field 수정 금지

### sidecar 복잡도 증가

위험: training lifecycle이 기존 finalization/publication 안정성을 깨뜨린다.

완화:

- 전용 control/queue
- 작은 sidecar adapter
- finalization gate와 profile failure policy를 명시
- fault-matrix 테스트 확장

### publish body 증가

위험: range matrix가 body byte 상한을 초과한다.

완화:

- summary/detail 분리
- authenticated detail endpoint
- digest 검증

### profile corruption/duplication

위험: crash/resume에서 같은 decision이 여러 번 반영된다.

완화:

- `evaluationId + digest`
- append-only event 또는 rebuild 가능한 event map
- atomic write

### deterministic policy의 인위성

위험: 재현성을 얻는 대신 실제 사람 같은 전략이 약해질 수 있다.

완화:

- training policy와 entertainment LLM mode 분리
- policy deviation을 명시적으로 측정
- persona 표현은 유지

---

## 13. 첫 구현 슬라이스 권장안

가장 작은 end-to-end vertical slice는 다음과 같다.

1. #19에서 unopened preflop user decision snapshot만 기록
2. #18에서 6-max 100BB fixed training session 생성
3. #20에서 BTN RFI 한 spot과 synthetic/test provider 지원
4. #21에서 핸드 종료 후 structured evaluation 한 건을 UI에 표시

이 슬라이스의 성공 화면:

```text
핸드 7 · BTN · AJo
내 선택: Fold
추천: Raise 96%
EV 데이터 없음 · Low-frequency action
Source: test-provider 0.1
```

실제 라이선스가 확인된 EV dataset을 연결한 뒤에만 다음처럼 표시한다.

```text
Mistake · EV Loss 0.28BB
```

그 다음 #22/#23으로 확장하면 `play → measure → diagnose → drill → retest`의 첫 완전한 학습 루프가 된다.

---

## 14. 범위 밖 및 윤리적 경계

이 로드맵은 사용자가 AI-Holdem 내부 또는 사후 hand history로 공부하는 기능을 위한 것이다.

포함하지 않는다.

- 실제 온라인 포커 게임 중 실시간 solver 조언
- 다른 client의 화면/메모리/네트워크에서 hand를 자동 수집하는 기능
- 상대 HUD 데이터 무단 수집
- collusion 또는 부정행위 지원
- 실제 화폐 결제·베팅 기능

모든 machine feedback은 AI-Holdem 내부 훈련 또는 사후 review를 기준으로 설계한다.

---

## 15. 추적 이슈

- #17 Epic
- #18 Cash Training Mode
- #19 Canonical Decision Snapshot
- #20 Preflop Provider/Evaluator
- #21 Structured Evaluation UI/Coach/Publication
- #22 Skill Profile/Leak Detector
- #23 Spot Drill/Mistake Bank/Spaced Repetition
- #24 Persona/Strategy Policy Separation
- #25 GTO vs Exploit Evaluation
- #26 Postflop Solver/Range UI
- #27 Hand History Export
