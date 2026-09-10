#!/usr/bin/env node
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { newDeck } from '../engine/cards.js';
import { snapshotDecision } from '../engine/decision.js';
import { applyAction, createGame, legalFor, startHand } from '../engine/hand.js';
import { allHandClasses } from '../training/cards.js';
import { policyById } from '../training/policies/catalog.js';
import { raiseToFor, roundToUnit } from '../training/policies/sizing.js';
import { distributionV2 } from '../training/policies/strategy-v2.js';
import { decide } from './policy-player.js';
import { deriveUnit, sampleWeighted } from '../training/policies/rng.js';
import { publicLine } from '../training/policies/public-line.js';

const PERSONA_IDS = Object.freeze([
  'nit-v2', 'tag-v2', 'lag-v2', 'calling-station-v2', 'maniac-v2', 'trickster-v2',
]);

const RIVER_FACING_LEGAL = Object.freeze({
  canCheck: false, canRaise: true, callAmount: 500, minRaiseTo: 1_000, maxRaiseTo: 10_000,
});

function riverSnapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    decisionId: 'benchmark-decision',
    street: 'river',
    holeCards: ['Th', '9d'],
    board: ['Ah', 'Kh', 'Qh', 'Jh', '2c'],
    blinds: [50, 100],
    position: 'BTN',
    potBefore: 1_000,
    actorBet: 0,
    currentBet: 500,
    toCall: 500,
    effectiveStack: 10_000,
    priorActions: [],
    publicSeats: Array.from({ length: 6 }, (_, index) => ({ playerId: `p${index}`, out: false })),
    ...overrides,
  };
}

export function buildPreflopScenarios() {
  let state = createGame({
    aiCount: 5,
    startStack: 10_000,
    blinds0: [50, 100],
    mode: 'cash-training',
    levelEvery: null,
    startStackBb: 100,
    handLimit: 20,
  });
  state.button = 5;
  state = startHand(state, { deck: newDeck() }).state;
  for (const playerId of ['p3', 'p4', 'p5']) {
    const legal = legalFor(state);
    if (legal.toAct !== playerId) throw new Error(`preflop scenario actor mismatch: ${legal.toAct}`);
    state = applyAction(state, playerId, 'fold').state;
  }
  const unopenedLegal = legalFor(state);
  const unopenedSnapshot = snapshotDecision(state, unopenedLegal.toAct, null, {
    blinds: [50, 100], legal: unopenedLegal,
  });
  state = applyAction(state, unopenedLegal.toAct, 'raise', 250).state;
  const facingOpenLegal = legalFor(state);
  const facingOpenSnapshot = snapshotDecision(state, facingOpenLegal.toAct, null, {
    blinds: [50, 100], legal: facingOpenLegal,
  });
  return {
    unopened: { snapshot: unopenedSnapshot, legal: unopenedLegal },
    facingOpen: { snapshot: facingOpenSnapshot, legal: facingOpenLegal },
  };
}

const PREFLOP_SCENARIOS = buildPreflopScenarios();

function sizingSpot(actions = []) {
  let state = createGame({
    aiCount: 5,
    startStack: 5000,
    blinds0: [25, 50],
    mode: 'cash-training',
    levelEvery: null,
    startStackBb: 100,
    handLimit: 20,
  });
  state.button = 5;
  state = startHand(state, { deck: newDeck() }).state;
  for (const step of actions) {
    const legal = legalFor(state);
    const [action, amount] = Array.isArray(step) ? step : [step];
    state = applyAction(state, legal.toAct, action, amount).state;
  }
  const legal = legalFor(state);
  const snapshot = snapshotDecision(state, legal.toAct, null, {
    blinds: state.config.blinds0, legal,
  });
  return { snapshot, legal };
}

