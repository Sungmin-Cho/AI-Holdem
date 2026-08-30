---
name: start-game
description: AI 홀덤 게임 시작/재개 — 딜러 오케스트레이션
metadata:
  argument-hint: "[AI수 1~8] | resume [--stack N] [--level-every N]"
  user-invocable: true
---

# start-game

게임 루프는 **사이드카**(`tools/game-loop.js`)가 소유한다. 부트스트랩(loop 락 → `init` → 서버 기동)부터 핸드 안 액션, 코치, 종합 리뷰, 종료까지 전부 그 노드 프로세스 안에서 돌고, 플레이어·코치·리뷰 LLM은 사이드카가 부르는 무도구 CLI 자식이다.

딜러(이 세션)가 하는 일은 셋뿐이다: **사전 점검 → 사이드카 기동 → 보고.** 게임이 시작된 뒤에는 **개입하지 않는다** — 핸드 안 딜러 라운드는 0회다.

사용법: `/start-game [AI수 1~8]` (옵션 `--stack N`, `--level-every N`, `--blinds SB/BB`). 기본 AI 3명(4인 테이블). 중단 재개: `/start-game resume`.

저장소 루트에서 실행. `game/`은 런타임 상태(gitignore)이고 사이드카·엔진만 쓴다.

## 절대 규약

- **게시는 `tools/publish.js`만 한다.** 그 도구만이 `visibility==="public"` 필터와 `publishId` 증가를 책임진다. 딜러는 게시하지 않는다 — 사이드카가 한다.
- **모델이 만든 문자열을 셸 인자에 넣지 않는다.** 사이드카는 프롬프트를 stdin으로, 본문을 파일로만 흘린다. 딜러가 남기는 모델 유래 문자열은 practiceFocus 파일 하나뿐이고, argv에는 그 **경로만** 넘긴다.
- 사용자 노출 문자열은 한국어. 아키타입·스타일·비공개 홀카드는 종합 리뷰 전까지 공개하지 않는다 — 이 불변식도 사이드카가 지킨다.
- 게임은 멈추지 않는다(워치독·사용자 무제한 대기·서버 자가치유는 전부 사이드카 소관). 예외는 **기동 전 실패** 하나다 — 적격 플레이어 런타임이 없으면 게임을 시작하지 않는다.

---

## 1. 사전 점검

1. `node --version` — major ≥ 20이어야 한다. 미달이면 중단하고 사용자에게 알린다.
2. **연습 포커스**: `game/review.md`가 있으면 새 게임이 그것을 지우기 전에 '다음 게임에서 연습할 것' 항목을 읽는다. 그것이 이번 세션의 practiceFocus다 — **`game/` 밖 경로**(예: `/tmp/ai-holdem-practice-focus.md`)에 Write 도구로 저장하고 그 경로를 `--practice-focus-file`로 넘긴다. `game/` 안에 쓰면 부트스트랩의 vacate가 아카이브로 쓸어 간다. 없으면 생략한다.
3. **잔여 게임 판정** — `game/`에 상태가 남아 있으면:

```bash
node engine/cli.js resume-check --game-dir game
# {ok, serverPidAlive, loopPidAlive, port, sessionToken, stateVersion, phase, toAct,
#  archiveRepaired, archiveStatus: "healthy"|"repaired"|"repair_failed"}
```

`serverPidAlive`와 `loopPidAlive`는 **동격**이다 — 둘 중 하나라도 참이면 활성/잔여 게임이다. 하나라도 참이면 **사용자에게 묻는다**: 이어서 할지(§5) vs 새 게임. 추측으로 기동하지 마라.

`archiveStatus`가 `repair_failed`면 그 사실을 사용자에게 먼저 알린다. 그 핸드 기록은 코치·리뷰가 읽을 수 없다.

---

## 2. 시작

인자가 없으면 AI 수 `n=3`. 범위 1~8. `--stack`(기본 5000), `--level-every`(기본 8), `--blinds`는 사용자 요청이 있을 때만.

