---
name: start-game
description: AI 홀덤 게임 시작/재개 — 딜러 오케스트레이션
argument-hint: "[AI수 1~8] | resume [--stack N] [--level-every N]"
user-invocable: true
---

# start-game

딜러(이 세션)가 포커 엔진 CLI와 중계 서버를 오케스트레이션한다. 규칙·칩 계산은 엔진만 한다. LLM은 계산하지 않는다.

사용법: `/start-game [AI수 1~8]` (옵션 `--stack N`, `--level-every N`). 기본 AI 3명(4인 테이블). 중단 재개: `/start-game resume`.

저장소 루트에서 실행. `game/`은 런타임 상태(gitignore). `game/state.json`은 **엔진만** 읽고 쓴다 — 딜러는 `view`/`legal`/`hand`/`stats`/`resume-check`로만 조회한다.

**세 호스트(Claude Code·Codex·Grok) 모두 지속 명명 서브에이전트로 실행한다.** 호스트가 갈리는 지점은 플레이어 스폰 모델과 회신 경로 둘뿐이며, 둘 다 §3에 표로 있다. §8은 호스트별 요약이다.

## 절대 규약

- 엔진 stdout의 이벤트는 visibility 미필터. 게시·나레이션은 `visibility === "public"`만. `actor:*`·`engine` 이벤트(홀카드 `deal_hole` 등)는 버리지 않으면 유출이다.
- `POST /api/publish` 본문에 단조 증가 `publishId`를 넣는다. 같은 id 재전송은 서버가 멱등 skip.
- 사용자 노출 문자열은 한국어. 아키타입·스타일·bluffFreq는 종합 리뷰 전까지 비공개.
- 게임은 멈추지 않는다. AI 실패 → `--force-default`. 사용자 불법 액션 → 강제 폴드 금지, 재게시+재대기.
- 코칭은 딜러 컨텍스트가 직접 쓰지 않는다(전 패를 이미 봤으므로). 격리 1회성 서브에이전트만.

공통 헬퍼 (저장소 루트, `TOKEN`/`PORT=8877`/`PUBLISH_ID`를 딜러가 유지):

```bash
cli() { node engine/cli.js "$@"; }
health() { curl -fsS "http://127.0.0.1:${PORT}/api/health"; }
publish() { # stdin = JSON body. TOKEN 쿼리.
  curl -fsS -X POST "http://127.0.0.1:${PORT}/api/publish?token=${TOKEN}" \
    -H 'Content-Type: application/json' --data-binary @-; }
wait_action() { # $1=decisionId
  curl -fsS "http://127.0.0.1:${PORT}/api/wait-action?token=${TOKEN}&timeoutMs=25000&expectDecisionId=$1"; }
snapshot() { curl -fsS "http://127.0.0.1:${PORT}/api/snapshot?token=${TOKEN}"; }
```

엔진 성공 envelope: `{ok:true, stateVersion, events:[...], ...}`. 실패: `{ok:false, code, message}` (exit 1 거부 / 2 사용법). 실패 시 상태 무변경.

---

## 1. 사전 점검

1. `node --version` — major ≥ 20이어야 한다. 미달이면 중단하고 사용자에게 알린다.
2. 연습 포커스: `game/review.md`가 있으면 **init으로 지우기 전에** '연습할 것' 항목을 읽어 이번 세션 `practiceFocus`로 둔다. 없으면 빈 값.
3. 활성/잔여 게임:
   - `game/lock.json`이 있으면 `{serverPid, port, sessionToken, startedAt}`을 읽는다.
   - `curl -fsS "http://127.0.0.1:<port>/api/health"` (토큰 불필요). 200 `{ok:true}`이면 서버 생존.
   - `game/`에 상태가 남아 있으면 `cli resume-check`로 `serverPidAlive`·`sessionToken`·`phase`·`toAct`를 확인해도 된다.
4. 잔여 게임이 있으면 **사용자에게 묻는다**: 이어서 할지(`/start-game resume`) vs 새 게임. 추측으로 init하지 마라.
   - 이어서 → §7.
   - 새 게임 + 서버 생존 → `cli init --ai <n> --force ...` (구 서버 SIGTERM 후 `game/` 폐기). **force 전에 review.md를 이미 읽었는지 확인.**
   - 새 게임 + 서버 사망 → `init`(force 없이 잔여 디렉터리를 폐기한다). 역시 review.md를 먼저 읽는다.

