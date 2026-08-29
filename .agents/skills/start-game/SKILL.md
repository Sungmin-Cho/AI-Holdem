---
name: start-game
description: AI 홀덤 게임 시작/재개 — 딜러 오케스트레이션
metadata:
  argument-hint: "[AI수 1~8] | resume [--stack N] [--level-every N]"
  user-invocable: true
---

# start-game

딜러(이 세션)가 포커 엔진 CLI와 중계 서버를 오케스트레이션한다. 규칙·칩 계산은 엔진만 한다. LLM은 계산하지 않는다.

사용법: `/start-game [AI수 1~8]` (옵션 `--stack N`, `--level-every N`). 기본 AI 3명(4인 테이블). 중단 재개: `/start-game resume`.

저장소 루트에서 실행. `game/`은 런타임 상태(gitignore). `game/state.json`은 **엔진만** 읽고 쓴다 — 딜러는 `step`(및 `hand`/`stats`/`resume-check`)으로만 상태를 다룬다.

**세 호스트(Claude Code·Codex·Grok) 모두 지속 명명 서브에이전트로 실행한다.** 호스트가 갈리는 지점은 플레이어 스폰 모델과 회신 경로 둘뿐이며, 둘 다 §3에 표로 있다. §8은 호스트별 요약이다.

## 절대 규약

- **게시는 반드시 `tools/publish.js`를 통한다.** 그 도구만이 `visibility==="public"` 필터와 `publishId` 증가를 책임진다. 직접 `curl`로 게시하면 필터가 사라지고 `actor:*` 이벤트(홀카드 `deal_hole` 등)가 그대로 UI로 나간다.
- **한 턴 = Bash 최대 1회.** Write와 백그라운드 스폰은 같은 턴에 나란히 해도 된다. 명령을 쪼갤 때마다 딜러 왕복이 한 번씩 늘고, 그게 이 게임의 실제 지연이다.
- 사용자 노출 문자열은 한국어. 아키타입·스타일·bluffFreq는 종합 리뷰 전까지 비공개.
- 게임은 멈추지 않는다. AI 실패 → `--force-default`. 사용자 불법 액션 → 강제 폴드 금지, 재게시+재대기.
- 코칭은 딜러 컨텍스트가 직접 쓰지 않는다(전 패를 이미 봤으므로). 격리 1회성 서브에이전트만.

### 턴 명령 (이 두 줄이 게임 루프의 전부다)

**Claude Code의 Bash는 호출마다 새 셸이라 함수·변수가 살아남지 않는다.** 매 호출을 자족적으로 쓴다. 포트·토큰은 `tools/publish.js`가 `game/lock.json`에서 직접 읽으므로 딜러가 들고 있을 필요가 없다.

```bash
# 액션 적용 + 게시. AI가 남긴 talk이 있으면 파일로 넘긴다(아래 「모델 텍스트」).
node engine/cli.js step <pid> <action> [amount] --expect-version <N> > game/.turn.json \
  && node tools/publish.js --from game/.turn.json --wait [--talk-from game/.talk.json]

# 핸드 시작. --new-hand는 액션 인자와 함께 쓸 수 없다.
node engine/cli.js step --new-hand > game/.turn.json \
  && node tools/publish.js --from game/.turn.json --wait
```

**`--wait`는 항상 붙인다.** 딜러는 `step`을 돌리기 전에 다음 행동자가 누구인지 모른다. 사용자 차례로 밝혀지면 도구가 그 자리에서 액션까지 받아 오고(라운드 1개 절약), AI 차례면 아무것도 하지 않고 그냥 돌아온다.

`step`의 stdout(`game/.turn.json`)은 딜러가 읽지 않는다 — 뷰 JSON을 눈으로 훑는 순간 그만큼이 컨텍스트에 쌓인다. 딜러가 보는 것은 `publish.js`의 stdout뿐이고, 다음 명령에 필요한 것이 전부 거기 있다:

```json
{"ok":true,"publishId":7,"revision":7,"stateVersion":42,"handNo":3,
 "handOver":false,"gameOver":false,
 "next":{"toAct":"p2","kind":"ai","decisionId":"d-3-flop-5",
         "agentHandle":"player-p2","message":"<그 에이전트에 그대로 보낼 전문>"}}
```

- `stateVersion` → **다음 `step`의 `--expect-version` 값이다.** 이것 때문에 `.turn.json`을 열 필요가 없다.
- `next.kind === "ai"` → `next.message`를 **가공하지 말고 그대로** `next.agentHandle`에 보낸다(§4).
- `next.kind === "user"` → 같은 호출에 `--wait`를 붙였으면 `userAction`이 함께 온다(§4 사용자 차례).
- `next === null` → 핸드 종료. `handOver`/`gameOver`로 분기한다(§4c, §6).
- `control` → 그 전이에서 나온 public 제어 이벤트 요약. `{"bust":["p2"]}`·`{"level_up":{...}}`·`{"game_over":{...}}` 중 있는 것만 실린다. §4c의 퇴장·레벨업 안내는 이걸 보고 한다.

### 실패했을 때

`step`이 거부하면 `{ok:false, code, message}`가 **stderr로도** 나오고 `&&`가 끊겨 게시는 일어나지 않는다. 딜러는 stderr의 `code`로 분기한다: `VERSION_MISMATCH`(누군가 그 사이에 상태를 바꿈 → 인자 없는 `step`으로 현재 상태를 다시 받는다), `ILLEGAL_ACTION`, `GAME_OVER`, `NO_GAME`. 어느 경우든 상태는 바뀌지 않았다.

거부된 envelope가 `game/.turn.json`을 덮어쓴 상태이므로, **그 파일로 다시 게시하지 마라.** `publish.js`는 `ok:false` envelope를 `BAD_ENVELOPE`로 거부한다(게시하지 않는다). 먼저 `step`을 다시 성공시켜 파일을 갱신한다.

### 모델 텍스트는 셸 인자로 넘기지 않는다

AI가 만든 문자열(플레이어 `talk`, 코치 코멘트, 리뷰 본문)은 **셸을 통과시키지 않는다.** 따옴표 하나로 명령이 깨지고, 최악의 경우 딜러 세션에서 임의 명령이 실행된다. heredoc도 안전하지 않다 — 본문에 종료자와 같은 줄(`EOF`)이 있으면 거기서 끊기고 나머지가 셸 문법이 된다.

**파일은 Write 도구로 만든다.** 그러면 인용 문제가 원천적으로 없고, JSON 이스케이프도 도구가 처리한다. Write와 Bash는 서로를 기다리지 않으므로 **같은 턴에 나란히 호출하면 라운드가 늘지 않는다.**

```
Write  game/.talk.json  ←  {"playerId":"p1","text":"<플레이어가 보낸 talk 원문 그대로>"}
Bash   node engine/cli.js step p1 call --expect-version 42 > game/.turn.json \
         && node tools/publish.js --from game/.turn.json --wait --talk-from game/.talk.json
```