function buildSizingScenarios() {
  const flop = [['raise', 125], 'fold', 'fold', 'fold', 'fold', 'call'];
  return Object.freeze([
    Object.freeze({ spot: 'P1', ...sizingSpot([]) }),
    Object.freeze({ spot: 'P2', ...sizingSpot(['call']) }),
    Object.freeze({ spot: 'P3', ...sizingSpot([['raise', 125]]) }),
    Object.freeze({ spot: 'P4', ...sizingSpot([['raise', 125], 'call']) }),
    Object.freeze({ spot: 'P5', ...sizingSpot([['raise', 125], ['raise', 425]]) }),
    Object.freeze({ spot: 'P6', ...sizingSpot([['raise', 125], ['raise', 425], ['raise', 975]]) }),
    Object.freeze({ spot: 'F1', ...sizingSpot(flop) }),
    Object.freeze({ spot: 'F2', ...sizingSpot([...flop, ['raise', 175]]) }),
  ]);
}

const SIZING_SCENARIOS = buildSizingScenarios();

function benchmarkSizing() {
  const scenarios=SIZING_SCENARIOS.map(row=>({...row,snapshot:row.snapshot.street==='preflop'?row.snapshot:{...row.snapshot,
    holeCards:['Js','Ts'],board:['As','Ks','Qs','2c','3d'].slice(0,row.snapshot.board.length)}}));
  const sizing = scenarios.map(({ spot, snapshot, legal }) => {
    const sized = raiseToFor(snapshot, legal);
    const raises = distributionV2(snapshot, legal, policyById('tag-v2'))
      .filter((item) => item.action === 'raise');
    return {
      spot,
      rule: sized.rule,
      minRaiseTo: legal.minRaiseTo,
      maxRaiseTo: legal.maxRaiseTo,
      amount: raises[0]?.amount ?? null,
      sizeSupport: raises.map(row=>({amount:row.amount,frequency:row.frequency})),
      raiseFrequency: raises.reduce((sum,row) => sum + row.frequency,0),
    };
  });
  let minRaiseOutsideClampCount = 0;
  for (const { snapshot, legal } of scenarios) {
    const sized = raiseToFor(snapshot, legal);
    const unit = snapshot.blinds[0];
    for (const id of PERSONA_IDS) {
      for (const item of distributionV2(snapshot, legal, policyById(id))) {
        if (item.action !== 'raise') continue;
        if (item.amount === legal.minRaiseTo && roundToUnit(sized.target, unit) > legal.minRaiseTo) {
          minRaiseOutsideClampCount += 1;
        }
      }
    }
  }
  return { sizing, minRaiseOutsideClampCount };
}

const EXPECTED_PREFLOP_FACTS = Object.freeze({
  unopened: Object.freeze({
    actorId: 'user', position: 'BTN', potBefore: 150, actorBet: 0,
    currentBet: 100, toCall: 100, callAmount: 100, minRaiseTo: 200,
  }),
  facingOpen: Object.freeze({
    actorId: 'p1', position: 'SB', potBefore: 400, actorBet: 50,
    currentBet: 250, toCall: 200, callAmount: 200, minRaiseTo: 400,
  }),
});

function scenarioFacts({ snapshot, legal }) {
  return {
    actorId: snapshot.actorId,
    position: snapshot.position,
    potBefore: snapshot.potBefore,
    actorBet: snapshot.actorBet,
    currentBet: snapshot.currentBet,
    toCall: snapshot.toCall,
    callAmount: legal.callAmount,
    minRaiseTo: legal.minRaiseTo,
  };
}

function probability(items, action) {
  return items.filter((item) => item.action === action).reduce((sum, item) => sum + item.frequency, 0);
}

function participation(items) {
  return 1 - probability(items, 'fold');
}

function handClassFixture(handClass) {
  if (handClass.length === 2) return { cards: [`${handClass[0]}h`, `${handClass[1]}d`], combos: 6 };
  if (handClass[2] === 's') return { cards: [`${handClass[0]}h`, `${handClass[1]}h`], combos: 4 };
  return { cards: [`${handClass[0]}h`, `${handClass[1]}d`], combos: 12 };
}

function totalVariation(left, right) {
  return 0.5 * ['fold', 'check', 'call', 'raise'].reduce(
    (sum, action) => sum + Math.abs(probability(left, action) - probability(right, action)),
    0,
  );
}

