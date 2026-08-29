# 핸드 안 템포 — 게임 루프 사이드카 · talk 제거

날짜: 2026-08-29
이슈: #5 (핸드 안 템포: 게임 루프를 사이드카로 옮기고 talk를 뺀다)
상태: 리뷰 루프 진행 중 (R1 반영)

## 0. 리뷰 루프

공식 model-router `route_task.py`: REVIEW c2 u2 b2 r1 → risk 11/18 **CRITICAL**, 교차 가족 이중 리뷰, 저자 가족(claude) 좌석 제외. 좌석: grok-4.6(xhigh) + gpt-5.6-sol(max, luna에서 인간 승격 — tier 2 충족). 판사 없음 → 불일치는 사용자. 라우팅·좌석·영수증: `docs/sidecar-review/` (untracked).

| 라운드 | grok-4.6 | gpt-5.6-sol | 처리 |
|---|---|---|---|
| R1 | FAIL 0.86 | FAIL 0.97 | 12건 전부 수용: 홀카드 격리(무도구+cwd 격리+부정 probe), init↔사이드카 레이스(LOOP_ALIVE), user 분기 완성(강제 폴드 금지), 런타임별 워치독, attach 분기, 상위 모델 probe·리뷰 계약(REVIEW_FAILED), 롤백 절차, loop 락 identity 원시, 메트릭 객관화, 레거시 talk 필터, 테스트 확충, practiceFocus 인계 |

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
| AI 결정 elapsedMs 중앙값 — grok(grok-4.6) 플레이어 | ≤ 30s | 콜드 단발 실측 25.3s(기본 effort). low effort 핀이 확인되면 ≤ 15s로 조인다 |
| AI 결정 elapsedMs p95 | ≤ 워치독 1차 한도(D8 표: claude·codex 25s, grok 60s) | 정상 응답의 95%가 워치독을 건드리지 않는다 |
| AI 결정 elapsedMs 상한 (구조적) | ≤ 1차 한도 + 재전송 한도 + 2s | 워치독 사다리 + step/publish 오버헤드로 하드 바운드 |
| forced_default 비율 | < 10% (표본 내) | 워치독이 정상 경로가 아니라 예외 경로임을 판정 |
| 사이드카 오버헤드 (step+publish+파싱, LLM 제외) | ≤ 1s/액션 | 엔진·게시는 ms급 실측 |
| 라이브 Grok 대비 | ≥ 4× 단축 | 108s → ≤ 30s |

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
| D6 | `/start-game` 딜러 역할: 사전 점검(사용자 질문 포함, `review.md`의 practiceFocus 추출) → `init` → Write `game/.practice-focus.json`(추출문 — 모델 텍스트이므로 argv 금지) → 서버 기동 → **사이드카 detached 기동** → 종료 보고. 게임 중 딜러 라운드 0. 사이드카는 그 파일이 있으면 코치 프롬프트에 싣는다 |
| D7 | resume: **먼저 `resume-check`의 `loopPidAlive`로 분기한다.** 살아 있으면 스폰하지 않고 **attach** — loop-state를 읽어 "게임 진행 중"을 보고하고, 요청 시 종료까지 관찰만 한다(loop-lock은 살아 있는 선점자를 거부하므로 이것이 유일한 정상 경로다). 죽었거나 없을 때만 사이드카 `--resume` 스폰 — 스킬 §7 재진입 체크리스트를 전부 기계화(publish-attempt `--retry`, `repair_failed` 정지, view-only 재게시, `begin-owner` 코치 재개, 플레이어 세션 복원/재생성, 종료 국면이면 finalization·리뷰부터 멱등 재개) |
| D8 | 워치독 의미 유지(무응답 1차 한도→동일 요약 재전송 1회→`--force-default`; 파싱 실패·불일치·불법도 재요청 1회→force-default; 늦은/중복 decisionId 폐기; 사용자 대기 무제한). 사이드카 타이머로 구현. **한도는 런타임별**: claude·codex 25s/15s(현행 값), grok 60s/30s(기본 effort 실측 25.3s가 1차 한도에 걸리지 않게). grok low effort 핀이 확인되면 25s/15s로 회귀 |
| D9 | 서버 자가 치유: 게시 실패 시 사이드카가 health 확인→같은 포트·토큰으로 서버 재기동→`publish.js --retry`(스킬 §4 복구 표의 기계화) |
| D10 | 호스트 플레이어 에이전트 정의 2파일(`.claude/agents/holdem-player.md`, `.grok/agents/holdem-player.md`) 삭제. 플레이어 프롬프트 정본은 사이드카 쪽 한 곳(`tools/player-prompt.md`)으로 이동, 회신 규약은 "JSON 한 줄을 최종 출력으로" 하나로 통일(SendMessage·`결정:` 라벨 경로 소멸) |

