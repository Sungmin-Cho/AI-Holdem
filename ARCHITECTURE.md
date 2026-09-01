# AI 홀덤 — 아키텍처

## 1. 개요

AI 홀덤은 브라우저 UI를 통해 사용자가 LLM 페르소나 다수를 상대로 노리밋 텍사스 홀덤을 두는 시스템이다. 시스템은 서로 아는 것이 다른 세 계층으로 갈라져 있다 — 네트워크와 LLM을 전혀 모르는 순수 규칙 엔진(`engine/`), 게임 진행 전체를 소유하고 LLM 자식 프로세스를 부리는 detached 사이드카(`tools/game-loop.js`), 상태를 갖지 않고 중계만 하는 HTTP 서버(`server/`)다. LLM 호출은 오직 `tools/player-runtime.js` 한 표면에서만 일어나며, 사용자가 여는 딜러 세션(Claude Code·Codex·Grok)은 사전 점검과 사이드카 기동, 결과 보고만 담당하고 핸드 안 진행에는 관여하지 않는다.

실행·운영 절차는 [`README.md`](README.md), 호스트별 딜러 절차는 [`AGENTS.md`](AGENTS.md)와 그것이 가리키는 정본 스킬이 담당한다. 이 문서는 경계와 불변식만 다룬다.

## 2. Codemap

| 모듈 | 책임 |
|---|---|
| `engine/cards.js` | 표준 52장 덱 생성·셔플·순위 값(`newDeck`/`shuffle`/`rankValue`). |
| `engine/evaluator.js` | 7장 중 최고 5장 핸드 평가(`evaluate7`)와 점수 비교(`compareScore`). |
| `engine/sidepots.js` | 컨트리뷰션·폴드 집합으로부터 사이드팟을 구성(`buildPots`)하고 승자에게 분배(`awardPots`). |
| `engine/personas.js` | AI 좌석의 아키타입(TAG/LAG/Nit/CallingStation/Maniac/Trickster) 생성(`generatePersonas`). |
| `engine/hand.js` | 핸드 상태 전이의 본체 — 블라인드 레벨(`blindsForLevel`), `createGame`, `startHand`, `legalFor`, `applyAction`, `forceDefault`. `mode: cash-training`이면 고정 블라인드·핸드 간 top-up·`result: completed`. |
| `engine/positions.js` | 버튼부터의 생존 좌석 순서와 엔진 포지션 라벨(`seatedFromButton`/`positionsOf`). |
| `engine/decision.js` | 액션 적용 전 canonical decision snapshot(`snapshotDecision`). 영속화는 user만, redacted view는 viewer 스냅샷만. |
| `training/` | 엔진 밖 학습 계층. Preflop baseline lookup과 frequency grade. 파일 I/O는 CLI와 `tools/training-store.js`만. 전략 데이터를 engine이 로드하지 않는다. |
| `tools/training-control.js` | 세션 스코프 training authority·평가 멱등·reconcile. 코치 authority와 파일을 합치지 않는다. |
| `training/profile-store.js` | 장기 skill profile. 저장은 `<store>/.training/`이며 `tools/training-store.js`만 I/O한다. |
| `server/drill-server.js` | 게임 서버와 분리된 스팟 드릴 HTTP. 자체 토큰, 정적 파일은 `server/drill-public/`. |
| `engine/views.js` | 상태를 플레이어별 공개 뷰·핸드 요약·redacted 기록·통계로 투영(`viewFor`/`turnSummary`/`redactRecord`/`statsReport`). |
| `engine/game-archive.js` | 게임 디렉터리 초기화, 이전 게임 vacate/archive, 서버 pid 생존 판정(`isAlive`), 사이드카 락 존중(내부 `assertLoopAllowsInit`). |
| `engine/state.js` | `state.json` 원자적 I/O(`loadState`/`saveState`)와 이 저장소 전체가 재사용하는 pid(+startTime) identity 기반 owned-lock 프리미티브(`withMutation`/`withNamedLock`/`acquireOwnedLock`). |
| `engine/cli.js` | 엔진의 유일한 외부 표면 — `init`/`new-hand`/`legal`/`apply`/`view`/`step`/`hand`/`stats`/`end`/`resume-check` 서브커맨드. |
| `engine/session-catalog.js` | store의 영구 `sessions/<gameId>` namespace와 atomic current selector. normal resolve는 directory scan을 하지 않는다. |
| `tools/game-loop.js` | 사이드카 본체 — 부트스트랩(loop 락 → `init` → 서버 기동), 핸드 안 액션 루프, 워치독, 코치 파이프라인, 종합 리뷰, 종료 시퀀스를 한 detached 프로세스에서 오케스트레이션. |
| `tools/player-runtime.js` | LLM CLI를 부르는 유일한 어댑터 — 런타임별 probe·워밍업·세션 유지 결정·1회성 상위 모델 호출과 컨테인먼트 계약을 소유(`RUNTIME_TABLE`). |
| `tools/coach-control.js` | 코치 authority 상태기계 — `gameEpoch`/`activeOwnerSessionId`/핸드별 `generation`으로 큐·재개·중복 요청을 판정. |
| `tools/publish.js` | 게시 CLI — `engine/cli.js step` envelope의 공개분만 골라 서버에 POST하고 `publishId`를 관리. |
| `publish-contract.js` | `server/`와 `tools/`가 공유하는 계약 하나 — body-byte 상한(65,536)·`publishId` 상한·`gameEpoch = sha256(sessionToken)` 파생. |
| `server/server.js` | HTTP 중계 — `/api/events`(SSE), `/api/snapshot`, `/api/wait-action`, `/api/action`, `/api/publish`, `/api/health`. 토큰 검증만 하고 게임 규칙은 모른다. |
| `server/public/` | 정적 UI(`index.html`/`app.js`/`style.css`) — 한국어 포커 테이블. |
| `game/` | gitignore된 runtime store — `loop.lock.d/`와 `.session-store/current.json`; 선택된 `.session-store/sessions/<gameId>/` 아래에 `loop-state.json`, `state.json`, server/publish/coach 파일이 있다. |
| `test/` | `node --test` 스위트 — 엔진 단위 테스트부터 사이드카 통합(`game-loop.test.js`), 어댑터 계약(`player-runtime.test.js`), step→publish 통합 계약(`turn-contract.test.js`)까지. |

