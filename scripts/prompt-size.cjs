// Usage: npm run build && npm run report:prompt
// Prints the estimated size of the fixed prompt per engine/mode, using the repo's own (conservative, about 1.6x real) estimator.
const { buildSystemPrompt } = require('../dist/lib/providers');
const { ROLEPLAY_ENGINES } = require('../dist/lib/providers/engines');
const { ROLEPLAY_INPUT_RULES } = require('../dist/lib/roleplayInput');
const { LANGUAGE_RULE } = require('../dist/lib/conversationAwareness');
const { estimateTokens } = require('../dist/lib/hazelnutContext');

const character = { name: 'Mira', personality: 'Reserved archivist who hides warmth behind dry humor.', backstory: 'Keeps the records of a coastal town.', greeting: 'The reading room is closed.', tagline: 'Archivist' };
console.log('Estimated tokens per fixed block');
for (const [k, v] of Object.entries({ 'narrator / director / input rules': ROLEPLAY_INPUT_RULES, 'language rule': LANGUAGE_RULE }))
  console.log(`  ${k.padEnd(36)} ${String(estimateTokens(v)).padStart(5)}`);
console.log('\nEstimated tokens, whole system prompt, small fixture');
for (const [id, explicit] of [['strawberry', false], ['strawberry', true], ['choco_hazelnut', false], ['choco_hazelnut', true]]) {
  const e = ROLEPLAY_ENGINES[id];
  const t = buildSystemPrompt(character, { explicitMode: explicit, engine: e, voiceNotes: e.voiceNotes });
  console.log(`  ${(id + (explicit ? ' mature' : ' sfw')).padEnd(36)} ${String(estimateTokens(t)).padStart(5)}`);
}