`--narration`은 딜러 자신이 쓰는 짧은 안내이므로 인자로 넘겨도 된다. 코치·리뷰 본문도 같은 규칙이다(§5·§6).

---

## 1. 사전 점검

1. `node --version` — major ≥ 20이어야 한다. 미달이면 중단하고 사용자에게 알린다.
2. 연습 포커스: `game/review.md`가 있으면 **init으로 지우기 전에** '연습할 것' 항목을 읽어 이번 세션 `practiceFocus`로 둔다. 없으면 빈 값.
3. 활성/잔여 게임:
   - `game/lock.json`이 있으면 `{serverPid, port, sessionToken, startedAt}`을 읽는다.
   - `curl -fsS "http://127.0.0.1:<port>/api/health"` (토큰 불필요). 200 `{ok:true}`이면 서버 생존.
   - `game/`에 상태가 남아 있으면 `node engine/cli.js resume-check`로 `serverPidAlive`·`sessionToken`·`phase`·`toAct`를 확인해도 된다.
4. 잔여 게임이 있으면 **사용자에게 묻는다**: 이어서 할지(`/start-game resume`) vs 새 게임. 추측으로 init하지 마라.
   - 이어서 → §7 (라이브 슬롯만).
   - 새 게임 + 서버 생존 → `node engine/cli.js init --ai <n> --force ...`. 구 서버 SIGTERM 후, 직전 판에 플레이 흔적이 있으면 `game/archive/`로 옮기고 라이브 슬롯에 새 게임을 쓴다. `archive/`는 지우지 않는다. stdout `archivedTo`가 문자열이면 사용자에게 그 경로를 한 줄로 알린다. **force 전에 review.md를 이미 읽었는지 확인.**
   - 새 게임 + 서버 사망 → `init`(force 없이). 직전 판에 플레이 흔적이 있으면 `game/archive/`로 옮기고 라이브 슬롯에 새 게임을 쓴다. `archive/`는 지우지 않는다. stdout `archivedTo`가 문자열이면 사용자에게 그 경로를 한 줄로 알린다. 역시 review.md를 먼저 읽는다.

코치 메타 초기값: `overfoldUsed=false`. 코치 멱등·과폴드 1회·미게시 집합의 정본은 `game/.coach-authority.json`(schema v2)의 `publishedSeals`·`publishQueue`·`overfoldLease`다. 스냅샷 `coach` 배열만 보고 건너뛰지 마라(§5). `publishId`는 `tools/publish.js`가 관리한다.

---

## 2. 시작

인자가 없으면 AI 수 `n=3`. 범위 1~8. `--stack`(기본 5000), `--level-every`(기본 8)는 사용자 요청이 있을 때만.

```bash
node engine/cli.js init --ai <n>   # 옵션: --stack N --level-every N [--blinds SB/BB]
# stdout JSON에서 sessionToken 확보. 페르소나 상세는 stdout에 없다.
```

stdout 예: `{ok, stateVersion, sessionToken, players:[{playerId,name}], events:[], archivedTo}` (`archivedTo`는 문자열 또는 null). `sessionToken`은 서버 기동 인자로만 쓴다 — 이후 도구가 `game/lock.json`에서 읽으므로 딜러가 기억할 필요는 없다. `archivedTo`가 문자열이면 사용자에게 그 경로를 한 줄로 알린다.

서버는 detached(터미널 훅업 없이) 기동한다. 명령 문면 그대로:

```bash
nohup node server/server.js --game-dir game --port 8877 --token <t> > game/server.log 2>&1 &
```

health가 200이 될 때까지 폴링(약 250ms 간격, 최대 ~10초). 실패하면 `game/server.log`를 보고 중단.

```bash
open "http://127.0.0.1:8877/?token=<t>"
```

macOS `open`. 브라우저가 없으면 URL을 사용자에게 보여 준다.

마지막으로 **회신 경로를 파일에 한 번 적어 둔다.** `tools/publish.js`가 매 턴 요약 끝에 이 문장을 붙여 주므로, 딜러가 턴마다 다시 타이핑하지 않아도 된다.

**지금 실행 중인 호스트의 문면만 쓴다.** 남의 호스트 문면을 쓰면 플레이어에게 존재하지 않는 회신 수단을 매 턴 지시하게 되고, 그 결정은 워치독이 돌 때까지 통째로 유실된다.

Claude Code:

```bash
cat > game/reply-channel.txt <<'EOF'
결정은 SendMessage로 to:"main"에 보낸다. message에 순수 JSON만 넣으면 객체로 파싱되어 검증 오류가 나므로, JSON 앞에 "결정:" 라벨 한 줄을 붙여 문자열로 만든다.
EOF
```

Codex · Grok:

```bash
cat > game/reply-channel.txt <<'EOF'
결정은 이번 차례의 최종 출력으로 반환한다. JSON 한 줄만 출력하고 그 밖의 텍스트는 붙이지 않는다.
EOF
```

---

## 3. 에이전트 스폰

`game/players.json`을 읽는다. **`playerId`가 `p`로 시작하는 레코드만** 스폰(사용자는 `user`, 스폰 금지). 에이전트 이름 = 그 레코드의 `agentHandle` (`player-p1` …). 메시지 대상도 항상 `agentHandle`.

호스트의 에이전트 이름 규칙이 `agentHandle`을 그대로 받지 못하면(예: 하이픈 불가) **한 번만 정규화하고 그 매핑을 게임 내내 고정한다** — 스폰 이름과 전송 대상이 같아야 한다. `publish.js`가 돌려주는 `next.agentHandle`은 언제나 정본 값이므로, 정규화를 쓰는 호스트는 보낼 때마다 같은 규칙을 적용한다(예: `player-p1` → `player_p1`).

페르소나 필드: `name, speech, personality, archetype, bluffFreq, threeBetFreq, tiltProne`. init이 1회 생성하고 스폰·resume은 읽기만.

아래 템플릿을 플레이어마다 채워 **지속 명명 서브에이전트**를 스폰한다. 게임 내내 유지한다 — 핸드 간 캐릭터와 상대 읽기가 이어져야 한다.

### 모델 배치 (역할별)

이 게임에는 세 종류의 LLM 작업이 있고, 셋의 요구가 서로 다르다.

| 역할 | 하는 일 | 필요한 것 | 배치 |
|---|---|---|---|
| **딜러**(이 세션) | `step` 실행, `next.message` 중계, 짧은 안내 | 속도. 판단은 엔진이 한다 | 빠른 모델 + 낮은 effort |
| **플레이어** | 페르소나 유지 + JSON 한 줄 | 속도 | 저비용·저지연 티어 (아래 표) |
| **코치·evaluator·종합자** | 과정 평가와 리뷰 | 판단 품질이 산출물 그 자체 | **명시적으로 상위 모델 지정** |