function legalDistribution(items, legal) {
  const total = items.reduce((sum, item) => sum + item.frequency, 0);
  if (Math.abs(total - 1) > 1e-12 || items.some((item) => !(item.frequency > 0))) return false;
  return items.every((item) => {
    if (item.action === 'check') return legal.canCheck;
    if (item.action === 'fold') return !legal.canCheck;
    if (item.action === 'call') return !legal.canCheck && legal.callAmount > 0 && item.amount === legal.callAmount;
    if (item.action !== 'raise' || !legal.canRaise || !Number.isInteger(item.amount)) return false;
    return legal.minRaiseTo > legal.maxRaiseTo
      ? item.amount === legal.maxRaiseTo
      : item.amount >= legal.minRaiseTo && item.amount <= legal.maxRaiseTo;
  });
}

function benchmarkPersonaResponses() {
  const fixtures = {
    strong: riverSnapshot(),
    marginal: riverSnapshot({ holeCards: ['Ad', '9s'], board: ['Ah', 'Kh', '7c', '4d', '2c'] }),
    draw: riverSnapshot({ street: 'turn', holeCards: ['Th', '9h'], board: ['Ah', 'Kh', '2c', '3d'] }),
    air: riverSnapshot({ holeCards: ['3d', '4s'] }),
  };
  return Object.fromEntries(PERSONA_IDS.map((id) => [id, Object.fromEntries(
    Object.entries(fixtures).map(([name, input]) => {
      const items = distributionV2(input, RIVER_FACING_LEGAL, policyById(id));
      return [name, {
        fold: probability(items, 'fold'),
        call: probability(items, 'call'),
        raise: probability(items, 'raise'),
        participation: participation(items),
      }];
    }),
  )]));
}

function benchmarkPrice() {
  const marginal = riverSnapshot({ holeCards: ['Ad', '9s'], board: ['Ah', 'Kh', '7c', '4d', '2c'] });
  let violations = 0;
  const responses = {};
  for (const id of PERSONA_IDS) {
    let previous = Infinity;
    responses[id] = [50, 200, 500, 1_000].map((callAmount) => {
      const value = participation(distributionV2(
        { ...marginal, toCall: callAmount },
        { ...RIVER_FACING_LEGAL, callAmount },
        policyById(id),
      ));
      if (value > previous + 1e-12) violations += 1;
      previous = value;
      return { callAmount, participation: value };
    });
  }
  return { violations, responses };
}

function benchmarkPreflop() {
  const grid = allHandClasses().map((handClass) => ({ handClass, ...handClassFixture(handClass) }));
  const openRates = {};
  const defenseCalls = {};
  const tv = [];
  const weight = grid.reduce((sum, row) => sum + row.combos, 0);
  const unopened = PREFLOP_SCENARIOS.unopened;
  const facingOpen = PREFLOP_SCENARIOS.facingOpen;
  for (const id of ['nit-v2', 'tag-v2', 'lag-v2', 'maniac-v2']) {
    openRates[id] = grid.reduce((sum, row) => sum + row.combos * participation(distributionV2(
      { ...unopened.snapshot, holeCards: row.cards },
      unopened.legal,
      policyById(id),
    )), 0) / weight;
  }
  for (const id of ['tag-v2', 'calling-station-v2']) {
    defenseCalls[id] = grid.reduce((sum, row) => sum + row.combos * probability(distributionV2(
      { ...facingOpen.snapshot, holeCards: row.cards },
      facingOpen.legal,
      policyById(id),
    ), 'call'), 0) / weight;
  }
  for (const row of grid) {
    const input = { ...facingOpen.snapshot, holeCards: row.cards };
    tv.push({
      combos: row.combos,
      value: totalVariation(
        distributionV2(input, facingOpen.legal, policyById('trickster-v2')),
        distributionV2(input, facingOpen.legal, policyById('baseline-v2')),
      ),
    });
  }
  return {
    comboCount: weight,
    classCount: grid.length,
    openRates,
    defenseCalls,
    tricksterBaselineMeanTv: tv.reduce((sum, row) => sum + row.combos * row.value, 0) / weight,
  };
}

