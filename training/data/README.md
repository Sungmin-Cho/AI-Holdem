# Preflop baseline v1

`preflop-baseline-v1.json` is an original **frequency-only** 6-max 100BB sketch.

- License: Apache-2.0 (same as this repository)
- Provider id: `local-preflop-baseline` @ `1.0.0`
- Tree: RFI 2.5bb, 3-bet 8.5bb
- EV fields are omitted. Evaluators must keep `evBb` / `bestEvBb` / `evLossBb` null.
- Methodology: written from public general-principle opening-range shape (pairs, Broadway, suited connectors widen by position). **Not** copied from a commercial solver, GTO Wizard export, or proprietary chart.

Digest: `preflop-baseline-v1.sha256` (one hex line). Loaders must pass it as `expectedSha256`.

Rebuild:

```bash
node tools/build-preflop-baseline.js --version 1
```

Unsupported on purpose: postflop, stacks other than 100bb, multiway, 4-bet+, ante, ICM.


## Baseline v2

`preflop-baseline-v2.json` is an original frequency-only extension, schema 2,
provider `local-preflop-baseline@2.0.0`, Apache-2.0. Its bundled `.sha256` and
`shared/reference.js` pin the exact bytes. V1 bytes and hash are unchanged.

The 99 native contexts contain all 169 hand classes: 20 unopened RFI contexts
and 79 ordered hero/opener pairs across 6, 8 and 9 seats. Keys include table size,
hero and opener; the closed key catalog plus global capabilities defines native
metadata without duplicating it on every row. All EV values are null.

Recipe (`original-v2.0.0`): 6-seat RFI retains v1 frequencies. Early-position RFI
uses v1 UTG multiplied by 0.65/0.80/1.00 for 8-seat UTG/UTG1/LJ and
0.50/0.65/0.80/1.00 for 9-seat UTG/UTG1/UTG2/LJ. AA/KK/QQ/AKs/AKo retain
raise frequency 1 in these early positions. Other positions use their v1 recipe.
Vs-open raise and call start from the v1 vector, multiplied by opener factors:
UTG .60, UTG1 .65, UTG2 .70, LJ .75, HJ .85, CO .95, BTN 1.10, SB 1.20.
Call receives an additional .85 multiplier when hero is out of position.
AA/KK/QQ always raise. If raise+call exceeds 1, normalize those two proportionally;
otherwise the remainder folds. Largest-remainder allocation uses 10,000 units,
ties ordered raise, call, fold; zero-frequency rows are omitted.

Cash-training only. Native stack 100BB, open 2.5BB and 3-bet 8.5BB. Integer-chip
size representation allows ±0.05BB. Stack 80–120BB, open 2–3BB and chosen 3-bet
6.5–10.5BB are projected reference only: no grade or metric eligibility. Unequal
active stacks, unsupported seat counts/modes, callers, reopened trees and postflop
remain unsupported. These coefficients and projection bounds are engineering
choices, not evidence of GTO correctness, profitability or learning effectiveness.

```sh
node tools/build-preflop-baseline.js --version 2
node tools/build-preflop-baseline.js --check
node tools/build-preflop-baseline.js --version 1 --check
```