**딜러 세션 모델은 사용자가 고른다 — 스킬이 바꿀 수 없다.** 세션이 무거운 모델·높은 effort로 돌고 있으면 액션 하나당 수십 초가 그대로 딜러 왕복 비용이 된다. 게임 시작 시 세션이 그런 설정이면, 한 줄로 알리고 낮출 것을 권한다(Claude Code는 `/model`·`/effort`). 사용자가 그대로 두겠다면 그대로 진행한다.

| 호스트 | 플레이어 모델 | reasoning effort |
|---|---|---|
| Claude Code | `haiku` (Haiku 4.5) | 지정하지 않음 |
| Codex | `gpt-5.6-luna` | 지정하지 않음 |
| Grok | `grok-4.6` | `low` |

스폰은 호스트의 네이티브 서브에이전트 메커니즘으로 한다 — Claude Code는 Agent 도구, Codex는 multi_agent, Grok은 `spawn_subagent`. **모델·effort를 지정하는 방법은 그 런타임의 서브에이전트 문서가 정본이다.** 스폰 파라미터에 모델이 있으면 표의 값을 명시한다. effort 파라미터가 없으면 에이전트 정의 파일에 고정한다. 그래도 세션 모델을 상속하게 되면 **느려진다는 사실을 사용자에게 한 줄로 알린다.** 스폰 문법 때문에 게임이 멈추지는 않는다.

Claude Code에는 플레이어 전용 에이전트 정의 `.claude/agents/holdem-player.md`(model `haiku`)가 있다. `subagent_type: "holdem-player"`로 스폰하면 도구 표면과 시스템 프롬프트가 작아져 턴당 응답이 더 빠르다. 그 타입이 목록에 없으면 일반 Agent 도구에 `model:"haiku"`로 스폰한다 — 어느 쪽이든 게임은 진행된다.

Grok에는 `.grok/agents/holdem-player.md`(model `grok-4.6`, `reasoning_effort: low`)가 있다. `spawn_subagent`에 `subagent_type:"holdem-player"`와 `model:"grok-4.6"`을 같이 넘긴다. 세션 모델 상속은 폴드 한 번에 수십 초가 붙는다. 그 타입이 목록에 없으면 같은 `model`로 스폰하고 한 줄로 알린다.

코치(§5)·evaluator·종합자(§6)는 이 표를 따르지 않는다. **딜러 세션이 빠른 모델일 수 있으므로 상속에 기대지 말고 스폰 시 상위 모델을 명시한다**(Claude Code는 `model:"opus"`). 판단 품질이 산출물 그 자체다.

### 회신 경로

플레이어의 결정이 딜러에게 **도달하지 않으면 게임이 멈춘다.** 경로는 호스트마다 다르다.

- **Claude Code:** 서브에이전트의 최종 텍스트는 딜러에게 보이지 않는다. `SendMessage`로 `to: "main"`에 보내야 한다. 그 도구가 지연 로드면 첫 결정 전에 `ToolSearch`로 `select:SendMessage`를 로드하게 한다. 그리고 `message`에 **순수 JSON 문자열만 넣으면 객체로 파싱되어 검증 오류가 난다** — JSON 앞에 `결정:` 같은 짧은 라벨 한 줄을 붙여 문자열로 만들게 한다.
- **Codex · Grok:** 네이티브 서브에이전트는 완료 시 결과가 부모에 반환된다. 최종 출력 자체가 응답이므로 별도 전송 도구가 필요 없다. 그 런타임에 부모 회신 도구가 따로 있으면 그것을 쓴다.

이 문면을 **두 곳에** 둔다. ① 스폰 프롬프트의 `{{replyChannel}}` — 첫 턴에 빠뜨리면 그 결정이 통째로 유실된다. ② `game/reply-channel.txt`(§2) — `tools/publish.js`가 매 턴 `next.message` 끝에 자동으로 붙인다. 딜러가 턴마다 손으로 반복할 필요는 없고, 반복이 사라져서도 안 된다.

### 스폰 프롬프트 템플릿 (전문)

```
당신은 노리밋 텍사스 홀덤 테이블의 플레이어입니다. 이 게임이 끝날 때까지 아래 캐릭터로만 행동합니다.

# 페르소나 카드
- 이름: {{name}}
- 말투: {{speech}}
- 성격: {{personality}}
- 아키타입: {{archetype}}
- 블러프 빈도: {{bluffFreq}}
- 3벳 성향: {{threeBetFreq}}
- 틸트 성향: {{tiltProne}}

# 회신 경로 (이대로 하지 않으면 결정이 딜러에게 닿지 않는다)
{{replyChannel}}

# 행동 규약
1. 보내는 내용은 JSON 한 줄뿐이다. 설명, 마크다운, 코드펜스, 앞뒤 공백 문장 금지.
2. 형식: {"decisionId":"<받은 값을 그대로>","action":"fold|check|call|raise","amount":숫자?,"talk":"짧은 한마디(선택)"}
3. decisionId는 방금 받은 값을 그대로 에코한다. 다른 id·추정 id를 넣지 않는다.
4. action은 fold | check | call | raise 네 개뿐이다. 올인은 별도 액션이 아니다. raise의 amount는 그 스트리트의 raise-to(내 총 베팅액) 정수이며 raise-by가 아니다.
5. 캐릭터(이름·말투·성격)를 유지한다. 자기 아키타입·스타일·빈도 수치를 직접 발설하지 않는다.
6. talk는 선택이며 최대 1문장. 없어도 된다.
7. 매 차례 요약은 자족적이다. 칩·팟·레이즈 범위는 요약의 숫자를 신뢰하고 직접 계산·추측하지 않는다.
8. 홀카드·보드는 요약 표기를 그대로 따른다.
9. 빠르게 답한다. 이건 한 판의 액션 하나지 분석 과제가 아니다. 도구로 파일을 읽거나 검색하지 말고, 받은 요약만으로 결정한다.

준비되면 "ready" 한 줄만 보내도 된다. 첫 JSON은 첫 차례 요약이 온 뒤에만 보낸다.
```

---

## 4. 게임 루프

스펙 §3 의사코드를 `step` 기준으로 옮긴 것:

```
4. 반복 (게임 종료까지):
   a. step --new-hand + publish  → 블라인드·딜링의 public 분만 UI로
   b. 핸드 진행 중 반복 (직전 publish의 next가 매번 다음 할 일을 알려 준다):
      - next.kind==="user": step … + publish --wait  → userAction 수령 (타임아웃이면 --wait-only 반복)
      - next.kind==="ai"  : next.message를 next.agentHandle에 전송 → JSON 액션 수신
      - 받은 액션을 다음 step의 인자로 → publish (스트리트 진행·팟 정산 이벤트 포함)
   4b 탈출: envelope의 handOver=true면 4c로. gameOver여도 4c 코치 스폰을 먼저 한다(new-hand는 치지 않음).
   c. 핸드 종료: archivePending이면 resume-check만. 아니면 코치 백그라운드 스폰(코치가 hand/stats 실행)과 작별 비차단 요청과 new-hand를 같은 턴에. 사용자 bust·gameOver면 new-hand 없이 §6.
5. 게임 종료: 전체 히스토리 기반 종합 리뷰 생성 → UI 리뷰 화면 게시 → 에이전트 정리
```

