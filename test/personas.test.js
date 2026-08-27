import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePersonas, ARCHETYPES } from '../engine/personas.js';

const PERSONA_KEYS = [
  'playerId', 'seat', 'name', 'agentHandle', 'speech', 'personality',
  'archetype', 'bluffFreq', 'threeBetFreq', 'tiltProne',
];

test('필드는 닫힌 목록이고 이름 중복 없음', () => {
  const personas = generatePersonas(8);

  for (const persona of personas) {
    assert.deepEqual(Object.keys(persona).sort(), [...PERSONA_KEYS].sort());
  }
  assert.equal(new Set(personas.map((persona) => persona.name)).size, 8);
  assert.equal(personas[0].agentHandle, 'player-p1');
});

test('아키타입은 6종 안에서만', () => {
  const personas = generatePersonas(12);

  assert.deepEqual(new Set(personas.map((persona) => persona.archetype)), new Set(ARCHETYPES));
  for (const persona of personas) {
    assert.ok(ARCHETYPES.includes(persona.archetype));
    assert.ok(persona.bluffFreq >= 0 && persona.bluffFreq <= 1);
    assert.ok(persona.threeBetFreq >= 0 && persona.threeBetFreq <= 1);
    assert.equal(typeof persona.tiltProne, 'boolean');
  }
});

test('AI만 생성하고 좌석과 핸들이 안정적으로 배정됨', () => {
  const personas = generatePersonas(3);

  assert.deepEqual(personas.map(({ playerId, seat, agentHandle }) => ({ playerId, seat, agentHandle })), [
    { playerId: 'p1', seat: 1, agentHandle: 'player-p1' },
    { playerId: 'p2', seat: 2, agentHandle: 'player-p2' },
    { playerId: 'p3', seat: 3, agentHandle: 'player-p3' },
  ]);
  assert.ok(personas.every((persona) => persona.playerId.startsWith('p')));
});
