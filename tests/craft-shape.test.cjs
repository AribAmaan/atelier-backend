const test = require('node:test');
const assert = require('node:assert/strict');
const { ROLEPLAY_CRAFT_RULES } = require('../dist/lib/providers/roleplayCraft');
const { buildReplyGuidance } = require('../dist/lib/providers/replyPolicy');

test('craft asks for fewer, fuller passages and concrete body detail', () => {
  assert.match(ROLEPLAY_CRAFT_RULES, /SHAPE: fewer, fuller passages, not a chain of fragments/);
  assert.match(ROLEPLAY_CRAFT_RULES, /never a third short beat/);
  assert.match(ROLEPLAY_CRAFT_RULES, /Never repeat a reassurance, invitation or instruction/);
  assert.match(ROLEPLAY_CRAFT_RULES, /BODY: when the moment calls for it, use concrete physical detail/);
});

test('a bare greeting does not license inventing the user\'s mood or problem', () => {
  assert.match(ROLEPLAY_CRAFT_RULES, /never invent their mood or problem from a bare greeting/i);
  for (const level of [5, 7, 10]) {
    assert.match(buildReplyGuidance(level, 'normal', false), /never on several short beats, repeated reassurance, or guesses about how the user feels/);
  }
});

test('word floors and ceilings are unchanged by the shape rules', () => {
  assert.match(buildReplyGuidance(10, 'normal', false), /at least 105 words/);
  assert.match(buildReplyGuidance(10, 'normal', false), /130 is the hard ceiling/);
  assert.match(buildReplyGuidance(7, 'normal', false), /70 is the hard ceiling/);
});
