# 핸드 안 템포 — 게임 루프 사이드카 · talk 제거

날짜: 2026-08-29
이슈: #5 (핸드 안 템포: 게임 루프를 사이드카로 옮기고 talk를 뺀다)
상태: 리뷰 루프 수렴 (R3, model-router CRITICAL 밴드 이중 리뷰). 구현은 이 워크트리의 새 세션.

## 0. 리뷰 루프

공식 model-router `route_task.py`: REVIEW c2 u2 b2 r1 → risk 11/18 **CRITICAL**, 교차 가족 이중 리뷰, 저자 가족(claude) 좌석 제외. 좌석: grok-4.6(xhigh) + gpt-5.6-sol(max, luna에서 인간 승격 — tier 2 충족). 판사 없음 → 불일치는 사용자. 라우팅·좌석·영수증: `docs/sidecar-review/` (untracked).

| 라운드 | grok-4.6 | gpt-5.6-sol | 처리 |
|---|---|---|---|
| R1 | FAIL 0.86 | FAIL 0.97 | 12건 전부 수용: 홀카드 격리(무도구+cwd 격리+부정 probe), init↔사이드카 레이스(LOOP_ALIVE), user 분기 완성(강제 폴드 금지), 런타임별 워치독, attach 분기, 상위 모델 probe·리뷰 계약(REVIEW_FAILED), 롤백 절차, loop 락 identity 원시, 메트릭 객관화, 레거시 talk 필터, 테스트 확충, practiceFocus 인계 |
| R2 | FAIL 0.86 (추출) | FAIL 0.96 | 11건 수용 + 1건 부분: **부트스트랩 재설계**(사이드카가 락→init→서버 소유 — 기동 공백 제거), pid+startTime identity(재사용 방어), 정지 순서 사이드카→서버 + SIGTERM 중 D9 금지, 첫 전이의 종료 국면 술어, 마지막 핸드 코치 재-reserve 금지, review_generated/review_published 체크포인트, probe를 실제 state.json·동일 env로, 런타임 전멸 resume 규칙(playing이면 NO_PLAYER_RUNTIME HALT — 리뷰어의 전결정 force-default 제안은 유령 게임이라 기각), 스킬 사전 점검 동격, grok 27s(4× 산술), 테스트 확충 |
| R3 | FAIL 0.87 (추출) | FAIL 0.96 | 12건 전부 수용: **probe 미끼를 카나리로**(R2의 state.json probe가 유출 역설 — 라이브 홀카드 경로를 probe에 절대 안 넣음), 락 identity 인코딩을 원시 구현과 정합(pid 파일 확장·추가 파일 금지·epoch는 loop-state로), 딜러 부트 대기를 pid 생존 기반으로(probe 사다리 시간), loop-state 부재/bootstrap/playing+gameOver 복구 유도 규칙(--resume은 init 금지), stats 캡처→reserve 순서(코드 사실), spawn 직후 bind-handle, review 이중 게시 방지(스냅샷 digest 대조), init 옵션 패스스루, practice-focus 소스 game/ 밖, loop-state에 sessionToken·notices, 오버헤드 판정 분리(세부 타이밍+zero-delay 벤치), 테스트 확충 |

**수렴 판정 (R3 최종)**: R2·R3 연속 2라운드에서 신규 발견 과반이 직전-삽입 문면의 파장(R2: 8/12, R3: 9/12) — `review-loop-convergence-rule` 신호 2 충족. 락·복구 시퀀스류 상태기계 명세는 산문 라운드를 더 돌수록 새 경계 조건이 재생산되므로(규칙 3), 여기서 수렴을 선언하고 잔여를 아래로 이월한다.

### 구현 이월 (플랜·구현 검증이 확정)

- 컨테인먼트 플래그·env 목록의 실제 값: Task 0 probe가 카나리 부정 검증으로 핀 (설계는 계약만 정의)
- 락 identity 기록의 정확한 파일 형식과 `engine/state.js` 원시 확장 API: 구현 + 5e 테스트가 검증
- grok low effort 핀 방법(`--agent` 정의 파일 vs 설정): Task 0 probe, 실패 시 §2 grok 기준 유지
- 코치·리뷰 상위 모델 CLI의 정확한 argv(무도구 모드 포함): Task 0 probe
- 부트 폴링 문면의 최종 스킬 텍스트: 스킬 개정 태스크에서 계약 테스트와 함께 고정
- 딜러 종료 인지의 호스트별 결선(run_in_background wake 등): 실기 스모크에서 확인

## 1. 문제

엔진·게시·UI는 액션당 수십 ms다. 핸드 안 체감 지연은 **딜러 LLM이 액션 하나에 도는 왕복**이다. 현행 규약(SKILL §4)은 AI 액션 1개 = 딜러 라운드 2개(Bash `step`+publish, 플레이어 전송)이고, 그 두 라운드 각각이 딜러 세션 모델의 생성 시간을 문다.

실측(`game/ui-snapshot.json` `history[].at`):

| 경로 | AI 액션 중앙값 |
|---|---|
| 라이브 Grok 딜러 (2026-08-29) | ~108s (폴드 ~116s) |
| 이전 Claude 딜러 아카이브 | ~21–25s |

PR #3은 핸드 **사이** 4c를 한 턴으로 접었다. 핸드 **안** 바닥은 딜러 왕복 구조가 남는 한 그대로다.

## 2. 목표와 성공 기준

노드 사이드카 프로세스가 `while !gameOver`를 들고, LLM은 **플레이어 결정(fold/check/call/raise)만** 만든다. 딜러 세션은 핸드 안 액션 경로에서 완전히 빠진다.

### 확정 수치

측정 방법: 사이드카가 **모든 AI 결정**을 `game/loop-state.json` metrics에 기록한다 — `{playerId, decisionId, runtime, outcome, elapsedMs}`. `elapsedMs`는 요약 전송 시점부터 **엔진에 액션이 적용된 시점**까지이고, `outcome ∈ {accepted, retried_accepted, forced_default}`이며 **forced_default도 그 소요 시간 그대로 분포에 포함한다**(타임아웃 결정을 분포에서 숨기지 않는다). 백분위는 nearest-rank. 판정 표본: 실기 스모크 3핸드 이상 **그리고 AI 결정 20개 이상**. `history[].at`으로 교차 확인.

