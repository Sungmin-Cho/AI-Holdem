/** First-turn guide (design §10.4): three steps on the first turn of the
 * first game — the seat and stack, the action bar, the side panel and menu.
 * It never blocks play: the card sits in the flow of the side panel (no
 * overlay), targets only get an outline, and focus is never moved. A first turn
 * with an action deadline (online sessions) is left alone; the guide then shows
 * in the wait after that turn. Seen once per browser (`holdem.onboarding.v1`),
 * or once per page when storage is unavailable. */
import { DISPLAY_KEYS } from './display-settings.js';

export const ONBOARDING_STEPS = Object.freeze([
  { target: 'seat', title: '내 좌석과 스택', text: '아래 가운데가 내 자리입니다. 명판의 숫자가 남은 스택이고, 내 카드는 명판 위에 있습니다.' },
  { target: 'actions', title: '액션 바와 금액', text: '폴드·체크/콜·벳/레이즈를 고릅니다. 레이즈 금액은 그 스트리트의 총액이며, 금액·메모에서 바꿀 수 있습니다.' },
  { target: 'side', title: '로그·코치·학습', text: '오른쪽 탭에서 진행 기록, 코치 노트, 학습 카드를 봅니다. 일시정지와 설정은 위쪽 메뉴에 있습니다.' },
]);

function storageOf(storage) { try { return storage ?? globalThis.localStorage ?? null; } catch { return null; } }

export function createOnboarding({ doc = globalThis.document, storage, container, targets }) {
  let step = -1;
  let seenThisPage = false;
  // A deadline turn was skipped; show in the next wait (seated, not our turn).
  let deferred = false;
  let card = null;
  const seen = () => {
    if (seenThisPage) return true;
    try { return storageOf(storage)?.getItem(DISPLAY_KEYS.onboarding) === 'done'; } catch { return false; }
  };
  const remember = () => {
    seenThisPage = true;
    try { storageOf(storage)?.setItem(DISPLAY_KEYS.onboarding, 'done'); } catch { /* this page only */ }
  };
  const highlight = (name) => {
    for (const [key, find] of Object.entries(targets)) find()?.classList.toggle('onboarding-focus', key === name);
  };
  const end = () => {
    step = -1;
    highlight(null);
    card?.remove();
    card = null;
  };
  const button = (label, className, onClick) => {
    const node = doc.createElement('button');
    node.type = 'button';
    node.className = `ui-btn ${className}`;
    node.textContent = label;
    node.addEventListener('click', onClick);
    return node;
  };
  const render = () => {
    const current = ONBOARDING_STEPS[step];
    card?.remove();
    card = doc.createElement('section');
    card.className = 'onboarding-card';
    card.setAttribute('aria-label', '처음 안내');
    const count = doc.createElement('p');
    count.className = 'onboarding-count';
    count.textContent = `처음 안내 ${step + 1} / ${ONBOARDING_STEPS.length}`;
    const title = doc.createElement('h2');
    title.className = 'onboarding-title';
    title.textContent = current.title;
    const text = doc.createElement('p');
    text.className = 'onboarding-text';
    text.textContent = current.text;
    const actions = doc.createElement('div');
    actions.className = 'onboarding-actions';
    const last = step === ONBOARDING_STEPS.length - 1;
    actions.append(
      button(last ? '마치기' : '다음', 'ui-btn--primary onboarding-next', () => api.next()),
      button('건너뛰기', 'ui-btn--quiet onboarding-skip', () => api.skip()),
    );
    card.append(count, title, text, actions);
    container().prepend(card);
    highlight(current.target);
  };
  const api = {
    get active() { return step >= 0; },
    get step() { return step; },
    /** Called on every paint: starts on the viewer's first deadline-free turn,
     * or — after a first turn that had a deadline — in the wait that follows. */
    offer({ myTurn, deadline, seated = true }) {
      if (step >= 0 || seen()) return false;
      if (myTurn && deadline) { deferred = true; return false; }
      if (!myTurn && !(deferred && seated)) return false;
      step = 0;
      render();
      return true;
    },
    next() {
      if (step < 0) return;
      if (step >= ONBOARDING_STEPS.length - 1) { remember(); end(); return; }
      step += 1;
      render();
    },
    /** Skip, finish or Esc: the guide does not come back unless replayed. */
    skip() { if (step >= 0) { remember(); end(); } },
    reset() {
      end();
      seenThisPage = false;
      deferred = false;
      try { storageOf(storage)?.removeItem(DISPLAY_KEYS.onboarding); } catch { /* optional */ }
    },
  };
  return api;
}
