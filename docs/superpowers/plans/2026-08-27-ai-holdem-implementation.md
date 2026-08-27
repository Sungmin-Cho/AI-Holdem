# AI 홀덤 구현 플랜

상태: 리뷰 수렴 완료 — 2라운드 교차 모델 리뷰(grok-4.6 + gpt-5.6-sol) 후 수렴 판정(P2 신규 표면 3/24, 파장-과반 연속 2라운드). `node --test` 디렉토리 인자 결함은 실측 검증 후 반영.

> **For agentic workers:** 이 플랜의 실행자는 **새로 시작하는 grok-4.6 세션**을 1순위로 상정한다(제로 컨텍스트 전제). 태스크를 번호 순서대로, 태스크마다 RED(실패 테스트) → GREEN(구현) → 검증 → 커밋 사이클로 진행하고 체크박스(`- [ ]`)로 추적하라. superpowers 플러그인이 있는 호스트에서 실행한다면 superpowers:subagent-driven-development 또는 superpowers:executing-plans를 사용해도 된다. 오케스트레이션 플러그인(deep-loop 등)은 사용하지 않는다.

**Goal:** AI 에이전트 상대와 웹 UI로 즐기는 노리밋 텍사스 홀덤 — 딜러(AI 세션) 오케스트레이션, 코칭 포함 — 의 코드 전체(엔진·서버·UI·스킬)를 구현한다.

**Architecture:** 규칙 판정 전부를 담당하는 상태 파일 기반 순수 JS 엔진 CLI + 게임 로직 없는 중계 웹 서버(SSE/long-poll) + vanilla 웹 UI + 딜러 절차를 담은 크로스 호스트 스킬 문서. 진실의 원천은 `game/state.json`, LLM은 규칙·칩 계산을 하지 않는다.

**Tech Stack:** Node.js ≥ 20 (ESM), 외부 npm 의존성 0개, `node --test`, Node 내장 `http`/`crypto`/`fs`.

**Spec:** `docs/superpowers/specs/2026-08-26-ai-holdem-design.md` — 이 플랜은 스펙을 전제로 논증한다. 실행자는 반드시 스펙을 먼저 정독하라. 계약(액션 스키마, envelope, view 필드, 서버 API, 무결성 계약)은 스펙 §3~§5가 정본이고, 플랜과 스펙이 충돌하면 **스펙이 이긴다**(발견 시 커밋 메시지에 기록).

## Global Constraints

- Node ≥ 20 (개발 머신은 v26), `package.json`은 `"type": "module"`, 외부 의존성 0개, 빌드 단계 없음.
- 모든 사용자 노출 문자열(UI·이벤트 로그·코치)은 한국어.
- 엔진 순수성: `engine/**`는 네트워크·타이머·LLM 접근 금지. 파일 I/O는 `state.js`를 통해서만.
- 카드 표기(엔진 내부 표준): 랭크 `2 3 4 5 6 7 8 9 T J Q K A` + 슈트 소문자 `s h d c` — 예: `"As"`, `"Td"`, `"7c"`. UI에서만 ♠♥♦♣로 렌더링.
- decisionId 형식: `d-<handNo>-<street>-<actionIndex>` (street ∈ `preflop|flop|turn|river`). 같은 결정 지점에 대해 안정적이다.
- 금액은 전부 정수 칩. `raise`의 amount는 항상 raise-to(그 스트리트의 내 총 베팅액).
- 테스트 실행: `node --test` (전체 — 인자 없이 실행하면 기본 글롭이 `test/**`를 자동 발견한다. **디렉토리 인자를 주면 Node v26에서 실패하므로 금지**), `node --test test/<파일>.test.js` (단건). 커밋 전 전체 그린 필수.
- 커밋: conventional commit(`feat:`/`test:`/`docs:`/`chore:`), 제목 한국어 허용, 태스크당 1커밋 이상.
- 브랜치: `main`에서 직접 작업(단독 그린필드).
- 게임 런타임 대상은 Claude Code(스펙 §9 v1 범위). 이 플랜의 코드 태스크는 어느 호스트에서든 구현·테스트 가능하다(게임 실행이 아니라 코드 작성이므로).

## 파일 구조

```
engine/
  cards.js       # 덱 생성·셔플(crypto)·카드 유틸
  evaluator.js   # 5/7카드 핸드 평가·비교
  sidepots.js    # 사이드팟 구성·분배·홀수 칩
  state.js       # 상태 로드/저장(원자적 rename)·mutation lock·stateVersion
  hand.js        # 핸드 상태기계 (new-hand/베팅/스트리트/쇼다운/정산/아카이브)
  views.js       # view --for user, hand --redacted, stats
  personas.js    # 페르소나 랜덤 생성 (init 시 1회)
  cli.js         # 명령 디스패치·공통 envelope·exit code
server/
  server.js      # 중계 서버 (SSE·슬롯·스냅샷·토큰·health)
  public/
    index.html   # 포커 테이블 UI
    app.js       # SSE 부트스트랩·렌더링·액션 바
    style.css    # 그린 펠트 테마
test/
  *.test.js      # 태스크별 테스트 (아래 각 태스크에 명시)
  helpers/fixtures.js  # 공용 테스트 헬퍼(고정 덱 주입 등)
.agents/skills/start-game/SKILL.md   # 딜러 절차 정본
.claude/skills/start-game            # → 심볼릭 링크
game/            # 런타임 상태 (gitignore, 코드 없음)
README.md
```

설계 원칙: 모듈은 순수 함수 위주(상태 in → 상태·이벤트 out), `hand.js`만 게임 규칙의 상태 전이를 소유하고 `cli.js`는 얇은 어댑터다. 테스트는 CLI가 아니라 모듈 함수를 직접 호출한다(덱 주입 가능). CLI 통합 테스트는 Task 10에서 별도로 수행한다.

---

### Task 0: 프로젝트 스캐폴드

**Files:**
- Create: `package.json`, `.gitignore`, `README.md`(빈 뼈대), 디렉토리들

**Interfaces:**
- Produces: `"type":"module"` ESM 환경, `npm test` = `node --test`

- [x] **Step 1:** `package.json` 작성:

```json
{
  "name": "ai-holdem",
  "private": true,
  "type": "module",
  "scripts": { "test": "node --test" }
}
```

- [x] **Step 2:** `.gitignore` 작성:

```
game/
*.log
.DS_Store
```

- [x] **Step 3:** 디렉토리 생성 `engine/ server/public/ test/helpers/`, `README.md`에 프로젝트 한 줄 설명만.
- [x] **Step 4:** 검증: `node --test`가 tests 0으로 exit 0 종료(에러 아님), `node --version` ≥ 20.
- [x] **Step 5:** 커밋 `chore: 프로젝트 스캐폴드`.

---

### Task 1: cards.js — 덱과 셔플

**Files:**
- Create: `engine/cards.js`, `test/cards.test.js`

**Interfaces:**
- Produces: `newDeck() -> string[52]` (고정 순서), `shuffle(deck, rng?) -> string[52]` — rng 미지정 시 `crypto.randomInt`, 지정 시 `rng: () => number`([0,1) 균등)를 사용해 `Math.floor(rng() * (i + 1))` Fisher-Yates. 새 배열 반환, `RANKS`, `SUITS`, `rankValue(card) -> 2..14`

- [ ] **Step 1 (RED):** `test/cards.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDeck, shuffle, rankValue } from '../engine/cards.js';

test('덱은 52장 전부 유일', () => {
  const d = newDeck();
  assert.equal(d.length, 52);
  assert.equal(new Set(d).size, 52);
  assert.ok(d.includes('As') && d.includes('2c') && d.includes('Td'));
});
test('셔플은 순열이며 원본을 훼손하지 않는다', () => {
  const d = newDeck(); const before = [...d];
  const s = shuffle(d);
  assert.deepEqual(d, before);
  assert.deepEqual([...s].sort(), [...d].sort());
});
test('rankValue', () => {
  assert.equal(rankValue('As'), 14);
  assert.equal(rankValue('Td'), 10);
  assert.equal(rankValue('2c'), 2);
});
```

