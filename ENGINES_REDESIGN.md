# Two-engine redesign (free + paid)

Engines went from four (vanilla, strawberry, chocolate, hazelnut) to two.

| | Vanilla (free) | Hazelnut (paid) |
|---|---|---|
| `minTier` | free | plus (the single paid plan) |
| Reply length | follows the context (no word cap) | follows the context (no word cap) |
| Safety token ceiling | 400 | 600 |
| Intelligence | 4 | 10 (unchanged) |
| Verbatim window / summarize trigger | 8 / 15 | 10 / 26 compact (20 / 36 if compact context is off), unchanged |
| Temperature / top_p | 0.78 / 0.92 | 0.87 / 0.95 (unchanged) |
| Style | balanced | intense |

- Vanilla now has the attentive voice of the old Strawberry (small persona-driven choice, relevant detail, mood carried forward), so the free engine is not curt.
- Reply length is no longer an engine property. See REPLY_LENGTH_FIX.md: the old 45-70 / 105-130 word bands were removed.
- Membership is now just two tiers, free and plus. See MEMBERSHIP_TWO_TIERS.md.
- Hazelnut keeps its full prompt, memory and compact-context behavior. The old Chocolate behavior text was folded into its delivery guidance.
- Retired ids still work: a client or saved chat that sends `strawberry` or `chocolate` gets Hazelnut. If `ENFORCE_ENGINE_TIERS=true`, a free account is downgraded to Vanilla with the usual `engine_downgrade` upsell event.
- Membership tiers: free and plus only (see MEMBERSHIP_TWO_TIERS.md). The paywall is still off unless `ENFORCE_ENGINE_TIERS=true`.
- No manual-mode change: a request with no `engineId` still uses intelligence 5, which now maps to Vanilla (it previously mapped to the old 'Balanced' band).
- Frontend: the picker should show only `vanilla` and `hazelnut`. Old docs (`PATCH_NOTES_VANILLA_STRAWBERRY.md` etc.) describe the previous four-engine setup.
