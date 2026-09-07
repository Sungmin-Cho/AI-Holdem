import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, createGame, legalFor, startHand } from '../engine/hand.js';
import { positionsOf } from '../engine/positions.js';
import { statsReport } from '../engine/views.js';
import { mulberry32 } from './helpers/fixtures.js';
import { SCENARIOS, buildDeck, readGeneratedRecord } from './helpers/gen-hh-fixtures.js';
import { estimatePublicStrength } from '../training/policies/hand-strength.js';
import {
  HAND_CLASSES,
  POSITIONS,
  assertTendency,
  rateOf,
} from '../training/tendency/contracts.js';
import { extractHandTendency, tendencyFromRecords } from '../training/tendency/extract.js';
import { positionsFromRecord } from '../training/tendency/positions.js';

function randomLegal(la, rng) {
  const options = [
    { weight: 0.2, pick: () => ['fold'] },
    { weight: 0.5, pick: () => [la.canCheck ? 'check' : 'call'] },
  ];
  if (la.canRaise) {
    options.push({
      weight: 0.3,
      pick: () => {
        const amount = la.minRaiseTo > la.maxRaiseTo
          ? la.maxRaiseTo
          : la.minRaiseTo + Math.floor(rng() * (la.maxRaiseTo - la.minRaiseTo + 1));
        return ['raise', amount];
      },
    });
  }
  const total = options.reduce((sum, option) => sum + option.weight, 0);
  let roll = rng() * total;
  for (const option of options) {
    roll -= option.weight;
    if (roll < 0) return option.pick();
  }
  return options.at(-1).pick();
}

function buttonFirstIds(seated, heroFromButton = 0) {
  const ids = [];
  let n = 1;
  for (let i = 0; i < seated; i += 1) {
    if (i === heroFromButton) ids.push('user');
    else {
      ids.push(`p${n}`);
      n += 1;
    }
  }
  return ids;
}

function act(partial) {
  return {
    decisionId: partial.decisionId,
    playerId: partial.playerId,
    action: partial.action,
    amount: partial.amount ?? 0,
    street: partial.street ?? 'preflop',
    potTotal: partial.potTotal ?? 75,
    callAmount: partial.callAmount ?? 0,
    minRaiseTo: partial.minRaiseTo ?? 100,
    maxRaiseTo: partial.maxRaiseTo ?? 5000,
    currentBet: partial.currentBet ?? 50,
    board: partial.board ?? [],
    stacks: partial.stacks ?? {},
  };
}

function makeRecord({
  seated = 6,
  heroFromButton = 0,
  holes,
  actions = [],
  decisions = [],
  board = [],
  folded = [],
  allIn = [],
  pots = [],
  showdown = null,
  blinds = [25, 50],
}) {
  const ids = buttonFirstIds(seated, heroFromButton);
  const deal = [...ids.slice(1), ids[0]];
  const startStacks = {};
  for (const id of deal) startStacks[id] = 5000;
  const defaultHoles = {};
  for (const id of ids) defaultHoles[id] = id === 'user' ? ['Ah', 'Kd'] : ['2c', '3d'];
  return {
    handNo: 1,
    blinds,
    button: ids[0],
    holes: holes ?? defaultHoles,
    board,
    folded,
    allIn,
    actions,
    decisions,
    pots,
    showdown,
    startStacks,
    endStacks: { ...startStacks },
    posts: [
      { playerId: deal[0], amount: blinds[0], allIn: false },
      { playerId: deal[1], amount: blinds[1], allIn: false },
    ],
  };
}

function extractUser(record, extra = {}) {
  const forcedDecisionIds = (record.decisions ?? [])
    .filter((row) => row.forced === true)
    .map((row) => row.decisionId);
  return extractHandTendency(record, extra.playerId ?? 'user', { forcedDecisionIds, ...extra });
}

