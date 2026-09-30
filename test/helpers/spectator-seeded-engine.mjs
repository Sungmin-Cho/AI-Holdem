// Browser fixture only: seed the engine CLI's button and shuffle, never tokens.
// Every hand intentionally uses the same shuffle permutation (button rotates).
// Loaded explicitly by the spectator journey, not by production entrypoints.
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
const engine = fileURLToPath(new URL('../../engine/cli.js', import.meta.url));
if (process.argv[1] && path.resolve(process.argv[1]) === engine) {
  let seed = 2;
  const rng = () => {
    seed = (seed + 0x6D2B79F5) >>> 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  crypto.randomInt = (min, max) => {
    if (max === undefined) { max = min; min = 0; }
    // init also shuffles unused persona pools before choosing the button.
    // Pin that command separately so those unrelated draws cannot move the button.
    if (process.argv[2] === 'init') return max - 1;
    return min + Math.floor(rng() * (max - min));
  };
  syncBuiltinESMExports();
}