| 기준 | 값 | 근거 |
|---|---|---|
| **구조**: 핸드 안 AI 액션 경로의 딜러 세션 LLM 라운드 | **0회** | 사이드카 단독 완주. 딜러 전사에 핸드 안 tool call 없음 |
| AI 결정 elapsedMs 중앙값 — claude(haiku)·codex(gpt-5.6-luna) 플레이어 | ≤ 10s | 콜드 단발 실측 7.7s / 6.3s (CLI 부팅 포함) |
| AI 결정 elapsedMs 중앙값 — grok(grok-4.6) 플레이어 | ≤ 27s | 콜드 단발 실측 25.3s(기본 effort). low effort 핀이 확인되면 ≤ 15s로 조인다 |
| AI 결정 elapsedMs p95 | ≤ 워치독 1차 한도(D8 표: claude·codex 25s, grok 60s) | 정상 응답의 95%가 워치독을 건드리지 않는다 |
| AI 결정 elapsedMs 상한 (구조적) | ≤ 1차 한도 + 재전송 한도 + 2s | 워치독 사다리 + step/publish 오버헤드로 하드 바운드 |
| forced_default 비율 | < 10% (표본 내) | 워치독이 정상 경로가 아니라 예외 경로임을 판정 |
| 사이드카 오버헤드 (step+publish+파싱, LLM 제외) | ≤ 1s/액션 | 판정은 metrics 세부 필드(modelMs/parseMs/stepMs/publishMs)와 §8 5f zero-delay fake 벤치 — 총 elapsedMs에서 유도하지 않는다 |
| 라이브 Grok 대비 | ≥ 4× 단축 | 중앙값 108s → ≤ 27s (108/27 = 4.0) |

엔진·서버·게시 계약은 바꾸지 않는다: 기존 `node --test` 그린 유지(단, talk 제거·스킬 문면 테스트는 §8에서 조정).

## 3. 접근 비교와 결정

핵심 갈림길은 이슈 함정 1 — **플레이어 I/O를 딜러 LLM 밖으로 어떻게 빼는가**.

**A. 호스트 CLI headless 대화 세션 (채택).** 사이드카가 각 플레이어를 CLI 자식 프로세스로 부른다. 세 CLI 모두 이 머신에서 headless 단발 + 세션 resume을 지원함을 확인했다:

| CLI | 단발 | 대화 지속 | 확인 방법 (2026-08-29 이 머신 실측) |
|---|---|---|---|
| `claude` | `-p` | `--session-id <uuid>` 생성 → `-p --resume <id>` | 단발 7.7s + **resume 기억 왕복 실증**(이름·암호 유지) |
| `codex` | `exec [PROMPT]` (stdin 가능) | `--json`의 `thread.started.thread_id` 캡처 → `exec resume <id>` | 단발 6.3s + **resume 기억 왕복 실증** |
| `grok` | `-p/--single`, `--prompt-file` | `--session-id <uuid>` 생성 → `-p --resume <id>` | 단발 25.3s + **resume 기억 왕복 실증** |

페르소나 기억(함정 2)은 세션 resume이 유지한다 — 프로세스는 결정마다 새로 뜨지만 **대화는 하나**다. 결정마다 1회성 스폰(기억 리셋)이 아니다.

**B. 호스트 네이티브 지속 서브에이전트 + 파일/소켓 브리지 (기각).** 플레이어를 지금처럼 호스트 서브에이전트로 두고, 에이전트가 blocking wait 도구(파일 폴링 Bash)를 스스로 반복 호출해 사이드카와 파일로 교신한다. 기각 사유: ① 에이전트가 턴을 끝내지 않고 영원히 도구를 재호출해야 하는데 이는 모델 재량이라 강제할 수 없다(끊기면 복구 경로가 다시 호스트 세션 도구다 — 함정 1 재발). ② 플레이어 에이전트에 Bash/파일 도구를 줘야 해 도구 표면이 커진다. ③ Codex/Grok 서브에이전트의 장기 blocking 호출 의미론이 미확정이다. ④ 호스트 세션이 살아 있어야 게임이 산다 — A는 세션이 죽어도 게임이 돈다.

**C. 프로바이더 API 직접 호출 (기각, 어댑터 여지만 남김).** Anthropic/OpenAI/xAI HTTP API를 사이드카가 직접 부른다. 지연·제어는 최선이지만 API 키 관리와 별도 과금이 생긴다 — 이 게임은 사용자의 CLI 구독으로 돈다. `tools/player-runtime.js`의 어댑터 인터페이스만 API 구현을 나중에 받을 수 있게 둔다(v1 구현 없음).

### 결정 요약