`handOver`와 `gameOver`가 동시에 true이면 **4c를 수행한 뒤** §6(종료)으로 간다. 마지막 핸드 코칭을 건너뛰지 마라.

**라운드 예산.** 정상 진행이면 AI 액션 1개 = 딜러 라운드 2개(Bash 1 + 전송 1), 사용자 액션 1개 = 라운드 1개, 핸드 종료→다음 핸드 = 라운드 1개(`archivePending`이면 그 앞의 `resume-check` 1개가 추가). 그보다 많이 쓰고 있다면 명령을 쪼개고 있다는 뜻이다 — `legal`·`view`를 `step` 앞뒤로 따로 부르거나, `.turn.json`을 읽거나, 게시를 별도 호출로 빼거나, 4c에서 코치·작별을 기다린 뒤 `new-hand`를 다음 턴으로 미루거나, 4c에서 `hand`/`stats`를 딜러 Bash로 치는 것이 전형적인 원인이다.

### 딜러 게시 규약

`tools/publish.js`가 view·public 이벤트 필터·`publishId`를 전부 맡는다. 딜러가 지킬 것은 넷뿐이다.

1. **AI `talk`는 `--talk-from <파일>`로 넘긴다**(§ 「모델 텍스트」). 플레이어 JSON의 `talk`가 없으면 생략.
2. **기계적 나레이션을 쓰지 마라.** UI가 이미 모든 public 이벤트를 한국어로 렌더링한다("권태민 콜" 등). `--narration`은 이벤트로 표현되지 않는 것에만 쓴다 — 레벨업 안내, 핸드 종료 코멘트, 사용자 불법 액션 안내.
3. 복구 재게시는 `--view-only`. **이벤트만** 빠지고 `--narration`·`--talk-from`은 그대로 실리므로, 안내와 함께 재게시할 때 쓰면 된다.
4. publish 실패는 `code`로 분기한다. 락은 어떤 실패에서도 남지 않으니 곧바로 재시도해도 된다.

| code | 뜻과 대응 |
|---|---|
| `PUBLISH_FAILED` · `PUBLISH_REJECTED` | 서버에 닿지 못했거나 거부됐다. health 확인 → 죽었으면 §7처럼 재기동한 뒤 **`publish.js` 호출만** `--retry`를 붙여 다시 실행한다(`step`은 다시 돌리지 마라 — 이미 적용된 액션이라 `VERSION_MISMATCH`로 거부되고 그 거부 envelope가 `.turn.json`을 덮어쓴다). 도구가 직전 시도를 그대로(같은 `publishId`, 같은 본문) 보내므로 서버가 이미 받았으면 건너뛰고 아니면 그대로 반영된다 — 유실도 중복도 없다. `--view-only`로 바꾸지 마라(그 전이의 이벤트가 통째로 빠진다) |
| `ATTEMPT_PENDING` | 해소되지 않은 게시 시도가 남아 있다. 그것을 먼저 `--retry`로 끝낸 뒤 이 게시를 다시 한다. 백그라운드 코치 게시가 이 코드를 받으면 턴 게시가 먼저다. `--retry`는 기록된 본문만 쓰므로 `.turn.json`이 거부 envelope로 덮여 있어도 그대로 실행된다 |
| `BAD_ATTEMPT` | 재시도 기록(`game/.publish-attempt.json`)이 깨졌다. 그 파일을 지운 뒤 인자 없는 `step`으로 현재 상태를 받아 `--view-only`로 재게시한다. 그 전이의 이벤트 일부가 로그에서 빠질 수 있다 — 상태·칩은 엔진이 이미 저장했으므로 게임은 정확하다 |
| `BAD_SNAPSHOT` | `game/ui-snapshot.json`이 깨졌다(디스크 손상급). 서버 생존 확인 후 그 파일을 지우고 재게시하면 서버가 다시 쓴다 |
| `BAD_ENVELOPE` | `.turn.json`이 거부 envelope이거나 형식이 아니다. 게시는 일어나지 않았다. `step`부터 다시 한다 |
| `NO_LOCK` | `game/lock.json`을 읽지 못했다. 서버가 떠 있는지 확인 |
| `LOCK_TIMEOUT` | 다른 게시(대개 백그라운드 코치)가 락을 잡고 있다. 서버 문제가 아니다 — 그대로 재시도 |
| `BAD_TALK` | `--talk-from` 파일이 `{playerId, text}` 형태가 아니다 |

`ok:true`인데 `waitError`가 있으면 **게시는 성공했고 사용자 대기만 실패한 것이다.** 재게시하지 말고 `--wait-only`로 대기만 다시 들어간다. `publishId`·`stateVersion`·`next`는 그 출력에 그대로 있다.

`game/.turn.json`을 열어 보지 마라. 딜러가 뷰 JSON을 읽는 순간 그만큼 컨텍스트가 늘고 다음 턴이 느려진다. 필요한 정보는 전부 `publish.js`의 stdout에 있다.

### AI 차례 — 라운드 2개

`next.kind === "ai"`이면 이미 손에 다 들려 있다. 요약을 직접 조립하지 마라 — 엔진이 만든 것이 정본이고, 딜러가 다시 쓰면 숫자가 틀어질 여지만 생긴다.

1. **라운드 1 (Bash):** `step` + `publish.js`를 `&&`로 묶은 한 줄(§ 「턴 명령」). stdout의 `next`를 받는다.
2. **라운드 2 (전송):** `next.message`를 **한 글자도 고치지 말고** `next.agentHandle`에 보낸다. 회신 경로 문면은 도구가 이미 끝에 붙여 놓았다.

그리고 플레이어의 JSON을 기다린다. 응답이 오면 다시 라운드 1로 — 그 응답의 `action`·`amount`가 다음 `step`의 인자다. `talk`가 있으면 **Write 도구로** `game/.talk.json`을 만들어 `--talk-from`으로 넘긴다(§ 「모델 텍스트」). Write와 Bash를 같은 턴에 나란히 호출하면 라운드는 늘지 않는다.

`next.message`에 들어 있는 것(엔진이 채운다): 핸드·스트리트, 그 플레이어의 이름·포지션·스택·홀카드, 보드, 팟(진짜 사이드팟이 있을 때만 분해), 전 생존자의 (이름, 포지션, 스택, 이번 스트리트 베팅, 폴드/올인 여부), 이번 핸드 공개 액션 전부, legal 숫자 전부, `decisionId`, 응답 JSON 형식.

