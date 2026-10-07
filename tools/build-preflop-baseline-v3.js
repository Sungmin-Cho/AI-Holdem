// Builds training/data/preflop-baseline-v3.json (schema 3) from the shared v3
// chart construction. `--check` verifies the committed bytes and digest;
// `--dump <spotKey>` prints one spot as a 13x13 grid for human review.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HAND_CLASSES } from '../shared/poker-eval.js';
import { SIZES_V3, UNITS, buildChartsV3, chartForKey } from '../training/ranges/charts-v3.js';

export const METHOD_V3 = 'Original heuristic approximation: authored raise-first-in charts, equity-based facing-open and facing-3-bet construction with soft boundary mixing, and a chip-EV push/fold fictitious-play approximation (no antes, no ICM, single caller). Not solver output and not copied from a commercial chart.';

export function buildBaselineV3() {
  const { charts, spots, stacksBb } = buildChartsV3();
  return { schemaVersion: 3, id: 'local-preflop-baseline', version: '3.0.0', license: 'Apache-2.0', recipeVersion: 'original-v3.0.0',
    methodology: METHOD_V3, handOrder: [...HAND_CLASSES], units: UNITS,
    tree: { openBb: SIZES_V3.openBb, threeBetBb: SIZES_V3.threeBetBb, fourBetBb: SIZES_V3.fourBetBb, pushFoldStacksBb: stacksBb },
    charts, spots };
}

export function dumpSpotV3(key) {
  const { raise, call } = chartForKey(key);
  const ranks = 'AKQJT98765432';
  const lines = [`${key}  (r=raise/push %, c=call %)`];
  for (let i = 0; i < 13; i += 1) {
    const cells = [];
    for (let j = 0; j < 13; j += 1) {
      const cls = i === j ? ranks[i] + ranks[j] : i < j ? `${ranks[i]}${ranks[j]}s` : `${ranks[j]}${ranks[i]}o`;
      const k = HAND_CLASSES.indexOf(cls);
      const r = Math.round(raise[k] * 100);
      const c = Math.round(call[k] * 100);
      cells.push(`${cls.padEnd(3)} ${r ? `r${r}` : ''}${c ? `c${c}` : ''}`.padEnd(13));
    }
    lines.push(cells.join(''));
  }
  return lines.join('\n');
}

function main(argv) {
  const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../training/data/preflop-baseline-v3.json');
  if (argv[0] === '--dump') {
    process.stdout.write(`${dumpSpotV3(argv[1])}\n`);
    return;
  }
  const check = argv.includes('--check');
  if (argv.some(arg => arg !== '--check')) throw new Error(`unknown argument: ${argv.find(arg => arg !== '--check')}`);
  const body = `${JSON.stringify(buildBaselineV3())}\n`;
  const digest = createHash('sha256').update(body).digest('hex');
  const pin = out.replace(/\.json$/, '.sha256');
  if (check) {
    if (fs.readFileSync(out, 'utf8') !== body || fs.readFileSync(pin, 'utf8').trim() !== digest) throw new Error('v3 baseline bytes or digest differ');
  } else {
    fs.writeFileSync(out, body);
    fs.writeFileSync(pin, `${digest}\n`);
  }
  process.stdout.write(`${JSON.stringify({ version: 3, digest, check })}\n`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
