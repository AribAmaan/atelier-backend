# Pollinations image-generation reliability fix (audited & corrected)

This file replaces the earlier notes, which contained inaccuracies. Everything below was
checked against the original ZIP and by running the code and tests.

## What the Render logs actually mean
- `402 FREE_LIMIT` / `503 SERVICE_UNAVAILABLE`: the *legacy anonymous* endpoint
  (image.pollinations.ai) enforces 1 image / 45 s / IP and sometimes runs out of capacity.
- `Pollinations request timed out after 15s`: your live service evidently has
  `IMAGE_GEN_TIMEOUT_SECONDS=15` set in the Render dashboard (the code default and the
  render.yaml value were already 45).
- Cloudflare `code 3030` ("output has been flagged"): Cloudflare's own safety filter rejected
  the generated output. It is not a Pollinations error.

## What changed vs. the original ZIP
1. **Key path.** The original already read `POLLINATIONS_API_KEY` (as `?key=` on the legacy
   endpoint). Now, when the key is set, requests go to `https://gen.pollinations.ai/image/...`
   with `Authorization: Bearer <key>` (never in the URL). Without a key the legacy endpoint is
   still used, best-effort.
2. **402 / 503 / timeout handling.** These now open the Pollinations circuit breaker
   (45 s for a 402 without a hint, 30 s for 503, or the provider's `Retry after N s` /
   `Retry-After` value) and fall straight through to Cloudflare. The original did not treat
   402/503 as rate limits, so every job re-hit Pollinations.
3. **Anonymous 45 s cooldown.** Without a key, a *successful* Pollinations call also opens a
   45 s cooldown (verified by test and a manual probe: 4 back-to-back jobs -> 1 Pollinations
   call, 3 Cloudflare calls). Anonymous jobs are also serialized.
4. **Steps / sizes.** Safe model (`lykon/dreamshaper-8-lcm`): 8 steps instead of 35.
   Avatars 768x768 (Cloudflare avatars remain 1024x1024). Explicit model keeps 35 steps / 1024.
5. **Backgrounds are unchanged at native 1920x1080.** The original already generated them at
   1920x1080 (no 1024x576 upscaling ever existed in the original or this ZIP). The only change
   for safe backgrounds is steps 35 -> 8.
6. **Separate timeouts.** `POLLINATIONS_TIMEOUT_SECONDS` (20), `POLLINATIONS_BACKGROUND_TIMEOUT_SECONDS`
   (35), `CLOUDFLARE_IMAGE_TIMEOUT_SECONDS` (45). If these are unset, Cloudflare gets at least 45 s
   even when `IMAGE_GEN_TIMEOUT_SECONDS` is lower in the dashboard.
7. **Cloudflare safety retry.** For characters NOT marked 18+, a 3030 rejection is retried ONCE
   with explicit safe-for-work framing around the same prompt. It is not retried for 18+
   characters, so it cannot help explicit-character avatars/backgrounds.

## Corrections made in this audit
- `isRateLimitError` restored to its original chat-provider meaning. The earlier patch had
  added 402/503/FREE_LIMIT to it globally, silently changing chat failover. Image-specific
  402/503 handling stays in `avatar.ts`.
- Retry-hint regex now requires a seconds unit (the earlier one parsed "retry in 2 minutes" as 2 s).
- Tests: 81/81 pass (77 existing + 4 new breaker tests).

## Still unverified (needs a live call with your key)
- That `gen.pollinations.ai` accepts `steps`, `safe`, `enhance`, `nologo` for DreamShaper.
- That `vendouple/uncensored-image-enhanced` (the explicit model) still exists on gen.pollinations.ai.
  If it does not, explicit avatars will fall to Cloudflare, which flags explicit output.
- Image quality of an SD1.5-class model (DreamShaper 8) at 1920x1080. These models are trained
  near 512 px and can show duplicated subjects at large sizes. Compare against 1280x720.

Quick live checks (run locally; do not paste your key anywhere public):
    curl -s https://gen.pollinations.ai/image/models | grep -i -E 'dreamshaper|uncensored'
    curl -s -o /tmp/t.jpg -w '%{http_code}\n' -H "Authorization: Bearer $POLLINATIONS_API_KEY" \
      'https://gen.pollinations.ai/image/a%20castle?model=lykon/dreamshaper-8-lcm&width=1920&height=1080&steps=8&nologo=true'
