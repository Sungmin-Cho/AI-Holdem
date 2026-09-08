import { handAssistanceDisposition } from '../../shared/assistance.js';
import { estimatePublicStrength } from '../policies/hand-strength.js';
import {
  HAND_CLASSES,
  POSITIONAL_SEATS,
  STREETS,
  bucketKey,
  emptyTendency,
  handClassOf,
  mergeTendency,
  normalizePosition,
} from './contracts.js';
import { positionsFromRecord } from './positions.js';

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

function firstRaiseAmount(actions, index) {
  for (let i = 0; i < index; i += 1) {
    const row = actions[i];
    if (row?.street === 'preflop' && row.action === 'raise' && Number.isFinite(row.amount)) {
      return row.amount;
    }
  }
  return null;
}

function addBucket(hist, value, step) {
  const key = bucketKey(value, step);
  if (key == null) return;
  hist.n += 1;
  hist.buckets[key] = (hist.buckets[key] ?? 0) + 1;
}

function wonContested(record, playerId) {
  for (const pot of record.pots ?? []) {
    if (!Array.isArray(pot?.eligible) || pot.eligible.length < 2) continue;
    if ((pot.winners ?? []).some((row) => row?.playerId === playerId && (row.share ?? 0) > 0)) {
      return true;
    }
  }
  return false;
}

