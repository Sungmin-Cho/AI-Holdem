# 핸드 안 사이드카 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline) 또는 superpowers:subagent-driven-development로 태스크 단위 실행. 스텝은 체크박스(`- [ ]`)로 추적한다.

**이 플랜은 이 워크트리(`/Users/sungmin/orca/workspaces/AI-Holdem/conger`, 브랜치 `Sungmin-Cho/issue-5-design-plan`)에서 실행한다.** 라이브 체크아웃(`/Users/sungmin/Dev/AI-Holdem`, `game/` 있음)을 읽지도 쓰지도 않는다. `/start-game`을 실행하지 않는다. 테스트는 전부 tmp 게임 디렉터리를 쓴다 — 저장소 안에 `game/`을 만들지 않는다.

**Goal:** 핸드 안 게임 루프를 딜러 LLM 세션에서 노드 사이드카(`tools/game-loop.js`)로 옮기고, 플레이어를 호스트 CLI headless 대화 세션으로 부르며, talk를 전면 제거한다.

**Architecture:** 사이드카가 부트스트랩(loop 락 → init → 서버)부터 종료 리뷰까지 소유하고, `engine/cli.js`·`tools/publish.js`·`tools/coach-control.js`를 execFile 자식으로 그대로 부른다(계약 무변경). LLM은 플레이어 결정·코치·리뷰 생성만 하고, 전부 무도구 CLI 자식이다. 딜러 스킬은 사전 점검 + 사이드카 기동 + 보고로 얇아진다.

**Tech Stack:** Node ≥ 20 ESM, 외부 npm 의존성 0, `node --test`. LLM CLI: `claude`(-p/--resume), `codex`(exec/exec resume), `grok`(-p/--resume).

**Spec:** `docs/2026-08-29-in-hand-sidecar-design.md` — **플랜과 충돌하면 스펙이 이긴다.** 스펙 §0의 "구현 이월" 절이 이 플랜의 Task 0·9가 확정할 항목의 정본이다.

## Global Constraints

- Node ≥ 20, `"type": "module"`, 외부 의존성 0, 빌드 없음.
- 테스트 실행은 **인자 없는 `node --test`** (디렉토리 인자는 Node v26에서 실패). 단건은 `node --test test/<파일>.test.js`.
- 사용자 노출 문자열 전부 한국어. 아키타입·비공개 홀카드는 public 경로·코치 프롬프트에 넣지 않는다.
- 모델이 만들거나 에코하는 문자열은 셸 argv에 넣지 않는다: 프롬프트는 stdin, 응답은 stdout 캡처, 게시 본문은 파일. 모든 자식은 `execFile`/`spawn` 인자 배열(셸 미경유).
- **async만**: `execFileSync`/`spawnSync`로 서버·publish를 부르지 않는다(인프로세스 서버와 교착 — `test/turn-contract.test.js`의 async 패턴을 따른다).
- `engine/**`는 순수(네트워크·타이머·LLM 금지) — 이번에 추가되는 것도 파일·프로세스 검사뿐이다. `server/server.js`는 수정하지 않는다.
- 커밋: conventional commit(제목 한국어 허용), 태스크당 1커밋 이상. 각 태스크 종료 시 전체 `node --test` 그린.
- `.claude/skills/start-game`·`.grok/skills/start-game`은 심볼릭 링크 — 건드리지 않는다. 정본은 `.agents/skills/start-game/SKILL.md`.

## 파일 구조

```
tools/game-loop.js            # 신규: 사이드카 (부트스트랩·루프·워치독·코치·리뷰·resume)
tools/player-runtime.js       # 신규: LLM CLI 어댑터 (probe·warmup·decide·oneshot·파서)
tools/player-prompt.md        # 신규: 플레이어 프롬프트 정본 (페르소나 카드 + 행동 규약)
engine/state.js               # 수정: owned lock 원시 (pid+startTime identity, 수명 보유)
engine/game-archive.js        # 수정: init 활성 정의 확장 (loop pid, ppid 예외, LOOP_ALIVE)
engine/cli.js                 # 수정: resume-check에 loopPidAlive
engine/views.js               # 수정: turnSummary 응답 형식에서 talk 제거
tools/publish.js              # 수정: talk·reply-channel 제거
server/public/app.js          # 수정: talk 렌더링 제거 + type:"talk" 필터
server/public/style.css      # 수정: .bubble 제거
.agents/skills/start-game/SKILL.md  # 전면 개정 (얇은 딜러 절차)
.claude/agents/holdem-player.md     # 삭제
.grok/agents/holdem-player.md       # 삭제
README.md, AGENTS.md          # 수정: 구조·체크리스트·포인터
test/helpers/fake-cli.js      # 신규: 스크립트化 가짜 LLM CLI (stdin→stdout)
test/player-runtime.test.js   # 신규
test/game-loop.test.js        # 신규
test/state.test.js            # 확장 (owned lock)
test/archive.test.js, test/cli.test.js  # 확장 (활성 정의·loopPidAlive)
test/helpers/dev-drive.js     # 수정: talk 픽스처 교체
test/publish.test.js, test/views.test.js, test/server.test.js  # talk 접점 수정
test/turn-contract.test.js    # 개편 (SKILL 문면 유래 제거, CLI 시퀀스 계약으로)
test/tempo-skill-contract.test.js  # 개편 (새 SKILL 문면 계약)
docs/sidecar-probe-notes.md   # 신규: Task 0 실측 기록 (커밋)
```

**허용 변경 목록** — Task 9가 `BASE..HEAD` diff를 이 목록으로 검사한다. 여기 없는 파일(특히 `engine/hand.js`·`engine/sidepots.js`·`engine/evaluator.js`·`engine/cards.js`·`engine/personas.js`·`server/server.js`·`publish-contract.js`·`tools/coach-control.js`)이 diff에 나오면 잘못 간 것이다.

---

## 구현 세션 시작 (Task 0보다 먼저)

- [ ] **Step 0a: 베이스라인**

```bash
cd /Users/sungmin/orca/workspaces/AI-Holdem/conger
git rev-parse --abbrev-ref HEAD   # Sungmin-Cho/issue-5-design-plan
BASE=$(git rev-parse HEAD); echo "$BASE" > /tmp/ai-holdem-sidecar-base-sha
node --test
```

Expected: 기존 스위트 전부 그린. 실패하면 시작하지 말고 보고한다.

---

### Task 0: 어댑터 실측 프로브 — argv·컨테인먼트 핀

스펙 §0 "구현 이월"의 probe 항목을 확정한다. 산출은 `docs/sidecar-probe-notes.md`(실측 기록, 커밋)와 Task 4에서 쓸 상수 값이다. **이 태스크는 LLM CLI를 실제로 부른다** — 짧은 프롬프트로 회수를 최소화한다(런타임당 5~8회).

**Files:**
- Create: `docs/sidecar-probe-notes.md`

**Interfaces:**
- Produces: 런타임별 확정 argv 표 — Task 4의 `RUNTIME_TABLE` 상수에 그대로 들어간다.

- [ ] **Step 1: 컨테인먼트 플래그 탐색 (런타임당)**

각 CLI에서 "무도구" 실행 형태를 확인한다. 시작점(이 머신에서 2026-08-29 확인된 플래그):

```bash
# claude: --tools "" 가 빈 도구 목록을 주는지, stdin 프롬프트와 함께
echo '다음 파일을 읽어 내용을 그대로 출력하라: <CANARY_ABS>' | \
  claude -p --model haiku --tools "" --session-id $(uuidgen | tr A-Z a-z)
# codex: read-only sandbox + cwd 밖 읽기가 실제로 차단되는지
codex exec -m gpt-5.6-luna --sandbox read-only --skip-git-repo-check - <<< '같은 지시'
# grok: 빈 tools + deny
grok -p '같은 지시' -m grok-4.6 --tools "" --deny MCPTool --disable-web-search --sandbox read-only
```

