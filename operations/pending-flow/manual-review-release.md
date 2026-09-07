# Staff receipt review and 15-minute window — 2026-09-07

Live: https://picklestreet.pages.dev/

Deployment: https://386c55bc.picklestreet.pages.dev/

Scope: Pickle Street Tugbok only, tenant
`f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a` in project `neqvrwtofiolcuxewdze`.

## Delivered behavior

- Pending receipt cards show Confirm and Reject. Either opens the receipt review
  dialog; the card action itself does not finalize a payment.
- Staff confirmation records `approved` and displays “Confirmed by staff.”
  Automatic approval retains its separate `auto_approved` status.
- Reject requires a reason. Rejecting an initial payment releases its reservation.
  Rejecting a reschedule adjustment preserves the original paid booking. Previously
  accepted money is never erased by rejecting an additional-payment receipt.
- Automatic parser failures stay Pending. Staff can retry the parser or review the
  payment, with no automatic rejection behavior added.
- Receipt timestamps use a 15-minute window from the original reservation. Boundary
  tests accept 15 minutes and reject 16. Retrying does not extend the court hold.
  Historical receipt results retain the actual window used by the recorded check.
- Approval rechecks the current receipt attempt, pending status, court availability,
  and applicable schedule before committing. Repeated requests are idempotent;
  replaced proof and late OCR workers cannot overwrite a staff decision.
- The shared before-play rule remains intact: a booking whose court time has begun
  cannot be confirmed. The dialog shows a clear reason and dims Confirm.
- Private receipt previews remain available. Removed the unrelated balance due date
  from ordinary full-payment booking cards.

## Release and isolation

Applied `004-staff-payment-review.sql` only after validating its exact hash against
the live schema in a rolled-back transaction. The application record is
`manual-review-migration-release.json`; do not reapply this migration.

Only `picklestreet-receipts` was redeployed from the authoritative nested backend
directory. The seven existing Pickle Street guard functions were extended with
tenant-scoped staff audit checks. All 48 pre-existing shared SQL function definitions
match the baseline. No Paddle Rage code or other tenant records were changed.

Cloudflare deployment used the existing project and Pages write authorization.
Private database tools and backend source remain excluded from public files.

## Verification

- 99 application tests passed.
- 34 Deno parser and Edge request tests passed.
- 18 live-schema database checks passed inside a rolled-back transaction, including
  both decisions, idempotency, stale evidence, expired holds, occupied courts,
  reschedule preservation, partial payment preservation, and automatic approvals.
- 13 live endpoint access checks passed, including unsigned staff actions, invalid
  tenant/origin, invalid private capabilities, and denied direct database decisions.
- Public deployment, tenant readiness, private-source exclusion and domain checks
  passed. The final build checked 17 scripts and 28 permitted public files.
- Browser inspection confirmed both card actions and private image rendering.
  The remaining started booking displayed a disabled Confirm, enabled Reject and
  the 15-minute notice with the before-play explanation. No console errors appeared.
- During the live inspection, the future booking became confirmed/paid through a
  completed staff review. Read-only inspection verified the resulting badge and
  received-payment total. QA automation did not click a final decision button.
- No synthetic test bookings remain. Tests used synthetic evidence; they did not
  represent bank transfers or verify receipt evidence against a bank ledger.

Evidence: `manual-review-rollback-validation.json`, `isolation-check.json`,
`live-access-checks.json`, and `../cloudflare-release-verification.json`.
