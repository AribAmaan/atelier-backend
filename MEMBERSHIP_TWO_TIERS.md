# Membership: only two tiers (free and paid)

Before: free, plus (INR 1,099), ultra (INR 1,699), supreme (INR 4,199). The only thing a tier gated was the engine, and with
one paid engine (Hazelnut) ultra and supreme had nothing extra to sell.

Now: **free** and **plus** (the single paid plan, which unlocks Hazelnut).

## Backend changes
- `engines.ts`: `MembershipTier = "free" | "plus"`. New `normalizeMembershipTier()`: `plus`, `ultra` and `supreme` all mean paid
  (`plus`); anything else (missing, unknown, wrong case) means free. `resolveEngineForTier` normalizes whatever it is given.
- `chat.ts`: the account's stored tier goes through `normalizeMembershipTier`.
- `payments/razorpay.ts`: `MembershipTierId = "plus"`, one monthly price (INR 200), `isMembershipTierId()`.
- `billing.ts`: new checkouts accept only `plus`. Retired ids (`ultra`, `supreme`) are rejected so a stale app can never be charged a
  price different from the one it showed. `GET /billing/me` returns the normalized tier. Activating an old unpaid
  `ultra`/`supreme` order still works and sets the account to `plus`; a renewal extends from the current expiry for any paid account.

## Existing data: nothing to migrate
Current ultra/supreme subscribers keep paid access automatically (treated as plus until their renewal date, after which `auth.ts`
already drops expired accounts to free). Optional tidy-up, not required:

    UPDATE `User` SET `membershipTier` = 'plus' WHERE `membershipTier` IN ('ultra', 'supreme');

## Decision for you
The single plan price is INR 200 per month (down from the old Plus price of INR 1,099). Quarterly is x2.85 (INR 570) and yearly x10 (INR 2,000). Change it in two places and keep them equal:
`MEMBERSHIP_MONTHLY_PAISE` here and `MEMBERSHIP_TIERS` in the frontend `lib/premium.ts`. Existing ultra/supreme subscribers
who paid more are not refunded or repriced by this change; handle that outside the code if it matters.

Tests: `tests/membership.test.cjs` (new) and the tier checks in `narration.test.cjs`; 100 tests pass.

## Important: the paywall is still off by default
`resolveEngineForTier` only blocks Hazelnut for free accounts when the environment variable `ENFORCE_ENGINE_TIERS=true` is set (it was
already off before this change). Until you set it, every account, free or paid, can use Hazelnut. Set it when you turn on payments
(`PREMIUM_PAYMENTS_ENABLED` in the frontend).