| # | 결정 |
|---|---|
| D1 | 루프 소유자는 `tools/game-loop.js`(사이드카). `engine/cli.js`·`tools/publish.js`·`tools/coach-control.js`를 **execFile 자식 프로세스로 그대로 호출**한다(셸 없음). 라이브러리 리팩토링 없음 — 기존 계약·락·테스트를 전부 재사용한다 |
| D2 | 플레이어 = 호스트 CLI headless 대화 세션(A안). 기본 런타임은 `/start-game`을 실행한 호스트의 CLI, `--player-runtime claude\|codex\|grok`으로 오버라이드. 기동 probe(가용성 + §4 컨테인먼트 검증) 실패 시 그 런타임은 **부적격**이며 설치·인증된 다른 CLI로 폴백하고 사용자에게 한 줄 알린다. 전 런타임 부적격이면 게임을 시작하지 않는다 |
| D3 | talk 전면 제거: `--talk`/`--talk-from`/`BAD_TALK`(publish.js), turnSummary 응답 형식의 `talk` 필드(views.js), 말풍선·`lastTalk`(app.js·style.css), 4c 작별 요청·병합 규칙(스킬), 플레이어 프롬프트 talk 규약. `--narration`은 유지하되 **사이드카가 쓰는 결정적 문자열만** 싣는다 |
| D4 | 코치: 사이드카가 기존 `coach-control.js` verbs(reserve→bind-handle→accept→publish, heartbeat, complete-unavailable, finalize-cutoff)를 같은 지점에서 구동한다. 호스트 서브에이전트 스폰 → **상위 모델 CLI 1회성 호출**로 교체. 입력(`hand <n> --redacted`, `stats`)은 사이드카가 실행해 프롬프트에 인라인한다 — 코치는 무도구 단발 생성이 된다. 결과는 사이드카가 `exactResultPath`에 쓴다. `watch-accept` 백그라운드 프로세스는 사이드카 내부 async로 대체(코치 완료 → accept → publish). 공정성 불변식 유지: 코치 입력은 redacted 트레이스+stats뿐, deny 파일 forbidden literal 검사 유지 |
| D5 | §6 종합 리뷰(evaluator + 종합자)도 사이드카가 상위 모델 CLI 1회성으로 소유한다. finalize-cutoff 시퀀스(20s/10s 예산)는 기존 규약 그대로 코드화. 딜러 세션은 종료 보고만 한다 |
| D6 | **사이드카가 부트스트랩까지 소유한다**: loop 락 선점 → `init` → 서버 기동 → 루프. 딜러 역할은 사전 점검(사용자 질문, `review.md` practiceFocus 추출·Write — 모델 텍스트이므로 파일로, argv에는 그 **경로만**, 소스 파일은 **`game/` 밖**에 둔다 — init의 vacate가 지우기 전 game/ 안에 쓰면 소실된다) → **사이드카 detached 기동**(`--ai N [--stack N] [--level-every N] [--blinds SB/BB] [--force] [--player-runtime r] [--practice-focus-file 경로]` — 현행 init 옵션 전부 패스스루) → loop-state 폴링으로 부트스트랩 확인 → 브라우저 open·archivedTo 한 줄 보고 → 종료 보고. 게임 중 딜러 라운드 0. **이 순서가 기동 공백 레이스를 없앤다**: loop 락이 init보다 먼저 존재하므로, 동시 두 번째 `/start-game`은 어느 시점이든 활성 게임(loop pid)을 본다. practiceFocus 파일은 사이드카가 init 뒤 `game/.practice-focus.json`으로 복사해 코치 프롬프트에 싣는다 |
| D7 | resume: **먼저 `resume-check`의 `loopPidAlive`로 분기한다.** 살아 있으면 스폰하지 않고 **attach** — loop-state를 읽어 "게임 진행 중"을 보고하고, 요청 시 종료까지 관찰만 한다(loop 락은 살아 있는 선점자를 거부하므로 이것이 유일한 정상 경로다). 죽었거나 없을 때만 사이드카 `--resume` 스폰 — 스킬 §7 재진입 체크리스트를 전부 기계화(publish-attempt `--retry`, `repair_failed` 정지, view-only 재게시, `begin-owner` 코치 재개, 플레이어 세션 복원/재생성). **phase 복원이 플레이어 probe보다 먼저다**: loop-state가 종료 국면(finalizing 이후)이면 플레이어 워밍업·probe를 생략하고 그 지점부터 멱등 재개한다(상위 모델 경로만 필요). playing 국면인데 적격 플레이어 런타임이 하나도 없으면 유령 게임(전 결정 force-default)을 돌리지 않는다 — `halt:{code:"NO_PLAYER_RUNTIME"}`로 멈추고 실패한 probe 내역을 보고한다(사용자가 CLI 인증을 고치고 다시 resume) |
| D8 | 워치독 의미 유지(무응답 1차 한도→동일 요약 재전송 1회→`--force-default`; 파싱 실패·불일치·불법도 재요청 1회→force-default; 늦은/중복 decisionId 폐기; 사용자 대기 무제한). 사이드카 타이머로 구현. **한도는 런타임별**: claude·codex 25s/15s(현행 값), grok 60s/30s(기본 effort 실측 25.3s가 1차 한도에 걸리지 않게). grok low effort 핀이 확인되면 25s/15s로 회귀 |
| D9 | 서버 자가 치유: 게시 실패 시 사이드카가 health 확인→같은 포트·토큰으로 서버 재기동→`publish.js --retry`(스킬 §4 복구 표의 기계화). **단 SIGTERM 처리 중에는 재기동하지 않는다** — 종료 중 게시 실패는 attempt 기록으로 남기고 나가며, 다음 resume이 `--retry`로 해소한다(§4 `init --force` 순서가 이 조항에 기댄다) |
| D10 | 호스트 플레이어 에이전트 정의 2파일(`.claude/agents/holdem-player.md`, `.grok/agents/holdem-player.md`) 삭제. 플레이어 프롬프트 정본은 사이드카 쪽 한 곳(`tools/player-prompt.md`)으로 이동, 회신 규약은 "JSON 한 줄을 최종 출력으로" 하나로 통일(SendMessage·`결정:` 라벨 경로 소멸) |

## 4. 아키텍처

```
딜러 세션(LLM)          사이드카(node, detached)                 LLM CLI 자식들
────────────           ───────────────────────                ─────────────
preflight(사용자 질문,   tools/game-loop.js
 practiceFocus 추출)     ├─ [bootstrap] loop 락 → init → 서버    플레이어 p1..pn
사이드카 기동  ──기동──▶  ├─ engine/cli.js step   (execFile)     (claude|codex|grok
브라우저 open            ├─ tools/publish.js     (execFile)      headless 대화 세션)
   …(무개입)…           ├─ tools/coach-control.js (execFile)   코치·evaluator·종합자
종료 보고     ◀─결과──   ├─ tools/player-runtime.js ──────────▶  (상위 모델 1회성)
                        └─ game/loop-state.json (상태·메트릭)
```

### 새 파일

- `tools/game-loop.js` — 루프 상태기계, 워치독, 코치·리뷰 오케스트레이션, loop-lock, SIGTERM 처리.
- `tools/player-runtime.js` — CLI 어댑터: probe / 세션 생성(워밍업) / 결정 요청(resume) / 1회성 상위 모델 호출. 어댑터별 argv는 구현 Task 0에서 `--help`·프로브로 핀한다.
- `tools/player-prompt.md` — 플레이어 페르소나·행동 규약 프롬프트 정본(회신 규약: JSON 한 줄).

### 파일 계약 (전부 `game/` 런타임, gitignore 유지)

| 파일 | 소유 | 내용 |
|---|---|---|
| `game/loop.lock.d/` | 사이드카 | 수명 보유 락 **디렉터리** — `engine/state.js`의 mkdir+pid identity 원시를 **확장해** 재사용한다(별도 락 재발명 금지). **인코딩 주의**: 현행 `readPidFile`은 십진 pid 문자열만 파싱하므로, identity 기록은 **pid 파일 하나**를 `pid\n startTime` 2줄(또는 원시와 함께 개정된 형식)으로 확장하고 `readPidFile`·staleness 판정을 같이 고친다 — pid 파일에 JSON을 넣으면 `pid:null`→mtime 6s staleness로 **살아 있는 락이 회수된다**. 락 디렉터리에 그 외 파일을 두지 않는다(비재귀 `rmdir`가 ENOTEMPTY로 영구 실패). `gameEpoch`는 sessionToken(=init 이후에만 존재)에서 나오므로 락이 아니라 loop-state에 기록한다. attach·시그널·회수 경로는 pid 생존만이 아니라 **pid+startTime 일치**를 그 행위 직전에 재검증한다 — 불일치면 죽은 것으로 취급하되(회수 가능) 절대 시그널하지 않는다(fail-closed). `.lock.d` 접미사라 `vacateLive`의 reserved 규칙과도 정합 |
| `game/loop-state.json` | 사이드카 | 전이마다 원자적 갱신: `{phase, handNo, port, sessionToken, gameEpoch, lastPublishId, playerRuntime, startedAt, archivedTo?, notices[], metrics[], halt?:{code,message}, finishedAt?}` — 딜러 부트스트랩 확인·종료 보고·상태 질의·attach·테스트의 관찰 지점(딜러가 브라우저 URL·폴백/리뷰 불가 고지를 여기서 읽는다 — `notices[]`는 사이드카가 쓴 결정적 문자열). init 직후 `phase:"bootstrap"`으로 **가능한 한 빨리** 처음 기록해 딜러 폴링의 대상을 만든다. `phase ∈ {bootstrap, playing, finalizing, review_generated, review_published, done}` — 재진입 멱등의 기준이며, **엔진 `resume-check`의 `phase`(idle 등)와는 별개 축**이다. metrics 항목은 `{playerId, decisionId, runtime, outcome, elapsedMs, modelMs, parseMs, stepMs, publishMs}`로 세분한다(§2 오버헤드 기준의 판정 근거) |
| `game/loop.log` | 사이드카 | 사이드카가 **스스로 연다**(nohup 리디렉션이 아니라). init의 `vacateLive`가 game/을 비우기 전에 만든 파일이 아카이브로 쓸려 가는 문제를 피한다 — 기동 셸의 리디렉션은 부트 크래시 안전망용 임시 경로로만 |
| `game/.player-sessions.json` | 사이드카 | `{playerId: {runtime, sessionId, createdAt}}` — resume 시 대화 복원. 복원 불가면 페르소나 카드로 재생성(현행 §7 재스폰과 동일 의미) |
| `game/.turn.json`·`.publish-attempt.json`·`.coach-authority.json`·`lock.json` | 기존 | 계약 불변 |

