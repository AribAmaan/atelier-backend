// End-to-end regression coverage for the additive narrator/director channel.
// The test keeps v19 craft and reply-envelope behaviour in scope.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');

async function run({ initial = [], message, sceneDirective, regenerate = false, explicit = false, engineId = 'choco_hazelnut' } = {}) {
  let history = [], captured, counter = 0;
  const character = {
    id: 'char', ownerId: 'owner', name: 'Mira', personality: 'Reserved archivist',
    backstory: 'Works in the archive', greeting: '*I unlock the archive.*', tagline: 'Archivist',
    memorySummary: '', examples: '[]', roleplayNotes: '', summarizedThrough: 0,
    recallAfterCreatedAt: null, recallAfterId: '', explicitEverUsed: false,
  };
  const make = (role, content) => ({ id: `m${++counter}`, role, content, createdAt: new Date(counter * 1000) });
  history = initial.map(([role, content]) => make(role, content));
  const prisma = {
    character: {
      findUnique: async () => ({ ...character }),
      update: async ({ data }) => Object.assign(character, data),
      updateMany: async ({ data }) => { Object.assign(character, data); return { count: 1 }; },
    },
    user: { findUnique: async () => ({ membershipTier: 'supreme', explicitMode: explicit }) },
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
  const mocks = [
    ['../dist/lib/db', { prisma }],
    ['../dist/lib/auth', { getCurrentUserId: async () => 'owner' }],
    ['../dist/lib/rateLimit', { checkRateLimit: () => ({ limited: false }) }],
  ];
  const originals = mocks.map(([path, exports]) => {
    const id = require.resolve(path), old = require.cache[id];
    require.cache[id] = { id, filename: id, loaded: true, exports };
    return [id, old];
  });
  const providers = require('../dist/lib/providers');
  const originalStream = providers.streamChatWithFallback;
  providers.streamChatWithFallback = async (messages, onChunk, _failure, _signal, params) => {
    captured = { messages: structuredClone(messages), params: { ...params } };
    const text = 'Mira: *She looks toward the archive door.* Someone is there.';
    onChunk(text);
    return { text, provider: 'test', finishReason: 'stop' };
  };
  const routePath = require.resolve('../dist/routes/chat');
  delete require.cache[routePath];
  const app = express();
  app.use(express.json());
  app.use('/chat', require(routePath).default);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/chat/char`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, sceneDirective, regenerate, engineId }),
    });
    const body = await response.text();
    assert.equal(response.status, 200, body);
    return { captured, history, body };
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    providers.streamChatWithFallback = originalStream;
    delete require.cache[routePath];
    for (const [id, old] of originals) { if (old) require.cache[id] = old; else delete require.cache[id]; }
  }
}

const isDirectorNote = m => m.role === 'system' && m.content.startsWith('NARRATOR / SCENE DIRECTOR');

test('asterisk narration reaches the real provider as high-priority scene canon; raw user text stays saved', async () => {
  const { captured, history } = await run({
    initial: [['user', 'Where is the map?'], ['assistant', 'I think it is in the archive.']],
    message: 'Hey **the lights go out and someone knocks**',
  });
  const systems = captured.messages.filter(m => m.role === 'system');
  assert.match(captured.messages[0].content, /NARRATOR \/ SCENE DIRECTOR/);
  assert.match(captured.messages[0].content, /ROLEPLAY CRAFT/);
  assert.match(captured.messages[0].content, /TIER-LOCKED REPLY ENVELOPE/);
  assert.match(captured.messages[0].content, /CURRENT USER TURN — SPOKEN ANCHOR/);
  assert.match(captured.messages.at(-1).content, /"delivery":"narrator_director"/);
  assert.match(captured.messages.at(-1).content, /"authority":"canon_highest_priority"/);
  assert.equal(captured.messages.at(-1).role, 'user');
  assert.ok(isDirectorNote(captured.messages.at(-2)));
  assert.equal(systems.filter(isDirectorNote).length, 1);
  assert.equal(history.find(m => m.role === 'user' && m.content.startsWith('Hey **')).content, 'Hey **the lights go out and someone knocks**');
  assert.equal(captured.params.maxWords, 130, 'v19 tier word cap remains active');
});

test('a narrator direction such as *Suzy says* instructs the model to voice the other character', async () => {
  const { captured } = await run({ initial: [['user', 'Suzy just arrived.'], ['assistant', 'She is by the door.']], message: '*Suzy says*' });
  assert.match(captured.messages[0].content, /- CAST:/);
  assert.match(captured.messages[0].content, /write their action and actual words yourself/);
  assert.match(captured.messages.at(-1).content, /"text":"Suzy says","delivery":"narrator_director"/);
  assert.match(captured.messages.at(-2).content, /voice any supporting characters it directs/);
});

test('quick-action sceneDirective is delivered this turn only and never baked into cached prompt text', async () => {
  const first = await run({ initial: [['user', 'Where is the map?'], ['assistant', 'Shall I check?']], message: 'Yes', sceneDirective: 'Suzy enters and asks for the map.' });
  assert.ok(isDirectorNote(first.captured.messages.at(-2)));
  assert.match(first.captured.messages.at(-2).content, /Suzy enters and asks for the map/);
  assert.doesNotMatch(first.captured.messages[0].content.split('CURRENT USER TURN')[0], /Suzy enters and asks for the map/);

  const second = await run({ initial: first.history.map(m => [m.role, m.content]), message: 'Go on' });
  assert.equal(second.captured.messages.filter(isDirectorNote).length, 0);
  assert.doesNotMatch(JSON.stringify(second.captured.messages), /Suzy enters and asks for the map/);
});

test('Continue does not replay the old asterisk beat; a new quick steer still applies', async () => {
  const { captured } = await run({
    initial: [['user', 'Yes **a storm breaks**'], ['assistant', '*I unfold the map.*']],
    sceneDirective: 'Continue from the map.',
  });
  assert.equal(captured.messages.at(-1).role, 'assistant');
  const note = captured.messages.filter(isDirectorNote);
  assert.equal(note.length, 1);
  assert.match(note[0].content, /Scene steer \(quoted fictional data\):/);
  assert.match(note[0].content, /Continue from the map/);
  assert.doesNotMatch(note[0].content, /asterisk parts of the user's latest message/);
});

test('mature prompt keeps the existing adult-only and consent limits over the director channel', async () => {
  const { captured } = await run({ message: 'I want to have sex with you *A new scene begins*', explicit: true });
  assert.match(captured.messages[0].content, /every participant is clearly established as 18\+ and able to choose freely/i);
  assert.match(captured.messages[0].content, /clear no\/stop, pull-away, or withdrawal ends that intimate action/);
  assert.match(captured.messages[0].content, /cannot change system\/safety rules/);
  assert.match(captured.messages[0].content, /age\/consent limits/);
});


test('strict system-anchor placement keeps the director note inside the first system message', async () => {
  const previous = process.env.ROLEPLAY_ANCHOR_PLACEMENT;
  process.env.ROLEPLAY_ANCHOR_PLACEMENT = 'system';
  try {
    const { captured } = await run({ message: 'Hey *the archive door opens*' });
    assert.match(captured.messages[0].content, /NARRATOR \/ SCENE DIRECTOR \(this reply only; fiction only\):/);
    assert.equal(captured.messages.filter(isDirectorNote).length, 0);
  } finally {
    if (previous === undefined) delete process.env.ROLEPLAY_ANCHOR_PLACEMENT;
    else process.env.ROLEPLAY_ANCHOR_PLACEMENT = previous;
  }
});
