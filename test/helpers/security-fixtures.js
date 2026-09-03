import fs from 'node:fs';
import path from 'node:path';

// Q1(C1·C2)부터 서버의 보안 술어는 세션 디렉터리의 세 자료를 **전부** 읽는다:
// `players.json`(비공개 정책 필드) · `state.json`(엔진 gameOver·policySeed·진행 중 핸드) ·
// `hands/hand-NNNN.json`(과거 핸드의 미공개 홀카드). 하나라도 없으면 explanation은
// `FORBIDDEN_LITERAL_UNAVAILABLE`로 거부되므로, 서버에 annotation을 게시하는 테스트는
// 이 helper로 세 자료를 한 번에 심는다.

export const FIXTURE_ARCHETYPE = 'FIXTURE_ARCHETYPE_SENTINEL';
export const FIXTURE_POLICY_ID = 'fixture-policy-v1';
export const FIXTURE_CONFIG_DIGEST = 'c0'.repeat(32);
export const FIXTURE_POLICY_SEED = 'de'.repeat(32);

export function defaultPlayers() {
  return [
    { playerId: 'user' },
    {
      playerId: 'p1',
      archetype: FIXTURE_ARCHETYPE,
      policy: { policyId: FIXTURE_POLICY_ID, configDigest: FIXTURE_CONFIG_DIGEST },
    },
  ];
}

export function handRecordFixture(handNo, { holes = {}, reveals = null } = {}) {
  const record = { handNo, holes };
  if (reveals) record.showdown = { reveals, mucks: [] };
  return record;
}

export function handFilePath(dir, handNo) {
  return path.join(dir, 'hands', `hand-${String(handNo).padStart(4, '0')}.json`);
}

export function writeSecurityFixtures(dir, {
  gameOver = false,
  hands = [handRecordFixture(1, { holes: { user: ['Ah', 'Kh'] } })],
  players = defaultPlayers(),
  handInProgress = null,
  state = {},
} = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'players.json'), JSON.stringify(players));
  const archived = [...hands].sort((left, right) => (left.handNo ?? 0) - (right.handNo ?? 0));
  const lastHand = archived.length ? archived[archived.length - 1] : null;
  const engineState = {
    schemaVersion: 1,
    stateVersion: 1,
    handNo: handInProgress?.handNo ?? lastHand?.handNo ?? 0,
    policySeed: FIXTURE_POLICY_SEED,
    hand: handInProgress,
    lastHand,
    gameOver,
    ...state,
  };
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(engineState));
  if (archived.length) {
    fs.mkdirSync(path.join(dir, 'hands'), { recursive: true });
    for (const record of archived) {
      fs.writeFileSync(handFilePath(dir, record.handNo), JSON.stringify(record));
    }
  }
  return { players, state: engineState, hands: archived };
}
