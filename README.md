# AI 홀덤

AI 에이전트 상대와 웹 UI로 즐기는 노리밋 텍사스 홀덤. 게임 루프는 노드 사이드카, 규칙은 순수 Node 엔진, 서버는 중계만 한다.

요구: Node ≥ 20, 외부 npm 의존성 없음. 게임 런타임은 **Claude Code · Codex · Grok** 셋 다 지원한다.

## 누가 무엇을 소유하는가

**사이드카(`tools/game-loop.js`)가 게임 전체를 소유한다.** 부트스트랩(loop 락 → `init` → 서버 기동)부터 핸드 안 액션 루프, 워치독, 코치 파이프라인, 종합 리뷰, 종료 시퀀스까지 그 detached 노드 프로세스 안에서 돈다. `engine/cli.js`·`tools/publish.js`·`tools/coach-control.js`를 `execFile` 자식으로 그대로 부르므로 엔진·게시 계약은 바뀌지 않는다.

**딜러 세션(LLM)은 사전 점검 → 기동 → 보고만 한다.** 핸드 안 AI 액션 경로의 딜러 LLM 라운드는 0회다. 호스트 세션이 죽어도 사이드카와 서버는 detached라 게임은 계속 돈다.

**LLM은 플레이어 결정·코치·리뷰만 만든다.** 전부 `tools/player-runtime.js`가 부르는 무도구 CLI 자식이고, 플레이어는 CLI 세션 resume으로 대화 하나를 게임 내내 이어 간다(페르소나 기억). 프롬프트는 stdin, 응답은 stdout, 게시 본문은 파일 — 모델 문자열은 argv에 들어가지 않는다.

### 런타임 어댑터

| 런타임 | 플레이어 모델 | 상위 모델(코치·evaluator·종합자) | 워치독 1차/재전송 |
|---|---|---|---|
| `claude` | `haiku` | `opus` | 25s / 15s |
| `codex` | `gpt-5.6-luna` | `gpt-5.6-sol` | 25s / 15s |
| `grok` | `grok-4.6` | `grok-4.6` | 60s / 30s |

기본 런타임은 `/start-game`을 실행한 호스트다 — 딜러가 `--player-runtime`으로 명시한다. 기동 probe가 런타임마다 셋을 검증한다: ① 플레이어 모델 왕복 ② 상위 모델 왕복 ③ **컨테인먼트 부정 검증**(게임 디렉터리에 심은 카나리를 자식이 읽어 오지 못해야 적격). ①·③ 실패면 그 런타임은 부적격이고 폴백 사다리(claude → codex → grok)가 돈다. ②만 실패면 플레이어와 코치·리뷰를 다른 런타임으로 갈라 쓴다. 전부 부적격이면 게임을 시작하지 않는다(`halt.code = NO_PLAYER_RUNTIME`).

## 실행

저장소 루트에서.

### 스킬 (권장)

Claude Code 세션을 이 저장소에서 열고 `/start-game` (AI 1~8명, 기본 3). 옵션 `--stack N`, `--level-every N`, `--blinds SB/BB`. 중단 재개: `/start-game resume`.

절차 정본: [`.agents/skills/start-game/SKILL.md`](.agents/skills/start-game/SKILL.md). 호스트 포인터는 [`AGENTS.md`](AGENTS.md).

### 수동 (사이드카 직접 기동)

스킬 없이 같은 게임을 띄울 때. `init`·서버 기동은 사이드카가 한다.

```bash
nohup node tools/game-loop.js --game-dir game --ai 3 --player-runtime claude \
  > /tmp/ai-holdem-boot.log 2>&1 &
# game/loop-state.json을 폴링해 phase가 bootstrap을 지나면 port·sessionToken으로
open "http://127.0.0.1:<port>/?token=<t>"
```

재개는 `--ai` 대신 `--resume`. 종료 코드: `0` done, `2` repair_failed/USAGE, `3` REVIEW_FAILED, `4` NO_PLAYER_RUNTIME, `5` 기타 halt.

### 수동 (엔진·서버만)

LLM 없이 서버와 CLI만 띄울 때:

```bash
node engine/cli.js init --ai 3          # stdout의 sessionToken
nohup node server/server.js --game-dir game --port 8877 --token <t> > game/server.log 2>&1 &
# health 확인 후
open "http://127.0.0.1:8877/?token=<t>"
```

UI 시연(가짜 딜러): 서버를 `--token dev`로 띄운 뒤 `node test/helpers/dev-drive.js --port <p> --token dev`.

