import assert from 'node:assert/strict';
import { verifySourceRoute, SOURCE_ROUTE_TENANT_ID, SOURCE_ROUTE_TENANT_SLUG, type SourceRouteInput } from './source-routes.ts';
import { recoverReceiptReading } from './ocr-recovery.ts';

// Anonymized reconstructions of the September 26 receipt layout.
function fixture(amount = 110): SourceRouteInput {
  return {
    vision: {text: `MAA J. C.\n+63 917 000 0001\nSent via GCash\nAmount ${amount}.00\nTotal Amount Sent ₱${amount}.00\nRef No. 0045 123 456789 Sep 26, 2026 3:06 PM`, confidence: .96},
    image: {mimeType: 'image/jpeg', sizeBytes: 93000}, expectedAmount: amount, currency: 'PHP',
    payment: {paymentMethod: 'gcash', submittedReference: '0045123456789', receiverName: 'MARIA JR CRUZ', receiverReference: '09170000001'},
    timing: {bookingStartedAt: '2026-09-26T07:03:48Z', tenantTimezone: 'Asia/Manila'},
    route: {tenantId: SOURCE_ROUTE_TENANT_ID, tenantSlug: SOURCE_ROUTE_TENANT_SLUG, sourceProvider: 'gcash', destinationProvider: 'gcash', destinationMethodCode: 'gcash', enabled: true, autoApprovalEnabled: true},
  };
}

for (const amount of [110, 430]) Deno.test(`GCash compact masked name with exact mobile auto-verifies ${amount}`, () => {
  const f = fixture(amount);
  for (const name of ['MAA J. C.', 'MA••A J• C.']) {
    f.vision.text = fixture(amount).vision.text.replace('MAA J. C.', name);
    const result = verifySourceRoute(f);
    assert.equal(result.autoApprove, true, JSON.stringify(result.flags));
    assert.equal(result.extractedData.detected.route.recipient?.nameMatch, 'masked_compatible');
  }
});

Deno.test('Compact-mask recovery preserves all recipient and payment safeguards', () => {
  const mutations: Array<(f: SourceRouteInput) => void> = [
    f => {f.vision.text = f.vision.text.replace('MAA J. C.', 'MAZ J. C.');},
    f => {f.vision.text = f.vision.text.replace('MAA J. C.', 'MAA K. C.');},
    f => {f.vision.text = f.vision.text.replace('MAA J. C.', 'MAA J. D.');},
    f => {f.vision.text = f.vision.text.replace('MAA J. C.', 'MAA JR CRUZ');},
    f => {f.vision.text = f.vision.text.replace('000 0001', '000 0002');},
    f => {f.vision.text = f.vision.text.replace('+63 917 000 0001', '0917 *** 0001');},
    f => {f.expectedAmount = 111;},
    f => {f.vision.text = f.vision.text.replace('₱110.00', '₱111.00');},
    f => {f.vision.text = f.vision.text.replace('₱110.00', 'unreadable');},
    f => {f.payment.submittedReference = '0045123456788';},
    f => {f.vision.confidence = .70;},
    f => {f.vision.text = f.vision.text.replace('3:06 PM', '4:06 PM');},
    f => {f.route.autoApprovalEnabled = false;},
  ];
  for (const mutate of mutations) {
    const f = fixture(); mutate(f);
    assert.equal(verifySourceRoute(f).autoApprove, false, mutate.toString());
  }
});

Deno.test('A complete layout retry can recover the unreadable second amount without bypassing it', async () => {
  const f = fixture(430);
  const vision = {...f.vision, text: f.vision.text.replace('₱430.00', 'unreadable'), layoutText: f.vision.text};
  const primary = verifySourceRoute({...f, vision});
  assert.equal(primary.autoApprove, false);
  assert.ok(primary.flags.includes('amount_confirmation_unreadable'));
  const result = await recoverReceiptReading({primary, vision, method: 'gcash', verify: candidate => verifySourceRoute({...f, vision: candidate}), retry: async () => {throw Error('Layout should suffice');}});
  assert.equal(result.autoApprove, true);
  // Both production finish RPCs require these exact nine safe root keys.
  assert.deepEqual(Object.keys(result.extractedData).sort(), [
    'schemaVersion', 'provider', 'feature', 'ocrCharacterCount', 'file',
    'detected', 'comparison', 'timing', 'confidence',
  ].sort());
});
