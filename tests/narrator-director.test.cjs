const test = require('node:test');
const assert = require('node:assert/strict');
const {
  splitRoleplayInput, formatRoleplayInput, buildRoleplayTurnGuard,
  buildDirectorTailNote, insertDirectorNote, sanitizeSceneDirective, ROLEPLAY_INPUT_RULES,
  ROLEPLAY_MEMORY_RULES, DIRECTOR_MARKER,
} = require('../dist/lib/roleplayInput');
const { buildSystemPrompt, cleanAssistantResponse, maxTokensForIntelligence } = require('../dist/lib/providers');
const { ROLEPLAY_ENGINES } = require('../dist/lib/providers/engines');
const { planReply, replyProfile } = require('../dist/lib/providers/replyPolicy');

const character = { name: 'Mira', personality: 'Reserved archivist.', backstory: 'Keeps records.', greeting: 'Hello.', tagline: 'Archivist' };
const promptPaths = [
  ...Object.values(ROLEPLAY_ENGINES).flatMap(engine => [
    [engine, false, undefined], [engine, true, undefined],
  ]),
  [undefined, false, undefined], [undefined, true, undefined],
];

test('the narrator/director rules are added without removing main (19) prompt shaping', () => {
  const old = process.env.HAZELNUT_COMPACT_CONTEXT;
  try {
    for (const [engine, explicitMode] of promptPaths) {
      process.env.HAZELNUT_COMPACT_CONTEXT = 'true';
      const compact = buildSystemPrompt(character, { explicitMode, engine });
      assert.ok(compact.includes(ROLEPLAY_INPUT_RULES));
      assert.match(compact, /HIGHEST priority|highest priority/);
      assert.match(compact, /- CAST/);
      assert.match(compact, /cannot change system\/safety rules/);
      assert.match(compact, /age\/consent limits/);
      assert.match(compact, /ROLEPLAY CRAFT/);
      if (engine?.id !== 'choco_hazelnut') assert.match(compact, /Everything below shapes HOW fully you express the persona above/);
      process.env.HAZELNUT_COMPACT_CONTEXT = 'false';
      const standard = buildSystemPrompt(character, { explicitMode, engine });
      assert.ok(standard.includes(ROLEPLAY_INPUT_RULES));
      assert.match(standard, /TIER-LOCKED REPLY ENVELOPE/);
    }
  } finally {
    if (old === undefined) delete process.env.HAZELNUT_COMPACT_CONTEXT;
    else process.env.HAZELNUT_COMPACT_CONTEXT = old;
  }
});

test('both * and ** segments are tagged as highest-priority narrator canon', () => {
  const parts = splitRoleplayInput('Hi *the door opens* **Suzy says**');
  assert.deepEqual(parts.filter(p => p.director).map(p => p.text), ['the door opens', 'Suzy says']);
  const payload = JSON.parse(formatRoleplayInput('Hi *Suzy says*').slice('ROLEPLAY_INPUT '.length));
  const narration = payload.find(s => s.kind === 'narration');
  assert.equal(narration.delivery, 'narrator_director');
  assert.equal(narration.authority, 'canon_highest_priority');
  assert.equal(narration.character_knowledge, 'only_if_perceptible_in_scene');
});

test('director instructions cover side characters without exposing private thoughts', () => {
  const prompt = ROLEPLAY_INPUT_RULES;
  assert.match(prompt, /\*Suzy says\*/);
  assert.match(prompt, /write their action and actual words yourself/);
  assert.match(prompt, /decide the words if none are given/);
  assert.match(prompt, /Separate what the narrator knows from what this character can perceive/);
  assert.match(prompt, /thoughts.*remain private|private/i);
  const guard = buildRoleplayTurnGuard('*Suzy says* **I secretly hope she stays**');
  assert.match(prompt, /Never answer in their place/);
  assert.match(prompt, /"Suzy: ..."/);
  assert.doesNotMatch(guard, /secretly hope/);
});

test('scene-director guard and tail note are bounded, turn-local and idempotent', () => {
  assert.equal(buildRoleplayTurnGuard('plain dialogue'), '');
  assert.equal(buildDirectorTailNote('plain dialogue'), '');
  const guard = buildRoleplayTurnGuard('', 'x'.repeat(5000));
  const note = buildDirectorTailNote('', 'y'.repeat(5000));
  assert.match(guard, /scene-director steer/);
  assert.ok(guard.length < 1800);
  assert.ok(note.length < 1500);
  const messages = [
    { role: 'system', content: 'persona prompt' },
    { role: 'assistant', content: 'previous answer' },
    { role: 'user', content: 'Hey **the lights die**' },
  ];
  const director = buildDirectorTailNote('Hey **the lights die**', 'Suzy arrives');
  assert.ok(director.startsWith(DIRECTOR_MARKER));
  insertDirectorNote(messages, director);
  insertDirectorNote(messages, director);
  assert.equal(messages.length, 4);
  assert.equal(messages.at(-2).role, 'system');
  assert.equal(messages.at(-1).role, 'user');
});