- [x] **Step 2:** 실행 `node --test test/cards.test.js` → FAIL(모듈 없음) 확인.
- [x] **Step 3 (GREEN):** `engine/cards.js` 구현 (crypto.randomInt 기반 Fisher-Yates).
- [x] **Step 4:** 테스트 통과 확인 후 커밋 `feat: 카드 덱과 crypto 셔플`.

---

### Task 2: evaluator.js — 핸드 평가기

**Files:**
- Create: `engine/evaluator.js`, `test/evaluator.test.js`

**Interfaces:**
- Produces: `eval5(cards5) -> number[]` (사전식 비교 가능한 점수 벡터, `[카테고리, 타이브레이커...]`, 카테고리 8=스트레이트플러시 … 0=하이카드), `evaluate7(cards7) -> {score:number[], name:string}` (21개 5장 조합 중 최고), `compareScore(a,b) -> -1|0|1`, `HAND_NAMES` (한국어: "로열 스트레이트 플러시"…"하이 카드")

**구현 지침(참조 알고리즘 — 이대로 구현해도 되고 동등 로직이면 됨):**

```js
// eval5: 5장 → [category, tb...] (큰 쪽이 승리, 배열 사전식 비교)
// category: 8 SF, 7 quads, 6 boat, 5 flush, 4 straight, 3 trips, 2 two pair, 1 pair, 0 high
function eval5(cards) {
  const vals = cards.map(rankValue).sort((a, b) => b - a);
  const suits = cards.map(c => c[1]);
  const flush = suits.every(s => s === suits[0]);
  // 스트레이트: 유일 랭크 5개 + (최대-최소=4) 또는 휠 A-5432
  const uniq = [...new Set(vals)];
  let straightHigh = 0;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
    else if (uniq[0] === 14 && uniq[1] === 5 && uniq[4] === 2) straightHigh = 5; // 휠
  }
  const count = {};
  for (const v of vals) count[v] = (count[v] || 0) + 1;
  // 등장 횟수 desc, 랭크 desc 정렬 → 타이브레이커
  const groups = Object.entries(count)
    .map(([v, n]) => [n, +v]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  const tb = groups.map(g => g[1]);
  if (flush && straightHigh) return [8, straightHigh];
  if (groups[0][0] === 4) return [7, ...tb];
  if (groups[0][0] === 3 && groups[1][0] === 2) return [6, ...tb];
  if (flush) return [5, ...vals];
  if (straightHigh) return [4, straightHigh];
  if (groups[0][0] === 3) return [3, ...tb];
  if (groups[0][0] === 2 && groups[1][0] === 2) return [2, ...tb];
  if (groups[0][0] === 2) return [1, ...tb];
  return [0, ...vals];
}
```

- [ ] **Step 1 (RED):** `test/evaluator.test.js` — 아래 실제 케이스 + 표의 케이스 전부:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate7, compareScore } from '../engine/evaluator.js';

const s = h => evaluate7(h.split(' ')).score;
test('휠 스트레이트(A-2-3-4-5)는 5하이', () => {
  const wheel = s('As 2c 3d 4h 5s Kd Qc');
  const sixHigh = s('2s 3c 4d 5h 6s Kd Qc');
  assert.equal(compareScore(sixHigh, wheel), 1);
});
test('스틸 휠(A-5 스트레이트 플러시)', () => {
  const steel = s('As 2s 3s 4s 5s Kd Qc');
  assert.equal(steel[0], 8);
});
test('플러시는 스트레이트를 이긴다', () => {
  const flush = s('As Ks 9s 5s 2s 3d 4d');
  const straight = s('9c 8d 7h 6s 5c Ad Kd');
  assert.equal(compareScore(flush, straight), 1);
});
test('킥커 비교: 같은 원페어면 킥커 순서', () => {
  const a = s('As Ad Kc 9h 7s 4d 2c');  // AA K97
  const b = s('Ah Ac Qd 9c 7d 4s 2h');  // AA Q97
  assert.equal(compareScore(a, b), 1);
});
test('보드 플레이 동점(스플릿)', () => {
  const board = 'As Ks Qs Js Ts';
  const a = s(board + ' 2c 3d');
  const b = s(board + ' 7h 8h');
  assert.equal(compareScore(a, b), 0);
});
```

추가 필수 케이스(같은 파일에 같은 패턴으로 작성 — 입력과 기대를 정확히 이 표대로):

| 케이스 | 7장 | 기대 |
|---|---|---|
| 로열 | `As Ks Qs Js Ts 2c 3d` | category 8, high 14 |
| 포카드+킥커 | `Ac Ad Ah As Kc Qd 2s` vs `Ac Ad Ah As Qc Jd 2s` | 앞이 승 |
| 풀하우스 조합(777KK vs 777QQ) | 각각 구성 | 앞이 승 |
| 투페어 킥커 | `Ac Ad Kc Kd Qs 2h 3h` vs `Ac Ad Kc Kd Js 2h 3h` | 앞이 승 |
| 6-7장 중 최적 5장 선택 | `2c 2d 2h 5s 5d 5c Ah` → 풀하우스(555 22 아님 — 555+22? 트리플 둘) | category 6, tb [5,2] |
| 스트레이트 중복 랭크 | `9c 9d 8h 7s 6c 5d Ah` | category 4, high 9 |
| 트립스 | `Ac Ad Ah 9s 7d 4c 2h` | category 3 |
| 원페어 vs 하이카드 | `Ac Ad Kc Qd 9s 7h 4c` vs `Ac Kd Qc Jd 9s 7h 4c` | 앞이 승 |
| 하이카드 킥커 | `Ac Kd Qc Jd 9s 7h 4c` vs `Ac Kd Qc Jd 8s 7h 4c` | 앞이 승 |

- [ ] **Step 2:** RED 확인 → **Step 3 (GREEN):** 구현(eval5 + 21조합 evaluate7 + compareScore + HAND_NAMES 한국어) → **Step 4:** 전체 통과 → **Step 5:** 커밋 `feat: 7카드 핸드 평가기`.

---

### Task 3: state.js — 원자적 저장·mutation lock·stateVersion

**Files:**
- Create: `engine/state.js`, `test/state.test.js`

**Interfaces:**
- Produces:
  - `loadState(gameDir) -> state | null`
  - `saveState(gameDir, state)` — `state.stateVersion += 1` 후 temp 파일 + `fs.renameSync`로 원자 커밋
  - `readHand(gameDir, n) -> record|null`, `writeHandArchive(gameDir, record)` (record.handNo로 파일명; 파일명은 `hand-${String(handNo).padStart(4,'0')}.json` (4자리 패딩 — 계약)), `withMutation` 콜백 계약 — `fn(state) -> {state, response}`를 받아 커밋 후 `{state, response}`를 반환한다. `writeJsonAtomic`은 **엔진 전용**이다(서버는 동일 패턴을 자체 구현 — 엔진 import 금지).
  - `withMutation(gameDir, fn)` — `game/.mutex` 디렉토리를 `fs.mkdirSync`로 획득(획득 실패 시 100ms 간격 최대 3초 재시도, 이후 `{code:'LOCKED'}` throw; mutex 내 `pid` 파일로 죽은 소유자 감지 시 회수). fn 안에서 load→검증→save. fn이 throw하면 저장하지 않는다(상태 무변경 보장).
  - `writeJsonAtomic(path, obj)` — 아카이브·스냅샷 등 엔진 전용(서버는 동일 패턴을 자체 구현)
- Consumes: 없음 (fs만)

- [x] **Step 1 (RED):** `test/state.test.js` — 실제 케이스:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import { loadState, saveState, withMutation } from '../engine/state.js';

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-')); }

test('save는 stateVersion을 올리고 load로 왕복된다', () => {
  const d = tmpDir();
  saveState(d, { stateVersion: 0, foo: '가' });
  const s = loadState(d);
  assert.equal(s.stateVersion, 1);
  assert.equal(s.foo, '가');
});
test('withMutation에서 fn이 throw하면 상태 무변경', () => {
  const d = tmpDir();
  saveState(d, { stateVersion: 0, v: 1 });
  assert.throws(() => withMutation(d, s => { s.v = 2; throw new Error('boom'); }));
  assert.equal(loadState(d).v, 1);
});
test('죽은 소유자의 mutex는 회수되고 커밋이 성공한다', () => {
  const d = tmpDir();
  fs.mkdirSync(path.join(d, '.mutex'));
  fs.writeFileSync(path.join(d, '.mutex', 'pid'), '999999999');
  saveState(d, { stateVersion: 0 });
  const r = withMutation(d, s => ({ state: { ...s, ok: true }, response: null }));
  assert.equal(r.state.ok, true);
  assert.equal(loadState(d).ok, true);
});
test('아카이브 파일명은 4자리 패딩', () => {});
```

