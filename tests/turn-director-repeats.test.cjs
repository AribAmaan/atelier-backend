const test = require('node:test');
const assert = require('node:assert/strict');
const { planTurnSteers, analyzeReply, findPlainActionBeats } = require('../dist/lib/providers/turnDirector.js');

const U = c => ({ role: 'user', content: c });
const A = c => ({ role: 'assistant', content: c });
const ids = input => planTurnSteers(input).map(s => s.id);

// Plain (no-asterisk) replies in the shape the saved Kira chat had.
const plain = [
  `I stifle a laugh, shaking my head while sliding my hands into my coat pockets.\n\nIt's sweet, really. Means I still have a place in your head. Are you working nearby, or just passing through? You look like you've got stories I haven't heard yet.`,
  `I run my thumb along the rim of my coffee cup, smiling without looking up right away.\n\nIt's alright. Means I haven't become a stranger completely. Tell me, though, are you here for long, or just passing through on your way to something bigger?`,
  `I set my coffee down on the table between us, wrapping both hands around the warm mug as I look at you properly.\n\nSomeone I'd actually recognize on the street. You look like you've got your own opinions now. Means a lot.`,
];

test('unasterisked action beats are seen as actions, and a format steer is issued', () => {
  const shape = analyzeReply(plain[0]);
  assert.equal(shape.opening, 'action');
  assert.ok(shape.unmarkedActions >= 1 && shape.actions >= 1);
  const history = [U('a'), A(plain[0]), U('b'), A(plain[1]), U('c')];
  const out = ids({ history, latestUserText: 'c' });
  assert.ok(out.includes('format_actions'));
  assert.ok(!out.includes('no_actions'), 'unmarked beats must not read as "no actions"');
});

test('speech that starts with "I" is not mistaken for an action beat', () => {
  for (const t of ['I think so, but I hope you stay.', 'I stand corrected.', 'I run a small shop downtown.', 'I look forward to it.', '"I laugh at everything," she said.']) {
    assert.equal(findPlainActionBeats(t).length, 0, t);
  }
  assert.equal(findPlainActionBeats('I tuck a strand behind my ear.').length, 1);
});

test('a reply that already uses asterisks never gets the format steer', () => {
  const marked = n => `*She tucks a strand behind her ear.* Fine ${n}.`;
  const history = [U('a'), A(marked(1)), U('b'), A(marked(2)), U('c')];
  assert.ok(!ids({ history, latestUserText: 'c' }).includes('format_actions'));
});

test('a question asked twice and never answered is not asked a third time; an answered one is', () => {
  const history = [U('hi'), A(plain[0]), U('what do you mean'), A(plain[1]), U('ok')];
  assert.ok(ids({ history, latestUserText: 'ok' }).includes('repeated_question'));
  const answered = [U('hi'), A(plain[0]), U('just passing through yeah'), A(plain[1]), U('ok')];
  assert.ok(!ids({ history: answered, latestUserText: 'ok' }).includes('repeated_question'));
});

test('a sentence-opening habit and a repeated opening object are named', () => {
  const history = [U('a'), A(plain[0]), U('b'), A(plain[1]), U('c'), A(plain[2]), U('d')];
  const out = planTurnSteers({ history, latestUserText: 'd', characterName: 'Kira' });
  assert.match(out.find(s => s.id === 'starter_tic').text, /means/i);
  assert.match(out.find(s => s.id === 'opener_repeat').text, /coffee/i);
});

test('a paraphrased line that returns in two of the newest replies is retired', () => {
  const a = `I nod. Someone I'd actually recognize on the street, that's you.`;
  const b = `I wave. You grew up into someone I'd actually recognize anywhere.`;
  const out = planTurnSteers({ history: [U('a'), A(a), U('b'), A(b), U('c')], latestUserText: 'c' });
  assert.match(out.find(s => s.id === 'retire')?.text ?? '', /actually/i);
});

test('invented shared history is flagged only when neither persona nor user supplied it', () => {
  const claim = [U('hey'), A('You used to beg me for extra dessert, remember?'), U('lol yes')];
  assert.ok(ids({ history: claim, latestUserText: 'lol yes', knownFacts: 'Mia is a barista.' }).includes('invented_past'));
  assert.ok(!ids({ history: claim, latestUserText: 'lol yes', knownFacts: 'You used to beg me for extra dessert.' }).includes('invented_past'));
});

test('"what do you mean" gets a clarify steer; a question answered with a question gets a direct-answer steer', () => {
  const history = [U('hi'), A('I smile. So, are you here for long?'), U('what do you mean')];
  assert.ok(ids({ history, latestUserText: 'what do you mean' }).includes('clarify'));
  const h2 = [U('hi'), A('I smile. So, are you here for long?'), U('how long are you staying?')];
  assert.ok(ids({ history: h2, latestUserText: 'how long are you staying?' }).includes('direct_question'));
  const h3 = [U('hi'), A('Good to see you.'), U('how long are you staying?')];
  assert.ok(!ids({ history: h3, latestUserText: 'how long are you staying?' }).includes('direct_question'));
});

test('three action-first replies of near-identical length are called one template', () => {
  const same = n => A(`*She looks up.* Fine ${n}. Sit down and tell me everything about the trip, all of it, slowly.`);
  const history = [U('a'), same(1), U('b'), same(2), U('c'), same(3), U('d')];
  assert.ok(ids({ history, latestUserText: 'd' }).includes('structure_run'));
});

test('an invented age is flagged even when the other words in the sentence are known', () => {
  const history = [U('i called you mama, a childhood habit'), A('You used to call me that when you were what, six?'), U('lol')];
  assert.ok(ids({ history, latestUserText: 'lol', knownFacts: 'She used to babysit you.' }).includes('invented_past'));
  assert.ok(!ids({ history, latestUserText: 'lol', knownFacts: 'She used to babysit you when you were six.' }).includes('invented_past'));
});

test('"meaning of life?" is a question, not a request to clarify the last line', () => {
  const history = [U('hi'), A('I smile. Ready?'), U('meaning of life?')];
  assert.ok(!ids({ history, latestUserText: 'meaning of life?' }).includes('clarify'));
});

test('a beat with the character\'s name as subject counts as an action, not as "no actions"', () => {
  const r = n => `Rhea leans against the doorframe and tilts her head. The studio is a mess, number ${n}. Start early tomorrow.`;
  const history = [U('a'), A(r(1)), U('b'), A(r(2)), U('c'), A(r(3)), U('d')];
  assert.ok(!ids({ history, latestUserText: 'd', characterName: 'Rhea' }).includes('no_actions'));
});

test("\"you'd always ...\" (with either apostrophe) is read as a claim about shared history", () => {
  for (const apostrophe of ["'", "\u2019"]) {
    const history = [U('hey'), A(`You${apostrophe}d always steal my fries, remember?`), U('lol')];
    assert.ok(ids({ history, latestUserText: 'lol', knownFacts: 'Mia is a barista.' }).includes('invented_past'), apostrophe);
  }
});