## 3. 아키텍처 불변식

- `engine/`은 네트워크도 LLM도 몰라야 한다 — 외부 npm 의존성이 없고, `node:fs`/`node:path`/`node:crypto`/`node:child_process`(로컬 pid 조회) 밖의 무언가를 끌어들이면 안 된다.
- 선택된 session의 `state.json`은 `engine/state.js`의 락(`withMutation`)을 통해서만 바뀌어야 한다 — 사이드카·게시 도구도 상태를 직접 쓰지 않고 `engine/cli.js`를 자식 프로세스로 부른다.
- LLM CLI는 `tools/player-runtime.js` 바깥에서 spawn되면 안 된다.
- 그 자식의 argv에는 세션 id 외의 런타임 값(모델 문자열, 프롬프트, decisionId, 저장소·게임 경로)이 실리면 안 된다 — 프롬프트는 반드시 stdin, cwd는 레포·`game/` 밖의 per-runtime 빈 tmp 디렉터리, env는 `HOME`/`PATH`만 상속한다.
- 활성 게임 여부는 서버 pid와 loop 락 pid **양쪽**이 살아 있다는 것으로만 증명돼야 한다 — 한쪽만 보고 활성/비활성을 판정하면 안 된다(`engine/game-archive.js`의 `assertLoopAllowsInit`, `resume-check`의 `serverPidAlive`·`loopPidAlive`).
- `--resume`은 어떤 경로로도 `init`을 호출하면 안 된다.
- 종료 phase 체크포인트는 역행하면 안 된다: `playing → finalizing → review_generated → review_published → done`. `review_generated` 이후 재개는 선택된 session의 `review.md`를 다시 만들지 않고, 먼저 기록해 둔 sha256으로 그 산출물을 재사용해야 한다.
- 오래된 `gameEpoch`/`activeOwnerSessionId`의 코치 콜백이 새 게임의 상태를 오염시키면 안 된다.
- decision snapshot은 `engine/` 소유이며, redacted 핸드·코치 입력은 viewer 자신의 스냅샷만 남기고 `decisions[].priorActions`를 최상위 액션과 같은 허용 키로 다시 걸러 상대 홀카드·비공개 정책 필드가 새면 안 된다.

