#!/usr/bin/env node
// Learning-calibration G7: v1/v2 behaviour must stay byte-identical while shared
// functions change. The corpus (decision snapshots and mid-hand states) was built
// once with the engine of main@62ea79c; the expected hashes were computed with
// main's own modules. The test recomputes them with the current code.
//
//   node test/helpers/compat-baseline.mjs --root <code root> --build-corpus <corpus.json>
//   node test/helpers/compat-baseline.mjs --root <code root> --corpus <corpus.json> --out <expected.json>
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Engine epochs are sha256 hex; every contract checks the format.
const EPOCH = createHash('sha256').update('compat-epoch').digest('hex');
const sha = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function load(root, rel) {
  return import(pathToFileURL(path.join(root, rel)).href);
}

// Random but reproducible play: every hand's user decisions and a few mid-hand states.
export async function buildCorpus(root) {
  const { createGame, startHand, applyAction, legalFor } = await load(root, 'engine/hand.js');
  const rng = mulberry32(20261007);
  const snapshots = [];
  const states = [];
  const pick = (items) => items[Math.floor(rng() * items.length)];
  const configs = [];
  for (let seats = 2; seats <= 9; seats += 1) {
    configs.push({ aiCount: seats - 1, mode: 'cash-training', startStackBb: 100, handLimit: 40, levelEvery: null });
    configs.push({ aiCount: seats - 1, mode: 'tournament', levelEvery: 3 });
  }
  for (const config of configs) {
    let state = createGame(config);
    if (config.mode === 'tournament') {
      for (const seat of state.seats) seat.stack = pick([150, 300, 600, 1000, 2500, 5000, 8000]);
    }
    for (let hand = 0; hand < 12 && !state.gameOver; hand += 1) {
      state = startHand(state, { rng }).state;
      let steps = 0;
      while (state.hand && !legalFor(state).handOver && steps < 200) {
        const legal = legalFor(state);
        const roll = rng();
        let action;
        let amount;
        if (legal.canRaise && roll < 0.22) {
          const bb = state.config.blinds0[1] * 2 ** state.level;
          const target = pick([legal.minRaiseTo, Math.round(2.5 * bb), Math.round(3 * (legal.callAmount + bb)), legal.maxRaiseTo]);
          action = 'raise';
          amount = Math.max(legal.minRaiseTo, Math.min(legal.maxRaiseTo, target));
          if (legal.minRaiseTo > legal.maxRaiseTo) amount = legal.maxRaiseTo;
        } else if (legal.canCheck) action = roll < 0.85 ? 'check' : 'fold';
        else action = roll < 0.55 ? 'call' : 'fold';
        if (action === 'fold' && legal.canCheck) action = 'check';
        if (states.length < 24 && rng() < 0.02) states.push(structuredClone(state));
        state = applyAction(state, legal.toAct, action, amount).state;
        steps += 1;
      }
      for (const snap of state.lastHand?.decisions ?? []) if (snap.actorId === 'user') snapshots.push(snap);
    }
  }
  return { version: 1, builtWith: 'main@62ea79c', snapshots: snapshots.slice(0, 260), states };
}

function legalOf(snap) {
  return { decisionId: snap.decisionId, handNo: snap.handNo, street: snap.street, toAct: snap.actorId,
    canCheck: snap.legal.canCheck, callAmount: snap.legal.callAmount, canRaise: snap.legal.canRaise,
    minRaiseTo: snap.legal.minRaiseTo, maxRaiseTo: snap.legal.maxRaiseTo, potTotal: snap.potBefore,
    handOver: false, gameOver: false };
}

