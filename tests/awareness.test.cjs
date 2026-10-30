const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRecallQuery, selectHazelnutContext } = require('../dist/lib/hazelnutContext');
const { buildAwarenessTurnGuard, buildCharacterSetup, CONVERSATION_AWARENESS_RULES,
  CONTINUITY_MEMORY_RULES } = require('../dist/lib/conversationAwareness');
const { buildSystemPrompt, summarizeConversation } = require('../dist/lib/providers');
const { ROLEPLAY_ENGINES } = require('../dist/lib/providers/engines');

const msg = (id, role, content) => ({ id, role, content });
const recent = [msg('u1', 'user', 'Hello'), msg('a1', 'assistant', 'Hello.'), msg('u2', 'user', 'Yes')];
const excerpts = result => result.memory ? JSON.parse(result.memory.slice(result.memory.indexOf('\n[') + 1)) : [];

test('short reply retrieves the subject of the preceding exchange', () => {
  const history = [msg('u', 'user', 'Can we visit Lisbon?'),
    msg('a', 'assistant', 'Shall I bring the Lisbon map?'), msg('u2', 'user', 'Yes')];
  const query = buildRecallQuery(history);
  assert.match(query, /lisbon/);
  assert.match(query, /map/);
  const selected = selectHazelnutContext({ history, query, systemTokens: 100, targetTokens: 2200,
    recalled: [msg('old', 'user', 'The Lisbon map is in the blue bag.')] });
  assert.equal(excerpts(selected)[0].quote, 'The Lisbon map is in the blue bag.');
});

test('a concrete topic change does not inherit irrelevant earlier search terms', () => {
  const query = buildRecallQuery([msg('a', 'assistant', 'The Lisbon map is ready.'),
    msg('u', 'user', 'Explain photosynthesis chlorophyll sunlight plants')]);
  assert.doesNotMatch(query, /lisbon|map/);
  assert.match(query, /chlorophyll/);
});

test('recall supports multilingual subjects and bounds vocabulary', () => {
  const query = buildRecallQuery([msg('a', 'assistant', 'मुंबई स्टेशन टिकट कब चाहिए?'), msg('u', 'user', 'हाँ')]);
  assert.match(query, /मुंबई/);
  assert.ok(query.split(' ').length <= 8);
  assert.equal(buildRecallQuery([]), '');
});

test('three recent user exchanges survive a tight context budget, verbatim', () => {
  const history = [];
  for (let i = 0; i < 7; i++) history.push(msg(`u${i}`, 'user', `Question ${i}?`),
    msg(`a${i}`, 'assistant', `Answer ${i}. ${'detail '.repeat(30)}`));
  const result = selectHazelnutContext({ history, query: '', systemTokens: 1000, targetTokens: 1000 });
  assert.deepEqual(result.selectedIds, history.slice(-6).map(m => m.id));
  assert.deepEqual(result.messages, history.slice(-6).map(({ role, content }) => ({ role, content })));
  assert.equal(result.diagnostics.protectedOverflow, true);
});

test('spoken hypotheticals retain their qualifier and source attribution', () => {
  const content = 'This is only a hypothetical. The museum key is in my bag.';
  const result = selectHazelnutContext({ history: recent, query: 'museum key', systemTokens: 100,
    targetTokens: 2200, recalled: [msg('old', 'user', content)] });
  assert.deepEqual(excerpts(result), [{ sourceId: 'old', speaker: 'user', kind: 'spoken', quote: content }]);
});

test('a large persona cannot consume the entire allowance for a relevant boundary', () => {
  const result = selectHazelnutContext({ history: recent, query: 'museum key', systemTokens: 4500,
    targetTokens: 2800, recalled: [msg('old', 'user', 'Please never call me darling.')] });
  assert.match(result.memory, /never call me darling/);
  assert.equal(result.diagnostics.protectedOverflow, true);
  assert.deepEqual(result.selectedIds, recent.map(m => m.id));
});