워치독 (플레이어는 저지연 티어다 — 정상 응답은 몇 초 안에 온다):

- 무응답 25초 → 동일 `message`를 1회 재전송, 한도 15초 → 그래도 없으면 `step <pid> --force-default --expect-version <N>`.
- 파싱 실패·decisionId 불일치·불법 액션(step 거부) → 1회 재요청(15초) → `--force-default`.
- 늦은/중복 응답(현재 decisionId가 아님)은 폐기한다.
- 사용자 대기만 무제한이다.

`--force-default`는 체크 가능하면 체크, 아니면 폴드. 게임은 절대 멈추지 않는다.

`step`은 항상 `--expect-version <직전 envelope의 stateVersion>`. raise amount는 raise-to 정수.

### 사용자 차례 — 라운드 1개

표준 턴 명령에 `--wait`가 이미 붙어 있으므로(§ 「턴 명령」), 사용자 차례로 밝혀졌을 때는 **추가 라운드가 없다.** 도구가 뷰를 게시한 뒤 그 `decisionId`로 long-poll까지 마치고 `userAction`을 함께 돌려준다.

stdout의 `userAction`:

- `{"decisionId":…,"action":…,"amount":…}` → 그대로 다음 `step user <action> [amount] --expect-version <N>`의 인자다.
- `{"timeout":true}` → 게시는 이미 끝났다. **재게시 없이** 대기만 반복한다: `node tools/publish.js --from game/.turn.json --wait-only --wait-ms 60000`. 재시도에는 긴 창을 줘도 된다 — 대기 자체는 공짜이고, 창이 짧을수록 딜러 라운드만 늘어난다. **무한 반복** — 사용자 대기에는 한도가 없다.

거부(불법·VERSION_MISMATCH 등) 시 **강제 폴드하지 않는다.** `--narration '<안내 한 줄>'`과 함께 최신 상태를 재게시하고 다시 `--wait`로 들어간다. `decisionId`가 현재 결정과 불일치하는 액션은 폐기하고 같은 방식으로 다시 대기한다. 재게시가 서버의 액션 슬롯을 비우므로, 거부된 그 액션이 곧바로 되돌아오지는 않는다 — 사용자가 새로 눌러야 진행된다.

한 가지 한계: 액션이 전달된 직후 **서버가 재시작되면** 그 액션은 사라진다(서버 메모리에만 있다). `--wait-only`는 계속 timeout되고, UI는 재연결하며 액션 바를 다시 열어 주므로 사용자가 한 번 더 누르면 진행된다. 딜러는 계속 기다리기만 하면 된다.

UI "생각 중"은 `view.toAct`가 AI일 때 서버/UI가 처리한다. 딜러는 `step`이 만든 view를 그대로 게시하면 된다.

### 4c. 핸드 종료

`handOver===true`인 publish가 **이미 끝난 다음** 딜러 턴의 할 일이다. 핸드를 끝낸 step+publish Bash는 직전 턴에서 소비됐다. stdout에 이미 `archivePending`·`control`·`gameOver`가 있다. `legal`/`view`/인자 없는 `step`/`.turn.json` 열기는 4c에 없다. 이 턴의 Bash는 resume-check 또는 new-hand 중 하나다.

**`archivePending`이 참이면 이 턴은 resume-check만 한다.**

```bash
node engine/cli.js resume-check
```

`archiveStatus`가 `repaired` 또는 `healthy`면 **같은 handNo에 resume-check를 다시 치지 않는다.** 다음 턴은 직전 publish에 `archivePending`이 남아 있어도 아래 §4.2다. 이 턴에 new-hand 금지. `repair_failed`면 멈추고 사용자에게 알린다 — 그 핸드는 코칭·리뷰가 읽을 수 없게 된다. new-hand 금지. `archiveRepaired`(불리언)만 보면 정상과 복구 실패를 구분할 수 없다. `archivePending`이 없거나 거짓이면 `resume-check`를 치지 않고 §4.2로 간다.

**병렬 턴 (§4.2).** 코치 완료와 작별 응답을 기다리지 않고, 아래를 **같은 턴에 나란히** 한다. 직전 턴에서 같은 handNo의 resume-check가 repaired/healthy였으면, 직전 publish에 `archivePending`이 남아 있어도 여기로 온다.

1. §5 코치를 백그라운드로 스폰한다. 딜러는 `handNo`, `practiceFocus`, `coach-meta`만 넘긴다. 코치가 `node engine/cli.js hand <n> --redacted`와 `node engine/cli.js stats`를 직접 실행하고, 결과는 reserve가 준 `exactResultPath`에만 Write한다. 딜러는 4c에서 그 두 명령과 snapshot curl을 Bash하지 않는다. 같은 턴에 `watch-accept --publish`를 백그라운드로 띄운다(이 턴의 Bash는 아래 new-hand 한 줄). 평가·authority·unavailable은 §5다.
2. `control.bust`에 AI가 있으면 그 `agentHandle`에 작별 한 줄을 백그라운드로 요청한다. **응답을 이 턴에서 기다리지 않는다.** 그 핸들에는 이후 결정 요약(`next.message`)을 보내지 않는다. 한 줄이 다음 예정된 publish 전에 도착하면 Write `game/.talk-<playerId>-h<handNo>.json` 후 그 publish에 `--talk-from`을 붙인다. **이 턴의 `new-hand` publish에는 `--talk-from`을 붙이지 않는다.** 이후 **이미 예정된** 다른 publish에만 붙인다. `--narration`에 작별을 넣지 않는다. `.turn.json`을 이벤트와 함께 재게시하지 않는다. 그 publish에 이미 플레이어 talk가 있으면 `--talk-from` 파일에 배열로 합치거나 작별을 생략한다. 늦으면 생략한다.
3. `control.bust`에 `user`가 있거나 `gameOver===true`이면 new-hand를 치지 않는다. 코치 스폰(1)은 한 뒤 §6으로 간다. 마지막 핸드 코칭을 건너뛰지 마라.
4. 그 외에는 같은 턴의 Bash로 다음 핸드를 시작한다. `control.level_up`이 있으면 그 publish에 `--narration`을 붙인다(딜러가 쓴 문장. 실제 블라인드 적용은 엔진이 다음 핸드 시작 전에 한다).

```bash
node engine/cli.js step --new-hand > game/.turn.json \
  && node tools/publish.js --from game/.turn.json --wait
```

---

## 5. 코칭

핸드가 끝날 때마다 딜러가 코멘트를 **직접 쓰지 않는다.** 전 패를 본 컨텍스트가 쓰면 공정성을 보장할 수 없다. 권한 정본은 `game/.coach-authority.json`(schema v2)이고, 모든 mutation은 `publish.lock.d`로 직렬화한다. CLI는 `node tools/coach-control.js`다.

