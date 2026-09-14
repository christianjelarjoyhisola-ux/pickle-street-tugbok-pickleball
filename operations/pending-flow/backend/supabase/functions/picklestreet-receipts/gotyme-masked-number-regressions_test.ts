import assert from "node:assert/strict";
import {
  SOURCE_ROUTE_TENANT_ID,
  SOURCE_ROUTE_TENANT_SLUG,
  type SourceRouteInput,
  verifySourceRoute,
} from "./source-routes.ts";

const NAME = "Venue Recipient";
const MOBILE = "09272172285";

function fixture(maskedNumber: string): SourceRouteInput {
  return {
    vision: {
      confidence: 0.94,
      text: `Sent
PHP 160.00
Repeat
Add to favorites
Share
instaPay
Instant
To
From
Amount
Fee
Total
Note
Trace ID
Reference No.
Date
${NAME}
${maskedNumber}
G-Xchange, Inc (GCash)
SYNTHETIC SENDER
••••••••7523
GoTyme Bank
Amount PHP 160.00
Court booking payment
000015
ITO260914122329999
14 Sep 2026 at 8:23 PM
Get help`,
    },
    image: { mimeType: "image/png", sizeBytes: 2048 },
    expectedAmount: 160,
    currency: "PHP",
    payment: {
      paymentMethod: "gotyme",
      submittedReference: "",
      receiverName: NAME,
      receiverReference: MOBILE,
    },
    timing: {
      bookingStartedAt: "2026-09-14T12:21:05Z",
      tenantTimezone: "Asia/Manila",
    },
    route: {
      tenantId: SOURCE_ROUTE_TENANT_ID,
      tenantSlug: SOURCE_ROUTE_TENANT_SLUG,
      sourceProvider: "gotyme",
      destinationProvider: "gcash",
      destinationMethodCode: "gcash",
      enabled: true,
      autoApprovalEnabled: true,
    },
  };
}

Deno.test("GoTyme receiver accepts bounded masked-number OCR variants", () => {
  for (
    const masked of [
      "O∙∙∙∙∙∙ 2 2 8 5",
      "0 × × × × × × 2285",
      "0 o o o o o o 2285",
      "0   2285",
      "⋯⋯⋯⋯⋯⋯2285",
    ]
  ) {
    const result = verifySourceRoute(fixture(masked));
    assert.equal(result.autoApprove, true, `${masked}: ${result.flags}`);
    assert.ok(!result.flags.includes("payment_receiver_unverified"));
    assert.match(
      result.extractedData.detected.route.recipient?.observedNumber || "",
      /2\s*2\s*8\s*5$/,
    );
    assert.equal(
      result.extractedData.detected.route.recipient?.phoneMatch,
      "last4_only",
    );
  }
});

Deno.test("GoTyme receiver rejects wrong or unmasked four-digit values", () => {
  for (const value of ["0••••••9999", "2285", "Trace ID 2285"]) {
    const result = verifySourceRoute(fixture(value));
    assert.equal(result.autoApprove, false, value);
    assert.ok(result.flags.includes("payment_receiver_unverified"));
  }
});