코치 메타 초기값: `lastCoachHandNo=0`, `overfoldUsed=false`, `publishId=0`.

---

## 2. 시작

인자가 없으면 AI 수 `n=3`. 범위 1~8. `--stack`(기본 5000), `--level-every`(기본 8)는 사용자 요청이 있을 때만.

```bash
cli init --ai <n>            # 옵션: --stack N --level-every N [--blinds SB/BB]
# stdout JSON에서 sessionToken 확보. 페르소나 상세는 stdout에 없다.
```

stdout 예: `{ok, stateVersion, sessionToken, players:[{playerId,name}], events:[]}`. `sessionToken`을 `TOKEN`으로 저장.

서버는 detached(터미널 훅업 없이) 기동한다. 명령 문면 그대로:

```bash
nohup node server/server.js --game-dir game --port 8877 --token <t> > game/server.log 2>&1 &
```

health가 200이 될 때까지 폴링(약 250ms 간격, 최대 ~10초). 실패하면 `game/server.log`를 보고 중단.

```bash
open "http://127.0.0.1:8877/?token=<t>"
```

macOS `open`. 브라우저가 없으면 URL을 사용자에게 보여 준다.

---

## 3. 에이전트 스폰

`game/players.json`을 읽는다. **`playerId`가 `p`로 시작하는 레코드만** 스폰(사용자는 `user`, 스폰 금지). 에이전트 이름 = 그 레코드의 `agentHandle` (`player-p1` …). 메시지 대상도 항상 `agentHandle`.

페르소나 필드: `name, speech, personality, archetype, bluffFreq, threeBetFreq, tiltProne`. init이 1회 생성하고 스폰·resume은 읽기만.

아래 템플릿을 플레이어마다 채워 **지속 명명 서브에이전트**를 스폰한다. 게임 내내 유지한다 — 핸드 간 캐릭터와 상대 읽기가 이어져야 한다.

### 플레이어 모델 (호스트별)

플레이어가 하는 일은 페르소나 유지 + JSON 한 줄 출력뿐이다. 판단 부하가 낮으므로 **저비용·저지연 티어**로 스폰한다. 딜러 세션 모델을 상속시키면 폴드 한 번에 수십 초가 걸린다 — 추정이 아니라 실측된 증상이다.

| 호스트 | 플레이어 모델 | reasoning effort |
|---|---|---|
| Claude Code | `haiku` (Haiku 4.5) | 지정하지 않음 |
| Codex | `gpt-5.6-luna` | 지정하지 않음 |
| Grok | `grok-4.6` | `low` |

스폰은 호스트의 네이티브 서브에이전트 메커니즘으로 한다 — Claude Code는 Agent 도구, Codex는 multi_agent, Grok은 `spawn_subagent`. **모델·effort를 지정하는 방법은 그 런타임의 서브에이전트 문서가 정본이다.** 스폰 파라미터에 지정 수단이 없으면(예: Grok `spawn_subagent`에는 model 파라미터가 없다) 에이전트 정의 파일이나 role/persona로 고정한다. 그래도 불가능하면 세션 모델로 스폰하되 **느려진다는 사실을 사용자에게 한 줄로 알린다.** 스폰 문법 때문에 게임이 멈추지는 않는다.

코치(§5)·evaluator·종합자(§6)는 이 표를 따르지 않는다. 판단 품질이 산출물 그 자체이므로 **딜러 세션 모델을 그대로 상속**한다.

### 회신 경로

플레이어의 결정이 딜러에게 **도달하지 않으면 게임이 멈춘다.** 경로는 호스트마다 다르므로, 스폰 프롬프트와 매 턴 요약의 `{{replyChannel}}`을 아래 문구로 채운다.