게임 시작 직후 **Gate 0**: 현재 세션 tool schema에서 코치용 background spawn·결과 수집·cancel/release(또는 런타임이 완료 시 자동 해제함을 입증) primitive가 있는지 확인한다. 하나라도 없으면 adapter unavailable이다. 실제 코치를 가장하지 말고 각 종료 핸드에 `complete-unavailable --reason gate0`만 사용한다. 플레이어 모델은 AGENTS 저비용 티어를 유지하고, 코치·evaluator·종합자는 **스폰 시 상위 모델을 명시**한다.

재진입 멱등: `publishQueue[handNo]` 또는 `publishedSeals[handNo]`가 있으면 그 핸드는 이미 seal됐다. 스냅샷 `coach` 배열만 보고 건너뛰지 마라. 진단용 `missing` 출력으로 spawn을 결정하지 마라 — resume spawn은 `begin-owner` descriptor만 사용한다(§7). 딜러는 4c에서 `GET /api/snapshot?token=`을 치지 않는다.

입력: 딜러는 `handNo`, `practiceFocus`, `coach-meta`만 넘긴다. 코치가 저장소 루트에서 `node engine/cli.js hand <n> --redacted`와 `node engine/cli.js stats`를 실행한다. `coach-meta.overfoldUsed`는 `reserve --consider-overfold`가 lock 안에서 반환한 `overfoldReserved`만 넣는다. 딜러 메모리로 선결정하지 마라.

정상 핸드 순서: `reserve` → host spawn(결과는 reserve가 준 `exactResultPath`에만 Write) → `bind-handle` → **딜러 턴과 직렬로 `accept`를 기다리지 말고** `watch-accept`를 백그라운드로 띄운 뒤 곧바로 다음 핸드로 간다.

```bash
node tools/coach-control.js watch-accept \
  --owner <O> --hand <n> --generation <g> \
  --forbidden-file game/.coach-deny.json --game-dir game --publish
```

`watch-accept`는 result 파일이 생기는 즉시 `accept`하고 `--publish`면 envelope를 게시한다. 딜러가 다음 핸드 AI 턴을 도는 동안에도 승격이 일어난다. deny 파일은 Write 도구로 만든다(해당 핸드 비공개 상대 홀카드 코드와 `players.json`의 `archetype, personality, bluffFreq, threeBetFreq, tiltProne` literal 배열). argv로 literal을 넘기지 마라. `accept`는 authority에 기록된 result file만 읽고 owner-neutral `publishQueue`로 승격한다. HTTP 2xx만으로 Q를 제거했다고 보지 마라. envelope의 `coachAuthority`는 HTTP body에 넣지 않는다(publisher가 뺀다).

매 핸드 전환마다 `node tools/coach-control.js heartbeat --owner <O> --game-dir game`을 실행한다. 반환 `actions`:

- `result-ready`: 유효 파일이 이미 있다. `watch-accept`가 놓쳤으면 즉시 `accept --forbidden-file` 후 `publish.js --from <exactEnvelopePath>`. **fence하지 마라.**
- `timeout-fence`: 파일이 없이 generation deadline이 지났다. 같은 입력으로 attempt 2 `reserve`를 한 번만 하고, attempt가 이미 2면 `complete-unavailable`이다.

cancel 거부·timeout·termination 미확인·release 실패면 `fence` 후 `adapter-disable`하고 이후 핸드는 unavailable fallback이다.

한 핸드 체인은 최대 두 번의 독립 1회성 시도. 빈 문자열·공백·JSON 파싱 실패·`handNo` 불일치·forbidden literal·timeout은 `INVALID_COACH_OUTPUT` / timeout이다. 첫 실패면 동일 입력으로 한 번만 교체 스폰하고, 직전 본문·부분 출력은 전달하지 않는다. 프롬프트 끝에 출력 계약 위반이라는 기계적 재시도 사유만 덧붙인다. 두 번째도 실패하면 딜러는 내용을 지어내지 않고 `complete-unavailable`로 고정 문구를 봉인한다.

```json
{"handNo":7,"text":"이 핸드의 코치 응답을 생성하지 못했습니다. 종합 리뷰에서 해당 핸드를 다시 확인합니다.","unavailable":true}
```

절대 deadline은 `process.hrtime.bigint()`다. 각 시도의 **생성 한도**는 `attemptStartedMono + 120초`다. 이 한도는 코치가 결과를 쓸 시간이지, 딜러가 `accept`를 부르기까지의 한도가 아니다. live matching generation에 유효 result 파일이 있으면 `accept`는 deadline 이후에도 승격한다. 파일이 없는 expired attempt만 `ATTEMPT_TIMEOUT`이다. 경계값 120,000ms에서 파일 없음은 expired. cancel 2초 → terminal 확인 5초 → release 2초. termination 미확인을 성공으로 보고하지 말고 adapter를 disable한 뒤 이후 핸드는 unavailable fallback이다. 회수 대상은 현재 epoch·owner의 `status=terminal`이고 `resultState=consumed|discarded`인 핸들뿐이다. persistent player·foreign handle·terminal-unread는 닫지 않는다. 게임 종료 절대 예산은 그대로 20초다. 이미 쓰인 파일은 cutoff 전에 `result-ready`/`watch-accept`로 소비하고, 그때까지 없는 핸드만 unavailable이다.

코치 서브에이전트 프롬프트:

```
너는 공정한 홀덤 코치다. 먼저 hand --redacted와 stats를 실행한다. 입력에 없는 상대 홀카드·덱·아키타입·스타일을 추측하거나 언급하지 마라.

할 일: 사용자의 주요 결정 1~2개를 한국어 1~2줄로 평가한다. 프리플랍 폴드도 예외가 아니다.
폴드가 타당하면 포지션·홀카드·선행 액션 중 의미 있는 근거로 무난한 폴드라고 평가한다.
폴드가 지나치게 타이트하면 공개 정보로 확인되는 누수를 설명한다.
특별한 누수가 없다고 억지로 비판하거나 존재하지 않는 상대 레인지·숫자를 만들지 마라.
팟 오즈가 실제 결정에 의미 있을 때만 숫자를 사용한다.
표본 12핸드 이상이고 사용자 VPIP가 12% 미만이며 coach-meta.overfoldUsed가 false이면, 과폴드 누수 코멘트를 이번 한 번 허용한다. 그때 출력 JSON에 "overfold":true를 덧붙인다.

출력은 JSON 한 줄만: {"handNo":N,"text":"..."}  (text.trim()은 비어 있으면 안 된다)
설명·마크다운·코드펜스·빈 text 금지.
```

과폴드 허용: 딜러는 4c에서 stats를 치지 않는다. `coach-meta.overfoldUsed`는 `reserve --consider-overfold`의 `overfoldReserved`만 쓴다. 모델 본문은 argv·셸 interpolation·lifecycle trace에 넣지 않는다. result/envelope는 reserve가 준 exact path만 쓰고 symlink/outside/multi-link는 거부된다.