function benchmarkSafety() {
  let illegalOutputCount = 0;
  let determinismViolationCount = 0;
  let hiddenStateViolationCount = 0;
  const cases = [
    [riverSnapshot(), RIVER_FACING_LEGAL],
    [{ ...PREFLOP_SCENARIOS.unopened.snapshot, holeCards: ['Ah', 'Kd'] }, PREFLOP_SCENARIOS.unopened.legal],
    [riverSnapshot(), { ...RIVER_FACING_LEGAL, minRaiseTo: 850, maxRaiseTo: 620 }],
    [riverSnapshot({ street: 'flop', holeCards: ['Ah', 'Qh'], board: ['Jh', '7c', '2d'] }), { canCheck: true, canRaise: false, callAmount: 0, minRaiseTo: 0, maxRaiseTo: 0 }],
  ];
  for (const id of PERSONA_IDS) {
    for (const [input, legal] of cases) {
      const policy = policyById(id);
      const items = distributionV2(input, legal, policy);
      if (!legalDistribution(items, legal)) illegalOutputCount += 1;
      const args = {
        snapshot: input, legal, policy, policySeed: 'benchmark-seed', gameEpoch: 'benchmark-epoch',
      };
      const first = decide(args);
      const second = decide(args);
      if (JSON.stringify(first) !== JSON.stringify(second)) determinismViolationCount += 1;
      const hidden = decide({
        ...args,
        snapshot: {
          ...input,
          deck: ['As', 'Ac'],
          opponentHoleCards: [['Ks', 'Kc']],
          hidden: { futureBoard: ['Th', 'Kh'] },
        },
      });
      if (JSON.stringify(first) !== JSON.stringify(hidden)) hiddenStateViolationCount += 1;
    }
  }
  return { illegalOutputCount, determinismViolationCount, hiddenStateViolationCount };
}

export function benchmarkPositionMix() {
  const samples=10_000, tolerance=0.02, seed='policy-2.2-fixed-grid';
  const rows=[];
  for(const id of PERSONA_IDS) for(const position of ['UTG','CO','BTN']) {
    const snapshot={...PREFLOP_SCENARIOS.unopened.snapshot,position,holeCards:['8h','7h']};
    const declared=distributionV2(snapshot,PREFLOP_SCENARIOS.unopened.legal,policyById(id));
    const counts=new Map();
    for(let i=0;i<samples;i++) {
      const sampled=sampleWeighted(declared,deriveUnit(seed,'benchmark',String(i),id+position));
      const key=sampled.action+':'+sampled.amount;
      counts.set(key,(counts.get(key)??0)+1);
    }
    const frequencies=declared.map(row=>({...row,observed:(counts.get(row.action+':'+row.amount)??0)/samples}));
    rows.push({id,position,participation:1-(declared.find(row=>row.action==='fold')?.frequency??0),frequencies});
  }
  return {samples,tolerance,seed,rows,maxError:Math.max(...rows.flatMap(row=>row.frequencies.map(f=>Math.abs(f.frequency-f.observed))))};
}

