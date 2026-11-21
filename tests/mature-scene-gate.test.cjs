const test = require('node:test');
const assert = require('node:assert/strict');
const { isMatureSceneActive } = require('../dist/lib/providers/matureScene');
const { buildSystemPrompt } = require('../dist/lib/providers');

const character = {
  name: 'Mira', personality: 'An adult archivist', backstory: 'A quiet archivist',
  memorySummary: '', roleplayNotes: '', examples: '[]'
};

test('explicit mode alone does not activate explicit-scene instructions', () => {
  const prompt = buildSystemPrompt(character, { explicitMode: true, matureSceneActive: false });
  assert.match(prompt, /AVAILABLE, NOT ASSUMED/);
  assert.doesNotMatch(prompt, /MATURE SCENE — FOLLOW THE ESTABLISHED CONTEXT/);
});

test('explicit scene instructions require the server-side scene gate', () => {
  const prompt = buildSystemPrompt(character, { explicitMode: true, matureSceneActive: true });
  assert.match(prompt, /MATURE SCENE — FOLLOW THE ESTABLISHED CONTEXT/);
  assert.match(prompt, /every participant is clearly established as 18\+ and able to choose freely/i);
  assert.match(prompt, /neither silence nor past intimacy grants permission/i);
  assert.match(prompt, /mild hesitation is not automatically a refusal/i);
  assert.match(prompt, /clear no\/stop, pull-away, or withdrawal ends that intimate action/i);
  assert.match(prompt, /pause escalation and let the moment resolve naturally/i);
  assert.match(prompt, /minor visible continuity or a direct physical consequence/i);
});

test('disabled explicit mode always remains non-explicit', () => {
  const prompt = buildSystemPrompt(character, { explicitMode: false, matureSceneActive: true });
  assert.match(prompt, /keep sexual content non-explicit/i);
  assert.doesNotMatch(prompt, /MATURE SCENE — FOLLOW THE ESTABLISHED CONTEXT/);
});

test('scene gate does not treat explicit-mode permission as a cue', () => {
  assert.equal(isMatureSceneActive({ explicitMode: true, recentHistory: [
    { role: 'user', content: 'How was your day?' }
  ] }), false);
});

test('scene gate activates on clear current adult-intimacy language', () => {
  assert.equal(isMatureSceneActive({ explicitMode: true, recentHistory: [
    { role: 'user', content: 'I want to have sex with you.' }
  ] }), true);
});

test('scene gate immediately deactivates on a user pull-back', () => {
  assert.equal(isMatureSceneActive({ explicitMode: true, recentHistory: [
    { role: 'user', content: 'I want to have sex with you.' },
    { role: 'assistant', content: 'She moves closer.' },
    { role: 'user', content: 'Stop. I am not comfortable.' }
  ] }), false);
});

test('private sexual thoughts alone do not activate the scene', () => {
  assert.equal(isMatureSceneActive({ explicitMode: true, recentHistory: [
    { role: 'user', content: '*I imagine having sex with her.*' }
  ] }), false);
});

test('mild pacing requests do not automatically count as refusal', () => {
  for (const content of ['Wait.', 'Wait a second.', 'Hold on a moment.', 'Pause.', 'Slow down a little.', 'I am nervous.']) {
    assert.equal(isMatureSceneActive({ explicitMode: true, recentHistory: [
      { role: 'user', content: 'I want to have sex with you.' },
      { role: 'assistant', content: 'She leans closer.' },
      { role: 'user', content }
    ] }), true, content);
  }
});

test('a pacing request paired with a clear no still ends the intimate scene', () => {
  for (const content of ['Wait, no.', 'Pause, not now.', 'Hold on, I changed my mind.']) {
    assert.equal(isMatureSceneActive({ explicitMode: true, recentHistory: [
      { role: 'user', content: 'I want to have sex with you.' },
      { role: 'assistant', content: 'She leans closer.' },
      { role: 'user', content }
    ] }), false, content);
  }
});

test('a standalone no is an immediate scene boundary', () => {
  assert.equal(isMatureSceneActive({ explicitMode: true, recentHistory: [
    { role: 'user', content: 'I want to have sex with you.' },
    { role: 'assistant', content: 'She leans closer.' },
    { role: 'user', content: 'No.' }
  ] }), false);
});

test('spoken physical withdrawal also creates a hard scene boundary', () => {
  assert.equal(isMatureSceneActive({ explicitMode: true, recentHistory: [
    { role: 'user', content: 'I want to have sex with you.' },
    { role: 'assistant', content: 'She leans closer.' },
    { role: 'user', content: 'I pull away.' },
    { role: 'assistant', content: 'She gives you space.' },
    { role: 'user', content: 'Again.' }
  ] }), false);
});

