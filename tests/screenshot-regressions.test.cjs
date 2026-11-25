const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDirectorTailNote, isPhysicalImpactOnPersona, endsOnOpenSpeechTag, ROLEPLAY_INPUT_RULES } = require('../dist/lib/roleplayInput.js');
const { ROLEPLAY_CRAFT_RULES } = require('../dist/lib/providers/roleplayCraft.js');
const { CONVERSATION_AWARENESS_RULES } = require('../dist/lib/conversationAwareness.js');

test('a slap aimed at the persona asks for the spoken reflex FIRST', () => {
  const note = buildDirectorTailNote('*I slap her ass*', undefined, 'Abigail');
  assert.match(note, /FIRST words of the reply/);
  assert.match(note, /overrides the usual action-first order/);
});

test('impact verbs without the persona as target do not trigger a reflex', () => {
  for (const t of ["let's grab a bite", 'play poker?', 'a punch line', '*I kick off my shoes*', 'the candle flickers',
    '*I flick on the TV*', '*he bites into the pie*', '*Mark slaps me*', '*I slap the table*', '*I hit the road*', 'kickstart the car']) {
    assert.equal(isPhysicalImpactOnPersona(t, 'Abigail'), false, t);
  }
});

test('impact on the persona by pronoun or name still triggers', () => {
  for (const t of ['i slap her ass', '*I slap her*', 'I smack him on the arm', 'i hit her', 'tickles her ribs', '*I playfully poke you*', 'I pinch Abigail']) {
    assert.equal(isPhysicalImpactOnPersona(t, 'Abigail'), true, t);
  }
});

test('"ana my older sister comes and says" is an open speech tag; the note asks for Ana\'s own line', () => {
  assert.equal(endsOnOpenSpeechTag('*ana my older sister comes and says*'), true);
  const note = buildDirectorTailNote('*ana my older sister comes and says*', undefined, 'Abigail');
  assert.match(note, /speech tag with no words/);
  assert.match(note, /"Name: \.\.\."/);
  assert.match(note, /without invented backstory/);
});

test('speech tags that already carry words, or are ordinary talk, are not open', () => {
  assert.equal(endsOnOpenSpeechTag('*Mark comes in and says "hi"*'), false);
  assert.equal(endsOnOpenSpeechTag("that's what she always says"), false);
  assert.equal(endsOnOpenSpeechTag('hey beautiful'), false);
  assert.equal(endsOnOpenSpeechTag('ana my older sister comes and says'), true);
});

// The app is multi-character: nothing here may depend on a particular character or supporting-cast name.
const CHARACTERS = ['Abigail', 'Kaito Tanaka', 'The Duchess', 'Lady Rose', 'Maria de la Cruz', 'Priya', 'Rex'];

test('behaviour is the same for any character name', () => {
  for (const name of CHARACTERS) {
    assert.equal(isPhysicalImpactOnPersona('*I slap her*', name), true, name);
    assert.equal(isPhysicalImpactOnPersona('*I slap the table*', name), false, name);
    assert.equal(isPhysicalImpactOnPersona('let\'s grab a bite', name), false, name);
    assert.match(buildDirectorTailNote('*I smack him on the arm*', undefined, name), /FIRST words/, name);
    assert.match(buildDirectorTailNote('*mira the waitress comes over and asks*', undefined, name), /speech tag with no words/, name);
  }
});

test('the persona may be hit by name, whatever the name is', () => {
  assert.equal(isPhysicalImpactOnPersona('I pinch Kaito', 'Kaito Tanaka'), true);
  assert.equal(isPhysicalImpactOnPersona('I poke Priya', 'Priya'), true);
  assert.equal(isPhysicalImpactOnPersona('I slap Duchess', 'The Duchess'), true);
});

test('the shared prompt rules name no specific character', () => {
  for (const rules of [ROLEPLAY_INPUT_RULES, ROLEPLAY_CRAFT_RULES, CONVERSATION_AWARENESS_RULES]) {
    assert.doesNotMatch(rules, /\b(?:Ana|Abigail|William)\b/i);
  }
});

test('prompt rules: cast is new to the scene, names are not invented, reaction order yields', () => {
  assert.match(ROLEPLAY_INPUT_RULES, /lowercase name is still a name/);
  assert.match(ROLEPLAY_INPUT_RULES, /do not invent their past, illness/);
  assert.match(CONVERSATION_AWARENESS_RULES, /never invent a name/);
  assert.match(ROLEPLAY_CRAFT_RULES, /ORDER yields to the moment/);
});
