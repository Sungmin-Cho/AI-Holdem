# AI 홀덤 — 아키텍처

## 1. 개요

AI 홀덤은 브라우저 UI에서 policy 또는 LLM 페르소나를 상대로 플레이하고 복습하는 시스템이다. 새 store 기본값은 cash-training·AI 5명·100BB·20핸드·policy v2다. 순수 규칙 엔진(`engine/`)은 네트워크·LLM을 모르고, detached 사이드카(`tools/game-loop.js`)가 게임 진행과 자식 프로세스를 소유한다. HTTP relay(`server/`)는 UI 게시와 durable 액션 접수를 소유하며 게임 규칙을 실행하지 않는다. 독립 `tools/study-service.js`가 store 학습 요약·드릴을 제공한다. LLM 호출은 `tools/player-runtime.js` 하나를 통하고, 호스트 딜러는 사전 점검·기동·보고만 맡는다.

실행·운영 절차는 [`README.md`](README.md), 호스트별 딜러 절차는 [`AGENTS.md`](AGENTS.md)와 그것이 가리키는 정본 스킬이 담당한다. 이 문서는 경계와 불변식만 다룬다.

## 2. Codemap

| 모듈 | 책임 |
|---|---|
| `engine/cards.js` | 표준 52장 덱 생성·셔플·순위 값(`newDeck`/`shuffle`/`rankValue`). |
| `engine/evaluator.js` | 7장 중 최고 5장 핸드 평가(`evaluate7`)와 점수 비교(`compareScore`). |
| `engine/sidepots.js` | 컨트리뷰션·폴드 집합으로부터 사이드팟을 구성(`buildPots`)하고 승자에게 분배(`awardPots`). |
| `engine/personas.js` | AI 좌석의 표현 필드(이름·말투·성격·아키타입)만 생성. 빈도 파라미터는 `training/policies/`가 소유한다. |
| `training/policies/` | deterministic strategy policy와 RNG. 레이즈 사이징 규칙은 `sizing.js` 한 곳. 엔진은 정책 모듈을 import하지 않는다. |
| `training/tendency/` | 핸드 아카이브에서 관측 빈도 프로파일을 만드는 순수 계층. `compare.js`는 휴리스틱 유사도만 계산한다. |
| `training/policies/strategy-mirror.js` | 관측 빈도로 preflop을 재생하는 파생 정책 `strategy-mirror-v1`. |
| `tools/self-opponents.js` | `--mirror-self`/`--exploit-self` 좌석 배정·마커·재개 검사·리뷰 비교 절. |
| `tools/tendency-cli.js` | store 성향 프로파일 `show`/`check`. |
| `tools/policy-player.js` | `--opponent-runtime policy`일 때 인프로세스 결정. LLM 워밍업을 생략한다. |
| `training/exploit/` | 종료 후 heuristic exploit 비교. EV 숫자는 만들지 않는다. |
| `tools/solver-runtime.js` | Postflop solver 자식. detached process group, RSS/stdout cap, fake adapter. |
| `tools/solve-cli.js` | 한 postflop 결정을 풀어 evaluate와 같은 evaluation 봉투로 돌려준다. |
| 계층 방향 | `tools/ → training/`(순수 함수 import만 허용), `training/ → engine/state.js`(락만), `engine/ → training,tools` 금지, `server/*.js`는 `publish-contract.js`와 담기 원시자만. `test/boundaries.test.js`가 강제한다. |
| `training/postflop/solved-decision.js` | solver 결과 → evaluation 투영(순수). heuristic이면 EV는 전부 null. |
| `tools/evaluate-cli.js` | preflop 평가 프로세스 진입점. 데이터셋 읽기는 여기(호출자)의 책임이다. |
| `tools/preflop-dataset.js` | 데이터셋을 읽어 digest를 대조하고 순수 파서에 넘기는 유일한 지점. 파서가 통과시킨 dataset에만 모듈 전용 브랜드를 달고 `lookup`이 그것을 요구하므로(R5), raw `JSON.parse`로 만든 dataset은 전략이 될 수 없다. |
| `tools/training-stores.js` | R12의 주입자 — `tools/training-store.js`의 fs helper를 `training/`의 저장 모듈에 넘긴다. |
| `tools/fake-solver-adapter.js`, `tools/solver-adapter.js` | solver adapter 레지스트리와 fake adapter. 프로세스 spawn은 tools 책임이다. |
| `tools/build-preflop-baseline.js` | 데이터셋 빌드 스크립트. |
| `engine/hand.js` | 핸드 상태 전이의 본체 — 블라인드 레벨(`blindsForLevel`), `createGame`, `startHand`, `legalFor`, `applyAction`, `forceDefault`. `mode: cash-training`이면 고정 블라인드·핸드 간 top-up·`result: completed`. |
| `engine/positions.js` | 버튼부터의 생존 좌석 순서와 엔진 포지션 라벨(`seatedFromButton`/`positionsOf`). |
| `engine/decision.js` | 액션 적용 전 canonical decision snapshot(`snapshotDecision`). 영속화는 user만, redacted view는 viewer 스냅샷만. |
| `training/` | 엔진 밖 학습 계층. Preflop baseline lookup과 frequency grade. **순수 계층 — 파일 I/O도 `tools/` import도 없다**(R12). fs helper와 데이터셋은 주입받는다. |
| `tools/training-control.js` | 세션 스코프 training authority·평가 멱등·reconcile. 코치 authority와 파일을 합치지 않는다. |
| `training/profile-store.js` | 장기 skill profile. 저장은 `<store>/.training/`. fs helper를 **기본값 없이 주입**받으며, 주입자는 `tools/training-stores.js`다. |
| `tools/drill-server.js` | 게임 서버와 분리된 스팟 드릴 HTTP(별도 프로세스, 게임 서버와 무관). 자체 토큰, 정적 파일은 `server/drill-public/`. |
| `tools/study-service.js` | store inode·pid/startTime·instance identity와 private descriptor를 검증하는 독립 study 수명 소유자. parent attach와 제어 토큰은 UI 토큰과 분리된다. |
| `tools/study-summary.js` | 검증된 학습 이벤트를 게임·연습·평가·재시험별 공개 요약으로 투영한다. |
| `shared/reference.js` | 휴리스틱 기준표의 출처·허용 액션·분포 일치 계약. 학습 효과나 solver 권위로 승격하지 않는다. |
| `server/action-receipts.js` | 접수·전달·소비/거절을 원자적 영속 receipt로 기록한다. UI 커밋 뒤 ACK를 기록하고 재시작 시 정확한 identity로 복구한다. |
| `export/` | 핸드 히스토리 read-only export. 엔진 상태를 바꾸지 않는다. |
| `engine/views.js` | 상태를 플레이어별 공개 뷰·핸드 요약·redacted 기록·통계로 투영(`viewFor`/`turnSummary`/`redactRecord`/`statsReport`). |
| `engine/game-archive.js` | 게임 디렉터리 초기화, 이전 게임 vacate/archive, 서버 pid 생존 판정(`isAlive`), 사이드카 락 존중(내부 `assertLoopAllowsInit`). |
| `engine/state.js` | `state.json` 원자적 I/O(`loadState`/`saveState`)와 이 저장소 전체가 재사용하는 pid(+startTime) identity 기반 owned-lock 프리미티브(`withMutation`/`withNamedLock`/`acquireOwnedLock`). |
| `engine/cli.js` | 엔진의 유일한 외부 표면 — `init`/`new-hand`/`legal`/`apply`/`view`/`step`/`hand`/`stats`/`end`/`resume-check`/`decision-peek` 서브커맨드. |
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
- 서버는 세션 디렉터리의 `players.json`·`.coach-authority.json`·`state.json`·`hands/hand-*.json`을 **읽기 전용 보안 술어**로만 참조하며 어느 것도 쓰지 않는다 — 게시자의 주장(`view`·machine item의 `handNo`)은 exploit 게이트와 deny 목록의 입력이 될 수 없다.
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
| `server/` → `tools/`, `engine/` | `publish-contract.js`, 그리고 `tools/training-store.js`의 담기 원시자(`openContained`/`writeContained`)만 — 서버는 별도 프로세스라 주입이 불가능하고 담기 helper를 재구현해선 안 된다 | 사이드카 로직 모듈 전부. `test/boundaries.test.js`가 이름 단위로 강제한다 |
| `engine/` → `tools/`, `server/` | 없음 | 엔진이 상위 계층을 참조 |
| 딜러 세션(호스트 LLM) → 게임 루프 | current가 선택한 session의 `loop-state.json` 폴링, 사이드카 기동 | 핸드 안 진행에 관여, 상태 파일 직접 수정 |