function replayScenario(scenario) {
  let st = createGame({ aiCount: 2, startStack: 5000 });
  st.button = st.seats.length - 1;
  for (const seat of st.seats) seat.stack = scenario.stacks[seat.playerId];
  st = startHand(st, { deck: buildDeck(scenario) }).state;
  for (const [playerId, action, amount] of scenario.actions) {
    st = applyAction(st, playerId, action, amount).state;
  }
  assert.ok(st.lastHand, `${scenario.name} did not finish`);
  return st;
}

test('positionsFromRecord matches positionsOf on 200 real-play hands with busts', () => {
  const cases = [];
  for (let aiCount = 1; aiCount <= 8 && cases.length < 200; aiCount += 1) {
    for (let seed = 1; seed <= 12 && cases.length < 200; seed += 1) {
      const rng = mulberry32(seed * 1000 + aiCount);
      let st = createGame({ aiCount, levelEvery: 2 });
      let busted = false;
      let hands = 0;
      while (!st.gameOver && hands < 400 && cases.length < 200) {
        st = startHand(st, { rng }).state;
        // Capture while the hand is live. startHand may finish immediately
        // (walkout / blinds all-in); those seats can already be busted.
        if (!st.hand) {
          hands += 1;
          if (st.seats.some((seat) => seat.out)) busted = true;
          continue;
        }
        const live = positionsOf(st);
        let acts = 0;
        while (!legalFor(st).handOver) {
          acts += 1;
          assert.ok(acts <= 10_000, `hand ${hands} did not close`);
          const la = legalFor(st);
          st = applyAction(st, la.toAct, ...randomLegal(la, rng)).state;
        }
        hands += 1;
        if (st.seats.some((seat) => seat.out)) busted = true;
        if (!busted && aiCount > 1) continue;
        const fromRecord = positionsFromRecord(st.lastHand);
        const seated = fromRecord.seated;
        const labels = { ...fromRecord };
        delete labels.seated;
        cases.push({ live, labels, seated, seats: st.seats.length });
      }
    }
  }
  assert.ok(cases.length >= 200, `only ${cases.length} parity cases`);
  for (const row of cases.slice(0, 200)) {
    assert.deepEqual(row.labels, row.live);
    assert.equal(row.seated, Object.keys(row.live).length);
  }
});

test('generated fixture VPIP/PFR matches statsReport and ignores AF', () => {
  const names = ['uncalled', 'split', 'side-pot'];
  const records = names.map((name) => readGeneratedRecord(name));
  let vpip = 0;
  let pfr = 0;
  let hands = 0;
  for (const scenario of SCENARIOS) {
    const st = replayScenario(scenario);
    const raw = st.stats.user;
    vpip += raw.vpip;
    pfr += raw.pfr;
    hands += raw.hands;
    const report = statsReport(st).perPlayer.user;
    assert.equal(report.sample, raw.hands);
    assert.equal(report.vpip, raw.hands ? raw.vpip / raw.hands : 0);
    assert.equal(report.pfr, raw.hands ? raw.pfr / raw.hands : 0);
  }
  const tendency = tendencyFromRecords(records, 'user');
  assertTendency(tendency);
  assert.equal(tendency.hands, hands);
  assert.equal(tendency.preflop.vpip.n, hands);
  assert.equal(tendency.preflop.vpip.k, vpip);
  assert.equal(tendency.preflop.pfr.n, hands);
  assert.equal(tendency.preflop.pfr.k, pfr);
  assert.equal(rateOf(tendency.preflop.vpip), vpip / hands);
  assert.equal(rateOf(tendency.preflop.pfr), pfr / hands);
});

