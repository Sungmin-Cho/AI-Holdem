import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffViews, createMotionPlayer, MOTION_MS } from '../server/public/motion.js';

const seat = (playerId, bet = 0, extra = {}) => ({ playerId, bet, stack: 5000, ...extra });
const view = (extra = {}) => ({ handNo: 3, handInProgress: true, street: 'flop', board: ['As', 'Kd', '7c'],
  seats: [seat('user'), seat('p1'), seat('p2')], ...extra });
const frame = (v, revealed = []) => ({ view: v, revealed });

test('jumps never animate: snapshot, skipped revision, or no previous frame', () => {
  const before = frame(view()), after = frame(view({ seats: [seat('user', 100), seat('p1'), seat('p2')] }));
  assert.equal(diffViews(before, after).length, 1, 'a contiguous live update does animate');
  assert.deepEqual(diffViews(before, after, { source: 'snapshot', contiguous: false }), []);
  assert.deepEqual(diffViews(before, after, { source: 'live', contiguous: false }), []);
  assert.deepEqual(diffViews(null, after), []);
});

test('a new hand deals to seated players only, and a finished new hand deals nothing', () => {
  const next = view({ handNo: 4, street: 'preflop', board: [], seats: [seat('user'), seat('p1', 0, { out: true }), seat('p2')] });
  assert.deepEqual(diffViews(frame(view()), frame(next)), [{ type: 'deal', playerIds: ['user', 'p2'] }]);
  assert.deepEqual(diffViews(frame(view()), frame({ ...next, handInProgress: false })), []);
});

test('bets pop on the same street; a street change or hand end collects them instead', () => {
  const betting = view({ seats: [seat('user', 100), seat('p1', 300), seat('p2')] });
  assert.deepEqual(diffViews(frame(view({ seats: [seat('user', 100), seat('p1'), seat('p2')] })), frame(betting)), [{ type: 'bet', playerId: 'p1' }]);
  const turn = view({ street: 'turn', board: ['As', 'Kd', '7c', '2h'] });
  assert.deepEqual(diffViews(frame(betting), frame(turn)), [{ type: 'collect', playerIds: ['user', 'p1'] }, { type: 'board', from: 3, to: 4 }]);
  const ended = view({ handInProgress: false, street: null, board: ['As', 'Kd', '7c', '2h', '9s'] });
  assert.deepEqual(diffViews(frame(betting), frame(ended)), [{ type: 'collect', playerIds: ['user', 'p1'] }],
    'a runout at hand end is staged by the result frame, not flipped here');
});

test('only newly revealed seats flip', () => {
  const ended = view({ handInProgress: false });
  assert.deepEqual(diffViews(frame(ended, ['p1']), frame(ended, ['p1', 'p2'])), [{ type: 'reveal', playerIds: ['p2'] }]);
});

function fakeTable() {
  const calls = [];
  const node = (className, playerId, rect = { left: 0, top: 0, width: 10, height: 10 }) => {
    const self = { className, dataset: playerId ? { playerId } : {}, style: {}, children: [], removed: false,
      getBoundingClientRect: () => rect, setAttribute() {}, remove() { self.removed = true; },
      querySelector: (selector) => self.querySelectorAll(selector)[0] ?? null,
      querySelectorAll: (selector) => self.children.filter((child) => selector.split(' ').at(-1).split(',').some((part) => part === `.${child.className}` || part === `#${child.id}`)),
      append(child) { self.children.push(child); },
      animate(keyframes, options) {
        const animation = { keyframes, options, cancelled: false, cancel() { animation.cancelled = true; }, finished: new Promise(() => {}) };
        calls.push(animation); return animation;
      } };
    return self;
  };
  const table = node('table', null, { left: 0, top: 0, width: 800, height: 400 });
  const pots = node('pots', null, { left: 390, top: 190, width: 20, height: 20 }); pots.id = 'pots';
  const seats = ['user', 'p1'].map((id, index) => {
    const s = node('seat', id); const plate = node('plate', null, { left: index * 300, top: 300, width: 80, height: 40 });
    s.children.push(plate); return s;
  });
  table.querySelectorAll = (selector) => selector === '.seat' ? seats : selector === '#pots' ? [pots] : [];
  table.querySelector = (selector) => table.querySelectorAll(selector)[0] ?? null;
  const doc = { createElement: () => node('motion-chip') };
  return { table, doc, calls };
}

test('the player creates nothing when motion is reduced', () => {
  const { table, doc, calls } = fakeTable();
  const player = createMotionPlayer({ doc, enabled: () => false });
  player.play([{ type: 'collect', playerIds: ['user', 'p1'] }], { table });
  player.playAward(['user'], { table });
  assert.equal(calls.length, 0);
  assert.equal(table.children.length, 0);
  assert.equal(player.active, 0);
});

test('a collect flies one short-lived chip per bettor, and the next view ends it', () => {
  const { table, doc, calls } = fakeTable();
  const player = createMotionPlayer({ doc, enabled: () => true });
  player.play([{ type: 'collect', playerIds: ['user', 'p1'] }], { table });
  assert.equal(table.children.filter((child) => child.className === 'motion-chip').length, 2);
  assert.ok(calls.every((call) => call.options.duration <= 300));
  assert.equal(calls[0].options.duration, MOTION_MS.collect);
  player.play([], { table });
  assert.ok(calls.every((call) => call.cancelled), 'a new view cancels running motion');
  assert.ok(table.children.every((child) => child.removed), 'flight chips are removed');
  assert.equal(player.active, 0);
});

test('the award flies pot to each winner within 300ms', () => {
  const { table, doc, calls } = fakeTable();
  const player = createMotionPlayer({ doc, enabled: () => true });
  player.playAward(['p1'], { table });
  assert.ok(calls.length >= 2);
  assert.ok(calls.every((call) => call.options.duration === MOTION_MS.award && call.options.duration <= 300));
});
