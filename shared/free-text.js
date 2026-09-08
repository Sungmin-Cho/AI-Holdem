export const REASON_MAX_CHARS = 160;
export const NOTE_MAX_CHARS = 160;
export const REASON_MAX_BYTES = 512;
export const NOTE_MAX_BYTES = 512;
export const META_FILE_MAX_BYTES = 8192;

const CONTROL = /[\u0000-\u001F\u007F-\u009F]/g;

export function normalizeFreeText(value, { maxChars, maxBytes } = {}) {
  if (typeof value !== 'string') return null;
  let text = value.normalize('NFC').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (Number.isInteger(maxChars) && maxChars >= 0) {
    text = [...text].slice(0, maxChars).join('').trim();
    if (!text) return null;
  }
  if (Number.isInteger(maxBytes) && maxBytes >= 0) {
    while (text && Buffer.byteLength(JSON.stringify(text)) > maxBytes) {
      text = [...text].slice(0, -1).join('');
    }
    text = text.trim();
    if (!text) return null;
  }
  return text;
}
