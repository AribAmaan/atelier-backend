const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { measureReply, measureTranscript, driftReport } = require('../dist/lib/providers/replyMetrics');
const { buildReplyTelemetry, logReplyTelemetry, pseudonym, TELEMETRY_TAG } = require('../dist/lib/replyTelemetry');
const { buildRecencyAnchor, insertTailSystemMessage } = require('../dist/lib/providers/recencyAnchor');
const { planTurnSteers } = require('../dist/lib/providers/turnDirector');
const { parseFlag } = require('../dist/lib/roleplayFlags');
const { parseTelemetryLines, analyzeTelemetry, normalCdf, twoProportionTest, renderReport } = require('../dist/lib/roleplayReport');

const ROOT = path.join(__dirname, '..');
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b}`);

// ------------------------------------------------------------------ metrics
test('measureReply counts form only', () => {
  const m = measureReply('*She smirks.* Come in. How can I help you today? Feel free to sit. What do you want?');
  assert.equal(m.actions, 1);
  assert.equal(m.opensAction, true);
  assert.equal(m.endsQuestion, true);
  assert.equal(m.assistantisms, 2);
  assert.equal(m.tics, 1);
  assert.equal(m.words, 18);
  const plain = measureReply('The rain keeps on. I should close the window.');
  assert.deepEqual([plain.actions, plain.assistantisms, plain.tics, plain.endsQuestion, plain.opensAction], [0, 0, 0, false, false]);
});

test('measureTranscript: empty and tiny inputs are safe', () => {
  for (const input of [[], [''], ['   '], ['one reply only here']]) {
    const t = measureTranscript(input);
    for (const v of Object.values(t)) assert.ok(Number.isFinite(v));
  }
  assert.equal(measureTranscript([]).replies, 0);
});

test('measureTranscript: near-identical adjacent replies and recycled phrases are detected', () => {
  const same = Array.from({ length: 6 }, () => '*She smirks.* Sit down by the window and drink your tea before it gets cold.');
  const t = measureTranscript(same);
  assert.equal(t.repeatAdjacentRate, 1);
  assert.ok(t.repeatedPhraseRate > 0.7);
  assert.ok(t.ticRate === 1);
  const varied = ['The kettle clicks off.', 'Outside, a gull argues with the wind about something.', '*He pulls the ledger closer.* Tuesday, then.',
    'Not tonight. My knee has opinions about the stairs.', 'A shutter bangs somewhere down the lane.', 'Fine. Show me the map, but gently.'];
  const v = measureTranscript(varied);
  assert.equal(v.repeatAdjacentRate, 0);
  assert.equal(v.repeatedPhraseRate, 0);
  assert.ok(v.openingDiversity > 0.8);
});

test('driftReport: needs six replies; shows drift toward assistant phrasing and repetition, and no false alarm on a healthy chat', () => {
  assert.equal(driftReport(['a b c', 'd e f', 'g h i']), null);
  const healthy = ['The kettle clicks off.', 'Outside, a gull argues with the wind.', '*He pulls the ledger closer.* Tuesday, then.',
    'Not tonight. My knee has opinions about the stairs.', 'A shutter bangs somewhere down the lane.', 'Fine. Show me the map, but gently.',
    'You always do this, hiding behind a joke.', '*She laughs, once, surprised.* Maybe I do.', 'Rain again. The harbor smells of tar.',
    'Ask Tomas about the lamp. He broke it.'];
  const calm = driftReport(healthy);
  assert.ok(calm.delta.assistantismRate === 0 && calm.delta.repeatAdjacentRate === 0);

  const drifting = [
    ...healthy.slice(0, 5),
    "I'm here to help you with that. Feel free to ask me anything else you need today.",
    "I'm here to help you with that. Feel free to ask me anything else you need today.",
    "As an AI, I understand your concern. Is there anything else I can help with?",
    "I'm here to help you with that. Feel free to ask me anything else you need today.",
    "I apologize for the confusion. Feel free to ask me anything else you need today.",
  ];
  const bad = driftReport(drifting);
  assert.equal(bad.windowSize, 5);
  assert.ok(bad.delta.assistantismRate >= 0.99, 'late window is assistant-like');
  near(bad.delta.repeatAdjacentRate, 0.25, 1e-9, 'one identical adjacent pair out of four');
  near(bad.delta.repeatedPhraseRate, 0.5, 1e-9);
  assert.ok(bad.delta.openingDiversity < 0);
});

// ---------------------------------------------------------------- telemetry
const ARMS = { adaptiveRhythm: false, director: true, actionCap: false, personaAnchor: true };
const base = { userId: 'owner-user-id-123', characterId: 'char-secret-id-456', engineId: 'choco_hazelnut', intelligence: 10, arms: ARMS, beat: 'normal', steerIds: ['retire'], turn: 12 };

test('telemetry has no message text and no raw ids', () => {
  const reply = '*She smirks.* Umbrella secrets stay in the lighthouse, Marguerite.';
  const t = buildReplyTelemetry({ ...base, reply }, new Date('2026-11-02T10:00:00Z'));
  const json = JSON.stringify(t);
  for (const leaked of ['Umbrella', 'lighthouse', 'Marguerite', 'owner-user-id-123', 'char-secret-id-456']) assert.ok(!json.includes(leaked), leaked);
  assert.equal(t.uh, pseudonym('owner-user-id-123'));
  assert.equal(t.uh.length, 12);
  assert.equal(t.ts, '2026-11-02T10:00:00.000Z');
  assert.deepEqual([t.words, t.actions, t.tics, t.turn, t.steers], [9, 1, 1, 12, ['retire']]);
});

test('pseudonyms are stable, differ per id, and change with the salt', () => {
  const prev = process.env.ROLEPLAY_TELEMETRY_SALT;
  try {
    delete process.env.ROLEPLAY_TELEMETRY_SALT;
    const a = pseudonym('u1'), b = pseudonym('u2');
    assert.equal(a, pseudonym('u1'));
    assert.notEqual(a, b);
    process.env.ROLEPLAY_TELEMETRY_SALT = 'rotated';
    assert.notEqual(pseudonym('u1'), a, 'rotating the salt unlinks earlier records');
  } finally { if (prev === undefined) delete process.env.ROLEPLAY_TELEMETRY_SALT; else process.env.ROLEPLAY_TELEMETRY_SALT = prev; }
});

test('logReplyTelemetry: one tagged JSON line; ROLEPLAY_TELEMETRY=off is silent; it can never throw', () => {
  const lines = [];
  const orig = console.log;
  const prev = process.env.ROLEPLAY_TELEMETRY;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    delete process.env.ROLEPLAY_TELEMETRY;
    logReplyTelemetry({ ...base, reply: 'Hello there, friend.' });
    assert.equal(lines.length, 1);
    assert.ok(lines[0].startsWith(TELEMETRY_TAG + ' {'));
    JSON.parse(lines[0].slice(TELEMETRY_TAG.length + 1));
    process.env.ROLEPLAY_TELEMETRY = 'off';
    logReplyTelemetry({ ...base, reply: 'Hello again.' });
    assert.equal(lines.length, 1);
    delete process.env.ROLEPLAY_TELEMETRY;
    assert.doesNotThrow(() => logReplyTelemetry({ ...base, arms: undefined, reply: undefined, turn: NaN }));
  } finally { console.log = orig; if (prev === undefined) delete process.env.ROLEPLAY_TELEMETRY; else process.env.ROLEPLAY_TELEMETRY = prev; }
});

// --------------------------------------------------------------- statistics
test('normalCdf and the two-proportion test match independently computed values', () => {
  near(normalCdf(0), 0.5, 1e-7);
  near(normalCdf(1.959964), 0.975, 1e-5);
  near(normalCdf(-1.0), 0.158655, 1e-5);
  const t = twoProportionTest(50, 100, 40, 100);
  // pooled p = .45, se = sqrt(.45 * .55 * (1/100 + 1/100)); z = .10 / se
  const z = 0.10 / Math.sqrt(0.45 * 0.55 * 0.02);
  near(t.z, z, 1e-9);
  near(t.z, 1.4213, 1e-3);
  near(t.p, 0.1552, 2e-3);
  near(twoProportionTest(60, 100, 40, 100).p, 0.0047, 1e-3);
  assert.equal(twoProportionTest(0, 0, 5, 10), null, 'empty arm');
  assert.equal(twoProportionTest(0, 100, 0, 100), null, 'no variation at all');
  assert.equal(twoProportionTest(100, 100, 100, 100), null);
  assert.equal(twoProportionTest(5, 10, 5, 10).diff, 0);
});

// ------------------------------------------------------------------- report
const BASE_DAY = 20400;
const at = (day, hour = 10) => new Date((BASE_DAY + day) * 86400000 + hour * 3600000).toISOString();
const ev = (uh, day, arms, extra = {}) => ({ v: 1, ts: at(day), uh, ch: 'c', engine: 'choco_hazelnut', tier: 10, arms, beat: 'normal', steers: [], turn: 5,
  words: 100, actions: 1, endsQuestion: false, assistantisms: 0, tics: 0, ...extra });

function syntheticCohort() {
  const events = [];
  for (let k = 0; k < 200; k++) {
    for (const on of [true, false]) {
      const uh = `${on ? 'on' : 'off'}-${k}`;
      const arms = { adaptiveRhythm: on, director: true, actionCap: false, personaAnchor: true };
      const extra = { words: on ? 80 : 120, steers: on ? ['brief_beat'] : [] };
      events.push(ev(uh, 0, arms, extra));
      const r = k % 10;
      if (r < (on ? 6 : 4)) events.push(ev(uh, 1, arms, extra));           // returned the next day
      else if (r < (on ? 8 : 5)) events.push(ev(uh, 3, arms, extra));      // returned later in the week
    }
  }
  // The final, partial day, and a user too recent to evaluate.
  const lateArms = { adaptiveRhythm: true, director: true, actionCap: false, personaAnchor: true };
  events.push(ev('late-user', 9, lateArms, { words: 80, steers: ['brief_beat'] }), ev('late-user', 10, lateArms, { words: 80, steers: ['brief_beat'] }));
  return events;
}

test('report recovers known retention, ignores users whose window is unfinished, and attaches arm statistics', () => {
  const reports = analyzeTelemetry(syntheticCohort());
  const r = reports.find(x => x.flag === 'adaptiveRhythm');
  assert.equal(r.returnNextDay.onN, 200, 'late-user excluded: window not elapsed');
  assert.equal(r.returnNextDay.offN, 200);
  near(r.returnNextDay.onRate, 0.6, 1e-9);
  near(r.returnNextDay.offRate, 0.4, 1e-9);
  near(r.returnWithin7d.onRate, 0.8, 1e-9);
  near(r.returnWithin7d.offRate, 0.5, 1e-9);
  assert.ok(r.returnNextDay.p < 0.001 && r.returnNextDay.z > 0);
  assert.equal(r.on.users, 201);
  assert.equal(r.off.users, 200);
  near(r.on.meanWords, 80, 1e-9);
  near(r.off.meanWords, 120, 1e-9);
  assert.ok(r.on.steerRates.brief_beat > 0.99);
  assert.equal(r.off.steerRates.brief_beat, undefined);
  assert.deepEqual(r.warnings, []);
});

test('report warns when a flag is not split or arms are too small, instead of inventing a finding', () => {
  const reports = analyzeTelemetry(syntheticCohort());
  const director = reports.find(x => x.flag === 'director');
  assert.equal(director.off.users, 0);
  assert.match(director.warnings.join(' '), /not split/);
  assert.equal(director.returnNextDay, null);
  const tiny = [];
  for (let k = 0; k < 10; k++) for (const on of [true, false]) {
    const arms = { adaptiveRhythm: on, director: true, actionCap: false, personaAnchor: true };
    tiny.push(ev(`${on}-${k}`, 0, arms), ev(`${on}-${k}`, 1, arms));
  }
  tiny.push(ev('z', 12, { adaptiveRhythm: false, director: true, actionCap: false, personaAnchor: true }));
  const small = analyzeTelemetry(tiny).find(x => x.flag === 'adaptiveRhythm');
  assert.match(small.warnings.join(' '), /treat any difference as noise/);
});

test('a user belongs to the arm they were first seen in, even if the environment later changes', () => {
  const events = [
    ev('u', 0, { adaptiveRhythm: true, director: true, actionCap: false, personaAnchor: true }),
    ev('u', 1, { adaptiveRhythm: false, director: true, actionCap: false, personaAnchor: true }),
    ev('last', 12, { adaptiveRhythm: false, director: true, actionCap: false, personaAnchor: true }),
  ];
  const r = analyzeTelemetry(events).find(x => x.flag === 'adaptiveRhythm');
  assert.equal(r.on.users, 1);
  assert.equal(r.on.replies, 2, 'both of u\'s replies count under the arm u started in');
});

test('drift by conversation turn: the persona-anchor arms are compared per bucket', () => {
  const on = { adaptiveRhythm: false, director: true, actionCap: false, personaAnchor: true };
  const off = { ...on, personaAnchor: false };
  const events = [];
  for (let i = 0; i < 40; i++) {
    events.push(ev(`a${i}`, 0, on, { turn: 120, assistantisms: 0 }), ev(`b${i}`, 0, off, { turn: 120, assistantisms: i % 4 === 0 ? 1 : 0 }));
    events.push(ev(`a${i}`, 0, on, { turn: 5 }), ev(`b${i}`, 0, off, { turn: 5 }));
  }
  const r = analyzeTelemetry(events).find(x => x.flag === 'personaAnchor');
  const late = i => r.byTurn[i].find(b => b.bucket === '100+');
  assert.equal(late('on').assistantismRate, 0);
  near(late('off').assistantismRate, 0.25, 1e-9);
  assert.equal(r.byTurn.off.find(b => b.bucket === '0-19').assistantismRate, 0);
  assert.match(renderReport([r], events.length), /assistant-isms by conversation turn/);
});

test('parseTelemetryLines: finds tagged lines inside log prefixes, skips junk, truncation and bad fields', () => {
  const good = JSON.stringify(ev('u1', 0, ARMS));
  const text = [
    `2026-11-01T10:00:00Z app[web] ${TELEMETRY_TAG} ${good}`,
    'just some other log line',
    `${TELEMETRY_TAG} {"v":1,"uh":"cut off`,
    `${TELEMETRY_TAG} not json`,
    `${TELEMETRY_TAG}`,
    `${TELEMETRY_TAG} ${JSON.stringify({ ...ev('u2', 0, ARMS), v: 2 })}`,
    `${TELEMETRY_TAG} ${JSON.stringify({ ...ev('u3', 0, ARMS), ts: 'garbage' })}`,
    `${TELEMETRY_TAG} ${JSON.stringify({ ...ev('', 0, ARMS) })}`,
    `${TELEMETRY_TAG} ${good}`,
  ].join('\r\n');
  const parsed = parseTelemetryLines(text);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].uh, 'u1');
  assert.deepEqual(analyzeTelemetry([]).map(r => r.on.users + r.off.users), [0, 0, 0, 0]);
});

