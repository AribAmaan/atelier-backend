const test = require('node:test');
const assert = require('node:assert/strict');
const { splitRoleplayInput, formatRoleplayInput, buildRoleplayTurnGuard, ROLEPLAY_INPUT_RULES,
  ROLEPLAY_MEMORY_RULES } = require('../dist/lib/roleplayInput');
const { selectHazelnutContext } = require('../dist/lib/hazelnutContext');
const { buildSystemPrompt, summarizeConversation } = require('../dist/lib/providers');
const { ROLEPLAY_ENGINES } = require('../dist/lib/providers/engines');
const { replyProfile, classifyTurn, buildReplyGuidance, planReply } = require('../dist/lib/providers/replyPolicy');

for (const marker of ['*', '**']) {
  test(`${marker} separates speech, private context, and subsequent speech`, () => {
    assert.deepEqual(splitRoleplayInput(`Hi ${marker}I feel nervous but hide it${marker} How are you?`), [
      { kind: 'spoken', text: 'Hi ' },
      { kind: 'narration', text: 'I feel nervous but hide it' },
      { kind: 'spoken', text: ' How are you?' },
    ]);
  });
}

test('multiple narration spans retain their order and visible actions', () => {
  const input = 'Hello *I pass the map* Please read it **I secretly hope she finds the clue**';
  const payload = JSON.parse(formatRoleplayInput(input).slice('ROLEPLAY_INPUT '.length));
  assert.deepEqual(payload.map(s => s.kind), ['spoken', 'narration', 'spoken', 'narration']);
  assert.equal(payload[1].text, 'I pass the map');
  assert.equal(payload[1].delivery, 'unspoken_context');
  assert.equal(payload[3].character_knowledge, 'only_if_perceptible_in_scene');
});

test('quoted thought is retained as narration, never promoted to dialogue', () => {
  const parsed = splitRoleplayInput('Hey *I think "I missed you"*');
  assert.equal(parsed[1].kind, 'narration');
  assert.equal(parsed[1].text, 'I think "I missed you"');
  assert.doesNotMatch(buildRoleplayTurnGuard('Hey *I think "I missed you"*'), /I missed you/);
});

test('explicit speaking inside narration is preserved for contextual interpretation', () => {
  const parsed = splitRoleplayInput('*I say aloud, "The train is here."*');
  assert.equal(parsed[0].kind, 'narration');
  assert.match(formatRoleplayInput('*I say aloud, "The train is here."*'), /say aloud/);
  assert.match(buildRoleplayTurnGuard('*I say aloud, "The train is here."*'), /explicit act of speaking/);
});

test('unfinished narration remains unspoken across newlines', () => {
  assert.deepEqual(splitRoleplayInput('Hi **I wonder\nwhere she went'), [
    { kind: 'spoken', text: 'Hi ' }, { kind: 'narration', text: 'I wonder\nwhere she went' },
  ]);
});

test('plain speech, escaped asterisks and arithmetic retain original behavior', () => {
  for (const text of ['Hello there!', 'What is 2 * 3?', String.raw`A literal \*star\*`]) {
    assert.equal(formatRoleplayInput(text), text);
    assert.equal(buildRoleplayTurnGuard(text), '');
  }
});

test('guard anchors actual speech without repeating the private content', () => {
  const guard = buildRoleplayTurnGuard('Hello **I did not realize how anxious I was**');
  assert.match(guard, /"Hello"/);
  assert.doesNotMatch(guard, /anxious/);
  assert.match(guard, /Do not answer private thoughts\/feelings or invent cues/);
});

test('narration-only input does not fabricate speech', () => {
  const guard = buildRoleplayTurnGuard('*Rain drums against the window.*');
  assert.match(guard, /No outside-asterisk dialogue was supplied/);
});

test('speech anchor is bounded, escaped as JSON, and full original text is retained', () => {
  const text = 'hello "friend"\n' + 'x'.repeat(4000) + ' *I think quietly*';
  const guard = buildRoleplayTurnGuard(text);
  assert.ok(guard.length < 1400);
  assert.match(guard, /\\"friend\\"\\n/);
  const payload = JSON.parse(formatRoleplayInput(text).slice('ROLEPLAY_INPUT '.length));
  assert.equal(payload[0].text.length, text.indexOf('*'));
});

