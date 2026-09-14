import assert from "node:assert/strict";
import {
  SOURCE_ROUTE_TENANT_ID,
  SOURCE_ROUTE_TENANT_SLUG,
  type SourceRouteInput,
  verifySourceRoute,
} from "./source-routes.ts";

function fixture(amountRows: string): SourceRouteInput {
  return {
    vision: {
      confidence: 0.95,
      text: `GCash Receipt
Sent to
RE....O VH●L A.
+63 927 217 2285
Sent via GCash
${amountRows}
Ref No. 3045048952999 Sep 14, 2026 8:52 PM`,
    },
    image: { mimeType: "image/jpeg", sizeBytes: 98756 },
    expectedAmount: 320,
    currency: "PHP",
    payment: {
      paymentMethod: "gcash",
      submittedReference: "3045048952999",
      receiverName: "Renielo Vhal Apari",
      receiverReference: "09272172285",
    },
    timing: {
      bookingStartedAt: "2026-09-14T12:49:24Z",
      tenantTimezone: "Asia/Manila",
    },
    route: {
      tenantId: SOURCE_ROUTE_TENANT_ID,
      tenantSlug: SOURCE_ROUTE_TENANT_SLUG,
      sourceProvider: "gcash",
      destinationProvider: "gcash",
      destinationMethodCode: "gcash",
      enabled: true,
      autoApprovalEnabled: true,
    },
  };
}

Deno.test("GCash repairs letter O only in its labeled amount displays", () => {
  for (
    const rows of [
      "Amount\n320.00\nTotal Amount Sent\nP32O.OO",
      "Amount 32O.OO\nTotal Amount Sent P320.OO",
    ]
  ) {
    const result = verifySourceRoute(fixture(rows));
    assert.equal(result.autoApprove, true, JSON.stringify(result.flags));
    assert.deepEqual(result.flags, ["auto_approval_eligible"]);
  }
});

Deno.test("GCash OCR repair still rejects a conflicting total", () => {
  const result = verifySourceRoute(
    fixture("Amount\n320.00\nTotal Amount Sent\nP321.OO"),
  );
  assert.equal(result.autoApprove, false);
  assert.ok(result.flags.includes("amount_review"));
});

Deno.test("GCash OCR repair never promotes an unrelated O-number", () => {
  const result = verifySourceRoute(
    fixture("Amount\n320.00\nTotal Amount Sent\nReceipt code P32O.OO"),
  );
  assert.equal(result.autoApprove, false);
  assert.ok(result.flags.includes("amount_confirmation_unreadable"));
});
