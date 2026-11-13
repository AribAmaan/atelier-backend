const test = require('node:test');
const assert = require('node:assert/strict');
const { streamCompleteReply } = require('../dist/lib/providers/completeReply');
const { dropRepeatedSentences } = require('../dist/lib/providers/replyRepeat');
const { depthContinuationSuffix } = require('../dist/lib/providers/completeReply');
const { cleanAssistantResponse } = require('../dist/lib/providers');
const { LANGUAGE_RULE } = require('../dist/lib/conversationAwareness');

// Shapes taken from a real chat where a top-up call restarted the reply.
const first = "Fine, English. She looks up at you, lips already parted, voice dropping to a rough whisper. I'm not some girl you found at a bar. You're mine. Only mine.";

test('a restarted reply is cut back to its first copy', () => {
  const doubled = `${first} She sinks lower, gaze locking on yours. ${first}`;
  const cleaned = dropRepeatedSentences(doubled);
  assert.equal(cleaned, `${first} She sinks lower, gaze locking on yours.`);
});

test('a sentence repeated inside one reply is removed, with its orphaned one-word tail', () => {
  const text = "Main tumhe kabhi jaane nahi dungi, tum jaante ho na? Tum meri zimmedari ho. Meri. She sinks lower. Tum meri zimmedari ho. Meri. Sirf meri.";
  const cleaned = dropRepeatedSentences(text);
  assert.equal(cleaned.match(/zimmedari/g).length, 1);
  assert.equal(cleaned.match(/Meri\./g).length, 1);
  assert.match(cleaned, /Sirf meri\.$/);
});

test('near-identical rewordings count as repeats, different sentences do not', () => {
  assert.equal(dropRepeatedSentences('She watches the rain fall on the old window. She watches the rain fall on the old window!'), 'She watches the rain fall on the old window.');
  const distinct = 'She watches the rain fall on the old window. He closes the book and finally looks up at her.';
  assert.equal(dropRepeatedSentences(distinct), distinct);
});

test('lines repeated from the previous replies are dropped, short dialogue is kept', () => {
  const prior = ["Main tumhe kabhi jaane nahi dungi, tum jaante ho na? She rests a hand on your shoulder."];
  const next = "Haan. Main tumhe kabhi jaane nahi dungi, tum jaante ho na? Come here, sit down.";
  assert.equal(dropRepeatedSentences(next, prior), 'Haan. Come here, sit down.');
  assert.equal(dropRepeatedSentences('Haan. Sit down.', ['Haan. Sit down.']), 'Haan. Sit down.');
});

test('Devanagari sentences are compared too', () => {
  const t = 'मैं तुम्हें कभी जाने नहीं दूँगी। चलो बैठो। मैं तुम्हें कभी जाने नहीं दूँगी।';
  assert.equal(dropRepeatedSentences(t), 'मैं तुम्हें कभी जाने नहीं दूँगी। चलो बैठो।');
});

test('a reply that is only repeats is kept rather than emptied, unless a continuation allows empty', () => {
  const t = 'You already know what I am going to say here.';
  assert.equal(dropRepeatedSentences(t, [t]), t);
  assert.equal(dropRepeatedSentences(t, [t], { allowEmpty: true }), '');
});

test('depth top-up that restarts the reply adds nothing', () => {
  assert.equal(depthContinuationSuffix(first, first), '');
  assert.equal(depthContinuationSuffix(first, `${first} `), '');
});

test('depth top-up that restarts and then adds new text keeps only the new text', () => {
  const suffix = depthContinuationSuffix(first, `${first} She tugs you closer and does not look away.`);
  assert.equal(suffix, ' She tugs you closer and does not look away.');
});

test('a normal depth top-up is untouched, with natural spacing', () => {
  assert.equal(depthContinuationSuffix('She waits by the door.', 'Then she finally speaks, quietly.'), ' Then she finally speaks, quietly.');
  assert.equal(depthContinuationSuffix('She waits by the door. ', 'Then she finally speaks, quietly.'), 'Then she finally speaks, quietly.');
});

test('the saved reply is only format-cleaned, never shortened or deduplicated', () => {
  const prior = 'Tum meri zimmedari ho, aur main tumhe kisi aur ke paas nahi jaane dungi.';
  const out = cleanAssistantResponse(`Mira: ${prior} Ab baith jao aur batao kya hua. *she smiles`, 'Mira');
  assert.equal(out, `${prior} Ab baith jao aur batao kya hua. *she smiles*`);
});

test('the language rule is the only chat-level rule left', () => {
  assert.match(LANGUAGE_RULE, /LANGUAGE:.*switch/s);
  assert.match(LANGUAGE_RULE, /romanized Hindi\/Hinglish/);
  assert.doesNotMatch(LANGUAGE_RULE, /NO LOOPS|REACTION|NATURAL TURN/);
});

