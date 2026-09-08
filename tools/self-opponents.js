import { randomInt } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../engine/state.js';
import {
  POSITIONS,
  TENDENCY_MIN_HANDS,
  TENDENCY_MIN_N,
  emptyTendency,
  medianOf,
  mergeTendency,
  rateOf,
} from '../training/tendency/contracts.js';
import { SIMILARITY_MIN_COMPONENTS, tendencySimilarity } from '../training/tendency/compare.js';
import { tendencyFromRecords } from '../training/tendency/extract.js';
import { buildExploiterConfig, buildMirrorConfig, VERSION_V2 } from '../training/policies/catalog.js';
import { writeDerivedPolicyConfigs } from './policy-player.js';
import { openContained, writeContained } from './training-store.js';

const STATE_MAX_BYTES = 4 * 1024 * 1024;
const HAND_MAX_BYTES = 1 * 1024 * 1024;
const LOOP_MAX_BYTES = 1 * 1024 * 1024;
const MARKER_MAX_BYTES = 4096;
const HAND_FILE_RE = /^hand-.*\.json$/;
const MARKER_FILE = '.self-opponents.json';
const TARGET_LABELS = Object.freeze({
  'over-folds-vs-bet': '베팅에 자주 접음',
  'calls-too-wide': '베팅에 너무 넓게 콜',
  'over-raises': '너무 자주 레이즈',
  underbluffs: '블러프가 적음',
  'limps-often': '림프가 잦음',
  'over-folds-vs-3bet': '3벳에 자주 접음',
});

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function readJson(root, segments, maxBytes) {
  const buf = openContained(root, segments, { maxBytes });
  return JSON.parse(buf.toString('utf8'));
}

function scanSessions(storeDir) {
  const sessionsRoot = path.join(storeDir, '.session-store', 'sessions');
  let entries;
  try {
    entries = fs.readdirSync(sessionsRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return { eligible: [], skippedSessions: 0 };
    throw error;
  }
  const eligible = [];
  let skippedSessions = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const sessionDir = path.join(sessionsRoot, entry.name);
    try {
      const state = readJson(sessionDir, ['state.json'], STATE_MAX_BYTES);
      if (state?.gameOver !== true) {
        skippedSessions += 1;
        continue;
      }
      let opponentRuntime = state.policySeed ? 'policy' : 'llm';
      try {
        const loop = readJson(sessionDir, ['loop-state.json'], LOOP_MAX_BYTES);
        if (loop?.opponentRuntime === 'policy' || loop?.opponentRuntime === 'llm') {
          opponentRuntime = loop.opponentRuntime;
        }
      } catch {
        /* loop-state is optional for archive-only sessions */
      }
      eligible.push({
        gameId: entry.name,
        sessionDir,
        mode: state.config?.mode === 'cash-training' ? 'cash-training' : 'tournament',
        opponentRuntime,
        seats: Array.isArray(state.seats) ? state.seats.length : 0,
      });
    } catch {
      skippedSessions += 1;
    }
  }
  return { eligible, skippedSessions };
}

export function listGameOverSessions(storeDir) {
  return scanSessions(storeDir).eligible;
}

export function collectStoreTendency(storeDir) {
  const { eligible, skippedSessions } = scanSessions(storeDir);
  let tendency = emptyTendency('user');
  let skippedHands = 0;
  const sources = [];
  for (const session of eligible) {
    let files = [];
    try {
      files = fs.readdirSync(path.join(session.sessionDir, 'hands'))
        .filter((name) => HAND_FILE_RE.test(name))
        .sort();
    } catch {
      files = [];
    }
    const records = [];
    for (const name of files) {
      try {
        records.push(readJson(session.sessionDir, ['hands', name], HAND_MAX_BYTES));
      } catch {
        skippedHands += 1;
      }
    }
    const source = {
      gameId: session.gameId,
      hands: records.length,
      mode: session.mode,
      opponentRuntime: session.opponentRuntime,
      seats: session.seats,
    };
    sources.push(source);
    tendency = mergeTendency(
      tendency,
      tendencyFromRecords(records, 'user', { sources: [source] }),
    );
  }
  return { tendency, sources, skippedSessions, skippedHands };
}