const recent = [
  { id: 'u1', role: 'user', content: 'Hello' },
  { id: 'a1', role: 'assistant', content: 'Hello there.' },
  { id: 'u2', role: 'user', content: 'Where next?' },
];
test('Hazelnut recalls a complete private thought without losing its qualifier', () => {
  const narration = 'I secretly imagine another ending. The missing map is in Lisbon.';
  const result = selectHazelnutContext({ history: recent, query: 'Lisbon map', systemTokens: 100,
    targetTokens: 2000, recalled: [{ id: 'old', role: 'user', content: `*${narration}*` }] });
  const data = JSON.parse(result.memory.slice(result.memory.indexOf('\n[') + 1));
  assert.equal(data.length, 1);
  assert.equal(data[0].kind, 'narration');
  assert.equal(data[0].quote, narration);
  assert.deepEqual(result.selectedIds, ['u1', 'a1', 'u2']);
});

test('oversized narration is skipped whole instead of recalling an unqualified fragment', () => {
  const result = selectHazelnutContext({ history: recent, query: 'Lisbon map', systemTokens: 100,
    targetTokens: 700, recalled: [{ id: 'old', role: 'user',
      content: `*I am imagining this. ${'A private imagined detail. '.repeat(300)} The map is in Lisbon.*` }] });
  assert.equal(result.memory, '');
});

const character = { name: 'Alex', personality: 'A curious archivist', backstory: 'Works in a library.',
  examples: JSON.stringify([{ user: 'Hi *I am secretly worried*', character: 'Hello. Come in.' }]) };
for (const engine of Object.values(ROLEPLAY_ENGINES)) {
  test(`${engine.id} includes knowledge rules and labels authored example narration`, () => {
    const prompt = buildSystemPrompt(character, { explicitMode: false, engine });
    assert.ok(prompt.includes(ROLEPLAY_INPUT_RULES));
    assert.ok(prompt.includes('ROLEPLAY_INPUT'));
    assert.ok(prompt.includes('unspoken_context'));
  });
}

test('Hazelnut standard-context mode also carries the narration rules', () => {
  const previous = process.env.HAZELNUT_COMPACT_CONTEXT;
  try {
    process.env.HAZELNUT_COMPACT_CONTEXT = 'false';
    const prompt = buildSystemPrompt(character, { explicitMode: false, engine: ROLEPLAY_ENGINES.hazelnut });
    assert.ok(prompt.includes(ROLEPLAY_INPUT_RULES));
    assert.ok(prompt.includes('ROLEPLAY_INPUT'));
  } finally {
    if (previous === undefined) delete process.env.HAZELNUT_COMPACT_CONTEXT;
    else process.env.HAZELNUT_COMPACT_CONTEXT = previous;
  }
});

test('reply length has no word bounds: only a safety token ceiling per engine', () => {
  assert.deepEqual(Object.values(ROLEPLAY_ENGINES).map(e => replyProfile(e.intelligence).tokens), [400, 600]);
  for (const e of Object.values(ROLEPLAY_ENGINES)) {
    const p = replyProfile(e.intelligence);
    for (const key of ['minWords', 'maxWords', 'ordinaryWords']) assert.equal(p[key], undefined);
    const plan = planReply(e.intelligence, 'hi');
    for (const key of ['minWords', 'maxWords', 'targetWords']) assert.equal(plan[key], undefined);
    assert.equal(plan.maxTokens, p.tokens);
  }
});

test('turn weight follows the user message, not the engine', () => {
  assert.equal(classifyTurn('hi'), 'light');
  assert.equal(classifyTurn('yes *nods*'), 'light');
  assert.equal(classifyTurn('Do you want to get some coffee with me later today?'), 'normal');
  assert.equal(classifyTurn('hi', 'move the scene to the beach'), 'normal');
  assert.equal(classifyTurn('word '.repeat(60)), 'heavy');
  assert.equal(classifyTurn('one\n\ntwo\n\nthree'), 'heavy');
  for (const e of Object.values(ROLEPLAY_ENGINES)) {
    assert.equal(planReply(e.intelligence, 'hi').weight, 'light');
    assert.equal(planReply(e.intelligence, 'word '.repeat(60)).weight, 'heavy');
  }
});

