# Pickle Street weather credit

Adapts PickPoint's voucher and redemption-ledger approach to Pickle Street's unused-time policy. Credits are measured in court-minutes, valid on the original court(s), and have no expiry. Equivalent time and its booking fee are covered even if prices change. Additional time remains payable. Event bookings and paid equipment rentals require staff handling.

Owners/admins open Booking Details → Weather Credit, enter verified unused minutes, and issue once. A stored code can be copied if email delivery is pending. The original booking, court selections, customer, and payment are retained. Issuance does not close the court or release the original reservation; existing venue closure/cancellation controls remain separate.

Guests use the same email and apply the code in the payment step before paying or submitting proof. Fully covered bookings confirm atomically; partial credits reduce the exact receipt amount. Unpaid cancellation/expiry restores the reserved credit once. Changed-email use, other courts, duplicate issuance, refunded/replaced source bookings, expired holds, and subsequent revival of returned credit are blocked.

Existing payments and reports retain the source booking's original cash. Replacement bookings store net amounts; the separate use ledger records credited court charges and fee coverage. `weatherCreditOriginalTotal`, `weatherCreditOriginalSubtotal`, and `weatherCreditOriginalFee` preserve replacement gross values. The existing remittance query reads the net service fee, so covered time does not add another fee. Booking Details → Weather Credit shows redeemed amounts.

Source SQL: `../pending-flow/037-weather-time-credits.sql`. Migration is additive and does not rewrite existing bookings or platform functions. Validate using `node tools/weather-credit-platform.cjs validate`; it runs synthetic single/grouped holds, real policy consent, receipt settlement, expiry, and remittance checks in a transaction ending with ROLLBACK. Apply is permitted by the release tool only for the validated migration hash.

Backend: `picklestreet-weather-credit`, using existing tenant-specific Maileroo settings. No customer/test email is sent by the database validation. Edge-function tests intercept all network calls. Frontend regression tests: `node --test weather-credit.test.cjs`.