export function requireStoreTendency(storeDir) {
  let collected;
  try {
    collected = collectStoreTendency(storeDir);
  } catch (error) {
    if (error.code === 'TENDENCY_INSUFFICIENT' || error.code === 'TENDENCY_SOURCE_UNREADABLE') {
      throw error;
    }
    coded(
      'TENDENCY_SOURCE_UNREADABLE',
      `store 성향 출처를 읽을 수 없습니다 (${error.code ?? 'ERROR'}).`,
    );
  }
  const hands = collected?.tendency?.hands ?? 0;
  if (hands < TENDENCY_MIN_HANDS) {
    coded(
      'TENDENCY_INSUFFICIENT',
      `누적 ${hands}핸드 / 필요 ${TENDENCY_MIN_HANDS}핸드 — node tools/tendency-cli.js show --store-dir game`,
    );
  }
  return collected;
}

export function writeSelfOpponentsMarker(stagingDir, { requested, sourceHands, sourceSessions }) {
  writeContained(
    stagingDir,
    [MARKER_FILE],
    Buffer.from(JSON.stringify({
      schemaVersion: 1,
      requested: { mirror: !!requested?.mirror, exploiter: !!requested?.exploiter },
      sourceHands: sourceHands ?? 0,
      sourceSessions: sourceSessions ?? 0,
    })),
    { mode: 'create' },
  );
}

export function readSelfOpponentsMarker(root) {
  let buf;
  try {
    buf = openContained(root, [MARKER_FILE], { maxBytes: MARKER_MAX_BYTES });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    coded('SELF_OPPONENT_MARKER_CORRUPT', 'self-opponent marker를 읽을 수 없습니다.');
  }
  let parsed;
  try {
    parsed = JSON.parse(buf.toString('utf8'));
  } catch {
    coded('SELF_OPPONENT_MARKER_CORRUPT', 'self-opponent marker가 JSON이 아닙니다.');
  }
  if (
    parsed?.schemaVersion !== 1
    || parsed.requested == null
    || typeof parsed.requested !== 'object'
    || Array.isArray(parsed.requested)
  ) {
    coded('SELF_OPPONENT_MARKER_CORRUPT', 'self-opponent marker schema가 올바르지 않습니다.');
  }
  return parsed;
}

function sourceFrom(tendency, sources) {
  return {
    hands: tendency?.hands ?? 0,
    decisions: tendency?.decisions ?? 0,
    sessions: Array.isArray(sources) ? sources.length : 0,
    extractedAt: new Date().toISOString(),
  };
}

function pickIndex(count, chooseSeat) {
  const pick = chooseSeat ?? ((n) => randomInt(n));
  const index = pick(count);
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    coded('SELF_OPPONENT_INCOMPLETE', 'self-opponent 좌석 선택이 올바르지 않습니다.');
  }
  return index;
}

function applyDerivedSeat(player, config, archetype) {
  player.archetype = archetype;
  player.policy = {
    policyId: config.policyId,
    policyVersion: config.policyVersion,
    configDigest: config.configDigest,
  };
}

export function assignSelfOpponents({
  root,
  players,
  tendency,
  sources = [],
  requested = {},
  chooseSeat,
} = {}) {
  const next = (players ?? []).map((row) => ({
    ...row,
    policy: row.policy && typeof row.policy === 'object' ? { ...row.policy } : row.policy,
  }));
  const ai = next.filter((row) => row.playerId !== 'user');
  const remaining = [...ai];
  const configs = {};
  const assigned = { mirror: false, exploiter: false };
  const source = sourceFrom(tendency, sources);
  let targets = [];

  if (requested.mirror) {
    if (remaining.length < 1) coded('SELF_OPPONENT_INCOMPLETE', '복제 좌석을 배정할 AI가 없습니다.');
    const seat = remaining.splice(pickIndex(remaining.length, chooseSeat), 1)[0];
    const config = buildMirrorConfig(tendency, { source, strategyVersion: VERSION_V2 });
    applyDerivedSeat(seat, config, 'SelfMirror');
    configs[config.configDigest] = config;
    assigned.mirror = true;
  }
  if (requested.exploiter) {
    if (remaining.length < 1) coded('SELF_OPPONENT_INCOMPLETE', '공략 좌석을 배정할 AI가 없습니다.');
    const seat = remaining.splice(pickIndex(remaining.length, chooseSeat), 1)[0];
    const config = buildExploiterConfig(tendency, { source, strategyVersion: VERSION_V2 });
    applyDerivedSeat(seat, config, 'SelfExploiter');
    configs[config.configDigest] = config;
    assigned.exploiter = true;
    targets = config.params?.targets ?? [];
  }

  writeDerivedPolicyConfigs(root, configs);
  writeJsonAtomic(path.join(root, 'players.json'), next);
  return { assigned, players: next, targets, configs };
}

