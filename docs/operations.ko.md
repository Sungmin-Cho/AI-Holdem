# 운영 및 복구 가이드

[English README](../README.md) · [한국어 README](../README.ko.md)

게임 운영, 진단, legacy CLI와 복구 절차를 위한 상세 참고 문서입니다. 처음 시작하려면 README를 참고하세요.

브라우저에서 플레이하고 결정 기록을 복습하는 노리밋 텍사스 홀덤이다. 새 store 게임은 cash-training·AI 5명·100BB·20핸드·policy v2를 기본으로 한다. 옵션 `--showdown-policy open|standard`, `--replay-reveal all|showdown`. 핸드가 끝나면 로그 탭의 복기 뷰에서 상대 카드·사유와 코치 3줄을 보고, 액션 바의 의도 메모는 그 결정에 붙는다. export는 쇼다운 카드만 싣는다. 각 AI는 버전이 고정된 페르소나 정책으로 결정하며, `--opponent-runtime llm`을 선택하면 무도구 LLM 플레이어가 결정한다. 적격 상위 모델이 있으면 코치와 종합 리뷰를 제공하고, 없으면 설명 불가를 알리면서 실제 기록으로 만든 기계 피드백을 남긴다.

요구: Node ≥ 20, npm ci로 @typesafe-ai/sdk를 설치한다. 플레이어 런타임은 Claude Code · Codex · Grok을 지원한다.

## 어떻게 생겼나

게임 진행과 종료 후 학습의 소유권을 분리한다.

- **엔진**(`engine/`) — 덱·핸드 전이·사이드팟·핸드 평가. 네트워크도 LLM도 모른다.
- **사이드카**(`tools/game-loop.js`) — 게임 진행 전체를 소유하는 루프. 앱 서비스가 같은 프로세스에서 호스팅하며 legacy 직접 실행은 detached 노드 프로세스를 사용한다. 부트스트랩부터 핸드 안 액션 루프, 워치독, 코치, 종합 리뷰, 종료까지.
- **서버**(`server/`) — SSE와 액션 대기만 중계한다. 게임 규칙을 모른다.
- **학습 서비스**(`tools/study-service.js`) — store별 독립 프로세스에서 학습 요약·드릴을 제공한다. 게임 relay가 종료되어도 유지된다.

계층 경계와 불변식은 [`ARCHITECTURE.md`](../ARCHITECTURE.md)에 있다.

Preflop 학습 평가는 `training/`에 있다. 기준은 버전이 고정된 6·8·9인 100BB 휴리스틱 frequency-only 표이며 EV 숫자는 만들지 않는다. `--store-dir` 세션은 핸드 종료 후 평가를 게시하고 UI 학습 탭에 표시한다. 장기 skill profile은 `<store>/.training/`에 남고 `node tools/profile-cli.js apply|rebuild|show|reset|sweep --store-dir game`으로 관리한다. 스팟 드릴은 `node tools/drill-cli.js start --store-dir game --mode assessment|retest|leak|mistake-review|daily|free` 또는 `node tools/drill-server.js --store-dir game`(게임 세션 토큰과 다른 전용 토큰)이다. 핸드 히스토리 export는 `node tools/export-hh.js --game-dir <session|archive> --format canonical-json|pokerstars --out <path>`. PLAY 칩·synthetic ID이며 상용 사이트 핸드를 위조하지 않는다. 이미 있는 파일·symlink는 덮어쓰지 않는다. `--opponent-runtime policy`는 LLM 플레이어 없이 deterministic 정책을 쓰고, 종료 전에는 policy/deviation을 공개하지 않는다. `--mirror-self`와 `--exploit-self`는 같은 store의 종료된 핸드에서 관측 빈도를 뽑아 휴리스틱 복제·공략 좌석을 만들며, 누적 60핸드가 필요하고 종료 전에는 어느 좌석인지 공개하지 않는다. 정책 레이즈 사이징은 스팟별 고정 휴리스틱(오픈 2.5bb·3벳 3.4x·4벳 2.3x·5벳 이상 올인·포스트플랍 벳 2/3팟·레이즈 3/4팟)이며 페르소나와 무관하고 GTO·solver 값이 아니다. 종료 후 exploit 평가는 결정 시점의 공개 증거가 있는 상대를 대상으로 돌고, heuristic 방향만 보여 주며 가짜 EV를 만들지 않는다. Postflop solver는 `node tools/solve-cli.js` fake adapter가 CI 기본이며, 실제 solver는 사용자 설치형이다. `--solver <adapterId>`를 주면 postflop 결정을 unsupported로 접수하지 않고 solve로 미루며, 재개는 플래그 없이도 기록된 adapterId로 이어진다. Training detail은 `GET /api/training-detail?token=&ref=`(token-first, `detailSha256` 대조)이다. 레거시 `--game-dir`에서는 training이 꺼진다. 데이터 출처는 [`training/data/README.md`](../training/data/README.md).

