# Payment sources and shared GCash recipient — 2026-09-08

Live application: https://picklestreet.pages.dev/

Pages deployment: https://b55440b5.picklestreet.pages.dev/

This release implements the requested payment behavior as well as its settings
layout. It is restricted to Pickle Street Tugbok, tenant
`f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a` in project `neqvrwtofiolcuxewdze`.

## Settings and checkout

- GCash, BDO Pay, Maya, BPI, GoTyme and MariBank share one receiving GCash
  account name, number and QR. Source checkboxes control customer availability.
- Each source retains its own receipt parser, reference entry rules and automatic
  checks. BDO aliases resolve to one canonical method. Unreadable, mismatched,
  unsupported and duplicate proof remains Pending for staff review.
- BDO Pay requires the exact private QR alias and complete destination token.
  BPI requires the alias and visible token suffix. These settings are manager-only
  and are not returned by public bootstrap or receipt-status responses.
- PNB has an independent destination and manual-review fallback. Cash is recorded
  through the staff booking flow. No Xendit integration is used.
- The 15-minute introduction and payment countdown use the actual server hold
  expiry. Refresh, background tabs and retries cannot restart the hold. Expiry
  preserves the private payment case and refreshes availability.
- Automatic checks never reject a booking. Explicit staff Confirm and Reject
  decisions from the previous release retain their protected audit trail.
- Save shows persistent progress and success/error feedback. Payment-only edits
  preserve unchanged email settings. Empty disabled payment methods cannot block
  a save, and a successful write remains successful if its readiness refresh
  fails. Interrupted writes request a reload before retrying; they are not
  resubmitted automatically.

The screenshot's receiving account, QR alias and token were never imported.
The migration enabled no methods and changed no existing venue settings. The
owner selected all six GCash sources and their own recipient in the live settings
while the release was being checked. Customer options follow that saved state.

## Isolation and verification

`005-source-payment-routes.sql` was validated before application using its exact
SHA-256 hash. It introduces fixed-tenant tables and a separate approval function;
only the existing Pickle Street initial/balance finish dispatchers are replaced.
The 48 baseline shared SQL functions remain unchanged. Both new tables use RLS
and fixed-tenant checks. Browser access to their private data is through scoped
manager functions only. The migration backfills hashes into the new reference
ledger without rewriting historical bookings or payments.

Reference claims use source namespaces and a shared InstaPay namespace to prevent
cross-provider replay. Claims, payment settlement, availability checks and staff
decisions commit atomically. Stale attempts and changed recipient settings cannot
approve. Pending reschedule adjustments preserve the original paid booking.

Validation evidence:

- 124 Node application tests passed, including Save, revision and connection-failure
  cases, shared-recipient propagation, payment references and timer behavior.
- 81 Deno parser, receipt-route and service-context tests passed.
- 11 source-route SQL groups passed in rolled-back transactions against the
  actual database schema.
- The existing initial-payment (11), balance (7) and manual-review (18) SQL
  regression checks passed with the new migration installed inside rollback.
- 16 live access checks passed, including denied anonymous private-settings
  reads, writes and direct automatic approval.
- Public pages, domain mapping, venue readiness and private-file exclusion passed
  the Cloudflare release checks. No synthetic booking records remain.
- A fresh live admin load restored all six enabled methods and the saved shared
  recipient. Public checkout displayed those six sources and hid disabled PNB
  and Cash. The final persistent Save status control loaded correctly. A live
  connection interruption during earlier Save testing motivated the explicit
  uncertain-write feedback covered by the regression tests.

Receipt checks verify image evidence; they do not query a bank ledger. Positive
approval tests used synthetic evidence inside rolled-back fixtures, not live bank
transfers. The authoritative deployed Edge source is
`backend/supabase/functions/picklestreet-receipts`; the repository-root reference
`supabase/` directory was not deployed.
