// Bound private diagnostics by count AND the existing app JSON reader's byte limit.
export function boundJevDiagnostics(state) {
  const d = state.jevDiagnostics;
  if (!Object.hasOwn(state, 'jevDiagnostics')) return false;
  if (!d || typeof d !== 'object' || Array.isArray(d) || d.schemaVersion !== 1 || !Array.isArray(d.entries) || !Number.isSafeInteger(d.dropped) || d.dropped < 0) {
    state.jevDiagnostics = {schemaVersion:1,entries:[],
      dropped:Number.isSafeInteger(d?.dropped) && d.dropped >= 0 ? d.dropped : 0,historyIncomplete:true};
    return true;
  }
  const baseBytes = Buffer.byteLength(JSON.stringify({...state,jevDiagnostics:{schemaVersion:1,entries:[],dropped:d.dropped}}));
  const budget = Math.max(0, Math.min(256 * 1024, 2 * 1024 * 1024 - 64 * 1024 - baseBytes));
  let bytes = 0, start = d.entries.length;
  while (start > 0 && d.entries.length - start < 5000) {
    const n = Buffer.byteLength(JSON.stringify(d.entries[start - 1])) + 1;
    if (bytes + n > budget) break;
    bytes += n; start--;
  }
  state.jevDiagnostics = {schemaVersion:1,entries:d.entries.slice(start),dropped:d.dropped+start,
    ...(d.historyIncomplete ? {historyIncomplete:true} : {})};
  return false;
}
