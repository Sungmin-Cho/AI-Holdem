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

사용법: `/start-game [AI수 1~8]` (옵션 `--stack N`, `--level-every N`, `--blinds SB/BB`, `--mode cash-training`, `--stack-bb N`, `--hands N`, `--opponent-runtime llm|policy`). 기본 AI 3명(4인 테이블). 중단 재개: `/start-game resume`.

저장소 루트에서 실행. `game/`은 런타임 상태(gitignore)이고 사이드카·엔진만 쓴다.

## 절대 규약

- **게시는 `tools/publish.js`만 한다.** 그 도구만이 `visibility==="public"` 필터와 `publishId` 증가를 책임진다. 딜러는 게시하지 않는다 — 사이드카가 한다.
- **모델이 만든 문자열을 셸 인자에 넣지 않는다.** 사이드카는 프롬프트를 stdin으로, 본문을 파일로만 흘린다. 딜러가 남기는 모델 유래 문자열은 practiceFocus 파일 하나뿐이고, argv에는 그 **경로만** 넘긴다.
- 사용자 노출 문자열은 한국어. 아키타입·스타일·비공개 홀카드는 종합 리뷰 전까지 공개하지 않는다 — 이 불변식도 사이드카가 지킨다.
- 게임은 멈추지 않는다(워치독·사용자 무제한 대기·서버 자가치유는 전부 사이드카 소관). 예외는 **기동 전 실패** 하나다 — 적격 플레이어 런타임이 없으면 게임을 시작하지 않는다.

---

## 1. 사전 점검

1. `node --version` — major ≥ 20이어야 한다. 미달이면 중단하고 사용자에게 알린다.
2. **영구 세션**: 새 게임은 `game/.session-store/sessions/<gameId>/`에 처음부터 생성된다. 이전 세션은 다음 init 때 이동·복사·삭제되지 않는다. 이번 MVP에서는 이전 review 자동 전달은 하지 않는다.
3. **잔여 게임 판정** — `game/`에 상태가 남아 있으면:

```bash
if [ -f game/.session-store/current.json ]; then
  SESSION_DIR=$(node -e 'const fs=require("fs"),p=require("path"); const c=JSON.parse(fs.readFileSync("game/.session-store/current.json")); process.stdout.write(p.join("game/.session-store",c.sessionRel))')
  node engine/cli.js resume-check --game-dir "$SESSION_DIR" --lock-dir game
else
  echo '{"ok":true,"current":null}'
fi
# {ok, serverPidAlive, loopPidAlive, port, sessionToken, stateVersion, phase, toAct,
#  archiveRepaired, archiveStatus: "healthy"|"repaired"|"repair_failed"}
```

`serverPidAlive`와 `loopPidAlive`는 **동격**이다 — 둘 중 하나라도 참이면 활성/잔여 게임이다. 하나라도 참이면 **사용자에게 묻는다**: 이어서 할지(§5) vs 새 게임. 추측으로 기동하지 마라.

`archiveStatus`가 `repair_failed`면 그 사실을 사용자에게 먼저 알린다. 그 핸드 기록은 코치·리뷰가 읽을 수 없다.

---

## 2. 시작

인자가 없으면 AI 수 `n=3`. 범위 1~8. `--stack`(기본 5000), `--level-every`(기본 8), `--blinds`는 사용자 요청이 있을 때만. cash-training은 `--mode cash-training --stack-bb 100 --blinds 50/100 --hands N`처럼 `--store-dir` 기동에 붙인다. store 루트를 `--game-dir`로 주면 `BAD_DIRECTORY_MODE`다. 장기 skill profile은 `game/.training/`이며 `node tools/profile-cli.js show --store-dir game`으로 본다.

`init`·서버 기동·페르소나 생성·브라우저 URL 확보는 전부 사이드카가 한다. 딜러는 이 한 줄만 친다.

```bash
nohup node tools/game-loop.js --store-dir game --ai <n> \
  --player-runtime <이 호스트의 값: Claude Code=claude, Codex=codex, Grok=grok> \
  [--stack N] [--level-every N] [--blinds SB/BB] \
  [--mode cash-training] [--stack-bb N] [--hands N] [--opponent-runtime llm|policy] \
  > /tmp/ai-holdem-boot.log 2>&1 &
```

살아 있는 게임이 있으면 사이드카가 `ACTIVE_GAME`으로 즉시 종료한다. session-store MVP의
`--force`는 `FORCE_UNAVAILABLE`로 fail-closed하므로 먼저 기존 게임을 정상 정지/재개한다.

current가 생기면 `game/.session-store/current.json`의 `sessionRel`을
`game/.session-store/<sessionRel>`에 결합해 `SESSION_DIR`로 고정한다. 그다음 약 250ms
간격으로 `$SESSION_DIR/loop-state.json`과 아래 명령을 함께 폴링한다.

```bash
node engine/cli.js resume-check --game-dir "$SESSION_DIR" --lock-dir game
```

