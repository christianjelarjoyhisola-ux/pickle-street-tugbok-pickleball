# Court promotions

In the owner dashboard, open **Courts → Pricing Tiers**. Each time range has a standard hourly rate, an optional promo rate, and a **Promo enabled** checkbox. Save Tiers applies the complete shared schedule to every Pickle Street court.

For the requested offer, enter standard **₱200** and promo **₱150**, enable the promotion, and save. Turning it off restores ₱200 while retaining ₱150 for later. No offer was activated during this release: all three existing courts remain at the user's **₱1/hour testing rate**.

The welcome offer and crossed-out regular prices appear only for enabled promotions. Mixed schedules use “Promo from” and “selected times.” Promotions apply to regular court rental; the separately configured booking fee and any equipment rental remain separate. Existing bookings keep their saved amounts, including payment retries after a price change. Future reschedules continue to use the existing current-price/top-up rules.

The updated manager adapters reject stale court revisions. If another manager saves first, reload the latest court settings before applying a new edit. Typing during a save preserves the newer unsaved draft. Existing cached clients cannot strip promo metadata or forge an effective price through the old shared court endpoint.

## Implementation and release

- Public/client helper: `court-pricing.js`.
- Backend migration: `pending-flow/006-court-promo.sql`.
- Fixed project: `neqvrwtofiolcuxewdze`; tenant: `f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a`.
- Only five new tenant-specific functions and a trigger restricted to this tenant. No existing public function bodies, court rows, or tenant rows changed during installation.
- `node tools/court-promo-platform.cjs validate` assembles and executes the pre-installation rollback suite. Synthetic courts, holds, access tokens, and test prices are rolled back together. It must run before initial installation; rerunning the migration after installation is deliberately refused.
- `node tools/court-promo-platform.cjs apply` requires the matching successful validation hash, verifies unchanged existing functions and rows before committing, and records its result in `pending-flow/court-promo-migration-release.json`.

Verification includes 165 frontend regressions, 26 database rollback groups, mobile/desktop welcome checks, and both admin color modes. Booking integration exercises the actual protected group route: a ₱150 court tier plus the current ₱1 fee totals ₱151; after disabling the promo, a new ₱200 court booking totals ₱201 while existing ₱151 holds remain unchanged.
