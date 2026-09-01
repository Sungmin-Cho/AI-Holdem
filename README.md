# AI 홀덤

AI 에이전트 여럿과 브라우저에서 두는 노리밋 텍사스 홀덤이다. 사람이 한 자리에 앉고 나머지 좌석은 페르소나를 가진 LLM이 채운다. 핸드가 끝날 때마다 코치가 방금 플레이를 짚어 주고, 게임이 끝나면 전체 리뷰가 나온다.

요구: Node ≥ 20, 외부 npm 의존성 없음. 플레이어 런타임은 Claude Code · Codex · Grok을 지원한다.

## 어떻게 생겼나

세 프로세스가 각각 아는 것이 다르다.

- **엔진**(`engine/`) — 덱·핸드 전이·사이드팟·핸드 평가. 네트워크도 LLM도 모른다.
- **사이드카**(`tools/game-loop.js`) — 게임 진행 전체를 소유하는 detached 노드 프로세스. 부트스트랩부터 핸드 안 액션 루프, 워치독, 코치, 종합 리뷰, 종료까지.
- **서버**(`server/`) — SSE와 액션 대기만 중계한다. 게임 규칙을 모른다.

계층 경계와 불변식은 [`ARCHITECTURE.md`](ARCHITECTURE.md)에 있다.

Preflop 학습 평가는 `training/`에 있다. MVP는 6-max 100BB frequency-only baseline이며 EV 숫자는 만들지 않는다. `--store-dir` 세션은 핸드 종료 후 평가를 게시하고 UI 학습 탭에 표시한다. 장기 skill profile은 `<store>/.training/`에 남고 `node tools/profile-cli.js apply|rebuild|show|reset|sweep --store-dir game`으로 관리한다. 스팟 드릴은 `node tools/drill-cli.js start --store-dir game --mode leak|mistake-review|daily|free` 또는 `node server/drill-server.js --store-dir game`(게임 세션 토큰과 다른 전용 토큰)이다. 핸드 히스토리 export는 `node tools/export-hh.js --game-dir <session|archive> --format canonical-json|pokerstars --out <path>`. PLAY 칩·synthetic ID이며 상용 사이트 핸드를 위조하지 않는다. 이미 있는 파일·symlink는 덮어쓰지 않는다. 레거시 `--game-dir`에서는 training이 꺼진다. 데이터 출처는 [`training/data/README.md`](training/data/README.md).

## 왜 사이드카인가

이전 구조에서는 딜러 역할을 맡은 LLM 세션이 루프를 직접 돌렸다. AI 한 명이 액션할 때마다 딜러 LLM 왕복이 한 번씩 끼어들었고, 그게 게임 속도를 지배했다. 지금은 그 루프가 노드 프로세스 안으로 들어갔다.

| 기준 | 값 |
|---|---|
| 핸드 안 AI 액션 경로의 딜러 LLM 라운드 | **0회** |
| 남는 지연 | 플레이어 CLI 왕복 1회 + 노드 오버헤드 |
| 사이드카 오버헤드(`parseMs+stepMs+publishMs`, LLM 제외) | ≤ 1s/액션 |

부수 효과가 더 크다. 사이드카는 detached라 **딜러 세션이 죽어도 게임은 계속 돈다.** 호스트 세션이 하는 일은 사전 점검 → 기동 → 보고 셋뿐이다.

판정 근거는 지어내지 않는다. 사이드카가 모든 AI 결정을 선택된 session의 `loop-state.json` `metrics`에 `{playerId, decisionId, runtime, outcome, elapsedMs, modelMs, parseMs, stepMs, publishMs}`로 남긴다. `outcome`이 `forced_default`(워치독 타임아웃)인 결정도 소요 시간 그대로 분포에 들어간다 — 타임아웃을 분포에서 숨기지 않는다.

## LLM은 어디에만 있나

