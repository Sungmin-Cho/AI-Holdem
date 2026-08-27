# AI 홀덤

스킬 정본: `.agents/skills/start-game/SKILL.md`

딜러 오케스트레이션은 그 파일 하나다. `/start-game` 또는 `/start-game resume`. 정본 게임 런타임은 Claude Code(지속 에이전트). Codex·Grok은 스킬 발견 + 저하 모드 문서화까지가 v1이다.

## 호스트 경로

- **Claude Code:** `.claude/skills/start-game` → `../../.agents/skills/start-game` 심볼릭 링크.
- **Codex:** 공식 저장소 스킬 경로는 `.agents/skills/`(CWD부터 리포 루트까지 스캔). 이 머신 `~/.codex/`에는 프로젝트 스킬 오버라이드가 없다. 일부 문서의 `.codex/skills/`는 심볼릭 디렉터리를 무시하므로 브리지 링크를 두지 않는다 — 이 포인터가 Codex 산출물이다.
- **Grok:** `.grok/skills/start-game` → 같은 정본 심볼릭 링크. Grok는 `.agents/skills/`도 네이티브 스캔한다.
