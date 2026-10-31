Latest audit: see [DEBUG_REPORT_2026-09-28.md](DEBUG_REPORT_2026-09-28.md) for fixes, test results and Render settings.

# RoliChat Backend

Node.js 22 or newer + TypeScript backend for RoliChat.

See `ROLEPLAY_REDESIGN.md` for the roleplay response redesign (craft block, turn director, reply polish, adaptive rhythm). See `TOKEN_REDUCTION.md` for the input-token reduction, the guards that keep it, and the levers left for you to decide (`npm run report:prompt` shows per-block sizes). See `TWO_ENGINES.md` for the current engine and membership layout (Strawberry free, Choco Hazelnut plus). See `AWARENESS_UPGRADE.md` for the latest character-awareness and memory-reset changes; `MODEL_REPLY_DEBUG_REPORT.md` and `RELIABILITY_DEBUG_REPORT.md` document earlier reply and reliability fixes. Existing users upgrading from before the reliability release must sign in again once because session tokens now become invalid when passwords change.

## Required project files

- `src/` — API, auth, chat, provider, billing, image and job logic.
- `prisma/` — Prisma schema, migration history and production seed script.
- `anime-characters-with-assets.ts` — anime seed character data used by `prisma/seed.ts`.
- `sfw-premium-characters-with-assets.ts` — SFW seed character data used by `prisma/seed.ts`.
- `prisma/explicit-characters.json` — 18+ seed character data used by `prisma/seed.ts`.
- `package.json` / `package-lock.json` — dependencies and scripts.
- `render.yaml` — Render deployment configuration.
- `.env.example` — environment-variable template.
- `AWARENESS_UPGRADE.md` — current changes, migration, validation, and deployment notes.
- `MODEL_REPLY_DEBUG_REPORT.md` — earlier reply-processing changes and token measurements.

## Local setup

```bash
npm ci
npx prisma generate
npm run build
```

For local development:

```bash
npm run dev
```

## Database

Apply committed migrations:

```bash
npx prisma migrate deploy
```

Seed/update bundled characters:

```bash
npm run db:seed
```

## Production

The included `render.yaml` installs dependencies, applies Prisma migrations, seeds character data, builds TypeScript, and starts `dist/server.js`.

Copy values from `.env.example` into your deployment environment; do not commit real secrets or API keys.
