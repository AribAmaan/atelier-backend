# Narration and character knowledge fix

## What changed

The previous backend already parsed single and double asterisks. The remaining
weakness was how the model interpreted unspoken context, especially private
feelings, sensations, and background information. A rendered italic span alone
does not enforce what the character knows.

- User narration now carries explicit unspoken-context and perception labels at
  the provider boundary. Original stored messages and frontend display are preserved.
- Every turn containing narration gets a fresh, bounded spoken-dialogue anchor
  and perception reminder, including regeneration and edit flows using the same
  chat route. This reminder is not cached with the character persona.
- Characters are instructed not to answer private context or invent observable
  gestures to justify knowing it. Visible actions remain available to the scene;
  explicit speaking inside narration can still be interpreted as audible.
- Hazelnut includes this reminder in context-budget estimates. Recalled narration
  stays whole so a sentence cannot lose a preceding thought/imagination qualifier.
- Authored user examples are labeled too, in both standard and compact prompts.
- Memory prompts preserve spoken/observable/private attribution and correct
  conflicting old claims when the supplied transcript supports that correction.

No provider ordering, model selection, reply word limits, database schema,
frontend files, or payment behavior was changed. The patch uses no additional
model requests; prompt labels/reminders do add input tokens on narration turns.

## Deploy

Replace the backend source in the existing Render project with this archive's
`rolichat-backend` contents. Use the existing environment variables and deployment
configuration. Normal installation generates Prisma Client; build with
`npm run build` and start with `npm start` as before. No database migration or
frontend deployment is required for this fix.

After deployment, regenerate the incorrect last reply or try a fresh conversation.
Existing saved replies are not rewritten. If an old memory summary wrongly says
the user disclosed a private thought, correct that entry in the Memory panel;
the patch cannot reconstruct information already lost from an old summary.

## Neutral acceptance examples

| Input | Intended interpretation |
| --- | --- |
| `Hi *I feel nervous but hide it*` | Hear Hi; do not diagnose or reassure about undisclosed nerves. |
| `Hey **she looks gorgeous**` | Hear Hey; do not thank the user for an unspoken compliment. |
| `*I pass her the map*` | React to the visible action without inventing spoken words. |
| `*I think "I missed you"*` | The quoted thought was not heard. |
| `*I say aloud, "The train is here."*` | The explicit act of speaking can be heard in the scene. |
| `*Rain drums against the window*` | Use environmental context without treating it as user dialogue. |

## Validation

- Prisma Client generation and full TypeScript production build passed.
- `npm run test:narration`: 19 passing regression tests.
- Tests cover both delimiters, mixed turns, unfinished narration, quoted thoughts,
  visible actions, escaped asterisks, arithmetic, bounded anchors, all four engines,
  both Hazelnut prompt paths, historical recall, and unchanged reply limits.
- The memory provider request was inspected using a mocked HTTP response;
  no real model reply was generated during validation.

These checks verify parsing, prompt construction, and request plumbing. They do
not guarantee every model will obey the perception rules. Run the neutral examples
against the deployed engines and inspect both fresh and existing conversations.