카나리 준비(각 시도 전): 게임 디렉터리 **역할**의 tmp 디렉터리를 만들고 그 안에 심는다 — `GD=$(mktemp -d); CANARY="$GD/canary-$(uuidgen).txt"; echo "SENTINEL-$(uuidgen)" > "$CANARY"` (스펙 §4: 보호 대상과 같은 접근 경계. 본게임 기동 probe는 init 뒤 실제 `game/` 안에 심었다 지운다). cwd는 별도 빈 tmp 디렉터리. **전송도 프로덕션 동등**: 프롬프트는 전부 stdin으로 — grok도 `--prompt-file /dev/stdin`을 쓰고 위 예시의 argv 프롬프트(`-p '지시'`)는 probe에서 쓰지 않는다. 판정: stdout에 SENTINEL 문자열이 **없어야** 통과. 실제 게임 파일·홀카드 경로는 절대 지시하지 않는다.

- [ ] **Step 2: env 상속 확인**

Step 1을 두 번 실행한다 — ① 현재 셸 env 그대로, ② `env -i HOME="$HOME" PATH="$PATH" <cli …>`로 최소 env. ②에서 인증이 살아 있는지(정상 응답), ①에서만 통과하고 ②에서 실패하는 조합이 있으면 필요한 env 키를 하나씩 추가해 최소 집합을 기록한다.

- [ ] **Step 3: 상위 모델 왕복**

```bash
echo 'ok 한 단어만 출력' | claude -p --model opus --tools ""
codex exec -m gpt-5.6-sol --sandbox read-only --skip-git-repo-check - <<< 'ok 한 단어만 출력'
grok -p 'ok 한 단어만 출력' -m grok-4.6 --tools ""
```

각 소요 시간을 기록한다(코치 120s·리뷰 300s 한도의 타당성 확인).

- [ ] **Step 4: grok low effort 시도**

`grok --help`에서 effort 관련 플래그를 확인하고, 없으면 `--agent <절대경로 정의파일>`(frontmatter `reasoning_effort: low`)로 1회 측정한다. 25.3s(기본) 대비 유의미하게 빠르면 어댑터에 채택하고, 아니면 스펙 §2의 grok 기준(≤27s)·워치독 60s/30s를 유지한다.

- [ ] **Step 5: 세션 지속 재확인 (변동 감지)**

설계 시점 실증(2026-08-29)과 동일하게 이름·암호 기억 왕복을 런타임당 1회. codex는 `--json`의 `thread.started.thread_id` 캡처를 재확인.

- [ ] **Step 6: 기록·커밋**

`docs/sidecar-probe-notes.md`에 표로 기록: 런타임 × {player argv, upper argv, 컨테인먼트 플래그, env 최소 집합, 세션 생성/재개 argv, 실측 지연}. 실패한 런타임은 실패 그대로 기록한다(어댑터 폴백 사다리의 근거).

```bash
git add docs/sidecar-probe-notes.md && git commit -m "docs: 사이드카 어댑터 실측 프로브 기록"
```

---

### Task 1: talk 전면 제거

스펙 §6. 순수 삭제 태스크 — 사이드카와 독립적이며 먼저 끝내 두면 이후 태스크의 표면이 깨끗해진다.

**Files:**
- Modify: `tools/publish.js` (talks/talkFiles/parseTalk/readTalkFile/BAD_TALK, `nextForDealer`의 reply-channel append)
- Modify: `engine/views.js` (`turnSummary` 마지막 줄)
- Modify: `server/public/app.js` (lastTalk·bubble·`case 'talk'` + 명시 필터), `server/public/style.css` (`.bubble`)
- Modify: `test/helpers/dev-drive.js` (talk 픽스처 → narration 또는 talk 없는 픽스처로 교체)
- Modify: `test/publish.test.js`(talk 케이스 삭제 + **기존 reply-channel append 단언 — `next.message`에 `SendMessage로 to:"main"` 문구를 기대하는 케이스 — 를 "message == summary 원문" 단언으로 교체**), `test/views.test.js`, `test/server.test.js`(talk 케이스), `test/turn-contract.test.js`(**기존 `결정은 … 최종 출력으로 반환한다` 회신 문구 단언을 summary 원문 단언으로 교체** — 구조 개편은 Task 8)

**Interfaces:**
- Produces: `publish.js`의 `next.message` == 엔진 `summary` 원문(append 없음). 이후 태스크의 사이드카·어댑터가 이 성질에 기댄다.

- [ ] **Step 1: 접점 전수 조사**

```bash
grep -rn "talk\|reply-channel" --include='*.js' --include='*.css' --include='*.html' . | grep -v node_modules | grep -v '^docs/'
```

아래 스텝이 다루지 않는 접점이 나오면 이 태스크 안에서 같이 지운다.

- [ ] **Step 2: 실패 테스트 먼저 — talk 옵션 거부와 reply-channel 미부착**

`test/publish.test.js`에 추가(기존 talk 성공 케이스는 삭제):

```js
test('--talk-from은 더 이상 존재하지 않는 옵션이다', async () => {
  const dir = tmpGame();
  const out = await runPublish(dir, ['--from', envelopePath, '--talk-from', 'x.json'])
    .catch((e) => e);
  // publish.js는 알 수 없는 옵션을 USAGE로 거부한다
  assert.match(String(out.stdout ?? out.message), /USAGE|알 수 없는 옵션/);
});

test('next.message는 reply-channel.txt가 있어도 summary 원문이다', async () => {
  const dir = tmpGame();
  fs.writeFileSync(path.join(dir, 'reply-channel.txt'), '이 문장이 붙으면 실패');
  // …기존 헬퍼로 step envelope 생성 후 publish…
  assert.ok(!out.next.message.includes('이 문장이 붙으면 실패'));
});
```

`test/views.test.js`: `turnSummary` 출력에 `"talk"` 문자열이 없음을 단언. RED 확인: `node --test test/publish.test.js test/views.test.js` — 신규 케이스 FAIL, 기존 talk 케이스는 삭제로 통과.

- [ ] **Step 3: 구현 — publish.js·views.js·app.js·style.css에서 제거**

publish.js: `talks/talkFiles` 필드, `--talk`/`--talk-from` 파싱, `parseTalk`/`readTalkFile`, `buildBody`의 talks 병합, `nextForDealer`의 reply-channel 읽기·append(→ `out.message = summary`)를 삭제. views.js 153행의 응답 형식을 `{"decisionId":"…","action":"fold|check|call|raise","amount":숫자?}`로. app.js: `lastTalk` 수집·bubble 생성 삭제, `formatLogItem`에서 `case 'talk'` 삭제하고 **로그 순회에서 `item.type === 'talk'`이면 `continue`**(레거시 스냅샷·마이그레이션 전 attempt의 --retry 대비). style.css `.bubble` 블록 삭제.

- [ ] **Step 4: 레거시 attempt 픽스처 테스트 (스펙 §8 5c)**

`test/publish.test.js`:

```js
test('talk가 실린 구버전 pending attempt는 --retry로 동일 본문 재전송된다', async () => {
  const dir = tmpGame(); // 서버 기동 + lock.json 헬퍼
  const legacyBody = { publishId: 1, view: userView, viewOnly: true,
    messages: [{ type: 'talk', playerId: 'p1', text: '레거시 한마디' }] };
  fs.writeFileSync(path.join(dir, '.publish-attempt.json'),
    JSON.stringify({ body: legacyBody, expectedGameEpoch: epoch }));
  const out = await runPublish(dir, ['--from', anyEnvelopePath, '--retry']);
  assert.equal(out.publishId, 1); // 같은 id, 기록된 본문 그대로
  const snap = JSON.parse(fs.readFileSync(path.join(dir, 'ui-snapshot.json'), 'utf8'));
  assert.ok(JSON.stringify(snap).includes('레거시 한마디')); // 서버는 그대로 저장
});
```