## 4. 아키텍처

```
딜러 세션(LLM)          사이드카(node, detached)                 LLM CLI 자식들
────────────           ───────────────────────                ─────────────
preflight·init          tools/game-loop.js                     플레이어 p1..pn
서버 기동      ──기동──▶  ├─ engine/cli.js step   (execFile)     (claude|codex|grok
사이드카 기동            ├─ tools/publish.js     (execFile)      headless 대화 세션)
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
| `game/loop.lock.d/` | 사이드카 | 수명 보유 락 **디렉터리** — `engine/state.js`의 mkdir+pid identity 원시(acquire/reclaim)를 재사용한다. JSON pid 파일의 check-then-write TOCTOU를 만들지 않는다. 회수는 pid 사망 시에만(기존 `isReclaimable` 의미). `.lock.d` 접미사라 `vacateLive`의 reserved 규칙과도 정합 |
| `game/loop-state.json` | 사이드카 | 전이마다 원자적 갱신: `{phase, handNo, lastPublishId, playerRuntime, startedAt, metrics[], halt?:{code,message}, finishedAt?}` — 딜러 종료 보고·상태 질의·attach·테스트의 관찰 지점. `phase`는 finalization 체크포인트(`playing → finalizing → review → done`)를 포함해 재진입 멱등의 기준이 된다 |
| `game/.player-sessions.json` | 사이드카 | `{playerId: {runtime, sessionId, createdAt}}` — resume 시 대화 복원. 복원 불가면 페르소나 카드로 재생성(현행 §7 재스폰과 동일 의미) |
| `game/.turn.json`·`.publish-attempt.json`·`.coach-authority.json`·`lock.json` | 기존 | 계약 불변 |

### 프로세스·시그널

- 사이드카는 `nohup … &` detached로 뜬다(서버와 동일). 호스트 세션이 죽어도 게임은 돈다.
- **게임의 "활성" 정의가 넓어진다**: 서버 pid 또는 loop 락의 pid 중 **하나라도** 살아 있으면 활성이다. force 없는 `init`은 그 경우 `ACTIVE_GAME`으로 거부한다(서버만 보던 현행 판정으로는, 서버가 잠시 죽고 자가치유 사이드카가 살아 있는 게임을 `init`이 아카이브해 버린다).
- `init --force`는 **서버와 사이드카 둘 다** SIGTERM→확인 대기→SIGKILL로 정지시키고, **둘 다 죽은 것을 확인한 뒤에만** 아카이브(`runExclusive`/`vacateLive`)로 들어간다. 정지 대기는 현행 `stopServer`처럼 `runExclusive` **밖**에서 한다 — `.mutex`를 쥔 채 프로세스를 기다리지 않는다(사이드카의 SIGTERM 핸들러가 in-flight step을 마치려면 그 mutex가 필요하다). 그래도 살아 있으면 `SERVER_ALIVE`와 대칭인 `LOOP_ALIVE`로 실패하고 아카이브하지 않는다.
- 사이드카 SIGTERM: 진행 중인 step+publish 원자 단위를 마치고 loop-state에 기록 후 종료. in-flight CLI 자식은 kill.
- `resume-check`에 `loopPidAlive` 필드를 추가한다(loop 락 디렉터리의 pid 기반 — `serverPidAlive`와 같은 패턴).

### 보안 (함정 6 + 홀카드 격리)

- 모든 자식 호출은 `execFile` 인자 배열 — 셸 미경유.
- 모델이 만들거나 에코하는 문자열(플레이어 JSON, 코치·리뷰 본문, decisionId)은 **argv에 넣지 않는다**: 프롬프트는 **stdin으로만** 넘긴다(claude `-p`는 stdin, codex `exec -`, grok `--prompt-file /dev/stdin` — 프롬프트 파일 자체를 만들지 않아 타 프로세스 가독성 문제가 없다). 응답은 stdout 캡처, 게시 본문은 파일(`--from`, `exactResultPath`)로만 흐른다.
- **홀카드 격리 (LLM 자식 컨테인먼트).** 현행 Claude 플레이어는 도구가 SendMessage·ToolSearch뿐이라 `game/state.json`(전원 홀카드)을 읽을 수 없었다. CLI 이관 후에도 같은 성질을 유지해야 한다 — 프롬프트 지시("도구를 쓰지 마라")는 컨테인먼트가 아니다:
  - 플레이어·코치·evaluator·종합자 **전부** 도구 없는 모드로 돈다: claude `--tools ""`(빈 목록), grok `--tools ""` + `--deny MCPTool` + `--disable-web-search`, codex는 최소 sandbox + 도구 차단 설정. 정확한 플래그는 Task 0 probe가 핀한다.
  - cwd는 **레포와 `game/` 밖** — `os.tmpdir()` 아래 per-runtime 빈 디렉터리(레포 지침 파일·게임 상태가 컨텍스트에 실리지 않는다). `--game-dir`·레포 경로를 LLM 자식 argv에 절대 넣지 않는다.
  - **부정 검증(negative probe)이 적격 조건이다**: Task 0과 게임 기동 probe에서 cwd 밖 센티널 파일 읽기를 지시해 **실패해야** 그 런타임이 적격이다. 도구 차단이나 읽기 격리를 검증할 수 없는 런타임은 플레이어·코치·리뷰에 부적격이며 폴백 대상이다.
  - 코치·evaluator·종합자의 입력은 사이드카가 redacted 트레이스·stats·(종합자에 한해) `players.json`을 프롬프트에 인라인한다 — 자식이 파일에 접근할 이유 자체가 없다.

## 5. 사이드카 루프 (스킬 §4·§4c·§5·§6·§7의 기계화)

```
기동: loop-lock 선점 → (--resume이면 재진입 체크리스트: attempt --retry → repair_failed 검사
      → 인자 없는 step → publish --view-only) → 플레이어 전원 병렬 워밍업
      (세션 생성 + 페르소나 카드, "ready" 1회 — 첫 결정에서 세션 생성 비용을 뺀다)
