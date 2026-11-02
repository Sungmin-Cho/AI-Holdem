// #339, #343: one network call of a one-shot Node process, ended at its budget whatever fetch does.
//
// AbortSignal.timeout's timer does not keep the process alive, and when a server drops the
// connection before it reads the request, fetch on Node 20 (and on Node 22 on Windows) never
// settles: the event loop then empties and a process whose only pending work is that call exits 13
// with its top-level await unsettled — no reply, no message. This one ref'd timer, of the same
// budget, aborts the request and rejects whatever the caller is awaiting (`settle`) at the budget
// and never later; `release` clears it as soon as the call is over, so it holds nothing past it.
// Await the request *and* every read of its body through `settle`: a 200 whose body never ends
// is the same stall one step later.
//
// The rejection is the one AbortSignal.timeout gives (a DOMException named TimeoutError), so a
// caller that classifies a timeout keeps classifying it the same way. A budget is a whole number
// of milliseconds a timer can hold: a value AbortSignal.timeout refused still fails before
// anything is sent, and so does one past 2^31-1, which a timer (AbortSignal.timeout's too) would
// cut to 1ms with only a warning.
//
// Node only: this module is never served to a browser (shared/ is).
export const MAX_NETWORK_BUDGET_MS = 0x7FFF_FFFF;
export function boundedNetworkCall(budgetMs) {
  if (!Number.isInteger(budgetMs) || budgetMs < 0 || budgetMs > MAX_NETWORK_BUDGET_MS) {
    throw new RangeError('network budget must be a whole number of milliseconds');
  }
  const controller = new AbortController();
  let expire;
  const expired = new Promise((_, reject) => { expire = reject; });
  expired.catch(() => {});
  const timer = setTimeout(() => {
    const reason = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    controller.abort(reason);
    expire(reason);
  }, budgetMs);
  return {
    signal: controller.signal,
    settle: (pending) => Promise.race([pending, expired]),
    release: () => clearTimeout(timer),
  };
}