`init`·서버 기동·페르소나 생성·브라우저 URL 확보는 전부 사이드카가 한다. 딜러는 이 한 줄만 친다.

```bash
nohup node tools/game-loop.js --game-dir game --ai <n> \
  --player-runtime <이 호스트의 값: Claude Code=claude, Codex=codex, Grok=grok> \
  [--stack N] [--level-every N] [--blinds SB/BB] [--force] \
  [--practice-focus-file <game/ 밖 경로>] \
  > /tmp/ai-holdem-boot.log 2>&1 &
```

살아 있는 게임이 있는데 `--force` 없이 기동하면 사이드카가 `ACTIVE_GAME`으로 즉시 종료한다. 새 게임으로 덮어쓰기로 사용자가 정했을 때만 `--force`를 붙인다(정지 순서 사이드카 → 서버, 아카이브는 둘 다 사망 확인 후. 남의 살아 있는 loop는 엔진이 죽이지 않는다).

그다음 `game/loop-state.json`을 약 250ms 간격으로 폴링한다. **종료 조건은 벽시계가 아니라 셋 중 하나다:**

1. `halt` 기록 — 기동 실패다. `halt.code`·`message`와 `/tmp/ai-holdem-boot.log`를 보고 중단한다.
2. `phase`가 `bootstrap`을 지남(`playing` 이후) — 정상 기동이다.
3. 사이드카 **pid 사망** — `/tmp/ai-holdem-boot.log`를 보고 중단한다.

런타임 probe 사다리(런타임 × 플레이어/상위 모델/컨테인먼트, grok 콜드 1회 ~25s)가 있어 부트가 수십 초를 넘을 수 있다. **pid가 살아 있는 한 "기동 중"으로 보고하고 계속 기다린다** — 중단하거나 `--force`로 다시 띄우지 마라.

2번에 도달하면 `loop-state.json`의 `port`·`sessionToken`으로 브라우저를 연다.

```bash
open "http://127.0.0.1:<port>/?token=<sessionToken>"
```

macOS `open`. 브라우저가 없으면 URL을 사용자에게 보여 준다.

마지막으로 `loop-state.json`의 `archivedTo`가 문자열이면 그 아카이브 경로를, `notices`에 항목이 있으면 각각을 **한 줄씩** 사용자에게 보고한다. `notices`는 런타임 폴백(요청한 `--player-runtime`이 부적격이라 다른 CLI를 쓰는 중), 상위 모델 부재(코치가 unavailable 경로만 밟고 종합 리뷰를 만들 수 없음) 같은 고지가 담기는 **유일한 경로**다.

---

## 3. 게임 중

**딜러는 개입하지 않는다.** 핸드 안 AI 액션 경로의 딜러 LLM 라운드는 **0회**이고, 그것이 이 구조의 성공 기준이다. 액션 전달·워치독·코치 스폰·게시·서버 재기동은 전부 사이드카가 한다.

사용자가 진행 상황을 물으면 **`game/loop-state.json`을 한 번 읽고** 답한다: `phase`, `handNo`, `notices`, 그리고 결정별 `metrics`(`{playerId, decisionId, runtime, outcome, elapsedMs, modelMs, parseMs, stepMs, publishMs}`) 요약. `outcome`이 `forced_default`인 결정이 잦으면 워치독이 자주 걸린다는 뜻이니 한 줄로 알린다. 상세 로그는 `game/loop.log`다.

---

## 4. 종료 보고

종료까지 관찰할 때의 관찰 종료 조건도 셋이다: `phase`가 done, `halt` 기록, 사이드카 pid 사망. 사이드카는 `loop-state.json`의 `phase`가 done이 된 시점에 `finishedAt`을 남기고 exit 0으로 끝난다. 정상 종료면 종합 리뷰가 UI 오버레이로 게시돼 있고 본문이 `game/review.md`에 있다 — 사용자에게 리뷰가 준비됐다는 것과 '다음 게임에서 연습할 것' 항목을 한 줄로 전한다.