## 5. 횡단 관심사

- **락**: pid(+startTime) identity 기반 owned-lock 프리미티브 하나(`engine/state.js`의 `acquireOwnedLock`/`readOwnedLock`/`withMutation`/`withNamedLock`)가 엔진 mutex, 사이드카 수명 락(`loop.lock.d/`), 게시 락(`publish.lock.d/`) 전부에 재사용된다. 새 락 구현을 따로 만들지 않는다. 회수는 stale pid 파일에 하드링크 aside를 붙여 inode를 검증하고 그 aside가 디렉터리를 비어 있지 않게 고정하는 동안만 지운다(경로 재바인딩 방지); 획득은 고유 이름 임시 디렉터리에 pid를 먼저 기록하고 rename으로 설치해 산 락이 한순간도 비어 있지 않게 한다. 회수에는 rename을 쓰지 않는다.
- **게시 계약**: `publish-contract.js`가 body-byte 상한·`publishId` 상한·`gameEpoch` 파생을 `server/`와 `tools/` 양쪽에 단일 소스로 공급해, 두 프로세스가 같은 상수를 따로 정의하지 않게 한다.
- **원자적 쓰기**: JSON 상태 파일은 `engine/state.js`의 `writeJsonAtomic`이, 리뷰 같은 텍스트 산출물은 `tools/game-loop.js`의 `writeTextAtomic`이 각각 tmp-write-then-rename으로 쓴다 — 프로세스가 도중에 죽어도 부분 쓰기로 상태가 깨지지 않는다.
- **contained I/O**: `tools/training-store.js`의 `openContained`/`writeContained`는 세그먼트 문법(`BAD_SEGMENT`)·조상 `lstat`(symlink 거부)·`O_NOFOLLOW`·열기 후 조상 재-`lstat`(dev/ino)로 경계를 좁힌다. Node 공개 API에 `openat`이 없어 이 검사-열기-재검사는 **완전 봉쇄가 아니다** — TOCTOU 창은 줄어들 뿐이고, 호출자는 root를 신뢰 경계로 둬야 한다. `writeContained({mode:'create'})`는 `link(tmp, dest)`만 허용하며(EEXIST → `EXISTS`) 존재 검사 후 rename으로 덮어쓰지 않는다.
- **관찰 지점**: `game/.session-store/current.json`이 선택한 concrete session의 `loop-state.json`이 딜러 세션의 폴링 대상이다 — phase·port·notices·metrics·halt가 여기 모인다.
- **영구 세션**: 새 게임은 `.session-store/sessions/<gameId>`에서 초기화되고 그 directory는 다음 init 때문에 이동·복사·삭제되지 않는다.
- **로그**: 로그 파일을 여는 것은 사이드카뿐이다(선택된 session의 `loop.log`, append). 사이드카가 띄우는 서버는 `stdio: 'ignore'`로 spawn되므로 자체 로그 파일을 갖지 않는다 — `server.log`는 서버를 손으로 띄울 때 쓰는 셸 리다이렉트일 뿐이다. 공용 로거는 없다.
- **런타임 폴백**: 플레이어·상위 모델 런타임 선택은 `tools/player-runtime.js`의 probe 사다리(`claude → codex → grok`) 하나로 결정되며, 이 판정은 사이드카·서버 어느 쪽에도 복제되지 않는다.
- **기본값과 학습 범위**: fresh store 요청만 새 기본값을 받는다. 명시 llm/tournament·스택·레벨·AI 수·핸드 수·블라인드는 보존한다. legacy API와 resume은 기록된 설정을 사용한다. 새 세션의 v2 휴리스틱 기준표는 cash-training 6·8·9인, 100BB의 미오픈 2.5BB 오픈과 단일 오픈 대응 8.5BB 3-bet을 지원한다. 80~120BB 스택·2~3BB 오픈·6.5~10.5BB 선택 3-bet은 제한적 투영 참고이며 점수·분포·오답·재시험 통계에서 제외한다. limp·cold-call·multiway·4-bet+·postflop은 지원하지 않는다. 기존 세션과 정책 v1은 기존 기준표를 유지한다. 게임 지표와 연습 지표, source 버전별 점수는 합치지 않는다.
- **별도 study 수명**: store loop 락 소유자가 검증된 서비스에 parent로 붙는다. relay adoption은 pid·listener·세션 인증에 더해 protocol 2/actionReceipts/studyLink와 현재 study URL 일치를 요구한다. 서비스 재시작으로 URL이 바뀌면 identity를 증명한 relay만 교체하고 엔진 view를 동기화한다. 게임 종료는 study를 정지하지 않으며 인증 활동/부모 종료 후 유휴 10분에 정지한다.
- **생성 권한**: 실제 store CLI 프로세스는 catalog·loop 락 생성 전에 umask 077을 설정한다. 호스트·API 호출자의 umask나 기존 디렉터리·foreign 락은 변경하지 않는다.
- **버전 복구**: v1 배정은 정확한 v1 identity로 읽고 v2는 그대로 보존한다. 구버전 profile 검증은 복사본에서 실제 reader로 실행하며 raw 이벤트·평가·processed digest를 대조한다. 결과가 미확인인 accepted/delivered 액션은 rollback을 차단한다. 권위 동기화 후 matching study만 정지하고 호환 버전으로 roll-forward한다.
- **파생 정책 identity**: 자기 복제·공략 좌석은 `players.json`의 삼중항(`policyId`/`policyVersion`/`configDigest`)과 세션 `.policy-configs.json`에 묶인다. digest가 config 본문을 결박하며, 서버·export는 그 파일을 읽지 않는다.

### Reference coverage v2 (#150)

`training/preflop-reference.js` separates choice-free lookup from choice comparison.
The parser pins immutable data; query results are bound by object identity to their
public decision snapshot. No opponent policy strength or future outcome is read.
`reference-source.json` pins new sessions before catalog commit; absent legacy bindings
resolve v1, conflicting history halts. `training-control` replays v2 evaluation against
the completed canonical decision before acceptance. Optional coverage participates
in summary/detail digests without rewriting v1 canonical bytes.

Profile schema 5 retains raw coverage and source identity while admitting only exact
comparisons to scores, calibration and practice candidates. Event schemas 1–4 remain
readable and their journal bytes are preserved. Source-aware drills resume the source
of their stored queue or assessment. Roll forward with a compatible reader; do not
open v2 stores with an older binary. Issue #147 hint publication remains separate.
