// Token budget for the fixed prompt (system prompt + reply envelope + per-turn guard + persona anchor) on a
// small fixture, measured with the repo's own conservative estimator (about 1.6x the real BPE count).
// The fixed prompt grew roughly 1.8x in five weeks without anyone deciding that; this makes growth a decision. If you add a rule
// on purpose, raise the budget in the same change AND say what it buys. Prefer removing a duplicate first.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSystemPrompt } = require('../dist/lib/providers');
const { ROLEPLAY_ENGINES } = require('../dist/lib/providers/engines');
const { buildAwarenessTurnGuard } = require('../dist/lib/conversationAwareness');
const { buildReplyGuidance } = require('../dist/lib/providers/replyPolicy');
const { buildRecencyAnchor } = require('../dist/lib/providers/recencyAnchor');
const { estimateTokens } = require('../dist/lib/hazelnutContext');

const character = { name: 'Mira', personality: 'Reserved archivist who hides warmth behind dry humor.', backstory: 'Keeps the records of a coastal town.', greeting: 'The reading room is closed.', tagline: 'Archivist' };
const BUDGETS = [
  ['strawberry', false, true, 3700], ['strawberry', true, true, 4350],
  ['choco_hazelnut', false, true, 3850], ['choco_hazelnut', true, true, 4650], ['choco_hazelnut', true, false, 5000],
];
for (const [engineId, explicit, compact, budget] of BUDGETS) {
  test(`fixed prompt stays within ${budget} estimated tokens: ${engineId} ${explicit ? 'mature' : 'sfw'} ${compact ? 'compact' : 'standard'}`, () => {
    const prev = process.env.HAZELNUT_COMPACT_CONTEXT;
    if (compact) delete process.env.HAZELNUT_COMPACT_CONTEXT; else process.env.HAZELNUT_COMPACT_CONTEXT = 'false';
    try {
      const e = ROLEPLAY_ENGINES[engineId];
      const text = buildSystemPrompt(character, { explicitMode: explicit, engine: e, voiceNotes: e.voiceNotes, deferReplyGuidance: true })
        + '\n\n' + buildReplyGuidance(e.intelligence) + buildAwarenessTurnGuard([{ role: 'user', content: 'hi' }]) + '\n' + buildRecencyAnchor(character);
      const used = estimateTokens(text);
      assert.ok(used <= budget, `${used} > ${budget}: the fixed prompt grew; remove a duplicate or raise the budget on purpose`);
    } finally { if (prev === undefined) delete process.env.HAZELNUT_COMPACT_CONTEXT; else process.env.HAZELNUT_COMPACT_CONTEXT = prev; }
  });
}
