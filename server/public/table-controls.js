/** All amounts are total committed chips on this street (raise-to). */
export function clampRaiseTo(value, legal) {
  const max = Math.max(0, Number(legal.maxRaiseTo) || 0);
  const min = Math.min(max, Math.max(0, Number(legal.minRaiseTo) || 0));
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : min;
}

/** A slider position in big-blind mode: the nearest half big blind, except
 * that the legal ends stay exact (an all-in is rarely a whole number of BB). */
export function snapRaiseTo(value, legal, bb) {
  const max = Math.max(0, Number(legal.maxRaiseTo) || 0);
  const min = Math.min(max, Math.max(0, Number(legal.minRaiseTo) || 0));
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n <= min) return min;
  if (n >= max) return max;
  const step = Number(bb) / 2;
  return step > 0 ? clampRaiseTo(Math.round(n / step) * step, legal) : clampRaiseTo(n, legal);
}

export function potRaiseTo(legal, actorBet, fraction) {
  return clampRaiseTo(actorBet + legal.callAmount + fraction * (legal.potTotal + legal.callAmount), legal);
}

export function bbRaiseTo(legal, bb, multiple) {
  const amount = Number(bb) * multiple;
  return legal.canRaise && legal.minRaiseTo <= amount && amount <= legal.maxRaiseTo
    && Number.isSafeInteger(amount) ? amount : null;
}

/** Default raise-to when a decision opens: a 2.5bb open unopened, three times
 * the bet when facing one, half pot for a first postflop bet. The minimum
 * raise was the old default and pushed every raise to the smallest size. */
export function defaultRaiseTo(view, legal) {
  if (!legal?.canRaise) return legal?.minRaiseTo ?? 0;
  const bb = Number(view?.blinds?.[1]) || 0;
  const currentBet = Math.max(0, ...(view?.seats ?? []).map((seat) => Number(seat.bet) || 0));
  const myBet = Number(view?.seats?.find((seat) => seat.playerId === view?.viewer)?.bet) || 0;
  if (view?.street === 'preflop') {
    if (currentBet <= bb) return clampRaiseTo(Math.round(2.5 * bb), legal);
    return clampRaiseTo(3 * currentBet, legal);
  }
  if (currentBet === 0) return potRaiseTo(legal, myBet, 0.5);
  return clampRaiseTo(3 * currentBet, legal);
}

/** Verb for the primary wager button, sharing replay-format actionVerbs' rule:
 * a street with chips already in (preflop always, blinds count) makes the
 * wager a raise, an empty street makes it a bet, and the maximum is all-in. */
export function primaryVerb(view, amount) {
  const legal = view?.legal;
  if (legal && Number.isSafeInteger(amount) && Number.isSafeInteger(legal.maxRaiseTo) && amount >= legal.maxRaiseTo) return 'allin';
  const wagered = view?.street === 'preflop'
    || (view?.seats ?? []).some((seat) => Number.isSafeInteger(seat.bet) && seat.bet > 0);
  return wagered ? 'raise' : 'bet';
}
export const PRIMARY_VERB_LABEL = Object.freeze({ bet: '벳', raise: '레이즈', allin: '올인' });

export function reviewDismissalAfterUpdate(dismissed) {
  return dismissed === true;
}

/** Whole seconds left in a timed level at server time `serverNow`: the clock
 * only runs down while play time runs (`running`), and stops at zero — the
 * next hand then starts the next level. Null without a valid clock. */
export function levelSecondsLeft(clock, serverNow = Date.now()) {
  if (!clock || !Number.isSafeInteger(clock.remainingMs)) return null;
  const at = Date.parse(clock.at);
  if (!Number.isFinite(at)) return null;
  const left = clock.running ? clock.remainingMs - Math.max(0, serverNow - at) : clock.remainingMs;
  return Math.max(0, Math.ceil(left / 1000));
}

/** "1:05" for the next level; "다음 핸드" once the level's time is up. */
export function formatLevelSeconds(seconds) {
  if (!Number.isSafeInteger(seconds) || seconds < 0) return null;
  if (seconds === 0) return '다음 핸드';
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function formatTurnDeadline(deadline, now = Date.now()) {
  const at = deadline && typeof deadline === 'object' ? deadline.at : deadline;
  if (typeof at !== 'string') return null;
  const ms = Date.parse(at) - now;
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return '제한 시간 종료';
  return `남은 시간 ${Math.ceil(ms / 1000)}초`;
}

export function formatNarration(item, seats = []) {
  if (!item || typeof item !== 'object') return '';
  const nameOf = (id) => seats.find((seat) => seat.playerId === id)?.name
    ?? (id === 'user' ? '호스트' : id === undefined ? '' : `참가자 ${String(id).replace(/^h/, '')}`);
  if (item.code === 'TIMEOUT_FOLD') return `${nameOf(item.params?.playerId)} 시간 초과로 폴드했습니다.`;
  if (item.code === 'TIMEOUT_CHECK') return `${nameOf(item.params?.playerId)} 시간 초과로 체크했습니다.`;
  if (item.code === 'LEVEL_UP') return `블라인드가 ${item.params?.sb}/${item.params?.bb}로 올랐습니다.`;
  if (item.code === 'RESYNC') return '상태를 다시 맞췄습니다.';
  if (item.code === 'ILLEGAL_RETRY') return '잘못된 행동이 있어 다시 시도합니다.';
  return typeof item.text === 'string' ? item.text : '';
}

export function studyLink(value, selectors = {}) {
  try {
    const url = new URL(value);
    const fragment = new URLSearchParams(url.hash.slice(1));
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1'
      || !/^\d+$/.test(url.port) || Number(url.port) < 1 || Number(url.port) > 65535
      || url.username || url.password || url.pathname !== '/' || url.search
      || [...fragment.keys()].length !== 1 || !/^[0-9a-f]{64}$/.test(fragment.get('token') ?? '')) return null;
    for (const key of ['mode', 'spotKey', 'handClass']) {
      if (selectors[key] != null && /^[a-zA-Z0-9-]{1,100}$/.test(selectors[key])) url.searchParams.set(key, selectors[key]);
    }
    return url.href;
  } catch { return null; }
}


export function retainTurnDeadline(previous, incoming, previousView, view) {
  const deadline = incoming === undefined ? previous : incoming;
  if (!deadline || !view?.toAct || view.handInProgress === false) return null;
  if (incoming === undefined && (previousView?.toAct !== view.toAct || previousView?.handNo !== view.handNo)) return null;
  if ((Object.hasOwn(view,'viewer') ? view.viewer : 'user') === view.toAct && view.legal?.decisionId !== deadline.decisionId) return null;
  return deadline;
}

export function serverClockOffset(dateHeader, receivedAt = Date.now(), requestedAt = receivedAt) {
  const at = typeof dateHeader === 'string' ? Date.parse(dateHeader) : NaN;
  // HTTP Date has one-second precision; use its midpoint and half the round trip.
  return Number.isFinite(at) ? at + 500 + Math.max(0,receivedAt-requestedAt)/2 - receivedAt : 0;
}
