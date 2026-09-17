import assert from "node:assert/strict";
import { parseMayaToGcashReceipt } from "../_shared/picklestreet-source/receipt-providers/maya.ts";

const completedReceipt = `Bank transfer to
vhal
09272172285
- PHP1,270.00
Completed
Source
My Wallet
+63 939 569 5354
Destination
G-Xchange Inc. / GCash
vhal
09272172285
Transaction details
Transaction fee
PHP10.00
Gateway
InstaPay
Reference ID
769cd5aa7d92
maya`;

Deno.test("Maya to GCash bank-transfer screen reads the primary amount, receiver and reference", () => {
  const parsed = parseMayaToGcashReceipt(completedReceipt, {
    typedReference: "769CD5AA7D92",
  });
  assert.equal(parsed.indicators.nativeWalletLayout, true);
  assert.equal(parsed.indicators.providerBrand, true);
  assert.equal(parsed.indicators.destinationGcash, true);
  assert.equal(parsed.indicators.instaPay, true);
  assert.equal(parsed.indicators.completionScreen, true);
  assert.equal(parsed.reference.value, "769CD5AA7D92");
  assert.equal(parsed.reference.typedMatch, "match");
  assert.equal(parsed.amount.amount, 1270);
  assert.equal(parsed.recipient.phoneNormalized, "9272172285");
  assert.equal(parsed.recipient.nameRaw, "vhal");
});

Deno.test("Maya Processing bank transfer is never treated as completed", () => {
  const parsed = parseMayaToGcashReceipt(
    completedReceipt.replace("Completed", "Processing"),
    { typedReference: "769CD5AA7D92" },
  );
  assert.equal(parsed.indicators.pendingStatus, true);
  assert.equal(parsed.indicators.completionScreen, false);
});