- [x] **Step 2~5:** RED → 구현 → GREEN → 커밋 `feat: 원자적 상태 저장과 mutation lock`.

---

### Task 4: sidepots.js — 사이드팟 구성과 분배

**Files:**
- Create: `engine/sidepots.js`, `test/sidepots.test.js`

**Interfaces:**
- Produces:
  - `buildPots(contribs: Map<pid, chips>, folded: Set<pid>) -> [{amount, eligible: pid[]}]` (기여 레벨별 레이어, 동일 eligible 병합; 폴드 기여는 amount에 포함되나 eligible 제외)
  - `awardPots(pots, scores: Map<pid, score>, oddChipOrder: pid[]) -> Map<pid, chips>` (팟별 최고 score 동점 분할, 홀수 칩은 oddChipOrder 앞 좌석부터 1개씩)

**참조 알고리즘 (buildPots):**

```js
export function buildPots(contribs, folded) {
  const levels = [...new Set([...contribs.values()].filter(v => v > 0))].sort((a, b) => a - b);
  const pots = []; let prev = 0;
  for (const lv of levels) {
    let amount = 0; const eligible = [];
    for (const [pid, c] of contribs) {
      amount += Math.max(0, Math.min(c, lv) - prev);
      if (c >= lv && !folded.has(pid)) eligible.push(pid);
    }
    if (amount > 0) {
      const last = pots.at(-1);
      const same = last && last.eligible.length === eligible.length
        && last.eligible.every(p => eligible.includes(p));
      if (same) last.amount += amount; else pots.push({ amount, eligible });
    }
    prev = lv;
  }
  return pots;
}
```

- [x] **Step 1 (RED):** 실제 케이스:

```js
test('3-way 올인 사이드팟', () => {
  // A 100 올인, B 300 올인, C 300 콜
  const pots = buildPots(new Map([['A',100],['B',300],['C',300]]), new Set());
  assert.deepEqual(pots, [
    { amount: 300, eligible: ['A','B','C'] },
    { amount: 400, eligible: ['B','C'] },
  ]);
});
test('폴드 기여는 팟에 남고 자격은 없다', () => {
  const pots = buildPots(new Map([['A',50],['B',200],['C',200]]), new Set(['A']));
  assert.deepEqual(pots, [{ amount: 450, eligible: ['B','C'] }]);
});
test('동점 스플릿 홀수 칩은 순서 앞 좌석부터', () => {
  const out = awardPots([{ amount: 101, eligible: ['A','B'] }],
    new Map([['A',[1,14]],['B',[1,14]]]), ['B','A']);
  assert.equal(out.get('B'), 51); assert.equal(out.get('A'), 50);
});
```

- [x] **Step 2~5:** RED → 구현 → GREEN → 커밋 `feat: 사이드팟 구성·분배`.

---

### Task 5: hand.js (1/3) — 게임 생성·버튼 로테이션·블라인드·레벨

**Files:**
- Create: `engine/hand.js`, `test/hand-setup.test.js`

**Interfaces:**
- Produces:
  - `createGame({aiCount, startStack=5000, blinds0=[25,50], levelEvery=8, names}) -> state` — seats: `user` + `p1..pN`, `phase:'idle'`, `handNo:0`, `button` 랜덤 좌석
  - `blindsForLevel(level) -> [sb, bb]` — 스케줄: 25/50, 50/100, 75/150, 100/200, 150/300, 200/400, 300/600, 400/800, 500/1000, 700/1400, 1000/2000, 이후 ×1.5 정수 반올림(`Math.round`). ×1.5 구간 기대값: 1000/2000 다음은 1500/3000 → 2250/4500 → 3375/6750. `--blinds SB/BB`가 기본값(25/50)이 아니면 스케줄 전체를 비율 스케일한다 — `blindsForLevel(level, blinds0)` = 기본표[level]을 (blinds0/25·50) 배율로 정수 반올림. 테스트: blinds0=50/100이면 레벨 1은 100/200.
  - `startHand(state, {deck}) -> {state, events}` — 레벨 = `Math.floor((handNo - 1) / levelEvery)` (handNo는 증가 후 1부터 — 핸드 1~8 = 레벨 0, 9번째 핸드부터 레벨 1), 버튼을 다음 생존 좌석으로 이동(dead button 규칙은 생략 — 단순화 결정), SB/BB 포스팅(스택 부족 시 전액 올인 포스팅), 홀카드 딜(`deal_hole` actor 이벤트), 헤즈업 특례(버튼=SB, 프리플랍 버튼 선행동, 포스트플랍 BB 선행동), `phase:'in_hand'`. `deck` 옵션은 테스트 주입용(생략 시 shuffle).
  - state에 `gameOver=true`거나 user 스택 0이면 `{code:'GAME_OVER'}` throw

**state 핵심 필드(이 태스크에서 확정):** `{schemaVersion:1, stateVersion, config, sessionToken, level, handNo, phase, button, seats:[{playerId,name,stack,out}], hand:{street, deck, board, holes, contribs, bets, folded, allIn, toActIdx, actionIndex, currentBet, lastRaiseSize, lastAggressor, reopenEligible}, lastHand, stats, gameOver, result}`

**직렬화 규칙:** state는 JSON 왕복 가능해야 하므로 컬렉션은 전부 plain object/array다 — `contribs:{pid:chips}`, `holes:{pid:[c,c]}`, `folded:[pid]`, `allIn:[pid]`. Map/Set은 state에 넣지 않는다(`sidepots.js`의 Map 인자는 호출부인 `hand.js`가 `new Map(Object.entries(...))`로 변환해 전달). 모든 이벤트는 생성 시점부터 `{seq, visibility, type, ...}` 형태다(스펙 §4).

**이벤트 payload 표(전 태스크 공용 계약 — Task 7·8·12·14는 이 표를 소비한다):**

| type | visibility | 필수 필드 |
|---|---|---|
| `hand_start` | public | `handNo, level, blinds:[sb,bb], button(playerId)` |
| `blinds_posted` | public | `sb, bb, posts:[{playerId, amount, allIn}]` |
| `deal_hole` | `actor:<pid>` | `playerId, cards:[c,c]` |
| `action` | public | `playerId, action, amount?, allIn?, street` (amount는 raise-to) |
| `street` | public | `street, board` (전체 보드 배열) |
| `showdown` | public | `reveals:[{playerId, cards, handName}], mucks:[playerId]` |
| `pot_award` | public | `potIndex, amount, winners:[{playerId, share}]` |
| `level_up` | public | `level, sb, bb` |
| `bust` | public | `playerId` |
| `game_over` | public | `result, bustedPlayerIds` |

`talk`·`coach`·`narration`은 엔진이 생성하지 않는다 — 딜러 publish 전용 이벤트로 `seq`가 없으며, 순서 정본은 서버 `revision`이다(엔진 seq는 엔진 이벤트만 정렬한다).

- [x] **Step 1 (RED):** `test/hand-setup.test.js` 실제 케이스:

```js
test('레벨업 경계: levelEvery=8이면 9번째 핸드부터 레벨 1', () => {
  let st = createGame({ aiCount: 2, levelEvery: 8 });
  st.handNo = 8; st.phase = 'idle';
  const r = startHand(st, { deck: fixedDeck() });
  assert.equal(r.state.handNo, 9);
  assert.equal(r.state.level, 1);           // 50/100
  const posted = r.events.find(e => e.type === 'blinds_posted');
  assert.equal(posted.bb, 100);
});
test('숏스택 블라인드는 전액 올인 포스팅', () => {
  let st = createGame({ aiCount: 2 });
  // 3인, seats [user,p1,p2], 회전 전 st.button=1 → startHand가 다음 생존 좌석 2(p2)로 이동 → SB=user(0), BB=p1(1)
  st.button = 1;
  st.seats.find(s => s.playerId === 'p1').stack = 30;
  const r = startHand(st, { deck: fixedDeck() });
  const p1 = r.state.seats.find(s => s.playerId === 'p1');
  assert.equal(p1.stack, 0);
  assert.equal(r.state.hand.contribs['p1'], 30);
  assert.ok(r.state.hand.allIn.includes('p1'));
});
test('헤즈업: 버튼이 SB이고 프리플랍 선행동', () => {
  const st = createGame({ aiCount: 1 });
  const r = startHand(st, { deck: fixedDeck() });
  const btnSeat = r.state.seats[r.state.button].playerId;
  assert.equal(r.state.hand.contribs[btnSeat], blindsForLevel(0)[0]); // 버튼=SB
  assert.equal(r.state.seats[r.state.hand.toActIdx].playerId, btnSeat);
  const bbSeat = r.state.seats.find(s => s.playerId !== btnSeat).playerId;
  let st = applyAction(r.state, btnSeat, 'call').state;
  st = applyAction(st, bbSeat, 'check').state;
});
test('탈락 좌석 건너뛰고 버튼 이동, out 좌석 미딜링', () => { /* p2.out=true 세팅 후 startHand → p2 홀카드 없음, 버튼·블라인드가 생존 좌석만 순회 */ });
```

(`fixedDeck()`는 `test/helpers/fixtures.js`에 구현: 고정 순서 덱 반환.)

- [x] **Step 2~5:** RED → 구현 → GREEN → 커밋 `feat: 핸드 시작·로테이션·블라인드·레벨`.

---

### Task 6: hand.js (2/3) — 베팅 라운드·legal·apply

**Files:**
- Modify: `engine/hand.js`
- Create: `test/hand-betting.test.js`

**Interfaces:**
- Produces:
  - `legalFor(state) -> {stateVersion, decisionId, handNo, street, toAct, canCheck, callAmount, canRaise, minRaiseTo, maxRaiseTo, potTotal, handOver, gameOver, result?, bustedPlayerIds?}` — 핸드 밖이면 `toAct:null, handOver:true`
  - `applyAction(state, playerId, action, amount?) -> {state, events}` — 검증(차례·합법성·raise-to 범위) 실패 시 `{code:'ILLEGAL_ACTION', message}` throw(상태 무변경), 성공 시 액션 이벤트 + 라운드 종결 판정
  - `forceDefault(state, playerId) -> {state, events}` — 체크 가능하면 체크, 아니면 폴드. applyAction과 동일 반환 계약.
  - 스트리트 전환 시 `bets`는 0으로 리셋, `currentBet=0`, 포스트플랍 첫 벳(raise-to)의 최소 금액은 BB다.
- 규칙 정밀 정의(테스트가 강제):
  - `minRaiseTo = currentBet + lastRaiseSize` (프리플랍 시작 lastRaiseSize=BB)
  - 언더 레이즈 올인(`amount < minRaiseTo`인 올인)은 허용하되 `lastRaiseSize`를 갱신하지 않고, 이미 행동을 마친 플레이어에게 액션을 다시 열지 않는다(그들은 콜/폴드만 가능)
  - 내 스택이 minRaiseTo 미만이어서 올인 레이즈만 가능한 경우(재오픈 금지와 구별): `canRaise:true`, `minRaiseTo > maxRaiseTo`로 반환되며 유일한 합법 raise amount는 maxRaiseTo다(스펙 §4).
  - 벳이 없는 스트리트의 첫 벳도 액션 enum상 `raise`(raise-to)로 표현한다 — `bet` 액션은 없다.
  - `decisionId`는 `(handNo, street, actionIndex)`에서 유도 — apply 성공 시에만 actionIndex 증가

- [x] **Step 1 (RED):** `test/hand-betting.test.js` 실제 케이스:

```js
// 공용 셋업: 3인 [user,p1,p2], button=0(user) → SB=p1, BB=p2, 블라인드 25/50, 레벨 0
// 프리플랍 첫 행동자는 버튼(user). 스택은 각 케이스에 명시.
test('언더 레이즈 올인은 베팅을 다시 열지 않는다', () => {
  // 스택: user 5000, p1 5000, p2 130
  let st = setup3(5000, 5000, 130);
  st = applyAction(st, 'user', 'raise', 100).state;   // lastRaise 50 → 다음 min 150
  st = applyAction(st, 'p1', 'fold').state;
  st = applyAction(st, 'p2', 'raise', 130).state;      // 언더 레이즈 올인 (150 미만)
  const la = legalFor(st);
  assert.equal(la.toAct, 'user');
  assert.equal(la.canRaise, false);                    // user에게 다시 열리지 않음
  assert.equal(la.callAmount, 30);
});
test('minRaiseTo: 프리플랍 연쇄', () => {
  let st = setup3(5000, 5000, 5000);
  st = applyAction(st, 'user', 'raise', 100).state;    // BB 50 기준 lastRaise 50
  assert.equal(legalFor(st).minRaiseTo, 150);          // p1 차례
  st = applyAction(st, 'p1', 'raise', 300).state;      // lastRaise 200
  assert.equal(legalFor(st).minRaiseTo, 500);          // p2 차례
});
test('forceDefault: 체크 가능하면 체크, 아니면 폴드', () => {
  let st = setup3(5000, 5000, 5000);
  st = applyAction(st, 'user', 'call').state;
  st = applyAction(st, 'p1', 'call').state;
  const r1 = forceDefault(st, 'p2');                     // 미벳 → check
  assert.equal(r1.events.find(e => e.type === 'action').action, 'check');
  let st2 = setup3(5000, 5000, 5000);
  st2 = applyAction(st2, 'user', 'raise', 150).state;
  const r2 = forceDefault(st2, 'p1');                    // 벳 직면 → fold
  assert.equal(r2.events.find(e => e.type === 'action').action, 'fold');
});
test('숏스택 올인 레이즈: minRaiseTo > maxRaiseTo, canRaise true', () => {
  // 3인 [user,p1,p2], button=0(user) → SB=p1, BB=p2. 블라인드 25/50, 스택 user 5000 / p1 5000 / p2 200
  let st = setup3(5000, 5000, 200);
  st = applyAction(st, 'user', 'raise', 150).state;  // BTN 오픈 레이즈 → 다음 min 250
  st = applyAction(st, 'p1', 'fold').state;
  const la = legalFor(st);
  assert.equal(la.toAct, 'p2');
  assert.equal(la.canRaise, true);
  assert.ok(la.minRaiseTo > la.maxRaiseTo);
  assert.equal(la.maxRaiseTo, 200);
  applyAction(st, 'p2', 'raise', 200);               // 올인 레이즈 성공해야 함
});
test('legal 재호출은 같은 decisionId (안정성)', () => {
  let st = setup3(5000, 5000, 5000);
  const a = legalFor(st); const b = legalFor(st);
  assert.equal(a.decisionId, b.decisionId);
});
test('apply 실패 시 상태 무변경·actionIndex 불변', () => {
  let st = setup3(5000, 5000, 5000);
  const before = JSON.stringify(st);
  assert.throws(() => applyAction(st, 'user', 'raise', 999999));
  assert.equal(JSON.stringify(st), before);
});
test('체크-레이즈 합법', () => { /* BB 체크 → 상대 벳 → BB 레이즈 성공 */ });
test('minRaiseTo 계산', () => { /* 벳 100 → 레이즈는 200 이상; 300 레이즈 후 재레이즈는 500 이상 */ });
test('forceDefault: 체크 가능하면 체크, 아니면 폴드', () => { /* 두 상황 각각 */ });
```