### 프로세스·시그널

- 사이드카는 `nohup … &` detached로 뜬다(서버와 동일). 호스트 세션이 죽어도 게임은 돈다.
- **부트스트랩 순서 (새 게임)**: ① 기존 loop 락 확인 — pid+startTime 유효하게 살아 있으면 `--force` 없이는 `ACTIVE_GAME`으로 즉시 종료, `--force`면 그 사이드카를 먼저 정지(아래 순서) — ② loop 락 선점 — ③ `engine/cli.js init [--force]` 실행(엔진의 서버 정지·아카이브·페르소나 생성은 현행 그대로) — ④ 서버 기동·health — ⑤ loop-state 기록(port·archivedTo) — ⑥ 루프 진입. 락이 init보다 먼저이므로 동시 두 번째 부트스트랩은 ②에서 거부된다(기동 공백 없음).
- **게임의 "활성" 정의가 넓어진다**: 서버 pid 또는 loop 락의 pid(+startTime 일치) 중 **하나라도** 살아 있으면 활성이다. force 없는 `init`은 그 경우 `ACTIVE_GAME`으로 거부한다 — 사이드카 밖에서 `init`을 직접 부르는 수동 조작의 방어선으로 엔진에도 이 검사를 넣는다. **예외**: `loopPid == process.ppid`(락을 쥔 사이드카 자신이 부른 자식 init)는 활성으로 치지 않는다 — 부트스트랩이 자기 락에 막히지 않기 위한 규칙이다. 살아 있는 **남의** loop pid는 `--force`로도 엔진이 죽이지 않는다(`LOOP_ALIVE`로 거부 — 정지는 부트스트랩/롤백 절차의 소관, pid+startTime 검증과 함께).
- **정지 순서 (`--force`·롤백 공통): 사이드카 → 서버.** 서버를 먼저 죽이면 사이드카의 D9 자가치유가 새 서버(새 pid, lock.json 갱신)를 띄워, "옛 serverPid 사망"만 확인한 아카이브가 라이브 서버 밑에서 진행될 수 있다. 순서는: loop pid 정지(SIGTERM→확인→SIGKILL, pid+startTime 재검증 후에만 시그널) → 사망 확인 → **lock.json 재독** → 그 serverPid 정지 → 둘 다 사망 확인 후에만 아카이브. D9의 "SIGTERM 중 재기동 금지" 조항이 이 순서의 전제다. 정지 대기는 `runExclusive` **밖**에서 한다 — `.mutex`를 쥔 채 프로세스를 기다리지 않는다(사이드카의 SIGTERM 핸들러가 in-flight step을 마치려면 그 mutex가 필요하다).
- 사이드카 SIGTERM: 진행 중인 step+publish 원자 단위를 마치고 loop-state에 기록 후 종료(서버 재기동 금지 — D9). in-flight CLI 자식은 kill.
- `resume-check`에 `loopPidAlive` 필드를 추가한다(loop 락의 pid+startTime 검증 기반).

### 보안 (함정 6 + 홀카드 격리)

- 모든 자식 호출은 `execFile` 인자 배열 — 셸 미경유.
- 모델이 만들거나 에코하는 문자열(플레이어 JSON, 코치·리뷰 본문, decisionId)은 **argv에 넣지 않는다**: 프롬프트는 **stdin으로만** 넘긴다(claude `-p`는 stdin, codex `exec -`, grok `--prompt-file /dev/stdin` — 프롬프트 파일 자체를 만들지 않아 타 프로세스 가독성 문제가 없다). 응답은 stdout 캡처, 게시 본문은 파일(`--from`, `exactResultPath`)로만 흐른다.
- **홀카드 격리 (LLM 자식 컨테인먼트).** 현행 Claude 플레이어는 도구가 SendMessage·ToolSearch뿐이라 `game/state.json`(전원 홀카드)을 읽을 수 없었다. CLI 이관 후에도 같은 성질을 유지해야 한다 — 프롬프트 지시("도구를 쓰지 마라")는 컨테인먼트가 아니다:
  - 플레이어·코치·evaluator·종합자 **전부** 도구 없는 모드로 돈다: claude `--tools ""`(빈 목록), grok `--tools ""` + `--deny MCPTool` + `--disable-web-search`, codex는 최소 sandbox + 도구 차단 설정. 정확한 플래그는 Task 0 probe가 핀한다.
  - cwd는 **레포와 `game/` 밖** — `os.tmpdir()` 아래 per-runtime 빈 디렉터리(레포 지침 파일·게임 상태가 컨텍스트에 실리지 않는다). `--game-dir`·레포 경로를 LLM 자식 argv에 절대 넣지 않는다.
  - **LLM 자식의 env를 정리한다**: 레포·워크스페이스를 가리키는 상속 env(각 CLI의 프로젝트/워크스페이스 결정에 쓰이는 변수, `PWD`·`OLDPWD` 포함)를 제거하거나 tmpdir로 덮어쓴다. 인증에 필요한 것(`HOME`, PATH, CLI 자체 자격 변수)만 남긴다 — cwd만 옮기고 env를 상속하면 sandbox가 레포 읽기를 허용하는 구성이 될 수 있다.
  - **부정 검증(negative probe)이 적격 조건이다 — 단 미끼는 카나리다**: Task 0과 게임 기동 probe에서 **본게임과 동일한 cwd·argv·env**로 자식을 띄워, `game/` 안에 심은 **카나리 파일**(예측 불가한 이름, 센티널 바이트, 비밀 아님 — 보호 대상과 같은 접근 경계) 절대 경로 읽기를 지시하고, **stdout/트레이스에 센티널이 나타나지 않아야(또는 기계적 거부가 관측돼야)** 그 런타임이 적격이다. **라이브 `game/state.json`이나 홀카드가 실릴 수 있는 어떤 경로도 probe의 argv·프롬프트에 넣지 않는다** — 격리가 깨진 런타임을 잡는 probe가 그 순간 홀카드를 프로바이더로 유출하는 역설을 막는다(playing 중 resume probe 포함). 도구 차단이나 읽기 격리를 검증할 수 없는 런타임은 플레이어·코치·리뷰에 부적격이며 폴백 대상이다.
  - 코치·evaluator·종합자의 입력은 사이드카가 redacted 트레이스·stats·(종합자에 한해) `players.json`을 프롬프트에 인라인한다 — 자식이 파일에 접근할 이유 자체가 없다.