**활성 게임의 정의는 서버 pid와 loop 락 pid 동격이다.** `resume-check`가 `serverPidAlive`·`loopPidAlive`를 함께 준다. 둘 중 하나라도 살아 있으면 `init`은 `ACTIVE_GAME`으로 거부하고, `--force`여도 남의 살아 있는 사이드카는 엔진이 죽이지 않는다(`LOOP_ALIVE`) — 정지는 부트스트랩·롤백 절차의 소관이고 순서는 **사이드카 → 서버**다. 아카이브는 둘 다 사망을 확인한 뒤에만 일어나며 `archive/`는 지우지 않는다.

`game/`은 gitignore 런타임 상태다. `game/state.json`은 엔진만 읽고 쓴다.

## 테스트

```bash
node --test
```

인자 없이 실행한다. **`node --test test/`처럼 디렉토리 인자를 주면 Node v26에서 실패하므로 금지.** 단건은 `node --test test/<파일>.test.js`.

## 파일 구조

```
engine/                 # 순수 포커 엔진 CLI (네트워크·LLM 없음)
  cli.js                # step/init/new-hand/legal/apply/view/hand/stats/end/resume-check
  state.js              # 상태 I/O + 수명 보유 owned lock (pid+startTime identity)
tools/
  game-loop.js          # 사이드카: 부트스트랩·핸드 루프·워치독·코치·리뷰·resume
  player-runtime.js     # LLM CLI 어댑터 (probe·워밍업·결정·1회성 상위 모델 호출)
  player-prompt.md      # 플레이어 프롬프트 정본 (페르소나 카드 + JSON 한 줄 회신)
  publish.js            # 게시 도구 (public 필터·publishId·사용자 액션 대기)
  coach-control.js      # 코치 authority·queue/tombstone·owner/generation
publish-contract.js     # 공유 body-byte/publishId 상한
server/
  server.js             # 중계 (SSE, wait-action, publish, 토큰)
  public/               # 한국어 포커 테이블 UI
test/                   # node --test
  game-loop.test.js     # 사이드카 통합 (fake 어댑터로 완주·워치독·resume·종료 시퀀스)
  player-runtime.test.js # 어댑터 계약 (세션 지속·컨테인먼트·관용 파서)
  turn-contract.test.js # 사이드카가 잇는 step→publish 시퀀스의 통합 계약
  tempo-skill-contract.test.js # 스킬·README·AGENTS 문면 계약
  helpers/fake-cli.js   # 스크립트化 가짜 LLM CLI
  helpers/dev-drive.js  # UI 시연용 가짜 딜러
.agents/skills/start-game/SKILL.md   # 딜러 절차 정본 (SSOT)
.claude/skills/start-game            # → 정본 심볼릭 링크
.grok/skills/start-game              # → 정본 심볼릭 링크
AGENTS.md                            # Codex 등 호스트 포인터
game/                   # 런타임 (gitignore)
  loop-state.json       # phase·port·notices·metrics·halt — 딜러의 유일한 관찰 지점
  loop.lock.d/          # 사이드카 수명 보유 락 (pid+startTime)
  loop.log              # 사이드카 로그
```

호스트별 플레이어 에이전트 정의 파일은 없다 — 플레이어 프롬프트 정본은 `tools/player-prompt.md` 한 곳이고 회신 규약은 "JSON 한 줄을 최종 출력으로" 하나다.

## 턴 지연

게임 속도를 지배하는 것은 **딜러 LLM 왕복**이었다. 사이드카가 루프를 가져가면서 그 왕복은 액션당 0회가 됐고, 남는 것은 플레이어 CLI 왕복 하나와 노드 오버헤드뿐이다.

| 기준 | 값 |
|---|---|
| 핸드 안 AI 액션 경로의 딜러 세션 LLM 라운드 | **0회** |
| AI 결정 `elapsedMs` 중앙값 — claude(haiku)·codex(gpt-5.6-luna) | ≤ 10s |
| AI 결정 `elapsedMs` 중앙값 — grok(grok-4.6) | ≤ 27s |
| AI 결정 `elapsedMs` p95 | ≤ 워치독 1차 한도(claude·codex 25s, grok 60s) |
| `forced_default` 비율 | < 10% |
| 사이드카 오버헤드(step+publish+파싱, LLM 제외) | ≤ 1s/액션 |

판정 근거는 사이드카가 **모든 AI 결정**에 대해 `game/loop-state.json`의 `metrics`에 남기는 `{playerId, decisionId, runtime, outcome, elapsedMs, modelMs, parseMs, stepMs, publishMs}`다. `outcome ∈ {accepted, retried_accepted, forced_default}`이고 `forced_default`도 소요 시간 그대로 분포에 들어간다(타임아웃을 분포에서 숨기지 않는다). 오버헤드는 총 `elapsedMs`가 아니라 `parseMs+stepMs+publishMs`로 판정한다. 백분위는 nearest-rank, 판정 표본은 3핸드 이상 **그리고** AI 결정 20개 이상. 게시 시각은 `game/ui-snapshot.json`의 `history[].at`으로 교차 확인한다.