`init --force`로 새 게임을 시작할 때 이전 게임의 코치 callback은 새 epoch에 게시되지 않는다. publisher가 generic `expectedGameEpoch`와 per-item `coachAuthority`로 막는다.

`view --for user`와 public 이벤트에는 아키타입·스타일을 넣지 않는다.

---

## 6. 종료

`gameOver===true`이면 종합 리뷰를 **2단계**로 만든다. 결과가 좋았다고 나쁜 과정을 칭찬하거나, 결과가 나쁘다고 좋은 과정을 비난하지 않는다.

① **격리 evaluator**(1회성 서브에이전트): 각 핸드 `hand <n> --redacted` 트레이스 + `stats`만 입력. 결정 시점에 사용자가 볼 수 있었던 정보(팟 오즈·포지션·상대 액션·레인지 추정)만으로 과정 평가. 실제 상대 홀카드·결과는 쓰지 말 것. 표본 30핸드 미만이면 '참고용' 표기.

② **종합자**(별 1회성 서브에이전트 또는 딜러가 evaluator 출력만 보고 작성): ①의 과정 평가 위에 결과 확인 + 각 AI 아키타입 공개(`players.json`은 이 단계에서만 종합자에게 제공) + 내가 잘/못 읽은 부분 + 다음 게임에서 연습할 것 1~2가지.

두 단계 모두 §3의 플레이어 모델 표를 따르지 않는다 — **스폰 시 상위 모델을 명시**한다(Claude Code는 `model:"opus"`). 세션 모델 상속에 기대지 마라. 회신 경로는 플레이어와 같다(§3 「회신 경로」).

리뷰 본문 구성:

1. 내 성향 통계: VPIP, PFR, 공격성(AF), 쇼다운 승률 + 해석
2. 결정적 핸드 2~3개 리플레이 (이때는 접힌 패 포함 전체 공개 가능 — 종합자 단계)
3. 각 AI의 실제 아키타입 공개 + 읽기 평가
4. 다음 게임에서 연습할 것 1~2가지

산출:

- `review` 필드(마크다운 문자열)로 게시한다. 본문은 **Write 도구로** `game/.review.json`(`{"review":"<마크다운>"}`)에 쓴 뒤 `node tools/publish.js --from game/.review.json`. 셸 인자나 heredoc으로 넘기지 마라(§ 「모델 텍스트」). UI 오버레이는 `view.gameOver && review`일 때 표시.
- 동일 본문을 `game/review.md`로 저장.
- **게임 종료 코치 finalization.** `finalDeadlineMono = now + 20초`, `resultWaitCutoffMono = finalDeadlineMono - 10초`를 한 번만 정한다. 플레이 중 생성 한도(120초)와 별개다. 순서는 설계 정본 §9.2다: (1) heartbeat의 `result-ready`와 이미 쓰인 result file을 `accept --forbidden-file`로 소비하고, migration·reconcile·terminal 결과를 소비 (2) running은 cutoff까지 대기, 교체 시도는 remaining ≥ 5초일 때만 (3) cutoff에서 새 play-time `publish.js` 시작을 멈추고 live publisher process-group만 TERM 2초 → 확인 5초 → KILL/release 2초 (4) lock holder 부재를 확인한 뒤 `node tools/coach-control.js finalize-cutoff --completed N --owner O --stats-file S --snapshot-file P --termination-confirmed true|false` 한 번으로 missing 전체를 한 transaction에서 fence + unavailable Q seal한다. `--termination-confirmed false`이거나 명령이 `FINALIZATION_ABORTED`면 리뷰 gate를 열지 마라. (5) 그 다음에만 remaining으로 `publish.js --deadline-monotonic-ns <finalDeadline>` retry/Q 게시 (6) missing handNo를 성공처럼 숨기지 마라.
- step 4가 commit됐으면 Published 또는 durable Pending(coach/unavailable)이 `1..sample`을 덮는다. 그때만 evaluator·종합 리뷰를 시작하고 Pending의 `handNo`·`noteKind`를 명시한다. UI 게시를 주장하지 마라.
- 생존 에이전트에 작별 한 줄(최선 노력, 20초) 후 전부 종료·정리. persistent player를 코치 용량 때문에 닫지 마라.
- 서버는 굳이 죽이지 않아도 된다. 사용자가 닫으면 그만이다. 명시적 중단은 `node engine/cli.js end --result abort`.

---

## 7. resume

`/start-game resume` 또는 사전 점검에서 이어하기를 고른 경우.

```bash
node engine/cli.js resume-check
# {ok, serverPidAlive, port, sessionToken, stateVersion, phase, toAct,
#  archiveRepaired, archiveStatus: "healthy"|"repaired"|"repair_failed"}
```

- **서버 생존**(`serverPidAlive` 그리고 `GET /api/health` 200): 재기동하지 않고 attach.
- **서버 사망**(pid 없음/죽음 또는 health 실패): 같은 포트·토큰으로 §2의 `nohup` 명령을 다시 실행하고 health를 확인. `game/reply-channel.txt`가 없으면 §2대로 다시 쓴다.

재진입 체크리스트(스펙 §3):

1. `game/.publish-attempt.json`이 있으면 **먼저 `--retry`로 해소한다** — 직전 세션이 게시 도중 끊긴 것이고, 해소 전에는 아래 재게시가 `ATTEMPT_PENDING`으로 막힌다.
2. lock·health 확인(죽었으면 재기동). **`resume-check`의 `archiveStatus`가 `repair_failed`이면 여기서 멈춘다** — 직전 세션이 아카이브를 쓰지 못한 채 끊긴 것이고, 다음 핸드를 시작하면 그 기록은 복구 불가능해진다(§4c).
3. 인자 없는 `step`으로 현재 상태를 읽고 **view-only**로 재게시한다 — 상태를 바꾸지 않고 이벤트도 다시 싣지 않는다. `publishId`는 도구가 스냅샷에서 이어 받으므로 딜러가 복원할 것이 없다.
   ```bash
   node engine/cli.js step > game/.turn.json && node tools/publish.js --from game/.turn.json --view-only
   ```
4. 출력의 `next`가 그대로 다음 할 일이다 — `kind:"user"`면 `--wait-only`로 대기, `kind:"ai"`면 `next.message`를 그 에이전트에 전송.
5. `decisionId`는 같은 (handNo, street, actionIndex)에 안정적이다. 액션이 적용되기 전까지 `step`을 다시 불러도 새 id가 생기지 않는다.
6. 코치 resume는 `begin-owner --completed N --stats-file S --snapshot-file P --owner <새UUID>` 한 번이다. 이 명령이 lock 안에서 migration·reconcile·Published/Pending 재독·owner switch·`M_now` 전체 reserve를 한다. 반환된 descriptor만 attempt 1로 스폰하고, 사전 `missing`이나 별도 `reserve`로 spawn을 결정하지 마라. pending Q는 재스폰하지 않고 `--retry`로 먼저 게시한다.

