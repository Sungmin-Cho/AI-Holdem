# Task 1 Report: cards.js — 덱과 셔플

## 구현

- `engine/cards.js`를 추가했다.
- `RANKS`와 `SUITS`를 export하고, rank-우선 고정 순서로 52장 덱을 생성한다.
- `shuffle(deck, rng?)`는 입력 배열을 복사한 뒤 Fisher–Yates를 수행한다. `rng`가 없으면 `node:crypto`의 `randomInt`를 사용하고, 있으면 브리프에 지정된 `Math.floor(rng() * (i + 1))`를 사용한다.
- `rankValue(card)`는 카드 첫 글자를 기준으로 2–14 값을 반환한다.
- 브리프에 지정된 세 테스트를 `test/cards.test.js`에 그대로 추가했다.

## TDD Evidence

### RED

Command:

```text
node --test test/cards.test.js
```

Failing output:

```text
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/sungmin/Dev/AI-Holdem/engine/cards.js' imported from /Users/sungmin/Dev/AI-Holdem/test/cards.test.js
    at finalizeResolution (node:internal/modules/esm/resolve:271:11)
...
✖ test/cards.test.js (52.109375ms)
ℹ tests 1
ℹ pass 0
ℹ fail 1
```

Expected because the test was run before production code existed, and `engine/cards.js` was intentionally missing at the RED step.

### GREEN

Focused command:

```text
node --test test/cards.test.js
```

Passing output:

```text
✔ 덱은 52장 전부 유일 (0.833583ms)
✔ 셔플은 순열이며 원본을 훼손하지 않는다 (3.327333ms)
✔ rankValue (0.046042ms)
ℹ tests 3
ℹ pass 3
ℹ fail 0
```

Full suite command (no directory argument):

```text
node --test
```

Passing output:

```text
✔ 덱은 52장 전부 유일 (0.510291ms)
✔ 셔플은 순열이며 원본을 훼손하지 않는다 (0.6815ms)
✔ rankValue (0.044042ms)
ℹ tests 3
ℹ pass 3
ℹ fail 0
```

## Self-review

- The deck contains all rank/suit combinations exactly once and preserves a deterministic order.
- Shuffle copies the input, returns a permutation, and follows the required injected-RNG index formula.
- The default shuffle path uses `crypto.randomInt` and has no network, timer, file I/O, or LLM behavior.
- No evaluator, hand, or CLI code was added.
- `git diff --check` passed.

## Commit

Will be recorded after this report and the final verification:

`feat: 카드 덱과 crypto 셔플`