function hasDerivedTriple(players, policyId, archetype) {
  return (players ?? []).some((row) => (
    row.playerId !== 'user'
    && row.archetype === archetype
    && row.policy?.policyId === policyId
    && typeof row.policy?.policyVersion === 'string'
    && typeof row.policy?.configDigest === 'string'
  ));
}

function loopRequested(root) {
  try {
    const loop = readJson(root, ['loop-state.json'], LOOP_MAX_BYTES);
    const requested = loop?.selfOpponents?.requested;
    if (!requested || typeof requested !== 'object') return null;
    return { mirror: !!requested.mirror, exploiter: !!requested.exploiter };
  } catch {
    return null;
  }
}

export function assertSelfOpponentsConsistent({ root, players }) {
  const marker = readSelfOpponentsMarker(root);
  let requested = marker?.requested
    ? { mirror: !!marker.requested.mirror, exploiter: !!marker.requested.exploiter }
    : null;
  if (!requested || (!requested.mirror && !requested.exploiter)) {
    requested = loopRequested(root);
  }
  if (!requested || (!requested.mirror && !requested.exploiter)) return;
  if (requested.mirror && !hasDerivedTriple(players, 'self-mirror-v1', 'SelfMirror')) {
    coded('SELF_OPPONENT_INCOMPLETE', '자기 복제 좌석이 없습니다. 이 세션은 재개하지 말고 새 게임을 시작하세요.');
  }
  if (requested.exploiter && !hasDerivedTriple(players, 'self-exploiter-v1', 'SelfExploiter')) {
    coded('SELF_OPPONENT_INCOMPLETE', '자기 공략 좌석이 없습니다. 이 세션은 재개하지 말고 새 게임을 시작하세요.');
  }
}

export function selfOpponentNotices({ assigned, sources = [], targets = [] } = {}) {
  const hands = sources.reduce((sum, row) => sum + (row.hands ?? 0), 0);
  const sessions = sources.length;
  const notices = [];
  if (assigned?.mirror) {
    notices.push(
      `자기 복제 좌석 1석을 배정했습니다 (출처 누적 ${hands}핸드·${sessions}세션). 어느 좌석인지는 종합 리뷰에서 공개됩니다.`,
    );
  }
  if (assigned?.exploiter) {
    notices.push(
      `자기 공략 좌석 1석을 배정했습니다 (겨냥한 경향 ${targets.length}가지 — 종합 리뷰에서 공개).`,
    );
  }
  return notices;
}

export function loadSessionHandRecords(root) {
  let names = [];
  try {
    names = fs.readdirSync(path.join(root, 'hands')).filter((name) => HAND_FILE_RE.test(name)).sort();
  } catch {
    return [];
  }
  const records = [];
  for (const name of names) {
    try {
      records.push(readJson(root, ['hands', name], HAND_MAX_BYTES));
    } catch {
      /* skip unreadable hands */
    }
  }
  return records;
}

function findSeat(players, policyId, archetype) {
  return (players ?? []).find((row) => (
    row.policy?.policyId === policyId || row.archetype === archetype
  ));
}

function configOf(player, derived) {
  const digest = player?.policy?.configDigest;
  if (!digest) coded('SELF_OPPONENT_INCOMPLETE', '파생 정책 digest가 없습니다.');
  const config = derived?.[digest];
  if (!config) coded('POLICY_CONFIG_MISMATCH', '파생 정책 config를 찾을 수 없습니다.');
  return config;
}

function pooledFacing(tendency) {
  let n = 0;
  let fold = 0;
  let call = 0;
  let raise = 0;
  for (const street of ['flop', 'turn', 'river']) {
    const row = tendency?.postflop?.byStreet?.[street]?.facingBet;
    if (!row) continue;
    n += row.n ?? 0;
    fold += row.fold ?? 0;
    call += row.call ?? 0;
    raise += row.raise ?? 0;
  }
  return { n, fold, call, raise };
}

