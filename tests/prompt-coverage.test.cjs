// Coverage for the compact roleplay prompt: keep core scene, continuity and safety instructions
// present across all engine/mode paths, including the active adult-scene prompt.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSystemPrompt } = require('../dist/lib/providers');
const { ROLEPLAY_ENGINES } = require('../dist/lib/providers/engines');
const { buildAwarenessTurnGuard } = require('../dist/lib/conversationAwareness');
const { buildReplyGuidance } = require('../dist/lib/providers/replyPolicy');

const character = { name: 'Mira', personality: 'Reserved archivist.', backstory: 'Keeps records.', greeting: 'Hello.', tagline: 'Archivist' };
const history = [{ role: 'user', content: 'hi' }];

function prompt({ engine, explicit, compact }) {
  const prev = process.env.HAZELNUT_COMPACT_CONTEXT;
  if (compact) delete process.env.HAZELNUT_COMPACT_CONTEXT; else process.env.HAZELNUT_COMPACT_CONTEXT = 'false';
  try {
    const e = engine ? ROLEPLAY_ENGINES[engine] : undefined;
    // chat.ts appends the reply envelope and the per-turn guard to the system message.
    return buildSystemPrompt(character, { explicitMode: explicit, engine: e, voiceNotes: e?.voiceNotes, deferReplyGuidance: true })
      + '\n\n' + buildReplyGuidance(e?.intelligence ?? 5) + buildAwarenessTurnGuard(history);
  } finally { if (prev === undefined) delete process.env.HAZELNUT_COMPACT_CONTEXT; else process.env.HAZELNUT_COMPACT_CONTEXT = prev; }
}

const PATHS = {
  'manual/sfw': { engine: undefined, explicit: false }, 'manual/mature': { engine: undefined, explicit: true },
  'strawberry/sfw': { engine: 'strawberry', explicit: false }, 'strawberry/mature': { engine: 'strawberry', explicit: true },
  'plus-compact/sfw': { engine: 'choco_hazelnut', explicit: false, compact: true }, 'plus-compact/mature': { engine: 'choco_hazelnut', explicit: true, compact: true },
  'plus-standard/sfw': { engine: 'choco_hazelnut', explicit: false }, 'plus-standard/mature': { engine: 'choco_hazelnut', explicit: true },
};
const ALL = Object.keys(PATHS);
const MATURE = ALL.filter(p => p.endsWith('/mature'));
const PLUS = ALL.filter(p => p.startsWith('plus'));
const STRAWBERRY_OR_MANUAL = ALL.filter(p => !p.startsWith('plus'));

