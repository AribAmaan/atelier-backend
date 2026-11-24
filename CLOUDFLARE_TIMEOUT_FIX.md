# Image generation speed + Cloudflare timeout fix

## Root cause
1. Cloudflare Workers AI shared `IMAGE_GEN_TIMEOUT_SECONDS` (45s) with Pollinations
   and DiceBear, so it had no deadline of its own.
2. Pollinations always went first, so a slow/failing Pollinations call used up to
   45s *before* Cloudflare (a 4-step model that normally answers in seconds) even started.
3. Nothing capped the total wait across providers.

## What changed
- **Cloudflare first** for normal jobs, Pollinations as fallback.
  **Explicit characters keep Pollinations first** (its uncensored model is built for
  them), Cloudflare second.
- **Total time budget**: `IMAGE_GEN_TOTAL_BUDGET_SECONDS` (default 75, range 10-300).
  Every provider attempt (including Pollinations' internal retries) is clamped to the
  time left; a provider is not started with < 5s left. DiceBear (avatars) still gets a
  short slice so a customer gets an image instead of an error whenever possible.
- **Cloudflare deadline**: `CLOUDFLARE_IMAGE_TIMEOUT_SECONDS` (default 60, range 1-300),
  total including one retry. `IMAGE_GEN_TIMEOUT_SECONDS` still controls Pollinations/DiceBear.
- **One retry** (1s delay, only if >= 10s remain) for momentary Cloudflare failures:
  HTTP 5xx, capacity error 3040, dropped connections. Never retried: timeouts, 401/403,
  429/quota, other 4xx.
- **Cloudflare circuit breaker**: on quota exhaustion (daily neuron limit / error 4006) or
  429, Cloudflare is skipped for 120s instead of wasting a call on every request; after
  3 consecutive timeouts it is skipped for 30s. Overridable via
  `CLOUDFLARE_IMAGE_COOLDOWN_SECONDS` etc.
- **Smaller backgrounds on Cloudflare**: 1536x864 (exact 16:9) instead of 1920x1080 -
  about 36% fewer pixels, so faster and cheaper. The background route already resizes
  to 1920x1080 (cover), so the final image size is unchanged. Avatars stay 1024x1024.

## Files
src/lib/providers/mediaHttp.ts, src/routes/avatar.ts, src/lib/providers/cloudflare.ts,
render.yaml, .env.example, tests/image-generation.test.cjs.

## Render settings (already in render.yaml; set them on an existing service)
CLOUDFLARE_IMAGE_TIMEOUT_SECONDS=60, IMAGE_GEN_TOTAL_BUDGET_SECONDS=75.
Worst case a customer waits ~75s (plus a few seconds for the DiceBear avatar fallback),
not ~165s. If your frontend or proxy cuts requests earlier, lower
IMAGE_GEN_TOTAL_BUDGET_SECONDS.
