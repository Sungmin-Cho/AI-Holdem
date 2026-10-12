import {formatAmount, formatSignedAmount} from './chip-format.js';
import {parseCard, cardLabel, renderMiniCard} from './card-render.js';

/** One finished hand (a hand-result.js result) for the live strip, the
 * "직전 결과" dialog and the final overlay. It draws only the result's public
 * fields; callers own names, the display unit and any live controls. */
const STREETS = [['flop', '플랍'], ['turn', '턴'], ['river', '리버']];

function node(doc, tag, className, text) {
  const el = doc.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function cardRow(doc, cards, className) {
  const row = node(doc, 'span', className);
  row.setAttribute('role', 'img');
  row.setAttribute('aria-label', cards.map(code => cardLabel(parseCard(code))).join(', '));
  for (const code of cards) row.append(renderMiniCard(code, {doc}));
  return row;
}

function boardRow(doc, result) {
  const box = node(doc, 'div', 'hand-result-board');
  const shown = STREETS.filter(([key]) => result.board?.[key]?.length);
  if (!shown.length) {
    box.append(node(doc, 'span', 'hand-result-board-none', '프리플랍에서 종료 · 보드 없음'));
    return box;
  }
  box.append(node(doc, 'span', 'hand-result-board-label', '보드'));
  for (const [key, label] of shown) {
    const street = node(doc, 'span', `hand-result-street${result.runout?.includes(key) ? ' is-runout' : ''}`);
    street.append(node(doc, 'span', 'hand-result-street-label', label), cardRow(doc, result.board[key], 'hand-result-street-cards'));
    box.append(street);
  }
  const unseen = STREETS.filter(([key]) => !result.board?.[key]?.length).map(([, label]) => label);
  if (unseen.length) box.append(node(doc, 'span', 'hand-result-board-none', `${unseen.join('·')} 공개 안 됨`));
  if (result.runout?.length) {
    const names = STREETS.filter(([key]) => result.runout.includes(key)).map(([, label]) => label);
    box.append(node(doc, 'span', 'hand-result-runout', `올인 런아웃 · ${names.join('·')}`));
  }
  return box;
}

/** Returns {head, body} appended to `container` so a live caller can add its
 * countdown and skip control to the head. */
export function renderHandResultCard(container, result, {doc = globalThis.document, playerName = id => id,
  unit = 'bb', bb = result?.blinds?.[1] ?? null} = {}) {
  const amount = value => formatAmount(value, bb, unit).primary;
  const head = node(doc, 'div', 'hand-result-head');
  head.append(node(doc, 'strong', 'hand-result-title', `핸드 ${result.handNo} 결과`),
    node(doc, 'span', 'hand-result-reason', result.kind === 'uncontested' ? '상대 전원 폴드' : '쇼다운'));
  const body = node(doc, 'div', 'hand-result-body');
  const winners = node(doc, 'ul', 'hand-result-winners');
  for (const winner of result.winners) {
    // "팟 N 획득" is what a winner collected, never their profit.
    const row = node(doc, 'li', 'hand-result-winner');
    row.append(node(doc, 'span', 'hand-result-name', playerName(winner.playerId)),
      node(doc, 'span', 'hand-result-won', `팟 ${amount(winner.total)} 획득`),
      node(doc, 'span', 'hand-result-hand', winner.handName ?? (result.kind === 'uncontested' ? '상대 전원 폴드' : '쇼다운')));
    if (winner.cards?.length) row.append(cardRow(doc, winner.cards, 'hand-result-cards'));
    winners.append(row);
  }
  body.append(winners);
  const why = pot => (pot.note ? `${pot.note}${pot.versus ? ` (${playerName(pot.versus)} 대비)` : ''}` : null);
  if (result.pots.length === 1) {
    if (why(result.pots[0])) body.append(node(doc, 'p', 'hand-result-note', `판별 · ${why(result.pots[0])}`));
  } else {
    const pots = node(doc, 'ul', 'hand-result-pots');
    for (const pot of result.pots) {
      const name = pot.potIndex === 0 ? '메인 팟' : `사이드 팟 ${pot.potIndex}`;
      const shares = pot.winners.map(row => `${playerName(row.playerId)} ${amount(row.share)}`).join(', ');
      pots.append(node(doc, 'li', 'hand-result-pot', `${name} ${amount(pot.amount)} · ${shares}${why(pot) ? ` · ${why(pot)}` : ''}`));
    }
    body.append(pots);
  }
  body.append(boardRow(doc, result));
  if (result.myNet !== null && result.myNet !== undefined) {
    body.append(node(doc, 'p', `hand-result-net ${result.myNet > 0 ? 'is-pos' : result.myNet < 0 ? 'is-neg' : ''}`.trim(),
      `내 순손익 ${formatSignedAmount(result.myNet, bb, unit).primary}`));
  }
  container.append(head, body);
  return {head, body};
}