첫 전이: 진행 중 핸드가 없으면 step --new-hand → publish --wait, 있으면 재진입 view-only 출력으로 진입

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

1. `coach-control reserve --consider-overfold` → descriptor(`exactResultPath`, `overfoldReserved`).
2. 사이드카가 `hand <n> --redacted`·`stats` 실행, deny 파일 생성(비공개 홀카드·아키타입 literal), 코치 프롬프트 조립(§5 평가 문장 규칙 유지 + "아래 입력만 사용" — CLI 실행 지시는 삭제).
3. 상위 모델 CLI 1회성 호출(120s 생성 한도) → stdout JSON 검증(빈 text·handNo 불일치·forbidden literal 거부) → `exactResultPath`에 기록 → `bind-handle`(자식 pid) → `accept --forbidden-file` → `publish.js --from <exactEnvelopePath>`.
4. 실패/타임아웃: 동일 입력 교체 시도 1회(attempt 2) → 그래도 실패면 `complete-unavailable`(고정 문구). 핸드 전환마다 `heartbeat`(result-ready/timeout-fence 대응 유지).
5. 멱등·epoch 가드(publishedSeals·publishQueue·expectedGameEpoch)는 기존 authority 계약 그대로.

### 종료 시퀀스 (gameOver 또는 user bust)

loop-state `phase`가 각 단계 전후에 기록되는 체크포인트다(`finalizing → review → done`). 사이드카가 도중에 죽으면 `--resume`이 기록된 phase부터 멱등 재개한다(코치 authority·publish-attempt·`review.md` 존재가 각 단계의 멱등 마커).

1. **finalizing**: 마지막 핸드 코치 스폰(생략 금지) → `finalDeadlineMono = now+20s` finalize: 기존 §6 순서(result 소비 → cutoff → `finalize-cutoff` → 잔여 Q 게시)를 코드로.
2. **review**: evaluator(1회성, redacted 트레이스+stats만) → 종합자(1회성, evaluator 출력+결과+`players.json` 아키타입 공개) — 상위 모델, 무도구, 사이드카가 입력 인라인. **각 호출의 계약**: 생성 한도 300s, 출력 검증(비어 있지 않은 본문, 종합자는 §6 리뷰 4요소 헤딩 존재), 실패·타임아웃 시 동일 입력 재시도 1회. 재시도도 실패하면 리뷰를 지어내지 않는다 — loop-state `halt:{code:"REVIEW_FAILED"}`로 종료하고(게임 상태·코치 노트는 온전) 딜러가 사용자에게 보고한다. 이후 `/start-game resume`이 review phase부터 재시도한다(§7의 "리뷰 없는 gameOver resume" 경로와 동일 의미).
3. **done**: `{"review": …}` 파일 게시 + `game/review.md` 저장 → loop-state `finishedAt` 기록 → 플레이어 세션 정리 → exit 0.

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

`SKILL.md`는 얇아진다: 절대 규약(게시는 publish.js만, 한국어, 게임은 멈추지 않는다) + 사전 점검 + init/서버/사이드카 기동 + 종료 보고 + resume 진입. §3~§7의 루프·코치·리뷰·재진입 상세는 사이드카 구현으로 이관되고, 스킬에는 "사이드카가 한다"는 경계 선언과 기동·중단·상태 질의 문면만 남는다.

기동 문면(호스트 공통, 저장소 루트):