플레이어 결정·코치 노트·종합 리뷰 셋뿐이다. 전부 `tools/player-runtime.js`가 부르는 **무도구 CLI 자식**이고, 이 파일이 LLM을 부르는 유일한 표면이다. 플레이어는 CLI 세션 resume으로 대화 하나를 게임 내내 이어 가서 자기 페르소나를 기억한다. 프롬프트 정본은 `tools/player-prompt.md` 한 곳이고, 회신 규약은 "JSON 한 줄을 최종 출력으로"다.

**컨테인먼트**가 이 설계의 핵심이다. 자식은 도구 없이, 레포와 `game/` 밖의 빈 임시 디렉터리에서, `HOME`/`PATH`만 상속한 채 돈다. 프롬프트는 stdin으로만 가고 argv에 실리는 런타임 값은 세션 id 하나뿐이다. 플레이어 에이전트가 남의 홀카드를 파일에서 읽어 오는 경로 자체를 없앤 것이다. 기동할 때마다 게임 디렉터리에 카나리를 심어 자식이 그걸 읽어 오지 **못하는지** 부정 검증하고, 읽어 오면 그 런타임은 부적격 처리한다.

| 런타임 | 플레이어 모델 | 상위 모델(코치·evaluator·종합자) | 워치독 1차/재전송 |
|---|---|---|---|
| `claude` | `haiku` | `opus` | 25s / 15s |
| `codex` | `gpt-5.6-luna` | `gpt-5.6-sol` | 25s / 15s |
| `grok` | `grok-4.6` | `grok-4.6` | 60s / 30s |

기본 런타임은 `/start-game`을 실행한 호스트이고, 딜러가 `--player-runtime`으로 명시한다. 플레이어 모델 왕복이나 컨테인먼트 검증에 실패한 런타임은 부적격이 되어 폴백 사다리(claude → codex → grok)가 돌고, 상위 모델만 실패하면 플레이어와 코치·리뷰를 다른 런타임으로 갈라 쓴다. 전부 부적격이면 게임을 시작하지 않는다(`halt.code = NO_PLAYER_RUNTIME`).

## 시작하기

저장소 루트에서.

### 스킬 (권장)

이 저장소에서 Claude Code 세션을 열고 `/start-game` (AI 1~8명, 기본 3). 옵션 `--stack N`, `--level-every N`, `--blinds SB/BB`. cash-training은 `--mode cash-training --stack-bb 100 --hands N`을 `--store-dir game` 기동에 붙인다. 중단 재개는 `/start-game resume`.

절차 정본은 [`.agents/skills/start-game/SKILL.md`](.agents/skills/start-game/SKILL.md), 호스트 포인터는 [`AGENTS.md`](AGENTS.md)다.

### 사이드카 직접 기동

스킬 없이 같은 게임을 띄울 때. `init`과 서버 기동은 사이드카가 하므로 직접 부르지 않는다.

```bash
nohup node tools/game-loop.js --store-dir game --ai 3 --player-runtime claude \
  > /tmp/ai-holdem-boot.log 2>&1 &
# game/.session-store/current.json의 sessionRel을 해석한 concrete session의
# loop-state.json을 폴링해 phase가 bootstrap을 지나면 port·sessionToken으로
open "http://127.0.0.1:<port>/?token=<t>"
```

재개는 `--ai` 대신 `--resume`.

### 엔진·서버만 (LLM 없이, legacy 개발 디렉터리)

session store root인 `game/`에는 engine `init`을 직접 실행하지 않는다. 독립 임시 directory를
`--game-dir`로 명시한 legacy 개발 흐름만 허용하며 production은 위 사이드카 명령을 쓴다.

## 게임 중에 볼 것

선택된 `game/.session-store/sessions/<gameId>/loop-state.json` 하나다. phase·port·notices·`metrics`·halt가 전부 여기 모인다.

새 게임은 처음부터 `game/.session-store/sessions/<gameId>/`에 생성된다. 다음 게임을
시작해도 이전 session directory를 archive로 이동·복사·삭제하지 않는다.
engine init 뒤 runtime/server 기동이 실패해도 그 새 session은 current로 남아 `--resume`으로
재시도한다. current가 가리키는 directory는 수동 삭제하지 않는다. `.<gameId>.creating`은
init 실패 보존물이며 자동 선택되지 않는다.

