/** The parent header's game context (hand, blinds, net, connection) from the
 * embedded table's `holdem:context` message (shell-bridge.js). Shared by the
 * host lobby and the join page; amounts follow the BB/chips preference. */
import { formatAmount } from './chip-format.js';
import { currentDisplaySettings } from './display-settings.js';
import { formatLevelSeconds } from './table-controls.js';

/** `paused`: the shell knows play is paused, so the level clock is shown as
 * paused rather than as the last time the table sent. */
export function paintShellContext(node, context, { doc = globalThis.document, preference = currentDisplaySettings({ doc }).unit, paused = false } = {}) {
  if (!node) return;
  if (!context) { node.hidden = true; node.replaceChildren(); return; }
  const parts = [];
  const add = (label, value, className = '') => {
    const span = doc.createElement('span');
    span.append(`${label} `);
    const strong = doc.createElement('span');
    strong.className = `ui-num ${className}`.trim();
    strong.textContent = value;
    span.append(strong);
    parts.push(span);
  };
  if (context.handNo !== null) add('핸드', context.handLimit ? `${context.handNo}/${context.handLimit}` : String(context.handNo));
  if (context.blinds) add(context.level ? `레벨 ${context.level} ·` : '블라인드', `${context.blinds[0].toLocaleString('ko-KR')}/${context.blinds[1].toLocaleString('ko-KR')}`);
  if (context.levelSecondsLeft != null && !context.gameOver) add('다음 레벨', paused ? '일시정지' : formatLevelSeconds(context.levelSecondsLeft));
  else if (context.levelLeft != null && !context.gameOver) add('다음 레벨', `${context.levelLeft}핸드`);
  if (context.sessionNet !== null) {
    const net = formatAmount(context.sessionNet, context.blinds?.[1] ?? null, preference, true).primary;
    add('손익', net, context.sessionNet > 0 ? 'ui-pos' : context.sessionNet < 0 ? 'ui-neg' : '');
  }
  if (context.conn !== 'on') add('연결', context.conn === 'retry' ? '재연결 중' : '종료');
  node.replaceChildren(...parts);
  node.hidden = parts.length === 0;
}
