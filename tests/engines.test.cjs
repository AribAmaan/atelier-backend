const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ROLEPLAY_ENGINES, getEngineConfig, normalizeEngineId, normalizeMembershipTier, resolveEngineForTier,
  FREE_ENGINE_ID, PREMIUM_ENGINE_ID,
} = require('../dist/lib/providers/engines');
const { membershipAmountInPaise } = require('../dist/lib/payments/razorpay');
const { buildSystemPrompt } = require('../dist/lib/providers');

test('exactly two engines: Strawberry (free) and Choco Hazelnut (plus)', () => {
  assert.deepEqual(Object.keys(ROLEPLAY_ENGINES), ['strawberry', 'choco_hazelnut']);
  assert.equal(FREE_ENGINE_ID, 'strawberry');
  assert.equal(PREMIUM_ENGINE_ID, 'choco_hazelnut');
  assert.equal(ROLEPLAY_ENGINES.strawberry.minTier, 'free');
  assert.equal(ROLEPLAY_ENGINES.choco_hazelnut.minTier, 'plus');
});

test('Strawberry keeps its full previous configuration', () => {
  const s = ROLEPLAY_ENGINES.strawberry;
  assert.deepEqual([s.intelligence, s.recentMessageWindow, s.summarizeTrigger, s.temperature, s.topP, s.roleplayStyle],
    [6, 11, 18, 0.79, 0.92, 'balanced']);
});

test('Choco Hazelnut is at least as strong as Chocolate and Hazelnut on every axis', () => {
  const c = ROLEPLAY_ENGINES.choco_hazelnut;
  assert.equal(c.intelligence, 10);                 // Hazelnut 10, Chocolate 8
  assert.ok(c.recentMessageWindow >= 15);           // Chocolate 15, Hazelnut 10
  assert.ok(c.temperature >= 0.87 && c.topP >= 0.95);
  assert.equal(c.roleplayStyle, 'intense');         // matches the frontend
  assert.ok(c.voiceNotes.length <= 1800, 'fits the compact prompt voice-note budget untruncated');
  // Ideas from both engines survive in the merged notes.
  assert.match(c.voiceNotes, /unresolved threads/i);        // Chocolate
  assert.match(c.voiceNotes, /independent, persona-consistent/i); // Hazelnut
  assert.match(c.voiceNotes, /hesitation or refusal/i);     // consent guard, both
});

test('retired and alternate engine ids resolve to the two current engines', () => {
  for (const id of ['vanilla', 'strawberry', 'Strawberry', ' STRAWBERRY ']) assert.equal(normalizeEngineId(id), 'strawberry');
  for (const id of ['chocolate', 'hazelnut', 'choco_hazelnut', 'choco-hazelnut', 'Choco Hazelnut', 'chocolate_hazelnut', 'chocohazelnut'])
    assert.equal(normalizeEngineId(id), 'choco_hazelnut', id);
  for (const id of ['custom', '', 'constructor', '__proto__', null, undefined, 5, {}]) assert.equal(normalizeEngineId(id), null, String(id));
  assert.equal(getEngineConfig('hazelnut').id, 'choco_hazelnut');
  assert.equal(getEngineConfig('toString'), null);
});

test('legacy paid tiers count as Plus; everything else is Free', () => {
  for (const t of ['plus', 'ultra', 'supreme']) assert.equal(normalizeMembershipTier(t), 'plus');
  for (const t of ['free', '', 'gold', null, undefined, 3]) assert.equal(normalizeMembershipTier(t), 'free');
});

test('paywall: off by default; when enforced, Free falls back to Strawberry and legacy paid accounts keep Choco Hazelnut', () => {
  const previous = process.env.ENFORCE_ENGINE_TIERS;
  try {
    delete process.env.ENFORCE_ENGINE_TIERS;
    assert.equal(resolveEngineForTier('hazelnut', 'free').engine.id, 'choco_hazelnut');
    process.env.ENFORCE_ENGINE_TIERS = 'true';
    const free = resolveEngineForTier('hazelnut', 'free');
    assert.equal(free.engine.id, 'strawberry');
    assert.equal(free.downgradedFrom, 'choco_hazelnut');
    assert.equal(free.requiredTier, 'plus');
    assert.equal(resolveEngineForTier('vanilla', 'free').downgradedFrom, null);
    for (const tier of ['plus', 'ultra', 'supreme']) {
      const r = resolveEngineForTier('chocolate', tier);
      assert.equal(r.engine.id, 'choco_hazelnut');
      assert.equal(r.downgradedFrom, null);
    }
    assert.equal(resolveEngineForTier('custom', 'free').engine, null);
  } finally {
    if (previous === undefined) delete process.env.ENFORCE_ENGINE_TIERS; else process.env.ENFORCE_ENGINE_TIERS = previous;
  }
});

test('Plus is the only paid plan: 200 INR/month, quarterly x2.85, yearly x10', () => {
  assert.equal(membershipAmountInPaise('plus', 'monthly'), 20000);
  assert.equal(membershipAmountInPaise('plus', 'quarterly'), 57000);
  assert.equal(membershipAmountInPaise('plus', 'yearly'), 200000);
});

test('Choco Hazelnut prompt carries the merged voice notes in both context modes', () => {
  const character = { name: 'Mira', personality: 'Reserved archivist.', backstory: 'Keeps records.' };
  const engine = ROLEPLAY_ENGINES.choco_hazelnut;
  const previous = process.env.HAZELNUT_COMPACT_CONTEXT;
  try {
    for (const mode of [undefined, 'false']) {
      if (mode === undefined) delete process.env.HAZELNUT_COMPACT_CONTEXT; else process.env.HAZELNUT_COMPACT_CONTEXT = mode;
      const prompt = buildSystemPrompt(character, { explicitMode: true, engine, voiceNotes: engine.voiceNotes });
      assert.ok(prompt.includes(engine.voiceNotes), `full voice notes present (compact=${mode !== 'false'})`);
      assert.match(prompt, /At Choco Hazelnut tier/);
    }
  } finally {
    if (previous === undefined) delete process.env.HAZELNUT_COMPACT_CONTEXT; else process.env.HAZELNUT_COMPACT_CONTEXT = previous;
  }
});