## 왜 사이드카인가

이전 구조에서는 딜러 역할을 맡은 LLM 세션이 루프를 직접 돌렸다. AI 한 명이 액션할 때마다 딜러 LLM 왕복이 한 번씩 끼어들었고, 그게 게임 속도를 지배했다. 지금은 그 루프가 노드 프로세스 안으로 들어갔다.

| 기준 | 값 |
|---|---|
| 핸드 안 AI 액션 경로의 딜러 LLM 라운드 | **0회** |
| 남는 지연 | policy는 로컬 결정, llm은 플레이어 CLI 왕복 + 노드 오버헤드 |
| 사이드카 오버헤드(`parseMs+stepMs+publishMs`, LLM 제외) | ≤ 1s/액션 |

부수 효과가 더 크다. 사이드카는 detached라 **딜러 세션이 죽어도 게임은 계속 돈다.** 호스트 세션이 하는 일은 사전 점검 → 기동 → 보고 셋뿐이다.

판정 근거는 지어내지 않는다. 사이드카는 선택된 session의 `loop-state.json` `metrics`에 결정별 시간을 남긴다. `outcome`은 `accepted`·`retried_accepted`·`policy_accepted`이며, `sessionRepaired`·`corrected` 플래그로 세션 복구와 교정 수락을 구분한다. 유효 결정이 없으면 액션 없이 `pendingDecision.status=recovery_required`로 보존되고 `code`(마지막 호출 실패)와 `diagnostics`(직전 회신의 안전 투영·교정 횟수)가 남는다. `loop.log`의 `player-call`(`callNo`)·`player-decision-normalized`·`player-decision-rejected`·`player-correction`·`player-correction-skipped`·`player-diagnostics-quarantined`·`player-recovery-required`로 원인을 확인한다. 거부된 원문 출력은 로그에 남기지 않는다. 자동 교정은 자식 종료 확인 후 남은 예산 안에서 1회이며, TIMEOUT만 발생한 결정은 자동 재질문하지 않는다. `player-correction`은 호출 준비 이벤트이므로 뒤따르는 `player-correction-skipped`를 제외하고 실제 호출은 `player-call`로 센다. v2 pending이 남은 게임은 호환 버전으로 이어서 복구하며, 구버전으로 배포를 되돌리기 전 현재 버전에서 안전 종료한다.

같은 무효 회신을 반복하는 LLM 좌석은 일시정지 메뉴의 **새 세션으로 재시도**를 명시적으로 선택할 수 있다. 대화 기억은 사라지지만 페르소나 카드·칩·핸드 기록은 유지된다. 새 세션에는 교정 문맥을 상속하지 않고 현재 결정을 처음부터 묻는다. 자동 재생성은 없으며, 같은 결정의 identity와 자식 종료 증거를 확인하고 저장된 한 세대 예산 안에서 워밍업과 결정을 수행한다. 명령 영수증의 `succeeded`는 인가 완료이며, 실제 재생성은 `player-call`의 `purpose:'fresh-warmup'`·`player-session-recreated` 또는 `player-session-recreate-failed`, 성공 결정은 `metrics.freshSession:true`·`outcome:'retried_accepted'`로 확인한다. legacy는 정지된 게임에 `node tools/game-loop.js --game-dir /absolute/game --resume --retry-decision <decisionId> --fresh-session`을 사용한다. 인가 후 프로세스가 중단되면 자동 재실행하지 않으며 다시 명령해야 한다.


