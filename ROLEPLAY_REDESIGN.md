# Roleplay response redesign

Goal: replies that feel like a specific person in a living scene, not a model following a checklist. Everything here is deterministic and adds **no model calls**.

## What was wrong (from reading the code)

1. **Five overlapping style blocks.** "Vary openings / no generic closing question / carry emotion forward / keep dialogue spoken" was repeated in `NATURAL TURN`, `buildNaturalTurnBlock`, the engine behaviour block, the voice notes and the mature block. Small and fallback models follow one short, ordered block better than several lists of prohibitions, and the duplicates cost tokens every turn.
2. **Only sentence-level repetition was caught.** What makes long chats feel mechanical is the reply *shape* repeating: same opening move, a question ending every turn, the same number of action beats, the same stock gesture ("smirk", "breath hitched"), the same three-word line in four replies out of five. A model imitates its own recent replies more strongly than it obeys a rule.
3. **A hard word floor forced padding.** A one-word "hi" to Choco Hazelnut triggered the depth top-up call, which pads the reply or restarts it.
4. **Assistant leakage got through.** Speaker labels (`Mira: ...`), sign-offs like "What would you like to do next?", and an unclosed `*` that italicises the rest of the message.

## What changed

| Piece | File | Effect |
|---|---|---|
| **Craft block** | `src/lib/providers/roleplayCraft.ts` (new) | One positively-phrased, ordered block (presence, want, subtext, voice, proportion, momentum, continuity, frame) replaces the overlapping ones. Tier depth is one line (`craftDepthLine`). |
| **Turn director** | `src/lib/providers/turnDirector.ts` (new) | Reads the character's last replies and the user's latest beat. Emits 0 to 5 short steers: break a run of closing questions, vary a repeated first word or an all-action opening, cap action-heavy replies (and add grounding to action-free ones when the user is writing actions), stop the character narrating the user's body or feelings, retire stock gestures and repeated lines, and size the reply to the beat. Returns `""` on a healthy chat. Appended fresh every request, never cached. |
| **Reply polish** | `src/lib/providers/replyPolish.ts` (new) | Strips a leaked speaker label, strips one trailing assistant-style hand-back (narrow list of assistant-only phrasings, end of reply only, never empties a reply), and repairs a single unclosed `*` action (anything more tangled is left as written). Runs inside `cleanAssistantResponse`, so the saved text and the `reply_final` event match. |
| **Adaptive rhythm** | `replyPolicy.ts` | On a brief user turn (5 words or fewer) the word **floor** relaxes to 60% and the aim to 80%, and the prompt tells the model to answer a light turn compactly but a turn that carries feeling, news or a decision fully. Ordinary/weighty turns, scene steers and Continue keep the full envelope. |
| **Voice notes** | `engines.ts` | Opening sentence of each engine's notes no longer says "full depth regardless of input length" (it contradicted the rhythm rule). Adult-intimacy and consent text is unchanged. |
| **Awareness rules** | `conversationAwareness.ts` | `NATURAL TURN` and `REACTION` tightened; every wording the tests pin is preserved. |
| **Wiring** | `chat.ts`, `providers/index.ts` | Director added to the per-turn guard (so Hazelnut's budget sees it), character name passed to cleanup, prompt-cache key bumped to `compact-v8-craft` / `standard-v7-craft`. |

## What did **not** change

- Engine ids, tiers, billing, temperatures, token budgets, reply **ceilings** (70 / 130 words), recall/summary logic.
- The adult-only, consent and "respond immediately to hesitation or refusal" rules, and the mature-mode block.
- The perception rules for `*narration*` (what the character can and cannot know).
- No content filtering was added. The director and polish look at form (position, repetition, a fixed list of stock phrases), never at what a line means.

## Config and rollback

- `ADAPTIVE_REPLY_RHYTHM=false` restores the old fixed floor exactly. Default on. It is in `render.yaml`.
- The director and polish have no switch; they only act when a pattern is actually present.

## Cost

Estimated input tokens (repo's own `estimateTokens`, conservative), system prompt only, before to after:

| Path | Before | After |
|---|---|---|
| Strawberry | 4335 | 4300 (-35) |
| Choco Hazelnut, standard context | 5203 | 5039 (-164) |
| Choco Hazelnut, compact context (default) | 4279 | 4679 (+400) |

The compact path had no craft guidance of its own, which is why it grows. It was already above `HAZELNUT_INPUT_TARGET_TOKENS`, whose budget protects the last three exchanges either way, so history is not squeezed. The director adds 0 tokens on a healthy turn and about 180 in the worst case (all steers firing at once).

## Verification

- `node --test tests/*.test.cjs`: **131 / 131 pass** (97 existing, 29 in `tests/roleplay-craft.test.cjs`, 5 in `tests/chat-craft.test.cjs`).
- Fuzzed with 20,000 seeded hostile inputs (stray `*`, quotes, backslashes, regex metacharacters, Hindi/CJK, NULs): no crash, no emptied reply, asterisk repair stable. A 100k-character hostile reply polishes in ~15 ms; the director over 8,000 messages takes ~2 ms per call. A 4,000-case version runs in the suite.
- `chat-craft.test.cjs` drives the real chat route: repetitive history leads to the director in the prompt, the relaxed floor in `genParams`, and a polished saved reply identical to `reply_final`.
- Type-check: zero errors in the touched files. The 20 remaining errors are the missing generated Prisma client, identical to the original upload.
- Not exercised: real provider output. Whether a given model obeys the craft block and the steers needs a read of live chats; start with a Choco Hazelnut chat that previously looped.

## Second-pass audit: flaws found in the first version and fixed

Probed with real inputs after the first version passed its tests:

1. **Plain-speech chats were pushed into action beats every turn.** The director now steers only runs of an actual habit (all-action openings, repeated first word, action-heavy replies). Speech-only is a valid style. The "add a physical beat" steer fires only when the user is writing actions themselves.
2. **The closer stripper deleted legitimate lines** ("What do you think?", "Let me know if you get cold."). The list is now assistant-only phrasing ("What would you like to do next?", "How does that sound?", "Is there anything else I can help with?").
3. **A short but charged turn ("I love you", "please dont go", "im pregnant") was told to keep it small.** The brief-turn threshold dropped from 7 to 5 words and the wording now leaves the call to the model: light turns get a compact reply, charged ones are answered fully. Known limit: a charged turn is still brief, so the floor is relaxed for it; the prompt, not a rule, is what makes the reply full.
4. **The character speaking for the user was not detected.** The director now flags narration like "you shiver, your heart racing" in the last two replies (inside the character's own narration only, so "your breath fogs in the cold" is fine).
5. **Asterisk repair was unstable on tangled input.** Fuzzing showed it could grow forever on mismatched nesting. It now repairs only a single unclosed action and is checked to be a fixed point.

## Deliberately not done

- **Repetition penalties (`frequency_penalty` / `presence_penalty`).** Groq's compatibility page lists only `logprobs`, `top_logprobs`, `logit_bias` and `messages[].name` as 400-causing, but nothing confirms per-model acceptance across Groq, NVIDIA, SambaNova, Cloudflare and Ollama, and a rejected field would break the fallback chain. Repetition is handled in the prompt layer instead. Worth a live test per provider if you want to add them.
- **Non-English stock-phrase list.** `STOCK` is English; repeated lines in any language are still caught by the 3-word repeat check (verified on romanized Hindi).
- **Hiding streamed labels/closers until the end.** A leaked label or closer can flash while streaming and is removed by `reply_final`, the same reconciliation the repeat cleanup already uses.

## Tuning

Thresholds are the named constants at the top of `turnDirector.ts` (3 openings, 2 closing questions, 2-of-4 stock tics, 3-of-5 repeated phrases, quick/weighty word counts) and the `STOCK` / `STOCK_CLOSERS` lists. Add a pattern there when you see a new tic in real chats.