// ------------------------------------------------------------------ scripts
test('scripts: roleplay-report and drift-report run end to end and fail loudly on bad input', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-'));
  const log = path.join(dir, 'logs.txt');
  fs.writeFileSync(log, syntheticCohort().map(e => `${TELEMETRY_TAG} ${JSON.stringify(e)}`).join('\n'));
  const ok = spawnSync('node', [path.join(ROOT, 'scripts/roleplay-report.cjs'), log], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /== adaptiveRhythm ==/);
  assert.match(ok.stdout, /return next day\s+on 60\.0% \(n=200\) vs off 40\.0% \(n=200\)/);
  const json = spawnSync('node', [path.join(ROOT, 'scripts/roleplay-report.cjs'), log, '--json'], { encoding: 'utf8' });
  assert.equal(JSON.parse(json.stdout).length, 4);
  const empty = path.join(dir, 'empty.txt'); fs.writeFileSync(empty, 'nothing relevant\n');
  const none = spawnSync('node', [path.join(ROOT, 'scripts/roleplay-report.cjs'), empty], { encoding: 'utf8' });
  assert.equal(none.status, 1);
  assert.match(none.stderr, /No \[roleplay-telemetry\] lines/);
  assert.equal(spawnSync('node', [path.join(ROOT, 'scripts/roleplay-report.cjs')], { encoding: 'utf8' }).status, 2);

  const chat = path.join(dir, 'chat.json');
  const msgs = [];
  for (let i = 0; i < 12; i++) msgs.push({ role: 'user', content: `u${i}` }, { role: 'assistant', content: i < 6 ? `Varied reply number ${i} about ${['rain', 'tea', 'maps', 'lamps', 'gulls', 'keys'][i]}.` : "I'm here to help you. Feel free to ask me anything else." });
  fs.writeFileSync(chat, JSON.stringify(msgs));
  const drift = spawnSync('node', [path.join(ROOT, 'scripts/drift-report.cjs'), chat, '--name', 'Mira'], { encoding: 'utf8' });
  assert.equal(drift.status, 0, drift.stderr);
  assert.match(drift.stdout, /assistant-isms\s+0\.0%\s+100\.0%\s+\+100\.0 pts/);
  fs.writeFileSync(chat, JSON.stringify([{ role: 'assistant', content: 'only one' }]));
  assert.equal(spawnSync('node', [path.join(ROOT, 'scripts/drift-report.cjs'), chat], { encoding: 'utf8' }).status, 1);
});

