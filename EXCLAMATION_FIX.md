# Natural reactions / exclamations fix

**Cause:** the `REACTION` rule in `src/lib/conversationAwareness.ts` told the model that many turns need no
exclamation or interjection and not to add them to prove feeling. Nothing in the code strips exclamations;
the flat replies came from that prompt wording. (Same text was in the RoliChat-Backend-Klein4B zip.)

**Change:** `REACTION` is now fully context-driven. A short spoken reaction (a laugh, "oh", "wait", a sharp breath) is allowed only when the moment really calls for it (surprising, funny, tender, annoying, intense). Most turns are ordinary and get no exclamation at all; it is never added as filler or to sound lively, and the same sound is never reused in consecutive replies. `tests/reply-repeat.test.cjs` updated.

## Model config (NVIDIA Nemotron 3.5 Super VL, Groq Qwen 3.8 Flash)
- `nvidia.ts`: `IS_NEMOTRON_3_SUPER` now also matches `nvidia/nemotron-3.5-super-vl-120b-a12b`, so it gets
  temperature 1.0 / top_p 0.95 (NVIDIA's documented sampling) and `enable_thinking=false`. Before this, the Super VL
  string fell through to the per-tier temperatures. Code default for `NVIDIA_MODEL` is now that model id.
- `groq.ts`: `SUPPORTS_REASONING_EFFORT` now accepts `qwen3.x-flash` / `-flash-next`. Before, a Flash model id
  did not match, so `reasoning_effort: "none"` was never sent and `MAX_TOKENS` tripled to 3072.
  Escape hatch if Groq rejects "none" for your Flash id: `GROQ_REASONING_EFFORT=default`.
- `render.yaml`: `GROQ_MODEL` and `NVIDIA_MODEL` are `sync: false` so a blueprint sync cannot overwrite the
  values you set in the Render dashboard.
- Set `GROQ_MODEL` in Render to the exact id Groq lists for your Flash model.

## Speaker handoff (character switching inside a chat)
**Problem:** each chat is bound to one character, and text in *asterisks* was treated only as unspoken narration, so
"*amy comes to my room* *Abigail out of the conversation for now* come in amy" was still answered by Abigail.

**Fix:**
- `roleplayInput.ts`: new `SPEAKER HANDOFF` rule (in every system prompt). Scene directions can bring another character in
  or mark the current one out; the incoming character answers, opening with "Name: ", and stays the speaker until the user
  changes it. A name that is only mentioned does not switch.
- `buildCastHandoffGuard`: finds the user's other characters whose names appear (whole word) in the latest message or recent
  messages and adds their profile (personality + backstory, bounded) to the per-turn guard. Syntax match only; the model
  decides from the scene whether a handoff happens. This is per-turn, so the cached system prompt is unaffected.
- `chat.ts`: loads the user's other characters (max 60, name/personality/backstory only) and appends the guard. A failed lookup never blocks chat.
- `withPersonaAnchor` reminder now says the handoff overrides "answer as the chat's character".
- `tests/speaker-handoff.test.cjs` added.

Note: the incoming character's reply is stored in the same chat, so the UI still shows it under the chat character's avatar; the "Amy:" prefix marks who spoke.