- **Claude Code:** 서브에이전트의 최종 텍스트는 딜러에게 보이지 않는다. `SendMessage`로 `to: "main"`에 보내야 한다. 그 도구가 지연 로드면 첫 결정 전에 `ToolSearch`로 `select:SendMessage`를 로드하게 한다. 그리고 `message`에 **순수 JSON 문자열만 넣으면 객체로 파싱되어 검증 오류가 난다** — JSON 앞에 `결정:` 같은 짧은 라벨 한 줄을 붙여 문자열로 만들게 한다.
- **Codex · Grok:** 네이티브 서브에이전트는 완료 시 결과가 부모에 반환된다. 최종 출력 자체가 응답이므로 별도 전송 도구가 필요 없다. 그 런타임에 부모 회신 도구가 따로 있으면 그것을 쓴다.

두 경우 모두 **스폰 시점에** 경로를 프롬프트에 박아 넣는다. 첫 턴에 빠뜨리면 그 결정은 통째로 유실된다.

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

스펙 §3 의사코드 그대로:

```
4. 반복 (게임 종료까지):
   a. engine new-hand  → 블라인드 게시·딜링 이벤트 게시
   b. 핸드 진행 중 반복:
      - engine legal → 다음 행동자 + 가능 액션
      - 사용자 차례: /api/wait-action long-poll (타임아웃 시 재시도, 무한 대기 허용)
      - AI 차례: 해당 에이전트에 상황 전송 → JSON 액션 수신
      - engine apply → 결과 이벤트(스트리트 진행·팟 정산 포함) 게시
   4b 탈출: apply/legal 결과의 handOver=true면 4c로, gameOver=true면 5로 이동한다.
   c. 핸드 종료(아카이브는 엔진이 apply에서 이미 기록): 코칭 코멘트 생성(비공개 정보 제외) 게시,
      버스트 처리(AI면 작별 멘트 후 퇴장, 사용자면 게임 종료), 레벨업 안내
5. 게임 종료: 전체 히스토리 기반 종합 리뷰 생성 → UI 리뷰 화면 게시 → 에이전트 정리
```

`handOver`와 `gameOver`가 동시에 true이면 **4c를 수행한 뒤** §6(종료)으로 간다. 마지막 핸드 코칭을 건너뛰지 마라.

### 딜러 게시 규약

매 전이 후:

1. `cli view --for user` → UI용 view. `legal` 필드는 사용자 차례에만 들어 있다.
2. 직전 명령의 `events`에서 `visibility==="public"`만 골라 `events`로 넣는다.
3. 나레이션은 public 이벤트만 근거로 `messages:[{type:"narration", text:"..."}]`.
4. AI `talk`는 `messages:[{type:"talk", playerId, text}]`.
5. `publishId`를 1부터 단조 증가해 POST. 본문: `{publishId, view?, events?, messages?, coach?, review?}`.
6. 복구 재게시는 **view만** 갱신하고 `events`를 넣지 않는다(누적 로그 중복 방지).
7. publish 실패 → health 확인, 죽었으면 §7처럼 서버 재기동 후 view-only 재게시.

### AI 차례

`legal.toAct`가 `p*`이면 `view --for <pid>`로 그 관점 뷰를 만들고, 아래 자족적 요약을 `agentHandle`에 보낸다.

**요약 필수 블록(생략 금지):** 전 생존자의 (이름, 포지션, 스택, 폴드 여부), 팟(사이드팟 포함), 내 유효 스택, legal 숫자 전부(`callAmount`·`minRaiseTo`·`maxRaiseTo`·`canCheck`·`canRaise`), `decisionId`.

턴 요약 템플릿:

```
[핸드 {{handNo}} / {{street}}] 당신: {{name}} ({{pos}}, 스택 {{stack}}) | decisionId: {{decisionId}}
홀카드: {{myCards}} | 보드: {{board}}
팟: {{potTotal}} (사이드팟 있으면 나열) | 블라인드 {{sb}}/{{bb}}
생존자: {{name(pos, 스택, 폴드여부)}} …
이번 핸드 공개 액션: …
가능한 액션: fold / check? / call {{callAmount}} / raise {{minRaiseTo}}~{{maxRaiseTo}}
minRaiseTo>maxRaiseTo 이면 합법 레이즈는 maxRaiseTo(올인)뿐이다.
{{replyChannel 한 줄 요약}} JSON 한 줄로 응답: {"decisionId":"{{decisionId}}","action":"...","amount":숫자?,"talk":"짧은 한마디(선택)"}
```

