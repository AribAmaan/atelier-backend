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