**종료 조건은 벽시계가 아니라 셋 중 하나다:**

1. `halt` 기록 — 기동 실패다. `halt.code`·`message`와 `/tmp/ai-holdem-boot.log`를 보고 중단한다.
2. `phase`가 `bootstrap`을 지남(`playing` 이후) — 정상 기동이다.
3. `resume-check`의 **`loopPidAlive:false`** — 사이드카 pid가 사망했다. `/tmp/ai-holdem-boot.log`를 보고 중단한다.

런타임 probe 사다리(런타임 × 플레이어/상위 모델/컨테인먼트, grok 콜드 1회 ~25s)가 있어 부트가 수십 초를 넘을 수 있다. **pid가 살아 있는 한 "기동 중"으로 보고하고 계속 기다린다** — 중단하거나 `--force`로 다시 띄우지 마라.

2번에 도달하면 `loop-state.json`의 `port`·`sessionToken`으로 브라우저를 연다.

```bash
open "http://127.0.0.1:<port>/?token=<sessionToken>"
```

macOS `open`. 브라우저가 없으면 URL을 사용자에게 보여 준다.

마지막으로 선택된 `gameId`와 영구 `SESSION_DIR`을 보고하고, `notices`에 항목이 있으면 각각을 **한 줄씩** 사용자에게 보고한다. 새 init의 `archivedTo`는 더 이상 사용하지 않는다.
engine init 뒤 runtime/server 기동이 실패한 경우에도 새 session이 current로 남으므로,
오류를 고친 뒤 `/start-game resume`으로 같은 gameId를 재시도한다.

---

## 3. 게임 중

**딜러는 개입하지 않는다.** 핸드 안 AI 액션 경로의 딜러 LLM 라운드는 **0회**이고, 그것이 이 구조의 성공 기준이다. 액션 전달·워치독·코치 스폰·게시·서버 재기동은 전부 사이드카가 한다.

사용자가 진행 상황을 물으면 **선택된 `$SESSION_DIR/loop-state.json`을 한 번 읽고** 답한다: `phase`, `handNo`, `notices`, 그리고 결정별 `metrics`(`{playerId, decisionId, runtime, outcome, elapsedMs, modelMs, parseMs, stepMs, publishMs}`) 요약. `outcome`이 `forced_default`인 결정이 잦으면 워치독이 자주 걸린다는 뜻이니 한 줄로 알린다. 상세 로그는 `$SESSION_DIR/loop.log`다.

---

## 4. 종료 보고

종료까지 관찰할 때의 관찰 종료 조건도 셋이다: `phase`가 done, `halt` 기록, `resume-check.loopPidAlive:false`. exit 0은 SIGTERM을 포함한 **정상적인 프로세스 정리**일 뿐 게임 완료 증명이 아니다. 완료는 오직 `loop-state.json`의 `phase:"done"`과 `finishedAt`으로 판정한다. 정상 완료면 종합 리뷰가 UI 오버레이로 게시돼 있고 본문이 `$SESSION_DIR/review.md`에 있다 — 사용자에게 리뷰가 준비됐다는 것과 '다음 게임에서 연습할 것' 항목을 한 줄로 전한다.

`halt`가 기록돼 있으면 `halt.code`로 분기해 **한 줄씩** 안내한다.

| `halt.code` | 사용자 안내 |
|---|---|
| `REVIEW_FAILED` | 게임은 끝났고 상태·코치 노트는 온전하지만 종합 리뷰 생성이 두 번 실패했습니다. 상위 모델 CLI 인증을 확인한 뒤 `/start-game resume`으로 리뷰 단계부터 다시 시도합니다 |
| `repair_failed` | 직전 핸드 아카이브를 쓰지 못해 멈췄습니다. 그 핸드는 코치·리뷰가 읽을 수 없습니다. `$SESSION_DIR/hands/` 상태를 확인해야 합니다 |
| `NO_PLAYER_RUNTIME` | 적격 플레이어 런타임이 하나도 없어 게임을 시작(또는 재개)하지 않았습니다. `notices`의 probe 실패 내역대로 CLI 인증·설치를 고친 뒤 다시 시도합니다 |
| `TRAINING_MIGRATION_CORRUPT` | training authority 마이그레이션 증거가 불완전해 재개 전에 멈췄습니다. `message`가 지목한 authority·digest map·JSONL·attempt 파일을 복구한 뒤 `/start-game resume`으로 다시 시도합니다 |

그 밖의 `halt.code`는 코드와 `message`를 그대로 전하고 `$SESSION_DIR/loop.log`를 가리킨다. 딜러가 원인을 추측해 지어내지 않는다.

---

## 5. resume

`/start-game resume` 또는 사전 점검에서 이어하기를 고른 경우. **분기는 `resume-check`의 `loopPidAlive` 하나다.**

