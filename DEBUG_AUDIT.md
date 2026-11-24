# RoliChat Backend Debug Audit — 2026-09-27

This build was audited across authentication, character CRUD/discovery/remix, chat persistence and memory, provider fallback/streaming, image storage/generation, moderation, retention, billing, deployment config, and the narration-awareness regression path.

## Fixes applied

1. **Critical: Discover privacy leak closed**
   - `/api/characters/discover` previously used Prisma `include` without an explicit scalar projection, which returned every `Character` scalar field.
   - Public responses could therefore expose private/internal fields such as `memorySummary`, `summarizedThrough`, `roleplayNotes`, `explicitEverUsed`, `flagCount`, and `isHidden`.
   - The route now uses an explicit public-field `select`, so current private state is excluded and future private columns are not automatically published.

2. **Chat chronology made deterministic**
   - Message history and summarization previously sorted only by `createdAt` even though MySQL timestamps have millisecond precision.
   - Messages written in the same millisecond could be returned in an unstable order, which is unsafe for the positional `summarizedThrough` cursor.
   - Chronological reads now use `(createdAt, id)` consistently; reverse reads use both fields in descending order.
   - Edit/delete cursor-position checks and edit-tail deletion now use the same tie-break rule.
   - Hazelnut older-history recall uses the same boundary rule.

3. **Dashboard latest-message tie fixed**
   - The previous `MAX(createdAt)` join could return more than one latest row when two messages shared a timestamp.
   - The query now deterministically selects one latest row using `(createdAt, id)` ordering semantics.

4. **NVIDIA false-failover timeout corrected**
   - Comments documented a 14-second time-to-first-token default, but live code still used 6 seconds.
   - The default is now 14 seconds. Mid-stream stall detection remains separately protected by the existing 20-second floor.
   - `NVIDIA_TIMEOUT_SECONDS` still overrides the default.

5. **Schema documentation corrected**
   - Removed the stale claim that Discover never contains explicit characters; the implementation intentionally has separate SFW and explicit galleries.

## Validation performed

- All 44 TypeScript source files were passed through TypeScript syntax transpilation: **0 syntax diagnostics**.
- `render.yaml` parsed successfully.
- `package.json` and `package-lock.json` parsed successfully.
- Narration-awareness regression suite: **19/19 passing**.
- Existing protections reviewed and retained: Razorpay signature verification/idempotent row locking, image-byte validation before B2 upload, authenticated ownership checks, rate-limit paths, retention anonymization, provider partial-stream preservation, and narration/private-thought labelling.

## Environment limitation during audit

A clean `npm ci` could not finish in the analysis sandbox because dependency downloads repeatedly timed out; an offline retry confirmed at least one required tarball was not cached. Because the interrupted install left `node_modules` incomplete, a full `tsc` semantic build in this sandbox reports missing type-definition packages. Those errors are dependency-install artifacts, not source syntax errors. The ZIP intentionally does **not** contain the partial `node_modules` or generated `dist`; Render should install from the unchanged lockfile and build normally.