test('forced:true decisions are excluded from counts and indicators', () => {
  const record = makeRecord({
    seated: 6,
    heroFromButton: 2,
    actions: [
      act({
        decisionId: 'd-open', playerId: 'p3', action: 'raise', amount: 125,
        potTotal: 75, callAmount: 50, currentBet: 50,
      }),
      act({
        decisionId: 'd-forced', playerId: 'user', action: 'call', amount: 75,
        potTotal: 175, callAmount: 75, currentBet: 125,
      }),
    ],
    decisions: [{ decisionId: 'd-forced', forced: true }],
  });
  const excluded = extractUser(record);
  assert.equal(excluded.decisions, 0);
  assert.equal(excluded.preflop.vpip.k, 0);
  assert.equal(excluded.preflop.vsRaise.n, 0);
  const included = extractHandTendency(record, 'user', { forcedDecisionIds: [] });
  assert.equal(included.decisions, 1);
  assert.equal(included.preflop.vpip.k, 1);
});

test('AI seat extraction is isomorphic and passes assertTendency', () => {
  const record = readGeneratedRecord('uncalled');
  const t = tendencyFromRecords([record], 'p1');
  assert.equal(t.subject, 'p1');
  assertTendency(t);
  assert.equal(t.hands, 1);
});

test('label fold and table-size gates for byPosition', () => {
  const sevenUtg = extractUser(makeRecord({ seated: 7, heroFromButton: 3 }));
  const sevenUtg1 = extractUser(makeRecord({ seated: 7, heroFromButton: 4 }));
  const sevenUtg2 = extractUser(makeRecord({ seated: 7, heroFromButton: 5 }));
  assert.equal(sevenUtg.preflop.byPosition.UTG.dealt, 1);
  assert.equal(sevenUtg1.preflop.byPosition.UTG.dealt, 1);
  assert.equal(sevenUtg2.preflop.byPosition.HJ.dealt, 1);
  assert.equal(sevenUtg2.preflop.byPosition.UTG.dealt, 0);

  const sixHj = extractUser(makeRecord({ seated: 6, heroFromButton: 4 }));
  assert.equal(sixHj.preflop.byPosition.HJ.dealt, 1);

  const fiveUtg = extractUser(makeRecord({ seated: 5, heroFromButton: 3 }));
  assert.equal(fiveUtg.preflop.byPosition.UTG.dealt, 1);
  assert.equal(fiveUtg.preflop.byPosition.HJ.dealt, 0);

  const headsUp = extractUser(makeRecord({ seated: 2, heroFromButton: 0 }));
  const eight = extractUser(makeRecord({ seated: 8, heroFromButton: 0 }));
  assert.equal(headsUp.seatMix[2], 1);
  assert.equal(eight.seatMix[8], 1);
  for (const pos of POSITIONS) {
    assert.equal(headsUp.preflop.byPosition[pos].dealt, 0);
    assert.equal(eight.preflop.byPosition[pos].dealt, 0);
  }

  const huHands = Array.from({ length: 30 }, () => makeRecord({ seated: 2, heroFromButton: 0 }));
  const sixHands = Array.from({ length: 60 }, () => makeRecord({ seated: 6, heroFromButton: 0 }));
  const mixed = tendencyFromRecords([...huHands, ...sixHands], 'user');
  assert.equal(mixed.seatMix[2], 30);
  assert.equal(mixed.seatMix[6], 60);
  assert.equal(mixed.preflop.byPosition.BTN.dealt, 60);
});

