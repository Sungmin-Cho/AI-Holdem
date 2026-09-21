/** All amounts are total committed chips on this street (raise-to). */
export function clampRaiseTo(value, legal) {
  const max = Math.max(0, Number(legal.maxRaiseTo) || 0);
  const min = Math.min(max, Math.max(0, Number(legal.minRaiseTo) || 0));
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : min;
}

export function potRaiseTo(legal, actorBet, fraction) {
  return clampRaiseTo(actorBet + legal.callAmount + fraction * (legal.potTotal + legal.callAmount), legal);
}

export function bbRaiseTo(legal, bb, multiple) {
  const amount = Number(bb) * multiple;
  return legal.canRaise && legal.minRaiseTo <= amount && amount <= legal.maxRaiseTo
    && Number.isSafeInteger(amount) ? amount : null;
}

export function reviewDismissalAfterUpdate(dismissed) {
  return dismissed === true;
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
  if (view.viewer === view.toAct && view.legal?.decisionId !== deadline.decisionId) return null;
  return deadline;
}

export function serverClockOffset(dateHeader, receivedAt = Date.now()) {
  const at = typeof dateHeader === 'string' ? Date.parse(dateHeader) : NaN;
  return Number.isFinite(at) ? at - receivedAt : 0;
}
