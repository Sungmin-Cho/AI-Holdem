/** Help drawer (design §10.4): the rules, the words, the modes, what the
 * learning numbers mean (the honesty statement's home), what is revealed or
 * sent elsewhere, and the display settings. One native <dialog> per document,
 * built on first use; every screen's ⓘ opens it at its own section. Shared by
 * the lobby, the table, the join page and the study room, so it depends only
 * on card-render.js and display-settings.js. */
import { renderCard } from './card-render.js';
import { openDisplaySettings } from './display-settings.js';

export const HELP_SECTIONS = Object.freeze([
  ['rules', '기본 규칙'],
  ['terms', '용어'],
  ['modes', '게임 방식'],
  ['learning', '학습 수치의 의미'],
  ['privacy', '공개 범위와 외부 전송'],
  ['display', '표시 설정'],
]);

// Examples use real cards; the label is what the table and log call the hand.
const RANKINGS = Object.freeze([
  ['로열 스트레이트 플러시', ['As', 'Ks', 'Qs', 'Js', 'Ts']],
  ['스트레이트 플러시', ['9h', '8h', '7h', '6h', '5h']],
  ['포카드', ['Qc', 'Qd', 'Qh', 'Qs', '4d']],
  ['풀하우스', ['Jc', 'Jd', 'Jh', '8s', '8c']],
  ['플러시', ['Ad', 'Td', '8d', '5d', '2d']],
  ['스트레이트', ['9c', '8d', '7s', '6h', '5c']],
  ['트리플', ['7c', '7d', '7h', 'Ks', '2d']],
  ['투페어', ['Kc', 'Kd', '5h', '5s', 'Qd']],
  ['원페어', ['Ah', 'Ad', '9c', '6s', '3d']],
  ['하이 카드', ['Ac', 'Jd', '8h', '5s', '3c']],
]);

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function paragraph(doc, text) { return el(doc, 'p', 'help-text', text); }

function list(doc, rows) {
  const node = el(doc, 'dl', 'help-terms');
  for (const [term, meaning] of rows) node.append(el(doc, 'dt', null, term), el(doc, 'dd', null, meaning));
  return node;
}

function sectionContent(doc, id) {
  if (id === 'rules') {
    const table = el(doc, 'ol', 'help-rankings');
    table.setAttribute('aria-label', '족보 순서 (높은 것부터)');
    for (const [name, cards] of RANKINGS) {
      const row = el(doc, 'li', 'help-ranking');
      const hand = el(doc, 'span', 'help-ranking-cards');
      for (const code of cards) hand.append(renderCard(code, { small: true, doc }));
      row.append(el(doc, 'span', 'help-ranking-name', name), hand);
      table.append(row);
    }
    return [
      paragraph(doc, '각자 카드 2장을 받고, 가운데에 공용 카드 5장이 순서대로 깔립니다: 프리플랍(카드만 받음) → 플랍(3장) → 턴(1장) → 리버(1장). 스트리트마다 차례대로 폴드·체크·콜·벳·레이즈를 고릅니다.'),
      paragraph(doc, '끝까지 남은 사람이 둘 이상이면 쇼다운에서 내 카드 2장과 공용 카드 5장 중 가장 좋은 5장으로 겨룹니다. 한 명만 남으면 카드를 보이지 않고 팟을 가져갑니다.'),
      table,
    ];
  }
  if (id === 'terms') {
    return [list(doc, [
      ['BB (빅 블라인드)', '핸드마다 두 번째 좌석이 내는 강제 베팅. 금액을 BB 단위로 보면 스택 크기와 무관하게 비교할 수 있습니다.'],
      ['팟', '이번 핸드에 모인 칩. 진행 중에는 앞에 놓인 베팅이 스트리트가 끝날 때 팟으로 모입니다.'],
      ['사이드 팟', '누군가 스택보다 적게 올인하면, 그보다 더 넣은 칩은 따로 모여 그 칩을 넣은 사람끼리만 겨룹니다.'],
      ['포지션', 'BTN(딜러 버튼) · SB · BB · UTG … CO. 버튼에 가까울수록 나중에 행동해 정보가 많습니다.'],
      ['벳 · 레이즈 금액', '이 앱의 금액은 그 스트리트의 총액입니다. "레이즈 12 BB"는 12 BB까지 올린다는 뜻이지 12 BB를 더 넣는다는 뜻이 아닙니다.'],
      ['올인', '남은 칩을 모두 거는 것. 이후에는 행동하지 않고, 자기가 넣은 만큼까지만 팟을 겨룹니다.'],
    ])];
  }
  if (id === 'modes') {
    return [list(doc, [
      ['캐시 트레이닝', '매 핸드 같은 스택으로 다시 시작합니다. 누적 손익은 핸드마다의 득실을 더한 값입니다.'],
      ['토너먼트', '스택이 이어지고 블라인드가 레벨마다 오릅니다. 칩을 모두 잃으면 탈락합니다.'],
      ['온라인 세션', '같은 네트워크의 친구가 참가 링크로 좌석에 앉습니다. 게임이 시작된 뒤 들어오면 관전자가 되며, 관전자에게는 모든 카드가 공개됩니다.'],
    ])];
  }
  if (id === 'learning') {
    return [
      paragraph(doc, '학습 탭과 학습실의 수치는 로컬 프리플롭 휴리스틱 기준표와 내 선택을 비교한 결과입니다. 실제 포커 실력, 수익, GTO 정답을 증명하지 않습니다.'),
      paragraph(doc, '기준표가 다루지 않는 상황(지원 범위 밖)이나 시간 초과로 대신 처리된 결정은 평가에서 뺍니다. 표본이 적으면 비율이 크게 흔들리므로 표본 수를 함께 보세요.'),
      paragraph(doc, '코치 노트와 사후 설명은 모델이 쓴 해설이며, 실제 의도나 정답을 보장하지 않습니다.'),
    ];
  }
  if (id === 'privacy') {
    return [
      paragraph(doc, '플레이어에게는 핸드 진행 중 상대의 카드와 결정 사유를 보여 주지 않습니다. 핸드가 끝난 뒤 쇼다운 공개 방식과 복기 공개 범위(쇼다운 카드만 또는 AI 좌석 전부)에 따라 복기에서 볼 수 있습니다.'),
      paragraph(doc, '온라인 세션의 관전자에게는 진행 중에도 모든 좌석의 카드가 공개됩니다(결정 사유는 공개하지 않습니다). 관전자는 게임이 시작된 뒤 들어온 참가자입니다.'),
      paragraph(doc, '기본 AI 상대는 이 컴퓨터의 로컬 정책으로 결정합니다. LLM 상대와 코치·종합 리뷰는 이 컴퓨터의 AI CLI를 부릅니다. JEV 모드를 고르면 게임 중 AI 결정마다 그 AI 좌석의 자기 카드와 공개된 플레이 정보가 TypeSafe AI로 전송됩니다(참가자의 카드와 이름은 보내지 않습니다).'),
      paragraph(doc, '표시 설정(테마·단위·덱 색상·모션)은 이 브라우저에만 저장되고 서버로 보내지 않습니다.'),
    ];
  }
  const button = el(doc, 'button', 'ui-btn ui-btn--ghost help-display-open', '표시 설정 열기');
  button.type = 'button';
  button.addEventListener('click', () => openDisplaySettings({ doc }));
  const replay = doc.body?.hasAttribute?.('data-no-onboarding') ? '' : ', 처음 안내 다시 보기';
  return [paragraph(doc, `테마(기본 · 클래식 · 페이퍼), 금액 단위(BB/칩), 덱 색상(4색/2색), 모션 줄이기${replay}를 고를 수 있습니다.`), button];
}