## 종료 시퀀스와 재개

게임이 끝나면(`gameOver` 또는 사용자 bust) 사이드카가 phase 체크포인트를 밟는다.

```
playing → finalizing → review_generated → review_published → done
```

- **finalizing**: 마지막 핸드 코치를 재-reserve하지 않고, 20초 절대 예산 안에서 result 소비 → cutoff → `finalize-cutoff`(missing 전체를 한 transaction에서 fence + unavailable seal) → 잔여 pending Q 게시.
- **review_generated**: evaluator(redacted 트레이스+stats만) → 종합자(evaluator 출력+결과+아키타입 공개)로 리뷰를 만들고 `game/review.md`와 그 sha256을 **먼저** 기록한다. 이후 재개는 재생성하지 않고 이 산출물을 재사용한다. 두 번 실패하면 리뷰를 지어내지 않고 `halt.code = REVIEW_FAILED`다.
- **review_published**: 게시 전에 `ui-snapshot.json`의 review digest를 대조해 이중 게시를 생략한다.
- **done**: `finishedAt` 기록 후 정리·exit 0.

`--resume`은 **어떤 경로에서도 `init`을 부르지 않는다.** 기록된 phase(없으면 엔진 상태로 유도)부터 멱등 재개하고, 종료 국면이면 플레이어 probe·워밍업을 생략한다. 재개 여부의 분기는 `resume-check`의 `loopPidAlive` 하나다 — 참이면 사이드카를 다시 띄우지 않고 attach(관찰만), 거짓일 때만 `--resume`으로 기동한다. 종료 정리가 실패하면(`loop-state.json`의 `cleanupFailedAt`) 그 프로세스는 이미 끝났으므로 복구는 새 `--resume` 프로세스가 한다.

## 구현 후 확인 체크리스트

호스트별 스킬 **인식 실측**과 첫 게임은 이 저장소를 연 세션에서 직접 확인한다(구현 세션에서는 스킬 메뉴를 검증하지 않음).

- [ ] **Claude Code:** 이 저장소에서 세션을 열고 `/start-game`이 슬래시 메뉴에 보이는지. 안 되면 폴백: `.claude/skills/start-game/SKILL.md`를 정본을 참조하는 얇은 래퍼 파일로 바꾼다(심볼릭 링크 미인식 시).
- [ ] **Codex:** `$start-game` / 스킬 목록에 `.agents/skills/start-game`이 보이는지. 안 되면 `AGENTS.md` 포인터를 읽고 그 경로의 `SKILL.md`를 연다. `.codex/skills/` 심볼릭 링크는 Codex가 심볼릭 디렉터리를 무시하므로 두지 않았다.
- [ ] **Grok:** `/start-game` 또는 `/local:start-game`이 보이는지(`.grok/skills` 또는 `.agents/skills`). 안 되면 `AGENTS.md` 포인터.
- [ ] **런타임별 §2 수치 판정(최소 3핸드 + AI 결정 20개):** `game/loop-state.json`의 `metrics`로 중앙값·p95·`forced_default` 비율·오버헤드(`parseMs+stepMs+publishMs`)를 계산해 위 「턴 지연」 표와 대조한다. 딜러 전사에 핸드 안 tool call이 없음도 함께 확인한다.
- [ ] **컨테인먼트 부정 probe 실측:** 기동 로그(`game/loop.log`)에서 런타임별 probe 판정을 확인한다. 카나리 센티널이 자식 출력에 나타난 런타임은 부적격으로 기록됐어야 한다. 실패한 런타임은 실패 그대로 기록한다(다른 호스트 결과를 일반화하지 않는다).
- [ ] **코치 노트:** 모든 완료 `handNo`가 Published 또는 Pending이고 `text`가 비어 있지 않거나 `unavailable` 표식이 있다. 코치가 다음 핸드를 막지 않는다. 코치 문구에 비공개 홀카드·아키타입이 없다. resume은 missing만 백필하고 Q를 재스폰하지 않는다. late old epoch/owner callback이 새 게임을 오염시키지 않는다.
- [ ] **리뷰 오버레이:** 게임 종료 후 UI 리뷰 오버레이와 `game/review.md`. `loop-state.json`의 `phase`가 `done`이고 `finishedAt`이 있다. Pending이 있으면 리뷰에 `handNo`·`noteKind`를 명시하고 UI 게시 완료를 주장하지 않는다.
- [ ] **레거시 talk 스냅샷:** 이전 버전에서 만들어진 `ui-snapshot.json`을 열었을 때 talk 말풍선·로그 라인이 보이지 않고 narration은 그대로 보이는지.
- [ ] **notices 보고:** 런타임 폴백이나 상위 모델 부재가 있었다면 딜러가 그것을 한 줄로 보고했는지.
