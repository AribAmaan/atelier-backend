# Backend reliability and debugging update

Date: 26 September 2026

This report records the earlier reliability pass on the supplied `atelier-backend-main (16).zip`. Those fixes are included in the current package. The subsequent model/reply changes are documented in `MODEL_REPLY_DEBUG_REPORT.md`. The frontend attachment was unavailable, so frontend behavior and browser integration have not been verified.

## What changed

- **Accounts and sessions:** Reset links are claimed atomically and sibling reset links are consumed. Password changes invalidate existing sessions. Deleted accounts cannot use old sessions or Google sign-in. Expired membership access is removed on the next authenticated request. Input validation rejects invalid dates and passwords that bcrypt would truncate. Clearing a username stores `NULL` instead of a conflicting empty string.
- **Payments:** Checkout verification fetches the payment from Razorpay and requires captured funds with the expected order, amount, and currency before crediting an account. Webhooks enforce the same match. Existing transaction locking prevents duplicate credits. Month-end renewal dates are clamped correctly, and early renewals of the same tier extend its existing expiry.
- **Uploads and images:** Authentication runs before buffering uploaded files. Actual image bytes determine their format, extension, and MIME type. Upload sizes are bounded; malformed files return usable errors. The image proxy restricts the object keys it serves, handles conditional requests and missing files, and closes streams on disconnect. Generation queues preserve FIFO handoff and reject waiting work on shutdown; busy responses use HTTP 503 with a retry hint.
- **Chats and caching:** Clearing a chat now clears messages and memory in one transaction. History and memory mutations are protected while replies or summaries are being saved. Prompt cache keys use a bounded hash of their inputs. Concurrent health checks share a database check and cache it for five seconds.
- **Cleanup and moderation:** Inactivity cleanup requires a successfully sent notice and a full 30-day notice period, then rechecks inactivity inside the deletion transaction. More profile identifiers are scrubbed. Payment records remain retained as before. Concurrent moderation changes lock the character row, avoid counting duplicate reports, and preserve upheld hiding decisions.
- **HTTP and dependencies:** Correct client-IP handling uses Express's configured proxy chain. CORS normalizes configured origins. Bad JSON, oversized uploads, and common database conflicts receive appropriate status codes. Production email failures no longer print account links. Dependencies were updated and unused runtime packages removed.

## Model cost and reply length

The reliability pass left model prompts and generation settings unchanged. The subsequent model/reply update refines generic conversational guidance, compresses instructions, and fixes reply processing while preserving numeric tier budgets and word bands. See `MODEL_REPLY_DEBUG_REPORT.md` for the current measurements and changes to continuation accounting. Actual provider billing depends on usage.

## Verification

Clean `npm ci` (including Prisma client generation) and TypeScript compilation succeeded. All 109 regression tests passed, with zero failures or skipped tests, using Node.js 24.19.0. Coverage includes reset-token reuse, session invalidation, payment capture matching, date and upload validation, queue ordering, retention safeguards, image serving, health-check coalescing, and chat-reset rollback. `npm audit` reported zero known vulnerabilities for the installed lockfile on the verification date; this is a point-in-time dependency check.

Two existing tests needed maintenance: one inspected the most recent prompt-building call instead of the prompt actually served from cache; another required an old phrase rather than accepting the equivalent boundary wording already present. Neither fix changes model instructions.

Database operations and external services in regression tests use mocks. Live MySQL/TiDB transaction behavior, Razorpay capture/webhook delivery, SMTP, Google OAuth, Backblaze, and model quality were not exercised against production services. No live deployment or account changes were made.

## Deploy

Use Node.js 22 or newer. Keep the existing hosted environment values, run `npm ci`, `npm run build`, and start with `npm start`. This patch adds no database schema migration. Retain the normal migration process for any migrations pending from older releases.

**Users must sign in once after this upgrade.** Old tokens lack the credential version now required to invalidate sessions after password changes. The frontend may need to clear a persisted old bearer token when it receives HTTP 401; that integration still needs verification with the frontend ZIP.

Configure production SMTP for account emails. Confirm `TRUST_PROXY_HOPS` matches the hosting path: direct hosting defaults to 0; Render defaults to 1. Rate limiting and chat locks remain per-process, so multiple backend instances would require shared coordination.

The delivery ZIP excludes tests, installed dependencies, generated build files, and secrets. Tests were used for verification and are not required at runtime. Extract it before running the install/build commands.
