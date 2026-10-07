import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareGuesses, GUESS_CHOICES, hudLine, readOpponentNotes, saveOpponentNote } from '../server/public/opponent-notes.js';

function memoryStorage() {
  const map = new Map();
  return { getItem: (key) => (map.has(key) ? map.get(key) : null), setItem: (key, value) => map.set(key, String(value)), map };
}

test('opponent notes are kept per game, cleaned, and removable', () => {
  const storage = memoryStorage();
  assert.equal(saveOpponentNote('g1', 'p1', { guess: 'LAG', note: '  자주 3벳  ' }, storage), true);
  assert.equal(saveOpponentNote('g1', 'p2', { guess: 'NotAType', note: 'x'.repeat(500) }, storage), true);
  const notes = readOpponentNotes('g1', storage);
  assert.deepEqual(notes.p1, { guess: 'LAG', note: '자주 3벳' });
  assert.equal(notes.p2.guess, '');
  assert.equal(notes.p2.note.length, 200);
  assert.deepEqual(readOpponentNotes('g2', storage), {}, 'another game has its own notes');
  saveOpponentNote('g1', 'p1', { guess: '', note: '' }, storage);
  assert.equal(readOpponentNotes('g1', storage).p1, undefined);
  storage.setItem('holdem.opponent-notes.v1:g3', '{broken');
  assert.deepEqual(readOpponentNotes('g3', storage), {});
  const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.deepEqual(readOpponentNotes('g1', throwing), {});
  assert.equal(saveOpponentNote('g1', 'p1', { guess: 'TAG' }, throwing), false);
  assert.equal(GUESS_CHOICES[0][0], '');
});

test('the HUD line shows the engine counts and a sample size', () => {
  assert.equal(hudLine({ sample: 12, vpip: 0.25, pfr: 0.1833, af: 1.46 }), '표본 12 · VPIP 25% · PFR 18% · AF 1.5');
  assert.equal(hudLine({ sample: 0, vpip: 0, pfr: 0, af: 0 }), '표본 없음');
  assert.equal(hudLine(null), '표본 없음');
});

test('guesses are compared with the revealed identities', () => {
  const rows = compareGuesses({ p1: { guess: 'LAG', note: '' }, p2: { guess: 'Nit', note: '' } }, {
    players: [{ playerId: 'p1', name: 'A', archetype: 'LAG' }, { playerId: 'p2', name: 'B', archetype: 'TAG' }, { playerId: 'p3', name: 'C', archetype: 'SelfMirror' }],
  });
  assert.deepEqual(rows.map((row) => [row.playerId, row.match]), [['p1', true], ['p2', false], ['p3', false]]);
  assert.equal(rows[2].guessLabel, '추정 없음');
  assert.match(rows[2].actualLabel, /self-mirror/);
  assert.deepEqual(compareGuesses({}, null), []);
});
