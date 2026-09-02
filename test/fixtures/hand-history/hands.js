// lastHand-shaped records for PokerStars renderer fixtures.
// Author-owned; not copied from a commercial site.

const SEATS_5000 = { p1: 5000, p2: 5000, user: 5000 };
const POSTS = [
  { playerId: 'p1', amount: 25, allIn: false },
  { playerId: 'p2', amount: 50, allIn: false },
];

function base(overrides) {
  return {
    handNo: 1,
    level: 0,
    blinds: [25, 50],
    button: 'user',
    holes: { user: ['Ah', 'Kd'], p1: ['2c', '3d'], p2: ['7s', '8s'] },
    board: [],
    folded: [],
    allIn: [],
    actions: [],
    pots: [],
    showdown: null,
    startStacks: { ...SEATS_5000 },
    endStacks: { ...SEATS_5000 },
    posts: POSTS.map((post) => ({ ...post })),
    uncalledReturns: {},
    ...overrides,
  };
}

export const HANDS = [
  {
    file: '01-posts-fold.txt',
    record: base({
      folded: ['user', 'p1'],
      actions: [
        { playerId: 'user', action: 'fold', amount: 0, street: 'preflop', currentBet: 50 },
        { playerId: 'p1', action: 'fold', amount: 0, street: 'preflop', currentBet: 50 },
      ],
      uncalledReturns: { p2: 25 },
      pots: [{
        potIndex: 0,
        amount: 50,
        eligible: ['p2'],
        winners: [{ playerId: 'p2', share: 50 }],
      }],
      endStacks: { p1: 4975, p2: 5025, user: 5000 },
    }),
  },
  {
    file: '02-check.txt',
    record: base({
      board: ['2c', '7d', '9h', '3s'],
      folded: ['p1', 'p2'],
      actions: [
        { playerId: 'user', action: 'call', amount: 50, street: 'preflop', currentBet: 50 },
        { playerId: 'p1', action: 'call', amount: 25, street: 'preflop', currentBet: 50 },
        { playerId: 'p2', action: 'check', amount: 0, street: 'preflop', currentBet: 50 },
        { playerId: 'p1', action: 'check', amount: 0, street: 'flop', currentBet: 0 },
        { playerId: 'p2', action: 'check', amount: 0, street: 'flop', currentBet: 0 },
        { playerId: 'user', action: 'check', amount: 0, street: 'flop', currentBet: 0 },
        { playerId: 'p1', action: 'fold', amount: 0, street: 'turn', currentBet: 0 },
        { playerId: 'p2', action: 'fold', amount: 0, street: 'turn', currentBet: 0 },
      ],
      pots: [{
        potIndex: 0,
        amount: 150,
        eligible: ['user'],
        winners: [{ playerId: 'user', share: 150 }],
      }],
      endStacks: { p1: 4950, p2: 4950, user: 5150 },
    }),
  },
  {
    file: '03-call.txt',
    record: base({
      folded: ['p1', 'p2'],
      actions: [
        { playerId: 'user', action: 'call', amount: 50, street: 'preflop', currentBet: 50 },
        { playerId: 'p1', action: 'fold', amount: 0, street: 'preflop', currentBet: 50 },
        { playerId: 'p2', action: 'fold', amount: 0, street: 'preflop', currentBet: 50 },
      ],
      pots: [{
        potIndex: 0,
        amount: 125,
        eligible: ['user'],
        winners: [{ playerId: 'user', share: 125 }],
      }],
      endStacks: { p1: 4975, p2: 4950, user: 5075 },
    }),
  },
  {
    file: '04-bet.txt',
    record: base({
      board: ['2c', '7d', '9h'],
      folded: ['user', 'p2'],
      actions: [
        { playerId: 'user', action: 'call', amount: 50, street: 'preflop', currentBet: 50 },
        { playerId: 'p1', action: 'call', amount: 25, street: 'preflop', currentBet: 50 },
        { playerId: 'p2', action: 'check', amount: 0, street: 'preflop', currentBet: 50 },
        { playerId: 'p1', action: 'raise', amount: 50, street: 'flop', currentBet: 0 },
        { playerId: 'p2', action: 'fold', amount: 0, street: 'flop', currentBet: 50 },
        { playerId: 'user', action: 'fold', amount: 0, street: 'flop', currentBet: 50 },
      ],
      uncalledReturns: { p1: 50 },
      pots: [{
        potIndex: 0,
        amount: 150,
        eligible: ['p1'],
        winners: [{ playerId: 'p1', share: 150 }],
      }],
      endStacks: { p1: 5150, p2: 4950, user: 4950 },
    }),
  },
  {
    file: '05-raise-to.txt',
    record: base({
      folded: ['p1', 'p2'],
      actions: [
        { playerId: 'user', action: 'raise', amount: 200, street: 'preflop', currentBet: 50 },
        { playerId: 'p1', action: 'fold', amount: 0, street: 'preflop', currentBet: 200 },
        { playerId: 'p2', action: 'fold', amount: 0, street: 'preflop', currentBet: 200 },
      ],
      uncalledReturns: { user: 150 },
      pots: [{
        potIndex: 0,
        amount: 125,
        eligible: ['user'],
        winners: [{ playerId: 'user', share: 125 }],
      }],
      endStacks: { p1: 4975, p2: 4950, user: 5075 },
    }),
  },
  {
    file: '06-all-in.txt',
    record: base({
      startStacks: { p1: 5000, p2: 5000, user: 100 },
      allIn: ['user'],
      folded: ['p1', 'p2'],
      actions: [
        { playerId: 'user', action: 'raise', amount: 100, street: 'preflop', currentBet: 50 },
        { playerId: 'p1', action: 'fold', amount: 0, street: 'preflop', currentBet: 100 },
        { playerId: 'p2', action: 'fold', amount: 0, street: 'preflop', currentBet: 100 },
      ],
      uncalledReturns: { user: 50 },
      pots: [{
        potIndex: 0,
        amount: 125,
        eligible: ['user'],
        winners: [{ playerId: 'user', share: 125 }],
      }],
      endStacks: { p1: 4975, p2: 4950, user: 175 },
    }),
  },
  {
    file: '07-folded-raise-uncalled.txt',
    record: base({
      startStacks: { p1: 5000, p2: 50, user: 5000 },
      allIn: ['p2'],
      folded: ['p1'],
      posts: [
        { playerId: 'p1', amount: 25, allIn: false },
        { playerId: 'p2', amount: 50, allIn: true },
      ],
      actions: [
        { playerId: 'user', action: 'call', amount: 50, street: 'preflop', currentBet: 50 },
        { playerId: 'p1', action: 'raise', amount: 80, street: 'preflop', currentBet: 50 },
        { playerId: 'user', action: 'raise', amount: 100, street: 'preflop', currentBet: 80 },
        { playerId: 'p1', action: 'fold', amount: 0, street: 'preflop', currentBet: 100 },
      ],
      uncalledReturns: { user: 20 },
      pots: [
        {
          potIndex: 0,
          amount: 150,
          eligible: ['user', 'p2'],
          winners: [{ playerId: 'user', share: 150 }],
        },
        {
          potIndex: 1,
          amount: 60,
          eligible: ['user'],
          winners: [{ playerId: 'user', share: 60 }],
        },
      ],
      board: ['2c', '7d', '9h', '3s', '4c'],
      showdown: {
        reveals: [{ playerId: 'user', cards: ['Ah', 'Kd'], handName: 'high card' }],
        mucks: ['p2'],
      },
      endStacks: { p1: 4920, p2: 0, user: 5130 },
    }),
  },
  {
    file: '08-unmatched-allin.txt',
    record: base({
      startStacks: { p1: 80, p2: 50, user: 100 },
      allIn: ['p2', 'user', 'p1'],
      posts: [
        { playerId: 'p1', amount: 25, allIn: false },
        { playerId: 'p2', amount: 50, allIn: true },
      ],
      actions: [
        { playerId: 'user', action: 'raise', amount: 100, street: 'preflop', currentBet: 50 },
        { playerId: 'p1', action: 'call', amount: 55, street: 'preflop', currentBet: 100 },
      ],
      uncalledReturns: { user: 20 },
      pots: [
        {
          potIndex: 0,
          amount: 150,
          eligible: ['user', 'p1', 'p2'],
          winners: [{ playerId: 'user', share: 150 }],
        },
        {
          potIndex: 1,
          amount: 60,
          eligible: ['user', 'p1'],
          winners: [{ playerId: 'user', share: 60 }],
        },
      ],
      board: ['As', 'Kd', 'Qh', 'Jc', '9s'],
      showdown: {
        reveals: [
          { playerId: 'user', cards: ['Ah', 'Kd'], handName: 'two pair' },
          { playerId: 'p1', cards: ['2c', '3d'], handName: 'high card' },
        ],
        mucks: ['p2'],
      },
      holes: { user: ['Ah', 'Kd'], p1: ['2c', '3d'], p2: ['7s', '8s'] },
      endStacks: { p1: 0, p2: 0, user: 230 },
    }),
  },
  {
    file: '09-showdown-muck-split.txt',
    record: base({
      board: ['Ts', 'Js', 'Qs', '9s', '2d'],
      actions: [
        { playerId: 'user', action: 'call', amount: 50, street: 'preflop', currentBet: 50 },
        { playerId: 'p1', action: 'call', amount: 25, street: 'preflop', currentBet: 50 },
        { playerId: 'p2', action: 'check', amount: 0, street: 'preflop', currentBet: 50 },
        { playerId: 'p1', action: 'check', amount: 0, street: 'flop', currentBet: 0 },
        { playerId: 'p2', action: 'check', amount: 0, street: 'flop', currentBet: 0 },
        { playerId: 'user', action: 'check', amount: 0, street: 'flop', currentBet: 0 },
        { playerId: 'p1', action: 'check', amount: 0, street: 'turn', currentBet: 0 },
        { playerId: 'p2', action: 'check', amount: 0, street: 'turn', currentBet: 0 },
        { playerId: 'user', action: 'check', amount: 0, street: 'turn', currentBet: 0 },
        { playerId: 'p1', action: 'check', amount: 0, street: 'river', currentBet: 0 },
        { playerId: 'p2', action: 'check', amount: 0, street: 'river', currentBet: 0 },
        { playerId: 'user', action: 'check', amount: 0, street: 'river', currentBet: 0 },
      ],
      pots: [{
        potIndex: 0,
        amount: 150,
        eligible: ['user', 'p1', 'p2'],
        winners: [
          { playerId: 'p1', share: 75 },
          { playerId: 'user', share: 75 },
        ],
      }],
      showdown: {
        reveals: [
          { playerId: 'p1', cards: ['As', 'Ks'], handName: 'straight flush' },
          { playerId: 'user', cards: ['Ah', 'Kh'], handName: 'straight flush' },
        ],
        mucks: ['p2'],
      },
      holes: { user: ['Ah', 'Kh'], p1: ['As', 'Ks'], p2: ['7s', '8s'] },
      endStacks: { p1: 5075, p2: 4950, user: 5075 },
    }),
  },
  {
    file: '10-side-pot.txt',
    record: base({
      startStacks: { p1: 300, p2: 500, user: 100 },
      allIn: ['user', 'p1', 'p2'],
      actions: [
        { playerId: 'user', action: 'raise', amount: 100, street: 'preflop', currentBet: 50 },
        { playerId: 'p1', action: 'raise', amount: 300, street: 'preflop', currentBet: 100 },
        { playerId: 'p2', action: 'call', amount: 250, street: 'preflop', currentBet: 300 },
      ],
      pots: [
        {
          potIndex: 0,
          amount: 300,
          eligible: ['user', 'p1', 'p2'],
          winners: [{ playerId: 'p2', share: 300 }],
        },
        {
          potIndex: 1,
          amount: 400,
          eligible: ['p1', 'p2'],
          winners: [{ playerId: 'p2', share: 400 }],
        },
      ],
      board: ['2c', '7d', '9h', '3s', '4c'],
      showdown: {
        reveals: [
          { playerId: 'p2', cards: ['As', 'Ad'], handName: 'a pair of Aces' },
          { playerId: 'p1', cards: ['Kc', 'Kd'], handName: 'a pair of Kings' },
          { playerId: 'user', cards: ['Ah', 'Kd'], handName: 'high card' },
        ],
        mucks: [],
      },
      holes: { user: ['Ah', 'Kd'], p1: ['Kc', 'Kd'], p2: ['As', 'Ad'] },
      endStacks: { p1: 0, p2: 800, user: 0 },
    }),
  },
];