- [x] **Step 2~5:** RED → 구현 → GREEN → 커밋 `feat: 베팅 라운드·legal·apply`.

---

### Task 7: hand.js (3/3) — 스트리트 진행·런아웃·쇼다운·정산·아카이브

**Files:**
- Modify: `engine/hand.js`
- Create: `test/hand-showdown.test.js`

**Interfaces:**
- Produces (applyAction 내부에서 자동):
  - 베팅 라운드 종결 → 다음 스트리트 딜(`street` 이벤트, board 갱신) 또는 쇼다운
  - 전원 올인·콜 완료 → 잔여 보드 자동 런아웃
  - 한 명 남으면 즉시 팟 지급(쇼다운 없음, 홀카드 비공개)
  - 쇼다운: 공개 순서(마지막 베팅 스트리트의 마지막 공격자부터 시계방향, 공격 없으면 버튼 왼쪽부터), 승자 패 필수 공개, 지는 패 머킹(`showdown` 이벤트에 공개/머킹 구분), `pot_award` 이벤트(팟별)
  - 정산: 스택 반영, `bust` 이벤트, 사용자 0 → `gameOver, result:'lose'`; AI 전원 0 → `result:'win'`; `game_over` 이벤트. bust 정산 시 해당 좌석 `out=true`를 설정한다(startHand는 out 좌석을 스킵).
  - 홀수 칩: `oddChipOrder`는 버튼 왼쪽부터 시계방향의 해당 팟 자격자 순서다.
  - 핸드가 닫히면 정산 결과 전체를 `state.lastHand`(재생성 가능한 전체 기록: 홀카드·보드·액션·결정 스냅샷·팟 분배·shown/muck)에 남기는 것까지가 `hand.js`의 몫이고, **아카이브 파일 기록과 roll-forward(`rebuildArchive(gameDir)`)는 `cli.js`가 소유한다**(apply 처리: withMutation으로 state 커밋 → 커밋 후 lastHand가 새로 닫혔으면 writeHandArchive).
  - 핸드 히스토리(lastHand)에 결정 스냅샷: 각 액션마다 `{decisionId, playerId, action, amount, street, potTotal, callAmount, minRaiseTo, maxRaiseTo, board, stacks}`
  - 통계 누적: `state.stats[pid] = {hands, vpip, pfr, betsRaises, calls, showdowns, showdownWins, net}`

- [x] **Step 1 (RED):** `test/hand-showdown.test.js` 실제 케이스:

```js
test('헤즈업 포스트플랍 선행동은 BB', () => {
  const st = createGame({ aiCount: 1 });
  const r = startHand(st, { deck: fixedDeck() });
  const btnSeat = r.state.seats[r.state.button].playerId;
  const bbSeat = r.state.seats.find(s => s.playerId !== btnSeat).playerId;
  let next = applyAction(r.state, btnSeat, 'call').state;
  next = applyAction(next, bbSeat, 'check').state;
  assert.equal(legalFor(next).toAct, bbSeat);
});
test('포스트플랍 벳과 체크-레이즈', () => {
  let st = setup3(5000, 5000, 5000);
  st = applyAction(st, 'user', 'call', undefined).state; // 콜 50
  st = applyAction(st, 'p1', 'call').state;              // SB 컴플릿
  st = applyAction(st, 'p2', 'check').state;             // 플랍으로
  assert.equal(legalFor(st).street, 'flop');
  assert.equal(legalFor(st).toAct, 'p1');                // 포스트플랍은 SB부터
  st = applyAction(st, 'p1', 'check').state;
  st = applyAction(st, 'p2', 'raise', 100).state;        // 벳 100 (첫 벳도 raise-to로 표현)
  assert.equal(legalFor(st).minRaiseTo, 200);            // user 차례
  st = applyAction(st, 'user', 'fold').state;
  st = applyAction(st, 'p1', 'raise', 300).state;        // 체크-레이즈 합법
  assert.equal(legalFor(st).toAct, 'p2');
});
test('칩 보존: 핸드 전후 총합 불변', () => {
  // 고정 덱 3인 핸드를 쇼다운까지 진행
  const total = st => st.seats.reduce((a, s) => a + s.stack, 0)
    + Object.values(st.hand?.contribs ?? {}).reduce((a, c) => a + c, 0);
  /* 진행 전후 total 동일 assert */
});
test('한 명 남으면 쇼다운 없이 지급·홀카드 비공개', () => { /* showdown 이벤트 없음, pot_award만 */ });
test('올인 런아웃: 프리플랍 올인 콜 → 보드 5장 자동', () => { /* street 이벤트 3회 연속 */ });
test('쇼다운 공개 순서와 머킹', () => { /* 고정 덱과 button을 명시하고 리버 체크 종료 → 버튼 왼쪽부터; 지는 패 muck 표시, reveals/mucks의 playerId 단언 */ });
test('사용자 버스트 → gameOver lose', () => { /* user 스택 0 정산 → result lose, game_over 이벤트 */ });
test('동시 버스트: 사용자 생존+AI 전멸 → win', () => {});
test('bust 좌석은 out=true', () => {});
test('lastHand 완전성: 정산 후 lastHand로 hand-NNNN.json 내용을 재구성할 수 있다(모듈 수준 비교)', () => {});
```

- [x] **Step 2~5:** RED → 구현 → GREEN → 커밋 `feat: 쇼다운·정산·아카이브·게임 종료`.

---

### Task 8: views.js — 사용자 뷰·redacted 히스토리·통계

**Files:**
- Create: `engine/views.js`, `test/views.test.js`

**Interfaces:**
- Produces:
  - `viewFor(state, playerId) -> {...}` (정본 — myCards는 해당 playerId의 홀카드, legal은 그 플레이어 차례일 때만), `userView(state) = viewFor(state,'user')` 래퍼. view에는 `levelEvery`(config 공개값)도 포함한다 — UI 상단바의 '다음 레벨업까지 남은 핸드' 계산용.
  - `redactRecord(record, viewerId='user') -> {...}` — 아카이브/`state.lastHand` **레코드**를 입력으로 받는 순수 함수. 해당 뷰어 관점에서 공개된 정보만 남긴다(자기 홀카드, 보드, 쇼다운 공개 패, 액션 시퀀스, 결정 스냅샷).
  - `statsReport(state) -> {perPlayer: {vpip, pfr, af, showdownWin, net, sample}}` — 정의는 스펙 §8 (VPIP: 블라인드 강제 제외 자발적 투입, AF=(벳+레이즈)/콜)
- Consumes: Task 5~7의 state 구조, `legalFor`

- [ ] **Step 1 (RED):** 고정 픽스처 검사 — 실제 케이스:

```js
test('userView에 금지 정보가 없다', () => {
  const v = userView(st);
  const json = JSON.stringify(v);
  for (const banned of [st.hand.deck[0], holeOf(st, 'p1')[0], 'archetype', 'bluffFreq']) {
    assert.ok(!json.includes(banned), `유출: ${banned}`);
  }
  assert.ok(v.myCards.length === 2);
});
test('redactRecord: 머킹된 패 미포함, 쇼다운 공개 패 포함', () => {});
test('public 이벤트에 금지 정보 없음', () => {
  // 정산까지 끝난 핸드의 events 중 visibility==='public'만 모아 JSON化
  // → 덱 카드·타인 홀카드 문자열이 포함되지 않음을 assert (deal_hole은 actor 전용이어야 함)
});
test('VPIP: BB 체크는 미집계, SB 컴플릿은 집계', () => {});
test('내 차례일 때만 legal 포함 + decisionId 일치', () => {});
test('viewFor(p1)은 p1 카드만, user 카드 비노출', () => {});
test('코치 입력 합성(redactRecord + statsReport JSON)에 상대 홀카드·덱·아키타입 문자열 부재', () => {});
```