function pooledBet(tendency) {
  const buckets = {};
  let n = 0;
  for (const street of ['flop', 'turn', 'river']) {
    const hist = tendency?.postflop?.byStreet?.[street]?.betSizePot;
    if (!hist) continue;
    n += hist.n ?? 0;
    for (const [key, count] of Object.entries(hist.buckets ?? {})) {
      buckets[key] = (buckets[key] ?? 0) + count;
    }
  }
  return { n, median: medianOf(buckets) };
}

function percentCell(counter) {
  if (!counter || !Number.isInteger(counter.n) || counter.n < TENDENCY_MIN_N) return '—';
  const rate = rateOf(counter);
  if (rate == null) return '—';
  return `${Math.round(rate * 100)}% (n=${counter.n})`;
}

function shareCell(row, key) {
  if (!row || !Number.isInteger(row.n) || row.n < TENDENCY_MIN_N) return '—';
  return `${Math.round((100 * (row[key] ?? 0)) / row.n)}% (n=${row.n})`;
}

function afCell(tendency) {
  const af = tendency?.postflop?.af ?? { bets: 0, raises: 0, calls: 0 };
  const n = (af.bets ?? 0) + (af.raises ?? 0) + (af.calls ?? 0);
  if (n < TENDENCY_MIN_N) return '—';
  const value = (af.calls ?? 0) === 0
    ? (af.bets + af.raises > 0 ? Infinity : 0)
    : (af.bets + af.raises) / af.calls;
  const shown = Number.isFinite(value) ? value.toFixed(1) : '∞';
  return `${shown} (n=${n})`;
}

function sizeCell(n, median, digits = 1) {
  if (!Number.isInteger(n) || n < TENDENCY_MIN_N || median == null) return '—';
  return `${Number(median).toFixed(digits)} (n=${n})`;
}

function priorPreflop(actions, index) {
  let raises = 0;
  let calls = 0;
  for (let i = 0; i < index; i += 1) {
    const row = actions[i];
    if (row?.street !== 'preflop') continue;
    if (row.action === 'raise') raises += 1;
    else if (row.action === 'call') calls += 1;
  }
  return { raises, calls };
}

function decisiveLine(records, replicaId, cumulative) {
  let best = null;
  let bestAmount = -1;
  for (const record of records ?? []) {
    const pots = Array.isArray(record?.pots) ? record.pots : [];
    if (!pots.some((pot) => Array.isArray(pot?.eligible) && pot.eligible.includes(replicaId))) continue;
    const amount = pots.reduce((sum, pot) => sum + (Number(pot.amount) || 0), 0);
    if (amount > bestAmount) {
      bestAmount = amount;
      best = record;
    }
  }
  if (!best) return null;
  const actions = Array.isArray(best.actions) ? best.actions : [];
  const index = actions.findIndex((row) => row?.playerId === replicaId && row.street === 'preflop');
  const action = index >= 0 ? actions[index] : null;
  const chosen = action?.action ?? '참여';
  let freq = null;
  if (action) {
    const { raises, calls } = priorPreflop(actions, index);
    if (raises === 0 && calls === 0) {
      const rfi = cumulative?.preflop?.byPosition?.BTN?.rfi
        ?? cumulative?.preflop?.pfr;
      if (rfi?.n >= TENDENCY_MIN_N) freq = rateOf(rfi);
    } else if (raises === 1 && calls === 0) {
      const vs = cumulative?.preflop?.vsRaise;
      if (vs?.n >= TENDENCY_MIN_N) {
        const key = chosen === 'raise' ? 'raise' : chosen === 'call' ? 'call' : 'fold';
        freq = vs[key] / vs.n;
      }
    }
  }
  const freqText = freq == null ? '표본이 부족해 빈도를 표시하지 않습니다' : `${Math.round(freq * 100)}%로 같은 선택을 했습니다`;
  return `결정적 핸드: 복제 좌석이 핸드 ${best.handNo}에서 ${chosen} — 누적 기록에서 같은 국면의 나는 ${freqText}.`;
}

