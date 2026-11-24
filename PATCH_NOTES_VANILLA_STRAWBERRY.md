# Vanilla / Strawberry completion fix

## Diagnosed causes

1. `nvidia/nemotron-3-super-120b-a12b` was receiving the per-engine sampling values (Vanilla 0.74/0.91, Strawberry 0.79/0.92) instead of the model's tuned NVIDIA settings (temperature 1.0, top_p 0.95).
2. Nemotron 3 thinking was already disabled, but `nvidia.ts` still added a blanket +512-token "reasoning buffer". With thinking off, that let short tiers generate far beyond their intended envelope and forced a later server-side cut.
3. Strawberry's 104-token native budget was unnecessarily close to a 50–70 word roleplay reply and could still produce a genuine `finish_reason=length` on punctuation/action-heavy output.
4. The live-stream ceiling could expose text up to the exact word cap and then `reply_final` would roll the UI back to an earlier sentence boundary. Preserving the hard-capped stream avoided the rollback but could leave an incomplete sentence.

## Fixes applied

- Nemotron 3 Super now uses `temperature=1.0` and `top_p=0.95` only on NVIDIA; the engine-specific values remain intact for Groq/SambaNova/etc.
- Nemotron 3 keeps `enable_thinking=false` and no longer receives the obsolete +512 max-token padding.
- Removed the undocumented `force_nonempty_content` chat-template kwarg.
- Strawberry native generation budget increased from 104 to 144 tokens; same-provider continuation budget is 128.
- Vanilla same-provider continuation budget is 96.
- Vanilla/Strawberry live output now exposes only sentence-complete prefixes inside their word ceiling, then releases the reconciled final tail. This prevents the visible "generate longer, then cut backward" effect and avoids displaying a mid-sentence hard cap.
- The local clamp now prefers a complete earlier sentence over chopping a later sentence at an arbitrary word; if that lands below the tier minimum, the existing same-provider depth top-up can fill the missing depth.
- Tier guidance explicitly tells the model to wrap up before the hard word ceiling.
- Provider logs now include `finishReason` and continuation count for easier production diagnosis.

## Validation performed

- TypeScript syntax/transpile validation passed for all modified provider files.
- Targeted tests passed for Vanilla/Strawberry overrun reconciliation and same-provider token-limit recovery.
- A mocked Nemotron Super request verified the outgoing body uses temperature 1.0, top_p 0.95, `enable_thinking=false`, and the real tier max-token value without +512 padding.