- [ ] **Step 2~5:** RED → 구현 → GREEN → 커밋 `feat: 사용자 뷰·redacted 히스토리·통계`.

---

### Task 9: personas.js — 페르소나 생성

**Files:**
- Create: `engine/personas.js`, `test/personas.test.js`

**Interfaces:**
- Produces: `generatePersonas(n) -> [{playerId:'p1'.., seat, name, agentHandle:'player-p1'.., speech, personality, archetype, bluffFreq, threeBetFreq, tiltProne}]` — archetype ∈ 6종(TAG/LAG/Nit/CallingStation/Maniac/Trickster), 이름은 한국어 풀(≥20개)에서 중복 없이, 수치 파라미터는 아키타입 기준값 ± 랜덤 변주. `generatePersonas(n)`은 AI만 생성한다. `players.json` 파일은 init(cli.js)이 기록하며 **user 레코드 `{playerId:'user', seat, name:'나'}`를 포함**한 전 좌석 배열이다(스펙 §6). 스폰 대상 필터는 `playerId`가 `p`로 시작하는 레코드뿐이다(Task 14 스킬 문서에도 동일 문면).

- [ ] **Step 1 (RED):**

```js
test('필드는 닫힌 목록이고 이름 중복 없음', () => {
  const ps = generatePersonas(8);
  const keys = ['playerId','seat','name','agentHandle','speech','personality','archetype','bluffFreq','threeBetFreq','tiltProne'];
  for (const p of ps) assert.deepEqual(Object.keys(p).sort(), [...keys].sort());
  assert.equal(new Set(ps.map(p => p.name)).size, 8);
  assert.equal(ps[0].agentHandle, 'player-p1');
});
test('아키타입은 6종 안에서만', () => {});
test('players.json 형태: user 레코드 포함, AI만 페르소나 필드 보유', () => {});
```

(이 테스트는 Task 10 init 통합 테스트로 배치해도 된다.)

- [ ] **Step 2~5:** RED → 구현 → GREEN → 커밋 `feat: 페르소나 생성`.

---

### Task 10: cli.js — 명령 디스패치·envelope·게임 디렉토리 통합

**Files:**
- Create: `engine/cli.js`, `test/cli.test.js`

**Interfaces:**
- Produces (사용법: `node engine/cli.js <cmd> [args] [--game-dir game]`):
  - `init --ai <n> [--stack N] [--blinds SB/BB] [--level-every N] [--force]` → createGame + generatePersonas + sessionToken(`crypto.randomBytes(16).toString('hex')`) → `players.json`, state 저장. stdout에 `{ok, sessionToken, port?, players:[{playerId,name}]}` (**페르소나 상세는 stdout에 내지 않는다** — 스타일 비공개; 딜러는 스폰 시 `players.json`을 에이전트 프롬프트 작성에만 사용). lock 존재+서버 생존 시 `{ok:false, code:'ACTIVE_GAME'}`.
  - `new-hand`, `legal`, `apply <pid> <action> [amount] [--expect-version N]`, `apply <pid> --force-default`, `view --for user|<pid>`, `hand <n> [--redacted]`, `stats`, `end --result abort`, `resume-check`(정합 자가검사+roll-forward)
  - state 커밋 후 아카이브 쓰기 실패는 실패 envelope가 아니다 — 성공 응답에 `archivePending:true`를 더해 반환하고, 다음 `resume-check`가 멱등 복구한다(복구 대상은 `state.lastHand`가 가리키는 마지막 핸드뿐이다).

| 명령 | stdout (envelope 공통 필드 외) |
|---|---|
| `legal` | `legalFor` 전 필드 그대로 |
| `apply` / `apply --force-default` | `events`(visibility 포함 전체), `handOver`, `gameOver` (+종료 시 `result`, `bustedPlayerIds`). force-default도 `action` 이벤트(check/fold)를 생성한다 |
| `view --for <pid|user>` | `viewFor` 결과 |
| `hand <n> [--redacted]` | `readHand(gameDir, n)`(현재 핸드면 `state.lastHand`) 후 `--redacted`면 `redactRecord(record)` 적용 |
| `resume-check` | `{ok, serverPidAlive, port, sessionToken, stateVersion, phase, toAct, archiveRepaired}` — lock 판독 + serverPid 생존 확인 + `rebuildArchive` 수행 |
|  | 엔진은 HTTP를 호출하지 않는다 — 최종 attach 판정은 딜러(Task 14)가 lock의 port로 `GET /api/health`를 호출해 내린다. |
| `init --force` | 절차: lock 판독 → serverPid 생존이면 SIGTERM·종료 대기(최대 5초) → `game/` 폐기 → 새 init |
| `end --result abort` | withMutation 안에서 `gameOver=true, result:'abort'` 기록. envelope `{ok:true, stateVersion, gameOver:true, result:'abort', events:[]}`. 이후 `new-hand`는 거부된다 |
  - 공통 envelope: 성공 `{ok:true, stateVersion, events?, ...}` / 실패 `{ok:false, code, message}`, exit 0/1/2. 모든 변경 명령은 `withMutation` 임계구역.
  - 이벤트는 visibility 필터 없이 **전부** 반환하되 각 이벤트에 `visibility` 표시(public 필터링은 딜러 규약 — 스펙 §4).
- Consumes: Task 3~9 전부.

- [x] **Step 1 (RED):** `test/cli.test.js` — `child_process.execFileSync`로 실제 CLI 왕복:

```js
test('스크립트된 3인 핸드 통합', () => {
  // tmp game-dir에서: init → new-hand → legal/apply 반복(고정 시나리오는 --deck 주입 옵션으로) → 핸드 종료까지
  // 각 응답 envelope {ok:true, stateVersion} 확인, 종료 후 hands/hand-0001.json 존재
});
test('불법 액션 → ok:false, exit 1, 상태 무변경', () => {});
test('--expect-version 불일치 → 거부', () => {});
test('init은 활성 게임에서 ACTIVE_GAME 거부', () => {});
test('init stdout에 archetype/bluffFreq 미노출', () => {});
test('과거 핸드 조회: 두 핸드 진행 후 hand 1 --redacted', () => {});
test('gameOver 후 new-hand 거부', () => {});
test('핸드 1·2 진행 → `hand-0002.json`만 삭제 → `resume-check` → `archiveRepaired:true`, hand-0002 복구, hand-0001은 그대로', () => {});
test('end abort 후 new-hand 거부', () => {});
test('init --force: 살아 있는 가짜 서버(spawn된 node 대기 프로세스)를 SIGTERM 후 새 게임 생성', () => {});
test('연속 3핸드 로테이션: 버튼·SB·BB가 매 핸드 시계방향 이동(4인)', () => {});
```

(테스트를 위해 `new-hand --deck "As,Kd,..."` 숨은 옵션 지원 — 52장 콤마 목록. README에는 문서화하지 않는다.)

- [x] **Step 2~5:** RED → 구현 → GREEN → 커밋 `feat: 엔진 CLI와 공통 envelope`.

---

### Task 11: server.js — 중계 서버

**Files:**
- Create: `server/server.js`, `test/server.test.js`

