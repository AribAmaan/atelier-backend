// Real chat route, in-memory persistence, captured provider boundary: checks
// which engine a request actually runs on for each membership tier.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');

test('chat route resolves engines by tier (paywall on) and honors retired engine ids', async () => {
  let tier = 'free', counter = 0, captured;
  const history = [];
  const character = { id: 'char', ownerId: 'owner', name: 'Mira', personality: 'Reserved archivist',
    backstory: 'Works in the archive', greeting: '', tagline: '', memorySummary: '', examples: '[]',
    roleplayNotes: '', summarizedThrough: 0, recallAfterCreatedAt: null, recallAfterId: '', explicitEverUsed: false };
  const make = (role, content) => ({ id: `m${++counter}`, role, content, createdAt: new Date(counter * 1000) });
  const prisma = {
    character: { findUnique: async () => ({ ...character }), update: async () => character, updateMany: async () => ({ count: 1 }) },
    user: { findUnique: async () => ({ membershipTier: tier, explicitMode: false }) },
    message: {
      findMany: async ({ skip = 0 } = {}) => history.slice(skip).map(m => ({ ...m })),
      findFirst: async () => history.at(-1),
      create: async ({ data }) => { const m = make(data.role, data.content); history.push(m); return m; },
      update: async ({ where, data }) => Object.assign(history.find(m => m.id === where.id), data),
      count: async () => 0,
    },
  };
  prisma.$transaction = async fn => fn(prisma);
  const replacements = [
    ['../dist/lib/db', { prisma }],
    ['../dist/lib/auth', { getCurrentUserId: async () => 'owner' }],
    ['../dist/lib/rateLimit', { checkRateLimit: () => ({ limited: false }) }],
  ];
  const originals = replacements.map(([path, exports]) => {
    const id = require.resolve(path), old = require.cache[id];
    require.cache[id] = { id, filename: id, loaded: true, exports };
    return [id, old];
  });
  const providers = require('../dist/lib/providers');
  const originalStream = providers.streamChatWithFallback;
  providers.streamChatWithFallback = async (messages, onChunk, _f, _s, params) => {
    captured = { messages: structuredClone(messages), params: { ...params } };
    const text = 'The map is here. Let me check the route.';
    onChunk(text);
    return { text, provider: 'test', finishReason: 'stop' };
  };
  const previousPaywall = process.env.ENFORCE_ENGINE_TIERS;
  process.env.ENFORCE_ENGINE_TIERS = 'true';
  const routerPath = require.resolve('../dist/routes/chat');
  delete require.cache[routerPath];
  const app = express();
  app.use(express.json());
  app.use('/chat', require(routerPath).default);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const send = async (userTier, engineId) => {
    tier = userTier; captured = undefined;
    const response = await fetch(`http://127.0.0.1:${server.address().port}/chat/char`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ engineId, message: 'Hello there' }),
    });
    const body = await response.text();
    assert.equal(response.status, 200, body);
    const events = [...body.matchAll(/\u0000EVT:(.*?)\u0000/g)].map(m => JSON.parse(m[1]));
    return { maxWords: captured.params.maxWords, temperature: captured.params.temperature, events };
  };
  try {
    // Free: Strawberry runs; asking for the premium engine falls back with an upsell event.
    let r = await send('free', 'strawberry');
    assert.deepEqual([r.maxWords, r.temperature], [70, 0.79]);
    assert.equal(r.events.some(e => e.type === 'engine_downgrade'), false);
    r = await send('free', 'hazelnut');
    assert.deepEqual([r.maxWords, r.temperature], [70, 0.79]);
    assert.deepEqual(r.events.find(e => e.type === 'engine_downgrade'),
      { type: 'engine_downgrade', requested: 'choco_hazelnut', used: 'strawberry', requiredTier: 'plus' });
    // Plus and legacy paid accounts get Choco Hazelnut, no downgrade event.
    for (const paid of ['plus', 'ultra', 'supreme']) {
      for (const id of ['choco_hazelnut', 'chocolate', 'hazelnut']) {
        r = await send(paid, id);
        assert.deepEqual([r.maxWords, r.temperature], [130, 0.87], `${paid}/${id}`);
        assert.equal(r.events.some(e => e.type === 'engine_downgrade'), false, `${paid}/${id}`);
      }
    }
    // Retired free id still lands on Strawberry.
    r = await send('free', 'vanilla');
    assert.deepEqual([r.maxWords, r.temperature], [70, 0.79]);
    // An unknown tier value is treated as free.
    r = await send('gold', 'choco_hazelnut');
    assert.equal(r.maxWords, 70);
  } finally {
    if (previousPaywall === undefined) delete process.env.ENFORCE_ENGINE_TIERS; else process.env.ENFORCE_ENGINE_TIERS = previousPaywall;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    providers.streamChatWithFallback = originalStream;
    delete require.cache[routerPath];
    for (const [id, old] of originals) { if (old) require.cache[id] = old; else delete require.cache[id]; }
  }
});
