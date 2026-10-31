# Roleplay response redesign

Goal: replies that feel like a specific person in a living scene, and a way to **measure** whether each change helps real users. Everything here is deterministic and adds **no model calls**.

## What changed

| Piece | File | Effect |
|---|---|---|
| Craft block | `providers/roleplayCraft.ts` | One short, ordered, positively-phrased block (presence, want, subtext, voice, proportion, momentum, continuity, frame) replaces five overlapping style blocks. Includes "most replies carry at least one non-verbal beat". |
| Turn director | `providers/turnDirector.ts` | Reads the character's last replies and the user's latest beat; emits 0 to 7 short steers with stable ids (nine possible ids). Silent on a healthy chat. |
| Reply polish | `providers/replyPolish.ts` | Strips a leaked speaker label, one trailing assistant-style closer, and repairs a single unclosed `*`. Saved text equals `reply_final`. |
| **Persona anchor** | `providers/recencyAnchor.ts` | A short persona reminder placed just before the final message (see below). |
| **Experiment flags** | `roleplayFlags.ts` | Sticky, per-user A/B switches for the behaviours that are hypotheses. |
| **Scene state + voice memory** | `providers/index.ts` | Summary prompts now record time, who is present, what each person holds or wears, established props and gestures, and the character's established voice. |
| **Metrics** | `providers/replyMetrics.ts` | Repetition, assistant-style phrasing, stock tics, non-verbal rate, length, question-ending rate. |
| **Telemetry** | `replyTelemetry.ts` | One content-free, pseudonymous log line per reply. |
| **Reports** | `roleplayReport.ts`, `scripts/` | `npm run report:roleplay` (A/B and retention) and `npm run report:drift` (one conversation). |

## What the research says, and what this does with it

