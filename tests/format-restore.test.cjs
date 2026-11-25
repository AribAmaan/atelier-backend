const test = require('node:test');
const assert = require('node:assert/strict');
const { restoreActionMarkup } = require('../dist/lib/providers/replyPolish');
const { cleanAssistantResponse } = require('../dist/lib/providers');
const { planTurnSteers } = require('../dist/lib/providers/turnDirector');
const { ROLEPLAY_INPUT_RULES } = require('../dist/lib/roleplayInput');

const plain = '"Ow!"\n\nShe yelps, hand flying to her cheek.\n\n"Damn it, sugar." She settles back, grinning.\n\n"Eggs?"';

test('a reply with no asterisks but quoted dialogue gets its narration wrapped, words unchanged', () => {
  const out = restoreActionMarkup(plain);
  assert.equal(out, '"Ow!"\n\n*She yelps, hand flying to her cheek.*\n\n"Damn it, sugar." *She settles back, grinning.*\n\n"Eggs?"');
  assert.equal(out.replace(/\*/g, ''), plain);
});

test('works for any character or cast name, and keeps speaker labels plain', () => {
  for (const n of ['Kaito', 'The Duchess', 'Maria de la Cruz', 'Rex']) {
    const t = `${n} looks up from the map.\n\nMira: "Hello there."\n\n"Hi." ${n} nods.`;
    const out = restoreActionMarkup(t);
    assert.match(out, /Mira: "Hello there\."/);
    assert.ok(!/\*Mira:\*/.test(out));
    assert.equal(out.replace(/\*/g, ''), t);
  }
});

test('ambiguous replies are left exactly as written', () => {
  for (const t of ['*She waves.* "Hi."', '"Hi. *waves*"', 'Just talking, no quotes at all.', 'He said "no way" and left.', '"Unbalanced quote', 'She nods. "Hi." She waits.']) {
    assert.equal(restoreActionMarkup(t), t, t);
  }
});

test('restoring is idempotent and curly quotes work', () => {
  const t = '\u201cHi.\u201d\n\nShe waves.';
  const once = restoreActionMarkup(t);
  assert.equal(once, '\u201cHi.\u201d\n\n*She waves.*');
  assert.equal(restoreActionMarkup(once), once);
});

test('cleanAssistantResponse applies it in the real save path', () => {
  const out = cleanAssistantResponse(plain, 8, [], 'Abigail');
  assert.match(out, /\*She yelps, hand flying to her cheek\.\*/);
});

const chop = '"Oh."\n\nShe blinks.\n\n"Ana."\n\nThe name comes out quiet.\n\n"Stay."\n\nHer hand finds yours.';
test('two chains of one-line paragraphs in a row trigger a layout steer; healthy layouts do not', () => {
  const history = [{ role: 'user', content: 'a' }, { role: 'assistant', content: chop }, { role: 'user', content: 'b' }, { role: 'assistant', content: chop }, { role: 'user', content: 'c' }];
  assert.ok(planTurnSteers({ history, latestUserText: 'c' }).some(s => s.id === 'choppy_run'));
  const healthy = '*She smiles.* "Hi."\n\n"Come in, it is cold."';
  const h2 = history.map(m => (m.role === 'assistant' ? { ...m, content: healthy } : m));
  assert.ok(!planTurnSteers({ history: h2, latestUserText: 'c' }).some(s => s.id === 'choppy_run'));
});

test('the asterisk-format steer no longer pushes first person', () => {
  const un = 'She blinks, then sets her coffee down. "Oh."';
  const history = [{ role: 'user', content: 'a' }, { role: 'assistant', content: un }, { role: 'user', content: 'b' }, { role: 'assistant', content: un }, { role: 'user', content: 'c' }];
  const steer = planTurnSteers({ history, latestUserText: 'c' }).find(s => s.id === 'format_actions');
  assert.ok(steer);
  assert.doesNotMatch(steer.text, /\*I tuck/);
  assert.match(steer.text, /same person you already narrate in/);
});

test('supporting characters get no invented romantic or sexual contact', () => {
  assert.match(ROLEPLAY_INPUT_RULES, /Do not start romantic or sexual contact involving a supporting character unless the user directs it/);
});
