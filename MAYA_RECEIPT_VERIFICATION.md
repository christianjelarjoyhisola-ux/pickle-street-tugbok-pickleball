# Maya receipt verification

## Current native Maya screen

Pickle Street's Maya method now receives Maya-to-Maya wallet transfers. The
current `Sent Money` screen can prove the Maya brand, `Completed` status,
principal amount, configured destination name and full mobile number, and the
12-character Reference ID. The verifier parses those fields and reads the
Reference ID from the receipt instead of requiring customers to transcribe it.

That screen does **not** display a transaction date/time or an independent
network reference. The phone status-bar clock is not transaction evidence and
must never be substituted for a receipt timestamp. Therefore this exact Maya
screen remains pending for staff review even when all visible fields match.
Automatic confirmation for this layout requires authenticated Maya merchant
payment status (API/webhook reconciliation), not a weaker screenshot rule.

The older verifier described below remains relevant only to historical
Maya-to-GCash receipts that include their own timestamp and InstaPay reference.

Maya uses a dedicated parser and verifier (`maya_to_gcash_v1`) through the existing `verify-gcash-receipt` Edge Function. This checks uploaded receipt evidence; it does not query Maya or GCash to confirm that funds were credited.

## Receipt fields

- **Payment amount:** the outgoing amount beneath “Sent money via.” The leading minus sign indicates a debit. A separate transfer fee is not part of the booking payment amount.
- **Recipient:** GCash / G-Xchange destination and the configured full recipient mobile number. A masked account name must be checked using Maya's masking format; visible contradictory letters must not be ignored.
- **Reference ID:** the 12-character Maya reference, normalized without spaces. This is the reference the customer enters.
- **InstaPay Ref. No.:** a separate receipt field used for replay protection. Customers must not substitute it for the Maya Reference ID.
- **Transaction date and time:** the receipt timestamp in Philippine time, not the phone's status-bar clock.

## Automatic approval requirements

1. Maya is enabled in payment settings, and the receiving GCash identity is correctly configured. Do not derive the expected recipient from the uploaded receipt.
2. The server can calculate the payment due for the booking or registration, and the parsed payment amount matches it within the existing tolerance.
3. The dedicated verifier accepts the source, outgoing-transfer layout, destination, recipient, references, and timestamp without flags. Failed, pending, conflicting, and unreadable evidence stays in review.
4. The transaction falls within the existing booking payment window: 15 minutes after booking creation, with the existing 2-minute early tolerance.
5. Google Vision returns native OCR confidence of at least 90%. A high overall score does not bypass missing or conflicting fields.
6. The receipt's reference keys have not already been claimed. Atomic database finalization must succeed before a persisted booking is marked paid.

The verifier uses `maya_merchant_number` when present, otherwise `gcash_merchant_number`. For the account name it uses `maya_merchant_name`, then `payment_merchant_name`, then `gcash_merchant_name`. The admin's shared GCash name and number populate the common settings. Check any existing Maya overrides if the expected recipient differs from the shared settings. The BDO/BPI QR alias and destination token are not Maya's personal account identity.

## Rollout and validation

Apply `supabase/migrations/20260905130000_maya_dedicated_receipt_verifier.sql`, deploy the updated `verify-gcash-receipt` function, and release the updated customer and admin pages together. Deploying only the parser is insufficient because database approval functions also enforce provider, route, and parser-version contracts.

Verify a new controlled payment end to end after deployment. Check the stored parser version, amount, account comparison, both references, OCR confidence, and final booking payment state. Historical manually confirmed receipts retain their original audit result.

The sample provided for development shows an 800-peso payment and a separate 10-peso transfer fee. Its transaction timestamp is four minutes after the displayed booking start. Parser fixtures transcribe the screenshot; a fixture passing does not establish a live OCR or settlement result.

## Provider-confirmed payments

For confirmation directly from a payment provider, use a merchant payment integration with authenticated server-side payment-status reconciliation. Maya documents `PAYMENT_SUCCESS` webhooks for its merchant payment products. Those webhooks are a separate integration and are not proof of arbitrary consumer Maya-to-GCash transfers uploaded as screenshots.

References: [Maya bank transfers](https://www.maya.ph/bank-transfer), [Maya payment webhooks](https://developers.maya.ph/reference/receive-real-time-payment-information-using-webhooks).
