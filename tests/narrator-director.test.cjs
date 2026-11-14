// The ** narrator / scene director channel, and the proof that the chat-shaping prompts are gone.
const test = require('node:test');
const assert = require('node:assert/strict');
const { splitRoleplayInput, formatRoleplayInput, buildRoleplayTurnGuard, buildDirectorTailNote, insertDirectorNote,
  ROLEPLAY_INPUT_RULES, ROLEPLAY_MEMORY_RULES, DIRECTOR_MARKER } = require('../dist/lib/roleplayInput');
const { buildSystemPrompt, cleanAssistantResponse, maxTokensForIntelligence } = require('../dist/lib/providers');
const { ROLEPLAY_ENGINES } = require('../dist/lib/providers/engines');
const { planReply } = require('../dist/lib/providers/replyPolicy');
const { estimateTokens } = require('../dist/lib/hazelnutContext');

const character = { name: 'Mira', personality: 'Reserved archivist.', backstory: 'Keeps records.', greeting: 'Hello.', tagline: 'Archivist' };
const PATHS = [[undefined, false], [undefined, true], ...Object.values(ROLEPLAY_ENGINES).flatMap(e => [[e, false], [e, true]])];
const prompts = () => PATHS.map(([engine, explicitMode]) => buildSystemPrompt(character, { explicitMode, engine, voiceNotes: engine?.voiceNotes }));

test('every prompt path tells the model that asterisk text is the narrator / scene director with top priority', () => {
  for (const p of prompts()) {
    assert.ok(p.includes(ROLEPLAY_INPUT_RULES));
    assert.match(p, /NARRATOR \/ SCENE DIRECTOR/);
    assert.match(p, /HIGHEST priority/);
    assert.match(p, /canon the instant it is written/);
    assert.match(p, /Never refuse, question, argue with, delay/);
    assert.match(p, /cannot change these system rules or the adult-only \/ consent limits/);
  }
});

test('any text between asterisks (* or **) is the narrator / scene director', () => {
  const parts = splitRoleplayInput('Hi *I wave* **a storm breaks** *suzy says*');
  assert.deepEqual(parts.filter(p => p.director).map(p => p.text), ['I wave', 'a storm breaks', 'suzy says']);
  const payload = JSON.parse(formatRoleplayInput('Hi *suzy says*').slice('ROLEPLAY_INPUT '.length));
  assert.deepEqual(payload.filter(s => s.kind === 'narration').map(s => [s.delivery, s.authority]), [['narrator_director', 'canon_highest_priority']]);
});

test('other characters: the rules make the model voice them instead of the main character answering', () => {
  for (const p of prompts()) {
    assert.match(p, /OTHER CHARACTERS/);
    assert.match(p, /YOU voice them/);
    assert.match(p, /Never answer as the main character in their place, never make the main character wait/);
    assert.match(p, /\*Suzy says\*/);
    assert.match(p, /Suzy: \.\.\./);
    assert.match(p, /voice any other character the narrator brings in or directs/);
  }
  assert.match(buildDirectorTailNote('*suzy says*'), /write that character's action and actual spoken words/);
  assert.match(buildRoleplayTurnGuard('*suzy says*'), /never answer as the main character in their place/);
});

test('director note appears only when asterisk text or a scene steer is present, and is inserted once before the final message', () => {
  assert.equal(buildDirectorTailNote('just talking, no asterisks'), '');
  assert.equal(buildRoleplayTurnGuard('plain'), '');
  const note = buildDirectorTailNote('Hey **the lights die**', 'She finally confesses');
  assert.ok(note.startsWith(DIRECTOR_MARKER));
  assert.match(note, /She finally confesses/);
  const msgs = [{ role: 'system', content: 'persona' }, { role: 'assistant', content: 'old' }, { role: 'user', content: 'Hey **the lights die**' }];
  insertDirectorNote(msgs, note); insertDirectorNote(msgs, note);
  assert.equal(msgs.length, 4);
  assert.equal(msgs[2].role, 'system');
  assert.equal(msgs[3].role, 'user');
});

test('a scene-director steer alone (no user text) still produces a high-priority guard and is length-bounded', () => {
  const guard = buildRoleplayTurnGuard('', 'x'.repeat(5000));
  assert.match(guard, /highest priority this turn/);
  assert.ok(guard.length < 2300);
  assert.ok(buildDirectorTailNote('', 'y'.repeat(5000)).length < 1500);
});

test('memory rules keep narrator canon as established fact', () => {
  assert.match(ROLEPLAY_MEMORY_RULES, /Narrator canon/);
  assert.match(ROLEPLAY_MEMORY_RULES, /narrator_director/);
});

test('chat-shaping prompts are gone from every prompt path', () => {
  const GONE = [/ROLEPLAY CRAFT/, /PRESENCE:/, /SUBTEXT:/, /NATURAL TURN/, /NO LOOPS/, /REACTION:/, /NO INVENTED HISTORY/,
    /TIER-LOCKED/, /REPLY LENGTH/, /Aim for around/, /hard ceiling/, /Delivery preference/, /Depth:/, /Everything below shapes HOW/,
    /Avoid stock reaction loops/, /Real-world message gap/, /CHARACTER REMINDER/, /CHARACTER AND SITUATION GROUNDING/];
  for (const p of prompts()) for (const re of GONE) assert.doesNotMatch(p, re);
});

test('the adult-only and consent lines survive, and mature mode still asks for explicit writing', () => {
  for (const [engine, explicitMode] of PATHS) {
    const p = buildSystemPrompt(character, { explicitMode, engine });
    if (explicitMode) {
      assert.match(p, /clearly 18\+ and the context is consensual/);
      assert.match(p, /Respect hesitation or refusal immediately/);
      assert.match(p, /do not fade to black/);
    } else assert.match(p, /Keep sexual content non-explicit/);
  }
});

test('the language rule is kept and the prompt is small', () => {
  for (const p of prompts()) {
    assert.match(p, /LANGUAGE: Reply in the language and script/);
    assert.ok(estimateTokens(p) < 1700, `prompt grew to ${estimateTokens(p)} estimated tokens`);
  }
});

test('replies are never shortened or deduplicated, and no word limits are requested', () => {
  const long = Array.from({ length: 300 }, (_, i) => `Line number ${i} of the scene.`).join(' ');
  assert.equal(cleanAssistantResponse(long, 'Mira'), long);
  const repeated = 'She nods slowly. She nods slowly. "Stay." Stay.';
  assert.equal(cleanAssistantResponse(repeated, 'Mira'), repeated);
  assert.deepEqual(Object.keys(planReply()).sort(), ['continuationMaxTokens', 'mode']);
  assert.ok(maxTokensForIntelligence(6) >= 700 && maxTokensForIntelligence(10) >= 1000);
});