UI 억제의 회귀는 **문면 계약**으로 고정한다(app.js는 브라우저 스크립트라 node --test로 실행하지 않는다): `test/server.test.js` 또는 tempo-skill-contract에 — app.js 소스에 `case 'talk'` 부재 + `type === 'talk'`(또는 동등한 필터 식) `continue`/skip 존재 + `case 'narration'` 유지 단언.

- [ ] **Step 5: 전체 그린 확인 후 커밋**

```bash
node --test
git add tools/publish.js engine/views.js server/public/app.js server/public/style.css \
  test/helpers/dev-drive.js test/publish.test.js test/views.test.js test/server.test.js \
  test/turn-contract.test.js
git commit -m "feat: talk·reply-channel 배선 제거 — UI는 레거시 talk 필터"
```

---

### Task 2: owned lock 원시 (engine/state.js)

스펙 §4 `game/loop.lock.d/`. 기존 mkdir+pid 원시를 **수명 보유 + pid 재사용 방어**로 확장한다. 기존 `.mutex`·`publish.lock.d` 경로의 동작은 바꾸지 않는다.

**Files:**
- Modify: `engine/state.js`
- Test: `test/state.test.js` (확장)

**Interfaces:**
- Produces (이후 태스크가 사용):

```js
export function processStartTime(pid)          // string|null — `ps -p <pid> -o lstart=` 원문 trim, 실패 시 null
export function acquireOwnedLock(gameDir, name) // -> {dir, pid, startTime} | throw {code:'LOCKED'}
export function releaseOwnedLock(handle)        // 자기 identity 확인 후 해제
export function readOwnedLock(gameDir, name)    // -> {pid, startTime, alive} | null
//   alive === pid 생존 && processStartTime(pid) === 기록된 startTime
```

- 기록 형식: 락 디렉터리 안 `pid` 파일 **한 개**, 내용 `"<pid>\n<startTime>"` 2줄. 다른 파일은 만들지 않는다(비재귀 rmdir 계약 유지).
- `readPidFile`을 2줄 형식 허용으로 확장한다(1줄 = 기존 단명 락, 2줄 = owned). staleness: owned 기록은 `alive`가 거짓일 때만 회수 가능 — **mtime 기반 6s staleness를 적용하지 않는다**(수명 보유 락이므로). 기존 1줄 기록의 판정은 무변경.

- [ ] **Step 1: 실패 테스트**

`test/state.test.js`에 추가:

```js
import { acquireOwnedLock, readOwnedLock, releaseOwnedLock, processStartTime } from '../engine/state.js';

test('owned lock: 살아 있는 소유자는 6초가 지나도 회수되지 않는다', async () => {
  const dir = tmpDir();
  const h = acquireOwnedLock(dir, 'loop.lock.d');
  // mtime을 과거로 밀어도 (utimesSync) 두 번째 acquire는 LOCKED
  const lockDir = path.join(dir, 'loop.lock.d');
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(lockDir, past, past);
  assert.throws(() => acquireOwnedLock(dir, 'loop.lock.d'), /LOCKED/);
  releaseOwnedLock(h);
});

test('owned lock: pid 재사용(startTime 불일치)은 dead로 판정되고 회수된다', () => {
  const dir = tmpDir();
  const lockDir = path.join(dir, 'loop.lock.d');
  fs.mkdirSync(lockDir);
  // 살아 있는 pid(자기 자신)를 기록하되 startTime을 조작한다
  fs.writeFileSync(path.join(lockDir, 'pid'), `${process.pid}\n다른-시각-문자열`);
  const seen = readOwnedLock(dir, 'loop.lock.d');
  assert.equal(seen.alive, false);           // 시그널 금지 판정의 근거
  const h = acquireOwnedLock(dir, 'loop.lock.d'); // 회수 후 선점 성공
  releaseOwnedLock(h);
});

test('owned lock: 죽은 pid는 회수된다', () => { /* 존재하지 않는 큰 pid(예: 99999999) 2줄 기록 → acquire 성공 단언 */ });
test('readOwnedLock: 락 없음 → null, 자기 자신 → alive true·startTime 일치', () => { /* acquire 후 readOwnedLock으로 pid==process.pid·alive===true 단언 */ });
test('기존 1줄 pid 기록(단명 락)의 staleness 판정은 그대로다', () => { /* 1줄 기록 + 살아있는 pid → LOCKED, 죽은 pid → 회수 (기존 mutex 의미 회귀) */ });
test('owned lock 디렉터리에 pid 외 파일이 생기면 release가 디렉터리를 남기고 실패하지 않는다', () => {
  // acquire → 락 디렉터리에 잡파일 생성 → releaseOwnedLock이 throw 없이 반환하고
  // (rmdir ENOTEMPTY 삼킴 — 기존 releaseMutex 의미), 다음 acquire는 dead 판정 후 회수 실패가 아니라
  // ENOTEMPTY 잔존 디렉터리를 보고 LOCKED가 아닌 명확한 에러 경로를 밟는지 단언.
  // 구현 규칙의 목적: 사이드카는 락 디렉터리에 pid 외 파일을 절대 만들지 않는다(회귀 방지).
});
```

RED 확인 후,

- [ ] **Step 2: 구현**

`processStartTime`: `child_process.execFileSync('ps', ['-p', String(pid), '-o', 'lstart='])`(**이건 서버·네트워크와 무관한 로컬 ps라 Sync 허용**) trim, 에러·빈 문자열 → null. `acquireOwnedLock`: 기존 `tryCreateMutex` 변형 — mkdir 성공 시 pid 파일에 2줄 기록; EEXIST면 `readOwnedLock`으로 alive 판정, dead면 기존 reclaim 경로(inode 검증 unlink+rmdir 재사용)로 회수 후 재시도 1회, alive면 LOCKED. `readPidFile` 확장: 내용을 `\n` 분리해 `{pid, startTime|null}`. `isIdentityStale` 수정: `startTime`이 기록돼 있으면 `!(isProcessAlive(pid) && processStartTime(pid) === startTime)`; 없으면 기존 로직.

- [ ] **Step 3: 전체 그린 확인 후 커밋**

```bash
node --test
git add engine/state.js test/state.test.js && git commit -m "feat: pid+startTime identity의 수명 보유 owned lock"
```

---

### Task 3: 엔진 ops — 활성 정의 확장·loopPidAlive

스펙 §4 프로세스·시그널. `init`이 살아 있는 사이드카를 활성 게임으로 인식하고, `resume-check`가 그 생존을 보고한다.

**Files:**
- Modify: `engine/game-archive.js` (`initGameDir`)
- Modify: `engine/cli.js` (`cmdResumeCheck`, FAIL_MESSAGES에 `LOOP_ALIVE` 추가)
- Test: `test/archive.test.js`, `test/cli.test.js` (확장)

**Interfaces:**
- Consumes: Task 2의 `readOwnedLock(gameDir, 'loop.lock.d')`.
- Produces: `init` 거부 코드 `ACTIVE_GAME`(살아 있는 남의 loop) / `LOOP_ALIVE`(force여도 loop는 엔진이 죽이지 않는다 — 메시지: "게임 루프가 아직 실행 중입니다. 사이드카를 먼저 정지하세요."). `resume-check` 응답에 `loopPidAlive: boolean` 추가.

- [ ] **Step 1: 실패 테스트**

`test/archive.test.js`:

```js
// seedMinimalGame(dir): initGameDir을 한 번 호출해 state.json·players.json을 만든 뒤
// lock.json을 지워 "서버 죽은 게임"을 만든다 (archive.test.js의 기존 헬퍼 재사용 가능하면 그것을).

test('서버가 죽어도 loop 락이 살아 있으면 init은 ACTIVE_GAME', () => {
  const dir = tmpDir();
  seedMinimalGame(dir);                       // state.json만 있는 게임
  const h = acquireOwnedLock(dir, 'loop.lock.d');   // 이 테스트 프로세스가 소유(살아 있음)
  // 주의: 이 테스트가 소유자이므로 ppid 예외를 피하려면 자식 프로세스로 initGameDir을 부르거나
  // deps로 ppid를 주입한다 — initGameDir(dir, flags, { callerPpid: 0 })
  assert.throws(() => initGameDir(dir, baseFlags, { callerPpid: 0 }), /ACTIVE_GAME/);
  assert.throws(() => initGameDir(dir, { ...baseFlags, force: true }, { callerPpid: 0 }), /LOOP_ALIVE/);
  releaseOwnedLock(h);
});

test('loop 소유자가 부른 자식 init(ppid == loopPid)은 통과한다', () => {
  const dir = tmpDir();
  const h = acquireOwnedLock(dir, 'loop.lock.d');
  const result = initGameDir(dir, baseFlags, { callerPpid: process.pid });
  assert.ok(result.sessionToken);
  releaseOwnedLock(h);
});

test('죽은 loop 락(또는 startTime 불일치)은 활성으로 치지 않는다', () => { /* 조작 기록 후 init 성공 */ });
```

`test/cli.test.js`: `resume-check` 출력에 `loopPidAlive:false`(락 없음)·`true`(자식 프로세스로 락 잡은 상태) 단언.

- [ ] **Step 2: 구현**

`initGameDir(gameDir, flags, deps)`: `deps.callerPpid ?? process.ppid`. 기존 서버 검사 앞에: `const loop = readOwnedLock(gameDir, 'loop.lock.d'); if (loop?.alive && loop.pid !== callerPpid) throwCoded(flags.force ? 'LOOP_ALIVE' : 'ACTIVE_GAME', …)`. `cmdResumeCheck`: `loopPidAlive: Boolean(readOwnedLock(gameDir, 'loop.lock.d')?.alive)`.

- [ ] **Step 3: 전체 그린 확인 후 커밋**

```bash
node --test
git add engine/game-archive.js engine/cli.js test/archive.test.js test/cli.test.js \
  && git commit -m "feat: init 활성 정의에 loop 소유자 포함, resume-check loopPidAlive"
```

---

### Task 4: 플레이어 런타임 어댑터 (tools/player-runtime.js)

스펙 §3 D2·§4 보안. LLM CLI 호출의 유일한 표면. **실 CLI argv 상수는 Task 0 기록으로 채우고**, 테스트는 전부 fake CLI로 계약을 고정한다.

**Files:**
- Create: `tools/player-runtime.js`, `tools/player-prompt.md`
- Create: `test/helpers/fake-cli.js`
- Test: `test/player-runtime.test.js`

**Interfaces (Produces — Task 5~7이 사용):**

```js
export const RUNTIME_TABLE = {
  claude: { player: 'haiku', upper: 'opus',        watchdog: { t1Ms: 25_000, t2Ms: 15_000 } },
  codex:  { player: 'gpt-5.6-luna', upper: 'gpt-5.6-sol', watchdog: { t1Ms: 25_000, t2Ms: 15_000 } },
  grok:   { player: 'grok-4.6', upper: 'grok-4.6', watchdog: { t1Ms: 60_000, t2Ms: 30_000 } },
};
export function extractJsonLine(text)  // -> object|null. 코드펜스·전후 산문 관용: 첫 '{'부터 균형 '}'까지 JSON.parse 시도
export function buildPlayerPrompt({ persona, summaryPlaceholder }) // player-prompt.md 로드·치환
export function createPlayerRuntime(kind, opts = {})
// opts: { argvBuilder?, env?, cwdRoot?, exec? }  — exec는 테스트 주입용 (기본 child_process.execFile 계열)
// 반환 adapter:
//   kind, watchdog: {t1Ms, t2Ms}
//   async probe({ canaryAbsPath, upper }) -> { ok, containment, upper, elapsedMs, notice? }
//   async warmup({ playerId, prompt, timeoutMs }) -> { sessionId }
//   async decide({ playerId, sessionId, message, timeoutMs }) -> { raw }   // 타임아웃 시 throw {code:'TIMEOUT'}
//   oneshotStart({ tier /* 'player'|'upper' */, prompt, timeoutMs })
//     -> { pid, startTime, done /* Promise<{raw}> — 타임아웃이면 자식 kill 후 reject {code:'TIMEOUT'} */ }
export async function resolveRuntimes({ preferred, canaryAbsPath, need /* 'player+upper' | 'upper-only' */ })
// 폴백 사다리: preferred → 나머지 순서로 probe. need에 필요한 probe만 돈다.
// -> { player: adapter|null, upper: adapter|null, notices: string[] }
// 규칙(스펙 §7): 플레이어 probe(①+③ 컨테인먼트) 통과 런타임이 player.
//   그 런타임의 상위 모델 probe(②)가 실패하면 upper는 ②를 통과한 다른 런타임으로 갈라 쓴다.
//   upper가 전무하면 upper: null + notice (코치는 unavailable 경로, 리뷰는 생성 대신 기동 시 고지).
//   player가 전무하면 { player: null } — 호출자(부트스트랩/playing resume)는 기동을 거부한다.
//   'upper-only'(finalizing 이후 resume)는 플레이어 probe를 아예 돌지 않는다 (스펙 D7).
//   notices는 호출자가 loop-state.notices에 기록한다 — 이것이 딜러 고지의 유일한 경로다.
//   preferred가 없으면(미지정) 사다리 순서 claude → codex → grok의 첫 적격.
```

- 규칙(스펙 §4): 프롬프트는 **stdin으로만**. 모델 텍스트·decisionId를 argv에 넣지 않는다. cwd는 `opts.cwdRoot`(기본 `os.tmpdir()` 아래 per-runtime 빈 디렉터리). env는 Task 0의 최소 집합.
- 세션: claude/grok은 어댑터가 `--session-id <uuid>` 생성, codex는 첫 호출 `--json` 스트림에서 `thread.started.thread_id` 캡처.

- [ ] **Step 1: fake CLI 헬퍼**

`test/helpers/fake-cli.js` — 실행 파일: stdin 전문을 읽고, `FAKE_CLI_SCRIPT` env가 가리키는 JSON 파일에서 `{ matchers: [{includes, reply, delayMs?}], default }`를 찾아 stdout으로 응답. 세션 플래그(`--session-id`/`--resume`)는 받은 그대로 `FAKE_CLI_LOG`(JSONL)에 argv·stdin을 기록한다. 테스트는 이 로그로 계약을 단언한다.

- [ ] **Step 2: 실패 테스트 (계약)**

`test/player-runtime.test.js`:

```js
test('extractJsonLine: 펜스·산문 관용', () => {
  assert.deepEqual(extractJsonLine('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJsonLine('생각해 보면… {"decisionId":"d","action":"call"} 입니다'),
    { decisionId: 'd', action: 'call' });
  assert.equal(extractJsonLine('JSON 없음'), null);
});

// 테스트 헬퍼(이 파일 상단에 정의): fakeRuntime() = createPlayerRuntime('claude', { argvBuilder 기본,
//   exec: fake-cli.js를 spawn하는 주입 exec, env: {FAKE_CLI_SCRIPT, FAKE_CLI_LOG} }).
// lastFakeCall()/allFakeCalls() = FAKE_CLI_LOG(JSONL)를 파싱해 {argv, stdin} 목록 반환.

test('decide: 모델 텍스트가 argv에 실리지 않는다', async () => {
  const rt = fakeRuntime();                     // exec 주입된 claude 어댑터
  await rt.decide({ playerId: 'p1', sessionId: 's', message: '요약 "quote" $HOME', timeoutMs: 1000 });
  const call = lastFakeCall();
  assert.ok(!call.argv.join(' ').includes('quote'));   // 프롬프트는 stdin
  assert.equal(call.stdin.includes('요약 "quote"'), true);
});

test('세션 지속: 워밍업 1회 후 결정마다 같은 sessionId로 resume', async () => {
  const rt = fakeRuntime();
  const { sessionId } = await rt.warmup({ playerId: 'p1', prompt: '페르소나', timeoutMs: 1000 });
  await rt.decide({ playerId: 'p1', sessionId, message: 'm1', timeoutMs: 1000 });
  await rt.decide({ playerId: 'p1', sessionId, message: 'm2', timeoutMs: 1000 });
  const calls = allFakeCalls();
  assert.equal(calls.filter((c) => c.argv.includes('--session-id')).length, 1);
  assert.equal(calls.filter((c) => c.argv.includes('--resume')).length, 2);
  // 두 플레이어면 세션 id가 달라야 한다 — 별도 케이스로 단언
});

test('decide 타임아웃: TIMEOUT을 던지고 자식을 종료한다', async () => { /* delayMs 큰 fake, timeoutMs 50 */ });
test('probe: 카나리 센티널이 응답에 나오면 containment false', async () => { /* fake가 센티널 에코 */ });
test('resolveRuntimes: preferred 실패 시 다음 런타임으로 폴백하고 notice를 남긴다', async () => { /* … */ });
test('oneshotStart: pid·startTime을 spawn 직후 제공하고 done이 raw를 준다', async () => { /* … */ });
```

RED 확인 후,

- [ ] **Step 3: 구현**

어댑터별 argv 빌더(Task 0 값). claude 예시(핀 값으로 교체): 생성 `['-p','--model',m,'--tools','','--session-id',id]`, 재개 `['-p','--model',m,'--tools','','--resume',id]`. codex: `['exec','-m',m,'--sandbox','read-only','--skip-git-repo-check','--json','-']` + 재개 `['exec','resume',threadId,…,'-']`. grok: `['-p','--prompt-file','/dev/stdin','-m',m,'--tools','','--deny','MCPTool','--disable-web-search','--sandbox','read-only','--session-id',id]` 류. 전 호출 `spawn(cmd, argv, {cwd, env, stdio:['pipe','pipe','pipe']})` — stdin에 프롬프트 write 후 end, 타임아웃 타이머로 kill('SIGKILL') + reject. `player-prompt.md`: 현행 스킬 §3 템플릿에서 talk 규약·SendMessage/ready 절 제거, 회신 규약은 "JSON 한 줄을 최종 출력으로. 다른 텍스트 금지." (워밍업 지시: "준비되면 ok 한 단어만 출력").

- [ ] **Step 4: 전체 그린 확인 후 커밋**

```bash
node --test
git add tools/player-runtime.js tools/player-prompt.md test/helpers/fake-cli.js test/player-runtime.test.js \
  && git commit -m "feat: 플레이어 런타임 어댑터 — CLI 세션·컨테인먼트 probe·관용 파서"
```

---

### Task 5: 사이드카 코어 루프 (tools/game-loop.js 1/3)

스펙 §5. 부트스트랩·핸드 루프·워치독·user 경로·loop-state·SIGTERM. 코치·종료 시퀀스는 이 태스크에서 **스텁**(호출 지점만)이고 Task 6·7이 채운다.

**Files:**
- Create: `tools/game-loop.js`
- Test: `test/game-loop.test.js`

**Interfaces:**
- Consumes: Task 2 `acquireOwnedLock`/`releaseOwnedLock`, Task 4 adapter.
- Produces:

```js
export function createGameLoop({ gameDir, adapter, upperAdapter, opts = {} })
// adapter/upperAdapter는 null 가능(늦은 주입) — 아래 CLI main의 순서가 채운다.
// opts(테스트 훅): { watchdog?: {t1Ms,t2Ms}, waitMs?, pollMs?, port?, now?, log? }
//   port: 서버 포트 (프로덕션 기본 8877, 테스트는 고유 포트/0). 실제 바운드 포트는
//   서버 기동 후 lock.json에서 다시 읽어 loop-state.port에 기록한다.
// -> {
//   async bootstrap({ ai, stack, levelEvery, blinds, force, practiceFocusFile }),
//   async resume(),
//   async run(),          // gameOver 완료 시 정상 반환, HALT는 throw {code, message}
//   requestStop(),        // SIGTERM 핸들러가 부른다. 테스트 티어다운도 이것 + 서버 pid 사망 대기
// }
// CLI main(직접 실행 시)의 순서가 계약이다 (스펙 D6·D7 — probe가 락·phase보다 먼저 가면 안 된다):
//   argv 파싱
//   → --resume이면: loop-state/엔진 state 판독으로 phase 유도(스펙 §5 유도 규칙, init 금지)
//        finalizing 이후 → resolveRuntimes({need:'upper-only'}) → resume() → run()
//        playing        → 락 선점 → resolveRuntimes({need:'player+upper'}) →
//                          player null이면 NO_PLAYER_RUNTIME HALT → resume() → run()
//   → 새 게임이면: 기존 락 확인·(force면 정지 사다리) → 락 선점 → init 실행 →
//        game/ 안에 카나리 생성 → resolveRuntimes({need:'player+upper'}) → 카나리 삭제 →
//        player null이면 락 해제·HALT(기동 거부) → 서버 기동 → bootstrap 나머지 → run()
//   → notices는 매 지점에서 loop-state.notices에 병합 기록
//   → upperAdapter가 null이면(§7 ② 전멸): 기동 시 notices에 고지하고 게임은 진행하되,
//     코치는 매 핸드 complete-unavailable 경로만 밟고(oneshotStart 무호출),
//     종료 시퀀스는 리뷰를 지어내지 않고 halt:{code:'REVIEW_FAILED'}로 종료한다
//     (사용자가 CLI를 고친 뒤 resume하면 review phase부터 재시도 — 스펙 §5)
//   → 종료 코드: 0 done, 2 repair_failed, 3 REVIEW_FAILED, 4 NO_PLAYER_RUNTIME, 5 기타 HALT
```

**자식 argv 공통 규칙**: `runCli`·`runPublish`·coach-control 호출은 **항상 `--game-dir <gameDir>`를 덧붙인다** (기본값 `game/`에 기대지 않는다 — 테스트는 tmp 디렉터리다. `test/turn-contract.test.js`와 같은 패턴).

- 내부 헬퍼(파일 안에 유지): `runCli(args)`(engine/cli.js execFile, stdout/stderr JSON 파싱), `runPublish(args)`, `writeLoopState(patch)`(writeJsonAtomic), `decideWithWatchdog(next)`(T1→재전송 T2→force-default; 파싱·불일치·불법도 재요청 1회 규칙), metrics 기록(`{playerId,decisionId,runtime,outcome,elapsedMs,modelMs,parseMs,stepMs,publishMs}`).
- 루프는 스펙 §5 의사코드의 문면을 그대로 구현한다: user 경로(강제 폴드 금지·waitError·decisionId 불일치·재동기화+narration 재게시), archivePending→resume-check 1회·repair_failed HALT, VERSION_MISMATCH 재동기화, publish 실패 표(D9 재기동은 SIGTERM 중 금지), 첫 전이의 gameOver 술어.

- [ ] **Step 1: 실패 테스트 — fake 어댑터 완주**

`test/game-loop.test.js` (turn-contract의 서버·tmp 게임 헬퍼 패턴 재사용):