function metricRows(cumulative, sessionUser, sessionReplica) {
  const userFacing = pooledFacing(sessionUser);
  const replicaFacing = pooledFacing(sessionReplica);
  const cumFacing = pooledFacing(cumulative);
  const rows = [
    ['자발적 참여(VPIP)', percentCell(cumulative.preflop.vpip), percentCell(sessionUser.preflop.vpip), percentCell(sessionReplica.preflop.vpip)],
    ['프리플롭 레이즈(PFR)', percentCell(cumulative.preflop.pfr), percentCell(sessionUser.preflop.pfr), percentCell(sessionReplica.preflop.pfr)],
    ['림프', percentCell(cumulative.preflop.limp), percentCell(sessionUser.preflop.limp), percentCell(sessionReplica.preflop.limp)],
    ['3-bet', shareCell(cumulative.preflop.vsRaise, 'raise'), shareCell(sessionUser.preflop.vsRaise, 'raise'), shareCell(sessionReplica.preflop.vsRaise, 'raise')],
    ['베팅에 접기(전 스트리트 합산)', shareCell(cumFacing, 'fold'), shareCell(userFacing, 'fold'), shareCell(replicaFacing, 'fold')],
    ['베팅에 콜(합산)', shareCell(cumFacing, 'call'), shareCell(userFacing, 'call'), shareCell(replicaFacing, 'call')],
    ['베팅에 레이즈(합산)', shareCell(cumFacing, 'raise'), shareCell(userFacing, 'raise'), shareCell(replicaFacing, 'raise')],
    ['c-bet', percentCell(cumulative.postflop.cbet), percentCell(sessionUser.postflop.cbet), percentCell(sessionReplica.postflop.cbet)],
    ['쇼다운 진출', percentCell(cumulative.postflop.wtsd), percentCell(sessionUser.postflop.wtsd), percentCell(sessionReplica.postflop.wtsd)],
    ['공격 빈도(AF)', afCell(cumulative), afCell(sessionUser), afCell(sessionReplica)],
    ['오픈 사이즈(bb)', sizeCell(cumulative.preflop.openSizeBb.n, medianOf(cumulative.preflop.openSizeBb.buckets)), sizeCell(sessionUser.preflop.openSizeBb.n, medianOf(sessionUser.preflop.openSizeBb.buckets)), sizeCell(sessionReplica.preflop.openSizeBb.n, medianOf(sessionReplica.preflop.openSizeBb.buckets))],
    ['베팅 사이즈(pot 대비, 합산)', sizeCell(pooledBet(cumulative).n, pooledBet(cumulative).median), sizeCell(pooledBet(sessionUser).n, pooledBet(sessionUser).median), sizeCell(pooledBet(sessionReplica).n, pooledBet(sessionReplica).median)],
  ];
  for (const pos of POSITIONS) {
    rows.push([
      `포지션별 오픈 — ${pos}`,
      percentCell(cumulative.preflop.byPosition[pos].rfi),
      percentCell(sessionUser.preflop.byPosition[pos].rfi),
      percentCell(sessionReplica.preflop.byPosition[pos].rfi),
    ]);
  }
  return rows;
}

function changedLine(cumulative, sessionUser) {
  const parts = [];
  const vpipCum = rateOf(cumulative.preflop.vpip);
  const vpipNow = rateOf(sessionUser.preflop.vpip);
  if (vpipCum != null && vpipNow != null && sessionUser.preflop.vpip.n >= TENDENCY_MIN_N) {
    const delta = Math.round((vpipNow - vpipCum) * 100);
    parts.push(`VPIP ${delta > 0 ? '+' : ''}${delta}%p`);
  }
  const foldCum = pooledFacing(cumulative);
  const foldNow = pooledFacing(sessionUser);
  if (foldCum.n >= TENDENCY_MIN_N && foldNow.n >= TENDENCY_MIN_N) {
    const delta = Math.round(((foldNow.fold / foldNow.n) - (foldCum.fold / foldCum.n)) * 100);
    parts.push(`베팅에 접기 ${delta > 0 ? '+' : ''}${delta}%p`);
  }
  if (!parts.length) return null;
  return `이번 세션에서 달라진 것: ${parts.join(', ')} (이번 세션 표본 ${sessionUser.hands}핸드 — 참고용)`;
}