```bash
nohup node tools/game-loop.js --game-dir game [--resume] [--player-runtime <r>] \
  > game/loop.log 2>&1 &
```

| 호스트 | 기동 | 종료 인지 | 플레이어 기본 런타임 |
|---|---|---|---|
| Claude Code | 위 문면. `run_in_background` Bash를 쓰면 종료 시 자동 보고(권장) | 자동 wake 또는 사용자 질의 시 loop-state 읽기 | `claude` |
| Codex | 위 문면 그대로 | 사용자 질의 시 loop-state 읽기 (UI 리뷰 오버레이가 1차 통지) | `codex` |
| Grok | 위 문면 그대로 | 동일 | `grok` |

Gate 0(코치 스폰 primitive 확인)는 사이드카 기동 probe로 대체된다. probe는 런타임당 세 가지를 검증한다: ① 플레이어 티어 모델 1회 왕복(가용·인증), ② **상위 티어 모델 1회 왕복**(코치·evaluator·종합자용 — 플레이어 probe만으로는 opus/sol의 가용을 증명하지 못한다), ③ §4 컨테인먼트 부정 검증. ①·③ 실패 = 그 런타임 전체 부적격(폴백). ②만 실패 = 플레이어는 그 런타임, 코치·리뷰는 상위 모델이 검증된 다른 런타임으로 갈라 쓸 수 있고, 그것도 없으면 코치는 `complete-unavailable` 고정 경로·리뷰는 기동 시점에 사용자에게 고지한다. 전 런타임 부적격이면 기동 거부 + 사용자 안내(게임을 시작하지 않는다 — 시작 전 실패는 "게임은 멈추지 않는다"의 예외).

resume 문면(스킬): `resume-check`의 `loopPidAlive`가 참이면 **attach** — 사이드카를 다시 띄우지 않고 loop-state로 진행 상황을 보고한다. 거짓일 때만 `--resume` 기동.

## 8. 테스트 전략

기존 스위트 유지 + 조정:

1. **엔진·서버·coach-control·publish 테스트**: 그린 유지. `publish.test.js`의 talk 케이스 삭제, `BAD_TALK` 계약 삭제.
2. **`turn-contract.test.js`**: SKILL 문면 유래를 끊고, 사이드카가 실제로 잇는 CLI 시퀀스(step→publish→step…)의 통합 계약 테스트로 개편(가치는 동일 — 엔진+게시 왕복).
3. **사이드카 단위·통합 (`test/game-loop.test.js`)**: `player-runtime`을 **fake 어댑터**(스크립트化 결정 주입)로 바꿔 전체 게임 완주. 케이스: 정상 완주(칩 보존), 워치독 타임아웃→재전송→force-default(런타임별 T1/T2 프로파일 적용 확인), 파싱 실패·decisionId 불일치·불법 액션 경로, `VERSION_MISMATCH` 재동기화, `archivePending`→resume-check 1회·`repair_failed` HALT, user bust/gameOver 종료 시퀀스(phase 체크포인트·REVIEW_FAILED halt·재진입 멱등), **사용자 경로 전체**(타임아웃 `--wait-only` 반복, waitError→서버 재기동→재대기, decisionId 불일치 폐기, 불법 액션 시 강제 폴드 없음 + narration 재게시 재대기), loop 락 이중 기동 거부(dead-pid 회수 포함), SIGTERM 원자성, resume 재진입(attempt 해소·view-only 재게시·세션 재생성·**loopPidAlive attach 분기**), metrics에 forced_default 포함 기록.
4. **어댑터 계약 (`test/player-runtime.test.js`)**: 코드펜스 관용 JSON 추출, argv에 모델 텍스트 부재(구조 검사), probe 실패 폴백, **세션 지속 트레이스**(워밍업 1회·플레이어별 상이한 세션 id·결정마다 같은 세션 재사용·복원 실패 시에만 재생성), **컨테인먼트 부정 검증**(fake로 계약 형태 고정 + 실기 probe는 Task 0).
5. **`init`/`resume-check` (`test/cli.test.js`·`test/archive.test.js` 확장)**: 서버 죽고 사이드카 살아 있는 게임의 force 없는 `init` = `ACTIVE_GAME`, `--force` = 둘 다 정지 후 아카이브, 정지 실패 = `LOOP_ALIVE` + 아카이브 없음, `loopPidAlive` 보고.
6. **코치 경로**: fake CLI로 결과 파일→accept→publish 승격, 2회 실패→unavailable, finalize-cutoff.
7. **스킬 문면 계약 (`tempo-skill-contract.test.js` 개편)**: 새 SKILL에 `--talk`류·`SendMessage`·`reply-channel` 부재, 사이드카 기동 문면·attach 분기 존재, `archivePending`/`repair_failed` 경계가 사이드카 소관임 명시.
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
