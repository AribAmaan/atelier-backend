const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFlag, bucketFor, flagEnabled, resolveArms, armsTag, FLAG_SPECS, FLAG_NAMES } = require('../dist/lib/roleplayFlags');

const ENV_KEYS = Object.values(FLAG_SPECS).map(s => s.env);
function withEnv(values, fn) {
  const saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, values);
  try { return fn(); } finally {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

test('defaults follow the evidence: shortening and action-capping are off; director and persona anchor are on', () => {
  withEnv({}, () => {
    assert.deepEqual(resolveArms('user-1'), { adaptiveRhythm: false, director: true, actionCap: false, personaAnchor: true });
    assert.equal(armsTag(resolveArms('user-1')), 'ar0.dr1.ac0.pa1');
  });
});

test('flag grammar: on/off words, case, whitespace, and garbage falls back without throwing', () => {
  for (const v of ['on', 'ON', ' true ', '1', 'yes']) assert.equal(parseFlag(v, false, 'f', 'u'), true, v);
  for (const v of ['off', 'OFF', ' false ', '0', 'no']) assert.equal(parseFlag(v, true, 'f', 'u'), false, v);
  for (const v of [undefined, '', '   ', 'maybe', 'split:', 'split:abc', 'split:-5', 'split:1.5', 'split:50%', 'splitx:50']) {
    assert.equal(parseFlag(v, true, 'f', 'u'), true, String(v));
    assert.equal(parseFlag(v, false, 'f', 'u'), false, String(v));
  }
});

test('split assignment is sticky: the same user always lands in the same arm', () => {
  for (const id of ['a', 'user-42', 'cuid_9f8e7d', '']) {
    const first = parseFlag('split:50', false, 'adaptiveRhythm', id || undefined);
    for (let i = 0; i < 50; i++) assert.equal(parseFlag('split:50', false, 'adaptiveRhythm', id || undefined), first);
  }
  assert.equal(bucketFor('x', 'u'), bucketFor('x', 'u'));
  assert.ok(bucketFor('x', 'u') >= 0 && bucketFor('x', 'u') < 100);
});

test('split honours its percentage over many users (within 1.5 points)', () => {
  const N = 20000;
  for (const pct of [10, 30, 50, 90]) {
    let on = 0;
    for (let i = 0; i < N; i++) if (parseFlag(`split:${pct}`, false, 'director', `user-${i}`)) on++;
    assert.ok(Math.abs(on / N * 100 - pct) < 1.5, `split:${pct} gave ${(on / N * 100).toFixed(2)}%`);
  }
});

test('split extremes and a missing user id', () => {
  assert.equal(parseFlag('split:0', true, 'f', 'u'), false);
  assert.equal(parseFlag('split:100', false, 'f', 'u'), true);
  assert.equal(parseFlag('split:999', false, 'f', 'u'), true, 'over 100 clamps to everyone');
  assert.equal(parseFlag('split:50', true, 'f', undefined), false, 'no user id is the control arm');
});

test('flags are assigned independently, so each can be analysed on its own', () => {
  const N = 20000;
  let a = 0, b = 0, both = 0;
  for (let i = 0; i < N; i++) {
    const x = parseFlag('split:50', false, 'adaptiveRhythm', `user-${i}`);
    const y = parseFlag('split:50', false, 'actionCap', `user-${i}`);
    if (x) a++; if (y) b++; if (x && y) both++;
  }
  const expected = (a / N) * (b / N);
  assert.ok(Math.abs(both / N - expected) < 0.012, `joint ${both / N} vs independent ${expected}`);
});

test('resolveArms reads the environment per user and the no-user control', () => {
  withEnv({ ADAPTIVE_REPLY_RHYTHM: 'split:50', ROLEPLAY_DIRECTOR: 'off', ROLEPLAY_ACTION_CAP: 'on' }, () => {
    const arms = resolveArms('some-user');
    assert.equal(arms.director, false);
    assert.equal(arms.actionCap, true);
    assert.equal(arms.adaptiveRhythm, parseFlag('split:50', false, 'adaptiveRhythm', 'some-user'));
    assert.equal(flagEnabled('adaptiveRhythm'), false, 'no user -> control');
  });
  assert.deepEqual(FLAG_NAMES.sort(), ['actionCap', 'adaptiveRhythm', 'director', 'personaAnchor']);
});