**Interfaces:**
- Produces (사용법: `node server/server.js --game-dir game --port 8877 --token <t>`; 기동 시 `game/lock.json`{serverPid,port,sessionToken,startedAt} 원자 기록):
  - `GET /api/health` → `{ok:true}` (토큰 불요)
  - `GET /?token=` 정적 서빙(`server/public/`)
  - `GET /api/events?token&after=<rev>` SSE — 누적 로그에서 after 이후 재전송 후 라이브, `id:<revision>`, 15s heartbeat 코멘트, `retry: 3000`
  - `GET /api/snapshot?token` → `{revision, view, log:[], coach:[]}`
  - `POST /api/publish` body `{token, publishId, view?, events?, messages?, coach?, review?}` — `events`는 엔진 public 이벤트(각각 `{seq, visibility, type, ...}`), `messages`는 딜러 작성 메시지 `[{type:'talk'|'narration', playerId?, text}]`, `coach`는 `[{handNo, text}]`, `review`는 종합 리뷰 마크다운 문자열. **snapshot = `{revision, view, log, coach, review?}`** — log는 events·messages가 도착 revision 순으로 병합 누적된 배열이다. publishId 중복 시 저장된 revision 반환(멱등), 아니면 revision++ 후 스냅샷 갱신(`game/ui-snapshot.json` 원자 저장) + SSE 브로드캐스트. view만 있는 재게시는 로그에 추가 없음.
  - 모든 성공 envelope는 `events` 배열을 포함한다 — 이벤트가 없는 명령(`legal`, `view`, `stats` 등)은 `events: []`.
  - `POST /api/action` body `{token, decisionId, action, amount?}` — 최신 view의 legal.decisionId와 불일치 시 409, 일치 시 깊이 1 슬롯 저장
  - `GET /api/wait-action?token&timeoutMs=25000&expectDecisionId=` — 일치 액션 즉시/도착 시 반환+슬롯 비움, 타임아웃 `{timeout:true}`
  - 127.0.0.1 바인딩, 토큰 불일치 401, body > 64KB 413, `server.timeout=0`, `keepAliveTimeout` 넉넉히
- Consumes: 없음(엔진 import 금지 — 게임 로직 무지 유지). view 구조는 불투명 JSON으로 취급.

- [x] **Step 1 (RED):** `test/server.test.js` — 실제 http 왕복(포트 0 사용):

```js
test('publish → snapshot → SSE after-replay 갭 없음', async () => {
  // publish rev1, rev2 → EventSource 대신 raw http로 /api/events?after=1 접속
  // → rev2가 재전송되는지 확인
});
test('publishId 중복은 같은 revision 반환(로그 중복 없음)', async () => {});
test('action: decisionId 불일치 409, 일치 시 wait-action이 소비', async () => {});
test('토큰 없음 401, 바디 65KB 413', async () => {});
test('타임아웃 설정: server.timeout===0, keepAliveTimeout>=75000, headersTimeout>=80000', async () => {});
test('서버 재시작: ui-snapshot.json에서 revision·log·coach까지 복원', async () => {});
test('review 게시 → snapshot 보존 → 서버 재시작 후 복원', async () => {});
test('깊이 1 덮어쓰기: 같은 decisionId로 두 번 POST → 마지막 값만 소비', async () => {});
test('소비 직후의 두 번째 wait-action은 timeout', async () => {});
test('슬롯 decisionId ≠ expectDecisionId면 소비하지 않고 timeout', async () => {});
```

- [x] **Step 2~5:** RED → 구현 → GREEN → 커밋 `feat: 중계 웹 서버`.

---

### Task 12: 웹 UI — 포커 테이블

**Files:**
- Create: `server/public/index.html`, `server/public/app.js`, `server/public/style.css`
- Create: `test/helpers/dev-drive.js` (UI 수동 검증용 가짜 딜러: 서버에 canned view/이벤트 시퀀스를 publish)

**Interfaces:**
- Consumes: 스펙 §7 화면 구성, `userView` 필드(Task 8), 서버 API(Task 11)
- Produces: 완결된 단일 페이지 UI (한국어, 그린 펠트, 타원 테이블, 좌석 배치, 커뮤니티 카드, 팟, 액션 바, 로그/코치 탭, 리뷰 오버레이, "OO 생각 중…" 표시)

**부트스트랩 시퀀스(app.js에 이 로직 그대로):**

```js
const token = new URLSearchParams(location.search).get('token');
let revision = 0; const buffer = [];
let booted = false;
const es = new EventSource(`/api/events?token=${token}&after=0`);
es.onmessage = (m) => {
  const msg = { revision: Number(m.lastEventId), ...JSON.parse(m.data) };
  if (!booted) { buffer.push(msg); return; }
  applyMessage(msg);                       // revision <= 현재면 무시
};
es.onopen = async () => {
  const snap = await (await fetch(`/api/snapshot?token=${token}`)).json();
  renderSnapshot(snap); revision = snap.revision;
  booted = true;
  for (const m of buffer.splice(0)) applyMessage(m); // snap 이후분만 적용됨
};
es.onerror = () => { booted = false; };     // 재접속 시 onopen이 다시 스냅샷 로드
function applyMessage(m) { if (m.revision <= revision) return; revision = m.revision; render(m); }
```

- [ ] **Step 1:** `dev-drive.js` 작성 — 서버 기동 후 다음 시퀀스 publish: 핸드 시작(4인) → 내 차례(legal 포함 view) → AI 액션 3개+talk → 플랍 → 쇼다운 → coach 노트 → game_over 후 review publish. 각 상태 사이 1.5초 대기.
- [ ] **Step 2:** UI 구현. 액션 바: fold/check/call 버튼 + raise 슬라이더(min=minRaiseTo, max=maxRaiseTo) + 프리셋(최소/½팟/팟/올인 — 팟 프리셋은 `potTotal` 기준 계산, 범위 클램프). `legal.canCheck`면 콜 버튼 숨김, `canRaise:false`면 슬라이더 비활성. `minRaiseTo > maxRaiseTo`인 경우(숏스택 올인만 가능) 슬라이더를 숨기고 '올인(maxRaiseTo)' 버튼만 활성화한다. 액션 전송: `POST /api/action` `{token, decisionId: view.legal.decisionId, action, amount?}` 후 버튼 즉시 비활성(재활성은 다음 view 게시로).
- 리뷰 오버레이는 `view.gameOver && snapshot.review`일 때 `review`를 렌더한다.
- [ ] **Step 3:** 검증: `node server/server.js --game-dir /tmp/holdem-ui --port 8899 --token dev` + `node test/helpers/dev-drive.js` 실행, 브라우저(또는 사용 가능한 브라우저 자동화 도구)로 `http://127.0.0.1:8899/?token=dev` 열어 전 시퀀스 확인: 카드 렌더, 차례 하이라이트, 액션 바 활성/비활성, 로그·코치 탭, 리뷰 오버레이, 새로고침 후 상태 복원. 액션 버튼 클릭 → 서버가 slot에 저장하고 다음 view 게시로 버튼 재활성.
- [ ] **Step 4:** 커밋 `feat: 포커 테이블 웹 UI`.

---

### Task 13: sim-game — 전체 게임 기계 검증 (통합 불변식)

**Files:**
- Create: `test/sim-game.test.js`

**Interfaces:**
- Consumes: 엔진 모듈 직접(cli 아님 — 속도), `legalFor/applyAction/startHand`
- Produces: 엔진 불변식의 기계 검증(칩 보존·종료 보장·음수 금지) — §14 중 '사이드팟·베팅 엣지케이스 전수' 항목의 실전 커버리지
- `startHand(state, {rng})` 옵션을 추가하고(`shuffle(deck, rng)`에 전달), 테스트는 `test/helpers/fixtures.js`의 시드 PRNG(mulberry32 — 아래 코드)를 사용해 3개 시드(1, 2, 3)로 결정적 재현한다.

```js
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// cards.shuffle(deck, rng?)는 rng가 주어지면 crypto 대신 rng() 기반 Fisher-Yates를 쓴다 (Task 1에 반영)
```

- [ ] **Step 1:** 랜덤 정책 봇(합법 액션 중 가중 랜덤: fold 20%/check-call 50%/raise 30%, 금액은 min~max 균등)으로 **게임 종료까지** 자동 진행하는 시뮬레이터 작성. 3개 시드 × (4인, 9인, 헤즈업) 구성.