test('reply guidance is context-based: no word counts, no quota, no padding', () => {
  for (const e of Object.values(ROLEPLAY_ENGINES)) {
    for (const weight of ['light', 'normal', 'heavy']) {
      const text = buildReplyGuidance(e.intelligence, weight);
      assert.match(text, /REPLY LENGTH/);
      assert.match(text, /never to a quota/);
      assert.match(text, /Stop as soon as the beat is complete/);
      assert.match(text, /finish every sentence/);
      assert.doesNotMatch(text, /\d+\s*(?:–|-|to)\s*\d+ words|hard ceiling|TIER-LOCKED|envelope/i);
    }
  }
  assert.match(buildReplyGuidance(4, 'light'), /light/);
  assert.match(buildReplyGuidance(10, 'heavy'), /long or sets a scene/);
});

test('engine voice notes and prompts no longer force depth or length on small turns', () => {
  for (const e of Object.values(ROLEPLAY_ENGINES)) {
    assert.doesNotMatch(e.voiceNotes, /even when the user (?:only says|sends a greeting)|fixed response envelope|full normal response depth/i);
  }
  const prompt = buildSystemPrompt({ name: 'Abigail', tagline: '', personality: 'warm', backstory: '', roleplayNotes: '', examples: '[]', memorySummary: '' }, { engine: ROLEPLAY_ENGINES.vanilla, voiceNotes: ROLEPLAY_ENGINES.vanilla.voiceNotes });
  assert.doesNotMatch(prompt, /fixed reply envelope|tier-locked|Hazelnut expresses|full normal tier depth/i);
  assert.match(prompt, /REPLY LENGTH/);
});

test('memory provider request preserves privacy labels and contains corrective memory rules', async () => {
  const previousKey = process.env.NVIDIA_API_KEY;
  const originalFetch = global.fetch;
  const captured = [];
  try {
    process.env.NVIDIA_API_KEY = 'test-placeholder-no-real-provider-request';
    global.fetch = async (_url, init) => {
      captured.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ choices: [{ message: {
        content: 'Private narrator context: the user feels nervous but has not disclosed it.'
      }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 15, total_tokens: 35 } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const summary = await summarizeConversation(character, 'An old unverified assumption.', [
      { role: 'user', content: 'Hello **I feel nervous but hide it**' },
    ], false, 10);
    assert.equal(captured.length, 1);
    assert.ok(captured[0].messages[0].content.includes(ROLEPLAY_MEMORY_RULES));
    assert.match(captured[0].messages[1].content, /unspoken_context/);
    assert.match(summary, /^Private narrator context:/);
  } finally {
    global.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.NVIDIA_API_KEY;
    else process.env.NVIDIA_API_KEY = previousKey;
  }
});

test('only two engines exist and retired ids resolve to the paid engine', () => {
  const { getEngineConfig, resolveEngineForTier } = require('../dist/lib/providers/engines');
  assert.deepEqual(Object.keys(ROLEPLAY_ENGINES), ['vanilla', 'hazelnut']);
  assert.equal(ROLEPLAY_ENGINES.vanilla.minTier, 'free');
  assert.equal(ROLEPLAY_ENGINES.hazelnut.minTier, 'plus');
  assert.equal(getEngineConfig('strawberry').id, 'hazelnut');
  assert.equal(getEngineConfig('chocolate').id, 'hazelnut');
  assert.equal(getEngineConfig('nonsense'), null);
  const previous = process.env.ENFORCE_ENGINE_TIERS;
  process.env.ENFORCE_ENGINE_TIERS = 'true';
  try {
    const free = resolveEngineForTier('hazelnut', 'free');
    assert.equal(free.engine.id, 'vanilla');
    assert.equal(free.downgradedFrom, 'hazelnut');
    assert.equal(free.requiredTier, 'plus');
    // Old ultra/supreme rows count as the paid plan; unknown values count as free.
    for (const tier of ['plus', 'ultra', 'supreme']) assert.equal(resolveEngineForTier('hazelnut', tier).engine.id, 'hazelnut');
    for (const tier of ['free', undefined, null, 'junk', 42]) assert.equal(resolveEngineForTier('hazelnut', tier).engine.id, 'vanilla');
    assert.equal(resolveEngineForTier('vanilla', 'free').downgradedFrom, null);
  } finally {
    if (previous === undefined) delete process.env.ENFORCE_ENGINE_TIERS; else process.env.ENFORCE_ENGINE_TIERS = previous;
  }
});
