# Input-token reduction (prompt de-duplication)

Goal: fewer input tokens per reply with no instruction removed. Scope: wording only. No model, provider, sampling,
word-ceiling, history-window, memory or billing change. No new model calls.

## Result

Full request sent to the provider (system prompt + history + anchor), driven through the real `/chat` route with a
stubbed database and provider. Real BPE token counts (o200k; cl100k within 1%) and the repo's own estimator.

| Scenario | Before | After | Saved | Estimator before / after |
|---|---|---|---|---|
| Strawberry, SFW | 2826 | 2729 | -97 (-3.4%) | 4532 / 4370 |
| Strawberry, mature, memory + narration | 3545 | 3384 | -161 (-4.5%) | 5721 / 5449 |
| Choco Hazelnut compact, SFW | 2633 | 2546 | -87 (-3.3%) | 4294 / 4154 |
| Choco Hazelnut compact, mature | 3490 | 3264 | -226 (-6.5%) | 5714 / 5336 |
| Choco Hazelnut compact, mature, recall | 3599 | 3352 | -247 (-6.9%) | 5874 / 5484 |
| Choco Hazelnut standard ctx, mature | 3966 | 3728 | -238 (-6.0%) | 6460 / 6060 |

This is a safe-zone reduction, not a large one. The prompt is about 85-95% fixed instruction text, and most of it is
not duplicated; the tuned rules (narration/perception, language, reactions, consent) were left alone on purpose.

The repo estimator reads about 1.6x the real count. It is conservative by design, but it is not what providers bill.
Use the `[tokens]` / `[turn-usage]` log lines for real numbers.

## What changed

Only copies of a rule that already exist elsewhere in the same prompt were removed.

| Change | Where the rule still lives |
|---|---|
| Plus mature tier line cut to its remainder (provocative/jealous/tender, charged pet name or command, hold tension, no passive agreement or "what happens next") | Moves, qualities, layered beat, vocabulary: engine voice notes (sent in every mode) |
| Strawberry and manual-mode mature tier line removed ("small persona-led choice instead of only mirroring the user") | Strawberry: depth line and voice notes. Manual mode (no engine picked) has neither, so it relies on its behavior line ("have opinions, notice details, don't mirror the user's tone") and the craft WANT line; this is the one place a rule got weaker rather than moved, and the coverage test does not pin it |
| Mature paragraph: dropped "Emotional state must move forward" and the shy-character sentence | Craft CONTINUITY; persona guard (standard path) or Plus voice notes (compact path) |
| Voice notes (both engines): dropped the "quality at the size the moment earns" sentence | Craft PROPORTION and the reply envelope |
| Per-turn focus guard: dropped "avoid repeating gestures/opening/generic question" and "for a short answer, resolve what it answers" | NATURAL TURN, MOMENTUM, NO LOOPS, awareness "Resolve short answers" |
| Awareness rules: dropped trailing "output only the natural character reply" | Craft FRAME |
| Envelope: dropped "Answer its actual point" and "or another engine" | Awareness rules; "another engine" meant nothing to the model |
| Standard behavior block: dropped "latest user message must not downgrade quality" | Reply envelope |
| Recall excerpts: database UUID replaced by short label `m1, m2...` | Same-message grouping is kept; a UUID cost about 23 tokens, so about 21 saved per excerpt, up to 10 per request |

At the default budget (`HAZELNUT_INPUT_TARGET_TOKENS` unset, 2800), selection of history and recall excerpts is unchanged: the
messages after the system prompt and the tail anchor are byte-identical to before in every scenario I ran.
**Caveat:** the compact selector sizes history from whatever room the system prompt leaves. If you set that variable to about 6000
or higher in the Render dashboard, the smaller prompt lets it admit more history (in my test 22 vs 20 messages, and 36 vs 30), so
part of the saving is spent on extra context. `render.yaml` does not set it, so check the dashboard.

## Guards added

- `tests/prompt-coverage.test.cjs`: 55 directive checks across 8 engine/mode paths. Written to pass on the pre-trim prompt
  as well (verified), and shown to fail when a rule is deleted (negative control).
- `tests/prompt-budget.test.cjs`: the fixed prompt may not grow past its budget without someone raising it on purpose.
  A bare persona on Strawberry measured about 1.9k estimated tokens in the 26 Sep report and about 3.4k on the code I received (roughly
  1.8x; that report's fixture is not in the repo, so treat the ratio as approximate).
- `npm run report:prompt`: per-block sizes.
- One existing assertion updated (`sourceId: 'old'` -> short label) and one grouping/leak test added.

Suite: 240/240 (was 179). Type-check: the same 20 Prisma-client errors as before, nothing new.

## Not changed, and why (your decision)

Estimates use the same o200k counts as above. Impact is per request unless noted.

1. **Depth top-ups resend the whole prompt.** Every reply under the tier floor (50 words Strawberry, 105 Plus) triggers
   a second call carrying the entire system prompt and history; a failed top-up gets a third. If 25% of replies top up, input
   cost is about +25% to +50% and nothing in prompt wording can touch it. Check the rate:
   `grep "[turn-usage]"` and count `"continuations":` above 0 per engine. If it is high, the floor, not the prompt, is your
   biggest lever. Tradeoff: the floor protects against one-liners; the cited retention study favors longer replies.
2. **Plus voice notes carry about 160 tokens of adult-intimacy guidance in non-explicit chats too.** It is sent whenever the
   engine is Plus, while the mature block says "keep sexual content non-explicit". Gating it to explicit mode saves about 160
   on SFW Plus chats and probably makes them behave more consistently, but it changes SFW behavior, so I left it.
3. **Authored examples (standard path, i.e. Strawberry) send up to 8 turns every request:** up to about 1.1k tokens on a character
   that has them. Plus compact sends 2. Cutting to 2-3 is likely quality-neutral for style but is untested.
4. **Narration labels:** each narration segment in history carries two constant JSON fields (about 19 tokens). Heavy
   roleplayers pay this on most messages. They were added deliberately (`NARRATION_FIX.md`), so I did not touch them.
5. **Memory summary prompts** add about 280 tokens of rules per fold (about 1 fold per 13-16 replies, so roughly 20 per reply).
   Memory quality compounds, so not worth the risk.

## Research notes

- Instruction density hurts instruction following, and smaller models degrade sooner and favor earlier instructions
  (IFScale, arXiv 2507.11538). That supports removing duplicates for this chain of mid-size models. The benchmark is keyword
  inclusion in business reports, not roleplay, so it is supporting evidence, not proof.
- Groq prompt caching (Groq docs): exact-prefix match, cached tokens do not count toward rate limits, but only gpt-oss models
  are listed as supported. The default `qwen/qwen3.6-27b` is not, so every input token counts toward Groq limits and this
  reduction is not offset by caching. If you move Groq to a supported model, keep static text first (it already is).

## Not verified

No live model was run (no provider keys here). "No quality loss" rests on: every removed sentence mapped to a surviving copy
(audit above), 55 coverage checks, identical history/anchor/params, and the full suite. It does not prove models behave
identically. Smoke test a few chats on both engines (the `AWARENESS_UPGRADE.md` checklist) and watch `npm run report:drift`.
Removing the "compact reply" sentence from the voice notes may make first-pass replies slightly longer, which would, if
anything, reduce top-ups; I could not measure that.