export function benchmarkPublicLines() {
  const snapshot={actorId:'user',decisionId:'line-grid',street:'flop',position:'BTN',
    holeCards:['6h','5h'],board:['Kh','8h','2c'],blinds:[25,50],potBefore:300,actorBet:0,currentBet:0,toCall:0,
    publicSeats:[{playerId:'user',position:'BTN'},{playerId:'p1',position:'BB'}],
    priorActions:[{playerId:'user',street:'preflop',action:'raise',amount:125},{playerId:'p1',street:'preflop',action:'call',amount:125},
      {playerId:'p1',street:'flop',action:'check',amount:0}]};
  const legal={canCheck:true,canRaise:true,callAmount:0,minRaiseTo:50,maxRaiseTo:5000};
  const cases=[['initiative',snapshot],['missing-history',{...snapshot,priorActions:undefined}],
    ['multiway',{...snapshot,publicSeats:[...snapshot.publicSeats,{playerId:'p2',position:'CO'}]}],
    ['facing-raise',{...snapshot,priorActions:[...snapshot.priorActions,{playerId:'p1',street:'flop',action:'raise',amount:100}]}]];
  const rows=[];
  for(const id of PERSONA_IDS) for(const [name,input] of cases) {
    const items=distributionV2(input,legal,policyById(id));
    const value=distributionV2({...input,holeCards:['Ks','Kd']},legal,policyById(id));
    const raises=items.filter(row=>row.action==='raise');
    rows.push({id,name,eligible:publicLine(input).eligible,
      bluffMass:raises.filter(row=>row.reasonCode.startsWith('v2-bluff:')).reduce((s,row)=>s+row.frequency,0),
      bluffSizes:raises.map(row=>row.amount),valueSizes:value.filter(row=>row.action==='raise').map(row=>row.amount)});
  }
  return {rows,eligibilityViolations:rows.filter(row=>!row.eligible && row.bluffMass!==0).length,
    supportViolations:rows.filter(row=>row.eligible && (!row.bluffMass || JSON.stringify(row.bluffSizes)!==JSON.stringify(row.valueSizes))).length};
}

export function benchmarkPolicies() {
  const started = performance.now();
  const personaStarted = performance.now();
  const personaResponses = benchmarkPersonaResponses();
  const personaMs = performance.now() - personaStarted;
  const priceStarted = performance.now();
  const price = benchmarkPrice();
  const priceMs = performance.now() - priceStarted;
  const preflopStarted = performance.now();
  const preflop = benchmarkPreflop();
  const preflopMs = performance.now() - preflopStarted;
  const safetyStarted = performance.now();
  const safety = benchmarkSafety();
  const safetyMs = performance.now() - safetyStarted;
  const sizingReport = benchmarkSizing();
  const positionMix = benchmarkPositionMix();
  const nutsFolds = PERSONA_IDS.map((id) => personaResponses[id].strong.fold);
  const nutsAirDifferences = PERSONA_IDS.map(
    (id) => personaResponses[id].air.fold - personaResponses[id].strong.fold,
  );
  const openOrder = ['nit-v2', 'tag-v2', 'lag-v2', 'maniac-v2'];
  const ordered = openOrder.every((id, index) => index === 0 || preflop.openRates[openOrder[index - 1]] < preflop.openRates[id]);
  return {
    schemaVersion: 1,
    evidenceKind: 'deterministic-heuristic-policy-behavior',
    methodology: {
      authority: 'local-card-aware-heuristic',
      opponentModel: 'uniform-unknown-single-opponent-sampling',
      humanOutcomeEvidence: 'none',
      solverOrGtoEvidence: 'none',
      preflopGrid: '169 classes weighted to 1326 combinations',
      preflopScenarios: 'derived-once-from-engine-state-transitions',
    },
    claims: { humanSkill: false, gto: false, solverAccuracy: false },
    acceptance: {
      nutsFoldMax: 0.05,
      nutsAirDifferenceMin: 0.5,
      marginalPriceViolationCountMax: 0,
      comboParticipationStrictOrder: openOrder,
      stationCallMinusTagMinExclusive: 0,
      tricksterBaselineMeanTvMin: 0.05,
      safetyViolationCountMax: 0,
      minRaiseOutsideClampCountMax: 0,
    },
    thresholds: {
      nutsFoldMax: Math.max(...nutsFolds),
      nutsAirDifferenceMin: Math.min(...nutsAirDifferences),
      marginalPriceViolationCount: price.violations,
      comboParticipationOrder: ordered ? openOrder : [],
      stationCallMinusTag: preflop.defenseCalls['calling-station-v2'] - preflop.defenseCalls['tag-v2'],
      tricksterBaselineMeanTv: preflop.tricksterBaselineMeanTv,
      minRaiseOutsideClampCount: sizingReport.minRaiseOutsideClampCount,
      ...safety,
    },
    sizing: sizingReport.sizing,
    personaResponses,
    priceResponses: price.responses,
    preflop,
    positionMix,
    publicLines: benchmarkPublicLines(),
    scenarios: {
      preflop: {
        unopened: scenarioFacts(PREFLOP_SCENARIOS.unopened),
        facingOpen: scenarioFacts(PREFLOP_SCENARIOS.facingOpen),
      },
    },
    measurements: {
      kind: 'non-deterministic-wall-clock',
      wallClockMs: {
        personaResponses: personaMs,
        priceResponses: priceMs,
        preflopGrid: preflopMs,
        safety: safetyMs,
        total: performance.now() - started,
      },
    },
  };
}

