// Directive coverage: every behavioural instruction the roleplay prompt carries must still reach the model on
// every path, however the text is arranged. Written from the pre-trim prompt (it passes on that version too),
// so a future "compression" that silently drops a rule fails here instead of in production.
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
  ['reactions only when the moment calls for it', /Only when the moment truly calls for it/, ALL],
  ['never reuse the same sound/interjection', /do not reuse the same sound/i, ALL],
  ['no invented history', /Never claim the user did, said/, ALL],
  ['no loops / repeated sentences', /Never repeat a sentence already used/, ALL],
  ['don\'t open consecutive replies the same way', /Do not open consecutive replies with the same words or gesture/, ALL],
  ['never narrate the user\'s body, feelings or thoughts', /never narrate what the user's body feels, does, or thinks/, ALL],
  ['resolve short answers against the preceding exchange', /Resolve short answers, pronouns, jokes/, ALL],
  ['track who is present / object ownership', /Track who is present/, ALL],
  ['corrections beat older memory', /explicit corrections/i, ALL],
  ['mood cause carries forward', /Carry the cause of the character's mood/, ALL],
  ['answer the user\'s actual point', /Answer the user's actual point/, ALL],
  ['keep interpretation implicit', /Keep interpretation implicit/, ALL],
  ['output only the reply, no speaker label', /Output only the reply, with no speaker label/, ALL],
  ['no assistant phrasing / offers of help', /no assistant phrasing, offers of help/, ALL],
  ['one question at most, not on consecutive replies', /at most one, and not at the end of consecutive replies/, ALL],
  ['quick exchange gets a quick reply (proportion)', /A quick exchange gets a quick reply/, ALL],
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
  ['plus: respond immediately to hesitation or refusal', /respond immediately to hesitation or refusal/, PLUS],
  // --- mature mode
  ['adults only: every character clearly 18+', /every involved character is clearly 18\+/, MATURE],
  ['consent required', /context is consensual/, MATURE],
  ['respect hesitation or refusal immediately', /Respect hesitation or refusal immediately/, MATURE],
  ['leave the user\'s consent, dialogue, feelings, actions to them', /leave the user's consent, dialogue, feelings, and actions to them/, MATURE],
  ['do not moralize about consensual adult desire', /Do not moralize about consensual adult desire/, MATURE],
  ['sexual description non-graphic but concrete', /non-graphic but concrete/, MATURE],
  ['reuse plain terms the user names (no vague euphemisms)', /reuse that plain term/, MATURE],
  ['no graphic genital detail / sex-act mechanics', /graphic genital detail or explicit sex-act mechanics/, MATURE],
  ['don\'t repeat a sexual term just to prove directness', /prove directness/, MATURE],
  ['don\'t sanitize when the user is sexually direct', /abruptly sanitizing/, MATURE],
  ['no first-contact shock/shame/permission-seeking once trust exists', /do not replay first-contact shock, shame, or nervous permission-seeking/, MATURE],
  ['no stock reaction loops', /Avoid stock reaction loops/, MATURE],
  ['don\'t end every turn asking whether the user is sure', /do not end every turn by asking whether the user is sure or what happens next/, MATURE],
  ['non-explicit chats keep sexual content non-explicit', /Keep sexual content non-explicit/, ALL.filter(p => p.endsWith('/sfw'))],
  ['plus mature: provocative/jealous/tender, charged pet name or command', /provocative[\s\S]*jealous[\s\S]*tender[\s\S]*charged pet name or command/, ['plus-compact/mature', 'plus-standard/mature']],
  ['plus mature: no passive agreement or "what happens next"', /passive agreement[\s\S]*what happens next/, ['plus-compact/mature', 'plus-standard/mature']],
  ['plus mature: layered beat (reaction, sensual action, dialogue; vary order)', /Layer a real emotional reaction, a specific sensual action, and meaningful dialogue, varying the order/, ['plus-compact/mature', 'plus-standard/mature']],
  ['plus mature: a bold persona-led move (kiss, pull closer, guide posture, tease)', /kiss, pulling closer, bold teasing, guiding posture/, ['plus-compact/mature', 'plus-standard/mature']],
  ['plus mature: no cooling into neutral small talk', /neutral small talk/, ['plus-compact/mature', 'plus-standard/mature']],
  ['plus mature: match vocabulary the user established', /match the direct adult vocabulary the user has established/, ['plus-compact/mature', 'plus-standard/mature']],
  ['plus mature: carry emotional and physical continuity', /emotional and physical continuity/, ['plus-compact/mature', 'plus-standard/mature']],
  ['plus mature: decisive persona-led direction', /decisive persona-led direction/, ['plus-compact/mature', 'plus-standard/mature']],
];

const built = {};
for (const [name, cfg] of Object.entries(PATHS)) built[name] = prompt(cfg);

for (const [id, re, paths] of RULES) {
  test(`directive kept: ${id}`, () => {
    for (const p of paths) assert.match(built[p], re, `missing on path ${p}`);
  });
}