`BAD_PLAYER_RECOVERY`는 저장된 LLM 결정 기록을 검증할 수 없다는 뜻이다. 앱의 private JSON reader는 **2 MiB**를 넘는 loop 파일을 읽지 않으며, 이것은 snapshot/core의 크기 제한이 아니다. 이때 앱 제어는 fail-closed로 unavailable일 수 있다. 파일을 직접 삭제하거나 손상 결정을 재실행하지 않는다. 중단됐고 소유자가 없는 게임만 legacy 명령으로 처리한다. 명시 종료는 prior `BAD_PLAYER_RECOVERY` 관찰 여부와 무관하게 eligible playing state를 버릴 수 있으며, audit `reason`은 모든 호출자가 그 오류를 봤다는 증명이 아니라 이 operator recovery 경로의 분류다. 최초 실패 전 바이트는 `loop-state.unverified.json`, 명시 종료에 사용한 바이트는 `loop-state.abandoned.<operationId>.json`에 create-only로 보존하며 `player-recovery-abandoned` 로그가 감사 기록을 가리킨다. 이미 엔진 결과가 확정된 게임은 **기록을 버리고 결과 정리**로 진행하며 엔진 결과는 바뀌지 않는다. 이 경로의 플레이어 호출은 0회지만 기존 코치·리뷰 정리는 실행되거나 halt할 수 있으므로 완료를 보장하지 않는다. live session을 중단하지 말고, 먼저 소유권과 정지를 확인한다.

legacy 정지 게임의 명시 종료는 `node tools/game-loop.js --game-dir /absolute/game --resume --abort-unrecoverable recovery-1`이다. operationId는 필수이며 `--retry-decision`과 함께 쓸 수 없다. `GAME_ENDED`이면 게임 실행을 다시 시작하지 않는다. audit retry 이벤트는 operationId/SHA 기준으로 반복될 수 있으므로 exactly-once라고 해석하지 않는다. `pendingDecision`, accepted 명령, 미완료 `aborting`/`abandonedPendingDecision` 체크포인트가 남아 있으면 구버전으로 내리지 말고 호환 버전에서 먼저 수렴시킨다. [복구 종료와 롤백 조건](implementation/unrecoverable-recovery-exit.md)을 참고한다.

## JEV 상대 플레이어

상세 설정에서 **JEV 플레이어 (테이블 전체)**를 선택하면 모든 AI 좌석이 TypeSafe AI의 `jev-1.13.0`으로 행동한다. 인간 좌석과 기본 로컬 정책 모드는 그대로다. 개발 설치는 `npm ci`, 서버 환경은 `TYPESAFE_API_KEY`를 사용한다. legacy CLI는 `--opponent-runtime jev`이며 온라인 게임은 앱 로비에서 시작·재개한다.

각 호출에는 행동하는 AI의 자기 패와 공개 보드·스택·액션만 보낸다. 이름, 참가자 ID, 다른 좌석의 패, 메모·채팅은 제외한다. 합법 액션/금액 후보 중 하나를 선택하며 자유 생성 설명이나 자동 정책 대체는 없다. 코치·종합 리뷰는 기존 상위 LLM 또는 사실 기반 피드백이다. JEV는 포커 solver나 GTO 정답이 아니다.

