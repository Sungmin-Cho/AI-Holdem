# AI 홀덤

브라우저에서 플레이하고 결정 기록을 복습하는 노리밋 텍사스 홀덤이다. 새 store 게임은 cash-training·AI 5명·100BB·20핸드·policy v2를 기본으로 한다. 각 AI는 버전이 고정된 페르소나 정책으로 결정하며, `--opponent-runtime llm`을 선택하면 무도구 LLM 플레이어가 결정한다. 적격 상위 모델이 있으면 코치와 종합 리뷰를 제공하고, 없으면 설명 불가를 알리면서 실제 기록으로 만든 기계 피드백을 남긴다.

요구: Node ≥ 20, 외부 npm 의존성 없음. 플레이어 런타임은 Claude Code · Codex · Grok을 지원한다.

## 어떻게 생겼나

게임 진행과 종료 후 학습의 소유권을 분리한다.

- **엔진**(`engine/`) — 덱·핸드 전이·사이드팟·핸드 평가. 네트워크도 LLM도 모른다.
- **사이드카**(`tools/game-loop.js`) — 게임 진행 전체를 소유하는 detached 노드 프로세스. 부트스트랩부터 핸드 안 액션 루프, 워치독, 코치, 종합 리뷰, 종료까지.
- **서버**(`server/`) — SSE와 액션 대기만 중계한다. 게임 규칙을 모른다.
- **학습 서비스**(`tools/study-service.js`) — store별 독립 프로세스에서 학습 요약·드릴을 제공한다. 게임 relay가 종료되어도 유지된다.

계층 경계와 불변식은 [`ARCHITECTURE.md`](ARCHITECTURE.md)에 있다.

Preflop 학습 평가는 `training/`에 있다. 기준은 버전이 고정된 6·8·9인 100BB 휴리스틱 frequency-only 표이며 EV 숫자는 만들지 않는다. `--store-dir` 세션은 핸드 종료 후 평가를 게시하고 UI 학습 탭에 표시한다. 장기 skill profile은 `<store>/.training/`에 남고 `node tools/profile-cli.js apply|rebuild|show|reset|sweep --store-dir game`으로 관리한다. 스팟 드릴은 `node tools/drill-cli.js start --store-dir game --mode assessment|retest|leak|mistake-review|daily|free` 또는 `node tools/drill-server.js --store-dir game`(게임 세션 토큰과 다른 전용 토큰)이다. 핸드 히스토리 export는 `node tools/export-hh.js --game-dir <session|archive> --format canonical-json|pokerstars --out <path>`. PLAY 칩·synthetic ID이며 상용 사이트 핸드를 위조하지 않는다. 이미 있는 파일·symlink는 덮어쓰지 않는다. `--opponent-runtime policy`는 LLM 플레이어 없이 deterministic 정책을 쓰고, 종료 전에는 policy/deviation을 공개하지 않는다. `--mirror-self`와 `--exploit-self`는 같은 store의 종료된 핸드에서 관측 빈도를 뽑아 휴리스틱 복제·공략 좌석을 만들며, 누적 60핸드가 필요하고 종료 전에는 어느 좌석인지 공개하지 않는다. 정책 레이즈 사이징은 스팟별 고정 휴리스틱(오픈 2.5bb·3벳 3.4x·4벳 2.3x·5벳 이상 올인·포스트플랍 벳 2/3팟·레이즈 3/4팟)이며 페르소나와 무관하고 GTO·solver 값이 아니다. 종료 후 exploit 평가는 결정 시점의 공개 증거가 있는 상대를 대상으로 돌고, heuristic 방향만 보여 주며 가짜 EV를 만들지 않는다. Postflop solver는 `node tools/solve-cli.js` fake adapter가 CI 기본이며, 실제 solver는 사용자 설치형이다. `--solver <adapterId>`를 주면 postflop 결정을 unsupported로 접수하지 않고 solve로 미루며, 재개는 플래그 없이도 기록된 adapterId로 이어진다. Training detail은 `GET /api/training-detail?token=&ref=`(token-first, `detailSha256` 대조)이다. 레거시 `--game-dir`에서는 training이 꺼진다. 데이터 출처는 [`training/data/README.md`](training/data/README.md).

## 왜 사이드카인가

이전 구조에서는 딜러 역할을 맡은 LLM 세션이 루프를 직접 돌렸다. AI 한 명이 액션할 때마다 딜러 LLM 왕복이 한 번씩 끼어들었고, 그게 게임 속도를 지배했다. 지금은 그 루프가 노드 프로세스 안으로 들어갔다.

| 기준 | 값 |
|---|---|
| 핸드 안 AI 액션 경로의 딜러 LLM 라운드 | **0회** |
| 남는 지연 | policy는 로컬 결정, llm은 플레이어 CLI 왕복 + 노드 오버헤드 |
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

기본 런타임은 `/start-game`을 실행한 호스트이고, 딜러가 `--player-runtime`으로 명시한다. policy 모드는 상위 모델만 검사하고 LLM 플레이어 probe·세션을 만들지 않는다. llm 모드에서는 플레이어 모델 왕복이나 컨테인먼트 검증에 실패하면 폴백 사다리(claude → codex → grok)가 돌며, 모두 부적격일 때 `NO_PLAYER_RUNTIME`으로 기동을 중단한다. 상위 모델만 없으면 LLM 설명을 제공할 수 없음을 알린다.

## 시작하기

저장소 루트에서.

### 스킬 (권장)

