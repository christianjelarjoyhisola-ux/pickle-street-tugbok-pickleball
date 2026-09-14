import assert from "node:assert/strict";
import { confirmedReceiptRereadAllowed } from "./index.ts";

const booking = {
  id: "00000000-0000-4000-8000-000000000001",
  status: "confirmed",
  payment_status: "paid",
};
const receipt = {
  booking_id: booking.id,
  balance_request_id: null,
  status: "auto_approved",
  storage_path: "tenant/receipts/booking/receipt.png",
};

Deno.test("confirmed receipt re-read never accepts an unsettled or different booking", () => {
  assert.equal(confirmedReceiptRereadAllowed(booking, receipt), true);
  assert.equal(confirmedReceiptRereadAllowed({ ...booking, status: "payment_review" }, receipt), false);
  assert.equal(confirmedReceiptRereadAllowed({ ...booking, payment_status: "pending" }, receipt), false);
  assert.equal(confirmedReceiptRereadAllowed(booking, { ...receipt, booking_id: "different" }), false);
  assert.equal(confirmedReceiptRereadAllowed(booking, { ...receipt, balance_request_id: "balance" }), false);
  assert.equal(confirmedReceiptRereadAllowed(booking, { ...receipt, status: "manual_review" }), false);
});