응답 대기 예산과 일시정지·재시도는 로비에서 관리한다. 오래 기다림 알림 이후 **AI 응답 취소**가 가능하고, 일반 일시정지는 진행 중 결정을 한 번 마친 뒤 멈춘다. 원격 실패는 명시적 재시도 또는 종료를 기다리며 **새 LLM 세션**은 JEV에 해당하지 않는다. 키가 없어도 종료와 완료 화면은 이용할 수 있다. 확률·confidence·usage는 private `loop-state.jevDiagnostics`에만 보관하며 최근 최대 5,000건 및 256 KiB/전체 loop 파일 크기로 제한한다. `dropped`는 폐기 누계다. 실제 API의 0.01 단위 확률 반올림 오차만 제한적으로 허용하며 확률을 재정규화하지 않는다.

`JEV_REQUEST_CLOSE_UNCONFIRMED`는 로컬 요청 종료를 확인하지 못했다는 뜻이다. 재시도·새 게임을 막고 락을 유지한다. 먼저 `npm run app:stop -- /absolute/store`를 실행한다. 실패하면 앱 descriptor와 app lock의 PID/startTime을 재검증한 뒤 해당 앱 소유 프로세스만 종료하고 사망을 확인해야 한다. 임의의 node 프로세스를 종료하거나 락 파일을 삭제하지 않는다. 이후 정상 앱 재개에서 미적용 HTTP 결정만 명시 재시도할 수 있다. 진행 중 JEV 저장소를 구버전으로 열지 말고 호환 버전에서 게임을 종료한 후 롤백한다.

실제 provider를 쓰는 별도 검증은 `node test/browser/jev-live-play.mjs --live --out-dir output/playwright/jev-live`다. 기존 게임을 변경하지 않는 임시 저장소에서 2핸드, 최대 40회 호출하며 상위 코치 LLM은 끈다. 일반 CI는 외부 API를 호출하지 않는다.

## LLM은 어디에만 있나

플레이어 결정·코치 노트·종합 리뷰 셋뿐이다. 전부 `tools/player-runtime.js`가 부르는 **무도구 CLI 자식**이고, 이 파일이 LLM을 부르는 유일한 표면이다. 플레이어는 CLI 세션 resume으로 대화 하나를 게임 내내 이어 가서 자기 페르소나를 기억한다. 프롬프트 정본은 `tools/player-prompt.md` 한 곳이고, 회신 규약은 "JSON 한 줄을 최종 출력으로"다.

**컨테인먼트**가 이 설계의 핵심이다. 자식은 도구 없이, 레포와 `game/` 밖의 빈 임시 디렉터리에서, `HOME`/`PATH`/`USER`만 상속한 채 돈다(grok은 `HOME`을 스토어별 격리 홈으로 바꾸고 자격 경로만 `GROK_AUTH_PATH`로 준다). 프롬프트는 stdin으로만 가고 argv에 실리는 런타임 값은 세션 id 하나뿐이다. 플레이어 에이전트가 남의 홀카드를 파일에서 읽어 오는 경로 자체를 없앤 것이다. 기동할 때마다 게임 디렉터리에 카나리를 심어 자식이 그걸 읽어 오지 **못하는지** 부정 검증하고, 읽어 오면 그 런타임은 부적격 처리한다.

| 런타임 | 격리 수단 | 한계 |
|---|---|---|
| `claude` | `--safe-mode --restricted` + probe stream 감사(`init.plugins` 빈 배열, hook 이벤트 0) | managed/`--settings` SessionEnd hook은 스트림에 없어 탐지하지 못한다 |
| `codex` | `exec --ignore-user-config` + `--disable hooks` | 실행 중 감사 스트림이 없다. 플래그 의미 변경은 자동으로 알 수 없다 |
| `grok` | 스토어별 격리 홈 + `inspect --json`·세션 기록 감사 + `--disallowed-tools`/`--deny`(도구 표면 `[read_file]`, 호출은 전부 거부) | Windows 미지원(fail-closed). 격리 홈은 스토어별 약 14 MB(`~/.ai-holdem/runtime-home/`, 지워도 다음 기동에서 재생성). 도구 목록은 이름 기반이라 새 기본 도구가 생기면 표면 감사로 탈락한다. 읽기 차단은 권한 계층이지 OS 샌드박스가 아니다. 부트 1–2분(카나리 거부 왕복 각 25–50 s). 같은 uid 프로세스의 홈 변조는 위협 모델 밖. API 키 env 인증은 미지원 |

