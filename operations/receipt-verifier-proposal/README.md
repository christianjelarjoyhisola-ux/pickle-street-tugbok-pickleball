# Pickle Street native receipt proposal

This is isolated groundwork under `operations/`, excluded from website deployment.
It does not modify deployed functions, the database, tenant configuration, or payment records.
There is no HTTP endpoint, upload handler, OCR request, database client, duplicate
lookup, SQL finalizer, or deployment command in the proposal implementation.

## Files and verification

- `native-receipt.ts`: six explicit native destination parser entry points and
  common mandatory evidence checks.
- `deployed-adapter.ts`: adds the exact deployed GCash/GoTyme extraction as a
  second, restrictive check. It cannot broaden the deployed approval decision.
- `deployed/`: unmodified support files copied from the Sept 7 deployed
  `verify-receipt` download. Its receipt extraction and entry point were compared
  with `D:/pickleball-booking-platform-qdink-gotyme-auto` and were byte-identical.
- `native-receipt_test.ts`: 60 passing tests; fixtures are visibly marked
  **synthetic canonical data, not real payments or validated provider layouts**.

Validation executed: `deno test --config deno.json native-receipt_test.ts`.
Result: **60 passed, 0 failed**. No network/read/write permissions were granted to
the test process; package resolution initialized the declared Deno dependencies.

## Deliberate support boundaries

| Destination method | Evidence parser | Approval-candidate gate |
| --- | --- | --- |
| `gcash` | Strict full-account recipient block plus deployed extraction | Both parsers must pass |
| `gotyme` | Strict full-account recipient block plus deployed extraction | Both parsers and tenant GoTyme opt-in must pass |
| `maya` | Native candidate profile v0 | Always manual: `UNSUPPORTED_NATIVE_LAYOUT` |
| `bdo_pay` | Native candidate profile v0 | Always manual: `UNSUPPORTED_NATIVE_LAYOUT` |
| `bpi` | Native candidate profile v0 | Always manual: `UNSUPPORTED_NATIVE_LAYOUT` |
| `pnb` | Native candidate profile v0 | Always manual: `UNSUPPORTED_NATIVE_LAYOUT` |

The four v0 profiles are not claims about real bank screen formats. Each needs
approved, anonymized native-destination receipt examples and matching negative
examples before its format can be considered for production. Synthetic fixtures
cannot unlock that gate. This code never invokes any legacy `*ToGcash` parser for
a native bank destination. `bdopay` is rejected at this boundary; the existing UI
alias must be mapped to authoritative backend `bdo_pay` before parsing.

The supplemental GCash/GoTyme grammar intentionally supports fewer layouts than
the deployed parser: named recipient block, explicit destination bank, exact
full account, complete recipient name, labeled principal PHP amount and labeled
date/time. Masked accounts, ambiguous fields, unlabeled/unsupported layouts,
other currencies and other timezones stay in review. Existing GoTyme split-column
or masked layouts may therefore remain in review even if the deployed helper
would accept them. This is not a drop-in compatibility release.

## Mandatory checks

The parser binds bank identity, complete recipient name and complete account to
one bounded destination block. Source-account or free-text provider branding
cannot satisfy those gates. It requires a labeled, unambiguous reference;
customer input is comparison-only. It distinguishes PHP principal amount from
fees and rejects conflicting principals. A success marker cannot override failed,
pending, scheduled, reversed or refunded text. It validates a full calendar date
and time against the server booking start with the existing -2/+10 minute window.

Context must be derived from server-side records, including the selected payment
method, active recipient configuration, current booking/session amount, tenant
approval mode and GoTyme opt-in. Both tenant ID and slug must match Pickle Street.
Missing/invalid context fails closed. `mandatoryEvidenceComplete` is diagnostic;
it does not mean the layout is validated or payment is approved.

`autoApprove: true` means only an **auto-approval candidate**. It does not prove
settlement or image authenticity and must never directly mark a booking paid.
Reference/image duplicates and current booking/session/slot state are outside
this pure module and remain required before any atomic finalization.

## Backend prerequisites identified by the audit

1. Deployed `verify-receipt` supports GCash and tenant-opted-in GoTyme only.
   Backend-hotfix source is stale at the TypeScript layer: it is GCash-only.
2. Latest reference SQL `20260809140000_enable_gotyme_receipt_auto_approval.sql`
   accepts `gcash`; `gotyme` requires its tenant flag. Every other payment method
   is rejected regardless of `receiptAutoApprovalMethods`. The deployed SQL gate
   was confirmed using a read-only function-definition query on September 7.
3. Existing submission source hardcodes `/functions/v1/verify-receipt`. Isolated
   new verifier routing also needs a new Pickle-only submit endpoint and a
   tenant frontend endpoint change. Fetch the deployed submit source first.
4. To keep shared functions unchanged, add a new tenant-bound atomic finalizer
   rather than mislabeling Maya/BDO/BPI/PNB sessions as GCash. No such finalizer is
   implemented here. It must retain tenant/manual-review/play-start guards,
   booking/session/slot locks, amount/currency/time validation and duplicate
   protections. It also needs a reviewed method/version/recipient evidence
   contract; `record_receipt_verification_v2` currently has a strict 9-key schema.
5. Current receipt reference and exact-image unique indexes are tenant scoped.
   Regular and open-play receipts use separate tables. A new reference ledger
   would need an explicit design for normalized method/rail/invoice keys and
   cross-flow reuse, without changing other tenants' behavior.

Do not connect this proposal to live submissions until the native receipt
layouts, endpoint authentication/routing, evidence persistence and atomic
finalization prerequisites have been completed and reviewed.
