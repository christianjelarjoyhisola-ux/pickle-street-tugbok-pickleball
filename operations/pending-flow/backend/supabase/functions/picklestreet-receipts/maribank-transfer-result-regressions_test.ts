import assert from "node:assert/strict";
import {
  SOURCE_ROUTE_TENANT_ID,
  SOURCE_ROUTE_TENANT_SLUG,
  type SourceRouteInput,
  verifySourceRoute,
} from "./source-routes.ts";

const ACCOUNT = "DWQM4TK3JDNZU9WO7";
const REFERENCE = "227145";

function fixture(): SourceRouteInput {
  return {
    vision: {
      confidence: 0.99,
      text: `Transfer Result
Transfer Successful!
PHP 530.00
From
PRINCESS CLARIZZ JOY S.
MariBank: 11853050034
To
Kr****e L** C.
G-Xchange / GCash
Acct No.: ${ACCOUNT}
Transfer Amount
PHP 530.00
Transfer Fee
FREE
Total Amount
PHP 530.00
Reference Number
${REFERENCE}
Transfer Method
Processing Time
Realtime
Transaction Date & Time
15 Sep 2026, 12:13`,
    },
    image: { mimeType: "image/png", sizeBytes: 2048 },
    expectedAmount: 530,
    currency: "PHP",
    payment: {
      paymentMethod: "maribank",
      submittedReference: "",
      receiverName: "KRISTIE LOU CACHUELA",
      receiverReference: "09609422169",
    },
    timing: {
      bookingStartedAt: "2026-09-15T04:12:00Z",
      tenantTimezone: "Asia/Manila",
    },
    route: {
      tenantId: SOURCE_ROUTE_TENANT_ID,
      tenantSlug: SOURCE_ROUTE_TENANT_SLUG,
      sourceProvider: "maribank",
      destinationProvider: "gcash",
      destinationMethodCode: "gcash",
      enabled: true,
      autoApprovalEnabled: true,
      gcashQrAlias: "KRISTIE LOU CACHUELA",
      gcashQrToken: ACCOUNT,
    },
  };
}

Deno.test("MariBank Transfer Result auto-verifies with exact account and no separate InstaPay trace", () => {
  const result = verifySourceRoute(fixture());
  assert.equal(result.autoApprove, true, JSON.stringify(result.flags));
  assert.deepEqual(result.flags, ["auto_approval_eligible"]);
  assert.equal(result.paymentReference, REFERENCE);
  assert.equal(
    result.extractedData.timing.receiptDateTime,
    "2026-09-15T04:13:00Z",
  );
  assert.equal(result.extractedData.detected.route.recipientMatched, true);
  assert.equal(
    result.extractedData.detected.route.recipient?.phoneMatch,
    "exact_account",
  );
  assert.deepEqual(result.extractedData.detected.route.secondaryReferences, []);
});

Deno.test("MariBank exact-account protection rejects a different destination", () => {
  const input = fixture();
  input.vision.text = input.vision.text.replace(
    ACCOUNT,
    "ZZZZ4TK3JDNZU9WO7",
  );
  const result = verifySourceRoute(input);
  assert.equal(result.autoApprove, false);
  assert.ok(
    result.flags.includes("wrong_gcash_number"),
    JSON.stringify(result.flags),
  );
  assert.ok(
    result.flags.includes("payment_receiver_unverified"),
    JSON.stringify(result.flags),
  );
});

Deno.test("MariBank rejects a wrong amount and an expired receipt", () => {
  const wrongAmount = fixture();
  wrongAmount.expectedAmount = 531;
  const amountResult = verifySourceRoute(wrongAmount);
  assert.equal(amountResult.autoApprove, false);
  assert.ok(
    amountResult.flags.includes("amount_mismatch"),
    JSON.stringify(amountResult.flags),
  );

  const late = fixture();
  late.timing.bookingStartedAt = "2026-09-15T03:40:00Z";
  const lateResult = verifySourceRoute(late);
  assert.equal(lateResult.autoApprove, false);
  assert.ok(
    lateResult.flags.includes("payment_window_expired"),
    JSON.stringify(lateResult.flags),
  );
});
