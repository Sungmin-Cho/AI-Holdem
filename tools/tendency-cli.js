#!/usr/bin/env node
import fs from 'node:fs';
import {
  POSITIONS,
  STREETS,
  TENDENCY_MIN_HANDS,
  medianOf,
  rateOf,
} from '../training/tendency/contracts.js';
import { traitsFromTendency } from '../training/tendency/traits.js';
import { referenceClaimAllowed } from '../shared/reference.js';
import { collectStoreTendency } from './self-opponents.js';

function fail(code, message) {
  fs.writeSync(2, `${message}\n`);
  process.exit(code === 'USAGE' ? 2 : 1);
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    if (arg === '--json') {
      flags.json = true;
      continue;
    }
    const value = argv[i + 1];
    if (value == null || value.startsWith('--')) fail('USAGE', `${arg}의 값이 필요합니다.`);
    flags[arg.slice(2)] = value;
    i += 1;
  }
  return { flags, positional };
}

function pct(rate) {
  if (rate == null) return '—';
  return `${(rate * 100).toFixed(1)}%`;
}

function counterLine(label, counter) {
  return `${label}  ${pct(rateOf(counter))}  n=${counter?.n ?? 0}`;
}

function fcrLine(label, counter) {
  const n = counter?.n ?? 0;
  const fold = n ? counter.fold / n : null;
  const call = n ? counter.call / n : null;
  const raise = n ? counter.raise / n : null;
  return `${label}  접기 ${pct(fold)} / 콜 ${pct(call)} / 레이즈 ${pct(raise)}  n=${n}`;
}

function indicatorsOf(t) {
  return {
    vpip: { rate: rateOf(t.preflop.vpip), n: t.preflop.vpip.n, k: t.preflop.vpip.k },
    pfr: { rate: rateOf(t.preflop.pfr), n: t.preflop.pfr.n, k: t.preflop.pfr.k },
    limp: { rate: rateOf(t.preflop.limp), n: t.preflop.limp.n, k: t.preflop.limp.k },
    vsRaise: {
      n: t.preflop.vsRaise.n,
      fold: t.preflop.vsRaise.n ? t.preflop.vsRaise.fold / t.preflop.vsRaise.n : null,
      call: t.preflop.vsRaise.n ? t.preflop.vsRaise.call / t.preflop.vsRaise.n : null,
      raise: t.preflop.vsRaise.n ? t.preflop.vsRaise.raise / t.preflop.vsRaise.n : null,
    },
    vs3Bet: {
      n: t.preflop.vs3Bet.n,
      fold: t.preflop.vs3Bet.n ? t.preflop.vs3Bet.fold / t.preflop.vs3Bet.n : null,
      call: t.preflop.vs3Bet.n ? t.preflop.vs3Bet.call / t.preflop.vs3Bet.n : null,
      raise: t.preflop.vs3Bet.n ? t.preflop.vs3Bet.raise / t.preflop.vs3Bet.n : null,
    },
    cbet: { rate: rateOf(t.postflop.cbet), n: t.postflop.cbet.n, k: t.postflop.cbet.k },
    wtsd: { rate: rateOf(t.postflop.wtsd), n: t.postflop.wtsd.n, k: t.postflop.wtsd.k },
    wsd: { rate: rateOf(t.postflop.wsd), n: t.postflop.wsd.n, k: t.postflop.wsd.k },
    bluff: { rate: rateOf(t.postflop.bluff), n: t.postflop.bluff.n, k: t.postflop.bluff.k },
    openSizeBb: { median: medianOf(t.preflop.openSizeBb.buckets), n: t.preflop.openSizeBb.n },
  };
}

function formatShow(result) {
  const t = result.tendency;
  const traits = traitsFromTendency(t);
  const eligible = t.hands >= TENDENCY_MIN_HANDS;
  const lines = [
    `누적 ${t.hands}핸드 · ${result.sources.length}세션`,
    `최소 표본(${TENDENCY_MIN_HANDS}핸드): ${t.hands >= TENDENCY_MIN_HANDS ? '충족' : '미달'}`,
    `복제 가능 여부: ${eligible ? '가능' : '불가'} (${t.hands}핸드 / 필요 ${TENDENCY_MIN_HANDS}핸드)`,
    `트레이트 투영  tightness ${traits.tightness.toFixed(2)} · aggression ${traits.aggression.toFixed(2)} · calling ${traits.calling.toFixed(2)} · bluff ${traits.bluff.toFixed(2)}`,
    '지표 (비율, n) — 관측 빈도이며 실력·수익의 증명이 아닙니다.',
    counterLine('자발적 참여(VPIP)', t.preflop.vpip),
    counterLine('프리플롭 레이즈(PFR)', t.preflop.pfr),
    counterLine('림프', t.preflop.limp),
    fcrLine('레이즈에 대응(vsRaise)', t.preflop.vsRaise),
    fcrLine('3-bet에 대응(vs3Bet)', t.preflop.vs3Bet),
    counterLine('c-bet', t.postflop.cbet),
    counterLine('쇼다운 진출(WTSD)', t.postflop.wtsd),
    counterLine('쇼다운 승(WSD)', t.postflop.wsd),
    `오픈 사이즈(bb)  중앙값 ${medianOf(t.preflop.openSizeBb.buckets) ?? '—'}  n=${t.preflop.openSizeBb.n}`,
  ];
  for (const pos of POSITIONS) {
    const block = t.preflop.byPosition[pos];
    lines.push(`포지션 ${pos}  오픈 ${pct(rateOf(block.rfi))}  n=${block.rfi.n}  참여 ${pct(rateOf(block.vpip))}  n=${block.dealt}`);
  }
  for (const street of STREETS) {
    const block = t.postflop.byStreet[street];
    lines.push(fcrLine(`${street} 베팅에 대응`, block.facingBet));
  }
  return `${lines.join('\n')}\n`;
}

function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const command = positional[0];
  const storeDir = flags['store-dir'];
  if (!storeDir) fail('USAGE', '--store-dir가 필요합니다.');
  if (command !== 'show' && command !== 'check') fail('USAGE', 'show 또는 check가 필요합니다.');
  const result = collectStoreTendency(storeDir);
  if (command === 'check') {
    const hands = result.tendency.hands;
    fs.writeSync(1, `${hands}/${TENDENCY_MIN_HANDS}\n`);
    process.exit(hands >= TENDENCY_MIN_HANDS ? 0 : 1);
  }
  if (flags.json) {
    const payload = {
      ok: true,
      schemaVersion: 1,
      hands: result.tendency.hands,
      sessions: result.sources.length,
      minHands: TENDENCY_MIN_HANDS,
      minHandsMet: result.tendency.hands >= TENDENCY_MIN_HANDS,
      skippedSessions: result.skippedSessions,
      skippedHands: result.skippedHands,
      indicators: indicatorsOf(result.tendency),
      traitProjection: traitsFromTendency(result.tendency),
      mirrorEligible: result.tendency.hands >= TENDENCY_MIN_HANDS,
      seatMix: result.tendency.seatMix,
      sources: result.sources,
    };
    fs.writeSync(1, `${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  const text = formatShow(result);
  if (!referenceClaimAllowed(text)) {
    fail('REFERENCE_CLAIM', '출력 문구가 참조 주장을 포함합니다.');
  }
  fs.writeSync(1, text);
}

main();
