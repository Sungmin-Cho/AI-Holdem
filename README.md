# AI 홀덤

AI 에이전트 상대와 웹 UI로 즐기는 노리밋 텍사스 홀덤. 딜러는 에이전트 세션, 규칙은 순수 Node 엔진, 서버는 중계만 한다.

요구: Node ≥ 20, 외부 npm 의존성 없음. 게임 런타임은 **Claude Code · Codex · Grok** 셋 다 지원한다.

## 실행

저장소 루트에서.

### 스킬 (권장)

Claude Code 세션을 이 저장소에서 열고 `/start-game` (AI 1~8명, 기본 3). 옵션 `--stack N`, `--level-every N`. 중단 재개: `/start-game resume`.

절차 정본: [`.agents/skills/start-game/SKILL.md`](.agents/skills/start-game/SKILL.md). 호스트 포인터는 [`AGENTS.md`](AGENTS.md).

### 수동 (엔진·서버만)

플레이어 에이전트 없이 서버와 CLI만 띄울 때:

```bash
node engine/cli.js init --ai 3          # stdout의 sessionToken
nohup node server/server.js --game-dir game --port 8877 --token <t> > game/server.log 2>&1 &
# health 확인 후
open "http://127.0.0.1:8877/?token=<t>"
```

UI 시연(가짜 딜러): 서버를 `--token dev`로 띄운 뒤 `node test/helpers/dev-drive.js --port <p> --token dev`.

활성 게임이 있는데 새로 시작하려면 `init --force`. 구 서버 SIGTERM 후, 직전 판에 플레이 흔적이 있으면 `game/archive/`로 옮기고 라이브 슬롯에 새 게임을 쓴다. `archive/`는 지우지 않는다. stdout `archivedTo`가 문자열이면 사용자에게 그 경로를 한 줄로 알린다. 이어하려면 `node engine/cli.js resume-check` 후 스킬 §7 (라이브 슬롯만).

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
tools/
  publish.js            # 딜러용 게시 도구 (public 필터·publishId·사용자 액션 대기)
server/
  server.js             # 중계 (SSE, wait-action, publish, 토큰)
  public/               # 한국어 포커 테이블 UI
test/                   # node --test
  turn-contract.test.js # SKILL의 턴 명령을 문면 그대로 이어 붙인 계약 테스트
  helpers/dev-drive.js  # UI 시연용 가짜 딜러
.agents/skills/start-game/SKILL.md   # 딜러 절차 정본 (SSOT)
.claude/skills/start-game            # → 정본 심볼릭 링크
.claude/agents/holdem-player.md      # Claude Code 플레이어 에이전트 정의 (haiku)
.grok/agents/holdem-player.md        # Grok 플레이어 에이전트 정의 (grok-4.6, effort low)
.grok/skills/start-game              # → 정본 심볼릭 링크
AGENTS.md                            # Codex 등 호스트 포인터
game/                   # 런타임 (gitignore)
```

## 턴 지연

게임 속도를 지배하는 것은 모델 자체가 아니라 **딜러가 액션 하나에 도는 LLM 왕복 횟수**다. `engine/cli.js step`이 적용·뷰·다음 행동자 요약을 한 번에 돌려주고 `tools/publish.js`가 게시·대기를 맡으므로, AI 액션 1개 = 딜러 라운드 2개, 사용자 액션 1개 = 라운드 1개, 핸드 종료→다음 핸드 = 라운드 1개로 끝난다. 이 경계를 지키는 규약은 SKILL.md의 「턴 명령」과 §4·§4c에 있다.

게시 시각은 `game/ui-snapshot.json`의 `history[].at`에 남으므로 턴별 실제 지연을 사후에 측정할 수 있다.

## 구현 후 확인 체크리스트

호스트별 스킬 **인식 실측**과 첫 게임은 이 저장소를 연 세션에서 직접 확인한다(구현 세션에서는 스킬 메뉴를 검증하지 않음).

- [ ] **Claude Code:** 이 저장소에서 세션을 열고 `/start-game`이 슬래시 메뉴에 보이는지. 안 되면 폴백: `.claude/skills/start-game/SKILL.md`를 정본을 참조하는 얇은 래퍼 파일로 바꾼다(심볼릭 링크 미인식 시).
- [ ] **Codex:** `$start-game` / 스킬 목록에 `.agents/skills/start-game`이 보이는지. 안 되면 `AGENTS.md` 포인터를 읽고 그 경로의 `SKILL.md`를 연다. `.codex/skills/` 심볼릭 링크는 Codex가 심볼릭 디렉터리를 무시하므로 두지 않았다.
- [ ] **Grok:** `/start-game` 또는 `/local:start-game`이 보이는지(`.grok/skills` 또는 `.agents/skills`). 안 되면 `AGENTS.md` 포인터.
- [ ] **Claude Code 첫 게임 스모크:** `/start-game` 기본 3 AI → 브라우저가 `/?token=`으로 열리는지 → 한 핸드 이상 진행(내 액션 + AI 액션 + 로그) → 핸드 종료 후 코치 탭에 노트 → 가능하면 게임 종료 후 리뷰 오버레이와 `game/review.md`. 코치 문구에 비공개 홀카드·아키타입이 없어야 한다.
