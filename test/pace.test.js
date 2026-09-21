import test from 'node:test';
import assert from 'node:assert/strict';

test('pace presets are explicit and old setup remains instant', async () => {
  const {paceFor} = await import('../shared/pace.js');
  const expected = {
    instant: {handResultDwellMs:0,aiActionIntervalMs:0,runoutStepMs:0},
    fast: {handResultDwellMs:1500,aiActionIntervalMs:300,runoutStepMs:400},
    normal: {handResultDwellMs:3500,aiActionIntervalMs:700,runoutStepMs:800},
    slow: {handResultDwellMs:6000,aiActionIntervalMs:1200,runoutStepMs:1200},
  };
  for (const [pace, value] of Object.entries(expected)) assert.deepEqual(paceFor({pace}), value);
  for (const setup of [undefined, {}, {pace:undefined}]) assert.deepEqual(paceFor(setup), expected.instant);
  assert.throws(() => paceFor({pace:'unexpected'}));
});

test('setup preserves pace only when explicitly selected', async () => {
  const {normalizeSetup,setupToArgs} = await import('../shared/game-setup.js');
  assert.equal(Object.hasOwn(normalizeSetup({}), 'pace'), false);
  for (const pace of ['instant','fast','normal','slow']) {
    assert.equal(normalizeSetup({pace}).pace, pace);
    assert.equal(setupToArgs({pace}, '/store').pace, pace);
  }
  assert.throws(() => normalizeSetup({pace:'bogus'}), {code:'INVALID_SETUP'});
});

test('result hold is a bounded card-free envelope tied to a completed hand', async () => {
  const {validateResultHold} = await import('../shared/multiplayer-publish.js');
  assert.equal(typeof validateResultHold, 'function');
  const view = {handNo:1,handInProgress:false};
  const hold = {handNo:1,startAt:'2026-09-21T00:00:00.000Z',until:'2026-09-21T00:00:03.500Z',runoutStepMs:800,runoutStreets:0};
  assert.deepEqual(validateResultHold(hold,view),hold);
  for (const invalid of [ {...hold,extra:1}, {...hold,startAt:'bad'}, {...hold,until:'2026-09-20T23:59:59.999Z'},
    {...hold,until:'2026-09-21T00:01:00.001Z'}, {...hold,runoutStepMs:5001}, {...hold,runoutStepMs:-1},
    {...hold,runoutStreets:4}, {...hold,runoutStreets:0.5}, {...hold,handNo:2} ]) {
    assert.throws(() => validateResultHold(invalid,view), {code:'BAD_RESULT_HOLD'});
  }
  assert.throws(() => validateResultHold(hold,{...view,handInProgress:true}), {code:'BAD_RESULT_HOLD'});
  assert.throws(() => validateResultHold(hold,undefined), {code:'BAD_RESULT_HOLD'});
});

test('result hold survives seat projection without exposing host channels', async () => {
  const { projectForSeat } = await import('../shared/multiplayer-publish.js');
  const hold = {handNo:1,startAt:'2026-09-21T00:00:00.000Z',until:'2026-09-21T00:00:03.500Z',runoutStepMs:800,runoutStreets:0};
  const frame = {view:{viewer:'user'},views:{user:{viewer:'user'},h1:{viewer:'h1'}},resultHold:hold,coach:[{text:'private'}]};
  assert.deepEqual(projectForSeat(frame,'h1'), {view:{viewer:'h1'},resultHold:hold});
  assert.deepEqual(projectForSeat(frame,'user').resultHold,hold);
  assert.deepEqual(projectForSeat({views:frame.views},'h1'),{view:{viewer:'h1'}});
});