// ------------------------------------------------------------------- fuzz
test('seeded fuzz over the new untrusted-input paths: anchor, steers, log parser, metrics, flags, telemetry', () => {
  let seed = 777;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const pick = a => a[Math.floor(rnd() * a.length)];
  const atoms = ['*', '**', '"', '\\', '{', '}', ':', ',', '[', ']', '\n', ' ', 'Mira', 'you shiver', 'smirk', '?', '!', '.', '[roleplay-telemetry] ',
    '{"v":1,"uh":"x"', '\u0000', '\u4f60\u597d', '\u0905', '$&', '__proto__', 'constructor', 'null', 'NaN', '1e999', 'split:50', 'on', '\u202e'];
  const gen = () => Array.from({ length: Math.floor(rnd() * 30) }, () => pick(atoms)).join('');
  for (let i = 0; i < 3000; i++) {
    const s = gen(), t = gen();
    const anchor = buildRecencyAnchor({ name: s, personality: t });
    const json = anchor.match(/\{.*\}(?=\. Stay)/);
    assert.ok(json, 'anchor keeps its shape');
    assert.doesNotThrow(() => JSON.parse(json[0]), 'quoted fields always parse back as data');
    const m = [{ role: 'system', content: 'p' }, { role: pick(['user', 'assistant']), content: t }];
    insertTailSystemMessage(m, anchor); insertTailSystemMessage(m, anchor);
    assert.equal(m.length, 3, 'inserted exactly once');
    planTurnSteers({ history: [{ role: 'user', content: s }, { role: 'assistant', content: t }, { role: 'assistant', content: s }, { role: 'user', content: t }],
      latestUserText: s, characterName: t, adaptiveRhythm: rnd() < .5, actionCap: rnd() < .5 });
    parseTelemetryLines(`${s}\n${t}\n[roleplay-telemetry] ${s}`);
    measureTranscript([s, t, s, t, s, t, s]); driftReport([s, t, s, t, s, t, s, t], s);
    assert.equal(typeof parseFlag(s, true, 'f', t), 'boolean');
  }
  for (const [a, b, c, d] of [[0, 1, 0, 1], [1, 1, 1, 1], [1, 2, 1, 2], [5, 5, 0, 5], [1e9, 2e9, 1e9, 2e9], [0, 0, 0, 0]]) {
    const r = twoProportionTest(a, b, c, d);
    if (r) for (const v of [r.z, r.p, r.diff]) assert.ok(Number.isFinite(v));
  }
  const garbage = buildReplyTelemetry({ userId: undefined, characterId: null, engineId: 5, intelligence: 'x', arms: {}, beat: {}, steerIds: 'no', turn: 'a', reply: 12 });
  assert.equal(garbage.turn, 0);
  assert.equal(garbage.tier, 0);
  assert.deepEqual(garbage.steers, []);
  assert.equal(garbage.words, 0);
});