function build(doc) {
  const dialog = el(doc, 'dialog', 'ui-dialog help-panel');
  dialog.id = 'help-panel';
  dialog.setAttribute('aria-labelledby', 'help-title');
  const head = el(doc, 'div', 'help-head');
  const title = el(doc, 'h2', 'help-title', '도움말');
  title.id = 'help-title';
  const close = el(doc, 'button', 'ui-btn ui-btn--quiet help-close', '닫기');
  close.type = 'button';
  close.addEventListener('click', () => dialog.close());
  head.append(title, close);
  const nav = el(doc, 'nav', 'help-nav');
  nav.setAttribute('aria-label', '도움말 목차');
  const body = el(doc, 'div', 'help-body');
  for (const [id, label] of HELP_SECTIONS) {
    const link = el(doc, 'a', 'help-nav-link', label);
    link.href = `#help-${id}`;
    link.addEventListener('click', (event) => { event.preventDefault(); show(dialog, id); });
    nav.append(link);
    const section = el(doc, 'section', 'help-section');
    section.id = `help-${id}`;
    section.setAttribute('aria-labelledby', `help-${id}-title`);
    const heading = el(doc, 'h3', 'help-section-title', label);
    heading.id = `help-${id}-title`;
    heading.tabIndex = -1;
    section.append(heading, ...sectionContent(doc, id));
    body.append(section);
  }
  dialog.append(head, nav, body);
  // A click on the backdrop (outside the drawer box) closes it.
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  doc.body.append(dialog);
  return dialog;
}

function show(dialog, section) {
  const target = dialog.querySelector(`#help-${section}`);
  if (!target) return;
  target.scrollIntoView({ block: 'start' });
  target.querySelector('.help-section-title')?.focus({ preventScroll: true });
}

/** Opens the drawer at a section (default: the rules). */
export function openHelp(section = 'rules', { doc = globalThis.document } = {}) {
  const dialog = doc.getElementById('help-panel') ?? build(doc);
  if (!dialog.open) dialog.showModal();
  show(dialog, HELP_SECTIONS.some(([id]) => id === section) ? section : 'rules');
  return dialog;
}

/** A small ⓘ button that opens the drawer at `section`; its name says where it goes. */
export function helpButton(section, label, { doc = globalThis.document } = {}) {
  const button = el(doc, 'button', 'help-info', 'ⓘ');
  button.type = 'button';
  button.setAttribute('aria-label', `${label} 도움말`);
  button.addEventListener('click', () => openHelp(section, { doc }));
  return button;
}

/** Wires the header's 도움말·설정 disclosure (#help-menu, #help-menu-list,
 * #open-help, #open-display-settings), shared by the lobby and the join page. */
export function wireHelpMenu({ doc = globalThis.document, section = 'rules' } = {}) {
  const $ = (id) => doc.getElementById(id);
  const menu = $('help-menu'), list = $('help-menu-list');
  if (!menu || !list) return null;
  const set = (open) => { list.hidden = !open; menu.setAttribute('aria-expanded', String(open)); };
  menu.onclick = () => set(list.hidden);
  list.addEventListener('keydown', (event) => { if (event.key === 'Escape') { set(false); menu.focus(); } });
  doc.addEventListener('click', (event) => { if (!list.hidden && !event.target.closest('.help-menu')) set(false); });
  // Close the list and focus the menu button first: the dialog returns focus to it.
  $('open-help').onclick = () => { set(false); menu.focus(); openHelp(section, { doc }); };
  $('open-display-settings').onclick = () => { set(false); menu.focus(); openDisplaySettings({ doc }); };
  return { set };
}