## 5. 사이드카 루프 (스킬 §4·§4c·§5·§6·§7의 기계화)

```
기동(새 게임): 부트스트랩(§4 순서: 락 → init → 서버) → 플레이어 전원 병렬 워밍업
      (세션 생성 + 페르소나 카드, "ready" 1회 — 첫 결정에서 세션 생성 비용을 뺀다)
기동(--resume): loop 락 선점 → phase 복원이 최우선. **--resume은 어떤 경로에서도 init을 부르지 않는다.**
      loop-state 없음 + 엔진 state 있음(부트 크래시 or 구스킬 게임) → 유도 규칙:
        엔진 gameOver → finalizing, 아니면 playing 으로 loop-state를 생성하고 계속
      loop-state 없음 + 엔진 state 없음 → resume 대상이 아니다(새 게임 안내 후 종료)
      phase ∈ {bootstrap} → 서버 생존 확인·기동부터 이어서 (init 재실행 금지 — epoch는 이미 존재)
      phase ∈ {finalizing, review_generated, review_published} → 플레이어 워밍업 없이
        종료 시퀀스의 그 지점부터 멱등 재개 (new-hand 금지 — 엔진도 GAME_OVER로 거부한다)
      phase == playing → 엔진 gameOver면 종료 시퀀스로 (아래 첫 전이 술어와 동일),
        아니면 재진입 체크리스트(attempt --retry → repair_failed 검사 →
        인자 없는 step → publish --view-only) → 플레이어 세션 복원/재생성
첫 전이(playing): **엔진 gameOver이면 new-hand 대신 종료 시퀀스로.**
      진행 중 핸드가 없으면 step --new-hand → publish --wait,
      있으면 재진입 view-only 출력으로 진입

LOOP:
  publish 출력(out)을 소비한다:
  ├─ out.archivePending → resume-check 1회 (같은 handNo 재실행 금지)
  │    repaired|healthy → 계속 / repair_failed → HALT(코드·안내를 loop-state에, exit≠0)
  ├─ out.handOver:
  │    코치 파이프라인 async 기동(비차단, 아래): 다음 핸드를 막지 않는다
  │    gameOver 또는 user bust → 종료 시퀀스(§6 기계화)로
  │    그 외 → step --new-hand → publish --wait (level_up이면 --narration "블라인드 …" 부착)
  ├─ out.next.kind == "user"  (사용자는 어떤 경로로도 force-default·강제 폴드하지 않는다):
  │    userAction 유효 → step user <action> [amount] --expect-version N → publish --wait = 다음 out
  │    userAction.timeout → publish --wait-only --wait-ms 60000 반복 (무한 — 사용자 대기 무제한)
  │    waitError (게시는 성공, 대기만 실패) → health 확인 → 서버 사망이면 D9 재기동 →
  │       publish --view-only(현 결정 재게시) 후 --wait-only 반복
  │    decisionId 불일치 액션 → 폐기 → --wait-only 반복
  │    step 거부(ILLEGAL_ACTION·VERSION_MISMATCH) → 인자 없는 step으로 재동기화 →
  │       publish --view-only --narration "<사이드카가 쓴 안내 한 줄>" --wait 로 재대기
  │       (거부된 envelope는 게시하지 않는다 — BAD_ENVELOPE 규약 그대로)
  ├─ out.next.kind == "ai":
  │    player-runtime에 next.message 전달(1차 한도 T1) → 무응답: 동일 요약 재전송(한도 T2) → force-default
  │    T1/T2는 D8의 런타임별 값(claude·codex 25s/15s, grok 60s/30s) — 단일 상수가 아니다
  │    응답 파싱: 코드펜스 관용 JSON 추출 → decisionId 불일치·불법·파싱 실패: 재요청 1회(T2) → force-default
  │    유효 액션 → step <pid> <action> [amount] --expect-version N → publish --wait = 다음 out
  └─ step/publish 거부는 스킬 §「실패했을 때」·§4 표를 코드로: VERSION_MISMATCH → 인자 없는
     step 재동기화, PUBLISH_FAILED → 서버 재기동+--retry, ATTEMPT_PENDING → 그 시도 --retry 선행, …
```

### 코치 파이프라인 (핸드 종료마다, async)

1. 사이드카가 **먼저** `hand <n> --redacted`·`stats`를 실행하고 스냅샷 경로를 확보한다 — `reserve`가 `--stats-file`을 즉시 읽으므로(coach-control.js `reserve()`), stats 캡처가 reserve보다 앞이다.
2. `coach-control reserve --consider-overfold --stats-file <캡처> --snapshot-file <경로>` → descriptor(`exactResultPath`, `overfoldReserved`). 같은 캡처 stats를 코치 프롬프트에도 재사용한다.
3. deny 파일 생성(비공개 홀카드·아키타입 literal), 코치 프롬프트 조립(§5 평가 문장 규칙 유지 + "아래 입력만 사용" — CLI 실행 지시는 삭제).
4. 상위 모델 CLI **spawn 직후** `bind-handle`(자식 pid+startTime — 생성 중 타임아웃·finalize가 그 워커를 식별·종료할 수 있어야 한다) → await(120s 생성 한도) → stdout JSON 검증(빈 text·handNo 불일치·forbidden literal 거부) → `exactResultPath`에 기록 → `accept --forbidden-file` → `publish.js --from <exactEnvelopePath>`.
5. 실패/타임아웃: 자식 **종료 확인**(TERM→확인→KILL) 후에만 동일 입력 교체 시도 1회(attempt 2) → 그래도 실패면 `complete-unavailable`(고정 문구). 종료 미확인이면 fence·adapter-disable 규약 그대로. 핸드 전환마다 `heartbeat`(result-ready/timeout-fence 대응 유지).
6. 멱등·epoch 가드(publishedSeals·publishQueue·expectedGameEpoch)는 기존 authority 계약 그대로.

### 종료 시퀀스 (gameOver 또는 user bust)

