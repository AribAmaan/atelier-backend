# Input-token reduction (prompt de-duplication)

Goal: fewer input tokens per reply with no instruction removed. Scope: wording only. No model, provider, sampling,
word-ceiling, history-window, memory or billing change. No new model calls.

## Result

Full request sent to the provider (system prompt + history + anchor), driven through the real `/chat` route with a
stubbed database and provider. Real BPE token counts (o200k; cl100k within 1%) and the repo's own estimator.

| Scenario | Before | After | Net per call | Estimator before / after |
|---|---|---|---|---|
| Strawberry, SFW | 2826 | 2778 | -48 (-1.7%) | 4532 / 4444 |
| Strawberry, mature, memory + narration | 3545 | 3433 | -112 (-3.2%) | 5721 / 5523 |
| Choco Hazelnut compact, SFW | 2633 | 2595 | -38 (-1.4%) | 4294 / 4228 |
| Choco Hazelnut compact, mature | 3490 | 3313 | -177 (-5.1%) | 5714 / 5410 |
| Choco Hazelnut compact, mature, recall | 3599 | 3401 | -198 (-5.5%) | 5874 / 5559 |
| Choco Hazelnut standard ctx, mature | 3966 | 3777 | -189 (-4.8%) | 6460 / 6135 |

The "After" column includes the word-floor sentence added in the second pass below (+49 real tokens per call). Before that
sentence the savings were 3.3-6.9%. It is the one deliberate addition, and it is there to remove a much larger cost.

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

## Second pass: what the production logs showed

Logs from a live Plus chat (5 replies, all in a fresh chat with one earlier message) showed every reply with `continuations:1`
and about 7,000 input tokens per reply against about 3,400 per call.

**Cause.** The reply envelope says "aim around 120 words, normally 105-130", but the craft block's PROPORTION line said
"a quick exchange gets a quick reply". On a short opening message the model followed PROPORTION (28 words). The server then
enforces a 105-word floor with a second call that resends the whole prompt. Two instructions disagreed and the server settled it
by paying for another call.

**Fix (no quality trade).** The floor, ceiling and token limits are unchanged (a test pins 105 / 130 / 256). The prompt now says
what the server enforces: PROPORTION says the moment sets weight and pace while the envelope sets length, and the envelope states
the floor ("Even a greeting or a one-line message gets at least 105 words ... never filler"). The model can then write the
full reply in one pass. If it still falls short, the top-up runs exactly as before, so the worst case is today's behavior.
Cost: +49 tokens per call, which pays for itself if it avoids one top-up in roughly 70.

**Confirmed in the code.** The `words` field in `[roleplay-telemetry]` is measured on the final saved reply. The 28-word reply in your
log therefore went through a top-up call and still came out at 28 words: that call was billed and added nothing usable. The floor
is best-effort, not guaranteed (a failed top-up keeps the first reply).

**Not proven.** I could not run the model, so the effect on the top-up rate is expected, not measured. The new log line below
measures it. If the rate does not fall, the remaining lever is the floor itself (your call, it is a quality decision).

**Visibility.** The 60-second `[tokens]` block now ends with a per-reply line:
`replies: N | with top-up/continuation: M (P%) | avg input per reply: X | avg output per reply: Y`. The per-provider table averages
per call, so it understated what a topped-up reply costs by about half.

**`/health` logging.** A database outage printed a full Prisma stack on every check (five identical blocks in the log). It now logs
one line with the error code, repeats at most once a minute with a count, and says when the database is reachable again. The
check itself, its 5-second cache and its 503 status are unchanged. I did not add a retry: a retry would lengthen a failing
check and could push it past Render's health timeout.

**Open decision: what a database outage does to the service.** `render.yaml` points Render's health check at `/api/health`, which
returns 503 when the database is down. Render's docs say a check fails after a 5-second timeout, traffic is cut after 15 consecutive
seconds of failures, and the service is restarted after 60. A restart does not fix an unreachable database and drops in-flight
streams. Returning 200 with `"database":"down"` in the body would keep the instance in rotation, but any external monitor that
alerts on the status code would then need to read the body. I did not change this; it is your call.

**Left alone on purpose**
- `P1001` to TiDB is infrastructure, not code: check the cluster status and connection string in the TiDB console.
- NVIDIA #1 timing out at 9 s on 2 of 4 requests and falling back to NVIDIA #2 is the documented tradeoff in `nvidia.ts`
  (`NVIDIA_TIMEOUT_MS`). Raising it trades fewer fallbacks for slower worst cases; that is operational tuning.
- `targetTokens: 2800` with `protectedOverflow: true` on every request is harmless (the fixed prompt alone exceeds it, so the
  last three exchanges are always kept). Fixing it would change how much history is sent, which is a quality decision.

## Guards added

- `tests/prompt-coverage.test.cjs`: 55 directive checks across 8 engine/mode paths. Written to pass on the pre-trim prompt
  as well (verified), and shown to fail when a rule is deleted (negative control).
- `tests/prompt-budget.test.cjs`: the fixed prompt may not grow past its budget without someone raising it on purpose (raised once, for the floor sentence, with the reason recorded in the file).
  A bare persona on Strawberry measured about 1.9k estimated tokens in the 26 Sep report and about 3.4k on the code I received (roughly
  1.8x; that report's fixture is not in the repo, so treat the ratio as approximate).
- `npm run report:prompt`: per-block sizes.
- One existing assertion updated (`sourceId: 'old'` -> short label) and one grouping/leak test added.

Suite: 245/245 (was 179); `tests/ops-observability.test.cjs` covers the health logger, the per-reply line and the envelope floor. Type-check: the same 20 Prisma-client errors as before, nothing new.

## Not changed, and why (your decision)

Estimates use the same o200k counts as above. Impact is per request unless noted.

1. **Depth top-ups resend the whole prompt** (confirmed in production logs, see "Second pass"; the new per-reply log line tracks the rate). Every reply under the tier floor (50 words Strawberry, 105 Plus) triggers
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

- IFScale (arXiv 2507.11538, re-read in full): instruction-following accuracy falls as the number of constraints grows
  (10 to 500 one-word keyword constraints in a report-writing task). Larger and reasoning models hold up longer, smaller and older
  ones degrade early, and models favor earlier instructions, a bias that peaks at mid densities and fades at extremes. It does NOT
  test duplicated instructions, roleplay, or the models in this chain, and the decay it measures starts at tens to hundreds of
  constraints. It is background for "fewer instructions is not worse for small models", not evidence for these edits. The
  evidence for the edits is the sentence audit, the 55 coverage checks and the unchanged tests. Qwen3-235B scored 20.9% at 500
  constraints, so the Groq fallback is not immune.
- Groq prompt caching (Groq docs, re-checked 1 Nov 2026): exact-prefix match, cached tokens do not count toward rate limits, but only gpt-oss models
  are listed as supported. The default `qwen/qwen3.6-27b` is not, so every input token counts toward Groq limits and this
  reduction is not offset by caching. If you move Groq to a supported model, keep static text first (it already is).

## Not verified

No live model was run (no provider keys here). "No quality loss" rests on: every removed sentence mapped to a surviving copy
(audit above), 55 coverage checks, identical history/anchor/params, and the full suite. It does not prove models behave
identically. Smoke test a few chats on both engines (the `AWARENESS_UPGRADE.md` checklist) and watch `npm run report:drift`.
Removing the "compact reply" sentence from the voice notes may make first-pass replies slightly longer, which would, if
anything, reduce top-ups; I could not measure that.
