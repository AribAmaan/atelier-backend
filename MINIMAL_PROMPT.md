# Minimal prompt: shaping removed, Narrator / Scene Director strengthened

Why: replies felt over-filtered. The prompt carried ~4,000 estimated tokens of style rules, a hard 50-130 word clamp, a repeat-sentence deleter, a stock-closer stripper, per-turn "steers" and a persona anchor. All of that is gone; the model decides tone, length and pacing.

## Removed (chat shaping)
Craft rules, `ROLEPLAY_FORMAT`, awareness rules (natural turn, reaction, no loops, no invented history), persona guard, behaviour ladder / depth lines, engine voice notes (now empty), time-gap block, tier reply envelope + length reminder, tail persona anchor, turn-director steers, "current response focus" guard, the style half of the mature block. Post-processing no longer shortens or edits replies: no word clamp, no min-word top-up, no repeat-sentence removal, no closer stripping, no "as an AI" stripping. Only a leaked `Name:` label, blank-line runs and a dangling `*` are fixed.

## Kept on purpose
- Adult-only + consent lines of the mature block (explicit writing is still requested, fade-to-black is discouraged).
- Persona / background / notes / examples / memory data.
- One language line (Hinglish stays romanized Hinglish) and one format line (*actions*, plain dialogue) so the UI keeps rendering. Delete either in `conversationAwareness.ts` / `providers/index.ts` if you want zero.
- Token ceiling as a runaway guard only: 700 (free) / 1000 (plus), env `REPLY_MAX_TOKENS_FREE` / `REPLY_MAX_TOKENS_PLUS`. Finish-on-cutoff recovery still works.

## Strengthened: text between asterisks (`*x*` or `**x**`) = Narrator / Scene Director
- Highest priority in the turn, above persona, history and memory. Canon the moment it is written (events, time/place jumps, new people/objects, character states); directions to the character are acted out; never refused or commented on.
- Both `*x*` and `**x**` are the narrator (the app renders both the same). Private thoughts/opinions inside stay unheard by the character.
- Other characters: `*Suzy enters*` / `*Suzy says*` makes the model voice Suzy (`Suzy: ...`) instead of the main character answering in her place.
- Director authority covers the story only, not system rules or adult-only/consent limits.
- Delivered three times: rules in the system prompt, `delivery: "narrator_director"` on the segment in the user's own message, and a tail system note right before the final message. The quick-action `sceneDirective` uses the same channel (limit raised 500 -> 1000 chars, no longer baked into the cached system prompt).
- Memory summaries keep narrator canon as facts (`Narrator canon` label).

## Verification notes
- Chat-route tests were run offline against a small express stand-in (validated by running the untouched original code through it: same results). `tests/chat-director.test.cjs` covers the real route end to end: `**` delivery, steer per turn (not cached), continue, regenerate, no word limits, long replies saved in full, mature mode guards.
- `tests/image-generation.test.cjs` needs the `sharp` package and fails only where it is not installed (same as before these changes).
