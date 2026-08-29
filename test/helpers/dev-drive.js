#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DELAY_MS = 1500;

function parseArgs(argv) {
  const out = { port: 8899, token: 'dev', host: '127.0.0.1' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--port' && next != null) { out.port = Number(next); i += 1; }
    else if (arg === '--token' && next != null) { out.token = next; i += 1; }
    else if (arg === '--host' && next != null) { out.host = next; i += 1; }
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitHealth(base) {
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return;
    } catch { /* 기동 대기 */ }
    await sleep(250);
  }
  throw new Error('서버 health 확인 실패 — 먼저 server.js를 기동하세요.');
}

async function publish(base, token, body) {
  const res = await fetch(`${base}/api/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, ...body }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) {
    throw new Error(`publish 실패 ${res.status} ${JSON.stringify(json)}`);
  }
  return json;
}

function ev(seq, type, extra = {}) {
  return { seq, visibility: 'public', type, ...extra };
}

function seats({ stacks, bets, folded = [], allIn = [], button = 'p1' }) {
  const names = { user: '나', p1: '이서연', p2: '김민준', p3: '박지훈' };
  return ['user', 'p1', 'p2', 'p3'].map((playerId) => ({
    playerId,
    name: names[playerId],
    stack: stacks[playerId],
    bet: bets[playerId] ?? 0,
    folded: folded.includes(playerId),
    allIn: allIn.includes(playerId),
    isButton: playerId === button,
  }));
}

function view(overrides) {
  return {
    handNo: 1,
    level: 0,
    levelEvery: 8,
    blinds: [25, 50],
    street: 'preflop',
    board: [],
    pots: [{ potIndex: 0, amount: 75, eligible: ['user', 'p1', 'p2', 'p3'] }],
    seats: seats({
      stacks: { user: 5000, p1: 5000, p2: 4975, p3: 4950 },
      bets: { user: 0, p1: 0, p2: 25, p3: 50 },
    }),
    toAct: 'user',
    myCards: ['As', 'Td'],
    gameOver: false,
    ...overrides,
  };
}

function legal(extra = {}) {
  return {
    stateVersion: 1,
    decisionId: 'd-1-preflop-0',
    handNo: 1,
    street: 'preflop',
    toAct: 'user',
    canCheck: false,
    callAmount: 50,
    canRaise: true,
    minRaiseTo: 100,
    maxRaiseTo: 5000,
    potTotal: 75,
    handOver: false,
    gameOver: false,
    ...extra,
  };
}

function sequence() {
  const boardFlop = ['Ah', '7c', '2d'];
  const boardRiver = ['Ah', '7c', '2d', '9s', '3c'];
  const eligible = ['user', 'p1', 'p2', 'p3'];

  return [
    {
      label: '핸드 시작(4인)',
      body: {
        publishId: 1,
        view: view({ toAct: 'user' }),
        events: [
          ev(0, 'hand_start', { handNo: 1, level: 0, blinds: [25, 50], button: 'p1' }),
          ev(1, 'blinds_posted', {
            sb: 25,
            bb: 50,
            posts: [
              { playerId: 'p2', amount: 25, allIn: false },
              { playerId: 'p3', amount: 50, allIn: false },
            ],
          }),
        ],
        messages: [{ type: 'narration', text: '핸드 1을 시작합니다. 블라인드 25/50.' }],
      },
    },
    {
      label: '내 차례(legal)',
      body: {
        publishId: 2,
        view: view({
          toAct: 'user',
          legal: legal(),
        }),
        messages: [{ type: 'narration', text: '당신의 차례입니다.' }],
      },
    },
    {
      label: 'AI 액션 1 + talk',
      body: {
        publishId: 3,
        view: view({
          toAct: 'p1',
          pots: [{ potIndex: 0, amount: 125, eligible }],
          seats: seats({
            stacks: { user: 4950, p1: 5000, p2: 4975, p3: 4950 },
            bets: { user: 50, p1: 0, p2: 25, p3: 50 },
          }),
        }),
        events: [
          ev(2, 'action', { playerId: 'user', action: 'call', street: 'preflop' }),
        ],
        messages: [
          { type: 'narration', text: '당신이 콜했습니다.' },
          { type: 'talk', playerId: 'p1', text: '일단 보고 가죠.' },
        ],
      },
    },
    {
      label: 'AI 액션 2 + talk',
      body: {
        publishId: 4,
        view: view({
          toAct: 'p2',
          pots: [{ potIndex: 0, amount: 175, eligible }],
          seats: seats({
            stacks: { user: 4950, p1: 4950, p2: 4975, p3: 4950 },
            bets: { user: 50, p1: 50, p2: 25, p3: 50 },
          }),
        }),
        events: [
          ev(3, 'action', { playerId: 'p1', action: 'call', street: 'preflop' }),
        ],
        messages: [
          { type: 'talk', playerId: 'p2', text: '큰 건 아닌 듯하네요.' },
        ],
      },
    },
    {
      label: 'AI 액션 3 + talk',
      body: {
        publishId: 5,
        view: view({
          toAct: 'p3',
          pots: [{ potIndex: 0, amount: 200, eligible }],
          seats: seats({
            stacks: { user: 4950, p1: 4950, p2: 4950, p3: 4950 },
            bets: { user: 50, p1: 50, p2: 50, p3: 50 },
          }),
        }),
        events: [
          ev(4, 'action', { playerId: 'p2', action: 'call', street: 'preflop' }),
        ],
        messages: [
          { type: 'talk', playerId: 'p3', text: '체크할게요.' },
        ],
      },
    },
    {
      label: '플랍',
      body: {
        publishId: 6,
        view: view({
          street: 'flop',
          board: boardFlop,
          toAct: 'p2',
          pots: [{ potIndex: 0, amount: 200, eligible }],
          seats: seats({
            stacks: { user: 4950, p1: 4950, p2: 4950, p3: 4950 },
            bets: { user: 0, p1: 0, p2: 0, p3: 0 },
          }),
        }),
        events: [
          ev(5, 'action', { playerId: 'p3', action: 'check', street: 'preflop' }),
          ev(6, 'street', { street: 'flop', board: boardFlop }),
        ],
        messages: [{ type: 'narration', text: '플랍이 깔렸습니다.' }],
      },
    },
    {
      label: '쇼다운',
      body: {
        publishId: 7,
        view: view({
          street: 'river',
          board: boardRiver,
          toAct: null,
          pots: [{ potIndex: 0, amount: 200, eligible }],
          seats: seats({
            stacks: { user: 5150, p1: 4950, p2: 4950, p3: 4950 },
            bets: { user: 0, p1: 0, p2: 0, p3: 0 },
          }),
        }),
        events: [
          ev(7, 'street', { street: 'turn', board: boardRiver.slice(0, 4) }),
          ev(8, 'street', { street: 'river', board: boardRiver }),
          ev(9, 'showdown', {
            reveals: [
              { playerId: 'user', cards: ['As', 'Td'], handName: '원페어' },
              { playerId: 'p1', cards: ['Kh', 'Qc'], handName: '하이 카드' },
              { playerId: 'p3', cards: ['Jd', '8s'], handName: '하이 카드' },
            ],
            mucks: ['p2'],
          }),
          ev(10, 'pot_award', {
            potIndex: 0,
            amount: 200,
            winners: [{ playerId: 'user', share: 200 }],
          }),
        ],
        messages: [{ type: 'narration', text: '쇼다운입니다. 당신이 팟을 가져갑니다.' }],
      },
    },
    {
      label: '코치 노트',
      body: {
        publishId: 8,
        coach: [
          {
            handNo: 1,
            text: '프리플랍 콜은 블라인드 대비 가격이 쌌습니다. 다음엔 버튼 뒤에서 레이즈로 주도권을 가져 보세요.',
          },
          {
            handNo: 2,
            text: '이 핸드의 코치 응답을 생성하지 못했습니다. 종합 리뷰에서 해당 핸드를 다시 확인합니다.',
            unavailable: true,
          },
        ],
      },
    },
    {
      label: 'game_over',
      body: {
        publishId: 9,
        view: view({
          street: 'river',
          board: boardRiver,
          toAct: null,
          gameOver: true,
          result: 'win',
          pots: [{ potIndex: 0, amount: 0, eligible }],
          seats: seats({
            stacks: { user: 5150, p1: 4950, p2: 4950, p3: 4950 },
            bets: { user: 0, p1: 0, p2: 0, p3: 0 },
          }),
        }),
        events: [ev(11, 'game_over', { result: 'win', bustedPlayerIds: [] })],
        messages: [{ type: 'narration', text: '게임이 끝났습니다. 우승입니다.' }],
      },
    },
    {
      label: 'review',
      body: {
        publishId: 10,
        view: view({
          street: 'river',
          board: boardRiver,
          toAct: null,
          gameOver: true,
          result: 'win',
          pots: [{ potIndex: 0, amount: 0, eligible }],
          seats: seats({
            stacks: { user: 5150, p1: 4950, p2: 4950, p3: 4950 },
            bets: { user: 0, p1: 0, p2: 0, p3: 0 },
          }),
        }),
        review: [
          '# 종합 리뷰',
          '',
          '결과: **우승**',
          '',
          '## 내 성향 통계 (참고용)',
          '- VPIP 100% · PFR 0% · AF 0 · 쇼다운 승률 100%',
          '',
          '## 결정적 핸드',
          '핸드 1: 프리플랍에서 콜한 과정은 팟 오즈상 무난했습니다. 보드의 에이스와 맞아들며 원페어로 이겼습니다.',
          '',
          '## AI 스타일 공개',
          '- 이서연: TAG',
          '- 김민준: Nit',
          '- 박지훈: LAG',
          '',
          '## 다음 게임에서 연습할 것',
          '- 프리플랍에서 레이즈로 이니셔티브를 가져 보세요.',
        ].join('\n'),
      },
    },
  ];
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const base = `http://${opts.host}:${opts.port}`;
  await waitHealth(base);
  const steps = sequence();
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const result = await publish(base, opts.token, step.body);
    process.stdout.write(`${step.label} → revision ${result.revision}\n`);
    if (i < steps.length - 1) await sleep(DELAY_MS);
  }
}

const isDirectRun = process.argv[1] != null
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun && !process.env.NODE_TEST_CONTEXT) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
