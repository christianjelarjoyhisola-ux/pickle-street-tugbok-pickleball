# Pickle Street booking audit — 7 September 2026

## Published fixes

Cloudflare production: https://picklestreet.pages.dev/
Release: https://acfc1070.picklestreet.pages.dev/

- Clearing a reschedule date now clears the chosen time and invalidates outstanding availability responses.
- Proposed reschedule payment holds no longer appear as part of the original confirmed booking. Settled replacement slots remain visible.
- A cheaper replacement time no longer misleadingly displays a reduced booked total: the existing backend preserves the original paid total.
- Payment review clears the previous receipt image/link before loading the next one and ignores late responses from an earlier selection.
- Approve, reject, and request-balance actions share an in-flight guard to prevent double submission or competing decisions.
- Receipt rejection collects and sends the required 3–1000 character reason. Balance-rejection messages no longer incorrectly describe all original bookings as pending.
- Frontend approval no longer resends the confirmation email already sent by the backend. An email failure is reported separately from a successful payment decision.
- A failed dashboard refresh no longer reports a committed review as a failed payment action.
- Open Play is hidden from admin navigation, dashboard cards, report tabs/exports, and the service-fee panel. Its public setting and stored records were not changed.
- Hidden controls now remain hidden even when component CSS specifies their display mode.
- Pickle Street's new rain entry points no longer expose the inherited percentage-refund workflow. Staff must handle rain rescheduling; no unused-time backend was implemented by these frontend changes.

## Checks performed

- 65 application tests passed, including 11 booking/payment regression tests.
- 60 separate parser proposal tests passed. These fixtures are synthetic and do not validate real payment-provider receipt layouts.
- Shipped JavaScript syntax and page asset references passed the build checks.
- Production public/login/admin/booking-management routes responded successfully.
- Read-only tenant resolution confirmed the exact Pickle Street tenant, 3 courts, active public booking, no setup blockers, and rejection of a foreign tenant slug on this origin.
- Live admin dashboard, reports, payment-review, court and payment settings inspected; Open Play visibility checked in the rendered UI.
- No customer bookings, payment approvals, cancellations, reschedules, refunds, or emails were created to test production. The tenant had zero bookings during the database check.

## Auto-approval: verified deployed state

Downloaded the deployed verify-receipt function through Supabase's source download. Its entry point and receipt helper exactly match the reference GoTyme-enabled implementation; the more recently named backend-hotfix checkout contains older verifier TypeScript and was not treated as the deployed truth.

Read-only database checks confirmed:

- Pickle Street currently enables only `gcash` as a customer payment method.
- `bookingApprovalMode` and `receiptAutoApprovalMethods` are unset for this tenant; no explicit manual override or GoTyme opt-in was found.
- The deployed atomic approval function explicitly permits GCash or tenant-opted-in GoTyme, and rejects other methods.
- Required Vision and internal-verifier secret names are present. Secret values were not read. Their existence is not an end-to-end payment test.

| Method | Current live support |
| --- | --- |
| GCash | Deployed OCR/evidence and atomic approval path; active payment method. Eligible receipts can auto-approve; ambiguous/failed checks require review. Real payment verification was not exercised. |
| GoTyme | Deployed dedicated destination parsing, but requires tenant opt-in and active receiving-account configuration. Neither is enabled for Pickle Street. |
| Maya | Manual review; new native parser/layout validation and atomic approval support needed. |
| BDO Pay | Manual review; new native parser/layout validation and atomic approval support needed. |
| BPI | Manual review; new native parser/layout validation and atomic approval support needed. |
| PNB | Manual review; new native parser/layout validation and atomic approval support needed. |

Receipt OCR is evidence checking, not a direct bank settlement confirmation. Recipient, amount, currency, reference, timestamp, successful transaction status, duplicate evidence, tenant ownership, payment-session state, and booking-slot state must all be checked before approval.

## Prepared, not deployed

`operations/receipt-verifier-proposal/` contains six explicit parser entry points, a guarded adapter for deployed GCash/GoTyme extraction, and 60 synthetic regression tests. Native Maya/BDO Pay/BPI/PNB formats deliberately remain manual-review-only. No new verifier endpoint, submission route, database finalizer, or approval flag was deployed.

To complete dedicated automatic verification for the four unsupported native methods:

1. Validate representative successful and failed/pending receipt layouts for each receiving bank. Redacted examples must preserve labels, destination-bank identity, and formatting; credentials are never needed.
2. Add Pickle-only submission and verifier endpoints with strict tenant ID/slug checks. The existing submission endpoint hardcodes the shared verifier, so a new verifier alone cannot receive traffic.
3. Implement a Pickle-only atomic approval function with the necessary evidence contract, duplicate prevention, row locking, active recipient settings, manual-mode override, and play-start guards. The shared function must not be bypassed by relabeling bank receipts as GCash.
4. Validate the isolated backend against test transactions before enabling each method.

## Other remaining backend work

- The reference reschedule preparation function checks availability before idempotent recovery. After a lost successful response, a retry can be rejected as the current schedule. This backend retry path was not changed; check the current booking before retrying an uncertain request.
- The inherited weather backend uses percentage refunds and rescheduling preserves full original duration. A dedicated unused-time rain credit/reschedule workflow is still required to automate Pickle Street's policy. Policy text alone does not implement that accounting.

No other tenant's data or shared backend functions were modified by this audit.
