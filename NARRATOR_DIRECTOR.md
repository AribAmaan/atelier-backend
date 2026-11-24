# Narrator / Scene Director channel (additive patch)

This patch keeps the `main (19)` prompt, craft, awareness, reply-envelope, persona-anchor, context-retrieval, provider, and post-processing systems. It adds the narrator / scene-director capability from the minimal-prompt branch without removing or replacing those existing systems.

## Input semantics

- Plain text remains the user's spoken dialogue (unless clearly out of character).
- Text wrapped in `*...*` or `**...**` is tagged as `delivery: "narrator_director"` and `authority: "canon_highest_priority"` for the current fictional scene.
- Narrated events, time/place changes, new people/objects, and explicit scene-state changes are treated as canon and played out in the current reply.
- The assistant voices other characters explicitly brought in or directed by the narrator. A direction such as `*Suzy says*` asks the assistant to provide Suzy's line, rather than answering in the main character's place. Supporting-character dialogue is prefixed with `Suzy:`; the main persona remains unlabeled.
- Private thoughts, feelings, opinions, hidden motives, and off-screen facts remain private unless made perceptible or explicitly spoken aloud. The director channel does not turn private thoughts into dialogue or allow the assistant to invent actions for the user's character.
- The director channel governs fiction only; system, safety, age, and consent boundaries remain in force.

## Per-turn delivery

The scene-director instruction is delivered through the system prompt rules, structured user-turn metadata, a bounded current-turn guard, and a short tail system note placed immediately before the final conversation message (or appended to the first system message when `ROLEPLAY_ANCHOR_PLACEMENT=system` requires the strict-template fallback). Quick-action `sceneDirective` text uses the same channel, is bounded to 1,000 characters, and is not stored in the reusable character prompt cache. It is also not saved as user dialogue.

## Continuity

Conversation summaries and older Hazelnut recall excerpts preserve narrator-established events as `Narrator canon` with `narrator_director` attribution, while keeping private context separate from what characters know. Older recalled excerpts retain the same delivery, authority, and character-knowledge metadata as current-turn input.

## Preserved behaviour

The patch intentionally retains the original craft rules, awareness checks, roleplay steering, reply-length envelopes, continuation budget, persona anchoring, Hazelnut context selection, provider fallback chain, reply cleanup, and existing feature flags from `main (19)`.

## v19 text kept verbatim; cost of the addition

`ROLEPLAY_INPUT_RULES` keeps every v19 perception rule and example verbatim and adds a short NARRATOR / SCENE DIRECTOR block (CANON, CAST, AGENCY, SCOPE) plus one Suzy example. `ROLEPLAY_MEMORY_RULES` keeps the full v19 text and adds the `Narrator canon` label. The recall header keeps the v19 wording plus one narrator sentence.

Cost: the fixed prompt grows by about 460 estimated tokens (about 12%, e.g. strawberry sfw 3715 -> 4179 in `npm run report:prompt`). `tests/prompt-budget.test.cjs` budgets were raised on purpose and the reason is recorded there. `tests/narrator-director.test.cjs` fails if any v19 perception or memory clause is removed.

Known limits: the director channel is prompt-level, so model behaviour (e.g. actually voicing Suzy) needs a live-model check. The v19 reply word ceiling still applies, so a long multi-speaker reply can be cut at the ceiling. A quick-action steer is not saved to history, so it reaches memory only through the reply it produces.
