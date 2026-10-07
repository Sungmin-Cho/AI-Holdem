// Authored raise-first-in charts for reference v3 (100bb, 2.5bb open, raise or
// fold). Original approximations written from widely published opening-range
// shapes; not copied from a commercial solver or chart. A chart depends on how
// many players still act behind the opener, so 9-handed LJ and 6-handed UTG share
// one chart. Mixed frequencies mark boundary hands.
import { HAND_CLASSES, comboCount } from '../../shared/poker-eval.js';

const RANKS = 'AKQJT98765432';

export const RFI_TEXT_V3 = Object.freeze({
  8: '77+ 66:0.5 55:0.25 ATs+ A5s:0.5 KTs+ QTs+ JTs AJo+ KQo',
  7: '66+ 55:0.5 44:0.25 A9s+ A5s A4s:0.5 KTs+ QTs+ JTs T9s:0.5 AJo+ ATo:0.5 KQo KJo:0.5',
  6: '66+ 55:0.5 44:0.25 A8s+ A5s-A4s A3s:0.25 K9s+ Q9s+ J9s+ T9s 98s:0.25 ATo+ KJo+ QJo:0.25',
  5: '66+ 55:0.5 44-22:0.25 A2s+ K9s+ Q9s+ J9s+ T9s T8s:0.5 98s:0.5 87s:0.25 76s:0.25 ATo+ KJo+ KTo:0.25 QJo:0.25',
  4: '55+ 44-22:0.5 A2s+ K8s+ K7s:0.5 Q9s+ Q8s:0.25 J9s+ T8s+ 98s 87s:0.5 76s:0.5 65s:0.5 A9o+ KTo+ QJo QTo:0.5 JTo:0.25',
  3: '22+ A2s+ K6s+ K5s:0.5 Q8s+ J8s+ T8s+ 97s+ 87s 76s 65s 54s:0.5 A8o+ A5o:0.5 A7o:0.25 KTo+ K9o:0.25 QTo+ JTo T9o:0.25',
  2: '22+ A2s+ K2s+ Q5s+ Q4s-Q2s:0.5 J7s+ J6s:0.5 T7s+ 96s+ 86s+ 75s+ 64s+ 54s 53s:0.5 43s:0.5 A2o+ K8o+ K7o:0.5 Q9o+ Q8o:0.5 J9o+ J8o:0.25 T8o+ 98o 87o:0.5',
  1: '22+ A2s+ K2s+ Q6s+ Q5s:0.5 J7s+ T7s+ 96s+ 86s+ 75s+ 65s 54s A2o+ K8o+ Q9o+ J9o+ T9o 98o:0.5',
  // Heads-up small blind (also the button): raise or fold, very wide.
  hu: '22+ A2s+ K2s+ Q2s+ J2s+ T2s+ 92s+ 82s+ 72s+ 62s+ 52s+ 42s+ 32s A2o+ K2o+ Q2o+ J4o+ J3o:0.5 T5o+ T4o:0.5 95o+ 85o+ 75o+ 64o+ 54o 53o:0.5',
});

function expandToken(token) {
  let m;
  if ((m = /^([AKQJT2-9])\1\+$/.exec(token))) return [...RANKS.slice(0, RANKS.indexOf(m[1]) + 1)].map(r => r + r);
  if ((m = /^([AKQJT2-9])\1-([AKQJT2-9])\2$/.exec(token))) {
    const [a, b] = [RANKS.indexOf(m[1]), RANKS.indexOf(m[2])].sort((x, y) => x - y);
    return [...RANKS.slice(a, b + 1)].map(r => r + r);
  }
  if ((m = /^([AKQJT2-9])\1$/.exec(token))) return [token];
  if ((m = /^([AKQJT2-9])([AKQJT2-9])([so])\+$/.exec(token))) {
    const out = [];
    for (let k = RANKS.indexOf(m[1]) + 1; k <= RANKS.indexOf(m[2]); k += 1) out.push(m[1] + RANKS[k] + m[3]);
    return out;
  }
  if ((m = /^([AKQJT2-9])([AKQJT2-9])([so])-\1([AKQJT2-9])\3$/.exec(token))) {
    const [a, b] = [RANKS.indexOf(m[2]), RANKS.indexOf(m[4])].sort((x, y) => x - y);
    const out = [];
    for (let k = a; k <= b; k += 1) out.push(m[1] + RANKS[k] + m[3]);
    return out;
  }
  if ((m = /^([AKQJT2-9])([AKQJT2-9])([so])$/.exec(token))) return [token];
  throw new Error(`bad range token ${token}`);
}

// Range notation ("22+ A2s+ KTo:0.5 ...") to a dense 169-entry frequency array.
export function parseRange(text) {
  const freq = new Float64Array(169);
  for (const raw of text.split(/\s+/).filter(Boolean)) {
    const m = /^(.*):([0-9.]+)$/.exec(raw);
    const value = m ? Number(m[2]) : 1;
    for (const cls of expandToken(m ? m[1] : raw)) {
      const index = HAND_CLASSES.indexOf(cls);
      if (index < 0) throw new Error(`bad hand class ${cls}`);
      freq[index] = Math.max(freq[index], value);
    }
  }
  return freq;
}

export function rangePercent(freq) {
  let combos = 0;
  for (let i = 0; i < 169; i += 1) combos += freq[i] * comboCount(HAND_CLASSES[i]);
  return (100 * combos) / 1326;
}

// RFI chart for a seat with `behind` players left to act (heads-up uses `hu`).
export function rfiRangeV3(seated, behind) {
  return parseRange(seated === 2 ? RFI_TEXT_V3.hu : RFI_TEXT_V3[behind]);
}
