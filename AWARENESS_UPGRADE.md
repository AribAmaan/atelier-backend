# Character and situation awareness upgrade

## Changes

- All four engines receive shared grounding guidance covering character goals, expertise, voice, present knowledge, scene participants, location, objects, physical constraints, emotional causes, boundaries, and unresolved questions.
- Character greetings and taglines now supply the initial scene premise. Later scene developments take precedence; greetings are not replayed. Editing the greeting invalidates the prompt cache.
- Each request distinguishes answering a user turn from continuing the character's last reply. Regeneration uses the remaining history, excluding the answer being replaced.
- Short replies such as “yes” and “why” inherit recall vocabulary from the preceding exchange. Concrete topic changes retain their own search terms. This is local keyword retrieval, not semantic search.
- Compact context protects the last three user exchanges, instead of two. Relevant older evidence keeps source attribution and whole speech/narration segments, preserving qualifiers and negation. Unrelated old scenery no longer fills the recall budget.
- A small allowance for relevant older evidence remains available when a long persona fills the soft token target. Overflow is reported in diagnostics. Context cost can increase; there are no added model calls or new dependencies.
- If summarization falls behind on another engine, the safety window preserves complete exchanges and relevant older evidence rather than dropping the whole intervening context.
- All engines' future memory summaries receive guidance to preserve causal context, corrections, object state, boundaries, and open commitments; proposals and imagined events remain distinct from completed events.

## Validation

`npm test`: TypeScript build and 48 tests passed. Prisma schema validation passed. An offline schema diff confirmed the committed migration adds exactly the two recall-cutoff fields.

Coverage includes the existing narration regressions, multilingual retrieval terms, short-answer recall, conditionals, bounded recall under a large persona, all four engine prompts, all four summary requests, and real HTTP route tests using mocked persistence and generation. Route tests check engine switches, continuation, regeneration, changed-greeting cache invalidation, a summary backlog, memory forgetting, and unanswered turns at Vanilla, Strawberry, and Chocolate summary boundaries. Existing word limits are asserted unchanged.

Tests verify context assembly and request behavior. No live model generation or production database test was performed, so conversational quality still needs a deployment smoke test. Prompt guidance cannot guarantee perfect recall or eliminate every model mistake. Existing summaries are not rewritten immediately; new summary folds use the upgraded instructions. Retrieval remains bounded and cannot consider the entire transcript on every turn.

## Additional debug fixes

- Forgetting memory now stores the last pre-reset message position. Hazelnut recall excludes older messages after the reset while preserving the visible chat transcript. The cutoff is cleared by conversation reset and bulk deletion.
- Memory summaries on every engine now leave a trailing unanswered user turn in recent context instead of folding it without the response.

## Deploy

Replace the backend project files with this ZIP's contents and redeploy using the existing build/start configuration. Keep the existing environment variables. No frontend change or new API key is required. This version includes a database migration adding `Character.recallAfterCreatedAt` and `Character.recallAfterId`; the included Render build command runs `prisma migrate deploy` before starting the backend. If you deploy manually, run `npx prisma migrate deploy` before `npm run start`. The production database was not connected in this audit, and this package has not been deployed to your server.

## Live smoke checks

1. With a reserved archivist character, ask about a missing map: the response should sound like that character rather than a generic helper.
2. Let the character offer to check the archive, then answer “yes”: it should follow through on that offer.
3. Say “Hi *I feel worried but hide it*”: the character should not claim to know the hidden worry.
4. Describe an event involving a friend yesterday: it should not move that friend or event into the present scene.
5. Offer an object without handing it over: the character should not already be holding it.
6. Correct the location, then ask what is nearby: the old opening location should not return.
7. Establish a disagreement, then apologize: the reply should reflect its cause without assuming instant forgiveness.
8. Continue a reply: it should advance from the last beat without inventing a new user action. Regenerate should instead answer the original user turn again.