| 런타임 | 플레이어 모델 | 상위 모델(코치·evaluator·종합자) | 플레이어 예산 soft / hard |
|---|---|---|---|
| `claude` | `sonnet --effort medium` | `opus` | 25s / 300s |
| `codex` | `gpt-5.6-luna` | `gpt-5.6-sol` | 25s / 300s |
| `grok` | `grok-4.6` | `grok-4.6` | 25s / 300s |

플레이어 예산은 `--player-soft-ms`·`--player-hard-ms` 또는 로비 setup의 `playerSoftMs`·`playerHardMs`로 설정한다. soft는 대기 안내 기준이며, hard가 결정 세대의 전체 호출 예산이다. `RUNTIME_TABLE.watchdog`의 `t1Ms`·`t2Ms`는 테스트 주입 호환 값이며 실제 기본 예산 표가 아니다.

Claude CLI는 `--safe-mode`와 `--effort`를 지원하는 2.1.278 이상을 사용한다(2.1.278 실측).

LLM 모드 진행 중 게임은 업그레이드 전에 끝낼 것. 새 Claude 플레이어는 sonnet medium으로 실행하며, 턴 요약의 판단 보조를 사용합니다.

기본 런타임은 `/start-game`을 실행한 호스트이고, 딜러가 `--player-runtime`으로 명시한다. policy 모드는 상위 모델만 검사하고 LLM 플레이어 probe·세션을 만들지 않는다. llm 모드에서는 플레이어 모델 왕복이나 컨테인먼트 검증에 실패하면 폴백 사다리(claude → codex → grok)가 돌며, 모두 부적격일 때 `NO_PLAYER_RUNTIME`으로 기동을 중단한다. 상위 모델만 없으면 LLM 설명을 제공할 수 없음을 알린다.


### 결과 표시와 진행 제어

새 로비의 진행 속도는 `즉시/빠름/보통/느림` 중 기본 `보통`이다. setup의 `pace` 및 legacy `--pace`는 `instant/fast/normal/slow`를 쓴다. pace가 없는 기존 게임은 즉시 진행한다. 핸드 결과 배너·런아웃·좌석 행동 배지는 공개 이벤트로 만들고, 턴 카운트다운은 서버가 저장한 같은 마감 시각을 쓴다. 단독 인간 게임의 호스트만 결과 대기를 건너뛸 수 있다. 모바일의 금액·메모 버튼은 보조 입력을 펼친다.

게임 종료 시 리뷰를 기다리지 않고 결과 화면을 표시한다. 요약을 읽는 동안 기존 순위가 보이며, 확인된 종료 시 리뷰가 없으면 그 사실을 표시한다. 종료 후 로비·참가자 테이블을 유지한다. 호스트 `GET /api/game/:gameId/summary`와 참가자 `GET /api/p/game/:gameId/summary`는 인증·게임 세대·종료 상태를 검사하며, 참가자 요약은 토큰당 2초에 한 번 허용한다. 손상·누락 기록은 손익을 임의로 채우지 않고 불완전으로 표시한다.

호스트 `POST /api/game/:gameId/skip-result`는 같은 핸드의 대기만, `POST /api/app/interrupt-decision`은 soft 대기 중인 같은 게임·결정·세대의 AI 호출만 제어한다. 취소는 자식 종료 확인을 기다린 뒤 복구 상태로 전환한다. 이후 웹 UI에서 재시도한다. 늦은 완료·이미 반영된 액션을 취소로 덮어쓰지 않는다. 두 제어는 일반 명령 저널을 기다리지 않아 일시정지와 교착하지 않는다.

