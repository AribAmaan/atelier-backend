const test = require('node:test');
const assert = require('node:assert/strict');
const { selectHazelnutContext, hazelnutMinHistoryTokens } = require('../dist/lib/hazelnutContext');

const words = (n, w) => Array.from({ length: n }, (_, i) => `${w}${i % 7}`).join(' ');
const chat = turns => Array.from({ length: turns }).flatMap((_, i) => [
  { id: `u${i}`, role: 'user', content: words(12, 'user') },
  { id: `a${i}`, role: 'assistant', content: words(135, 'reply') },
]);

test('a persona bigger than the target used to leave only the last 3 exchanges', () => {
  const r = selectHazelnutContext({ history: chat(20), query: 'x', systemTokens: 4600 });
  assert.equal(r.messages.length, 6);
});

test('minHistoryTokens keeps more recent exchanges even when the system prompt overflows the target', () => {
  const r = selectHazelnutContext({ history: chat(20), query: 'x', systemTokens: 4600, minHistoryTokens: 1500 });
  assert.ok(r.messages.length >= 12 && r.messages.length <= 18, `kept ${r.messages.length}`);
  assert.equal(r.messages[0].role, 'user', 'never starts on a dangling assistant reply');
});

test('the floor never trims below the protected last three exchanges', () => {
  const r = selectHazelnutContext({ history: chat(3), query: 'x', systemTokens: 4600, minHistoryTokens: 1500 });
  assert.equal(r.messages.length, 6);
});

test('HAZELNUT_MIN_HISTORY_TOKENS: default, override, and 0 to switch it off', () => {
  const old = process.env.HAZELNUT_MIN_HISTORY_TOKENS;
  try {
    delete process.env.HAZELNUT_MIN_HISTORY_TOKENS; assert.equal(hazelnutMinHistoryTokens(), 1500);
    process.env.HAZELNUT_MIN_HISTORY_TOKENS = '0'; assert.equal(hazelnutMinHistoryTokens(), 0);
    process.env.HAZELNUT_MIN_HISTORY_TOKENS = '2500'; assert.equal(hazelnutMinHistoryTokens(), 2500);
    process.env.HAZELNUT_MIN_HISTORY_TOKENS = 'abc'; assert.equal(hazelnutMinHistoryTokens(), 1500);
    process.env.HAZELNUT_MIN_HISTORY_TOKENS = '99999'; assert.equal(hazelnutMinHistoryTokens(), 1500);
  } finally { old === undefined ? delete process.env.HAZELNUT_MIN_HISTORY_TOKENS : (process.env.HAZELNUT_MIN_HISTORY_TOKENS = old); }
});