export function extractHandTendency(record, playerId, { forcedDecisionIds, strengthSamples = 32 } = {}) {
  const t = emptyTendency(playerId);
  if (playerId === 'user') {
    const assistance = handAssistanceDisposition(record);
    if (assistance !== 'independent') {
      t.excludedAssistedHands = assistance === 'assisted' ? 1 : 0;
      t.excludedUnknownAssistanceHands = assistance === 'unavailable' ? 1 : 0;
      return t;
    }
  }
  if (!record?.holes?.[playerId]) return t;
  t.hands = 1;
  const posInfo = positionsFromRecord(record);
  const seated = posInfo.seated;
  t.seatMix[seated] = (t.seatMix[seated] ?? 0) + 1;
  const engineLabel = posInfo[playerId];
  const pos = normalizePosition(engineLabel, seated);
  const positional = POSITIONAL_SEATS.includes(seated) && pos != null;
  const holeCards = record.holes[playerId];
  const bb = record.blinds?.[1] || 50;
  const forced = new Set(forcedDecisionIds ?? []);
  const actions = Array.isArray(record.actions) ? record.actions : [];
  const foldedSet = new Set(record.folded ?? []);

  if (positional) {
    t.preflop.byPosition[pos].dealt = 1;
    t.preflop.byPosition[pos].vpip.n = 1;
    const handClass = handClassOf(holeCards);
    if (handClass && HAND_CLASSES.includes(handClass)) {
      t.preflop.entered[pos][handClass].n = 1;
    }
  }

  let lastPreflopAggressor = null;
  let heroOpened = false;
  let heroVpip = false;
  let heroPfr = false;
  let heroLimp = false;
  let foldedPre = false;
  let heroFlopActed = false;

  for (let i = 0; i < actions.length; i += 1) {
    const row = actions[i];
    if (!row) continue;
    if (row.street === 'preflop' && row.action === 'raise') lastPreflopAggressor = row.playerId;
    if (row.playerId !== playerId) continue;

    if (row.street === 'preflop' && row.action === 'fold') foldedPre = true;
    const isForced = forced.has(row.decisionId);
    if (!isForced) t.decisions += 1;
    if (isForced) continue;

    if (row.street === 'preflop') {
      const prior = priorPreflop(actions, i);
      const unopened = prior.raises === 0 && prior.calls === 0;
      const singleOpen = prior.raises === 1 && prior.calls === 0;
      const vs3Bet = heroOpened && prior.raises === 2;
      const voluntary = row.action === 'call' || row.action === 'raise';

      if (voluntary) {
        heroVpip = true;
        if (positional) {
          t.preflop.byPosition[pos].vpip.k = 1;
          const handClass = handClassOf(holeCards);
          if (handClass && HAND_CLASSES.includes(handClass)) {
            t.preflop.entered[pos][handClass].k = 1;
          }
        }
      }
      if (row.action === 'raise') {
        heroPfr = true;
        if (unopened) heroOpened = true;
      }
      if (unopened && row.action === 'call') heroLimp = true;

      if (positional && unopened) {
        t.preflop.byPosition[pos].rfi.n += 1;
        t.preflop.byPosition[pos].limp.n += 1;
        if (row.action === 'raise') t.preflop.byPosition[pos].rfi.k += 1;
        if (row.action === 'call') t.preflop.byPosition[pos].limp.k += 1;
      }
      if (singleOpen) {
        t.preflop.vsRaise.n += 1;
        if (row.action === 'fold') t.preflop.vsRaise.fold += 1;
        else if (row.action === 'call') t.preflop.vsRaise.call += 1;
        else if (row.action === 'raise') t.preflop.vsRaise.raise += 1;
        if (positional) {
          t.preflop.byPosition[pos].vsRaise.n += 1;
          if (row.action === 'fold') t.preflop.byPosition[pos].vsRaise.fold += 1;
          else if (row.action === 'call') t.preflop.byPosition[pos].vsRaise.call += 1;
          else if (row.action === 'raise') t.preflop.byPosition[pos].vsRaise.raise += 1;
        }
      }
      if (vs3Bet) {
        t.preflop.vs3Bet.n += 1;
        if (row.action === 'fold') t.preflop.vs3Bet.fold += 1;
        else if (row.action === 'call') t.preflop.vs3Bet.call += 1;
        else if (row.action === 'raise') t.preflop.vs3Bet.raise += 1;
      }
      if (unopened && row.action === 'raise' && Number.isFinite(row.amount) && bb > 0) {
        addBucket(t.preflop.openSizeBb, row.amount / bb, 0.5);
      }
      if (singleOpen && row.action === 'raise' && Number.isFinite(row.amount)) {
        const openTo = firstRaiseAmount(actions, i);
        if (openTo > 0) addBucket(t.preflop.threeBetMultiple, row.amount / openTo, 0.1);
      }
      continue;
    }

    if (!STREETS.includes(row.street)) continue;
    const street = row.street;
    const facing = (row.callAmount ?? 0) > 0;
    const checkedTo = (row.callAmount ?? 0) === 0;

    if (facing) {
      t.postflop.byStreet[street].facingBet.n += 1;
      if (row.action === 'fold') t.postflop.byStreet[street].facingBet.fold += 1;
      else if (row.action === 'call') t.postflop.byStreet[street].facingBet.call += 1;
      else if (row.action === 'raise') t.postflop.byStreet[street].facingBet.raise += 1;
    } else if (checkedTo) {
      t.postflop.byStreet[street].checkedTo.n += 1;
      if (row.action === 'check') t.postflop.byStreet[street].checkedTo.check += 1;
      else if (row.action === 'raise') t.postflop.byStreet[street].checkedTo.bet += 1;
      try {
        const strength = estimatePublicStrength({
          street,
          holeCards,
          board: row.board ?? record.board ?? [],
          position: engineLabel,
        }, { samples: strengthSamples });
        if (strength < 0.30) {
          t.postflop.bluff.n += 1;
          if (row.action === 'raise') t.postflop.bluff.k += 1;
        }
      } catch {
        /* public cards may be incomplete on handmade fixtures */
      }
    }

    if (row.action === 'call') t.postflop.af.calls += 1;
    if (row.action === 'raise') {
      if ((row.currentBet ?? 0) === 0) {
        t.postflop.af.bets += 1;
        const pot = row.potTotal ?? 0;
        if (pot > 0 && Number.isFinite(row.amount)) {
          addBucket(t.postflop.byStreet[street].betSizePot, row.amount / pot, 0.1);
        }
      } else {
        t.postflop.af.raises += 1;
      }
    }

    if (street === 'flop' && !heroFlopActed) {
      heroFlopActed = true;
      if (lastPreflopAggressor === playerId && (row.currentBet ?? 0) === 0) {
        t.postflop.cbet.n += 1;
        if (row.action === 'raise') t.postflop.cbet.k += 1;
      }
    }
  }

  t.preflop.vpip.n = 1;
  t.preflop.pfr.n = 1;
  t.preflop.limp.n = 1;
  if (heroVpip) t.preflop.vpip.k = 1;
  if (heroPfr) t.preflop.pfr.k = 1;
  if (heroLimp) t.preflop.limp.k = 1;

  const board = record.board ?? [];
  const sawFlop = board.length >= 3 && !foldedPre;
  const wentToShowdown = sawFlop && record.showdown != null && !foldedSet.has(playerId);
  t.postflop.wtsd.n = sawFlop ? 1 : 0;
  t.postflop.wtsd.k = wentToShowdown ? 1 : 0;
  t.postflop.wsd.n = wentToShowdown ? 1 : 0;
  t.postflop.wsd.k = wentToShowdown && wonContested(record, playerId) ? 1 : 0;
  return t;
}

export function tendencyFromRecords(records, playerId, { sources, strengthSamples } = {}) {
  let t = emptyTendency(playerId);
  for (const record of records ?? []) {
    const forcedDecisionIds = (record?.decisions ?? [])
      .filter((row) => row?.forced === true)
      .map((row) => row.decisionId);
    t = mergeTendency(t, extractHandTendency(record, playerId, { forcedDecisionIds, strengthSamples }));
  }
  if (Array.isArray(sources) && sources.length) {
    t = { ...t, sources: [...t.sources, ...sources] };
  }
  return t;
}
