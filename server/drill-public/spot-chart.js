// The 13×13 chart of one spot (design D12): each cell's raise, call and fold
// frequencies as a bar and as text for assistive technology. Pairs sit on the
// diagonal, suited hands above it and offsuit hands below.
const RANKS = 'AKQJT98765432';
const pct = (value) => `${Math.round((value ?? 0) * 100)}%`;
export function chartClassAt(row, col) {
  if (row === col) return `${RANKS[row]}${RANKS[col]}`;
  return row < col ? `${RANKS[row]}${RANKS[col]}s` : `${RANKS[col]}${RANKS[row]}o`;
}
export function cellLabel(hand, cell) {
  if (!cell) return `${hand}: 이 상황에 도달하지 않음`;
  return `${hand}: 레이즈 ${pct(cell.raise)}, 콜 ${pct(cell.call)}, 폴드 ${pct(cell.fold)}`;
}
export function renderSpotChart(doc, chart, { highlight = null } = {}) {
  const table = doc.createElement('table');
  table.className = 'spot-chart';
  const caption = doc.createElement('caption');
  caption.textContent = `${chart.spotKey} · 기준표 ${chart.source?.version ?? ''} 전체 빈도`;
  table.append(caption);
  const body = doc.createElement('tbody');
  for (let row = 0; row < 13; row += 1) {
    const tr = doc.createElement('tr');
    for (let col = 0; col < 13; col += 1) {
      const hand = chartClassAt(row, col);
      const cell = chart.cells?.[hand] ?? null;
      const td = doc.createElement('td');
      td.className = `spot-cell${cell ? '' : ' is-unreached'}${hand === highlight ? ' is-hand' : ''}`;
      td.textContent = hand;
      td.title = cellLabel(hand, cell);
      td.setAttribute('aria-label', cellLabel(hand, cell));
      if (cell) {
        const raise = Math.round(cell.raise * 100);
        const call = Math.round(cell.call * 100);
        td.style.setProperty('--raise', `${raise}%`);
        td.style.setProperty('--call', `${raise + call}%`);
      }
      tr.append(td);
    }
    body.append(tr);
  }
  table.append(body);
  return table;
}

/** The chart box's lifecycle. A chart belongs to the run it was opened in: a
 * measuring run or another run closes it, and a response that arrives after the
 * box was closed or reopened is dropped. `show` paints a state into the box. */
export function createChartPanel({ box, load, show }) {
  let generation = 0;
  let run;
  const close = () => {
    generation += 1;
    box.hidden = true;
    box.replaceChildren();
  };
  return {
    close,
    sync(runId, measuring) {
      if (measuring || runId !== run) { run = runId; close(); }
    },
    async open(request) {
      const mine = ++generation;
      box.hidden = false;
      show({ loading: true, request });
      let response = null;
      try { response = await load(request); } catch { response = null; }
      if (mine !== generation) return false;
      show({ response, request });
      return true;
    },
  };
}
