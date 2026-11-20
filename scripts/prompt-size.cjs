// Usage: npm run build && npm run report:prompt
// Prints the estimated size of each fixed prompt block and of the whole fixed prompt per engine/mode, using the
// repo's own (conservative, about 1.6x real) estimator. Real usage is in the [tokens] and [turn-usage] log lines.
const { buildSystemPrompt } = require('../dist/lib/providers');
const { ROLEPLAY_ENGINES } = require('../dist/lib/providers/engines');
const { ROLEPLAY_CRAFT_RULES, craftDepthLine } = require('../dist/lib/providers/roleplayCraft');
const { ROLEPLAY_INPUT_RULES } = require('../dist/lib/roleplayInput');
const { CONVERSATION_AWARENESS_RULES, buildAwarenessTurnGuard } = require('../dist/lib/conversationAwareness');
const { buildReplyGuidance } = require('../dist/lib/providers/replyPolicy');
const { buildRecencyAnchor } = require('../dist/lib/providers/recencyAnchor');
const { estimateTokens } = require('../dist/lib/hazelnutContext');

const character = { name: 'Mira', personality: 'Reserved archivist who hides warmth behind dry humor.', backstory: 'Keeps the records of a coastal town.', greeting: 'The reading room is closed.', tagline: 'Archivist' };
const rows = {
  'craft rules': ROLEPLAY_CRAFT_RULES, 'input (narration) rules': ROLEPLAY_INPUT_RULES, 'awareness rules': CONVERSATION_AWARENESS_RULES,
  'depth line (plus)': craftDepthLine(10), 'voice notes (strawberry)': ROLEPLAY_ENGINES.strawberry.voiceNotes, 'voice notes (plus)': ROLEPLAY_ENGINES.choco_hazelnut.voiceNotes,
  'reply envelope (plus)': buildReplyGuidance(10), 'per-turn focus guard': buildAwarenessTurnGuard([{ role: 'user', content: 'hi' }]), 'persona anchor': buildRecencyAnchor(character),
};
console.log('Estimated tokens per fixed block');
for (const [k, v] of Object.entries(rows)) console.log(`  ${k.padEnd(26)} ${String(estimateTokens(v)).padStart(5)}`);
console.log('\nEstimated tokens, whole fixed prompt (system + envelope + guard + anchor), small fixture');
for (const [id, explicit, compact] of [['strawberry', false, true], ['strawberry', true, true], ['choco_hazelnut', false, true], ['choco_hazelnut', true, true], ['choco_hazelnut', true, false]]) {
  if (compact) delete process.env.HAZELNUT_COMPACT_CONTEXT; else process.env.HAZELNUT_COMPACT_CONTEXT = 'false';
  const e = ROLEPLAY_ENGINES[id];
  const t = buildSystemPrompt(character, { explicitMode: explicit, engine: e, voiceNotes: e.voiceNotes, deferReplyGuidance: true }) + '\n\n' + buildReplyGuidance(e.intelligence) + buildAwarenessTurnGuard([{ role: 'user', content: 'hi' }]) + '\n' + buildRecencyAnchor(character);
  console.log(`  ${(id + (explicit ? ' mature' : ' sfw') + (compact ? '' : ' (standard ctx)')).padEnd(34)} ${String(estimateTokens(t)).padStart(5)}`);
}
