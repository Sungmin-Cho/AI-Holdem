/** The "평가와 재평가" card list. Cards are keyed by run id and updated in place:
 * a button that is being pressed must stay the same element (a rebuilt button
 * loses the click between mousedown and mouseup, issue 329). The list is
 * rebuilt only when the order of run ids changes; a state change touches
 * `disabled` and the gate line only; a new summary changes text only.
 *
 * `cards` are the display cards of study-format.js formatSummary. `getGate`
 * returns the current gate ({ text }) or null and is asked again at click time,
 * so a stale render cannot start a run. `onRetest(card)` does the start. */
export function createRunCards(document, box, { onRetest, getGate = () => null, gateBox = null } = {}) {
  const entries = new Map();
  let order = [];
  let empty = null;

  const node = (tag, className) => { const element = document.createElement(tag); if (className) element.className = className; return element; };
  const setText = (element, text) => { if (element.textContent !== text) element.textContent = text; };
  const show = (element, text) => { element.hidden = !text; setText(element, text || ''); };

  function build(card) {
    const root = node('article', 'assessment');
    const title = node('h3');
    const badge = node('span', 'assessment-badge');
    const heading = node('span', 'assessment-title');
    title.append(heading, badge);
    const parts = { root, heading, badge, meta: node('p', 'assessment-meta'), relation: node('p', 'assessment-relation'),
      rate: node('p', 'assessment-rate'), status: node('p'), baseline: node('p', 'assessment-baseline'), available: node('p'),
      note: node('p', 'assessment-note'), button: null };
    root.append(title, parts.meta, parts.relation, parts.rate, parts.status, parts.baseline, parts.available, parts.note);
    const entry = { card, parts };
    if (card.kind === 'assessment') {
      const button = node('button', 'ui-btn ui-btn--ghost');
      button.type = 'button';
      button.textContent = '이 평가 재평가하기';
      // The handler reads the entry at click time: the card data and the gate
      // are whatever is current, not what was rendered when the button was made.
      button.addEventListener('click', () => {
        if (!entry.card.canRetest || getGate()) return;
        onRetest(entry.card);
      });
      parts.button = button;
      root.append(button);
    }
    return entry;
  }

  function fill(entry, card) {
    entry.card = card;
    const { parts } = entry;
    setText(parts.heading, card.title);
    show(parts.badge, card.badge);
    show(parts.meta, card.meta);
    show(parts.relation, card.relation);
    setText(parts.rate, `${card.rate} · ${card.samples}`);
    setText(parts.status, card.status);
    show(parts.baseline, card.baseline);
    show(parts.available, card.availableAt ? `재평가 가능 시각: ${card.availableAt}` : '');
    show(parts.note, card.note);
  }

  /** The gate line and every button's `disabled`; nothing else changes. */
  function refreshGate() {
    const gate = getGate();
    for (const entry of entries.values()) if (entry.parts.button) entry.parts.button.disabled = !entry.card.canRetest || gate !== null;
    if (gateBox) setText(gateBox, gate?.text ?? '');
  }

  function sync(cards) {
    const list = [];
    const seen = new Set();
    for (const card of cards) {
      if (typeof card?.key !== 'string' || seen.has(card.key)) continue;
      seen.add(card.key);
      list.push(card);
    }
    const keys = list.map((card) => card.key);
    for (const key of [...entries.keys()]) if (!seen.has(key)) entries.delete(key);
    for (const card of list) {
      const entry = entries.get(card.key) ?? build(card);
      entries.set(card.key, entry);
      fill(entry, card);
    }
    const changed = keys.length !== order.length || keys.some((key, index) => key !== order[index]);
    if (changed || (!keys.length && !empty)) {
      order = keys;
      if (keys.length) { empty = null; box.replaceChildren(...keys.map((key) => entries.get(key).parts.root)); }
      else {
        empty = node('p');
        empty.textContent = '완료한 새 문제 평가가 없습니다. 평가를 완료하면 24시간 뒤 같은 문항으로 재평가할 수 있습니다.';
        box.replaceChildren(empty);
      }
    }
    refreshGate();
  }

  return { sync, refreshGate, get keys() { return [...order]; }, buttonOf: (key) => entries.get(key)?.parts.button ?? null, elementOf: (key) => entries.get(key)?.parts.root ?? null };
}
