# Backend debug report — 28 September 2026

## Confirmed fixes

1. **Media requests could hang after response headers.** Pollinations, Cloudflare,
   DiceBear and Groq speech cleared their timeout before downloading the body.
   A shared bounded downloader now keeps a deadline through the final byte,
   aborts timed-out requests, cancels unused streams and limits response memory.
   Success responses are capped at 21 MiB (enough for a 15 MiB base64 image);
   unsuccessful responses retain at most 4 KiB for bounded error handling.
2. **Invalid image responses broke fallback.** An HTTP 200 containing HTML,
   corrupt image data or invalid Cloudflare base64 could be treated as success,
   preventing the next provider from running. Each attempt now verifies the
   image format, pixel/byte limits and actual decoding before it succeeds.
3. **Bad timeout settings could cause near-instant failures.**
   IMAGE_GEN_TIMEOUT_SECONDS accepts 1–120 seconds, defaults to 45 seconds,
   and falls back to 45 for invalid values. Previously it defaulted to 15 and
   accepted NaN/negative values. Existing valid overrides remain respected.
4. **Placeholder generation was invisible in the API response.** Character,
   background and profile generation responses now add imageGeneration with
   provider and isFallback. Existing character/user response fields remain.
   isFallback is true for DiceBear placeholders; frontend display requires
   consuming this new optional metadata.
5. **Voice playback had the same body-download hang.** Groq speech now uses
   the bounded media downloader too.
6. **Ollama readiness leaked resources.** Its unused response body is cancelled
   and the timer is cleared on success and failure.
7. **Registration accepted emails the database cannot store.** Email validation
   now matches the existing User.email VARCHAR(191) column, rejecting oversized
   input before persistence. No schema change or new migration is required.

## Klein multipart verification

The uploaded ZIP already contained the correct REST FormData approach for
FLUX.2 Klein 4B. This was retained and regression-tested, including automatic
Content-Type boundary generation, dimensions, raw image responses, JSON image
responses and error envelopes. Model IDs and provider order were preserved.

Reference checked: https://developers.cloudflare.com/changelog/post/2026-01-15-flux-2-klein-4b-workers-ai/

## Verification completed

- Clean npm ci and Prisma Client generation: passed.
- Original TypeScript build and existing tests: 48 passed.
- Updated TypeScript build and complete suite: 66 passed, 0 failed.
- 18 new tests exercise deadlines, cancellation, size limits, response parsing,
  real image decoding/fallback, queue release, TTS, readiness and email length.
- Prisma schema validation: passed using a dummy local DATABASE_URL.
- Startup smoke check: anonymous auth/me returns 200, untrusted origin returns
  403, and SIGTERM shuts down with exit code 0.
- npm audit --omit=dev: 0 reported vulnerabilities at check time.

## Deploy notes

Upload/commit the contents of the project directory to your existing backend
repository and redeploy using your existing Render setup. The ZIP excludes
node_modules and dist; npm ci and npm run build recreate them.

Set IMAGE_GEN_TIMEOUT_SECONDS=45 in Render if an older value such as 15 is
still configured. The code validates this setting, and render.yaml plus
.env.example now document the default. Preserve your existing credentials.

The Cloudflare model remains @cf/black-forest-labs/flux-2-klein-4b. A valid
CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are still required. Image storage
still needs your existing B2 settings. Increasing a deadline does not fix
provider outages, quota exhaustion, invalid credentials or provider rejection.

## Limits of this audit

This was a source review, local build, regression tests and startup smoke test.
No production database, live provider credentials, B2 storage, payment account,
email delivery or deployed frontend was exercised. Provider tests use mocks
and real image decoding; they do not prove current upstream availability or
model compatibility outside the documented Klein request. No deployment was
performed. Queue and rate-limit state remain per process, suitable for the
existing single-instance design, not shared between multiple instances.

Earlier reports in this archive describe previous patches; this file describes
only this audit and its verified changes.
