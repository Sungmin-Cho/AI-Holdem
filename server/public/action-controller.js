const WAITING = new Set(['sending', 'reconciling', 'accepted', 'delivered', 'consumed', 'unknown', 'unreceived']);
const PHASES = new Set(['accepted', 'delivered', 'consumed', 'rejected']);
const MESSAGES = {
  idle: '내 차례입니다. 액션을 선택하세요.',
  sending: '액션을 전송하고 있습니다…',
  reconciling: '접수 기록과 현재 차례를 확인하고 있습니다…',
  accepted: '액션이 접수되었습니다. 게임 진행을 기다려 주세요.',
  delivered: '접수된 액션을 처리하고 있습니다. 다시 누를 필요가 없습니다.',
  consumed: '액션 처리가 끝났습니다. 다음 차례를 기다려 주세요.',
  rejected: '액션이 거부되었습니다. 현재 가능한 액션을 다시 선택하세요.',
  unreceived: '현재 접수 기록은 없지만 이전 전송이 도착할 수 있습니다. 같은 액션만 다시 확인할 수 있습니다.',
  unknown: '접수 여부를 확인할 수 없습니다. 연결 복구 후 상태 확인을 눌러 주세요.',
  storage: '복구 정보를 저장할 수 없습니다. 브라우저 저장 공간을 확인한 뒤 새로고침하세요.',
};

/** Network/auth adapters are injected. Only a hash of the authenticated game token
 * identifies the game. Credentials never enter the persisted request object. */