활성 게임의 정의는 **선택된 session의 서버 pid와 store loop 락 pid 동격**이다.
`resume-check --game-dir "$SESSION_DIR" --lock-dir game`가 둘을 함께 보고한다. store MVP의
`--force`는 `FORCE_UNAVAILABLE`이며, 먼저 기존 게임을 정상 정지·재개해야 한다.

`game/`은 gitignore 런타임 store다. 엔진 상태는 선택된 concrete session 아래에만 있다.

## 끝날 때와 이어서 할 때

게임이 끝나면(`gameOver` 또는 사용자 bust) 사이드카가 phase 체크포인트를 밟는다.

```
playing → finalizing → review_generated → review_published → done
```

- **finalizing** — 마지막 핸드 코치를 재-reserve하지 않고 20초 절대 예산 안에서 정리하고, 잔여 pending 게시를 비운다.
- **review_generated** — evaluator(redacted 트레이스+stats만) → 종합자(evaluator 출력+결과+아키타입 공개)로 리뷰를 만들고 선택된 session의 `review.md`와 그 sha256을 **먼저** 기록한다. 이후 재개는 재생성하지 않고 이 산출물을 재사용한다. 두 번 실패하면 리뷰를 지어내지 않고 `halt.code = REVIEW_FAILED`다.
- **review_published** — 게시 전에 `ui-snapshot.json`의 review digest를 대조해 이중 게시를 생략한다.
- **done** — 세션·adapter·서버 정리가 성공한 뒤 `finishedAt`과 `phase: "done"`을 기록하고 exit 0.

**종료 코드로 완료를 판정하지 마라.** 종료 코드 `0`은 SIGTERM을 포함한 정상 프로세스 정리이며 게임 완료를 뜻하지 않는다. 완료는 오직 `phase: "done"` + `finishedAt`이다. 비정상 종료 코드는 `2` repair_failed/USAGE, `3` REVIEW_FAILED, `4` NO_PLAYER_RUNTIME, `5` 기타 halt다.

`--resume`은 **어떤 경로에서도 `init`을 부르지 않는다.** 기록된 phase부터 멱등 재개하고, 종료 국면이면 플레이어 probe·워밍업을 생략한다. 재개 여부의 분기는 `loopPidAlive` 하나다 — 참이면 사이드카를 다시 띄우지 않고 attach해 관찰만 하고, 거짓일 때만 `--resume`으로 기동한다. 종료 정리가 실패하면(`cleanupFailedAt`) 그 프로세스는 이미 끝났으므로 복구는 새 `--resume` 프로세스가 한다.

## 테스트

```bash
node --test
```

인자 없이 실행한다. **`node --test test/`처럼 디렉터리 인자를 주면 Node v26에서 실패하므로 금지.** 단건은 `node --test test/<파일>.test.js`.

CI는 프로세스·락 통합 테스트끼리의 교차 부하를 피하기 위해 테스트 파일만 직렬화하는 `npm run test:ci`를 사용한다. 각 테스트가 내부에서 만드는 동시성·race는 그대로 검증한다.

`test/tempo-skill-contract.test.js`는 코드가 아니라 **문서 문면**을 검사한다. 이 README와 `AGENTS.md`, 스킬 정본이 옛 딜러 루프를 다시 가리키지 않도록 고정하는 계약이라, 문서를 고치면 이 테스트를 함께 돌려야 한다.

## 문서 지도

| 문서 | 담당 |
|---|---|
| `README.md` | 이 문서 — 프로젝트 소개와 실행 |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | 소유권 경계, 계층 규칙, 아키텍처 불변식 |
| [`AGENTS.md`](AGENTS.md) | 호스트 중립 에이전트 지침과 호스트별 스킬 경로 |
| [`CLAUDE.md`](CLAUDE.md) | Claude Code 고유 사항 (`AGENTS.md`를 import) |
| [`.agents/skills/start-game/SKILL.md`](.agents/skills/start-game/SKILL.md) | 딜러 절차 정본 (SSOT) |

## 라이선스

[Apache License 2.0](LICENSE)에 따라 사용할 수 있다.
