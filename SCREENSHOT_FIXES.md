# Fixes from the Abigail chat screenshots

| # | What the screenshots showed | Cause (in this backend) | Fix |
|---|---|---|---|
| 1 | `*I slap her ass*`: reply opened with narration ("hand flies to her chest, a surprised laugh"), no spoken "Ah!/Ow!" | The craft SHAPE rule ("action passage, then a spoken line") and the 105-word envelope contradicted the reflex note, and the model followed the stronger rule | SHAPE now says a hit/touch or direct question gets the spoken reaction/answer first; the reflex note says the FIRST words are the spoken sound and that it overrides action-first |
| 2 | Reflex trigger was far too loose | Regex matched any `bite`, `poker`, `punch line`, `kick off`, `flicker`, `Ana slaps me`, `slap the table` | `isPhysicalImpactOnPersona`: an impact verb counts only when the target is her/him/them/you/your or the persona's name |
| 3 | `*ana my older sister comes and says*`: Abigail answered "Ana." herself and invented "the condition / Losing Mom, the war"; Ana never spoke | Open speech tag was not detected; CAST rule did not cover lowercase names or forbid inventing a new person's history | `endsOnOpenSpeechTag` adds a per-turn note to write Ana's own `Ana: ...` line; CAST now says a lowercase name is a name and a new person has no invented past |
| 4 | Persona called the user "William" while the account is "Amaan" | The user's name is never sent to the model, so nothing stops it inventing one | Rule added: name the user's character only as persona/setup/transcript does, otherwise no name |

Tests: `tests/screenshot-regressions.test.cjs` (6 new). Full suite 306/306.
`tests/prompt-budget.test.cjs`: strawberry sfw budget 4560 -> 4700 on purpose (about +125 estimated tokens), reason recorded in the file.

Not changed: no live model was run, so prompt fixes are verified as prompt/detector behavior only. Frontend items (layout, reaction pills) are not in this zip.

## Multi-character follow-up
The app has many characters, so nothing here may depend on one. Audit result:
- The shared prompt (CAST rule) contained a screenshot-specific example name; replaced with a neutral one (`*my brother walks in and says*`). A test now fails if any shared rule names a specific character.
- The slap reflex reads the active character's name per request. Fixed a bug for other characters: titles and filler in names ("The Duchess", "Lady Rose") made "slap the table" trigger a hit; those words are now ignored.
- Open-speech-tag detection works on any name or none ("my brother walks in and says").
- New tests run the same checks across 7 different character names. Suite: 309/309.