test('preflop regimes increment exactly one of rfi/limp/vsRaise/vs3Bet', () => {
  const unopened = extractUser(makeRecord({
    seated: 6,
    heroFromButton: 3,
    actions: [act({
      decisionId: 'd-open', playerId: 'user', action: 'raise', amount: 125,
      potTotal: 75, callAmount: 50, currentBet: 50,
    })],
  }));
  const limp = extractUser(makeRecord({
    seated: 6,
    heroFromButton: 3,
    actions: [act({
      decisionId: 'd-limp', playerId: 'user', action: 'call', amount: 50,
      potTotal: 75, callAmount: 50, currentBet: 50,
    })],
  }));
  const limper = extractUser(makeRecord({
    seated: 6,
    heroFromButton: 4,
    actions: [
      act({
        decisionId: 'd-limp', playerId: 'p4', action: 'call', amount: 50,
        potTotal: 75, callAmount: 50, currentBet: 50,
      }),
      act({
        decisionId: 'd-iso', playerId: 'user', action: 'raise', amount: 200,
        potTotal: 125, callAmount: 50, currentBet: 50,
      }),
    ],
  }));
  const singleOpen = extractUser(makeRecord({
    seated: 6,
    heroFromButton: 2,
    actions: [
      act({
        decisionId: 'd-open', playerId: 'p3', action: 'raise', amount: 125,
        potTotal: 75, callAmount: 50, currentBet: 50,
      }),
      act({
        decisionId: 'd-fold1', playerId: 'p4', action: 'fold',
        potTotal: 175, callAmount: 75, currentBet: 125,
      }),
      act({
        decisionId: 'd-hero', playerId: 'user', action: 'fold',
        potTotal: 175, callAmount: 75, currentBet: 125,
      }),
    ],
  }));
  const squeeze = extractUser(makeRecord({
    seated: 6,
    heroFromButton: 2,
    actions: [
      act({
        decisionId: 'd-open', playerId: 'p3', action: 'raise', amount: 125,
        potTotal: 75, callAmount: 50, currentBet: 50,
      }),
      act({
        decisionId: 'd-call', playerId: 'p4', action: 'call', amount: 75,
        potTotal: 175, callAmount: 75, currentBet: 125,
      }),
      act({
        decisionId: 'd-sq', playerId: 'user', action: 'raise', amount: 450,
        potTotal: 250, callAmount: 75, currentBet: 125,
      }),
    ],
  }));
  const vs3bet = extractUser(makeRecord({
    seated: 6,
    heroFromButton: 3,
    actions: [
      act({
        decisionId: 'd-open', playerId: 'user', action: 'raise', amount: 125,
        potTotal: 75, callAmount: 50, currentBet: 50,
      }),
      act({
        decisionId: 'd-3b', playerId: 'p4', action: 'raise', amount: 400,
        potTotal: 175, callAmount: 75, currentBet: 125,
      }),
      act({
        decisionId: 'd-hero', playerId: 'user', action: 'fold',
        potTotal: 450, callAmount: 275, currentBet: 400,
      }),
    ],
  }));

  function cells(t) {
    return {
      rfi: t.preflop.byPosition.UTG.rfi.k + t.preflop.byPosition.HJ.rfi.k
        + t.preflop.byPosition.CO.rfi.k + t.preflop.byPosition.BTN.rfi.k
        + t.preflop.byPosition.SB.rfi.k + t.preflop.byPosition.BB.rfi.k,
      limp: t.preflop.byPosition.UTG.limp.k + t.preflop.byPosition.HJ.limp.k
        + t.preflop.byPosition.CO.limp.k + t.preflop.byPosition.BTN.limp.k
        + t.preflop.byPosition.SB.limp.k + t.preflop.byPosition.BB.limp.k,
      vsRaise: t.preflop.vsRaise.n,
      vs3Bet: t.preflop.vs3Bet.n,
    };
  }

  assert.deepEqual(cells(unopened), { rfi: 1, limp: 0, vsRaise: 0, vs3Bet: 0 });
  assert.deepEqual(cells(limp), { rfi: 0, limp: 1, vsRaise: 0, vs3Bet: 0 });
  assert.deepEqual(cells(limper), { rfi: 0, limp: 0, vsRaise: 0, vs3Bet: 0 });
  assert.deepEqual(cells(singleOpen), { rfi: 0, limp: 0, vsRaise: 1, vs3Bet: 0 });
  assert.deepEqual(cells(squeeze), { rfi: 0, limp: 0, vsRaise: 0, vs3Bet: 0 });
  assert.deepEqual(cells(vs3bet), { rfi: 1, limp: 0, vsRaise: 0, vs3Bet: 1 });
});

