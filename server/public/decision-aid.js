// Decision aid for the human's turn (learning calibration D8/D13): arithmetic
// from the public view only — price, required equity, stack depth — plus what
// the hole cards make and draw to. No equity estimate and no strategy advice is
// shown during the decision, so pre-decision assistance stays factual.
import { describeMadeHand, drawsOf } from '../../shared/poker-eval.js';

const round = (value, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;

export function decisionAid(view, viewer) {
  const legal = view?.legal;
  const bb = view?.blinds?.[1];
  const hero = view?.seats?.find((seat) => seat.playerId === viewer);
  if (!legal || !hero || !(bb > 0)) return null;
  const pot = legal.potTotal ?? 0;
  const call = legal.callAmount ?? 0;
  const opponents = view.seats.filter((seat) => seat.playerId !== viewer && !seat.folded && !seat.out);
  const currentBet = Math.max(0, ...view.seats.map((seat) => seat.bet ?? 0));
  const partial = call > 0 && call < currentBet - (hero.bet ?? 0);
  const sidePots = (view.pots?.length ?? 0) > 1 || opponents.some((seat) => seat.allIn);
  const effective = Math.min(hero.stack, Math.max(0, ...opponents.map((seat) => seat.stack + (seat.bet ?? 0))));
  // Most useful first: the line is a single row that may be cut at the end.
  const items = [];
  if (call > 0) {
    items.push({ key: 'need', label: '필요 승률', value: `${round((100 * call) / (pot + call))}%`,
      note: partial || sidePots ? '총 팟 기준(사이드팟·부분 올인은 이길 수 있는 팟만 따로)' : null });
    items.push({ key: 'call', label: '콜', value: `${round(call / bb)}BB` });
    items.push({ key: 'odds', label: '팟 오즈', value: `${round(pot / call)}:1` });
  }
  items.push({ key: 'pot', label: '팟', value: `${round(pot / bb)}BB` });
  if (pot > 0) items.push({ key: 'spr', label: 'SPR', value: String(round(effective / pot)) });
  const cards = view.myCards ?? [];
  if (cards.length === 2 && (view.board?.length ?? 0) >= 3) {
    try {
      const made = describeMadeHand(cards, view.board);
      items.push({ key: 'made', label: '메이드', value: made.label });
      const draws = drawsOf(cards, view.board);
      if (draws.outs) {
        const kind = [draws.flushDraw ? '플러시 드로' : null, draws.straightDraw === 'open-ended' ? '양방 스트레이트 드로'
          : draws.straightDraw === 'gutshot' ? '거트샷' : null].filter(Boolean).join(' + ');
        items.push({ key: 'draw', label: '드로', value: `${kind || '드로'} · 완성 카드 ${draws.outs}장` });
      }
    } catch { /* malformed cards: arithmetic only */ }
  }
  items.push({ key: 'eff', label: '유효 스택', value: `${round(effective / bb)}BB` });
  return { items, partial, sidePots };
}

export function decisionAidText(aid) {
  if (!aid) return '';
  return aid.items.map((item) => `${item.label} ${item.value}`).join(' · ');
}