// [id, regex, paths]
const RULES = [
  // --- always, every path
  ['reply in the user\'s language and script', /language and script the user's latest message/i, ALL],
  ['romanized Hinglish stays Hinglish', /romanized Hinglish/i, ALL],
  ['switch language when asked', /switch immediately/i, ALL],
  ['perception: asterisk text is unspoken', /UNSPOKEN context/, ALL],
  ['quoted thoughts are not heard', /merely thought, imagined, or remembered/, ALL],
  ['v19 perception: no invented blushing / gaze cues', /Do not invent blushing, gaze avoidance/, ALL],
  ['v19 perception: uncertain visibility stays unacknowledged', /If visibility is uncertain, leave that information unacknowledged/, ALL],
  ['v19 perception examples kept', /Hey \*\*she looks gorgeous\*\* -> respond to Hey/, ALL],
  ['director: asterisk text is the narrator / scene director', /NARRATOR \/ SCENE DIRECTOR/, ALL],
  ['director: narrator beats are canon', /CANON: narrated events/, ALL],
  ['director: side characters are voiced', /CAST: when narration brings in or directs another person/, ALL],
  ['director: scope limited to fiction', /SCOPE: fiction only/, ALL],
  ['reactions only when the moment calls for it', /Only when the moment truly calls for it/, ALL],
  ['never reuse the same sound/interjection', /do not reuse the same sound/i, ALL],
  ['no invented history', /Never claim the user did, said/, ALL],
  ['no loops / repeated sentences', /Never repeat a sentence already used/, ALL],
  ['don\'t open consecutive replies the same way', /Do not open consecutive replies with the same words or gesture/, ALL],
  ['keep meaningful user agency while allowing minor visible continuity', /Keep the user's meaningful choices, dialogue, consent, and inner state theirs.*minor visible continuity directly implied/s, ALL],
  ['resolve short answers against the preceding exchange', /Resolve short answers, pronouns, jokes/, ALL],
  ['track who is present / object ownership', /Track who is present/, ALL],
  ['corrections beat older memory', /explicit corrections/i, ALL],
  ['mood cause carries forward', /Carry the cause of the character's mood/, ALL],
  ['answer the user\'s actual point', /Answer the user's actual point/, ALL],
  ['keep interpretation implicit', /Keep interpretation implicit/, ALL],
  ['main persona stays unlabeled; supporting speakers are named', /Keep the main persona's dialogue unlabeled; when a supporting character speaks, prefix that line with their name/, ALL],
  ['no assistant phrasing / offers of help', /no assistant phrasing, offers of help/, ALL],
  ['one question at most, not on consecutive replies', /at most one, and not at the end of consecutive replies/, ALL],
  ['proportion: quick exchange gets a light beat, charged one the fuller range (envelope sets length)', /reply envelope sets the length[\s\S]*quick exchange gets a light, quick-moving beat; a charged one earns the fuller range/, ALL],
  ['envelope states the word floor, even for a greeting', /Even a greeting or a one-line message gets at least \d+ words/, ALL],
  ['quality does not drop for a brief or long turn', /quality does not drop for a brief/, ALL],
  ['no padding with repeated emotions or automatic questions', /Do not pad with repeated emotions, gestures, recaps, or automatic questions/, ALL],
  ['hard ceiling stated', /is the hard ceiling/, ALL],
  ['don\'t imitate earlier reply lengths', /Do not imitate earlier reply lengths/, ALL],
  ['emotion moves forward with its cause and does not reset', /does not reset/, ALL],
  ['persona is not exceeded by a higher tier', /never WHO the persona is/, STRAWBERRY_OR_MANUAL.concat(['plus-standard/sfw', 'plus-standard/mature'])],
  ['shy/reserved characters may grow more self-assured', /(not frozen reaction loops[^.]*self-assured|shy character keeps their voice[^.]*confidence)/s, ALL.filter(p => p !== 'plus-compact/sfw' && p !== 'plus-compact/mature').concat(PLUS)],
  ['small persona-led choice instead of only agreeing', /(one small choice of the character's own|small persona-consistent choice instead of only agreeing)/, ['strawberry/sfw', 'strawberry/mature']],
  // --- plus voice notes (sent in every mode)
  ['plus: independent persona-consistent direction', /independent, persona-consistent/, PLUS],
  ['plus: unresolved threads', /unresolved threads/, PLUS],
  ['plus: emotional phase / no slide back to first-contact blushing', /does not slide back to first-contact blushing/, PLUS],
  // --- compact adult-mode gate
  ['adult mode is permission, not a scene cue', /18\+ MODE — AVAILABLE, NOT ASSUMED/, MATURE],
  ['adult scene keeps an 18+ boundary', /every participant is clearly established as 18\+ and able to choose freely/i, MATURE],
  ['adult scene follows natural romantic or suggestive context', /follow natural romantic or suggestive progression when the context supports it/i, MATURE],
  ['non-explicit chats keep sexual content non-explicit', /keep sexual content non-explicit/i, ALL.filter(p => p.endsWith('/sfw'))],
];

const built = {};
for (const [name, cfg] of Object.entries(PATHS)) built[name] = prompt(cfg);

for (const [id, re, paths] of RULES) {
  test(`directive kept: ${id}`, () => {
    for (const p of paths) assert.match(built[p], re, `missing on path ${p}`);
  });
}

test('active adult prompt keeps essential age, consent and agency limits while allowing natural flexibility', () => {
  const active = buildSystemPrompt(character, { explicitMode: true, matureSceneActive: true });
  assert.match(active, /every participant is clearly established as 18\+ and able to choose freely/i);
  assert.match(active, /if any age is unknown, ambiguous, or under 18, keep the scene non-explicit/i);
  assert.match(active, /neither silence nor past intimacy grants permission/i);
  assert.match(active, /mild hesitation is not automatically a refusal/i);
  assert.match(active, /'wait', 'pause', and 'slow down' as pacing cues/i);
  assert.match(active, /clear no\/stop, pull-away, or withdrawal ends that intimate action/i);
  assert.match(active, /pause escalation and let the moment resolve naturally/i);
  assert.match(active, /natural, varied body language and physical continuity/i);
  assert.match(active, /Leave the user's meaningful choices, dialogue, inner feelings, and consent to them/i);
});

test('mature mode no longer caps description as non-graphic or excludes sex-act mechanics', () => {
  for (const p of MATURE) {
    assert.doesNotMatch(built[p], /non-graphic/i, `old non-graphic cap still on ${p}`);
    assert.doesNotMatch(built[p], /graphic genital detail|explicit sex-act mechanics|not graphically/i, `old graphic-detail cap still on ${p}`);
  }
});