`halt`가 기록돼 있으면 `halt.code`로 분기해 **한 줄씩** 안내한다.

| `halt.code` | 사용자 안내 |
|---|---|
| `REVIEW_FAILED` | 게임은 끝났고 상태·코치 노트는 온전하지만 종합 리뷰 생성이 두 번 실패했습니다. 상위 모델 CLI 인증을 확인한 뒤 `/start-game resume`으로 리뷰 단계부터 다시 시도합니다 |
| `repair_failed` | 직전 핸드 아카이브를 쓰지 못해 멈췄습니다. 그 핸드는 코치·리뷰가 읽을 수 없습니다. `game/hands/` 상태를 확인해야 합니다 |
| `NO_PLAYER_RUNTIME` | 적격 플레이어 런타임이 하나도 없어 게임을 시작(또는 재개)하지 않았습니다. `notices`의 probe 실패 내역대로 CLI 인증·설치를 고친 뒤 다시 시도합니다 |

그 밖의 `halt.code`는 코드와 `message`를 그대로 전하고 `game/loop.log`를 가리킨다. 딜러가 원인을 추측해 지어내지 않는다.

---

## 5. resume

`/start-game resume` 또는 사전 점검에서 이어하기를 고른 경우. **분기는 `resume-check`의 `loopPidAlive` 하나다.**

- **`loopPidAlive: true` → attach.** 사이드카를 **다시 띄우지 않는다**(loop 락이 살아 있는 선점자를 거부하므로 이것이 유일한 정상 경로다). `loop-state.json`을 읽어 "게임 진행 중"과 `phase`·`handNo`를 보고하고, 사용자가 원하면 §4처럼 종료까지 관찰만 한다. 브라우저가 닫혔으면 `port`·`sessionToken`으로 다시 열어 준다.
- **`loopPidAlive: false` → `--resume` 기동.** 새 게임 기동과 같은 문면이되 `--ai`·`--force` 자리에 `--resume`이 온다.

```bash
nohup node tools/game-loop.js --game-dir game --resume \
  --player-runtime <이 호스트의 값: Claude Code=claude, Codex=codex, Grok=grok> \
  > /tmp/ai-holdem-boot.log 2>&1 &
```

폴링·보고는 §2와 같다. 재진입 체크리스트(미해소 게시 시도 `--retry`, `repair_failed` 정지, 재게시, 코치 owner 교대, 플레이어 세션 복원/재생성, 종료 국면이면 플레이어 probe 생략)는 전부 사이드카가 기계적으로 밟는다 — 딜러가 손으로 할 일은 없다.

`loop-state.json`도 엔진 상태도 없으면 재개할 게임이 아니다. 사이드카가 `NO_GAME`으로 거부하므로, 새 게임을 시작할지 사용자에게 묻는다.

---

## 6. 중단·롤백

사용자가 게임을 접겠다고 하면 사이드카를 먼저 정지하고(아래 1단계와 같이 identity 재검증 → SIGTERM → 사망 확인) 중단을 마킹한다.

```bash
node engine/cli.js end --result abort --game-dir game
```

**이 변경을 되돌리거나(revert) 새 버전을 얹기 전에는 아래 3단계를 순서대로 밟는다.** detached 사이드카는 revert 뒤에도 메모리에 올린 코드로 계속 돌기 때문에 revert 단독으로는 부족하다.