## 4. 레이어 경계

```
브라우저 (server/public)
   │ SSE /api/events, POST /api/action·/api/publish (token)
   ▼
server/server.js  ──────────────────────────── 중계만, 게임 규칙 모름
   ▲ POST /api/publish (body-byte·publishId 계약 검증)
   │
tools/game-loop.js  (사이드카, detached 프로세스)
   ├─ execFile 자식 ── engine/cli.js (step/apply/…), tools/publish.js, tools/coach-control.js
   ├─ spawn 자식    ── server/server.js (기동만, 이후 독립)
   └─ tools/player-runtime.js → LLM CLI 자식(claude/codex/grok, stdin 프롬프트만)
```

| 의존 방향 | 허용 | 금지 |
|---|---|---|
| `tools/` → `engine/` | `engine/cli.js`를 **자식 프로세스**로 호출, `engine/state.js`의 락·원자적 쓰기·pid 프리미티브를 직접 import(사이드카·게시 도구 자신의 수명 락에 재사용) | `engine/hand.js` 등 게임 로직 함수를 tools에서 직접 import — 상태 변경은 항상 `engine/cli.js` 서브커맨드를 거친다 |
| `server/` → `tools/`, `engine/` | 없음 — `server/server.js`는 `publish-contract.js`만 import | 서버가 엔진 상태나 사이드카 내부를 직접 참조 |
| `engine/` → `tools/`, `server/` | 없음 | 엔진이 상위 계층을 참조 |
| 딜러 세션(호스트 LLM) → 게임 루프 | current가 선택한 session의 `loop-state.json` 폴링, 사이드카 기동 | 핸드 안 진행에 관여, 상태 파일 직접 수정 |

## 5. 횡단 관심사

- **락**: pid(+startTime) identity 기반 owned-lock 프리미티브 하나(`engine/state.js`의 `acquireOwnedLock`/`readOwnedLock`/`withMutation`/`withNamedLock`)가 엔진 mutex, 사이드카 수명 락(`loop.lock.d/`), 게시 락(`publish.lock.d/`) 전부에 재사용된다. 새 락 구현을 따로 만들지 않는다.
- **게시 계약**: `publish-contract.js`가 body-byte 상한·`publishId` 상한·`gameEpoch` 파생을 `server/`와 `tools/` 양쪽에 단일 소스로 공급해, 두 프로세스가 같은 상수를 따로 정의하지 않게 한다.
- **원자적 쓰기**: JSON 상태 파일은 `engine/state.js`의 `writeJsonAtomic`이, 리뷰 같은 텍스트 산출물은 `tools/game-loop.js`의 `writeTextAtomic`이 각각 tmp-write-then-rename으로 쓴다 — 프로세스가 도중에 죽어도 부분 쓰기로 상태가 깨지지 않는다.
- **관찰 지점**: `game/.session-store/current.json`이 선택한 concrete session의 `loop-state.json`이 딜러 세션의 폴링 대상이다 — phase·port·notices·metrics·halt가 여기 모인다.
- **영구 세션**: 새 게임은 `.session-store/sessions/<gameId>`에서 초기화되고 그 directory는 다음 init 때문에 이동·복사·삭제되지 않는다.
- **로그**: 로그 파일을 여는 것은 사이드카뿐이다(선택된 session의 `loop.log`, append). 사이드카가 띄우는 서버는 `stdio: 'ignore'`로 spawn되므로 자체 로그 파일을 갖지 않는다 — `server.log`는 서버를 손으로 띄울 때 쓰는 셸 리다이렉트일 뿐이다. 공용 로거는 없다.
- **런타임 폴백**: 플레이어·상위 모델 런타임 선택은 `tools/player-runtime.js`의 probe 사다리(`claude → codex → grok`) 하나로 결정되며, 이 판정은 사이드카·서버 어느 쪽에도 복제되지 않는다.