```js
test('시뮬레이션 불변식', () => {
  for (const seed of [1, 2, 3]) for (const cfg of [{ai:3},{ai:8},{ai:1}]) {
    const rng = mulberry32(seed * 1000 + cfg.ai);
    let st = createGame({ aiCount: cfg.ai, levelEvery: 4 });
    const totalChips = (cfg.ai + 1) * 5000;
    let hands = 0;
    while (!st.gameOver && hands < 500) {
      let r = startHand(st, { rng }); st = r.state; hands++;
      while (!legalFor(st).handOver) {
        const la = legalFor(st);
        st = applyAction(st, la.toAct, ...randomLegal(la)).state;
      }
      assert.equal(st.seats.reduce((a, s) => a + s.stack, 0), totalChips, '칩 보존');
      for (const s of st.seats) assert.ok(s.stack >= 0, '음수 스택 금지');
    }
    assert.ok(st.gameOver, `${hands}핸드 내 종료(블라인드 상승 강제)`);
    assert.ok(['win','lose'].includes(st.result));
  }
});
test('시뮬레이션 후 stats 정합', () => { /* vpip ≤ 1, showdownWins ≤ showdowns, net 총합 0 */ });
```

- [ ] **Step 2:** 실패하는 규칙 버그가 나오면 **해당 태스크의 테스트로 축소 재현**을 먼저 추가하고 고친다(시뮬레이터에서 직접 고치지 않는다).
- [ ] **Step 3:** 전체 스위트 그린 확인 → 커밋 `test: 전체 게임 시뮬레이션 불변식`.

---

### Task 14: start-game 스킬(정본)과 호스트 링크·README

**Files:**
- Create: `.agents/skills/start-game/SKILL.md`
- Create: `.claude/skills/start-game` (심볼릭 링크 → `../../.agents/skills/start-game`)
- Modify: `README.md`

**Interfaces:**
- Consumes: 전체 시스템. SKILL.md는 스펙 §3(게임 루프·재진입), §6(프로토콜·타임아웃), §8(코칭 격리) 절차를 딜러 지침으로 옮긴 문서다.

- [x] **Step 1:** `SKILL.md` 작성 — frontmatter(`name: start-game`, `description: AI 홀덤 게임 시작/재개 — 딜러 오케스트레이션`) + 본문에 다음 절차를 **모두** 포함:
  1. **사전 점검**: `node --version`(≥20), 활성 게임 검사(`game/lock.json` + health), 있으면 사용자에게 resume/새 게임 질문.
  2. **시작**: `node engine/cli.js init --ai <n>` → stdout의 sessionToken 확보 → `nohup node server/server.js --game-dir game --port 8877 --token <t> > game/server.log 2>&1 &` (detached) → health 확인 → `open "http://127.0.0.1:8877/?token=<t>"`.
  3. **에이전트 스폰**: `game/players.json`을 읽고 `playerId`가 `p`로 시작하는 레코드만 대상으로 플레이어마다 명명 에이전트(이름=agentHandle)를 스폰. 스폰 프롬프트 템플릿(전문 포함): 페르소나 카드 전체 + 행동 규약(JSON 한 줄만, decisionId 에코, 캐릭터 유지, talk ≤ 1문장, 스타일 발설 금지).
  4. **게임 루프**: 스펙 §3 의사코드 그대로 + 딜러 규약: public 이벤트만 publish, publishId 단조 증가, AI 워치독(60초 → 재요청 30초 → `apply <pid> --force-default`), 사용자 apply 거부 시 재게시+재대기, 4b 탈출 조건(handOver/gameOver).
  5. **코칭**: 핸드 종료마다 `hand <n> --redacted` + `stats` + 연습 포커스 + coach-meta(과폴드 코멘트 기사용 여부)를 입력으로 **격리된 1회성 코치 서브에이전트**를 호출(전 패를 본 딜러 컨텍스트가 직접 쓰지 않는다), 출력을 `{handNo, text}`로 publish(재진입 시 마지막 coach handNo 확인으로 중복 방지 — 스펙 §14).
  6. **종료**: gameOver 시 2단계 종합 리뷰(①격리 evaluator: redacted 트레이스+통계 → ②종합자: 결과 확인+스타일 공개) 생성 → review는 publish의 `review` 필드로 게시 + `game/review.md` 저장 → 에이전트 작별·정리.
  7. **resume**: `resume-check` → 서버 생존이면 attach, 죽었으면 재기동 → 재진입 체크리스트(§3) → 에이전트 재스폰+브리핑(자기 페르소나, 현재 스택, 진행 상황 요약).
  8. **호스트 어댑테이션 절**: Claude Code=정본(지속 에이전트), Codex/Grok=저하 모드 문서화(스펙 §9 v1 범위 — 구현 아님).
- [x] **Step 2:** 호스트 링크 설치 — ① Claude: `mkdir -p .claude/skills && ln -s ../../.agents/skills/start-game .claude/skills/start-game`. ② Codex: 이 머신의 `~/.codex/` 구성과 로컬 문서에서 프로젝트 스킬 경로를 탐지해 확정되면 링크/포인터를 생성하고, 확정 불가면 **저장소 루트 `AGENTS.md`에 '스킬 정본: `.agents/skills/start-game/SKILL.md`' 포인터 절을 추가**하는 것을 산출물로 한다. ③ Grok: 동일 요령(탐지 → 링크 또는 포인터). ④ 호스트별 **인식 실측**(스킬이 실제로 노출되는지)만 README '구현 후 확인 체크리스트'에 남긴다.
- [x] **Step 3:** `README.md` 완성: 실행 방법(스킬/수동), 테스트 실행, 파일 구조, 구현 후 확인 체크리스트(호스트별 스킬 링크 인식 3항목 + Claude Code 세션 첫 게임 스모크).
- [x] **Step 4:** 전체 테스트 그린 재확인 → 커밋 `feat: start-game 스킬 정본·호스트 링크·README`.

---

## 수용 기준 (전체)

1. `node --test` 전부 그린 (엔진 단위 + 서버 + 시뮬레이션).
2. `dev-drive.js` 시퀀스가 브라우저에서 스펙 §7의 전 요소를 시연.
3. 시뮬레이션 불변식(칩 보존·종료 보장·음수 금지)이 3구성×3시드에서 통과.
4. `game/`은 gitignore, 커밋된 코드에 시크릿·절대경로 없음.
5. 스펙 §11의 모든 테스트 항목이 test/ 어딘가에 실재(누락 시 해당 태스크로 돌아가 보강).

## 부록: 스펙 §11 ↔ 테스트 매핑

| 스펙 §11 항목 | 담당 테스트 파일(및 태스크 번호) |
|---|---|
| 핸드 평가기 | `evaluator.test.js`, T2 |
| 사이드팟 | `sidepots.test.js`, T4 |
| 버튼·블라인드 로테이션 | `hand-setup.test.js`·`cli.test.js`, T5·T10 |
| 베팅 규칙 | `hand-betting.test.js`, T6 |
| 상태 전이 | `hand-showdown.test.js`, T7 |
| 액션 슬롯 | `server.test.js`, T11 |
| expect-version·상태 무변경 | `hand-betting.test.js`·`cli.test.js`, T6·T10 |
| 이벤트 visibility | `views.test.js`, T8 |
| handOver·gameOver | `hand-showdown.test.js`·`cli.test.js`, T7·T10 |
| init 거부·resume·정합 자가검사 | `cli.test.js`, T10 |
| 레벨업 오프바이원 | `hand-setup.test.js`, T5 |
| 서버 스모크·토큰·스냅샷 복원 | `server.test.js`, T11 |
| 코칭 격리 입력 | `views.test.js`, T8 |

Task 14 완료 전 이 표의 모든 행이 실재하는지 확인하는 것이 수용 기준 5의 판정 절차다.

## 명시적 비-태스크 (grok 세션에서 하지 않는 것)

- 실제 LLM 에이전트 스폰·게임 플레이(Claude Code 세션의 몫 — README 체크리스트로 이월)
- Claude Code 심볼릭 링크 인식 검증(동상)
- deep-loop 등 오케스트레이션 플러그인 사용
- Codex/Grok 저하 모드 런타임 구현(스펙 §9 v1 범위 외)