진단 `metrics`는 최근 5,000건을 보존하고 `metricsDropped`에 폐기 개수를 누적한다. relay 화면 로그는 1 MiB를 넘으면 오래된 핸드 단위로 줄이되 마지막 핸드는 단독으로 1 MiB를 넘어도 보존하므로 하드 상한은 아니다. 새로고침 후 잘린 과거 핸드의 로그 복기 진입점은 사라질 수 있다. 전체 결과 요약은 화면 로그가 아닌 완료 아카이브에서 계산한다. 진단 이력은 기존 loop-state로 재개하면 유지된다. loop-state가 없어 재구성한 경우에는 `metrics`와 `metricsDropped`가 0부터 시작하므로, 폐기 누계가 0이어도 게임 전체 표본이라고 단정하지 않는다. 참가 요청 주소 목록은 1,024개 초과 시 60초가 지난 항목을 청소하며 활성 주소 수의 하드 상한은 아니다.

## 시작하기

저장소 루트에서.

### 스킬 (권장)

이 저장소의 Claude Code·Codex·Grok 세션에서 `start game` 또는 `/start-game`을 요청하면 웹 로비가 열린다. 웹에서 모드와 AI 수(1~8명)를 선택하고 게임을 시작한다. 상세 설정의 기본은 캐시 트레이닝·AI 5명·100BB·20핸드·로컬 정책이다. 명시한 옵션은 로비 선택값으로 보존한다. 이미 앱이 실행 중이면 같은 로비로 연결한다. 기존 standalone 게임의 명시 `resume`은 legacy 절차를 유지한다.

절차 정본은 [`.agents/skills/start-game/SKILL.md`](../.agents/skills/start-game/SKILL.md), 호스트 포인터는 [`AGENTS.md`](../AGENTS.md)다.

### 웹 로비

```bash
npm run app -- /absolute/path/to/game --player-runtime codex
# 앱 자체를 종료할 때
npm run app:stop -- /absolute/path/to/game
```

출력된 링크를 열어 모드(캐시 트레이닝/토너먼트)와 AI 1~8명을 고른 뒤 시작한다. 로비를 여는 것만으로 게임이나 LLM 호출이 시작되지는 않는다. 기본은 캐시·AI 5명·100BB·20핸드·로컬 정책이다. 로비 토너먼트도 로컬 정책을 기본으로 하며 LLM/JEV 상대는 상세 설정에서 선택한다. 학습실은 별도 창으로 열린다.

온라인 세션은 로비에서 세션을 열면 LAN 참가 링크(`http://<LAN IP>:8899/join?code=ABCD-EFGH`)가 생긴다. 기본은 암호화 없는 HTTP이며 포트포워딩·터널·인증서는 사용자 몫이다. 공개 포트는 `HOLDEM_PUBLIC_PORT` 또는 `--public-port`이고, 표시 호스트는 `--public-host`다. `--tls-cert`와 `--tls-key`를 함께 주면 HTTPS다. 같은 NAT 뒤에서는 여러 참가자가 한 주소로 보일 수 있다. 멀티 세션은 앱으로만 재개하고, 직접 CLI `--resume`은 거부한다. 롤백 전에는 게임을 종료하고 룸을 닫는다.

게임 중 `일시정지 · 메뉴`를 누르면 현재 접수된 행동을 마친 뒤 정지한다. 계속하기, 같은 설정의 새 게임, 모드 선택, 종료를 제공한다. 메뉴 닫기와 Escape는 일시정지를 유지한다. 새 게임은 새 ID를 사용하고 완료한 핸드 기록은 보존한다. 중도 종료는 `aborted`이며 진행 중이던 핸드를 완료 성적에 포함하지 않는다. 정상 완주 리뷰는 종료된 게임의 `게임 기록 보기`에서 다시 열 수 있다.

앱 서비스와 학습 서비스는 게임보다 오래 유지된다. 로비의 접속 토큰은 URL fragment에서 sessionStorage로 옮겨지고 relay 토큰은 브라우저에 전달하지 않는다. 링크와 private descriptor를 공유하지 않는다. 기존 직접 실행 게임이 활성 상태면 로비가 소유권을 가져오지 않는다.

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

