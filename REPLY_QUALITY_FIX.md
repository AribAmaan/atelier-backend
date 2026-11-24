# Reply quality fix: repeated text, looping lines, language switching

## What was wrong (seen in a real chat)
1. **Reply printed twice.** When a reply came out shorter than its tier minimum, the
   "depth top-up" asked the model to continue. The model restarted the reply instead,
   and `depthContinuationSuffix` only stripped an echoed *tail*, so the whole restart
   was appended as "fresh" text.
2. **Same sentence twice in one reply** (same cause, or the model looping).
3. **Same stock line every turn** ("Main tumhe kabhi jaane nahi dungi..."). Nothing
   compared a new reply with the earlier ones, and the looped line was saved to history,
   which made the model repeat it even more.
4. **Language.** The prompts only said "match established language". Nothing told the
   character to switch when the user asks, so she argued instead of switching.

## Fixes
- `src/lib/providers/replyRepeat.ts` (new): sentence-level repeat detection (case/punctuation
  insensitive, near-duplicate aware, Unicode/Devanagari safe). Short lines like "Haan." are
  kept unless they sit inside a repeated run, so restarts are removed cleanly.
- `completeReply.ts`: both continuation paths (token-limit and depth top-up) now discard
  anything the reply already says; a top-up that only repeats adds nothing.
- `cleanAssistantResponse(text, intelligence, recentAssistant)`: removes repeats inside the
  reply and against the last 6 assistant replies before saving. The client receives the
  cleaned text through the existing `reply_final` event. `chat.ts` passes the history
  (a regenerated reply is already excluded from it).
- `conversationAwareness.ts`: new `LANGUAGE:` rule (follow the user's language/script,
  switch immediately when asked, natural grammar, no accent commentary) and `NO LOOPS:` rule.
- `tests/reply-repeat.test.cjs`: 11 tests built from the failing replies.

## Follow-ups
- A depth top-up that only repeats now gets ONE more attempt that asks for new sentences only
  (max 2 attempts), so replies are no longer left under the tier minimum when a retry works.
- New `NATURAL TURN` rule (all engines): mirror the user's format (plain speech gets mostly speech and
  at most 1-2 short action beats), vary openings, and never narrate the user's own body or feelings.
  Style only; it adds no content restrictions.
- New `NO INVENTED HISTORY` rule: no "you never said that before" claims, and no questioning
  the user's wording (names, terms of address, language); no new invented family/past facts.
- No content filters were added anywhere. The repeat cleanup only removes duplicated sentences
  and never looks at what a sentence says. Mature-mode prompts are unchanged.
- Note: `matureScene.ts` (`isMatureSceneActive`) is not called from anywhere, so it has no effect.

## Limits
- Odd wording the model invents comes from the model and the character's persona data, not from
  code; a clearer persona or a stronger engine tier helps there.

## Not changed on purpose
Sampling settings (temperature, penalties) are untouched: providers differ in which penalty fields they
accept and this could not be tested live, so a wrong field could break the fallback chain.