function fakeStream(outputs) {
  const calls = [];
  const stream = async (messages, onToken, _signal, params) => {
    calls.push(messages);
    const out = outputs[calls.length - 1] ?? '';
    onToken(out);
    params?.onFinish?.('stop');
    return out;
  };
  return { stream, calls };
}
const params = { minWords: 20, targetWords: 24, maxWords: 60, continuationMaxTokens: 160 };
const shortReply = 'She waits by the door, arms folded, watching you closely.';

test('when the top-up only repeats, one more attempt asks for new sentences only', async () => {
  const { stream, calls } = fakeStream([
    shortReply,
    `${shortReply}`,                                    // model restarts: nothing new
    'Then she sighs and finally lets her shoulders drop. "Come in before the rain gets worse," she says quietly.',
  ]);
  const shown = [];
  const result = await streamCompleteReply(stream, [{ role: 'user', content: 'hi' }], t => shown.push(t), undefined, params);
  assert.equal(calls.length, 3);
  assert.match(calls[2].at(-1).content, /only repeated sentences/);
  assert.equal(result.text.split(shortReply).length, 2);          // reply appears once
  assert.match(result.text, /Come in before the rain/);
  assert.equal(shown.join(''), result.text);                      // what streamed equals what is saved
});

test('a top-up that works the first time does not trigger a second call', async () => {
  const { stream, calls } = fakeStream([shortReply, 'Then she sighs and finally lets her shoulders drop, and the room feels warmer.']);
  const result = await streamCompleteReply(stream, [{ role: 'user', content: 'hi' }], () => {}, undefined, params);
  assert.equal(calls.length, 2);
  assert.match(result.text, /warmer\.$/);
});

test('two failed top-ups stop there and keep the original reply intact', async () => {
  const { stream, calls } = fakeStream([shortReply, shortReply, shortReply]);
  const result = await streamCompleteReply(stream, [{ role: 'user', content: 'hi' }], () => {}, undefined, params);
  assert.equal(calls.length, 3);
  assert.equal(result.text, shortReply);
});

test('a short first pass is held back so the reply never appears short and then grows', async () => {
  const sentences = (n, tag) => Array.from({ length: n / 10 }, (_, i) =>
    Array.from({ length: 10 }, (_, j) => `${tag}${i}w${j}`).join(' ') + '.').join(' ');
  let call = 0;
  const stream = async (_m, onToken, _s, p) => {
    const text = call++ === 0 ? sentences(30, 'a') : sentences(90, 'b');
    for (const piece of text.match(/\S+\s*/g)) onToken(piece);
    p.onFinish('stop');
    return text;
  };
  const emits = [];
  const r = await streamCompleteReply(stream, [{ role: 'user', content: 'hi' }], c => emits.push(c), undefined,
    { minWords: 105, maxWords: 130, targetWords: 120, maxTokens: 256, continuationMaxTokens: 160 });
  const words = s => s.trim().split(/\s+/).length;
  assert.equal(call, 2);
  assert.equal(emits.length, 1, 'client receives the finished reply in one block');
  assert.ok(words(emits[0]) >= 105 && words(emits[0]) <= 130);
  assert.equal(emits.join('').trim(), r.text.trim());
});

test('a token cutoff below the floor is recovered silently: one finished block, no short-then-grow', async () => {
  const sentences = (n, tag) => Array.from({ length: n / 10 }, (_, i) =>
    Array.from({ length: 10 }, (_, j) => `${tag}${i}w${j}`).join(' ') + '.').join(' ');
  const first = sentences(40, 'a');
  let call = 0;
  const stream = async (_m, onToken, _s, p) => {
    const text = call++ === 0 ? first : first + ' ' + sentences(70, 'b'); // recovery echoes the tail, then continues
    for (const piece of text.match(/\S+\s*/g)) onToken(piece);
    p.onFinish(call === 1 ? 'length' : 'stop');
    return text;
  };
  const emits = [];
  const r = await streamCompleteReply(stream, [{ role: 'user', content: 'hi' }], c => emits.push(c), undefined,
    { minWords: 105, maxWords: 130, targetWords: 120, maxTokens: 256, continuationMaxTokens: 160 });
  const words = s => s.trim().split(/\s+/).length;
  assert.ok(call >= 2);
  assert.equal(emits.length, 1, 'client never sees the 40-word partial on its own');
  assert.ok(words(emits[0]) > 40);
  assert.equal(emits.join('').trim(), r.text.trim());
});

test('a first pass already at the floor still streams live (no hold)', async () => {
  const sentences = (n, tag) => Array.from({ length: n / 10 }, (_, i) =>
    Array.from({ length: 10 }, (_, j) => `${tag}${i}w${j}`).join(' ') + '.').join(' ');
  const stream = async (_m, onToken, _s, p) => {
    const text = sentences(120, 'c');
    for (const piece of text.match(/\S+\s*/g)) onToken(piece);
    p.onFinish('stop');
    return text;
  };
  const emits = [];
  await streamCompleteReply(stream, [{ role: 'user', content: 'hi' }], c => emits.push(c), undefined,
    { minWords: 105, maxWords: 130, targetWords: 120, maxTokens: 256, continuationMaxTokens: 160 });
  assert.ok(emits.length > 1, 'long-enough replies keep streaming');
});