function renderSection({ players, derived, records }) {
  const mirror = findSeat(players, 'self-mirror-v1', 'SelfMirror');
  const exploiter = findSeat(players, 'self-exploiter-v1', 'SelfExploiter');
  if (!mirror && !exploiter) return '';
  const recs = records ?? [];
  const lines = [];
  if (mirror) {
    const config = configOf(mirror, derived);
    const cumulative = config.params?.tendency ?? emptyTendency('user');
    const sessionUser = tendencyFromRecords(recs, 'user');
    const sessionReplica = tendencyFromRecords(recs, mirror.playerId);
    const source = config.params?.source ?? {};
    const compared = tendencySimilarity(sessionUser, sessionReplica);
    lines.push('## 나를 닮은 상대와의 비교');
    lines.push(`- 복제 좌석: ${mirror.name ?? '이름 미확인'} — 출처 누적 ${source.hands ?? cumulative.hands}핸드·${source.sessions ?? 0}세션. 휴리스틱 복제이며 실력·수익의 증명이 아닙니다.`);
    lines.push('| 지표 | 실제 나(누적) | 실제 나(이번 세션) | 복제된 나(이번 세션) |');
    lines.push('| --- | --- | --- | --- |');
    for (const [label, a, b, c] of metricRows(cumulative, sessionUser, sessionReplica)) {
      lines.push(`| ${label} | ${a} | ${b} | ${c} |`);
    }
    if (compared.similarity == null || compared.used < SIMILARITY_MIN_COMPONENTS) {
      lines.push('- 표본 부족 — 더 긴 세션(`--hands 40` 이상)에서 비교하세요');
    } else {
      lines.push(`- 휴리스틱 유사도: ${compared.similarity}/100 (비교 지표 ${compared.used}개, 표본 ${TENDENCY_MIN_N} 미만이라 제외한 지표 ${compared.skipped}개)`);
    }
    const changed = changedLine(cumulative, sessionUser);
    if (changed) lines.push(`- ${changed}`);
    const decisive = decisiveLine(recs, mirror.playerId, cumulative);
    if (decisive) lines.push(`- ${decisive}`);
  }
  if (exploiter) {
    const config = configOf(exploiter, derived);
    const targets = config.params?.targets ?? [];
    lines.push('## 나를 공략한 상대');
    if (!targets.length) {
      lines.push(`- 공략 좌석: ${exploiter.name ?? '이름 미확인'} — 겨냥할 경향이 없어 정석대로 쳤습니다`);
    } else {
      const bits = targets.map((row) => {
        const label = TARGET_LABELS[row.label] ?? row.label;
        const n = row.evidence?.n;
        const rate = row.evidence?.rate;
        const rateText = Number.isFinite(rate) && Number.isInteger(n)
          ? `(누적 ${Math.round(rate * 100)}%, n=${n})`
          : '';
        return `${label}${rateText}`;
      });
      lines.push(`- 공략 좌석: ${exploiter.name ?? '이름 미확인'} — 겨냥한 경향: ${bits.join('; ')}`);
    }
  }
  return lines.join('\n');
}

export function buildSelfOpponentSection({ root, players, derived, records } = {}) {
  try {
    const recs = records ?? (root ? loadSessionHandRecords(root) : []);
    return renderSection({ players: players ?? [], derived: derived ?? {}, records: recs });
  } catch (error) {
    return `자기 상대 비교를 만들지 못했습니다 (${error.code ?? 'ERROR'})`;
  }
}

export function buildSelfOpponentsRaw({ root, players, derived, records } = {}) {
  const recs = records ?? (root ? loadSessionHandRecords(root) : []);
  const mirror = findSeat(players, 'self-mirror-v1', 'SelfMirror');
  const exploiter = findSeat(players, 'self-exploiter-v1', 'SelfExploiter');
  const seats = [];
  let similarity = null;
  if (mirror) {
    const config = derived?.[mirror.policy?.configDigest];
    const cumulative = config?.params?.tendency ?? emptyTendency('user');
    const sessionUser = tendencyFromRecords(recs, 'user');
    const sessionReplica = tendencyFromRecords(recs, mirror.playerId);
    similarity = tendencySimilarity(sessionUser, sessionReplica);
    seats.push({
      role: 'mirror',
      name: mirror.name ?? null,
      source: config?.params?.source ?? null,
      similarity,
    });
  }
  if (exploiter) {
    const config = derived?.[exploiter.policy?.configDigest];
    seats.push({
      role: 'exploiter',
      name: exploiter.name ?? null,
      targets: config?.params?.targets ?? [],
    });
  }
  return { seats, similarity };
}
