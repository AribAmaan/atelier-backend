# Backend: two engines, two tiers

Brings the backend in line with the frontend (`FRONTEND_TWO_TIERS.md`): four engines and four tiers become two of each. Nothing is downgraded.

## Engines
| Engine | Tier | What it is |
|---|---|---|
| `strawberry` | free | Strawberry exactly as it was (intelligence 6, 50-70 words, 144 tokens, window 11 / fold at 18, temp 0.79). It takes the free slot Vanilla held, so free chats get a fuller reply than before (35 words -> 60). |
| `choco_hazelnut` | plus | Chocolate + Hazelnut combined. Takes the higher value of every setting: intelligence 10, 105-130 words, 256 tokens, Hazelnut's sampling (0.87 / 0.95), Hazelnut's compact long-memory context and recall, Chocolate's larger verbatim window (15; fold trigger 31 so memory summaries are no more frequent than before). Voice notes, behavior ladder and mature-scene guidance merge both engines' text. The adult-only, consent and "react to hesitation or refusal immediately" rules are kept. |

Old ids still work, so saved browser settings and older clients keep working: `vanilla` -> `strawberry`; `chocolate`, `hazelnut`, `chocohazelnut`, `chocolate_hazelnut` -> `choco_hazelnut` (case, spaces and hyphens ignored). `custom` / unknown ids still mean manual mode.

## Tiers and billing
- Tiers are `free` and `plus`. Accounts stored as `ultra` or `supreme` are treated as Plus everywhere (`normalizeMembershipTier`), and a migration (`20261029120000_two_membership_tiers`) rewrites them to `plus`. Renewal dates are untouched.
- Checkout accepts only `plus`. **Plus is now 20000 paise (INR 200/month)**, matching the frontend (`lib/premium.ts`); quarterly x2.85 and yearly x10 unchanged. Previously INR 1,099. Payments are still off until `PAYMENTS_ENABLED` is on.
- A membership order created before this change (referenceId `ultra`/`supreme`) that is paid afterwards still completes and grants Plus.
- `GET /api/billing/me` always reports `free` or `plus`.
- `ENFORCE_ENGINE_TIERS` is unchanged and still defaults to off (every engine open to everyone). When on, a Free user asking for Choco Hazelnut gets Strawberry plus an `engine_downgrade` event.

## Code
`engines.ts` (two engines, aliases, `normalizeMembershipTier`), `replyPolicy.ts` (dead Vanilla/Chocolate profiles removed), `providers/index.ts` (merged behavior and mature-mode text, voice-note limit in standard mode raised 1000 -> 1800 so the merged notes are not cut), `chat.ts` (premium checks use `PREMIUM_ENGINE_ID`), `billing.ts`, `payments/razorpay.ts`, `schema.prisma` comment, new migration. `HAZELNUT_COMPACT_CONTEXT` and `HAZELNUT_INPUT_TARGET_TOKENS` keep their names so your Render settings still apply.

## Frontend
Use `RoliChat-Frontend-strawberry-choco-hazelnut.zip` with this backend. The older frontend still works because of the aliases above.

## Debugging pass
- Full `tsc --strict` type-check now passes with **zero** errors (generated the Prisma client offline). The 20 errors seen earlier were only the missing Prisma client.
- `npm test`: 97 of 97 pass, including `tests/engines.test.cjs` (engines, aliases, tiers, pricing, merged prompt) and `tests/chat-tiers.test.cjs`, which drives the real chat route with the paywall on: Free gets Strawberry and an `engine_downgrade` event for the premium engine; Plus, ultra and supreme accounts get Choco Hazelnut with no event; unknown tier values count as Free.
- Server boot smoke test: starts, `/api/health` reports the missing database correctly, protected routes return 401, membership checkout is blocked while payments are off.
- Frontend API paths all exist as backend routes. Unused-code warnings are identical to the original upload; nothing new.
- Not exercised: a live database migration and real provider calls.