loop-state `phase`가 각 단계 전후에 기록되는 체크포인트다(`finalizing → review_generated → review_published → done`). 사이드카가 도중에 죽으면 `--resume`이 기록된 phase부터 멱등 재개한다(코치 authority·publish-attempt·`review.md`+digest가 각 단계의 멱등 마커).

1. **finalizing**: 마지막 핸드 코치는 **재-reserve하지 않는다** — LOOP의 handOver 분기가 이미 async로 기동한 generation을 그대로 둔다(`reserve`를 다시 부르면 그 prior가 discard돼 결과가 유실된다). `--resume`으로 finalizing에 들어온 경우에만, 그 handNo가 `publishedSeals`/`publishQueue`에 없고 live generation도 없을 때 스폰한다. 그리고 `finalDeadlineMono = now+20s` finalize: 기존 §6 순서(result 소비 → cutoff → `finalize-cutoff` → 잔여 Q 게시)를 코드로.
2. **review 생성 → `review_generated`**: evaluator(1회성, redacted 트레이스+stats만) → 종합자(1회성, evaluator 출력+결과+`players.json` 아키타입 공개) — 상위 모델, 무도구, 사이드카가 입력 인라인. **각 호출의 계약**: 생성 한도 300s, 출력 검증(비어 있지 않은 본문, 종합자는 §6 리뷰 4요소 헤딩 존재), 실패·타임아웃 시 동일 입력 재시도 1회. 재시도도 실패하면 리뷰를 지어내지 않는다 — loop-state `halt:{code:"REVIEW_FAILED"}`로 종료하고(게임 상태·코치 노트는 온전) 딜러가 사용자에게 보고한다. 성공하면 `game/review.md`(+ loop-state에 그 sha256)를 **먼저** 원자 기록하고 `review_generated`로 전이한다 — 이후 재개는 이 산출물을 재사용하지, 재생성하지 않는다(비결정 생성이 이중 게시되는 창을 없앤다).
3. **review 게시 → `review_published`**: `review.md` 본문으로 `{"review": …}` envelope 파일을 만들어 게시. 게시의 멱등은 publish-attempt 계약 + **스냅샷 대조**가 함께 보장한다: publish.js는 서버 ack 후 attempt 파일을 지우므로, ack와 phase 전이 사이에 크래시하면 attempt 없이 phase가 `review_generated`로 남는다 — 재개는 게시 전에 `ui-snapshot.json`의 review가 `review.md` digest와 일치하는지 확인하고, 일치하면 게시를 생략하고 `review_published`로 전이한다(새 publishId로 이중 게시하지 않는다).
4. **done**: loop-state `finishedAt` 기록 → 플레이어 세션 정리 → exit 0.

### 상위 모델 표 (코치·evaluator·종합자)

| 런타임 | 모델 |
|---|---|
| claude | `opus` |
| codex | `gpt-5.6-sol` |
| grok | `grok-4.6` (effort 상향이 가능하면 상향) |

플레이어 저비용 티어 표(haiku / gpt-5.6-luna / grok-4.6)는 현행 §3 유지.

## 6. talk 제거 접점

| 위치 | 변경 |
|---|---|
| `tools/publish.js` | `--talk`·`--talk-from`·`BAD_TALK`·talk 메시지 조립 제거. `reply-channel.txt` append(`nextForDealer`)도 제거 — `next.message`는 엔진 요약 그대로가 되고, 회신 규약은 어댑터가 프롬프트에 넣는다. `publish.test.js`의 talk 케이스와 **reply-channel append 케이스**가 함께 바뀐다 |
| `engine/views.js` | `turnSummary` 마지막 줄의 응답 형식에서 `"talk"` 필드 제거 |
| `server/public/app.js`·`style.css` | `lastTalk`·`.bubble` 렌더링과 `talk` 로그 라인 케이스 제거 + **`type:"talk"` 항목을 로그 렌더링에서 명시적으로 필터**한다 — 포맷터의 default 분기가 `item.text`를 돌려주므로 케이스 삭제만으로는 레거시 스냅샷·마이그레이션 전 pending attempt의 `--retry`(기록 본문 그대로 재전송, 원자성 유지)에 실린 talk가 계속 표시된다. `narration` 케이스는 유지 |
| `.agents/skills/start-game/SKILL.md` | 「모델 텍스트」절의 talk 예시, §4c 작별 요청·`--talk-from` 병합 규칙, 스폰 템플릿 talk 규약, `reply-channel.txt` 절 삭제(문서 전면 개정은 §7) |
| 플레이어 프롬프트 | `"talk":"…(선택)"` 규약 삭제 — 응답은 `{"decisionId","action","amount?}` |
| `engine/personas.js`·`players.json` | **유지.** `speech` 등 페르소나 필드는 결정 성향 입력으로 남는다(스키마·생성·아카이브 무변경) |

작별(버스트 한 줄) 흐름은 talk와 함께 통째로 사라진다 — UI는 `bust` public 이벤트를 이미 한국어로 렌더링한다.

## 7. 스킬·호스트 어댑테이션

`SKILL.md`는 얇아진다: 절대 규약(게시는 publish.js만, 한국어, 게임은 멈추지 않는다) + 사전 점검 + 사이드카 기동(부트스트랩) + 종료 보고 + resume/attach 진입. §3~§7의 루프·코치·리뷰·재진입 상세는 사이드카 구현으로 이관되고, 스킬에는 "사이드카가 한다"는 경계 선언과 기동·중단·상태 질의 문면만 남는다.

사전 점검에서 잔여 게임 판정은 `serverPidAlive`·`loopPidAlive` **동격**이다 — 둘 중 하나라도 참이면 잔여 게임으로 사용자에게 묻고(이어하기 vs 새 게임), 새 게임은 `--force`다.

기동 문면(호스트 공통, 저장소 루트 — init·서버 기동은 사이드카가 한다):

```bash
nohup node tools/game-loop.js --game-dir game --ai <n> \
  --player-runtime <이 호스트의 값: Claude Code=claude, Codex=codex, Grok=grok> \
  [--stack N] [--level-every N] [--blinds SB/BB] [--force] [--resume] \
  [--practice-focus-file <game/ 밖 경로>] \
  > /tmp/ai-holdem-boot.log 2>&1 &
# 이후 game/loop-state.json 폴링(약 250ms). 종료 조건은 벽시계가 아니라 셋 중 하나다:
#   ① halt 기록  ② phase가 bootstrap을 지남  ③ 사이드카 pid 사망.
# probe 사다리(런타임 × 플레이어/상위/컨테인먼트, grok은 콜드 1회 ~25s)가 있어 부트가
# 수십 초를 넘을 수 있다 — pid가 살아 있는 한 "기동 중"으로 보고하고 계속 기다린다(중단·--force 금지).
# ②에 도달하면 loop-state의 port·sessionToken으로 open "http://127.0.0.1:<port>/?token=<t>",
# archivedTo·notices가 있으면 한 줄씩 보고. ③이면 /tmp/ai-holdem-boot.log를 보고 중단.
```

