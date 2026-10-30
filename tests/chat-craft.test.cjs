// End-to-end on the real HTTP route with in-memory persistence and a captured
// provider boundary: the turn director reaches the prompt, a quick beat relaxes
// the word floor, and the saved / final reply is polished. No DB or paid API.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');

const MESSY = 'Mira: *She smirks, tucking a strand of hair behind her ear.* Come in before the rain starts. What would you like to do next?';

async function run({ engineId, priorAssistant, userMessage, sceneDirective }) {
  let history = [], captured, counter = 0;
  const character = { id: 'char', ownerId: 'owner', name: 'Mira', personality: 'Reserved archivist',
    backstory: 'Works in the archive', greeting: '*I unlock the archive.*', tagline: 'Archivist',
    memorySummary: '', examples: '[]', roleplayNotes: '', summarizedThrough: 0,
    recallAfterCreatedAt: null, recallAfterId: '', explicitEverUsed: false };
  const make = (role, content) => ({ id: `m${++counter}`, role, content, createdAt: new Date(counter * 1000) });
  for (const content of priorAssistant) { history.push(make('user', 'tell me more about it please, go on')); history.push(make('assistant', content)); }
  const prisma = {
    character: { findUnique: async () => ({ ...character }), update: async ({ data }) => Object.assign(character, data), updateMany: async () => ({ count: 1 }) },
    user: { findUnique: async () => ({ membershipTier: 'plus', explicitMode: false }) },
    message: {
      findMany: async ({ skip = 0, take } = {}) => history.slice(skip, take === undefined ? undefined : skip + take).map(m => ({ ...m })),
      findFirst: async () => history.at(-1),
      create: async ({ data }) => { const m = make(data.role, data.content); history.push(m); return m; },
      update: async ({ where, data }) => Object.assign(history.find(m => m.id === where.id), data),
      upsert: async ({ where, create }) => { const m = make(create.role, create.content); m.id = where.id; history.push(m); return m; },
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
    onChunk(MESSY);
    return { text: MESSY, provider: 'test', finishReason: 'stop' };
  };
  const routerPath = require.resolve('../dist/routes/chat');
  delete require.cache[routerPath];
  const app = express();
  app.use(express.json());
  app.use('/chat', require(routerPath).default);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/chat/char`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: userMessage, engineId, sceneDirective }),
    });
    const body = await response.text();
    assert.equal(response.status, 200, body);
    const final = [...body.matchAll(/\u0000EVT:(.*?)\u0000/g)].map(m => JSON.parse(m[1])).find(e => e.type === 'reply_final');
    return { captured, saved: history.at(-1), final };
  } finally {
    server.close();
    providers.streamChatWithFallback = originalStream;
    for (const [id, old] of originals) { if (old) require.cache[id] = old; else delete require.cache[id]; }
    delete require.cache[routerPath];
  }
}

const tired = [
  '*She smirks.* Not bad at all. What do you want to do?',
  'Hm. *A smirk tugs at her mouth.* Try again. Would you like that?',
];

for (const engineId of ['strawberry', 'choco_hazelnut']) {
  test(`${engineId}: repetitive history + quick user beat -> director in prompt, relaxed floor, polished reply`, async () => {
    const { captured, saved, final } = await run({ engineId, priorAssistant: tired, userMessage: 'hey' });
    const system = captured.messages[0].content;
    assert.match(system, /TURN DIRECTOR/);
    assert.match(system, /"smirk"/);
    assert.match(system, /both ended on a question/);
    assert.match(system, /turn is brief/);
    // Ceiling unchanged; floor relaxed for the quick beat.
    const max = engineId === 'strawberry' ? 70 : 130;
    const min = engineId === 'strawberry' ? 50 : 105;
    assert.equal(captured.params.maxWords, max);
    assert.equal(captured.params.minWords, Math.round(min * 0.6));
    // Saved text and the reply_final event are both polished, and identical.
    for (const text of [saved.content, final.text]) {
      assert.doesNotMatch(text, /^Mira:/);
      assert.doesNotMatch(text, /What would you like to do next/);
      assert.match(text, /Come in before the rain starts\.$/);
    }
    assert.equal(saved.content, final.text);
  });

  test(`${engineId}: a weighty turn and a scene steer keep the full floor`, async () => {
    const long = Array.from({ length: 60 }, (_, i) => `w${i}`).join(' ');
    const weighty = await run({ engineId, priorAssistant: tired, userMessage: long });
    const min = engineId === 'strawberry' ? 50 : 105;
    assert.equal(weighty.captured.params.minWords, min);
    assert.match(weighty.captured.messages[0].content, /carries weight/);
    const steer = await run({ engineId, priorAssistant: tired, userMessage: 'hey', sceneDirective: 'a storm rolls in' });
    assert.equal(steer.captured.params.minWords, min);
    assert.doesNotMatch(steer.captured.messages[0].content, /turn is brief/);
  });
}

test('a healthy conversation adds no director block and no cost', async () => {
  const { captured } = await run({ engineId: 'choco_hazelnut', priorAssistant: ['The reading room smells of salt and old paper, and she likes it that way.'], userMessage: 'I think I will stay a while, if that is all right with you.' });
  assert.doesNotMatch(captured.messages[0].content, /TURN DIRECTOR/);
});
