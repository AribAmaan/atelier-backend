const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCastHandoffGuard, ROLEPLAY_INPUT_RULES } = require('../dist/lib/roleplayInput');
const { buildSystemPrompt } = require('../dist/lib/providers');

const cast = [
  { name: 'Amy', personality: 'playful, teasing', backstory: 'Lives next door.' },
  { name: 'Sam', personality: 'quiet', backstory: 'A coworker.' },
];
const msg = '*amy comes to my room* *Abigail out of the conversation for now* come in amy';

test('rules tell the model scene directions can hand the reply to another character', () => {
  assert.match(ROLEPLAY_INPUT_RULES, /SPEAKER HANDOFF:/);
  assert.match(ROLEPLAY_INPUT_RULES, /A character who is only mentioned or discussed does not take over/);
});

test('latest turn naming a cast member adds only that profile', () => {
  const guard = buildCastHandoffGuard(msg, [], cast);
  assert.match(guard, /SPEAKER HANDOFF — OTHER CHARACTERS/);
  assert.match(guard, /"name":"Amy"/);
  assert.doesNotMatch(guard, /"name":"Sam"/);
  assert.match(guard, /starting with "Name: "/);
});

test('an ongoing handoff keeps the profile via recent messages', () => {
  const guard = buildCastHandoffGuard('what are you doing', ['Amy: hey there', 'come closer'], cast);
  assert.match(guard, /"name":"Amy"/);
});

test('names match whole words only and nothing is added otherwise', () => {
  assert.equal(buildCastHandoffGuard('Amyra says hi, and I am a family man', ['hello'], cast), '');
  assert.equal(buildCastHandoffGuard('hello', [], []), '');
});

test('profiles are bounded and quoted as data', () => {
  const guard = buildCastHandoffGuard('Amy', [], [{ name: 'Amy', personality: 'x'.repeat(900), backstory: 'y'.repeat(2000) }]);
  assert.ok(guard.includes('x'.repeat(300)) && !guard.includes('x'.repeat(301)));
  assert.ok(guard.includes('y'.repeat(500)) && !guard.includes('y'.repeat(501)));
});

test('system prompts for a character carry the handoff rule', () => {
  const prompt = buildSystemPrompt({ name: 'Abigail', tagline: '', personality: 'warm', backstory: '', roleplayNotes: '', examples: '[]', memorySummary: '' }, {});
  assert.match(prompt, /SPEAKER HANDOFF:/);
});