CI는 프로세스·락 통합 테스트끼리의 교차 부하를 피하기 위해 테스트 파일만 직렬화하는 `npm run test:ci`를 사용한다. Windows는 8샤드다. 각 테스트가 내부에서 만드는 동시성·race는 그대로 검증한다.

멀티플레이 브라우저 저니(`npm run test:multiplayer:browser`)는 접속 가능한 LAN IPv4가 필요하며, 없으면 실패로 종료한다.

정책 검증은 `npm run benchmark:policies`다. 릴리스 검증은 `node tools/verify-learning-release.js --baseline <commit> --before-manifest <manifest> --out-dir <evidence>`로 실행하며, 실제 이전 버전 호환성·브라우저·정리 증빙 등이 없거나 실패하면 통과하지 않는다. 테스트 통과만으로 사람의 학습 효과를 주장하지 않는다.

`test/tempo-skill-contract.test.js`는 코드가 아니라 **문서 문면**을 검사한다. 이 운영 가이드와 `AGENTS.md`, 스킬 정본이 옛 딜러 루프를 다시 가리키지 않도록 고정하는 계약이라, 문서를 고치면 이 테스트를 함께 돌려야 한다.

## 문서 지도

| 문서 | 담당 |
|---|---|
| [`README.md`](../README.md) · [`README.ko.md`](../README.ko.md) | 프로젝트 소개와 빠른 시작 |
| `docs/operations.ko.md` | 이 문서 — 운영과 복구 |
| [`ARCHITECTURE.md`](../ARCHITECTURE.md) | 소유권 경계, 계층 규칙, 아키텍처 불변식 |
| [`AGENTS.md`](../AGENTS.md) | 호스트 중립 에이전트 지침과 호스트별 스킬 경로 |
| [`CLAUDE.md`](../CLAUDE.md) | Claude Code 고유 사항 (`AGENTS.md`를 import) |
| [`.agents/skills/start-game/SKILL.md`](../.agents/skills/start-game/SKILL.md) | 딜러 절차 정본 (SSOT) |

## 라이선스

[Apache License 2.0](../LICENSE)에 따라 사용할 수 있다.

새 store 세션은 사전 힌트가 기본적으로 꺼져 있다. `--hints on`으로 켜면 현재 사용자 프리플랍 판단의 v2 휴리스틱 기준표 빈도를 표시한다. `--hints off`는 수치를 표시하지 않는다. 설정은 세션 동안 고정되며 재개 시 생략하면 기존 값을 따른다. 구버전 세션에는 힌트를 추가하지 않으며 새 세션을 시작해야 한다. 힌트 게시 전에 보조 기록을 영속 저장하므로 실제 화면을 보지 못했어도 보조받은 판단으로 남을 수 있다. 해당 판단은 독립 점수·분포·오답·재시험·목표에서 제외하고, 해당 핸드 전체는 자기 성향의 독립 60핸드 표본에서 제외한다. 투영은 계속 비채점이며 기존 v1 출처는 보존한다.

### 진행 속도

새 로비 게임은 **보통**을 선택한다. 즉시/빠름/보통/느림은 핸드 결과 대기와 policy AI 액션 간격, 올인 런아웃 간격을 함께 정한다. LLM 응답 자체에는 추가 AI 간격을 넣지 않는다. legacy CLI는 `--pace instant|fast|normal|slow`로 선택하며, 옵션이 없거나 예전 setup에 기록이 없으면 즉시다. 재개와 같은 설정으로 재시작은 저장된 선택을 따른다.

결과 대기는 서버가 소유한다. 사람 좌석이 하나인 게임만 현재 핸드의 대기를 건너뛸 수 있고, 일시정지 후 재개하면 남은 대기를 반복하지 않는다. 이 기능을 되돌릴 때는 진행 중 게임을 먼저 종료하고 해당 세션의 `.app-setup.json`에서 `pace` 키를 제거한 뒤 이전 버전으로 되돌린다.