셸 리디렉션이 `game/loop.log`가 아닌 이유: init의 `vacateLive`가 game/을 비우기 전에 만들어진 파일은 아카이브로 쓸려 간다. 본 로그는 사이드카가 init 뒤 `game/loop.log`를 스스로 연다(§4 파일 계약).

`--player-runtime`은 **스킬이 명시하는 인자다** — detached 노드 프로세스는 자기를 띄운 호스트를 추론할 수 없으므로, 각 호스트의 딜러가 위 표의 자기 값을 넣는 것이 "기본 런타임 = 시작 호스트"(D2)의 유일한 캐리어다. 미지정 시 사이드카는 폴백 사다리(claude→codex→grok) 첫 적격을 쓰고 notices에 남긴다.

| 호스트 | 기동 | 종료 인지 | 플레이어 기본 런타임 |
|---|---|---|---|
| Claude Code | 위 문면. `run_in_background` Bash를 쓰면 종료 시 자동 보고(권장) | 자동 wake 또는 사용자 질의 시 loop-state 읽기 | `claude` |
| Codex | 위 문면 그대로 | 사용자 질의 시 loop-state 읽기 (UI 리뷰 오버레이가 1차 통지) | `codex` |
| Grok | 위 문면 그대로 | 동일 | `grok` |

Gate 0(코치 스폰 primitive 확인)는 사이드카 기동 probe로 대체된다. probe는 런타임당 세 가지를 검증한다: ① 플레이어 티어 모델 1회 왕복(가용·인증), ② **상위 티어 모델 1회 왕복**(코치·evaluator·종합자용 — 플레이어 probe만으로는 opus/sol의 가용을 증명하지 못한다), ③ §4 컨테인먼트 부정 검증. ①·③ 실패 = 그 런타임 전체 부적격(폴백). ②만 실패 = 플레이어는 그 런타임, 코치·리뷰는 상위 모델이 검증된 다른 런타임으로 갈라 쓸 수 있고, 그것도 없으면 코치는 `complete-unavailable` 고정 경로·리뷰는 기동 시점에 사용자에게 고지한다. 전 런타임 부적격이면 기동 거부 + 사용자 안내(게임을 시작하지 않는다 — 시작 전 실패는 "게임은 멈추지 않는다"의 예외).

resume 문면(스킬): `resume-check`의 `loopPidAlive`가 참이면 **attach** — 사이드카를 다시 띄우지 않고 loop-state로 진행 상황을 보고한다. 거짓일 때만 `--resume` 기동(위 문면에서 `--ai`/`--force` 대신 `--resume`).

## 8. 테스트 전략

기존 스위트 유지 + 조정:

1. **엔진·서버·coach-control·publish 테스트**: 그린 유지. `publish.test.js`의 talk 케이스 삭제, `BAD_TALK` 계약 삭제.
2. **`turn-contract.test.js`**: SKILL 문면 유래를 끊고, 사이드카가 실제로 잇는 CLI 시퀀스(step→publish→step…)의 통합 계약 테스트로 개편(가치는 동일 — 엔진+게시 왕복).
3. **사이드카 단위·통합 (`test/game-loop.test.js`)**: `player-runtime`을 **fake 어댑터**(스크립트化 결정 주입)로 바꿔 전체 게임 완주. 케이스: 정상 완주(칩 보존), 워치독 타임아웃→재전송→force-default(런타임별 T1/T2 프로파일 적용 확인), 파싱 실패·decisionId 불일치·불법 액션 경로, `VERSION_MISMATCH` 재동기화, `archivePending`→resume-check 1회·`repair_failed` HALT, user bust/gameOver 종료 시퀀스(phase 체크포인트·REVIEW_FAILED halt·재진입 멱등), **사용자 경로 전체**(타임아웃 `--wait-only` 반복, waitError→서버 재기동→재대기, decisionId 불일치 폐기, 불법 액션 시 강제 폴드 없음 + narration 재게시 재대기), loop 락 이중 기동 거부(dead-pid 회수 포함), SIGTERM 원자성, resume 재진입(attempt 해소·view-only 재게시·세션 재생성·**loopPidAlive attach 분기**), metrics에 forced_default 포함 기록.
4. **어댑터 계약 (`test/player-runtime.test.js`)**: 코드펜스 관용 JSON 추출, argv에 모델 텍스트 부재(구조 검사), probe 실패 폴백, **세션 지속 트레이스**(워밍업 1회·플레이어별 상이한 세션 id·결정마다 같은 세션 재사용·복원 실패 시에만 재생성), **컨테인먼트 부정 검증**(fake로 계약 형태 고정 + 실기 probe는 Task 0).
5. **`init`/`resume-check` (`test/cli.test.js`·`test/archive.test.js` 확장)**: 서버 죽고 사이드카 살아 있는 게임의 force 없는 `init` = `ACTIVE_GAME`, `--force` = **사이드카→서버 순** 정지 후 아카이브(정지 중 D9 재기동이 없음을 fake로 단언), 정지 실패 = `LOOP_ALIVE` + 아카이브 없음, `loopPidAlive` 보고, **pid 재사용 시뮬**(같은 pid·다른 startTime → 시그널 없이 dead 취급), **부트스트랩 동시 기동 인터리빙**(두 번째가 락 선점에서 거부).
5b. **종료·재개 멱등**: gameOver 상태 `--resume`이 new-hand를 치지 않고 기록된 phase부터 재개, `review_generated` 이후 재개가 리뷰를 재생성하지 않음(review.md digest 재사용), pending review 게시 attempt는 `--retry`로만 해소, 마지막 핸드 코치의 **이중 reserve 부재**(finalizing이 handOver의 generation을 소비).
5c. **레거시 talk 마이그레이션**: talk가 실린 구버전 `.publish-attempt` 픽스처가 `--retry`로 동일 publishId·동일 본문 재전송에 성공하고, 스냅샷·증분 렌더링 모두 talk를 표시하지 않으며 narration은 유지됨.
5d. **코치 입력 격리**: 사이드카가 조립한 코치 프롬프트에 상대 홀카드 literal이 없음(redacted 입력 단언), `next.message`가 해당 playerId의 세션에만 전달됨(fake 어댑터 라우팅 단언), stats 캡처가 reserve보다 선행함(순서 단언), spawn 직후 bind-handle.
5e. **락 인코딩·부트 복구**: identity 기록 파싱(현행 `readPidFile`과의 호환 개정), 락 디렉터리 추가 파일 금지(rmdir ENOTEMPTY 회귀), 살아 있는 락이 6s staleness로 회수되지 않음, loop-state 부재 + 엔진 state 존재의 유도 규칙(gameOver→finalizing/아니면 playing, init 미호출), playing phase + 엔진 gameOver → 종료 시퀀스, bootstrap phase 재개(재-init 금지), review 게시 ack 후·전이 전 크래시 → 스냅샷 digest 대조로 이중 게시 방지, probe argv/프롬프트에 보호 대상 경로 부재(카나리만).
5f. **오버헤드 벤치**: zero-delay fake 어댑터로 전체 게임을 돌려 결정당 LLM-제외 오버헤드(parse+step+publish) ≤ 1s를 직접 단언.
6. **코치 경로**: fake CLI로 결과 파일→accept→publish 승격, 2회 실패→unavailable, finalize-cutoff.
7. **스킬 문면 계약 (`tempo-skill-contract.test.js` 개편)**: 새 SKILL에 `--talk`류·`SendMessage`·`reply-channel` 부재, 사이드카 기동 문면·attach 분기·`loopPidAlive` 동격 사전 점검 존재, `archivePending`/`repair_failed` 경계가 사이드카 소관임 명시. 기존 `.grok/agents/holdem-player.md` frontmatter 테스트는 D10(파일 삭제)에 맞춰 삭제하고, 플레이어 프롬프트 계약 검사는 `tools/player-prompt.md`로 옮긴다.
8. **실기 스모크(구현 후 체크리스트, README 갱신)**: 호스트별 3핸드 — §2 수치 판정(런타임별), 컨테인먼트 부정 probe 실측, 코치 노트 게시, 리뷰 오버레이.

