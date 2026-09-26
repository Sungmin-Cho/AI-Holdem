/** Online-session invite helpers: QR code as SVG DOM (no HTML strings) and a
 * clipboard copy with a select-for-manual-copy fallback. */
import { qrcode } from './vendor-qrcode.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Draws `text` as a QR code inside `container` (replacing its children).
 * Returns false when the text cannot be encoded; the container is emptied. */
export function renderQr(container, text, { doc = globalThis.document, quiet = 2 } = {}) {
  container.replaceChildren();
  if (typeof text !== 'string' || !text) return false;
  let qr;
  try {
    qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
  } catch {
    return false;
  }
  const count = qr.getModuleCount();
  const size = count + quiet * 2;
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', '참가 링크 QR 코드');
  const background = doc.createElementNS(SVG_NS, 'rect');
  background.setAttribute('width', String(size));
  background.setAttribute('height', String(size));
  background.setAttribute('class', 'qr-bg');
  // One path keeps the DOM small (a 33x33 code would otherwise be ~500 rects).
  let d = '';
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (qr.isDark(row, col)) d += `M${col + quiet} ${row + quiet}h1v1h-1z`;
    }
  }
  const modules = doc.createElementNS(SVG_NS, 'path');
  modules.setAttribute('d', d);
  modules.setAttribute('class', 'qr-fg');
  svg.append(background, modules);
  container.append(svg);
  return true;
}

/** Copies `text`. Without clipboard permission (plain-http LAN origin, older
 * browsers) the fallback field is shown with the text selected so the host
 * can copy it by hand. Resolves to 'copied' | 'selected' | 'failed'. */
export async function copyText(text, { fallback = null, nav = globalThis.navigator } = {}) {
  try {
    if (nav?.clipboard?.writeText) {
      await nav.clipboard.writeText(text);
      return 'copied';
    }
  } catch { /* permission denied or insecure context: fall through */ }
  if (!fallback) return 'failed';
  fallback.value = text;
  fallback.hidden = false;
  fallback.focus?.();
  fallback.select?.();
  return 'selected';
}
