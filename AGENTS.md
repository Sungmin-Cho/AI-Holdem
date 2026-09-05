# AI 홀덤

스킬 정본: `.agents/skills/start-game/SKILL.md`

**게임 루프는 사이드카(`tools/game-loop.js`)가 소유한다.** 부트스트랩(loop 락 → `init` → 서버)부터 핸드 안 액션, 코치, 종합 리뷰, 종료까지 그 detached 노드 프로세스가 전부 한다. 딜러 세션이 하는 일은 사전 점검 → 사이드카 기동 → 보고 셋뿐이고, 핸드 안 딜러 LLM 라운드는 0회다.

플레이어·코치·evaluator·종합자는 사이드카가 부르는 **무도구 LLM CLI 자식**이다(`tools/player-runtime.js`). 호스트의 서브에이전트 스폰 경로는 쓰지 않으며, 호스트별 플레이어 정의 파일도 없다 — 플레이어 프롬프트 정본은 `tools/player-prompt.md` 하나이고 회신 규약은 "JSON 한 줄을 최종 출력으로"다.

호스트가 갈리는 지점은 **`--player-runtime` 값 하나**다: Claude Code=claude, Codex=codex, Grok=grok. 기동 문면과 폴링·보고는 호스트 중립이며 정본은 스킬 §2·§7이다.

## 호스트 경로

- **Claude Code:** `.claude/skills/start-game` → `../../.agents/skills/start-game` 심볼릭 링크.
- **Codex:** 공식 저장소 스킬 경로는 `.agents/skills/`(CWD부터 리포 루트까지 스캔). 이 머신 `~/.codex/`에는 프로젝트 스킬 오버라이드가 없다. 일부 문서의 `.codex/skills/`는 심볼릭 디렉터리를 무시하므로 브리지 링크를 두지 않는다 — 이 포인터가 Codex 산출물이다.
- **Grok:** `.grok/skills/start-game` → 같은 정본 심볼릭 링크. Grok는 `.agents/skills/`도 네이티브 스캔한다.
- **Windows:** `core.symlinks=false`면 위 링크가 일반 파일/빈 경로로 풀릴 수 있다. git config를 바꾸지 말고 정본 `.agents/skills/start-game/SKILL.md`를 읽는다. 사이드카 identity는 POSIX `ps`/`lsof`가 아니라 플랫폼 어댑터다.
