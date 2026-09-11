const KEY = 'holdem.display-unit.v1';

/** Display only. Engine/action amounts remain integer chips. */
export function formatAmount(chips, bb, preference = 'bb', signed = false) {
  if (!Number.isSafeInteger(chips)) return {primary: '—', secondary: ''};
  const sign = chips < 0 ? '−' : signed && chips > 0 ? '+' : '';
  const chipText = `${sign}${Math.abs(chips).toLocaleString('ko-KR')} 칩`;
  if (!Number.isSafeInteger(bb) || bb <= 0) return {primary: chipText, secondary: 'BB 기준 없음'};
  // Integer arithmetic also avoids false rounding/exactness at large safe amounts.
  const numerator = BigInt(Math.abs(chips)) * 100n;
  const denominator = BigInt(bb);
  let bbText;
  if (numerator > 0n && numerator < denominator) bbText = `${sign}<0.01 BB`;
  else {
    const rounded = (numerator * 2n + denominator) / (2n * denominator);
    const decimals = String(rounded % 100n).padStart(2, '0').replace(/0+$/, '');
    bbText = `${numerator % denominator ? '≈' : ''}${sign}${(rounded / 100n).toLocaleString('ko-KR')}${decimals ? `.${decimals}` : ''} BB`;
  }
  return preference === 'chips' ? {primary: chipText, secondary: bbText} : {primary: bbText, secondary: chipText};
}

export function formatSignedAmount(chips, bb, preference = 'bb') {
  return formatAmount(chips, bb, preference, true);
}
export function readPreference(storage) {
  try { return (storage ?? globalThis.localStorage)?.getItem(KEY) === 'chips' ? 'chips' : 'bb'; }
  catch { return 'bb'; }
}
export function writePreference(value, storage) {
  if (!['bb', 'chips'].includes(value)) return false;
  try { const target = storage ?? globalThis.localStorage; if (!target) return false; target.setItem(KEY, value); return true; }
  catch { return false; }
}