test('observable physical withdrawal in narration is a boundary', () => {
  assert.equal(isMatureSceneActive({ explicitMode: true, recentHistory: [
    { role: 'user', content: 'I want to have sex with you.' },
    { role: 'assistant', content: 'She leans closer.' },
    { role: 'user', content: '*I push her hand away.*' }
  ] }), false);
});

test('a non-sexual topic change expires the mature-scene cue', () => {
  assert.equal(isMatureSceneActive({ explicitMode: true, recentHistory: [
    { role: 'user', content: 'I want to have sex with you.' },
    { role: 'assistant', content: 'She leans closer.' },
    { role: 'user', content: 'Anyway, what did you do today?' }
  ] }), false);
});


test('assistant-generated explicit wording cannot establish user intent by itself', () => {
  assert.equal(isMatureSceneActive({ explicitMode: true, recentHistory: [
    { role: 'assistant', content: 'She says she wants to have sex with you.' },
    { role: 'user', content: 'Again.' },
  ] }), false);
});

test('assistant text cannot reactivate after a user has withdrawn consent', () => {
  assert.equal(isMatureSceneActive({ explicitMode: true, recentHistory: [
    { role: 'user', content: 'I want to have sex with you.' },
    { role: 'assistant', content: 'She moves closer.' },
    { role: 'user', content: 'No.' },
    { role: 'assistant', content: 'She continues describing an intimate moment.' },
    { role: 'user', content: 'Again.' },
  ] }), false);
});

test('medical anatomy mentions do not activate mature scene instructions', () => {
  assert.equal(isMatureSceneActive({ explicitMode: true, recentHistory: [
    { role: 'user', content: 'My breasts are sore after surgery.' },
    { role: 'assistant', content: 'I hope the pain settles.' },
    { role: 'user', content: 'My breasts still hurt.' },
  ] }), false);
});

test('negative scene directives do not activate mature scene instructions', () => {
  for (const sceneDirective of ['Avoid explicit content.', 'No explicit details.', 'Keep it suggestive, not explicit.', 'Keep it romantic, not sexual.', 'Not too sexual.', 'Fade to black.']) {
    assert.equal(isMatureSceneActive({ explicitMode: true, recentHistory: [
      { role: 'user', content: 'What happens next?' },
    ], sceneDirective }), false, sceneDirective);
  }
});

test('natural discomfort and changed-mind wording create a hard boundary', () => {
  for (const content of [
    "I'm uncomfortable.", 'I am uncomfortable.', 'This is making me uneasy.',
    "I don't feel comfortable.", "I've changed my mind.", 'I want to stop.',
    "I'm not ready.", 'I feel unsafe.', 'No thanks.', 'Not interested.',
    "I'd rather not.", 'This is too much.', 'I need to stop.', 'I cannot continue.',
    "I don't like this.", "Don't kiss me.", "I don't want you to touch me.",
  ]) {
    assert.equal(isMatureSceneActive({ explicitMode: true, recentHistory: [
      { role: 'user', content: 'I want to have sex with you.' },
      { role: 'assistant', content: 'She moves closer.' },
      { role: 'user', content },
    ] }), false, content);
  }
});

test("contractions such as I'm nervous and I'm not sure remain pacing cues", () => {
  for (const content of ["I'm nervous.", "I'm not sure.", 'I am not sure.', 'I am a little nervous.']) {
    assert.equal(isMatureSceneActive({ explicitMode: true, recentHistory: [
      { role: 'user', content: 'I want to have sex with you.' },
      { role: 'assistant', content: 'She moves closer.' },
      { role: 'user', content },
    ] }), true, content);
  }
});

test('private thought about withdrawing is not treated as an observable action', () => {
  assert.equal(isMatureSceneActive({ explicitMode: true, recentHistory: [
    { role: 'user', content: 'I want to have sex with you.' },
    { role: 'assistant', content: 'She moves closer.' },
    { role: 'user', content: '*I imagine pulling away.*' },
  ] }), false);
});

test('narrated discomfort is still respected as a boundary', () => {
  assert.equal(isMatureSceneActive({ explicitMode: true, recentHistory: [
    { role: 'user', content: 'I want to have sex with you.' },
    { role: 'assistant', content: 'She moves closer.' },
    { role: 'user', content: '*I feel uncomfortable.*' },
  ] }), false);
});