이 저장소의 Claude Code·Codex·Grok 세션에서 `/start-game`을 실행한다. 기본은 AI 5명과 20핸드 cash-training이며, AI 수는 1~8명을 선택할 수 있다. `--opponent-runtime llm`은 상대 결정 방식만 바꾼다. `--mode tournament` 또는 mode 없는 `--stack N`/`--level-every N` 요청은 기존 토너먼트·LLM 설정을 보존한다. 명시한 스택·블라인드·핸드 수는 덮어쓰지 않는다. 중단 재개는 `/start-game resume`.

절차 정본은 [`.agents/skills/start-game/SKILL.md`](.agents/skills/start-game/SKILL.md), 호스트 포인터는 [`AGENTS.md`](AGENTS.md)다.

### 사이드카 직접 기동

스킬 없이 같은 게임을 띄울 때. `init`과 서버 기동은 사이드카가 하므로 직접 부르지 않는다.

```bash
nohup node tools/game-loop.js --store-dir game --player-runtime claude \
  > /tmp/ai-holdem-boot.log 2>&1 &
# game/.session-store/current.json의 sessionRel을 해석한 concrete session의
# loop-state.json을 폴링해 phase가 bootstrap을 지나면 port·sessionToken으로
open "http://127.0.0.1:<port>/?token=<t>"
```

재개는 `--resume`을 추가한다. 명시 토너먼트 예시는 `--mode tournament --ai 3`, LLM 상대는 `--opponent-runtime llm`이다. 기존 `--game-dir` API와 resume에는 새 기본값을 주입하지 않는다. 직접 store CLI는 새 디렉터리·락을 private 모드로 만들며 기존 디렉터리나 다른 소유자의 락 권한은 바꾸지 않는다.

개발용 임시 store에서는 `--port 0`으로 OS가 고르는 relay 포트를 사용한다. `--port` 범위는 0..65535이며 생략 시 기존 8877을 쓴다. 재개는 이미 기록된 포트를 보존한다. 이 옵션은 엔진의 게임 설정을 바꾸지 않는다.

Windows Git Bash에서는 `nohup`/`/tmp` 대신 `node tools/game-loop.js ... > "%TEMP%\ai-holdem-boot.log" 2>&1 &` 와 `start "" "http://127.0.0.1:<port>/?token=<t>"` 를 쓴다. `ps -o lstart=` 는 쓰지 않는다 — 사이드카가 플랫폼 identity를 소유한다.


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

학습 페이지는 게임 relay와 다른 URL·토큰을 쓴다. 게임이 끝나도 요약과 드릴을 쓸 수 있고, 다음 게임은 검증된 서비스를 재사용한다. 다시 열거나 명시적으로 정지할 때는 존재하는 store 경로를 지정한다. 아래 명령은 실제 게임 store를 기본값으로 선택하지 않는다.

```bash
npm run study -- /absolute/store
npm run study:stop -- /absolute/store
```

`study-service` helper는 pid·startTime·store identity·인증 응답을 검증한다. 살아 있는 store loop 또는 인증된 학습 요청이 없으면 10분 유휴 후 정지한다. 재시작은 토큰을 회전하므로 새 URL을 사용한다. URL fragment와 private control token을 공유하지 않는다. 이전 relay를 재사용할 때는 인증된 protocol 2 capability와 현재 study URL이 모두 맞아야 한다.

평가는 **휴리스틱 기준표 비교**다. 새 세션의 v2 휴리스틱 기준표는 cash-training 6·8·9인, 100BB의 미오픈 2.5BB 오픈과 단일 오픈 대응 8.5BB 3-bet을 지원한다. 80~120BB 스택·2~3BB 오픈·6.5~10.5BB 선택 3-bet은 제한적 투영 참고이며 점수·분포·오답·재시험 통계에서 제외한다. limp·cold-call·multiway·4-bet+·postflop은 지원하지 않는다. 기존 세션과 정책 v1은 기존 기준표를 유지한다. 기본 6인·100BB 자체가 모든 결정을 지원한다는 뜻은 아니다. 허용 액션 비율, 최빈 액션 비율, 표본이 충분할 때의 분포 일치는 실제 실력·수익·solver 정답의 증명이 아니다. 게임과 연습 지표는 분리되며, 연습을 많이 해도 게임 통계·후보·분포 일치 값은 바뀌지 않는다.

v2 정책 배정이나 profile4·bank2 데이터가 생긴 뒤에는 구버전에 맞춰 덮어쓰지 않는다. 원본 이벤트·평가·processed digest를 보존하고 호환 버전으로 **roll-forward**한다. 실제 구버전 profile rebuild/show/apply 검증은 복사본에서만 수행한다. accepted/delivered 액션의 엔진 결과가 불명확하면 `OUTCOME_UNRESOLVED`로 복구를 멈추고 엔진 상태부터 동기화한다. 그 뒤 검증된 study instance만 helper로 정지하고 호환 버전으로 재개한다.

## 테스트

```bash
node --test
```

인자 없이 실행한다. **`node --test test/`처럼 디렉터리 인자를 주면 Node v26에서 실패하므로 금지.** 단건은 `node --test test/<파일>.test.js`.

CI는 프로세스·락 통합 테스트끼리의 교차 부하를 피하기 위해 테스트 파일만 직렬화하는 `npm run test:ci`를 사용한다. 각 테스트가 내부에서 만드는 동시성·race는 그대로 검증한다.

정책 검증은 `npm run benchmark:policies`다. 릴리스 검증은 `node tools/verify-learning-release.js --baseline <commit> --before-manifest <manifest> --out-dir <evidence>`로 실행하며, 실제 이전 버전 호환성·브라우저·정리 증빙 등이 없거나 실패하면 통과하지 않는다. 테스트 통과만으로 사람의 학습 효과를 주장하지 않는다.

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
