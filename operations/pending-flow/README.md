# Pickle Street pending receipt release — 2026-09-07

Live site: https://picklestreet.pages.dev/

Current Pages deployment: https://386c55bc.picklestreet.pages.dev/

Current staff-review update: [manual-review-release.md](manual-review-release.md).

Tenant: `pickle-street-tugbok` / `f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a`

Supabase project: `neqvrwtofiolcuxewdze`

## Behavior

Booking receipts automatically confirm only after the receiving account, amount,
reference, currency, payment timing, image evidence and court availability pass.
Unreadable, unsupported, duplicate, incomplete or mismatched evidence remains
Pending. As of the staff-review update, authenticated venue staff can explicitly
Confirm or Reject a pending receipt after reviewing the payment. Automatic parser
failures never reject a booking. Each staff decision is audited and committed
atomically through the isolated Pickle Street review route.

The Pickle Street receipt payment window is 15 minutes from the reservation's
creation. The existing public booking hold is also 15 minutes. Retries use the
original reservation time; existing saved results retain their recorded timing
policy until rechecked. The shared parser default remains unchanged for other
tenants. Existing platform rules prohibit confirmation after play starts.

Customers can submit corrected proof from their private booking or balance link.
Staff can retry the selected receipt. Retries rerun the parser, preserve receipt
history, reuse the original payment window and never extend the court hold.
Interrupted requests use idempotency keys; simultaneous attempts use leases.

The payment case and reservation are separate. A hold can expire while the receipt
remains pending. Confirmation after expiry rechecks the court and commits all slot
changes together. A reschedule adjustment preserves the original paid schedule
until the additional payment and new reservation both pass. The original booking
can still be used and completed while that adjustment is pending.

The dashboard's Money Received summary now counts verified paid amounts, excluding
pending booking totals. Open Play remains hidden as previously requested.

## Payment method coverage

GCash is the currently configured active method. Its automatic route requires
complete matching receiving-account details and a clearly labelled transferred
amount. Masked or ambiguous details remain pending.

GoTyme has its separate existing destination parser and requires explicit tenant
opt-in before automatic approval. Maya, BDO Pay, BPI, PNB and unknown layouts use
dedicated pending fallbacks until their formats can be validated. They cannot
accidentally pass through the GCash approval route.

This verifies receipt evidence; it does not query a bank ledger. No Xendit account,
integration or transaction was added.

## Isolation and deployment

Only the new `picklestreet-receipts` Edge Function was deployed. It validates the
exact tenant and mapped origin, private booking/balance capability for customer
requests, and active tenant staff or platform-owner authentication for retries.
It does not accept internal credentials on its public routes.

The new tables have fixed-tenant CHECK constraints, RLS and service-only access.
Triggers return immediately for other tenants. The 48 existing shared SQL function
definitions captured before this work were compared after release and are unchanged.
No other tenant's records were changed. The standalone reference `supabase/`
directory in the repository root was not deployed.

Applied migrations:

1. `001-pending-receipts.sql`: original booking receipts, durable attempt history,
   receipt/state guards and atomic confirmation after availability checks.
2. `002-balance-pending.sql`: extra-payment receipts, original-booking protection,
   automatic reschedule settlement and duplicate checks across payment purposes.
3. `003-balance-expiry.sql`: enables the supported Supabase `pg_cron` extension and
   creates one named job, `picklestreet-balance-holds-f19f457a`, every minute. Only
   the database owner can call its wrapper. Its first observed run succeeded.
   Already released pending holds are excluded from future sweeps.
4. `004-staff-payment-review.sql`: isolated authenticated staff decisions, immutable
   decision audit, stale-receipt and late-parser protection, and atomic availability
   checks for initial payments and reschedule adjustments.

Migration files are accompanied by exact-hash validation and application records.
`tools/pending-platform.cjs validate <initial|balance|expiry|manual>` checks unapplied
migrations in a rolled-back transaction. `apply` requires matching validation and
refuses an already-installed workflow. Do not reapply an installed migration.

Backend deployment uses the function source under `backend/supabase/functions`,
with its explicit `deno.json` import map. Platform JWT gateway checking is disabled
only for this function because the handler implements customer capability and staff
authentication itself; private database functions remain unavailable to guests.

## Original pending-flow verification

- 83 application regression tests passed.
- 26 synthetic receipt/parser and request-guard tests passed.
- 11 original-payment and 7 extra-payment checks passed against the actual live
  database schema inside transactions that were rolled back.
- Scheduler configuration and private access passed rollback validation; a real
  scheduled run succeeded after deployment.
- 10 live access checks passed, including wrong tenant/origin, invalid private
  links, unsigned staff retries and denied direct database operations.
- Cloudflare release checks passed for public pages, tenant readiness, private-file
  exclusion, domain mapping and active courts.
- The corrected receipt dialog was inspected on desktop and a 390px viewport.
- Both existing pending receipts were retried through the live dashboard. Both
  remained pending; neither was rejected or confirmed.
- The final dashboard displayed no received payments for those pending receipts
  and produced no browser console errors.

No synthetic booking records remain. Positive approval tests used synthetic
receipt evidence in rolled-back database fixtures, not real bank transfers.

Operational evidence is stored beside this file. Baseline deployed source downloads
are ignored by Git; they can contain large bundles and are never included in Pages.

Supabase scheduling reference: https://supabase.com/docs/guides/cron/install