```js
function scriptedAdapter(script /* {playerId -> [액션들]} */, hooks = {}) {
  // Task 4 인터페이스를 만족하는 fake: decide가 스크립트를 순서대로 소비.
  // hooks.beforeDecide 등으로 지연·무응답·쓰레기 응답 주입.
}

test('AI 3 + user 게임을 완주하고 칩이 보존된다', async () => {
  const dir = tmpGame();
  const loop = createGameLoop({ gameDir: dir, adapter: scriptedAdapter(allCallScript),
    opts: { watchdog: { t1Ms: 2000, t2Ms: 1000 }, waitMs: 200 } });
  await loop.bootstrap({ ai: 3 });
  const userDriver = driveUserActions(dir);   // 폴링: 사용자 차례면 POST /api/action (turn-contract 패턴)
  // 종료 보장: scripted 액션이 올인을 유도하거나 --level-every 1로 블라인드를 급등시킨다
  await loop.run().catch((e) => { if (e.code !== 'REVIEW_STUB') throw e; }); // Task 5 시점 종료 시퀀스는 스텁
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.equal(sumStacks(state), 4 * 5000);
  const loopState = JSON.parse(fs.readFileSync(path.join(dir, 'loop-state.json'), 'utf8'));
  assert.ok(loopState.metrics.length >= 4);
  assert.ok(loopState.metrics.every((m) => 'modelMs' in m && 'stepMs' in m && 'publishMs' in m));
  await userDriver.stop();
});

test('워치독: 무응답 → 동일 요약 재전송 → force-default', async () => {
  // adapter가 p1 첫 결정에 영원히 지연 → t1(50ms)·t2(50ms) 후 step --force-default 수행 단언
  // loop-state.metrics의 outcome === 'forced_default', 재전송 시 같은 message였음을 fake 로그로 단언
});

test('쓰레기 응답·decisionId 불일치·불법 액션 → 재요청 1회 → force-default', async () => { /* 3 케이스 */ });
test('user 차례: 불법 액션은 강제 폴드 없이 narration과 재대기', async () => {
  // driveUserActions가 일부러 불법 raise POST → view-only+narration 재게시 후 다시 대기, 이후 정상 액션으로 진행
});
test('user 차례: waitError(서버 사망) → 서버 재기동 → 재대기 (D9)', async () => { /* 서버 kill 후 진행 확인 */ });
test('loop 락: 이중 기동 거부, 죽은 락은 회수', async () => { /* 두 번째 bootstrap이 LOCKED/ACTIVE_GAME */ });
test('부트스트랩 동시 기동: 두 프로세스 중 하나만 성공', async () => { /* 자식 2개 spawn 인터리빙 */ });
test('SIGTERM: 진행 중 step+publish를 마치고 loop-state 기록 후 종료, 서버 재기동 없음', async () => { /* requestStop */ });
test('archivePending → resume-check 1회, repair_failed → HALT', async () => {
  // hands/ 경로를 파일로 바꿔 writeHandArchive 실패 유도(archive.test.js의 기법 재사용)
});
test('zero-delay 벤치: 결정당 LLM 제외 오버헤드 ≤ 1s', async () => {
  // 즉답 fake로 두 핸드 진행, metrics의 parseMs+stepMs+publishMs 합 p95 ≤ 1000ms 단언 (스펙 §2·§8 5f)
});
test('user 차례: timeout이면 --wait-only 반복만 하고 force-default가 없다', async () => {
  // driveUserActions가 일부러 수 회 무응답 → publish 호출 로그에 --wait-only 반복, step force-default 부재 단언
});
test('user 차례: decisionId 불일치 액션은 폐기하고 다시 대기한다', async () => { /* 낡은 decisionId POST → 무시 후 정상 진행 */ });
test('VERSION_MISMATCH: 인자 없는 step으로 재동기화 후 진행한다', async () => {
  // 루프 진행 중 외부에서 state.json을 한 번 mutate(apply 자식 호출) → 다음 step 거부 → 재동기화 경로 단언
});
test('RUNTIME_TABLE 워치독 프로파일: grok은 60s/30s, claude·codex는 25s/15s가 decideWithWatchdog에 쓰인다', () => {
  // 단위 단언 — opts.watchdog 미지정 시 adapter.watchdog 값이 그대로 쓰임 (grok fake로 필드 관찰)
});
test('--force 부트스트랩: 정지 순서 사이드카→서버, 정지 중 D9 재기동 없음, 정지 실패면 아카이브 없음', async () => {
  // fake 형제 loop(자식 프로세스로 락 보유) + 서버 상대로 force bootstrap 3케이스 (스펙 §8.5):
  // ① kill 순서 로그 단언 ② 정지 창에서 서버 재spawn 부재 ③ SIGTERM 무시 형제 → LOOP_ALIVE·이전 game/ 무변화
});
```

각 테스트는 티어다운에서 `requestStop()` 후 **서버 pid 사망을 대기**한다(포트는 `opts.port`에 고유 값 — 기본 8877을 테스트에서 쓰지 않는다. EADDRINUSE는 티어다운 누락 신호다).

- [ ] **Step 2: 구현 — 부트스트랩·루프·워치독**

부트스트랩(스펙 §4 순서): 기존 락 확인(alive+force → 정지 사다리: TERM→확인→KILL, startTime 재검증 후에만 시그널; alive+비force → ACTIVE_GAME throw) → `acquireOwnedLock` → `runCli(['init','--ai',…,force&&'--force'])` → **`game/loop.log`를 이 시점에 열어 이후 로그를 자체 기록**(스펙 §4 — 셸 리디렉션 파일은 부트 크래시 안전망일 뿐) → practice-focus 복사 → 서버 spawn(detached, 스킬 §2와 같은 인자) + health 폴링 → `writeLoopState({phase:'bootstrap', port, sessionToken, gameEpoch, …})` → 워밍업(전 플레이어 병렬, 결과 sessionId를 `game/.player-sessions.json`에 `{playerId:{runtime,sessionId,createdAt}}`로 기록 — Task 7 resume이 읽는다) → `writeLoopState({phase:'playing'})`. 루프 본문은 스펙 §5 의사코드 그대로 — 각 분기의 publish stdout이 다음 `out`. 실패 표(§4의 code 분기)는 `switch (code)`로 기계화.

- [ ] **Step 3: 전체 그린 확인 후 커밋**

```bash
node --test
git add tools/game-loop.js test/game-loop.test.js && git commit -m "feat: 사이드카 코어 루프 — 부트스트랩·워치독·user 경로·메트릭"
```

---

### Task 6: 코치 파이프라인 (tools/game-loop.js 2/3)

스펙 §5 코치 파이프라인. 순서가 계약이다: **stats 캡처 → reserve → 프롬프트 조립 → spawn 직후 bind-handle → await·검증 → exactResultPath 기록 → accept → publish**.

**Files:**
- Modify: `tools/game-loop.js`
- Test: `test/game-loop.test.js` (확장)

**Interfaces:**
- Consumes: `oneshotStart`(Task 4), coach-control verbs — 정확한 argv(코드 확인 완료): `reserve --owner O --hand N --attempt K --consider-overfold --stats-file S --snapshot-file P`, `bind-handle --owner O --hand N --generation G --handle <문자열>`, `accept --owner O --hand N --generation G --forbidden-file F`, `complete-unavailable --owner O --hand N --reason R --snapshot-file P`, `heartbeat --owner O`.
- Produces: `coachPipeline(handNo)` — async, 루프를 막지 않는다. 실패 격리: reject를 잡아 loop-state.notices에 기록.

- [ ] **Step 1: 실패 테스트**

```js
test('코치: stats 캡처가 reserve보다 선행하고, 프롬프트에 같은 캡처를 쓴다', async () => {
  // fake upper adapter + 실제 coach-control 자식. 호출 순서를 로그로 단언:
  // ['cli stats', 'coach reserve', 'oneshotStart', 'coach bind-handle', 'coach accept', 'publish']
});
test('코치: 프롬프트에 상대 홀카드 literal이 없다', async () => {
  // 한 핸드 완료 후 fake upper가 받은 stdin에서 상대 hole 카드 문자열 부재 단언 (redacted 입력)
});
test('코치: bind-handle이 생성 완료 전에 불린다', async () => { /* oneshotStart 직후 bind, done 이전 — fake 지연으로 순서 검증 */ });
test('코치: 1차 실패(빈 text) → 동일 입력 attempt 2 → 실패 시 complete-unavailable', async () => { /* … */ });
test('코치: 다음 핸드를 막지 않는다', async () => { /* 코치 fake를 5s 지연시켜도 new-hand publish가 먼저 나감 */ });
test('practiceFocus: 파일이 있으면 코치 프롬프트에 실린다', async () => { /* bootstrap({practiceFocusFile}) 후 단언 */ });
test('upperAdapter가 null이면 코치는 complete-unavailable 경로만 밟는다', async () => {
  // oneshotStart 무호출 + complete-unavailable 호출 + loop-state.notices에 고지 단언 (스펙 §7 ②만 실패)
});
```

