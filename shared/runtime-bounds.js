// Server/runtime helpers; not a browser-served shared asset.
/** Keep diagnostics bounded without changing the newest decision evidence. */
export function appendBoundedMetric(state, metric) {
  const rows = [...(Array.isArray(state?.metrics) ? state.metrics : []), metric];
  const dropped = Math.max(0, rows.length - 5000);
  const prior = Number.isSafeInteger(state?.metricsDropped) && state.metricsDropped >= 0 ? state.metricsDropped : 0;
  return { metrics: dropped ? rows.slice(dropped) : rows, metricsDropped: prior + dropped };
}

/** Discard startup narration and completed hands only at a hand boundary. The current hand stays. */
export function trimHandLog(log) {
  const budget = 1024 * 1024;
  const sizes = log.map(row => Buffer.byteLength(JSON.stringify(row)) + 1);
  let bytes = sizes.reduce((sum, size) => sum + size, 1);
  if (bytes <= budget) return log;
  const starts = [];
  for (let i = 0; i < log.length; i++) if (log[i]?.type === 'hand_start') starts.push(i);
  if (!starts.length) return log;
  let first = 0;
  for (const boundary of starts) {
    if (bytes <= budget) break;
    while (first < boundary) bytes -= sizes[first++];
  }
  return first ? log.slice(first) : log;
}

export function pruneJoinAttempts(attempts, now) {
  if (attempts.size <= 1024) return;
  for (const [key, row] of attempts) if (now - row.start > 60000) attempts.delete(key);
}
