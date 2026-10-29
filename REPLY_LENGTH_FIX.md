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

## Follow-up: personality and actions restored (replies had become plain text)
After the word cap was removed, short replies turned into bare dialogue ("Amy? I don't know anyone by that name.") with no action and
no personality. Cause: my light-turn hint said "one to three short sentences, sometimes just a line of dialogue", the guidance banned
"gestures and scenery", and the voice notes said an action only when it changes the moment. The old 105-130 word range and "full depth every
turn" notes were what had been producing the descriptive style.

Fix (still no word minimum or maximum, no padding pass, no trimming):
- `replyPolicy.ts`: the guidance now says to write like a roleplay partner, not a chatbot: dialogue plus a brief *action, expression,
  body language or sensory detail*, even in short replies, and never bare plain words. Light turns are "two to four sentences, a small
  action plus a line or two of dialogue"; normal turns a short paragraph; heavy or scene-setting turns fuller. Padding, repeated gestures,
  recaps and tacked-on questions are still ruled out.
- `index.ts` / `engines.ts`: removed "dialogue can stand alone" and "an action only when it changes the moment"; both engines' voice notes
  now ask for a small visible action or expression and the character's own voice.
- `roleplayInput.ts`: new STORY PREMISE rule, and the cast guard no longer lets the model say it has never heard of a person the user
  mentions (this caused the "I don't know anyone by that name" reply when the user said "wheres amy mom").
- Tests: 102 pass (2 new: roleplay texture is always requested; mentioned people are never denied).

Length is still steered by prompt only, so a weak model can still run plain or long. If so, tell me which model and what it wrote.
