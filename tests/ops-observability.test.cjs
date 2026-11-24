const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeDbError, createDbFailureLogger } = require('../dist/lib/dbFailureLog');
const { noteReplyForWindow, formatReplyWindow } = require('../dist/lib/providers/tokenStats');
const { buildReplyGuidance, planReply } = require('../dist/lib/providers/replyPolicy');

const prismaError = Object.assign(new Error("\nInvalid `prisma.$queryRaw()` invocation:\n\n\nCan't reach database server at `gateway01.example.com:4000`\n\nPlease make sure your database server is running at `gateway01.example.com:4000`."), { code: 'P1001' });

test('a Prisma connection error is summarised to one short line with its code', () => {
  const line = summarizeDbError(prismaError);
  assert.equal(line.includes('\n'), false);
  assert.match(line, /^P1001: Can't reach database server at/);
  assert.doesNotMatch(line, /Invalid `prisma/);
  assert.equal(summarizeDbError('plain string failure'), 'plain string failure');
  assert.ok(summarizeDbError(new Error('x'.repeat(2000))).length <= 300);
});

test('repeated database failures are logged once per interval with a count, and recovery is announced', () => {
  const out = []; let t = 1000;
  const log = createDbFailureLogger({ log: l => out.push(l), now: () => t, intervalMs: 60_000 });
  log.failed(prismaError);
  for (let i = 0; i < 4; i++) { t += 5000; log.failed(prismaError); }
  assert.equal(out.length, 1, 'five failures inside one minute produce one line');
  t += 60_000; log.failed(prismaError);
  assert.equal(out.length, 2);
  assert.match(out[1], /4 more failed checks/);
  log.ok();
  assert.match(out[2], /reachable again/);
  log.ok();
  assert.equal(out.length, 3, 'a healthy check after recovery stays silent');
});

test('the per-reply window shows the real input cost and the top-up rate', () => {
  const w = { replies: 0, withContinuation: 0, promptTokens: 0, completionTokens: 0, incomplete: 0 };
  assert.equal(formatReplyWindow(w), undefined, 'nothing is printed for an empty window');
  const base = { engine: 'choco_hazelnut', kind: 'reply', attempts: 2, reportedCalls: 2, promptTokens: 7000, completionTokens: 180, cachedTokens: 0 };
  noteReplyForWindow({ ...base, continuations: 1 }, true, w);
  noteReplyForWindow({ ...base, promptTokens: 3500, completionTokens: 120, attempts: 1, reportedCalls: 1, continuations: 0 }, true, w);
  noteReplyForWindow({ ...base, kind: 'memory', continuations: 0 }, true, w);
  noteReplyForWindow({ ...base, promptTokens: 3400, continuations: 1 }, false, w);
  assert.equal(w.replies, 3, 'memory calls are not replies');
  const line = formatReplyWindow(w);
  assert.match(line, /replies: 3 \| with top-up\/continuation: 2 \(67%\)/);
  assert.match(line, /avg input per reply: 4633/);
  assert.match(line, /1 with unreported calls/);
});

test('the envelope states the word floor outside the adaptive arm, and not inside it', () => {
  assert.match(buildReplyGuidance(10, 'normal', false), /Even a greeting or a one-line message gets at least 105 words/);
  assert.match(buildReplyGuidance(7, 'normal', false), /gets at least 50 words/);
  assert.doesNotMatch(buildReplyGuidance(10, 'rapid', true), /Even a greeting/, 'relaxed floor keeps its own wording');
  assert.doesNotMatch(buildReplyGuidance(10, 'rapid', false), /turn is brief/, 'control arm still never suggests a smaller reply');
  // The server-side floor and ceiling are unchanged.
  const plan = planReply(10, 'hi', '', { adaptiveRhythm: false });
  assert.equal(plan.minWords, 105); assert.equal(plan.maxWords, 130); assert.equal(plan.maxTokens, 256);
});