## 9. 마이그레이션 · 롤백

한 브랜치에서 코드(사이드카+talk 제거)와 문서(SKILL 개정)를 태스크 단위 커밋으로 올린다. 각 태스크는 테스트 그린을 유지한다. 이 변경은 `game/` 런타임 스키마를 바꾸지 않으므로(추가 파일뿐) 진행 중이던 이전 게임의 resume에는 영향이 없다.

**동시 소유 경계를 정직하게**: loop 락은 **사이드카 프로세스끼리만** 배제한다. 구스킬 딜러 LLM은 `step`/`publish.js`를 직접 부르므로 락이 막지 못한다 — 같은 게임에 구스킬 세션과 사이드카를 동시에 붙이지 않는 것은 운영 규칙이고, 스킬 개정(구 루프 문면 삭제)이 그 경로를 없앤다. 우발적 동시 소유의 피해는 `--expect-version`이 한쪽을 거부해 제한된다.

**롤백 절차** (revert 단독으로는 부족하다 — detached 사이드카는 revert 뒤에도 메모리에 올린 코드로 계속 돈다): ① loop 락의 pid를 SIGTERM→확인(identity 검증)으로 정지, ② 미해소 `publish-attempt`는 `--retry`로 해소하고 코치 pending Q는 게시(또는 `rollback-guard`가 거부하는 동안 보존), ③ 그 다음 `git revert`. "revert로 충분"은 **정지 확인이 끝난(quiescent) 게임**에만 성립한다.

## 10. 이슈 함정 → 설계 대응

| 함정 | 대응 |
|---|---|
| 1. 플레이어 스폰/회신이 딜러 세션을 타면 왕복이 남는다 | 플레이어 I/O는 CLI 자식 프로세스(D2) — 호스트 세션 도구(SendMessage·spawn_subagent) 완전 배제. 회신은 stdout |
| 2. 지속 명명 플레이어·페르소나 기억 | CLI 세션 resume으로 대화 1개 유지(D2). 워밍업 1회 + 결정마다 같은 세션 이어쓰기 |
| 3. 게시는 publish.js만 | 사이드카의 유일한 게시 경로가 `tools/publish.js` 자식 호출(D1). curl 게시 없음 |
| 4. archivePending 중 new-hand 금지·repair_failed 정지 | 루프 상태기계에 하드코딩(§5) — LLM 재량이 아니라 코드 경로 |
| 5. 코치는 딜러 컨텍스트가 본문을 쓰지 않고, 루프를 막지 않는다 | 코치 본문은 상위 모델 CLI 1회성이 생성(D4), 사이드카는 조립·검증만. async 비차단 |
| 6. 모델 문자열을 셸 인자로 넣지 않는다 | execFile+stdin/파일 원칙(§4 보안). talk가 사라져도 코치·리뷰 본문에 동일 적용 |

## 11. 리스크

| 리스크 | 완화 |
|---|---|
| CLI 플래그 드리프트(버전업으로 argv 변경) | 기동 probe가 실제 왕복 1회로 검증 후 게임 시작. 실패 메시지에 CLI·argv 명시. 어댑터는 파일 하나(`player-runtime.js`)에 격리 |
| codex 세션 id 캡처(`--last`는 병렬 플레이어와 충돌) | **해소됨**: `--json` 첫 이벤트 `thread.started.thread_id`를 캡처해 `exec resume <id>`로 지속 — 기억 왕복 실증 완료 |
| grok low effort 미핀(스폰 파라미터에 effort 없음) | `--agent <정의파일>` 경유·설정 파일 순으로 시도, 안 되면 기본 effort 실측치(25.3s)를 기준(§2)에 반영해 정직하게 판정 |
| 플레이어 CLI 응답이 JSON 밖 텍스트/펜스 포함 | 관용 파서 + 재요청 1회 + force-default(기존 워치독 의미) |
| 사이드카 크래시 | loop-lock·loop-state 관찰 가능, publish-attempt 원자성은 기존 계약. `/start-game resume`이 사이드카 재기동 |
| 플레이어 세션 파일 누적(CLI 쪽 저장소) | v1 범위 밖 — 게임 종료 시 세션 id 파기만. 필요 시 후속 정리 |
| 딜러 세션이 게임 중 종료됨 | 정상 — 사이드카·서버는 detached. resume 문면이 loop-state로 상태 복구 |

## 12. 범위 밖 (YAGNI)

- 딜러 세션 모델·effort 튜닝, 기본 AI 수 변경, 엔진 규칙 재작성 (이슈 명시)
- 프로바이더 API 직접 어댑터(C안), 플레이어 대화 로그 뷰어, talk 대체 기능(이모트 등)
- 멀티 게임 동시 실행, 사이드카 데몬화/재시작 슈퍼바이저
- coach-control 내부 단순화(사이드카 단독 소유가 되면 authority 기계를 줄일 여지가 있으나, v1은 무변경 재사용)

## 13. 새 세션 인계물

- 이 설계: `docs/2026-08-29-in-hand-sidecar-design.md` (커밋됨)
- 플랜: `docs/2026-08-29-in-hand-sidecar-plan.md` (리뷰 수렴 후 커밋)
- 현행 정본: `.agents/skills/start-game/SKILL.md` / `engine/cli.js` `step` / `tools/publish.js` / `tools/coach-control.js`
- 실측 근거: §2 표 (프로브 2026-08-29, 이 머신) + `game/ui-snapshot.json`·`game/archive/` `history[].at`
