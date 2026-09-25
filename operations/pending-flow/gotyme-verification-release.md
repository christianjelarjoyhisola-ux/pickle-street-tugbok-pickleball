# GoTyme verification and duplicate rejection release

Applied to Pickle Street Tugbok on September 24–25, 2026.

- Migration 028 allows a proven reused transaction to be rejected even when recipient details are unreadable. Reliable reference identity and a prior accepted, paid transaction remain required.
- Migration 029 scopes GoTyme v2 Trace IDs to the full transaction reference, preventing short Trace IDs shared by distinct payments from blocking confirmation. Full transaction references remain protected against reuse.
- Migration 030 accepts the GoTyme v2 parser in the database approval gate while preserving recipient, source, reference, status, confidence, and settings checks.
- GoTyme now participates in complete-reading OCR recovery: visual row order followed by an independent text-mode reading. Conflicting references, recipient mismatches, amount mismatches, incomplete transfers, and expired payment windows cannot be cleared by fallback readings.
- Checkout and pending guidance request the complete receipt, including its bottom reference and date/time.
- Rejection emails say the booking was rejected and ask the customer to book again without disclosing the internal duplicate reason.

## Validation

116 targeted OCR, source-route, recipient, and parser tests passed. Nine rejection-email and receipt-result tests also passed. The static build checked 28 scripts and public asset links.

The three database changes passed transaction rollback validation before application. Validation reports and inspected function baselines accompany their operator scripts. The scripts are historical, state-bound release tools; do not rerun their customer-specific validation fixtures or approval/rejection actions as a general test suite.

Production re-reading of the earlier complete GoTyme image still could not verify its recipient number. Its manually confirmed booking remained confirmed and paid. This release enables automatic approval for complete, readable receipts that pass all checks; it does not guarantee approval of every screenshot. No raw receipt image or OCR text is included in this release.

Backend deployment uses only `picklestreet-receipts` and `picklestreet-email-dispatch` from the dedicated `backend/supabase` configuration. Database migrations were already applied; do not replay them to deploy the frontend. The public frontend is built from the release allowlist and deployed to the `picklestreet` Cloudflare Pages project.