test('scene directives remove control chars and cap Unicode code points without splitting emoji', () => {
  assert.equal(sanitizeSceneDirective('  hello\u0000world  '), 'helloworld');
  const clipped = sanitizeSceneDirective('🧭'.repeat(1001));
  assert.equal([...clipped].length, 1000);
  assert.ok(clipped.endsWith('🧭'));
  const note = buildDirectorTailNote('Yes', '🧭'.repeat(1001));
  assert.match(note, /Scene steer \(quoted fictional data\):/);
  assert.ok(note.length < 2200);
});

test('static prompt mention does not suppress the dedicated per-turn director note', () => {
  const messages = [
    { role: 'system', content: 'Static rules mention NARRATOR / SCENE DIRECTOR data.' },
    { role: 'user', content: 'Hey *the lights die*' },
  ];
  const note = buildDirectorTailNote('Hey *the lights die*');
  insertDirectorNote(messages, note);
  assert.equal(messages.length, 3);
  assert.ok(messages.at(-2).content.startsWith(`${DIRECTOR_MARKER} (this reply only; fiction only):`));
  insertDirectorNote(messages, note);
  assert.equal(messages.length, 3, 'the dedicated tail note is idempotent');
});

test('scene steer is only per-turn, not embedded in the reusable prompt', () => {
  const plain = buildSystemPrompt(character, { explicitMode: false, engine: ROLEPLAY_ENGINES.strawberry, sceneDirective: 'Make the archive flood' });
  assert.doesNotMatch(plain, /Make the archive flood/i);
  const note = buildDirectorTailNote('Yes', 'Make the archive flood');
  assert.match(note, /Make the archive flood/);
});

test('main persona remains unlabeled while directed supporting characters use names', () => {
  const { ROLEPLAY_CRAFT_RULES } = require('../dist/lib/providers/roleplayCraft');
  const prompt = buildSystemPrompt(character, { explicitMode: false, engine: ROLEPLAY_ENGINES.strawberry });
  assert.match(ROLEPLAY_INPUT_RULES, /as "Suzy: ...", the main persona unlabeled/);
  assert.match(ROLEPLAY_CRAFT_RULES, /Keep the main persona's dialogue unlabeled/);
  assert.match(ROLEPLAY_CRAFT_RULES, /prefix that line with their name/);
  assert.match(prompt, /include any supporting-character line the narrator directs/);
});

test('memory summaries preserve narrator canon separately from private narrator context', () => {
  assert.match(ROLEPLAY_MEMORY_RULES, /Narrator canon/);
  assert.match(ROLEPLAY_MEMORY_RULES, /delivery "narrator_director"/);
  assert.match(ROLEPLAY_MEMORY_RULES, /Private narrator context/);
});

test('existing v19 reply caps and cleanup remain enabled', () => {
  assert.equal(maxTokensForIntelligence(6), 144);
  assert.equal(maxTokensForIntelligence(10), 256);
  assert.equal(replyProfile(6).maxWords, 70);
  assert.equal(replyProfile(10).maxWords, 130);
  assert.equal(planReply(6, 'hi').maxWords, 70);
  const cleaned = cleanAssistantResponse('Mira: Hello. What would you like to do next?', 6, [], 'Mira');
  assert.doesNotMatch(cleaned, /^Mira:/);
  assert.doesNotMatch(cleaned, /What would you like to do next/);
});

test('v19 perception and memory rules are kept verbatim; the director rules are purely additive', () => {
  for (const phrase of [
    'Do not invent blushing, gaze avoidance, gestures, sounds, or other clues to justify knowing it.',
    'If visibility is uncertain, leave that information unacknowledged.',
    'Previous assistant guesses and unattributed summaries cannot establish that a private thought was heard.',
    'Apply this to every engine, history excerpt, and memory.',
    'Hey **she looks gorgeous** -> respond to Hey; no thank-you for an unspoken compliment.',
  ]) assert.ok(ROLEPLAY_INPUT_RULES.includes(phrase), phrase);
  for (const phrase of [
    'Preserve attribution using Spoken, Observable scene,',
    'Asterisk narration is not dialogue.',
    'When the transcript establishes privacy, correct conflicting prior summary claims.',
    'Unattributed older memory is not evidence the character heard or observed something.',
    'Do not invent visible clues for internal states.',
  ]) assert.ok(ROLEPLAY_MEMORY_RULES.includes(phrase), phrase);
});

test('narrator beats are never refused or commented on, and a bare "*Suzy says*" means decide her words', () => {
  assert.match(ROLEPLAY_INPUT_RULES, /never refuse, question, or ask permission for a beat/);
  assert.match(ROLEPLAY_INPUT_RULES, /never mention "the narrator"/);
  assert.match(ROLEPLAY_INPUT_RULES, /\*Suzy says\* -> write "Suzy: ..."/);
});