1. **정지.** `game/loop.lock.d/`의 pid를 읽어 **pid+startTime identity를 그 행위 직전에 재검증한 뒤에만** SIGTERM을 보내고 사망을 확인한다. 불일치(pid 재사용)면 죽은 것으로 취급하고 **절대 시그널하지 않는다.** 사이드카 사망 확인 후 `game/lock.json`을 다시 읽어 그 `serverPid`를 정지한다(순서는 사이드카 → 서버. 반대로 하면 사이드카가 새 서버를 띄운다).
2. **미해소 게시 해소.** `game/.publish-attempt.json`이 남아 있으면 `node tools/publish.js --from <그 시도의 envelope> --game-dir game --retry`로 끝낸다. 코치 pending Q(`game/.coach-authority.json`의 `publishQueue`)는 게시하거나 그대로 보존한다 — `node tools/coach-control.js rollback-guard --game-dir game`이 `ROLLBACK_REFUSED`를 주는 동안에는 보존이 맞다.
3. **그 다음에** `git revert`. "revert로 충분"은 정지 확인이 끝난 **quiescent** 게임에만 성립한다.

종료 정리가 실패하면(`loop-state.json`에 `cleanupFailedAt`·`cleanupError`가 남고 프로세스가 비정상 종료) 그 프로세스는 이미 끝났으므로 **같은 프로세스에서 재시도되지 않는다.** 복구는 **새 `--resume` 프로세스**가 한다 — 락·서버·미해소 게시를 다시 들고 정리한다. 원인(자식 종료 미확인·디스크 오류 등)을 먼저 해소한 뒤 §5의 `--resume`을 띄운다.

---

## 7. 호스트 어댑테이션

기동·폴링·보고 문면은 호스트 중립이다. 갈리는 것은 `--player-runtime` 값과 종료를 어떻게 알아채느냐 둘뿐이다.

| 호스트 | `--player-runtime` | 기동 | 종료 인지 |
|---|---|---|---|
| Claude Code | `Claude Code=claude` | §2 문면. `run_in_background` Bash로 띄우면 종료 시 자동 보고(권장) | 자동 wake 또는 사용자 질의 시 `loop-state.json` 읽기 |
| Codex | `Codex=codex` | §2 문면 그대로 | 사용자 질의 시 `loop-state.json` 읽기 (UI 리뷰 오버레이가 1차 통지) |
| Grok | `Grok=grok` | §2 문면 그대로 | 동일 |

`--player-runtime`은 **딜러가 명시해야 하는 인자다.** detached 노드 프로세스는 자기를 띄운 호스트를 추론할 수 없으므로, 각 호스트의 딜러가 위 값을 넣는 것이 "기본 런타임 = 시작 호스트"의 유일한 캐리어다. 빠뜨리면 사이드카가 폴백 사다리(claude → codex → grok)의 첫 적격 런타임을 쓰고 `notices`에 남긴다 — 게임은 진행되지만 사용자가 의도한 런타임이 아닐 수 있다.

호스트별 플레이어 에이전트 정의 파일은 없다. 플레이어 프롬프트 정본은 `tools/player-prompt.md` 한 곳이고, 회신 규약은 "JSON 한 줄을 최종 출력으로" 하나다.

---

## 딜러가 쓰는 명령 전부

| 명령 | 역할 |
|---|---|
| `node engine/cli.js resume-check --game-dir game` | 사전 점검·resume 분기 (`serverPidAlive`·`loopPidAlive` 동격, `archiveStatus`) |
| `node tools/game-loop.js --game-dir game --ai <n> …` | 새 게임 기동 (§2) |
| `node tools/game-loop.js --game-dir game --resume …` | 재개 기동 (§5) |
| `node engine/cli.js end --result abort --game-dir game` | 중단 마킹 (§6) |
| `node tools/publish.js … --retry` · `node tools/coach-control.js rollback-guard` | 롤백 2단계에서만 (§6) |

관찰 지점: `game/loop-state.json`(phase·port·sessionToken·archivedTo·notices·metrics·halt·finishedAt), `game/loop.log`(사이드카 로그), `/tmp/ai-holdem-boot.log`(부트 크래시 안전망). 엔진 상태(`game/state.json`)와 게시 경로는 딜러가 열지 않는다.