test('bet vs raise size buckets use raise-to math', () => {
  const flopBet = extractUser(makeRecord({
    seated: 6,
    actions: [act({
      decisionId: 'd-bet', playerId: 'user', action: 'raise', amount: 200,
      street: 'flop', potTotal: 300, callAmount: 0, currentBet: 0,
      board: ['As', 'Kd', '2c'],
    })],
    board: ['As', 'Kd', '2c'],
  }));
  assert.equal(flopBet.postflop.byStreet.flop.betSizePot.buckets['0.7'], 1);

  const open = extractUser(makeRecord({
    seated: 6,
    heroFromButton: 3,
    actions: [act({
      decisionId: 'd-open', playerId: 'user', action: 'raise', amount: 125,
      potTotal: 75, callAmount: 50, currentBet: 50,
    })],
  }));
  assert.equal(open.preflop.openSizeBb.buckets['2.5'], 1);

  const threeBet = extractUser(makeRecord({
    seated: 6,
    heroFromButton: 2,
    actions: [
      act({
        decisionId: 'd-open', playerId: 'p3', action: 'raise', amount: 125,
        potTotal: 75, callAmount: 50, currentBet: 50,
      }),
      act({
        decisionId: 'd-3b', playerId: 'user', action: 'raise', amount: 425,
        potTotal: 175, callAmount: 75, currentBet: 125,
      }),
    ],
  }));
  assert.equal(threeBet.preflop.threeBetMultiple.buckets['3.4'], 1);
});

test('cbet, wtsd, wsd, and bluff have a positive and a negative case', () => {
  const flop = ['2c', '7d', '9h'];
  const cbetYes = extractUser(makeRecord({
    seated: 6,
    heroFromButton: 3,
    actions: [
      act({
        decisionId: 'd-open', playerId: 'user', action: 'raise', amount: 125,
        potTotal: 75, callAmount: 50, currentBet: 50,
      }),
      act({
        decisionId: 'd-call', playerId: 'p4', action: 'call', amount: 75,
        potTotal: 175, callAmount: 75, currentBet: 125,
      }),
      act({
        decisionId: 'd-cbet', playerId: 'user', action: 'raise', amount: 150,
        street: 'flop', potTotal: 250, callAmount: 0, currentBet: 0, board: flop,
      }),
    ],
    board: flop,
  }));
  const cbetNo = extractUser(makeRecord({
    seated: 6,
    heroFromButton: 3,
    actions: [
      act({
        decisionId: 'd-open', playerId: 'user', action: 'raise', amount: 125,
        potTotal: 75, callAmount: 50, currentBet: 50,
      }),
      act({
        decisionId: 'd-call', playerId: 'p4', action: 'call', amount: 75,
        potTotal: 175, callAmount: 75, currentBet: 125,
      }),
      act({
        decisionId: 'd-check', playerId: 'user', action: 'check',
        street: 'flop', potTotal: 250, callAmount: 0, currentBet: 0, board: flop,
      }),
    ],
    board: flop,
  }));
  assert.equal(cbetYes.postflop.cbet.n, 1);
  assert.equal(cbetYes.postflop.cbet.k, 1);
  assert.equal(cbetNo.postflop.cbet.n, 1);
  assert.equal(cbetNo.postflop.cbet.k, 0);

  const split = extractUser(readGeneratedRecord('split'));
  const side = extractUser(readGeneratedRecord('side-pot'));
  const missedFlop = extractUser(makeRecord({
    seated: 6,
    heroFromButton: 3,
    actions: [
      act({
        decisionId: 'd-call', playerId: 'user', action: 'call', amount: 50,
        potTotal: 75, callAmount: 50, currentBet: 50,
      }),
      act({
        decisionId: 'd-fold', playerId: 'user', action: 'fold',
        street: 'flop', potTotal: 150, callAmount: 50, currentBet: 50, board: flop,
      }),
    ],
    board: flop,
    folded: ['user'],
  }));
  assert.equal(split.postflop.wtsd.n, 1);
  assert.equal(split.postflop.wtsd.k, 1);
  assert.equal(split.postflop.wsd.n, 1);
  assert.equal(split.postflop.wsd.k, 1);
  assert.equal(side.postflop.wtsd.k, 1);
  assert.equal(side.postflop.wsd.n, 1);
  assert.equal(side.postflop.wsd.k, 0);
  assert.equal(missedFlop.postflop.wtsd.n, 1);
  assert.equal(missedFlop.postflop.wtsd.k, 0);

  const weak = ['2c', '7d'];
  const wet = ['As', 'Kh', 'Qd'];
  const strength = estimatePublicStrength({
    street: 'flop', holeCards: weak, board: wet, position: 'BTN',
  });
  assert.ok(strength < 0.30, `expected weak bluff hand, got ${strength}`);
  const holes = {
    user: weak, p1: ['3c', '3d'], p2: ['4c', '4d'], p3: ['5c', '5d'], p4: ['6c', '6d'], p5: ['8c', '8d'],
  };
  const bluffYes = extractUser(makeRecord({
    seated: 6,
    holes,
    board: wet,
    actions: [act({
      decisionId: 'd-bluff', playerId: 'user', action: 'raise', amount: 100,
      street: 'flop', potTotal: 150, callAmount: 0, currentBet: 0, board: wet,
    })],
  }));
  const bluffNo = extractUser(makeRecord({
    seated: 6,
    holes,
    board: wet,
    actions: [act({
      decisionId: 'd-check', playerId: 'user', action: 'check',
      street: 'flop', potTotal: 150, callAmount: 0, currentBet: 0, board: wet,
    })],
  }));
  assert.equal(bluffYes.postflop.bluff.n, 1);
  assert.equal(bluffYes.postflop.bluff.k, 1);
  assert.equal(bluffNo.postflop.bluff.n, 1);
  assert.equal(bluffNo.postflop.bluff.k, 0);
});