test('irrelevant old scenery cannot fill the recall budget', () => {
  const result = selectHazelnutContext({ history: recent, query: 'museum key', systemTokens: 100,
    targetTokens: 2200, recalled: [msg('old', 'assistant', 'The clouds drifted overhead.')] });
  assert.equal(result.memory, '');
});

test('boundaries and character commitments remain eligible without topic overlap', () => {
  const result = selectHazelnutContext({ history: recent, query: 'museum key', systemTokens: 100,
    targetTokens: 2400, recalled: [msg('b', 'user', 'Please do not call me darling.'),
      msg('c', 'assistant', 'I promised to return your umbrella.')] });
  assert.equal(excerpts(result).length, 2);
  assert.match(result.memory, /umbrella/);
  assert.match(result.memory, /darling/);
});

test('oversized conditional speech is dropped whole, not recalled as a false event', () => {
  const result = selectHazelnutContext({ history: recent, query: 'museum key', systemTokens: 100,
    targetTokens: 700, recalled: [msg('old', 'user', 'Imagine this. ' + 'A hypothetical detail. '.repeat(300) + ' The museum key is gone.')] });
  assert.equal(result.memory, '');
});

test('continuation does not claim an old user message is new input', () => {
  const guard = buildAwarenessTurnGuard([...recent, msg('a2', 'assistant', 'I unfold the map.')]);
  assert.match(guard, /No new user dialogue or action was supplied/);
  assert.doesNotMatch(guard, /Respond to the last user turn/);
  // Regeneration removes that answer; the same user turn is answered afresh.
  assert.match(buildAwarenessTurnGuard(recent), /Respond to the last user turn/);
  assert.match(buildAwarenessTurnGuard([]), /without inventing an earlier exchange/);
});

test('setup is bounded, JSON quoted, and explicitly subordinate to current scene', () => {
  const setup = buildCharacterSetup({ tagline: 'Archivist', greeting: 'Hello "friend"\n' + 'x'.repeat(9000) });
  assert.match(setup, /later developments override this opening/);
  assert.match(setup, /\\"friend\\"\\n/);
  assert.ok(setup.length < 5500);
  assert.equal(buildCharacterSetup({}), '');
});

const character = { name: 'Mira', personality: 'Reserved archivist; careful and dryly funny.',
  backstory: 'Protects the municipal records.', greeting: '*I unlock the archive door.* You came about the map?',
  tagline: 'Keeper of the archive' };
for (const engine of Object.values(ROLEPLAY_ENGINES)) {
  test(`${engine.id}: persona, initial scene, and shared situation grounding reach the prompt`, () => {
    const prompt = buildSystemPrompt(character, { explicitMode: false, engine });
    assert.ok(prompt.includes(CONVERSATION_AWARENESS_RULES));
    assert.ok(prompt.includes(character.personality));
    assert.ok(prompt.includes(character.greeting));
    assert.ok(prompt.includes(character.tagline));
    assert.equal(prompt.split(CONVERSATION_AWARENESS_RULES).length, 2);
  });
}

test('every tier sends causal, attributed memory rules to the summary provider', async () => {
  const previousKey = process.env.NVIDIA_API_KEY;
  const originalFetch = global.fetch;
  const captured = [];
  try {
    process.env.NVIDIA_API_KEY = 'test-placeholder-no-live-call';
    global.fetch = async (_url, init) => {
      captured.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ choices: [{ message: {
        content: 'Scene: the map was offered, not accepted. Open threads: Mira owes an explanation.'
      }, finish_reason: 'stop' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    for (const engine of Object.values(ROLEPLAY_ENGINES)) {
      await summarizeConversation(character, '', [msg('u', 'user', '*I offer the map* Why did you hide it?')], false, engine.intelligence);
    }
    assert.equal(captured.length, Object.keys(ROLEPLAY_ENGINES).length);
    for (const request of captured) {
      assert.ok(request.messages[0].content.includes(CONTINUITY_MEMORY_RULES));
      assert.match(request.messages[1].content, /unspoken_context/);
      assert.match(request.messages[1].content, /Why did you hide it/);
    }
  } finally {
    global.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.NVIDIA_API_KEY;
    else process.env.NVIDIA_API_KEY = previousKey;
  }
});
