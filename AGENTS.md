# AI 홀덤

스킬 정본: `.agents/skills/start-game/SKILL.md`

딜러 오케스트레이션은 그 파일 하나다. `/start-game` 또는 `/start-game resume`. 세 호스트(Claude Code·Codex·Grok) 모두 지속 명명 서브에이전트로 게임을 돌린다. 호스트가 갈리는 지점은 플레이어 스폰 모델과 회신 경로 둘뿐이며 스킬 §3·§8에 표로 있다.

플레이어는 저비용·저지연 티어로 스폰한다 — Claude Code `haiku`, Codex `gpt-5.6-luna`, Grok `grok-4.6`(effort `low`). 딜러 세션 모델을 상속시키면 폴드 한 번에 수십 초가 걸린다. 코치·evaluator·종합자는 반대로 **스폰 시 상위 모델을 명시한다**(상속에 기대지 않는다 — 딜러 세션이 빠른 모델일 수 있다). 정본은 스킬 §3.

## 호스트 경로

- **Claude Code:** `.claude/skills/start-game` → `../../.agents/skills/start-game` 심볼릭 링크.
- **Codex:** 공식 저장소 스킬 경로는 `.agents/skills/`(CWD부터 리포 루트까지 스캔). 이 머신 `~/.codex/`에는 프로젝트 스킬 오버라이드가 없다. 일부 문서의 `.codex/skills/`는 심볼릭 디렉터리를 무시하므로 브리지 링크를 두지 않는다 — 이 포인터가 Codex 산출물이다.
- **Grok:** `.grok/skills/start-game` → 같은 정본 심볼릭 링크. Grok는 `.agents/skills/`도 네이티브 스캔한다. 플레이어 정의는 `.grok/agents/holdem-player.md` (`grok-4.6`, effort `low`).