export async function computeBaseline(root, corpus) {
  const items = {};
  const put = (key, value) => { items[key] = sha(value); };
  const { evaluatePreflopReference } = await load(root, 'training/preflop-reference.js');
  const { evaluateDecision } = await load(root, 'training/decision-evaluator.js');
  const { normalizePreflopSpot } = await load(root, 'training/preflop-spot.js');
  const { handClassOf } = await load(root, 'training/cards.js');
  const { lookup, parsePreflopJson } = await load(root, 'training/providers/preflop-json.js');
  const { projectReferenceCoverage, referenceAssessmentEligibility } = await load(root, 'shared/reference-coverage.js');
  const { buildPreActionHint } = await load(root, 'training/pre-action-hint.js');
  const { eventFromEvaluation } = await load(root, 'training/profile-store.js');
  const { rebuildFromEvents, projectActive } = await load(root, 'training/profile-aggregator.js');
  const { nextSchedule } = await load(root, 'training/spaced-repetition.js');
  const { evaluateDrillAnswer } = await load(root, 'training/drill-evaluator.js');
  const { generateQueue } = await load(root, 'training/drill-generator.js');
  const { distributionFor, decide } = await load(root, 'tools/policy-player.js');
  const { POLICIES } = await load(root, 'training/policies/catalog.js');
  const { viewFor, spectatorView } = await load(root, 'engine/views.js');
  const dataset = (version) => {
    const file = path.join(root, `training/data/preflop-baseline-v${version}.json`);
    const raw = fs.readFileSync(file, 'utf8');
    return parsePreflopJson(raw, { expectedSha256: fs.readFileSync(file.replace(/\.json$/, '.sha256'), 'utf8').trim() });
  };
  const v1 = dataset(1);
  const v2 = dataset(2);
  const events = [];
  for (const [index, snap] of corpus.snapshots.entries()) {
    const id = snap.decisionId + ':' + snap.handNo + ':' + sha(snap).slice(0, 8);
    // One game epoch per snapshot keeps evaluation ids unique across the corpus.
    const EPOCH = sha(`compat-epoch:${index}`);
    let ev2;
    try {
      ev2 = evaluatePreflopReference(snap, v2, { gameEpoch: EPOCH });
      put(`v2:${id}`, ev2);
      if (ev2.coverage) put(`v2cov:${id}`, projectReferenceCoverage(ev2.coverage));
      put(`v2elig:${id}`, referenceAssessmentEligibility({ ...ev2, source: ev2.source }));
    } catch (error) { put(`v2err:${id}`, error.code ?? error.message); }
    let ev1;
    try {
      const spot = normalizePreflopSpot(snap);
      const strategy = spot.ok ? lookup(v1, { spotKey: spot.spotKey, handClass: handClassOf(snap.holeCards) })
        : { status: 'unsupported', reason: spot.reason, source: { id: v1.data.id, version: v1.data.version, license: v1.data.license, contentSha256: v1.contentSha256 } };
      ev1 = evaluateDecision(snap, strategy, { gameEpoch: EPOCH });
      put(`v1:${id}`, ev1);
    } catch (error) { put(`v1err:${id}`, error.code ?? error.message); }
    if (snap.street === 'preflop') {
      try {
        const { chosenAction, ...open } = snap;
        put(`hint:${id}`, buildPreActionHint(open, v2, { gameEpoch: EPOCH, stateVersion: 7 }));
      } catch (error) { put(`hinterr:${id}`, error.code ?? error.message); }
    }
    for (const ev of [ev1, ev2]) {
      if (!ev) continue;
      try {
        events.push(eventFromEvaluation({ ...ev, payloadSha256: sha(ev), origin: 'game' }, '2026-10-07T00:00:00.000Z'));
      } catch (error) { put(`eventerr:${id}:${ev.source?.version}`, error.code ?? error.message); }
    }
    const legal = legalOf(snap);
    for (const policyId of ['baseline-v2', 'tag-v2', 'lag-v2', 'nit-v2', 'calling-station-v2', 'maniac-v2', 'trickster-v2']) {
      try {
        put(`policy:${policyId}:${id}`, distributionFor(snap, legal, POLICIES[policyId]));
        put(`decide:${policyId}:${id}`, decide({ snapshot: snap, legal, policy: POLICIES[policyId], policySeed: 'compat-seed', gameEpoch: EPOCH }));
      } catch (error) { put(`policyerr:${policyId}:${id}`, error.code ?? error.message); }
    }
  }
  try {
    const profile = rebuildFromEvents(events);
    put('profile', profile);
    put('profile:active', projectActive(profile));
  } catch (error) { put('profileerr', error.code ?? error.message); }
  for (const grade of ['preferred', 'mixed', 'low-frequency', 'off-policy', 'unsupported']) {
    for (const intervalDays of [1, 2, 7, 30]) for (const ease of [1.3, 2.3, 2.8]) for (const lapses of [0, 3]) {
      put(`srs:${grade}:${intervalDays}:${ease}:${lapses}`, nextSchedule({ grade, intervalDays, ease, lapses, now: Date.UTC(2026, 9, 7) }));
    }
  }
  for (const [label, ds] of [['v1', v1], ['v2', v2]]) {
    const src = { id: ds.data.id, version: ds.data.version, contentSha256: ds.contentSha256 };
    for (const mode of ['free', 'assessment']) {
      try {
        const queue = generateQueue({ mode, seed: `compat-${label}`, now: '2026-10-07T00:00:00.000Z', source: src, limit: 10 });
        put(`queue:${label}:${mode}`, queue);
        for (const question of queue.slice(0, 5)) {
          const strategy = lookup(ds, { spotKey: question.prompt.spotKey, handClass: question.prompt.handClass });
          put(`drill:${label}:${question.questionId}`, evaluateDrillAnswer(question, { action: 'fold' }, strategy));
        }
      } catch (error) { put(`queueerr:${label}:${mode}`, error.code ?? error.message); }
    }
  }
  // Every v2 spot with representative hands and each tree answer, through the
  // native practice table: hundreds of supported v2 comparisons (evaluation,
  // coverage, eligibility, profile events and the drill grade).
  const { preflopKeys } = await load(root, 'shared/preflop-key.js');
  const { nativePreflopSnapshot } = await load(root, 'training/native-preflop-snapshot.js');
  const grid = [];
  const v2src = { id: v2.data.id, version: v2.data.version, contentSha256: v2.contentSha256 };
  for (const spotKey of preflopKeys()) {
    const facing = spotKey.includes('-vs-');
    const answers = facing ? [{ action: 'fold' }, { action: 'call' }, { action: 'raise', sizeBb: 8.5 }] : [{ action: 'fold' }, { action: 'raise', sizeBb: 2.5 }];
    for (const handClass of ['AA', 'AKo', 'A5s', 'KQo', 'T9s', '77', 'J8o', '72o']) {
      for (const answer of answers) {
        const key = `grid:${spotKey}:${handClass}:${answer.action}`;
        try {
          const ev = evaluatePreflopReference(nativePreflopSnapshot(spotKey, handClass, answer), v2, { gameEpoch: sha(key) });
          put(key, ev);
          put(`${key}:elig`, referenceAssessmentEligibility(ev));
          grid.push(eventFromEvaluation({ ...ev, payloadSha256: sha(ev), origin: 'practice', assistance: { schemaVersion: 1, hintShown: false, exposureId: null } }, '2026-10-07T00:00:00.000Z'));
          const strategy = lookup(v2, { spotKey, handClass });
          const question = { questionId: `grid:${spotKey}:${handClass}`, answerPolicy: { providerId: v2src.id, providerVersion: v2src.version } };
          put(`${key}:drill`, evaluateDrillAnswer(question, answer, strategy));
        } catch (error) { put(`${key}:err`, error.code ?? error.message); }
      }
    }
  }
  try { put('grid:profile', rebuildFromEvents(grid)); } catch (error) { put('grid:profileerr', error.code ?? error.message); }
  corpus.states.forEach((state, index) => {
    for (const seat of state.seats) {
      try { put(`view:${index}:${seat.playerId}`, viewFor(state, seat.playerId)); } catch (error) { put(`viewerr:${index}:${seat.playerId}`, error.message); }
    }
    try { put(`spectator:${index}`, spectatorView(state)); } catch (error) { put(`spectatorerr:${index}`, error.message); }
  });
  return { version: 1, items };
}

async function main(argv) {
  const arg = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv[i + 1]; };
  // `node --test` runs every module under test/ without arguments: nothing to do.
  if (!arg('--build-corpus') && !arg('--corpus')) return;
  const root = path.resolve(arg('--root') ?? '.');
  if (arg('--build-corpus')) {
    fs.writeFileSync(arg('--build-corpus'), `${JSON.stringify(await buildCorpus(root))}\n`);
    return;
  }
  const corpus = JSON.parse(fs.readFileSync(arg('--corpus'), 'utf8'));
  const result = await computeBaseline(root, corpus);
  fs.writeFileSync(arg('--out'), `${JSON.stringify(result, null, 1)}\n`);
  process.stdout.write(`${Object.keys(result.items).length} items\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  await main(process.argv.slice(2));
}