회신 경로는 매 턴 요약에도 한 줄로 반복한다(§3 「회신 경로」). 스폰 때 한 번 말했으니 됐다고 생략하지 마라 — 유실된 결정은 워치독까지 기다려야 드러난다.

워치독:

- 무응답 60초 → 동일 요약을 1회 재요청, 한도 30초 → 그래도 없으면 `cli apply <pid> --force-default --expect-version <N>`.
- 파싱 실패·decisionId 불일치·불법 액션(apply 거부) → 1회 재요청(30초) → `--force-default`.
- 늦은/중복 응답(현재 decisionId가 아님)은 폐기한다.
- 사용자 대기만 무제한이다.

`--force-default`는 체크 가능하면 체크, 아니면 폴드. 게임은 절대 멈추지 않는다.

apply는 항상 `--expect-version <직전 legal의 stateVersion>`. raise amount는 raise-to 정수.

### 사용자 차례

`toAct === "user"`:

1. public 이벤트 + `view --for user`(legal 포함)를 publish. 액션 바가 이 legal로 켜진다.
2. `wait_action <decisionId>` long-poll (기본 timeoutMs=25000). `{timeout:true}`면 재시도. **무한 반복**.
3. 슬롯 액션이 오면 `cli apply user <action> [amount] --expect-version <N>`.
4. 거부(불법·VERSION_MISMATCH 등) 시 **강제 폴드하지 않는다.** 안내 `narration` + 최신 `legal`/`view --for user` 재게시 후 wait-action으로 재진입.
5. `decisionId`가 현재 결정과 불일치하면 폐기하고 안내 이벤트를 게시한 뒤 다시 대기.
6. UI "생각 중"은 `view.toAct`가 AI일 때 서버/UI가 처리한다. 딜러는 toAct를 올바르게 게시하면 된다.

### 4c. 핸드 종료

`handOver===true`이면 §5 코칭을 호출한다. public `bust`가 AI면 작별 멘트 한 줄 요청(최선 노력, 20초) 후 실패해도 그 `agentHandle`을 종료하고 더 이상 메시지를 보내지 않는다. 사용자 bust면 게임 종료(§6). public `level_up`이 보이면 나레이션으로 레벨업을 알린다(실제 적용은 다음 `new-hand` 포스팅 전 엔진이 한다).

---

## 5. 코칭

핸드가 끝날 때마다 딜러가 코멘트를 **직접 쓰지 않는다.** 전 패를 본 컨텍스트가 쓰면 공정성을 보장할 수 없다.

재진입 멱등(스펙 §14): `snapshot`의 `coach` 배열 마지막 `handNo`(또는 메모리 `lastCoachHandNo`)가 이번 핸드와 같으면 스킵.

입력(이 네 가지만 서브에이전트에 전달 — 그 외 딜러 기억·홀카드·아키타입 금지):

1. `cli hand <n> --redacted` JSON (사용자 관점 공개 정보만)
2. `cli stats` JSON
3. `practiceFocus` (직전 `game/review.md`의 '연습할 것', 없으면 없음)
4. `coach-meta`: `{overfoldUsed: boolean}` — 표본 12핸드 이상에서 VPIP < 12%이면 세션 중 1회만 과폴드 코멘트 허용

격리된 **1회성** 코치 서브에이전트를 스폰하고, 출력을 `{handNo, text}`로만 받아 `coach: [{handNo, text}]`로 publish한다. `text`가 빈 문자열이면 publish하지 않는다.

코치는 §3의 플레이어 모델 표를 따르지 않는다 — **딜러 세션 모델을 상속**한다. 코멘트의 판단 품질이 산출물 그 자체다. 회신 경로는 플레이어와 같다(§3 「회신 경로」).

코치 서브에이전트 프롬프트:

```
너는 공정한 홀덤 코치다. 입력 JSON만 보고 판단한다. 입력에 없는 상대 홀카드·덱·아키타입·스타일을 추측하거나 언급하지 마라.

할 일: 사용자의 주요 결정 1~2개에 팟 오즈·포지션·레인지 개념을 실제 숫자와 함께 한국어 1~2줄로 코멘트.
사용자가 프리플랍에서 접은 핸드는 코멘트를 생략한다. 예외: 그 폴드 자체가 주목할 결정인 경우뿐.
표본 12핸드 이상이고 사용자 VPIP가 12% 미만이며 coach-meta.overfoldUsed가 false이면, 과폴드 누수 코멘트를 이번 한 번 허용한다. 그때 출력 JSON에 "overfold":true를 덧붙인다.

출력은 JSON 한 줄만: {"handNo":N,"text":"..."} 또는 생략 {"handNo":N,"text":""}
```

과폴드 코멘트를 실제로 게시했으면 `overfoldUsed=true`. 게시한 `handNo`를 `lastCoachHandNo`에 기록.

`view --for user`와 public 이벤트에는 아키타입·스타일을 넣지 않는다.

---

## 6. 종료

`gameOver===true`이면 종합 리뷰를 **2단계**로 만든다. 결과가 좋았다고 나쁜 과정을 칭찬하거나, 결과가 나쁘다고 좋은 과정을 비난하지 않는다.

① **격리 evaluator**(1회성 서브에이전트): 각 핸드 `hand <n> --redacted` 트레이스 + `stats`만 입력. 결정 시점에 사용자가 볼 수 있었던 정보(팟 오즈·포지션·상대 액션·레인지 추정)만으로 과정 평가. 실제 상대 홀카드·결과는 쓰지 말 것. 표본 30핸드 미만이면 '참고용' 표기.

② **종합자**(별 1회성 서브에이전트 또는 딜러가 evaluator 출력만 보고 작성): ①의 과정 평가 위에 결과 확인 + 각 AI 아키타입 공개(`players.json`은 이 단계에서만 종합자에게 제공) + 내가 잘/못 읽은 부분 + 다음 게임에서 연습할 것 1~2가지.

두 단계 모두 §3의 플레이어 모델 표를 따르지 않는다 — **딜러 세션 모델을 상속**한다. 회신 경로는 플레이어와 같다(§3 「회신 경로」).

리뷰 본문 구성:

1. 내 성향 통계: VPIP, PFR, 공격성(AF), 쇼다운 승률 + 해석
2. 결정적 핸드 2~3개 리플레이 (이때는 접힌 패 포함 전체 공개 가능 — 종합자 단계)
3. 각 AI의 실제 아키타입 공개 + 읽기 평가
4. 다음 게임에서 연습할 것 1~2가지

산출:

- `review` 필드(마크다운 문자열)로 publish. UI 오버레이는 `view.gameOver && review`일 때 표시.
- 동일 본문을 `game/review.md`로 저장.
- 생존 에이전트에 작별 한 줄(최선 노력, 20초) 후 전부 종료·정리.
- 서버는 굳이 죽이지 않아도 된다. 사용자가 닫으면 그만이다. 명시적 중단은 `cli end --result abort`.

---

## 7. resume

`/start-game resume` 또는 사전 점검에서 이어하기를 고른 경우.

```bash
cli resume-check
# {ok, serverPidAlive, port, sessionToken, stateVersion, phase, toAct, archiveRepaired}
```

- `sessionToken`을 `TOKEN`으로, `port`가 있으면 `PORT`로 쓴다. 없으면 8877.
- **서버 생존**(`serverPidAlive` 그리고 `GET /api/health` 200): 재기동하지 않고 attach.
- **서버 사망**(pid 없음/죽음 또는 health 실패): 같은 포트·토큰으로 §2의 `nohup` 명령을 다시 실행하고 health를 확인.

재진입 체크리스트(스펙 §3):

1. lock·health 확인(죽었으면 재기동)
2. `cli legal`
3. `cli view --for user`를 **view-only**로 재게시(`events` 없음). `publishId`는 `game/ui-snapshot.json`의 마지막 값 다음부터 단조 증가. 스냅샷의 `coach` 마지막 `handNo`로 `lastCoachHandNo`를 복원한다.
4. `toAct`가 사용자면 wait-action, AI면 에이전트에 상황 요약 전송.
5. `decisionId`는 같은 (handNo, street, actionIndex)에 안정적이다. apply 성공 전까지 legal을 다시 불러도 새 id가 생기지 않는다.

