# AI 홀덤

스킬 정본: `.agents/skills/start-game/SKILL.md`

**새 `start game` 요청은 `tools/app-service.js`로 웹 로비를 연다.** 모드·AI 수 선택과 시작, 일시정지·재개·재시작·종료는 웹 UI에서 처리한다. 온라인 세션은 공개 포트 8899의 참가 링크를 쓰고, 멀티 게임은 앱으로만 재개한다. 앱 서비스는 동일 프로세스에서 하나의 game-loop를 호스팅한다. 기존 standalone 직접 실행/재개 경로는 정본 스킬의 legacy 절차를 사용한다.

**게임 루프는 `tools/game-loop.js`가 소유한다.** 부트스트랩(loop 락 → `init` → 서버)부터 핸드 안 액션, 코치, 종합 리뷰, 종료까지 앱이 호스팅하는 loop 또는 legacy detached 노드 프로세스가 전부 한다. 딜러 세션이 하는 일은 사전 점검 → 앱 로비 기동 → 보고 셋뿐이고, 핸드 안 딜러 LLM 라운드는 0회다.

새 `--store-dir` 게임은 cash-training·AI 5명·100BB·20핸드·policy v2·showdownPolicy=open·replayReveal=all이 기본이다. 옵션 `--showdown-policy open|standard`, `--replay-reveal all|showdown`. 로그 탭의 복기 뷰와 액션 바의 의도 메모를 쓴다. export는 쇼다운 카드만 싣는다. 명시한 `--opponent-runtime llm`, `--mode tournament`, `--mirror-self`·`--exploit-self`, AI 수·스택·블라인드·핸드 수를 보존한다. mode 없는 `--stack`/`--level-every`는 기존 토너먼트 설정이며, resume과 legacy `--game-dir`에는 새 기본값을 적용하지 않는다. policy 게임은 플레이어 LLM 없이 실행하고 상위 모델만 코치·리뷰 용도로 검사한다. 적격 상위 모델이 없으면 LLM 설명 불가를 알리고 사실 기반 기계 피드백을 남긴다.

학습 서비스(`tools/study-service.js`)는 store마다 별도 수명·토큰을 가진다. 게임 relay가 종료되어도 study가 유지되며, 다음 게임은 검증된 같은 서비스를 재사용한다. 열기는 `npm run study -- /absolute/store`, 정지는 `npm run study:stop -- /absolute/store`다. URL과 descriptor의 토큰은 공유하지 않는다. 학습 수치는 휴리스틱 기준표 비교이며 실제 포커 실력·수익·GTO 정답의 증명이 아니다. v2 정책과 원본 이벤트를 보존하고, 구버전으로 강제 변환하지 말고 호환 버전으로 roll-forward한다. 미해소 액션의 엔진 결과부터 확인한 뒤 복구한다.

LLM 모드의 플레이어와 LLM 코치·evaluator·종합자는 사이드카가 부르는 **무도구 LLM CLI 자식**이다(`tools/player-runtime.js`). 기본 policy 플레이어는 로컬 정책으로 결정한다. 호스트의 서브에이전트 스폰 경로는 쓰지 않으며, 호스트별 플레이어 정의 파일도 없다 — LLM 플레이어 프롬프트 정본은 `tools/player-prompt.md` 하나이고 회신 규약은 "JSON 한 줄을 최종 출력으로"다.

호스트가 갈리는 지점은 **`--player-runtime` 값 하나**다: Claude Code=claude, Codex=codex, Grok=grok. 기동 문면과 폴링·보고는 호스트 중립이며 정본은 스킬 §2·§7이다.

## 호스트 경로

- **Claude Code:** `.claude/skills/start-game` → `../../.agents/skills/start-game` 심볼릭 링크.
- **Codex:** 공식 저장소 스킬 경로는 `.agents/skills/`(CWD부터 리포 루트까지 스캔). 이 머신 `~/.codex/`에는 프로젝트 스킬 오버라이드가 없다. 일부 문서의 `.codex/skills/`는 심볼릭 디렉터리를 무시하므로 브리지 링크를 두지 않는다 — 이 포인터가 Codex 산출물이다.
- **Grok:** `.grok/skills/start-game` → 같은 정본 심볼릭 링크. Grok는 `.agents/skills/`도 네이티브 스캔한다.
- **Windows:** `core.symlinks=false`면 위 링크가 일반 파일/빈 경로로 풀릴 수 있다. git config를 바꾸지 말고 정본 `.agents/skills/start-game/SKILL.md`를 읽는다. 사이드카 identity는 POSIX `ps`/`lsof`가 아니라 플랫폼 어댑터다.


새 로비 게임의 진행 속도는 `normal`(보통)이며, 즉시/빠름/보통/느림을 선택한다. resume과 같은 설정 재시작은 저장된 `pace`를 유지하고 기록이 없는 예전 게임은 `instant`다. legacy CLI의 `--pace`는 명시한 값만 적용한다.

결과 대기 건너뛰기는 단독 인간 호스트의 `POST /api/game/:gameId/skip-result`, 오래 걸리는 AI 취소는 호스트 `POST /api/app/interrupt-decision`으로 처리한다. 후자는 자식 종료 확인 후 복구 상태를 남기므로 UI에서 재시도한다. 최종 결과는 리뷰보다 먼저 표시하고 종료 후 테이블을 유지한다. 종료 요약은 호스트 `/api/game/:gameId/summary`, 참가자 `/api/p/game/:gameId/summary`이며 인증·세대·완료 상태를 검사한다. `metrics`는 최근 5,000건, 폐기 누계는 `metricsDropped`다. 진단 이력은 기존 loop-state로 재개하면 유지된다. loop-state가 없어 재구성한 경우에는 `metrics`와 `metricsDropped`가 0부터 시작하므로, 폐기 누계가 0이어도 게임 전체 표본이라고 단정하지 않는다. 참가 요청 주소 목록은 1,024개 초과 시 60초가 지난 항목을 청소하며 활성 주소 수의 하드 상한은 아니다.

테이블 전체 JEV는 `--opponent-runtime jev` 또는 로비 상세 설정에서 선택한다. Node 내부 `tools/jev-runtime.js`가 TypeSafe SDK로 `jev-1.13.0`을 호출하고 모든 AI 좌석에 적용한다. 인간 좌석은 유지하고 플레이어 CLI 세션은 만들지 않는다. 코치·리뷰는 기존 상위 런타임이다. 신규 게임은 config.opponentRuntime/jev를 최초 저장에 고정하고 재개·재시작에서 일치 검사한다. JEV 입력은 행동자의 패와 익명화한 공개 정보만 포함한다. 실패는 명시적 재시도/종료, HTTP 종료 미확인은 락 보존과 재시도 차단이다. 진행 중 JEV store의 구버전 downgrade는 금지한다. 실제 테스트는 별도 임시 store를 사용한다.
