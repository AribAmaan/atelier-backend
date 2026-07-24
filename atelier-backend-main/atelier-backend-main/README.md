# Atelier — backend (Express API, deploy to Render)

[![CI](https://github.com/chandiwalaamaan-droid/atelier-backend/actions/workflows/ci.yml/badge.svg)](https://github.com/chandiwalaamaan-droid/atelier-backend/actions/workflows/ci.yml)

This is the API half of Atelier, split out from the original combined Next.js
app so the frontend can be deployed separately on Netlify. It's a plain
Express + TypeScript app — no Next.js in here at all.

Handles: auth (signup/login/logout, JWT session cookie), character CRUD,
avatar upload + optional AI generation, and the streaming chat endpoint with
the free-provider fallback chain (Groq → NVIDIA → Cerebras → Ollama).

## Why split like this

The original app was one Next.js project serving both pages and `/api/*`
routes from the same origin. Splitting it means:

- **Frontend** (Next.js) → **Netlify**
- **Backend** (this folder, Express) → **Render**, which also gives it a
  persistent disk for avatar image uploads (Netlify has no such thing, and
  Vercel's serverless functions have an ephemeral filesystem — Render is the
  right fit here, same as it was for the original combined app).

Since the frontend and backend now live on different domains, a few things
changed from the original single-app version:

- The session cookie is now `SameSite=None; Secure` (was `Lax`) so it can be
  sent cross-site between the Netlify and Render domains. Every deploy target
  here is HTTPS, so this is safe.
- CORS is configured via `FRONTEND_URL`, with credentials enabled, so the
  browser will actually store/send that cookie.
- The old `middleware.ts` edge auth check (which read the cookie directly)
  is gone — the frontend now asks this API "am I signed in?" via
  `/api/auth/me` instead. See `components/RequireAuth.tsx` in the frontend.

Everything else — the provider fallback chain, circuit breakers, rate
limiting, Prisma schema, memory summarization — is carried over unchanged
from the original app.

## Local setup

1. `npm install`
2. `cp .env.example .env` and fill in:
   - `DATABASE_URL` — a Postgres connection string (or point at local SQLite
     and flip `provider` in `prisma/schema.prisma` to `sqlite` for local dev)
   - `FRONTEND_URL` — `http://localhost:3000` for local frontend dev
   - `SESSION_SECRET` — any long random string
   - Whichever chat provider key(s) you're using (all optional individually,
     but you need at least one, or Ollama running locally)
3. `npm run db:push` — pushes the Prisma schema to your database
4. `npm run dev` — starts the API on `http://localhost:4000`

## Deploying to Render

1. Push this folder to its own GitHub repo (or a subfolder Render can point
   at with a custom root directory).
2. In the Render dashboard: **New → Blueprint**, point it at this repo.
   Render reads `render.yaml` and provisions the web service, a free Postgres
   database, and a 1GB persistent disk for avatar uploads.
3. Fill in the secrets Render prompts for: `FRONTEND_URL` (your Netlify site
   URL, once you have it — you can update this after deploying the frontend),
   plus whichever `GROQ_API_KEY` / `NVIDIA_API_KEY` / etc. you're using.
4. Deploy. Note the resulting `https://your-service.onrender.com` URL — the
   frontend needs it as `NEXT_PUBLIC_API_URL`.
5. Once the frontend is deployed and you have its Netlify URL, come back and
   set `FRONTEND_URL` on this service to that URL (comma-separated if you
   also want to allow Netlify deploy-preview URLs), then redeploy.

## How it fits together

- `src/server.ts` — Express app setup: CORS, cookies, static `/uploads`, routes
- `src/routes/auth.ts` — register / login / logout / me
- `src/routes/characters.ts` — character CRUD
- `src/routes/avatar.ts` — image upload (multer) + optional OpenAI-generated avatar
- `src/routes/chat.ts` — streaming chat, conversation reset, memory summarization
- `src/routes/health.ts` — health check for Render + uptime pings
- `src/lib/auth.ts` — JWT session cookie creation/verification (cross-site config)
- `src/lib/db.ts` — Prisma client
- `src/lib/rateLimit.ts` — in-memory rate limiter for login/signup/chat
- `src/lib/providers/` — Groq, NVIDIA, Cerebras, Ollama clients + fallback orchestrator
- `prisma/schema.prisma` — `User`, `Character`, `Message` tables (unchanged)