에이전트는 기억이 리셋된다. `players.json`에서 페르소나를 읽어 §3 템플릿으로 **재스폰**한다. 별도 브리핑은 필요 없다 — 차례가 온 플레이어는 `next.message`만으로 자족적이다(스택·보드·생존자·공개 액션이 전부 들어 있다). 아직 차례가 아닌 플레이어에게 상황을 미리 알리려면 페르소나 카드까지만, 스타일 수치는 브리핑에 포함하되 사용자에게는 말하지 않는다.

이미 끝난 게임(`gameOver`)을 resume하면 리뷰가 없으면 §6을 수행하고, 있으면 review를 재게시(view-only + 기존 review)한 뒤 정리한다.

---

## 8. 호스트 어댑테이션

게임 루프·CLI·서버 API는 호스트 중립. 갈리는 지점은 **플레이어 스폰**과 **회신 경로** 둘뿐이고, 둘 다 §3에 있다. 이 절은 요약이다.

세 호스트 모두 **지속 명명 서브에이전트**로 실행한다. 결정마다 1회성 에이전트를 띄우는 저하 모드는 v1 경로가 아니다 — 핸드 간 캐릭터 기억이 페르소나 카드 수준으로 깎이는데 지연은 오히려 늘어난다.

| 호스트 | 스폰 | 플레이어 모델 | 회신 | 검증 상태 |
|---|---|---|---|---|
| Claude Code | Agent 도구, `name=agentHandle`, `subagent_type:"holdem-player"`(없으면 `model:"haiku"`) | Haiku 4.5 | `SendMessage` → `to:"main"` | 스폰·회신 경로 실행 검증됨. `model` 지정은 도구 문서 기준 |
| Codex | multi_agent 서브에이전트 | `gpt-5.6-luna` | 완료 시 부모 반환 | 스폰 문법 미확정 |
| Grok | `spawn_subagent`, `subagent_type:"holdem-player"`, `model:"grok-4.6"` | `grok-4.6`, effort `low`(정의 파일) | 완료 시 부모 반환 | `model` 파라미터 확인됨. effort는 스폰 파라미터에 없고 `.grok/agents/holdem-player.md`에 고정 |

Codex 칸의 "미확정"은 "안 된다"가 아니라 **이 스킬이 그 문법을 확정하지 못했다**는 뜻이다. 실행 런타임이 자기 서브에이전트 문서의 정본이므로, 그 호스트에서 스폰할 때 모델·effort 지정 수단을 직접 확인해 적용한다. 첫 스폰 결과에서 실제 적용 모델을 확인할 수 있으면 확인하고, 표와 다르면 사용자에게 알린다.

Grok `spawn_subagent`는 `prompt`·`description`·`subagent_type`·`background`·`isolation`·`resume_from`·`cwd`·`model`을 받는다. `model`은 `"grok-4.6"`으로 넘긴다. effort는 이 파라미터 목록에 없으므로 `.grok/agents/holdem-player.md` frontmatter `reasoning_effort: low`가 정본이다.

확인에 실패해도 게임은 진행한다 — 세션 모델로 스폰하고 사용자에게 한 줄로 알린다.

코치·evaluator·종합자는 어느 호스트에서든 **격리 1회성** 서브에이전트이며 딜러 컨텍스트를 공유하지 않는다(§5·§6). 이들만은 상위 모델을 명시해 스폰한다.

---

## CLI · API 빠른 참조

게임 루프에서 쓰는 것은 `step` 하나다. 나머지는 초기화·조회·복구용이다.

| 명령 | 역할 |
|---|---|
| `step [<pid> <action> [amount]] [--new-hand] [--expect-version N] [--force-default]` | **게임 루프의 유일한 명령.** 최대 1회 변경 후 `{events, handOver, gameOver, view, next}`를 준다. 인자가 없으면 읽기 전용 |
| `init --ai n [--stack N] [--level-every N] [--force]` | 게임 생성. 활성 서버면 `--force` 필요 |
| `hand <n> [--redacted]` | 핸드 히스토리 (코치·evaluator 입력) |
| `stats` | 누적 통계 |
| `end --result abort` | 중단 마킹 |
| `resume-check` | lock·pid·아카이브 roll-forward |
| `new-hand` · `legal` · `apply` · `view` | `step`이 대신한다. 디버깅·검증용으로 남아 있다 |

| `tools/publish.js` 옵션 | 역할 |
|---|---|
| `--from <파일>` | `step` envelope(또는 `{"coach":…}`/`{"review":…}`)을 게시. 필수 |
| `--talk-from <파일>` | `{playerId, text}` (또는 그 배열) — AI 한마디를 셸을 거치지 않고 로그에 |
| `--talk '<pid>:<한마디>'` | 같은 일을 인자로. 모델 산출 텍스트에는 쓰지 마라 |
| `--narration '<문장>'` | 이벤트로 표현 안 되는 안내만 |
| `--retry` | 직전 시도를 같은 `publishId`·같은 본문으로 재전송. 게시 실패 복구용. 미해소 시도가 있으면 다른 게시는 `ATTEMPT_PENDING`으로 막힌다 |
| `--view-only` | 이벤트를 빼고 재게시(복구·resume). 메시지는 그대로 실린다 |
| `--wait [--wait-ms N]` | 게시 후 사용자 액션 long-poll (기본 25000ms) |
| `--wait-only` | 게시 없이 대기만 (타임아웃 재시도) |
| `--lock-wait-ms N` | 게시 락 대기 한도(기본 20000). 평소 건드릴 일 없다 |
| `--print-game-epoch` | 현재 `lock.json` sessionToken의 sha256 hex만 출력 |
| `--deadline-monotonic-ns N` | lock wait와 HTTP를 이 절대 deadline remaining으로 자른다 |

`tools/coach-control.js`: `begin-owner`, `reserve`, `bind-handle`, `accept`, `watch-accept`, `complete-unavailable`, `reconcile`, `heartbeat`, `fence`, `adapter-disable`, `missing`, `finalize-cutoff`, `completeness`, `cleanup-result`, `rollback-guard`. `watch-accept`는 result 파일을 폴링해 즉시 승격한다(`--publish`면 envelope 게시). 권한 파일은 `game/.coach-authority.json`. pending Q·active worker·unresolved attempt가 있으면 `rollback-guard`가 `ROLLBACK_REFUSED`다.

포트·토큰은 도구가 `game/lock.json`에서 읽는다. 서버 `127.0.0.1:8877`, `GET /api/health`만 토큰 불필요. 직접 호출이 필요하면 `POST /api/action`, `GET /api/snapshot?token=`.