test('postflop AF counts bets, raises, and calls only after the flop', () => {
  const flop = ['2c', '7d', '9h'];
  const t = extractUser(makeRecord({
    seated: 6,
    actions: [
      act({
        decisionId: 'd-open', playerId: 'user', action: 'raise', amount: 125,
        potTotal: 75, callAmount: 50, currentBet: 50,
      }),
      act({
        decisionId: 'd-bet', playerId: 'user', action: 'raise', amount: 100,
        street: 'flop', potTotal: 200, callAmount: 0, currentBet: 0, board: flop,
      }),
      act({
        decisionId: 'd-call', playerId: 'user', action: 'call', amount: 150,
        street: 'turn', potTotal: 400, callAmount: 150, currentBet: 250, board: [...flop, '3s'],
      }),
      act({
        decisionId: 'd-raise', playerId: 'user', action: 'raise', amount: 600,
        street: 'river', potTotal: 700, callAmount: 100, currentBet: 100,
        board: [...flop, '3s', '4c'],
      }),
    ],
    board: [...flop, '3s', '4c'],
  }));
  assert.deepEqual(t.postflop.af, { bets: 1, raises: 1, calls: 1 });
});

test('extracting 115 archived hands stays under 1s', () => {
  const record = readGeneratedRecord('split');
  const records = Array.from({ length: 115 }, () => record);
  const start = Date.now();
  const t = tendencyFromRecords(records, 'user');
  const elapsed = Date.now() - start;
  assert.equal(t.hands, 115);
  assert.ok(elapsed < 1000, `extract took ${elapsed}ms`);
});

test('entered keys of a real extract stay inside 6×169', () => {
  const t = extractUser(makeRecord({ seated: 6, heroFromButton: 0 }));
  assertTendency(t);
  for (const pos of Object.keys(t.preflop.entered)) {
    assert.equal(POSITIONS.includes(pos), true);
    for (const handClass of Object.keys(t.preflop.entered[pos])) {
      assert.equal(HAND_CLASSES.includes(handClass), true);
    }
  }
});
