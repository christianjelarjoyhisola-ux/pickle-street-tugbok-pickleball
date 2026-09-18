import assert from "node:assert/strict";
import {
  SOURCE_ROUTE_TENANT_ID,
  SOURCE_ROUTE_TENANT_SLUG,
  type SourceRouteInput,
  verifySourceRoute,
} from "./source-routes.ts";

const receipt = (status: "Processing" | "Completed", fee = "10.00") =>
  `11:29
Bank transfer to
RE****O VH*L A.
DWQM4TK3JDNY1352Z
- ₱1,270.00
${status}
Source
My Wallet
+63 939 569 5354
Destination
G-Xchange Inc. / GCash
RE****O VH*L A.
DWQM4TK3JDNY1352Z
Purpose
payment
Transaction details
Transaction fee
₱${fee}
Gateway
InstaPay
Reference ID
d3d1bb09fee9
maya`;

function fixture(status: "Processing" | "Completed" = "Processing"): SourceRouteInput {
  return {
    vision: { text: receipt(status), confidence: 0.99 },
    image: { mimeType: "image/png", sizeBytes: 4096 },
    expectedAmount: 1270,
    currency: "PHP",
    payment: {
      paymentMethod: "maya",
      submittedReference: "D3D1BB09FEE9",
      receiverName: "Renielo Vhal Apari",
      receiverReference: "09272172285",
    },
    timing: {
      bookingStartedAt: "2026-09-18T15:28:00Z",
      tenantTimezone: "Asia/Manila",
    },
    route: {
      tenantId: SOURCE_ROUTE_TENANT_ID,
      tenantSlug: SOURCE_ROUTE_TENANT_SLUG,
      sourceProvider: "maya",
      destinationProvider: "gcash",
      destinationMethodCode: "gcash",
      enabled: true,
      autoApprovalEnabled: true,
    },
  };
}

for (const status of ["Processing", "Completed"] as const) {
  Deno.test(`Maya ${status} accepts a masked recipient and opaque destination account`, () => {
    const result = verifySourceRoute(fixture(status));
    assert.equal(result.autoApprove, true, JSON.stringify(result.flags));
    assert.deepEqual(result.flags, ["auto_approval_eligible"]);
    assert.equal(result.paymentReference, "D3D1BB09FEE9");
    assert.equal(result.extractedData.comparison.amountMatched, true);
    assert.equal(result.extractedData.detected.route.recipientMatched, true);
    assert.equal(
      result.extractedData.detected.route.recipient?.phoneMatch,
      "opaque_destination",
    );
    assert.equal(
      result.extractedData.detected.route.mayaStatus,
      status.toLowerCase(),
    );
  });
}

Deno.test("Maya transaction fee is not treated as the booking principal", () => {
  const input = fixture();
  input.vision.text = receipt("Processing", "999.00");
  const result = verifySourceRoute(input);
  assert.equal(result.autoApprove, true, JSON.stringify(result.flags));
  assert.deepEqual(result.extractedData.detected.amounts, [1270]);
  assert.equal(result.extractedData.comparison.amountMatched, true);
});

Deno.test("Maya principal mismatch, missing gateway or missing destination account stays pending", () => {
  const mutations = [
    (input: SourceRouteInput) => input.expectedAmount = 1271,
    (input: SourceRouteInput) => input.vision.text = input.vision.text.replace("InstaPay", ""),
    (input: SourceRouteInput) => input.vision.text = input.vision.text.replaceAll("DWQM4TK3JDNY1352Z", ""),
  ];
  for (const mutate of mutations) {
    const input = fixture();
    mutate(input);
    assert.equal(verifySourceRoute(input).autoApprove, false);
  }
});
