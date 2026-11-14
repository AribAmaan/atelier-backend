// End-to-end through the real chat route (in-memory persistence, captured provider boundary):
// the ** narrator / scene director reaches the model with top priority, no length limits are
// requested or enforced, and the removed shaping prompts never come back.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');

test('chat route: narrator / scene director delivery and no shaping prompts', async t => {
  let history = [], captured, counter = 0, replyText = 'The map is here. Let me check the route.', explicit = false;
  const character = { id: 'char', ownerId: 'owner', name: 'Mira', personality: 'Reserved archivist', backstory: 'Works in the archive',
    greeting: '*I unlock the archive.*', tagline: 'Archivist', memorySummary: '', examples: '[]', roleplayNotes: '', summarizedThrough: 0,
    recallAfterCreatedAt: null, recallAfterId: '', explicitEverUsed: false };
  const make = (role, content) => ({ id: `m${++counter}`, role, content, createdAt: new Date(counter * 1000) });
  const prisma = {
    character: { findUnique: async () => ({ ...character }), update: async ({ data }) => Object.assign(character, data), updateMany: async ({ data }) => { Object.assign(character, data); return { count: 1 }; } },
    user: { findUnique: async () => ({ membershipTier: 'supreme', explicitMode: explicit }) },
    message: {
      findMany: async ({ skip = 0, take, where } = {}) => (where?.AND ? [] : history.slice(skip, take === undefined ? undefined : skip + take).map(m => ({ ...m }))),
      findFirst: async () => history.at(-1),
      create: async ({ data }) => { const m = make(data.role, data.content); history.push(m); return m; },
      update: async ({ where, data }) => Object.assign(history.find(m => m.id === where.id), data),
      count: async () => 0,
    },
  };
  prisma.$transaction = async fn => fn(prisma);
  const originals = [['../dist/lib/db', { prisma }], ['../dist/lib/auth', { getCurrentUserId: async () => 'owner' }], ['../dist/lib/rateLimit', { checkRateLimit: () => ({ limited: false }) }]]
    .map(([path, exports]) => { const id = require.resolve(path), old = require.cache[id]; require.cache[id] = { id, filename: id, loaded: true, exports }; return [id, old]; });
  const providers = require('../dist/lib/providers');
  const originalStream = providers.streamChatWithFallback;
  providers.streamChatWithFallback = async (messages, onChunk, _f, _s, params) => {
    captured = { messages: structuredClone(messages), params: { ...params } };
    onChunk(replyText);
    return { text: replyText, provider: 'test', finishReason: 'stop' };
  };
  const routerPath = require.resolve('../dist/routes/chat');
  delete require.cache[routerPath];
  const app = express(); app.use(express.json()); app.use('/chat', require(routerPath).default);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const request = async body => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/chat/char`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(r.status, 200, await r.text());
    return captured;
  };
  const systems = c => c.messages.filter(m => m.role === 'system');
  const TAIL = /^NARRATOR \/ SCENE DIRECTOR/;
  try {
    await t.test('** in the user turn: rules, perception guard, segment label and tail note all present', async () => {
      history = [make('user', 'Where is the map?'), make('assistant', 'Shall I check the archive?')];
      const c = await request({ engineId: 'choco_hazelnut', message: 'Hey **the lights die and someone knocks**' });
      const sys = c.messages[0].content;
      assert.match(sys, /Text between asterisks \(\*like this\* or \*\*like this\*\*\) is the NARRATOR \/ SCENE DIRECTOR/);
      assert.match(sys, /CURRENT USER TURN — PERCEPTION CHECK/);
      assert.match(sys, /NARRATOR \/ SCENE DIRECTOR \(highest priority this turn\): apply every narrator_director segment/);
      assert.match(c.messages.at(-1).content, /"delivery":"narrator_director".*"authority":"canon_highest_priority"/);
      assert.equal(c.messages.at(-1).role, 'user');
      assert.equal(c.messages.at(-2).role, 'system');
      assert.match(c.messages.at(-2).content, TAIL);
      assert.equal(systems(c).filter(m => TAIL.test(m.content)).length, 1);
      assert.equal(history.find(m => m.content.startsWith('Hey **')).content, 'Hey **the lights die and someone knocks**', 'stored raw, not wrapped');
    });
    await t.test('single * scene direction ("*Suzy says*") reaches the model as director and tells it to voice Suzy', async () => {
      history = [make('user', 'suzy my aunt abigails lil sis enters the room'), make('assistant', 'Hey, Suzy.')];
      const c = await request({ engineId: 'choco_hazelnut', message: '*suzy says*' });
      assert.match(c.messages.at(-1).content, /"text":"suzy says","delivery":"narrator_director"/);
      assert.match(c.messages.at(-2).content, TAIL);
      assert.match(c.messages.at(-2).content, /another character .*write that character's action and actual spoken words/s);
      assert.match(c.messages[0].content, /OTHER CHARACTERS/);
      assert.match(c.messages[0].content, /A direction with no wording \("\*Suzy says\*"\) means: decide what Suzy says and write it/);
      assert.match(c.messages[0].content, /voice any other character the narrator brings in or directs/);
    });
    await t.test('no limits requested or enforced, and no shaping prompts', async () => {
      for (const [engineId, tokens] of [['strawberry', 700], ['choco_hazelnut', 1000]]) {
        history = [];
        const c = await request({ engineId, message: 'hi' });
        assert.equal(c.params.maxTokens, tokens);
        for (const k of ['maxWords', 'minWords', 'targetWords']) assert.equal(c.params[k], undefined, k);
        assert.equal(systems(c).length, 1, 'plain turn: one system message, no tail notes');
        assert.doesNotMatch(JSON.stringify(c.messages), /CHARACTER REMINDER|REPLY LENGTH|Aim for around|CURRENT RESPONSE FOCUS|NO LOOPS|ROLEPLAY CRAFT|TIER-LOCKED|Real-world message gap/);
      }
    });
    await t.test('a long reply is saved in full (no clamp, no dedupe)', async () => {
      history = [];
      replyText = Array.from({ length: 400 }, (_, i) => `Sentence ${i % 3} stays the same here.`).join(' ');
      await request({ engineId: 'strawberry', message: 'tell me everything' });
      assert.equal(history.at(-1).role, 'assistant');
      assert.equal(history.at(-1).content, replyText);
      replyText = 'The map is here. Let me check the route.';
    });
    await t.test('scene-director steer: delivered per turn, never cached into the system prompt', async () => {
      history = [make('user', 'Where is the map?'), make('assistant', 'Shall I check?')];
      const c1 = await request({ engineId: 'strawberry', message: 'Yes', sceneDirective: 'She finally confesses the truth' });
      assert.match(c1.messages.at(-2).content, TAIL);
      assert.match(c1.messages.at(-2).content, /She finally confesses the truth/);
      assert.match(c1.messages[0].content, /scene-director steer as canon/);
      const c2 = await request({ engineId: 'strawberry', message: 'Go on' });
      assert.doesNotMatch(JSON.stringify(c2.messages), /finally confesses/);
      assert.equal(systems(c2).length, 1);
    });
    await t.test('continue (last turn is the assistant): old ** is not replayed, only the steer applies', async () => {
      history = [make('user', 'Yes **a storm breaks**'), make('assistant', '*I unfold the map.*')];
      const c = await request({ engineId: 'strawberry', sceneDirective: 'Continue' });
      assert.equal(c.messages.at(-1).role, 'assistant');
      assert.doesNotMatch(c.messages[0].content, /PERCEPTION CHECK|apply every narrator_director segment/);
      const note = systems(c).filter(m => TAIL.test(m.content));
      assert.equal(note.length, 1);
      assert.match(note[0].content, /Scene-director steer for this reply: "Continue"/);
      assert.doesNotMatch(note[0].content, /asterisk parts/);
    });
    await t.test('regenerate drops the last reply and re-applies the ** of the user turn it answers', async () => {
      history = [make('user', 'Hey **a knock at the door**'), make('assistant', 'Discard this old answer.')];
      const c = await request({ engineId: 'strawberry', regenerate: true });
      assert.doesNotMatch(JSON.stringify(c.messages), /Discard this old answer/);
      assert.match(c.messages.at(-2).content, TAIL);
      assert.match(c.messages.at(-2).content, /asterisk parts/);
    });
    await t.test('mature mode keeps adult-only + consent and asks for explicit writing', async () => {
      explicit = true; history = [];
      const c = await request({ engineId: 'choco_hazelnut', message: 'hi' });
      assert.match(c.messages[0].content, /clearly 18\+ and the context is consensual/);
      assert.match(c.messages[0].content, /Respect hesitation or refusal immediately/);
      explicit = false;
    });
  } finally {
    server.closeAllConnections(); await new Promise(r => server.close(r));
    providers.streamChatWithFallback = originalStream; delete require.cache[routerPath];
    for (const [id, old] of originals) { if (old) require.cache[id] = old; else delete require.cache[id]; }
  }
});
