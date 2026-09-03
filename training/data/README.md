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
node tools/build-preflop-baseline.js
```

Unsupported on purpose: postflop, stacks other than 100bb, multiway, 4-bet+, ante, ICM.
