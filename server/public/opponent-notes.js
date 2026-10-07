// Opponent notes and the host HUD line (learning calibration D13). Notes stay in
// this browser (localStorage, one key per game); the configured identities come
// only from the host reveal route after the final review is published.
const KEY_PREFIX = 'holdem.opponent-notes.v1:';
const MAX_NOTE = 200;

export const ARCHETYPE_LABELS = Object.freeze({
  TAG: '신중한 공격형 (TAG)',
  LAG: '폭넓은 공격형 (LAG)',
  Nit: '매우 신중한 유형 (Nit)',
  CallingStation: '콜을 선호하는 유형 (CallingStation)',
  Maniac: '매우 공격적인 유형 (Maniac)',
  Trickster: '변화를 섞는 유형 (Trickster)',
  SelfMirror: '나를 닮은 복제 상대 (self-mirror)',
  SelfExploiter: '나를 공략하는 상대 (self-exploiter)',
});
/** Choices offered for a guess; the self opponents are not guessable presets. */
export const GUESS_CHOICES = Object.freeze([['', '아직 모름'],
  ...['TAG', 'LAG', 'Nit', 'CallingStation', 'Maniac', 'Trickster'].map((id) => [id, ARCHETYPE_LABELS[id]])]);

function store(storage) {
  try { return storage ?? globalThis.localStorage ?? null; } catch { return null; }
}
const keyOf = (gameId) => `${KEY_PREFIX}${gameId}`;

/** { playerId: { guess, note } } for one game; empty when unset or unreadable. */
export function readOpponentNotes(gameId, storage) {
  if (!gameId) return {};
  try {
    const raw = store(storage)?.getItem(keyOf(gameId));
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out = {};
    for (const [playerId, row] of Object.entries(parsed)) {
      const guess = Object.hasOwn(ARCHETYPE_LABELS, row?.guess) ? row.guess : '';
      const note = typeof row?.note === 'string' ? [...row.note].slice(0, MAX_NOTE).join('') : '';
      if (guess || note) out[playerId] = { guess, note };
    }
    return out;
  } catch { return {}; }
}

/** Saves one opponent's guess and note; returns whether it was stored. */
export function saveOpponentNote(gameId, playerId, { guess = '', note = '' } = {}, storage) {
  if (!gameId || !playerId) return false;
  const notes = readOpponentNotes(gameId, storage);
  const clean = {
    guess: Object.hasOwn(ARCHETYPE_LABELS, guess) ? guess : '',
    note: [...String(note ?? '')].slice(0, MAX_NOTE).join('').trim(),
  };
  if (clean.guess || clean.note) notes[playerId] = clean;
  else delete notes[playerId];
  try {
    store(storage)?.setItem(keyOf(gameId), JSON.stringify(notes));
    return true;
  } catch { return false; }
}

const pct = (value) => `${Math.round(100 * value)}%`;
/** "표본 12 · VPIP 25% · PFR 18% · AF 1.5" — the same counts the AI players see. */
export function hudLine(row) {
  if (!row || !Number.isSafeInteger(row.sample) || row.sample <= 0) return '표본 없음';
  const parts = [`표본 ${row.sample}`];
  if (Number.isFinite(row.vpip)) parts.push(`VPIP ${pct(row.vpip)}`);
  if (Number.isFinite(row.pfr)) parts.push(`PFR ${pct(row.pfr)}`);
  if (Number.isFinite(row.af)) parts.push(`AF ${Math.round(row.af * 10) / 10}`);
  return parts.join(' · ');
}

/** Rows comparing the viewer's guesses with the revealed identities. */
export function compareGuesses(notes, reveal) {
  return (reveal?.players ?? []).map((player) => {
    const guess = notes?.[player.playerId]?.guess ?? '';
    return {
      playerId: player.playerId,
      name: player.name ?? player.playerId,
      guess,
      guessLabel: guess ? ARCHETYPE_LABELS[guess] : '추정 없음',
      actual: player.archetype ?? null,
      actualLabel: ARCHETYPE_LABELS[player.archetype] ?? '확인 불가',
      match: guess !== '' && guess === player.archetype,
    };
  });
}
