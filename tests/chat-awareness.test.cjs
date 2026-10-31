// Exercise the real HTTP route and prompt cache with in-memory persistence and
// a captured provider boundary. No account, database, or paid API is contacted.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');
const { CONVERSATION_AWARENESS_RULES } = require('../dist/lib/conversationAwareness');

test('chat route delivers awareness through engine switches, continuation, regeneration and cache updates', async t => {
  let history = [], captured, counter = 0, useRealCount = false, recallWhere, summaryCommitted;
  const character = { id: 'char', ownerId: 'owner', name: 'Mira', personality: 'Reserved archivist',
    backstory: 'Works in the archive', greeting: '*I unlock the archive.*', tagline: 'Archivist',
    memorySummary: '', examples: '[]', roleplayNotes: '', summarizedThrough: 0,
    recallAfterCreatedAt: null, recallAfterId: '', explicitEverUsed: false };
  const make = (role, content) => ({ id: `m${++counter}`, role, content, createdAt: new Date(counter * 1000) });
  const prisma = {
    character: {
      findUnique: async () => ({ ...character }),
      update: async ({ data }) => Object.assign(character, data),
      updateMany: async ({ data }) => {
        Object.assign(character, data);
        summaryCommitted?.();
        return { count: 1 };
      },
    },
    user: { findUnique: async () => ({ membershipTier: 'supreme', explicitMode: false }) },
    message: {
      findMany: async ({ skip = 0, take, where } = {}) => {
        if (where?.AND) {
          recallWhere = where;
          // Simulate the database's ordered-tuple cutoff for candidate recall.
          const [old, ...rest] = history;
          const after = where.AND.find(part => part.OR?.some(branch => branch.createdAt?.gt));
          return [old, ...rest].filter(m => !after ||
            m.createdAt > after.OR[0].createdAt.gt ||
            (m.createdAt.getTime() === after.OR[1].createdAt.getTime() && m.id > after.OR[1].id.gt));
        }
        return history.slice(skip, take === undefined ? undefined : skip + take).map(m => ({ ...m }));
      },
      findFirst: async () => history.at(-1),
      create: async ({ data }) => { const message = make(data.role, data.content); history.push(message); return message; },
      update: async ({ where, data }) => Object.assign(history.find(m => m.id === where.id), data),
      // Suppress background summarization: this suite targets reply assembly.
      count: async () => useRealCount ? history.length : 0,
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
  const originalSummarize = providers.summarizeConversation;
  providers.streamChatWithFallback = async (messages, onChunk, _failover, _signal, params) => {
    captured = { messages: structuredClone(messages), params: { ...params } };
    const text = 'The map is here. Let me check the route.';
    onChunk(text);
    return { text, provider: 'test', finishReason: 'stop' };
  };
  const routerPath = require.resolve('../dist/routes/chat');
  delete require.cache[routerPath];
  const app = express();
  app.use(express.json());
  app.use('/chat', require(routerPath).default);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const request = async body => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/chat/char`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    return captured;
  };
  try {
    for (const [engineId, maxWords] of [['strawberry', 70], ['choco_hazelnut', 130], ['vanilla', 70], ['chocolate', 130], ['hazelnut', 130]]) {
      await t.test(engineId, async () => {
        history = [make('user', 'Where is the map?'), make('assistant', 'Shall I check the archive?')];
        const result = await request({ engineId, message: 'Yes *I secretly hope it is there*' });
        assert.ok(result.messages[0].content.includes(CONVERSATION_AWARENESS_RULES));
        assert.match(result.messages[0].content, /CURRENT RESPONSE FOCUS/);
        assert.match(result.messages.at(-1).content, /unspoken_context/);
        // The recency anchor sits just before the final user turn; the
        // conversation itself (ignoring system notes) is still in order.
        const convo = result.messages.slice(1).filter(m => m.role !== 'system');
        assert.equal(convo.at(-1).role, 'user');
        assert.match(convo.at(-2).content, /Shall I check the archive/);
        assert.match(result.messages.at(-2).content, /^CHARACTER REMINDER/);
        assert.equal(result.params.maxWords, maxWords);
        assert.equal(history.at(-2).content, 'Yes *I secretly hope it is there*');
      });
    }
    await t.test('continue', async () => {
      history = [make('user', 'Yes *I am secretly nervous*'), make('assistant', '*I unfold the map.*')];
      const result = await request({ engineId: 'hazelnut', sceneDirective: 'Continue' });
      assert.match(result.messages[0].content, /No new user dialogue or action was supplied/);
      assert.doesNotMatch(result.messages[0].content, /CURRENT USER TURN — PERCEPTION CHECK/);
      assert.equal(result.messages.at(-1).role, 'assistant');
    });
    await t.test('regenerate', async () => {
      history = [make('user', 'Where is the map?'), make('assistant', 'Discard this old answer.')];
      const result = await request({ engineId: 'hazelnut', regenerate: true });
      assert.match(result.messages[0].content, /Respond to the last user turn/);
      assert.doesNotMatch(JSON.stringify(result.messages), /Discard this old answer/);
      assert.equal(history.length, 2);
    });
    await t.test('greeting update invalidates the cached persona', async () => {
      character.greeting = '*I open the observatory dome.*';
      history = [];
      const result = await request({ engineId: 'strawberry', message: 'Hello' });
      assert.match(result.messages[0].content, /observatory dome/);
      assert.doesNotMatch(result.messages[0].content, /I unlock the archive/);
    });
    await t.test('summary backlog retains relevant older constraints', async () => {
      history = [make('user', 'Please never call me darling.')];
      for (let i = 0; i < 55; i++) history.push(make(i % 2 ? 'user' : 'assistant', 'Ordinary small talk. '.repeat(18)));
      const result = await request({ engineId: 'vanilla', message: 'Where is the museum key?' });
      assert.match(result.messages[0].content, /never call me darling/);
      assert.equal(result.messages[1].role, 'user');
    });
    await t.test('forgetting memory excludes old transcript even after new turns', async () => {
      useRealCount = true;
      history = [make('user', 'The hidden museum key is under the floor.'),
        make('assistant', 'I will remember that.')];
      // An earlier summary is now explicitly forgotten while messages remain visible.
      character.memorySummary = 'The hidden museum key is under the floor.';
      const response = await fetch(`http://127.0.0.1:${server.address().port}/chat/char/memory`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ forget: true }),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { memorySummary: '', summarizedThrough: 2 });
      assert.equal(character.recallAfterId, history[1].id);
      assert.equal(character.recallAfterCreatedAt.getTime(), history[1].createdAt.getTime());
      recallWhere = null;
      const result = await request({ engineId: 'hazelnut', message: 'What about the museum key?' });
      assert.ok(recallWhere, 'older transcript search ran');
      assert.deepEqual(recallWhere.AND.at(-1), { OR: [
        { createdAt: { gt: character.recallAfterCreatedAt } },
        { createdAt: character.recallAfterCreatedAt, id: { gt: character.recallAfterId } },
      ] });
      assert.doesNotMatch(JSON.stringify(result.messages), /under the floor/);
      assert.equal(history[0].content, 'The hidden museum key is under the floor.');
      useRealCount = false;
    });
    for (const [engineId, initialCount] of [['strawberry', 16], ['choco_hazelnut', 29]]) {
      await t.test(`${engineId} summary keeps an unanswered user turn in recent context`, async () => {
        useRealCount = true;
        character.memorySummary = '';
        character.summarizedThrough = 0;
        character.recallAfterCreatedAt = null;
        character.recallAfterId = '';
        history = Array.from({ length: initialCount }, (_, i) =>
          make(i % 2 ? 'assistant' : 'user', `Exchange ${i}`));
        let folded;
        providers.summarizeConversation = async (_character, _previous, messages) => {
          folded = messages;
          return 'A short continuity summary.';
        };
        const done = new Promise(resolve => { summaryCommitted = resolve; });
        await request({ engineId, message: 'Can you check the gate?' });
        await done;
        assert.equal(folded.at(-1).role, 'assistant');
        assert.equal(history[folded.length].role, 'user');
        assert.equal(character.summarizedThrough, folded.length);
        summaryCommitted = undefined;
        useRealCount = false;
      });
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    providers.streamChatWithFallback = originalStream;
    providers.summarizeConversation = originalSummarize;
    delete require.cache[routerPath];
    for (const [id, old] of originals) { if (old) require.cache[id] = old; else delete require.cache[id]; }
  }
});
