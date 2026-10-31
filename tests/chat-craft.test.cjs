// End-to-end on the real HTTP route with in-memory persistence and a captured
// provider boundary: the turn director reaches the prompt, a quick beat relaxes
// the word floor, and the saved / final reply is polished. No DB or paid API.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');

const MESSY = 'Mira: *She smirks, tucking a strand of hair behind her ear.* Come in before the rain starts. What would you like to do next?';

async function run({ engineId, priorAssistant, userMessage, sceneDirective, env = {}, regenerate }) {
  const savedEnv = {};
  const logs = [];
  const realLog = console.log;
  console.log = (...a) => { logs.push(a.join(' ')); };
  for (const k of Object.keys(env)) { savedEnv[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
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
      body: JSON.stringify({ message: userMessage, engineId, sceneDirective, regenerate }),
    });
    const body = await response.text();
    assert.equal(response.status, 200, body);
    const final = [...body.matchAll(/\u0000EVT:(.*?)\u0000/g)].map(m => JSON.parse(m[1])).find(e => e.type === 'reply_final');
    return { captured, saved: history.at(-1), final, logs };
  } finally {
    console.log = realLog;
    server.close();
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
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
  const max = engineId === 'strawberry' ? 70 : 130;
  const min = engineId === 'strawberry' ? 50 : 105;

  test(`${engineId}: repetitive history + brief user turn, DEFAULT arms -> director in prompt, full floor, polished reply`, async () => {
    const { captured, saved, final } = await run({ engineId, priorAssistant: tired, userMessage: 'hey' });
    const system = captured.messages[0].content;
    assert.match(system, /TURN DIRECTOR/);
    assert.match(system, /"smirk"/);
    assert.match(system, /both ended on a question/);
    assert.doesNotMatch(system, /turn is brief/, 'default arm never nudges a shorter reply');
    assert.equal(captured.params.maxWords, max);
    assert.equal(captured.params.minWords, min, 'full tier floor by default');
    for (const text of [saved.content, final.text]) {
      assert.doesNotMatch(text, /^Mira:/);
      assert.doesNotMatch(text, /What would you like to do next/);
      assert.match(text, /Come in before the rain starts\.$/);
    }
    assert.equal(saved.content, final.text);
  });

  test(`${engineId}: adaptive-rhythm arm (ADAPTIVE_REPLY_RHYTHM=on) relaxes the floor on a brief turn, ceiling unchanged`, async () => {
    const { captured } = await run({ engineId, priorAssistant: tired, userMessage: 'hey', env: { ADAPTIVE_REPLY_RHYTHM: 'on' } });
    assert.match(captured.messages[0].content, /turn is brief/);
    assert.equal(captured.params.maxWords, max);
    assert.equal(captured.params.minWords, Math.round(min * 0.6));
  });

  test(`${engineId}: director arm off (ROLEPLAY_DIRECTOR=off) adds no steers at all`, async () => {
    const { captured } = await run({ engineId, priorAssistant: tired, userMessage: 'hey', env: { ROLEPLAY_DIRECTOR: 'off' } });
    assert.doesNotMatch(captured.messages[0].content, /TURN DIRECTOR/);
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

// ------------------------------------------------------ recency persona anchor
const anchorAt = messages => messages.findIndex(m => m.role === 'system' && m.content.startsWith('CHARACTER REMINDER'));

for (const engineId of ['strawberry', 'choco_hazelnut']) {
  test(`${engineId}: persona anchor sits right before the final user turn (default arm)`, async () => {
    const { captured } = await run({ engineId, priorAssistant: tired, userMessage: 'I think I will stay a while, if that is all right with you.' });
    const { messages } = captured;
    const i = anchorAt(messages);
    assert.ok(i > 0, 'anchor present and not at index 0');
    assert.equal(i, messages.length - 2, 'immediately before the final message');
    assert.equal(messages.at(-1).role, 'user', 'final message is still the user turn');
    assert.match(messages[i].content, /"name":"Mira"/);
    assert.match(messages[i].content, /Reserved archivist/);
    assert.equal(messages.filter(m => m.content.startsWith('CHARACTER REMINDER')).length, 1);
    assert.doesNotMatch(messages[0].content, /Character reminder \(apply silently\)/, 'no second copy in the top system message');
  });
}

test('anchor survives the non-compact context-budget rebuild on a long history', async () => {
  const many = Array.from({ length: 40 }, (_, i) => `Reply number ${i}: the archive hums and she keeps working.`);
  const { captured } = await run({ engineId: 'choco_hazelnut', priorAssistant: many, userMessage: 'Okay, what now?', env: { HAZELNUT_COMPACT_CONTEXT: 'false' } });
  assert.equal(anchorAt(captured.messages), captured.messages.length - 2);
});

test('Continue / regenerate keep the character as the final speaker with the anchor one message earlier', async () => {
  const { captured } = await run({ engineId: 'choco_hazelnut', priorAssistant: tired, userMessage: undefined, sceneDirective: 'Continue' });
  const { messages } = captured;
  assert.equal(messages.at(-1).role, 'assistant');
  assert.equal(anchorAt(messages), messages.length - 2);
});

test('control arm (ROLEPLAY_PERSONA_ANCHOR=off): compact path has no anchor; standard path keeps the old top-of-prompt reminder', async () => {
  const compact = await run({ engineId: 'choco_hazelnut', priorAssistant: tired, userMessage: 'hello again, how are you doing tonight', env: { ROLEPLAY_PERSONA_ANCHOR: 'off' } });
  assert.equal(anchorAt(compact.captured.messages), -1);
  assert.doesNotMatch(compact.captured.messages[0].content, /Character reminder \(apply silently\)/);
  const standard = await run({ engineId: 'choco_hazelnut', priorAssistant: tired, userMessage: 'hello again, how are you doing tonight', env: { ROLEPLAY_PERSONA_ANCHOR: 'off', HAZELNUT_COMPACT_CONTEXT: 'false' } });
  assert.equal(anchorAt(standard.captured.messages), -1);
  assert.match(standard.captured.messages[0].content, /Character reminder \(apply silently\)/);
});

test('ROLEPLAY_ANCHOR_PLACEMENT=system appends to the first system message instead (strict-template fallback)', async () => {
  const { captured } = await run({ engineId: 'choco_hazelnut', priorAssistant: tired, userMessage: 'hello again, how are you doing tonight', env: { ROLEPLAY_ANCHOR_PLACEMENT: 'system' } });
  assert.equal(anchorAt(captured.messages), -1, 'no standalone message');
  assert.match(captured.messages[0].content, /CHARACTER REMINDER/);
  assert.equal(captured.messages.filter(m => m.role === 'system').length, 1);
});

// ------------------------------------------------------------------ telemetry
const telemetryLines = logs => logs.filter(l => l.startsWith('[roleplay-telemetry] '));

test('exactly one content-free telemetry line per reply, with arms, steers and turn', async () => {
  const { logs, final } = await run({ engineId: 'choco_hazelnut', priorAssistant: tired, userMessage: 'hey', env: { ROLEPLAY_TELEMETRY: undefined } });
  const lines = telemetryLines(logs);
  assert.equal(lines.length, 1);
  const t = JSON.parse(lines[0].slice('[roleplay-telemetry] '.length));
  assert.equal(t.v, 1);
  assert.deepEqual(t.arms, { adaptiveRhythm: false, director: true, actionCap: false, personaAnchor: true });
  assert.ok(t.steers.includes('question_run') && t.steers.includes('retire'));
  assert.equal(t.engine, 'choco_hazelnut');
  assert.equal(t.tier, 10);
  assert.ok(t.turn >= 4);
  assert.equal(t.words, final.text.split(/\s+/).length);
  assert.equal(t.endsQuestion, false);
  assert.equal(t.assistantisms, 0);
  // Privacy: nothing from the reply, the character, or the raw ids appears anywhere in the line.
  for (const leaked of ['Come in', 'rain', 'smirk', 'Mira', 'Archivist', 'owner', 'char']) {
    assert.ok(!lines[0].includes(leaked), `telemetry line leaks ${JSON.stringify(leaked)}`);
  }
  assert.match(t.uh, /^[0-9a-f]{12}$/);
});

test('telemetry records the user\'s experiment arms and is silent when disabled or on a regeneration', async () => {
  const split = await run({ engineId: 'choco_hazelnut', priorAssistant: tired, userMessage: 'hey', env: { ADAPTIVE_REPLY_RHYTHM: 'on', ROLEPLAY_ACTION_CAP: 'on', ROLEPLAY_DIRECTOR: 'off' } });
  const t = JSON.parse(telemetryLines(split.logs)[0].slice('[roleplay-telemetry] '.length));
  assert.deepEqual(t.arms, { adaptiveRhythm: true, director: false, actionCap: true, personaAnchor: true });
  assert.deepEqual(t.steers, [], 'director off -> no steers');
  assert.equal(t.beat, 'rapid');
  const off = await run({ engineId: 'choco_hazelnut', priorAssistant: tired, userMessage: 'hey', env: { ROLEPLAY_TELEMETRY: 'off' } });
  assert.equal(telemetryLines(off.logs).length, 0);
  const regen = await run({ engineId: 'choco_hazelnut', priorAssistant: tired, userMessage: undefined, regenerate: true });
  assert.equal(telemetryLines(regen.logs).length, 0, 'a regeneration replaces a reply and is not counted again');
});