- **`loopPidAlive: true` → attach.** 사이드카를 **다시 띄우지 않는다**(loop 락이 살아 있는 선점자를 거부하므로 이것이 유일한 정상 경로다). `loop-state.json`을 읽어 "게임 진행 중"과 `phase`·`handNo`를 보고하고, 사용자가 원하면 §4처럼 종료까지 관찰만 한다. 브라우저가 닫혔으면 `port`·`sessionToken`으로 다시 열어 준다.
- **`loopPidAlive: false` → `--resume` 기동.** 새 게임 기동과 같은 문면이되 `--ai`·`--force` 자리에 `--resume`이 온다.

```bash
nohup node tools/game-loop.js --store-dir game --resume \
  --player-runtime <이 호스트의 값: Claude Code=claude, Codex=codex, Grok=grok> \
  > /tmp/ai-holdem-boot.log 2>&1 &
```

폴링·보고는 §2와 같다. 재진입 체크리스트(미해소 게시 시도 `--retry`, `repair_failed` 정지, 재게시, 코치 owner 교대, 플레이어 세션 복원/재생성, 종료 국면이면 플레이어 probe 생략)는 전부 사이드카가 기계적으로 밟는다 — 딜러가 손으로 할 일은 없다.

`loop-state.json`도 엔진 상태도 없으면 재개할 게임이 아니다. 사이드카가 `NO_GAME`으로 거부하므로, 새 게임을 시작할지 사용자에게 묻는다.

---

## 6. 중단·롤백

사용자가 게임을 접겠다고 하면 사이드카를 먼저 정지하고(아래 1단계와 같이 identity 재검증 → SIGTERM → 사망 확인) 중단을 마킹한다.

```bash
node engine/cli.js end --result abort --game-dir "$SESSION_DIR"
```

**이 변경을 되돌리거나(revert) 새 버전을 얹기 전에는 아래 3단계를 순서대로 밟는다.** detached 사이드카는 revert 뒤에도 메모리에 올린 코드로 계속 돌기 때문에 revert 단독으로는 부족하다.

1. **정지와 lifecycle 선행 복구.** 정지 전에 `$SESSION_DIR/loop-state.json`의 `port`·`sessionToken`을 보관한다. loop lock은 session 디렉터리가 아니라 `--store-dir`의 **store root**인 `game/loop.lock.d/`가 소유한다. 그 pid+startTime identity를 직전에 재검증한 뒤에만 SIGTERM을 보내고 사망을 확인한다. 불일치면 절대 시그널하지 않는다. `phase_incomplete`는 새 `--resume`으로 finalizing/review lifecycle을 완주하고, `cleanup_error`는 원인을 해소한 뒤 새 `--resume`을 띄워 SIGTERM 정지를 다시 완주한다. 이 두 reason을 relay drain보다 먼저 해소한다.
2. **미해소 게시 해소.** 보관한 port·sessionToken으로 `node server/server.js --game-dir "$SESSION_DIR" --port <port> --token <sessionToken>` 임시 relay를 띄우고 기동 즉시 `RELAY_PID=$!`와 `RELAY_START_TIME=$(ps -p "$RELAY_PID" -o lstart=)`를 캡처한 뒤 token-authenticated snapshot을 확인한다. `.publish-attempt.json`은 `publish.js --retry`, pending Q인 `publishQueue`는 하나의 `DEADLINE_NS`로 drain한다. `rollback-guard`의 reason은 `attempt_pending`, `active_hands`, `publish_queue`, `retired_unresolved`, `retired_reclaimable`, `retired_unreclaimed`, `coach_authority_missing`, `coach_authority_unreadable`, `cleanup_error`, `phase_incomplete`, `loop_state_unreadable`다. **`{"ok":true}`**일 때만 계속한다. relay 종료 직전 `ps -p "$RELAY_PID" -o lstart=`를 다시 읽어 `$RELAY_START_TIME`과 일치할 때만 kill한다. relay identity 불일치 시 kill 금지다.
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
| `node engine/cli.js resume-check --game-dir "$SESSION_DIR" --lock-dir game` | 사전 점검·resume 분기 (`serverPidAlive`·`loopPidAlive` 동격, `archiveStatus`) |
| `node tools/game-loop.js --store-dir game --ai <n> …` | 영구 session 새 게임 기동 (§2) |
| `node tools/game-loop.js --store-dir game --resume …` | current session 재개 기동 (§5) |
| `node engine/cli.js end --result abort --game-dir "$SESSION_DIR"` | 중단 마킹 (§6) |
| `node tools/publish.js … --retry` · `node tools/coach-control.js rollback-guard` | 롤백 2단계에서만 (§6) |

관찰 지점: `$SESSION_DIR/loop-state.json`(phase·port·sessionToken·notices·metrics·halt·finishedAt), `$SESSION_DIR/loop.log`(사이드카 로그), `/tmp/ai-holdem-boot.log`(부트 크래시 안전망). 엔진 상태와 게시 경로는 딜러가 열지 않는다.
