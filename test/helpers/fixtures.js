import { newDeck } from '../../engine/cards.js';
import { createGame, startHand } from '../../engine/hand.js';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function fixedDeck() {
  return newDeck();
}

// 3인 [user,p1,p2], startHand 후 button=0(user) → SB=p1, BB=p2, 프리플랍 선행동=user.
export function setup3(userStack, p1Stack, p2Stack) {
  const st = createGame({ aiCount: 2 });
  st.button = 2;
  st.seats[0].stack = userStack;
  st.seats[1].stack = p1Stack;
  st.seats[2].stack = p2Stack;
  return startHand(st, { deck: fixedDeck() }).state;
}