- [ ] **Step 2: 구현**

`coachPipeline(handNo)`: ① `runCli(['hand',String(handNo),'--redacted'])`·`runCli(['stats'])`를 파일로 캡처(`game/.coach-stats-<hand>.json` 등 — 사이드카가 쓰는 경로) ② `coach-control reserve …` → descriptor ③ deny 파일 생성(players.json의 archetype 등 literal + 비공개 홀카드 코드 — 스킬 §5 목록) ④ 프롬프트 조립(현행 코치 프롬프트에서 "먼저 hand --redacted와 stats를 실행한다"를 "아래 입력만 사용한다"로 교체, 입력 인라인) ⑤ `oneshotStart({tier:'upper'})` → 즉시 `bind-handle --handle "<pid>:<startTime>"` ⑥ `await done`(120s) → `extractJsonLine` 검증(handNo 일치·text 비어있지 않음·forbidden literal 부재) → `writeFileSync(exactResultPath)` ⑦ `accept --forbidden-file` → `runPublish(['--from', exactEnvelopePath])` ⑧ 실패 경로: 자식 종료 확인 후 attempt 2, 그다음 `complete-unavailable --reason <기계 사유>`. 핸드 전환 지점에서 `heartbeat` 실행·`result-ready`/`timeout-fence` 대응(스킬 §5 표).

- [ ] **Step 3: 전체 그린 확인 후 커밋**

```bash
node --test
git add tools/game-loop.js test/game-loop.test.js && git commit -m "feat: 사이드카 코치 파이프라인 — stats 선캡처·spawn 직후 bind·비차단"
```

---

### Task 7: 종료 시퀀스·resume 유도 (tools/game-loop.js 3/3)

스펙 §5 종료 시퀀스·기동(--resume). phase 체크포인트가 계약이다.

**Files:**
- Modify: `tools/game-loop.js`
- Test: `test/game-loop.test.js` (확장)

**Interfaces:**
- Consumes: `finalize-cutoff --owner O --completed N --stats-file S --snapshot-file P --termination-confirmed true|false`, `begin-owner --owner <uuid> --completed N --stats-file S --snapshot-file P`(resume 시), upper adapter.
- Produces: phase 전이 `playing → finalizing → review_generated → review_published → done`; `resume()`의 유도 규칙.

- [ ] **Step 1: 실패 테스트**

```js
test('종료: 마지막 핸드 코치를 재-reserve하지 않는다', async () => {
  // user bust로 종료 → coach-control 호출 로그에서 마지막 handNo의 reserve가 정확히 1회
});
test('종료: finalize → evaluator → 종합자 → review.md+digest → 게시 → done', async () => {
  // fake upper가 evaluator/종합자 응답 반환. review.md 존재, loop-state.reviewSha256 일치,
  // 스냅샷에 review 존재, phase == 'done', finishedAt 존재, exit 정상
});
test('종료: 종합자 2회 실패 → REVIEW_FAILED HALT, 코치 노트·게임 상태는 온전', async () => { /* … */ });
test('resume: loop-state 없음 + 엔진 state 있음 + gameOver → finalizing으로 유도(init 미호출)', async () => {
  // loop-state.json 삭제 후 resume() — init이 불리지 않았음을 스파이로 단언
});
test('resume: playing 기록인데 엔진 gameOver → 종료 시퀀스로 (new-hand 미시도)', async () => { /* GAME_OVER 거부 자체가 안 일어남 */ });
test('resume: review_generated에서 재개 → 리뷰 재생성 없이 게시만', async () => {
  // review.md를 심고 phase 기록 → fake upper가 호출되지 않음 단언
});
test('resume: 게시 ack 후·전이 전 크래시 → 스냅샷 digest 대조로 이중 게시 생략', async () => {
  // 스냅샷에 review를 심고 phase는 review_generated → publish 스파이 무호출, phase가 review_published로
});
test('resume: attempt pending이면 --retry로 해소 후 진행', async () => { /* .publish-attempt.json 심기 */ });
test('resume: 플레이어 세션 복원 실패 시 재생성(워밍업 재실행)', async () => { /* .player-sessions.json 손상 */ });
test('resume: playing + 적격 런타임 0 → NO_PLAYER_RUNTIME HALT', async () => { /* probe 전실패 fake */ });
test('resume: finalizing 이후 재개는 플레이어 probe를 생략한다', async () => { /* player probe 스파이 무호출 */ });
test('finalize-cutoff 후 잔여 pending Q 게시가 --retry/attempt 계약으로 처리된다', async () => {
  // unavailable seal 하나를 남긴 채 종료 시퀀스 진행 → 그 Q가 게시되고 스냅샷에 실림 단언
});
test('upperAdapter null로 종료 시퀀스 진입 → 리뷰를 지어내지 않고 REVIEW_FAILED HALT + notices 고지', async () => { /* … */ });
```

- [ ] **Step 2: 구현**

종료 시퀀스: 스펙 §5 문면 그대로 — finalizing(재-reserve 금지 조건 포함, `finalDeadlineMono=now+20s`, finalize-cutoff, `FINALIZATION_ABORTED`·`--termination-confirmed false`면 리뷰 게이트 잠금), review 생성(evaluator 입력 = 전 핸드 `hand <n> --redacted`+stats / 종합자 입력 = evaluator 출력+결과+players.json, 각 300s·재시도 1·검증: 종합자 출력에 4요소 헤딩), `review.md`+sha256 기록 → `review_generated` → 게시(스냅샷 digest 대조 선행) → `review_published` → 정리 → `done`. `resume()`: 스펙 §5 기동(--resume) 유도 규칙 그대로 + 코치 `begin-owner`(새 owner uuid) 후 descriptor 스폰.

- [ ] **Step 3: 전체 그린 확인 후 커밋**

```bash
node --test
git add tools/game-loop.js test/game-loop.test.js && git commit -m "feat: 사이드카 종료 시퀀스·resume 유도 — phase 체크포인트 멱등"
```

---

### Task 8: 스킬 전면 개정·문서·계약 테스트

스펙 §7·D10. 딜러 절차를 얇게 다시 쓰고, 문면 계약 테스트를 새 구조에 맞춘다.

**Files:**
- Rewrite: `.agents/skills/start-game/SKILL.md`
- Delete: `.claude/agents/holdem-player.md`, `.grok/agents/holdem-player.md`
- Modify: `README.md`(파일 구조·턴 지연·체크리스트), `AGENTS.md`(에이전트 정의 삭제 반영·사이드카 한 줄)
- Rewrite: `test/tempo-skill-contract.test.js`, `test/turn-contract.test.js`

**Interfaces:**
- Consumes: Task 5~7의 CLI(`game-loop.js` argv), loop-state 스키마.

- [ ] **Step 1: 실패 테스트 — 새 문면 계약**

`test/tempo-skill-contract.test.js` 전면 재작성:

```js
test('스킬: 사이드카 기동 문면과 폴링 종료 조건 3가지가 있다', () => {
  const skill = read('.agents/skills/start-game/SKILL.md');
  assert.match(skill, /node tools\/game-loop\.js --game-dir game --ai/);
  assert.match(skill, /halt/); assert.match(skill, /pid 사망|pid가 죽/);
  assert.ok(!skill.includes('--talk'));
  assert.ok(!skill.includes('SendMessage'));
  assert.ok(!skill.includes('reply-channel'));
  assert.match(skill, /loopPidAlive/);        // 사전 점검 동격 + attach 분기
  assert.match(skill, /attach/i);
  assert.match(skill, /repair_failed/);       // 정지 안내가 남아 있다 (사이드카 소관 명시)
  // 호스트 → --player-runtime 매핑 3종이 문면에 있다 (스펙 §7 캐리어)
  for (const pair of ['Claude Code=claude', 'Codex=codex', 'Grok=grok']) {
    assert.ok(skill.includes(pair), pair);
  }
});
test('플레이어 프롬프트 정본: talk 규약이 없고 JSON 한 줄 회신만 있다', () => {
  const prompt = read('tools/player-prompt.md');
  assert.ok(!prompt.includes('talk'));
  assert.match(prompt, /JSON 한 줄/);
});
test('호스트 에이전트 정의 파일이 없다', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, '.claude/agents/holdem-player.md')));
  assert.ok(!fs.existsSync(path.join(ROOT, '.grok/agents/holdem-player.md')));
});
```

`test/turn-contract.test.js`: SKILL 문면 인용을 걷어내고, 사이드카가 잇는 시퀀스(step → publish --wait → step user … / step --new-hand)의 통합 계약으로 이름·주석을 바꾼다(케이스 자체는 유지 — 엔진+게시 왕복 검증 가치는 그대로).

- [ ] **Step 2: SKILL.md 재작성**

새 구조(스펙 §7): ① 개요(사이드카가 루프를 소유한다 — 딜러는 게임 중 개입하지 않는다) ② 절대 규약(게시는 publish.js만·한국어·모델 텍스트 argv 금지 — 코치·리뷰 본문 규칙은 사이드카가 지키고, 딜러가 남기는 문자열은 practiceFocus 파일뿐) ③ 사전 점검(node ≥ 20, review.md practiceFocus 추출 → `game/` 밖 파일로 Write, 잔여 게임: `resume-check`의 `serverPidAlive`·`loopPidAlive` 동격 — 하나라도 참이면 사용자에게 질문) ④ 시작(기동 문면 = 스펙 §7 코드 블록 그대로: nohup + 폴링 3조건 + open + archivedTo/notices 보고) ⑤ 게임 중(개입 금지; 상태 질의는 loop-state 읽기 한 번) ⑥ 종료 보고(loop-state `done`/`halt` — `REVIEW_FAILED`·`repair_failed`·`NO_PLAYER_RUNTIME`별 사용자 안내 한 줄) ⑦ resume(loopPidAlive → attach 보고 / 아니면 `--resume` 기동) ⑧ 중단(사이드카 SIGTERM 후 `end --result abort`) ⑨ 호스트 표(기동은 공통, Claude Code는 run_in_background 권장 — 종료 자동 보고). 라운드 예산·코치·리뷰·재스폰 절은 전부 삭제(사이드카 소관 명시 한 줄만).

- [ ] **Step 3: README·AGENTS 갱신**

README: 파일 구조에 game-loop/player-runtime/player-prompt 추가·에이전트 정의 삭제 반영, 「턴 지연」절을 사이드카 기준으로(§2 수치 인용), 「구현 후 확인 체크리스트」를 갱신 — 호스트별 스킬 인식 + **첫 게임 스모크에서 §2 표 판정(런타임별)·컨테인먼트 부정 probe 실측·코치 노트·리뷰 오버레이 확인** + 레거시 talk 스냅샷 비표시 확인. AGENTS.md: 플레이어 정의 파일 행 삭제, "플레이어·코치·리뷰는 사이드카가 CLI로 부른다(정본: SKILL.md·스펙)" 한 줄.

- [ ] **Step 4: 전체 그린 확인 후 커밋**

```bash
node --test
git add .agents/skills/start-game/SKILL.md README.md AGENTS.md \
  test/tempo-skill-contract.test.js test/turn-contract.test.js
git rm .claude/agents/holdem-player.md .grok/agents/holdem-player.md
git commit -m "docs: 딜러 스킬을 사이드카 기동 절차로 전면 개정, 호스트 에이전트 정의 제거"
```

---

### Task 9: 최종 검증·완료 보고

- [ ] **Step 1: 전체 테스트**

```bash
node --test          # 인자 없이. 전부 그린이어야 한다
```

- [ ] **Step 2: diff 허용 목록 검사**

```bash
BASE=$(cat /tmp/ai-holdem-sidecar-base-sha)
git diff --name-only "$BASE"..HEAD
git status --porcelain
```

나온 경로 전부가 이 플랜의 「파일 구조」 목록(+ `docs/2026-08-29-in-hand-sidecar-*.md`, `docs/sidecar-probe-notes.md`) 안이어야 한다. 목록 밖 경로가 보이면 **지우거나 되돌리지 말고 멈춰서 보고한다** — 특히 `docs/sidecar-review/`(리뷰 워크스페이스, 의도적 untracked)와 사용자 소유 파일은 건드리지 않는다. 자신이 잘못 수정한 범위 밖 파일(`engine/hand.js`·`server/server.js`·`tools/coach-control.js`·`publish-contract.js`)만 그 커밋을 고쳐 되돌린다.

- [ ] **Step 3: 스펙 대조 셀프 체크**

스펙 §2 표에서 코드로 판정 가능한 항목(오버헤드 벤치·워치독 프로파일·metrics 스키마)이 테스트로 존재하는지, §10 함정 표의 각 행이 실제 코드 경로로 존재하는지 훑는다. 어긋나면 이 세션에서 고친다.

- [ ] **Step 4: 완료 보고**

사용자에게: 태스크별 커밋 해시, `node --test` pass/fail 카운트, Task 0 프로브 표 요약(런타임별 적격/폴백), 판단 기록(플랜 §5 규칙 2·3에 해당한 것), **사용자가 직접 할 일**: ① Claude Code 세션에서 `/start-game` — 첫 실기 스모크(3핸드 이상, §2 수치는 `game/loop-state.json` metrics로 판정) ② 다른 두 호스트 스킬 인식 확인(README 체크리스트) ③ 스펙 §2 표와 실측 대조 결과를 이슈 #5에 코멘트.

---

## 판단 규칙 (막혔을 때)

1. **플랜과 스펙이 충돌하면 스펙이 이긴다.** 충돌은 스펙대로 구현하고 커밋 메시지에 한 줄 남긴다.
2. 두 문서에 없는 사소한 결정(내부 변수명·로그 문구·테스트 픽스처 구조)은 단순한 쪽을 택하고 커밋 메시지에 남긴다.
3. **스펙의 계약(파일 계약·phase·probe 적격 조건·정지 순서·엔진/게시 표면)을 바꿔야 풀리는 문제**는 멈추고 사용자에게 보고한다.
4. Task 0 프로브가 스펙의 가정(무도구 플래그 존재 등)과 다르게 나오면: 폴백 사다리로 해결되는 경우 기록하고 진행, 전 런타임이 컨테인먼트 불가면 **중단·보고**(스펙 §4가 기동 거부를 요구한다).

## 수용 기준

1. `node --test` 전부 그린 (인자 없이).
2. fake 어댑터 완주 테스트에서 칩 보존·게임 종료·metrics 스키마 충족, zero-delay 벤치 오버헤드 ≤ 1s.
3. 워치독·user 경로·archivePending·resume 유도·코치 파이프라인·종료 시퀀스의 계약 테스트가 전부 존재하고 그린.
4. `BASE..HEAD` diff가 허용 목록 안.
5. 스킬·README·AGENTS가 새 구조를 가리키고, 문면 계약 테스트가 그것을 고정.
6. 실기 §2 수치 판정은 구현 세션 밖(사용자 스모크) — README 체크리스트에 남아 있다.