export function assertBenchmark(result) {
  const failures = [];
  const t = result?.thresholds ?? {};
  if (!(t.nutsFoldMax <= 0.05)) failures.push('nutsFoldMax');
  if (!(t.nutsAirDifferenceMin >= 0.5)) failures.push('nutsAirDifferenceMin');
  if (t.marginalPriceViolationCount !== 0) failures.push('marginalPriceViolationCount');
  if (JSON.stringify(t.comboParticipationOrder) !== JSON.stringify(['nit-v2', 'tag-v2', 'lag-v2', 'maniac-v2'])) failures.push('comboParticipationOrder');
  if (!(t.stationCallMinusTag > 0)) failures.push('stationCallMinusTag');
  if (!(t.tricksterBaselineMeanTv >= 0.05)) failures.push('tricksterBaselineMeanTv');
  for (const key of ['illegalOutputCount', 'determinismViolationCount', 'hiddenStateViolationCount', 'minRaiseOutsideClampCount']) {
    if (t[key] !== 0) failures.push(key);
  }
  if (!Array.isArray(result?.sizing) || result.sizing.length !== 8) failures.push('sizing');
  else if(result.sizing.some(row=>!(row.raiseFrequency>0)||!row.sizeSupport?.length
    ||row.sizeSupport.some(size=>!Number.isFinite(size.amount)||size.amount<row.minRaiseTo||size.amount>row.maxRaiseTo))) failures.push('sizingSupport');
  if (!(result?.positionMix?.maxError <= 0.02) || result.positionMix.samples !== 10000) failures.push('positionMix');
  for(const id of PERSONA_IDS) {
    const rows=result.positionMix?.rows.filter(row=>row.id===id)??[];
    // Saturated persona participation can tie at the 0.98 cap, but its size
    // frequencies must still differ by position.
    if(rows.length!==3 || !(rows[0].participation<=rows[1].participation && rows[1].participation<=rows[2].participation)
      || JSON.stringify(rows[0].frequencies.map(f=>f.frequency))===JSON.stringify(rows[2].frequencies.map(f=>f.frequency))) failures.push('positionOrder:'+id);
  }
  if(result.publicLines?.eligibilityViolations!==0 || result.publicLines?.supportViolations!==0) failures.push('publicLines');
  for (const key of ['unopened', 'facingOpen']) {
    if (JSON.stringify(result?.scenarios?.preflop?.[key]) !== JSON.stringify(EXPECTED_PREFLOP_FACTS[key])) {
      failures.push(`preflopScenario.${key}`);
    }
  }
  if (result?.methodology?.preflopScenarios !== 'derived-once-from-engine-state-transitions') {
    failures.push('preflopScenario.methodology');
  }
  if (result?.measurements?.kind !== 'non-deterministic-wall-clock') {
    failures.push('measurements.kind');
  }
  if (failures.length) {
    const error = new Error(`policy benchmark thresholds failed: ${failures.join(', ')}`);
    error.code = 'POLICY_BENCHMARK_FAILED';
    error.failures = failures;
    throw error;
  }
  return result;
}

function main(argv) {
  const flags = new Set(argv);
  for (const flag of flags) {
    if (!['--assert', '--json'].includes(flag)) throw new Error(`unknown argument: ${flag}`);
  }
  const result = benchmarkPolicies();
  if (flags.has('--assert')) assertBenchmark(result);
  if (flags.has('--json')) process.stdout.write(`${JSON.stringify(result)}\n`);
  else process.stdout.write(`policy benchmark: ${JSON.stringify(result.thresholds)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file://${process.argv[1]}`))) {
  main(process.argv.slice(2));
}
