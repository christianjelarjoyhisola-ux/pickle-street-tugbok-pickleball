# Pickle Street grouped rescheduling

Implemented for tenant `f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a` only.

## Staff workflow

Open a confirmed, paid multi-session booking and select **Reschedule**. Choose **All sessions** or **Selected sessions**, set each selected session's new date and time, enter a reason, and review the complete booking. Every session retains its court and duration. One reference, customer, original receipt, and payment history remain attached to the booking.

The final save checks the current schedule, prices, opening hours, blocked times, occupancies, and rain claims. A conflict preserves every original session. Repeating an interrupted save uses the same request identity.

Rain changes preserve paid court-hours and the original price. A cheaper move retains the original paid total. A higher-price customer move creates one 15-minute additional-payment link. Staff can copy that private link from the result or reopen the reschedule dialog to recover it. All original slots stay reserved until successful automatic or staff verification applies the complete change. Expiry releases only the proposed extra holds. Receipt problems remain pending for review.

The optional confirmation email contains all final sessions under one reference. History records before/after sessions; an uncertain email delivery is retained for reconciliation rather than automatically sent twice. The existing Pickle Street dispatcher handles due grouped confirmations.

## Validation

- 219 frontend/data regression checks.
- 137 receipt, service, email, and authorization checks.
- 24 database rollback scenarios, including all/selected sessions, conflicts after review, swaps, idempotency, changing prices, automatic and staff additional-payment settlement, expiry, private RPC permissions, email claims, and a rain claim arriving before settlement.
- 15 browser scenarios at 320, 390, 768, and 1280 px; dark/light layouts, an 18-session review, delayed/out-of-order availability, interrupted saves, stale versions, and expired/cancelled/settled request replays.
- Database migration and validation compared fingerprints across 51 tables to preserve other tenants' rows; unrelated existing function definitions were unchanged.
- Browser services were mocked and database fixtures rolled back. No live test bookings or customer emails were created by verification.

Reports: `pending-flow/group-reschedule-validation.json`, `pending-flow/group-reschedule-release.json`, `group-reschedule-ui-verification.json`, and `group-reschedule-release-verification.json`.

## Deployment

The dedicated configuration is `pending-flow/backend/supabase/config.toml`. Never deploy from the legacy reference configuration in the repository's root `supabase` folder.

After reviewing and validating the migration, `node tools/group-reschedule-platform.cjs apply` installs the exact validated hash. Deploy only `picklestreet-reschedule`, `picklestreet-receipts`, and `picklestreet-email-dispatch` against project `neqvrwtofiolcuxewdze` using the dedicated backend work directory. Each service performs its own authorization; gateway JWT verification is disabled as configured. No other function is deployed.

Build with `npm run build`, deploy with `node tools/deploy-cloudflare.cjs`, and verify with `npm run verify:cloudflare` plus `node tools/verify-group-reschedule-release.cjs`. Capture the pre-deployment function versions using the latter script's `baseline` argument before a release.

## Existing history capacity

The shared manager service returns at most 500 booking rows. Pickle Street date/court filtering now checks actual sessions together instead of only a booking's first court/date. Filtered reads fail clearly at that existing capacity boundary rather than showing incomplete history. Increasing history capacity requires a separate paginated read contract; this release does not modify the shared manager service.

The database rollback script refuses to remove the feature after grouped reschedules have been used, protecting recorded schedules and payment history.
