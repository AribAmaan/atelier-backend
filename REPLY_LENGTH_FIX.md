# Reply length follows the context (no word cap)

**Problem:** every reply was forced into a word band (Vanilla 45-70, Hazelnut 105-130). `completeReply.ts` also ran a
"top-up" pass that asked the model for extra sentences whenever a reply came in under the minimum, so a greeting
got padded into a paragraph (and that pass is what produced doubled replies in an earlier bug). Replies were also
trimmed to the maximum after generation, and the prompt told the model to ignore how big the user's message was.

**Change:**
- No word minimum, maximum, target or ceiling anywhere. `clampReplyToWordCeiling`, the depth top-up and the
  sentence-buffered streaming are gone; text now streams straight from the provider and is saved as produced.
- `replyPolicy.ts`: `classifyTurn` reads the user's latest turn (light: a few words; normal; heavy: long or several
  paragraphs, or a scene steer) and `buildReplyGuidance` tells the model to size the reply to it: banter gets a line or
  two, an emotional or scene-setting turn gets more, "make it shorter/longer" is honoured, stop when the beat is done,
  no padding, recaps, stacked gestures or tacked-on questions, never copy earlier reply lengths. This is guidance only.
- Token ceiling is a runaway guard, not a target: Vanilla 400, Hazelnut 600. If a provider ever hits it, the existing
  same-provider continuation (max 2, 160 tokens each) finishes the sentence so it is not left cut off.
- Prompt wording that forced depth/length was removed (engine voice notes, behavior block, persona reminder,
  "fixed reply envelope", "tier-locked", a leaked "Hazelnut expresses..." line that also appeared in Vanilla prompts, a
  stale "Supreme delivery" label).
- Engines now differ in voice, initiative, memory and sampling, not in allowed length.

**Honest limits:** length is steered by prompt, so a weak model can still ramble or run short. The 400/600 ceiling
catches only extreme cases. If a specific model still over-writes, tell me which one and I can tighten the wording for it.

Tests: `narration`, `chat-awareness`, `reply-repeat` updated; 95 tests pass (run per-file and together).
