import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPokerStars } from '../export/pokerstars.js';

test('pokerstars renderer uses raises to, PLAY currency, synthetic id, no fake burns', () => {
  const { text, warnings } = renderPokerStars({
    hands: [{
      handNo: 3,
      button: 'user',
      blinds: [50, 100],
      seats: [{ playerId: 'user', stack: 10000 }, { playerId: 'p1', stack: 10000 }],
      heroCards: ['Ah', 'Jd'],
      board: [],
      actions: [
        { playerId: 'user', action: 'raise', amount: 250, street: 'preflop', currentBet: 100 },
        { playerId: 'p1', action: 'fold', amount: 0, street: 'preflop', currentBet: 250 },
      ],
      pots: [{ amount: 250 }],
      showdown: { reveals: [] },
    }],
  }, { gameId: 'abc', exportedAt: '2026/09/01 0:00:00 ET' });
  assert.equal(warnings.length, 0);
  assert.match(text, /PokerStars Hand #AIHabc-3/);
  assert.match(text, /50\/100 PLAY/);
  assert.match(text, /user: raises 150 to 250/);
  assert.equal(text.includes('burn'), false);
  assert.equal(text.includes('raises by'), false);
});