| Finding | Source | What was done |
|---|---|---|
| Personas drift within about eight turns, partly from attention decay. | [Measuring and Controlling Persona Drift in Language Model Dialogs](https://arxiv.org/pdf/2402.10962v1) | The persona reminder moved from the top of the prompt (no recency) to just before the final message. |
| Over long dialogues, persona fidelity fades and replies move toward the no-persona baseline. | [2026 long-dialogue persona study](https://anguilla.dbs.ifi.lmu.de/publications/dha+26/); [Persistent Personas?](https://arxiv.org/html/2512.12775v2) | Same; plus an `assistantismRate` metric to watch for it. |
| In a study of real users, average reply length was the factor most tied to retention, and non-verbal description (actions, setting) also helped. Personality consistency helped; fact consistency, empathy and proactivity showed no significant effect. Correlational, one platform. | [Retention study, arXiv 2402.11522](https://web3.arxiv.org/pdf/2402.11522v1) | **Reversed two earlier choices**: shortening replies and capping action beats are now OFF by default and run as experiments. The craft block asks for a non-verbal beat in most replies. Memory records scene state and voice, not trivia. |
| Anti-repetition samplers (DRY, XTC, min-p) work on engines that expose them. | [Min-p, ICLR 2025](https://iclr.cc/virtual/2025/poster/30358) and sampler docs | Not used: your hosted providers don't reliably expose them. |

Not implemented: inner-monologue planning (a 2026 preprint, [PersonaForge](https://preview.aclanthology.org/ingest-acl/2026.findings-acl.386/)). One paper, and it costs extra model work.

## Experiment flags

Each takes `on`, `off`, or `split:N` (N% of users, chosen by a stable hash of the user id, independently per flag). A user stays in one arm for the whole test. A split with no user id is the control.

| Env var | Default | Treatment |
|---|---|---|
| `ADAPTIVE_REPLY_RHYTHM` | **off** | On a brief, light user turn (5 words or fewer) relax the word floor to 60% and tell the model a light turn can get a compact reply. Ceiling never changes. |
| `ROLEPLAY_ACTION_CAP` | **off** | After three action-heavy replies, ask for at most one action beat. |
| `ROLEPLAY_DIRECTOR` | on | All per-turn steers. Off means none. |
| `ROLEPLAY_PERSONA_ANCHOR` | on | The recency anchor. Off means the previous behaviour (old top-of-prompt reminder on the standard path, nothing on compact). |
| `ROLEPLAY_ANCHOR_PLACEMENT` | `tail` | `system` appends the anchor to the first system message instead. |
| `ROLEPLAY_TELEMETRY` / `_SALT` | on | Per-reply log line. Changing the salt unlinks earlier records. |

### Running an experiment

1. Set e.g. `ADAPTIVE_REPLY_RHYTHM=split:50` and deploy. Leave the other flags alone so each comparison stays clean.
2. Let it run for at least a week; you want hundreds of users per arm.
3. Save the Render logs, then `npm run build && node scripts/roleplay-report.cjs logs.txt`.
4. Read, per flag: users and replies per user, mean words, non-verbal rate, question-ending rate, assistant-isms, stock tics, **return next day**, **return within 7 days** (with z and p), and for the persona anchor assistant-isms by conversation turn.

Reading it: arms are randomized, so a difference is a real estimate, not a correlation, but only if the sample is large. The report warns when an arm has under 100 users or a flag isn't split. Four flags and two retention outcomes are compared at once, so one p near 0.05 is expected by chance; prefer large, consistent differences that persist. Cohort = users first seen in the supplied logs, and users are counted for retention only once their whole window has elapsed.

## Persona anchor

Inserted as its own `system` message **immediately before the final message**, whatever its role. The final message keeps its role (user for a normal reply, character for Continue), so chat templates and the "answer the last turn" contract are unchanged. Character fields are sent as quoted JSON data (they are user-authored). About 110 estimated tokens.

Compatibility: some chat templates (strict Qwen/Mistral-style ones) reject a system message that is not first, and I could not test your live providers (the default Groq model is a Qwen). So the shared HTTP layer (`openaiCompatible.ts`, used by Groq, NVIDIA, SambaNova and Cloudflare) now handles it: if an endpoint answers HTTP 400 with "system" in the error, the request is retried once with the late system messages folded into the first one, and that endpoint+model is remembered so later requests skip the failed attempt. A working endpoint is unaffected (one request, unchanged messages), and an unrelated 400 is not retried. A one-line warning is logged the first time an endpoint needs the fold. Folding trades away the recency benefit for that endpoint only. Ollama has its own client and is not covered; set `ROLEPLAY_ANCHOR_PLACEMENT=system` if a local model rejects it. On the compact path, `chat.ts` rebuilds the message list after budgeting, so the anchor is inserted after that and its tokens are counted in the budget (tested).

## Telemetry privacy

Logged: arms, steer ids, turn number, engine, and form-only measurements (word count, action beats, ends on question, assistant-isms, tics). **Never logged:** message text, character text, names, or raw ids. User and character ids are salted one-way hashes. A test fails if a raw id or any reply text appears in the line (verified with a negative control). Regenerations are not counted.

## Scene state and voice

The Plus summary keeps its five headings and 220-word budget and gains a `Voice` heading; `Scene` now covers time, who is present, what each holds or wears when stated, and established props and gestures. Other tiers end with a `Scene:` line, and mid and top tiers add a `Voice:` line (pet names, running jokes, speech habits the chat established). Attribution and privacy rules still attach to every summary.

## What did not change

Engine ids, tiers, billing, temperatures, token budgets, reply **ceilings** (70 / 130 words), recall, the adult-only and consent rules, the mature-mode block, and perception rules for `*narration*`. No content filtering was added; the director and polish look at form only.

## Cost

> Superseded by `TOKEN_REDUCTION.md`: duplicated rules were later removed (about 3-7% fewer real input tokens, budgets enforced by `tests/prompt-budget.test.cjs`). The table below is the original redesign measurement.

Estimated input tokens per request (repo's `estimateTokens`, conservative), system prompt + reply guidance + persona reminder, original vs now:

| Path | Before | After |
|---|---|---|
| Strawberry | 4457 | 4444 (-13, -0.3%) |
| Choco Hazelnut, standard context | 5325 | 5183 (-142, -2.7%) |
| Choco Hazelnut, compact context (default) | 4279 | 4823 (**+544, +12.7%**) |

The compact path had no craft guidance or persona reminder, so it grows. The craft block is most of it (about 550) and the anchor about 110. A known remaining duplication is between the mature-mode tier line and the Plus voice notes; consolidating it would pay for much of this, but it changes the adult-mode prompt, so I left it. The director adds 0 tokens on a healthy turn and about 280 in the worst case (all seven steers at once, which takes a very repetitive chat).

## Verification

- `node --test tests/*.test.cjs`: **179 / 179 pass** (97 original, 82 new: craft, director, polish, anchor, flags, metrics, telemetry, statistics, report, scripts, provider system-message fold against a mock strict endpoint, and the real chat route).
- Statistics checked against independently computed values; retention logic checked on synthetic users with known return rates; flags checked for stickiness, honoured percentage, and independence.
- Fuzzed with 15,000 + 20,000 seeded hostile inputs (stray markers, regex metacharacters, NULs, Hindi/CJK, RTL, `__proto__`): no crash, no emptied reply, stable asterisk repair, anchor data always parses back. Found and fixed an unstable repair and a brittle telemetry builder along the way.
- Type-check: zero errors in touched files; the 20 remaining errors are the missing generated Prisma client, same as the original.
- **Not verified:** live provider behaviour, whether models obey the craft block, and whether any arm actually improves retention. That is what the experiment is for.

## Second audit (adversarial re-check)

Re-checked on a clean extract of the final package: full build, full suite, whole-project type-check with a permissive Prisma shim (so the 20 Prisma-caused errors cannot hide real ones; none did), and probes of each heuristic and script with realistic input. Found and fixed:

- **Strict-template providers would reject the anchor** (reproduced with a mock endpoint that answers 400 to a mid-conversation system message). A 400 does not trip the circuit breaker, so such a provider would have been skipped silently on every request. Fixed by the fold-and-retry above; covered by `tests/provider-system-fold.test.cjs`.
- **The closer stripper could leave broken text:** "So... what would you like to do next?" became a bare "So...". The lead-in word is now removed with the closer.
- **The closer stripper deleted genuine in-character questions** ("How does that sound?" after an offer, "Where do we go from here?" at a crossroads, "What happens next?", "Shall we continue?"). Those four patterns were removed; only unmistakably assistant-voiced closers remain ("What would you like to do next?", "Anything else I can help with?", "Let me know if you'd like to continue"). A missed tic costs less than a deleted question.
- The two report scripts printed a raw stack trace on a missing file or invalid JSON; they now exit 1 with a message.

Known and left as is: the turn director's `agency` steer can fire on innocent narration such as a hand resting on "your knees" (it only adds a soft steer, never edits text); `ai:` / `character:` at the very start of a reply are treated as leaked labels even in a rare sci-fi line; the telemetry salt defaults to a constant, so set `ROLEPLAY_TELEMETRY_SALT` in production.

## Earlier audit findings (already fixed)

Speech-only chats were pushed into actions; the closer stripper deleted real lines ("What do you think?"); short charged turns ("I love you") were told to stay small; speaking for the user was undetected; asterisk repair was unstable on tangled input.

## Deliberately not done

- Repetition penalties (`frequency_penalty` / `presence_penalty`): per-model acceptance across your providers is unconfirmed and a rejected field would break the fallback chain.
- Raising tier word ceilings: the retention study favours longer replies, but the tier envelope is a pricing and cost decision.
- A non-English stock-phrase list: repeated lines in any language are still caught by the three-word repeat check.

## Tuning

Director thresholds are named constants at the top of `turnDirector.ts`. Add patterns to `STOCK` / `STOCK_CLOSERS` / `ASSISTANTISMS` when you see new tics in real chats.