에이전트는 기억이 리셋된다. `players.json`에서 페르소나를 읽어 §3 템플릿으로 **재스폰**한 뒤, 각자 브리핑: 자기 페르소나, 현재 스택(`view --for <pid>`), 진행 상황 요약(핸드 번호, 스트리트, 보드 공개분, 생존자). 스타일 수치는 브리핑에 포함하되 사용자에게는 말하지 않는다.

이미 끝난 게임(`gameOver`)을 resume하면 리뷰가 없으면 §6을 수행하고, 있으면 review를 재게시(view-only + 기존 review)한 뒤 정리한다.

---

## 8. 호스트 어댑테이션

게임 루프·CLI·서버 API는 호스트 중립. 갈리는 지점은 **플레이어 스폰**과 **회신 경로** 둘뿐이고, 둘 다 §3에 있다. 이 절은 요약이다.

세 호스트 모두 **지속 명명 서브에이전트**로 실행한다. 결정마다 1회성 에이전트를 띄우는 저하 모드는 v1 경로가 아니다 — 핸드 간 캐릭터 기억이 페르소나 카드 수준으로 깎이는데 지연은 오히려 늘어난다.

| 호스트 | 스폰 | 플레이어 모델 | 회신 | 검증 상태 |
|---|---|---|---|---|
| Claude Code | Agent 도구, `name=agentHandle`, `model:"haiku"` | Haiku 4.5 | `SendMessage` → `to:"main"` | 스폰·회신 경로 실행 검증됨. `model` 지정은 도구 문서 기준 |
| Codex | multi_agent 서브에이전트 | `gpt-5.6-luna` | 완료 시 부모 반환 | 스폰 문법 미확정 |
| Grok | `spawn_subagent` | `grok-4.6`, effort `low` | 완료 시 부모 반환 | 스폰 문법 미확정 |

"미확정"은 "안 된다"가 아니라 **이 스킬이 그 문법을 확정하지 못했다**는 뜻이다. 실행 런타임이 자기 서브에이전트 문서의 정본이므로, 그 호스트에서 스폰할 때 모델·effort 지정 수단을 직접 확인해 적용한다. 첫 스폰 결과에서 실제 적용 모델을 확인할 수 있으면 확인하고, 표와 다르면 사용자에게 알린다.

알려진 제약 하나: Grok의 `spawn_subagent` 파라미터에는 model이 없다(`prompt`·`description`·`subagent_type`·`background`·`capability_mode`·`isolation`·`resume_from`·`cwd`). 모델·effort는 에이전트 정의 파일(`.grok/agents/*.md` frontmatter)이나 role/persona로 고정한 뒤 `subagent_type`으로 그 정의를 지목한다.

확인에 실패해도 게임은 진행한다 — 세션 모델로 스폰하고 사용자에게 한 줄로 알린다.

코치·evaluator·종합자는 어느 호스트에서든 **격리 1회성** 서브에이전트이며 딜러 컨텍스트를 공유하지 않는다(§5·§6). 이들만은 딜러 세션 모델을 상속한다.

---

## CLI · API 빠른 참조

| 명령 | 역할 |
|---|---|
| `init --ai n [--stack N] [--level-every N] [--force]` | 게임 생성. 활성 서버면 `--force` 필요 |
| `new-hand` | 셔플·딜링·블라인드·레벨업 판정 |
| `legal` | toAct, decisionId, call/raise 숫자, handOver, gameOver |
| `apply <pid> <action> [amount] [--expect-version N]` | 검증·적용. 스트리트/쇼다운/분배까지 자동 |
| `apply <pid> --force-default` | 체크 가능하면 체크, 아니면 폴드 |
| `view --for user\|<pid>` | 해당 관점 redacted view |
| `hand <n> [--redacted]` | 핸드 히스토리 |
| `stats` | 누적 통계 |
| `end --result abort` | 중단 마킹 |
| `resume-check` | lock·pid·아카이브 roll-forward |

서버 `127.0.0.1:8877`. `GET /api/health`만 토큰 불필요. 나머지 API는 `?token=`. `GET /api/wait-action?timeoutMs=25000&expectDecisionId=`. `POST /api/publish`, `POST /api/action`.
