@AGENTS.md

# Claude Code 전용

공용 지침은 AGENTS.md를 따른다. 아래는 이 호스트에서만 다른 부분이다.

- 게임 시작·재개는 `/start-game` 슬래시 커맨드로 한다.
- `.claude/agents/`에 플레이어용 서브에이전트 정의 파일(`holdem-player.md` 등)을 만들지 마라. 플레이어·코치·평가·종합자는 사이드카가 `tools/player-runtime.js`로 직접 부르는 무도구 CLI 자식이고, Claude Code의 서브에이전트 스폰 경로는 쓰지 않는다.
