# Weather interruption

Bookings → Weather Interruption lets authorized staff add court/time ranges, preview affected bookings, select up to 50 eligible bookings, and issue individual codes together. Inputs and displays use hours. Underlying credit accounting retains whole minutes. Two courts affected for one hour each count as two hours of court time.

The database calculates actual overlap. Overlapping ranges for the same court are rejected. Paid regular bookings are eligible; missing email, unresolved adjustments, existing rain claims/refunds, equipment/events, and previously credited bookings are excluded. An existing credit is never automatically increased: the preview explicitly marks it already issued.

Issuance is one transaction with booking locks, preview freshness checks, and a stored request ID for safe retries after a lost response. No original booking, payment, slot, or checkout function is modified. Venue closures remain a separate operation under Blocked Dates.

Email is sent after codes are saved, at most two requests concurrently. Failed emails do not reverse credits. Staff can retry pending emails; codes also remain in individual Booking Details → Weather Credit. No automated test sends real customer email.

Validation: `node tools/weather-interruption-platform.cjs validate` runs the migration and database integration tests in a rollback transaction, checking preservation of all pre-existing booking rows and functions. `apply` requires the exact validated SQL hash. The local browser fixture (`node tools/weather-interruption-preview.cjs`) exercises selection, hours, exclusions, issuance, and pending-email recovery with mocked data only.