export function createActionController({ gameEpoch, postAction, getSnapshot, getStatus, storage,
  onState = () => {}, onSnapshot = () => {}, uuid = () => {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }, timeoutMs = 8000 } = {}) {
  let view = null;
  let request = null;
  let phase = 'unknown';
  let errorCode = null;
  let notice = null;
  let revision = 0;
  let inflight = null;
  let viewRevision = 0;
  let requestGeneration = 0;
  let knownReceipt = null;
  let sendingCount = 0;
  let storageLoaded = false;
  let closedDecisionId = null;
  const receiptRank = { accepted: 1, delivered: 2, consumed: 3 };
  const key = typeof gameEpoch === 'string' && gameEpoch ? `holdem.action.v1.${gameEpoch}` : null;
  const currentId = () => view?.legal?.decisionId ?? null;
  const state = () => Object.freeze({ phase, requestId: request?.requestId ?? null,
    decisionId: currentId(), canRetry: Boolean(request && request.decisionId === currentId() && !view?.gameOver && !sendingCount && !knownReceipt && ['unreceived', 'unknown'].includes(phase)), disabled: !currentId() || Boolean(view?.gameOver) || WAITING.has(phase),
    notice: notice ? Object.freeze({...notice}) : null,
    message: phase === 'idle' && !currentId() ? (view?.gameOver ? '게임이 끝났습니다. 학습실에서 복습을 이어갈 수 있습니다.' : '다른 플레이어의 차례를 기다리고 있습니다.') : (MESSAGES[errorCode === 'STORAGE' ? 'storage' : phase] ?? MESSAGES.unknown), errorCode });
  const emit = () => { const next = state(); onState(next); return next; };
  const setPhase = (next, code = null) => { phase = next; errorCode = code; return emit(); };
  function load() {
    storageLoaded = false;
    if (!key) throw new Error('GAME_IDENTITY_UNAVAILABLE');
    const raw = storage.getItem(key);
    if (!raw) { storageLoaded = true; return; }
    const stored = JSON.parse(raw);
    if (typeof stored.decisionId !== 'string' || typeof stored.requestId !== 'string'
      || !['fold', 'check', 'call', 'raise'].includes(stored.action)
      || (stored.action === 'raise' && !Number.isSafeInteger(stored.amount))) throw new Error('STORAGE');
    if (stored.decisionId === currentId()) capture(stored);
    storageLoaded = true;
  }
  function capture(value) {
    const next = Object.freeze({
      decisionId: value.decisionId, requestId: value.requestId, action: value.action,
      ...(value.action === 'raise' ? { amount: value.amount } : {}),
      ...(typeof value.note === 'string' ? { note: value.note } : {}),
    });
    if (JSON.stringify(next) === JSON.stringify(request)) return;
    requestGeneration += 1; knownReceipt = null; request = next;
  }
  function release() {
    request = null; requestGeneration += 1; knownReceipt = null;
    storage.removeItem?.(key);
  }
  function rememberReceipt(receipt) {
    if (knownReceipt?.decisionId === receipt.decisionId && knownReceipt.requestId === receipt.requestId
      && receiptRank[knownReceipt.phase] > receiptRank[receipt.phase]) return;
    knownReceipt = { decisionId: receipt.decisionId, requestId: receipt.requestId, phase: receipt.phase };
  }
  function persist(next) {
    try { storage.setItem(key, JSON.stringify(next)); capture(next); return true; }
    catch { notice={code:'STORAGE'};setPhase('unknown', 'STORAGE'); return false; }
  }
  async function bounded(fn) {
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => fn({ signal: controller.signal })),
        new Promise((_, reject) => { timer = setTimeout(() => {
          controller.abort(); reject(new Error('TIMEOUT'));
        }, timeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
  }
  async function reconcile() {
    if (inflight) return inflight;
    const ticket = ++revision;
    setPhase('reconciling');
    inflight = (async () => {
      try {
        const snapshot = await bounded(getSnapshot);
        const receipt = await bounded(getStatus);
        if (ticket !== revision) return state();
        if (!key || !snapshot || snapshot.ok === false || !('view' in snapshot)
          || receipt?.ok !== true) throw new Error('AUTHORITY_UNAVAILABLE');
        if (Number.isInteger(snapshot.revision) && snapshot.revision < viewRevision) throw new Error('STALE_SNAPSHOT');
        const decisionId = snapshot.view?.legal?.decisionId ?? null;
        if (receipt.decisionId !== decisionId) throw new Error('STALE_STATUS');
        if(decisionId!==currentId())notice=null;
        view = snapshot.view;
        if (Number.isInteger(snapshot.revision)) viewRevision = snapshot.revision;
        // An unreceived server read cannot replace an unread local intent.
        // Retry initialization against this authoritative decision before unlock.
        if (!storageLoaded) load();
        onSnapshot(snapshot);
        if ((request && request.decisionId !== decisionId) || (knownReceipt && knownReceipt.decisionId !== decisionId)) release();
        if ((receipt.phase === null || receipt.phase === 'unreceived') && receipt.requestId === null) {
          // A read is not a cancellation fence. It may race any previously
          // issued POST, including one whose fetch rejected or timed out.
          return setPhase(knownReceipt?.phase ?? (request ? 'unreceived' : 'idle'));
        }
        if (!PHASES.has(receipt.phase) || typeof receipt.requestId !== 'string' || !receipt.requestId) {
          throw new Error('INVALID_STATUS');
        }
        // A receipt belonging to another tab also blocks this tab. A rejection
        // is authoritative for correction only when it is our request (or none).
        if (receipt.phase === 'rejected') {
          if (request && receipt.requestId !== request.requestId) throw new Error('RECEIPT_MISMATCH');
          release();
          notice={code:['STALE_DECISION','ILLEGAL_ACTION','VERSION_MISMATCH'].includes(receipt.reason)?receipt.reason:'ACTION_REJECTED'};
          return setPhase('rejected');
        }
        rememberReceipt(receipt);
        return setPhase(knownReceipt.phase);
      } catch (error) {
        if (ticket === revision) return setPhase('unknown', error.message);
        return state();
      } finally { inflight = null; }
    })();
    return inflight;
  }
  return {
    get state() { return state(); },
    async connect(snapshot) {
      if((snapshot?.view?.legal?.decisionId??null)!==currentId())notice=null;
      view = snapshot?.view ?? null;
      if (Number.isInteger(snapshot?.revision)) viewRevision = Math.max(viewRevision, snapshot.revision);
      try { load(); } catch (error) {return setPhase('unknown', error.message); }
      return reconcile();
    },
    observe(nextView, { revision: nextRevision } = {}) {
      if (Number.isInteger(nextRevision)) {
        if (nextRevision < viewRevision) return;
        viewRevision = nextRevision;
      }
      const before = currentId();
      view = nextView;
      if (currentId() !== closedDecisionId) closedDecisionId = null;
      if (currentId() !== before) { notice=null;setPhase('unknown'); void reconcile(); }
      else emit();
    },
    disconnect() { ++revision; return setPhase('unknown'); },
    reconcile,
    send: sendAction,
    async retry() {
      if (!state().canRetry) return state();
      return sendAction(request.action, request.amount);
    },
  };

  async function sendAction(action, amount, note) {
    if (closedDecisionId && currentId() === closedDecisionId) return state();
    const unchanged = request?.decisionId === currentId() && request.action === action
      && request.amount === (action === 'raise' ? amount : undefined);
    if (!key || (request && !unchanged) || (state().disabled && !(unchanged && state().canRetry))) return state();
    if (!['fold', 'check', 'call', 'raise'].includes(action)
      || (action === 'raise' && !Number.isSafeInteger(amount))) return state();
    if (!request && !persist({
      decisionId: currentId(), requestId: uuid(), action,
      ...(action === 'raise' ? { amount } : {}),
      ...(typeof note === 'string' ? { note } : {}),
    })) return state();
    const captured = request;
    const generation = requestGeneration;
    const stillCurrent = () => requestGeneration === generation && request === captured && currentId() === captured.decisionId;
    sendingCount += 1;
    setPhase('sending');
    try {
      const result = await bounded(async (options) => {
        const response = await postAction(captured, options);
        // Observe a late settlement even after the timeout race has ended, but
        // never resurrect a request terminalized by rejection/advancement.
        if (stillCurrent() && response?.ok === true) {
          notice=null;
          if (!knownReceipt || knownReceipt.requestId === captured.requestId) {
            rememberReceipt({ decisionId: captured.decisionId, requestId: captured.requestId, phase: 'accepted' });
          }
          setPhase(knownReceipt.phase);
        }
        return response;
      });
      if (stillCurrent() && result?.ok !== true) {
        notice={code:result?.code??'NETWORK_ERROR'};
        if (result && ['DECISION_CLOSED', 'STALE_DECISION'].includes(result.code)) {
          closedDecisionId = captured.decisionId;
          release();
          return setPhase('idle', result.code);
        }
        await reconcile();
      }
    } catch (error) {
      if (stillCurrent()) { notice={code:error.code??error.message};errorCode = error.message; await reconcile(); }
    } finally { sendingCount -= 1; emit(); }
    return state();
  }
}

const NOTICE_MESSAGES={
  GAME_PAUSED:'게임이 일시정지 중입니다. 재개한 뒤 행동하세요.',
  NOT_YOUR_TURN:'지금은 내 차례가 아닙니다.',
  DECISION_CLOSED:'이 차례는 이미 끝났습니다. 다음 차례를 기다려 주세요.',
  STALE_DECISION:'차례가 바뀌었습니다. 현재 화면을 확인하세요.',
  BAD_ACTION:'현재 가능한 액션과 금액을 확인하세요.',
  ILLEGAL_ACTION:'현재 가능한 액션과 금액을 확인하세요.',
  ACTION_REJECTED:'액션이 거절됐습니다. 현재 가능한 액션을 확인하세요.',
  ACTION_ALREADY_RECEIVED:'이미 액션을 접수했습니다. 처리를 기다려 주세요.',
  RATE_LIMIT:'요청이 많습니다. 잠시 후 다시 확인하세요.',
  SESSION_INACTIVE:'게임이 종료되었습니다.',
  STALE_GAME:'게임이 변경됐습니다. 로비에서 현재 게임을 확인하세요.',
  VERSION_MISMATCH:'상태가 바뀌어 다시 맞추고 있습니다.',
  RELAY_UNAVAILABLE:'게임 연결을 복구하고 있습니다. 잠시 기다려 주세요.',
  SESSION_UNAVAILABLE:'게임 연결을 복구하고 있습니다. 잠시 기다려 주세요.',
  STORAGE:'복구 정보를 저장할 수 없습니다. 브라우저 저장 공간을 확인하세요.',
};
export function formatActionNotice(notice) {
  return notice ? NOTICE_MESSAGES[notice.code]??'요청 결과를 확인하지 못했습니다. 연결 상태를 확인해 주세요.' : '';
}
