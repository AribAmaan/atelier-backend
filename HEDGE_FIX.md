# Slow image generation fix

Logs showed Cloudflare Klein timing out at the full 60s on EVERY request, then Pollinations/DiceBear running afterwards (60s + 5-15s = 65-75s per image).

Causes
1. Cloudflare was first in the chain with a 60s timeout and no circuit breaker, so every request re-paid the 60s.
2. Stale IMAGE_GEN_TIMEOUT_SECONDS=15 in the Render dashboard killed Pollinations at 15s.

Changes
- Cloudflare timeout 60s -> 20s (CLOUDFLARE_IMAGE_TIMEOUT_SECONDS).
- Cloudflare circuit breaker: one timeout skips it for 5 min; 429/quota skips it for 60s.
- Hedged chain: if a provider hasn't answered in IMAGE_HEDGE_SECONDS (default 8), the next one starts in parallel; first valid image wins. Fast failures go straight to the next provider.
- Pollinations timeout floor of 30s regardless of IMAGE_GEN_TIMEOUT_SECONDS.
- Two new tests (hedge, breaker); timeout default test updated.
