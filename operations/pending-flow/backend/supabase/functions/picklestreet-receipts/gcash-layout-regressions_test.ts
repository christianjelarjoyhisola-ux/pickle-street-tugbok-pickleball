import assert from 'node:assert/strict';
import { parseGcashReceipt, compareGcashRecipient } from '../_shared/picklestreet-source/gcash-receipt.ts';
import { verifySourceRoute, SOURCE_ROUTE_TENANT_ID, SOURCE_ROUTE_TENANT_SLUG, type SourceRouteInput } from './source-routes.ts';
import { verifyGcash } from './parsers.ts';
// Anonymized OCR-layout reconstruction; no image upload or live payment in these tests.
const reference='1234567890123';
const expectedName='Marta Davina Cruz';
const phone='+639170000001';
function fixture(columnOrder=false):SourceRouteInput {
  const amounts=columnOrder ? 'Amount\nTotal Amount Sent\n2.00\n₱2.00' : 'Amount\n2.00\nTotal Amount Sent\n₱2.00';
  return {vision:{text:`GCash\nM•• DA•••A C.\n${phone}\nSent via GCash\n${amounts}\nRef No. ${reference}\nSep 8, 2026 10:11 AM`,confidence:.99},
    image:{mimeType:'image/png',sizeBytes:2048},expectedAmount:2,currency:'PHP',
    payment:{paymentMethod:'gcash',submittedReference:reference,receiverName:expectedName,receiverReference:phone},
    timing:{bookingStartedAt:'2026-09-08T02:10:00Z',tenantTimezone:'Asia/Manila'},
    route:{tenantId:SOURCE_ROUTE_TENANT_ID,tenantSlug:SOURCE_ROUTE_TENANT_SLUG,sourceProvider:'gcash',destinationProvider:'gcash',destinationMethodCode:'gcash',enabled:true,autoApprovalEnabled:true}};
}
for(const columnOrder of [false,true]) {
  const label=columnOrder?'column order':'row order';
  Deno.test(`Dedicated parser reads masked recipient and both amount displays (${label})`,()=>{
    const f=fixture(columnOrder),p=parseGcashReceipt(f.vision.text,{typedReference:reference});
    const recipient=compareGcashRecipient(p.receiver,{name:expectedName,phone});
    assert.equal(recipient.phone,'exact');
    assert.equal(recipient.name,'masked_compatible');
    assert.equal(p.amount.amount,2);
    assert.equal(p.amount.reliable,true);
    assert.equal(p.amount.matchingPrimaryAmountDisplays,true);
    assert.equal(p.reference.value,reference);
    assert.equal(p.reference.typedMatch,'match');
    assert.equal(p.timestamp.instant,'2026-09-08T02:11:00.000Z');
  });
  Deno.test(`Pickle route accepts full phone plus compatible masked name (${label})`,()=>{
    const r=verifySourceRoute(fixture(columnOrder));
    assert.equal(r.extractedData.comparison.amountMatched,true,JSON.stringify(r.flags));
    assert.equal(r.extractedData.detected.route.recipientMatched,true,JSON.stringify(r.flags));
    assert.equal(r.autoApprove,true,JSON.stringify(r.flags));
    assert.equal(r.extractedData.detected.route.recipient?.observedName,'M•• DA•••A C.');
    assert.equal(r.extractedData.detected.route.recipient?.observedNumber,phone);
    assert.equal(r.extractedData.detected.route.recipient?.phoneMatch,'exact');
    assert.equal(r.extractedData.detected.route.recipient?.nameMatch,'masked_compatible');
    assert.equal(r.extractedData.detected.route.parserVersion,'gcash_v1');
    assert.equal(r.extractedData.detected.route.verifierVersion,'picklestreet_sources_20260909_1');
  });
  Deno.test(`Legacy GCash entry point also accepts this supported receipt (${label})`,()=>{
    const f=fixture(columnOrder);
    const r=verifyGcash({...f,payment:{...f.payment,autoApprovalEnabled:true}});
    assert.equal(r.autoApprove,true,JSON.stringify(r.flags));
  });
}
Deno.test('same-line Amount2.00 and Total Amount Sent₱2.00 remain explicit amount evidence',()=>{
  const f=fixture();f.vision.text=f.vision.text.replace('Amount\n2.00','Amount2.00').replace('Total Amount Sent\n₱2.00','Total Amount Sent₱2.00');
  const p=parseGcashReceipt(f.vision.text,{typedReference:reference});
  assert.equal(p.amount.amount,2);assert.equal(p.amount.reliable,true);assert.equal(p.amount.matchingPrimaryAmountDisplays,true);
});
// Android Express Send may yield a black-circle OCR mask rather than a bullet.
// Keep every visible letter significant; the mask does not replace the phone check.
for (const mask of ['⚫', '⚫️']) {
  Deno.test(`Express Send recipient supports a black-circle mask (${mask})`,()=>{
    const f=fixture();
    f.payment.receiverName='Renato Vhal Alves';
    f.vision.text=f.vision.text.replace('M•• DA•••A C.',`RE....O VH${mask}L A.`);
    const p=parseGcashReceipt(f.vision.text,{typedReference:reference});
    const recipient=compareGcashRecipient(p.receiver,{name:f.payment.receiverName,phone});
    assert.equal(recipient.phone,'exact');
    assert.equal(recipient.name,'masked_compatible');
    assert.equal(verifySourceRoute(f).autoApprove,true);
    f.vision.text=f.vision.text.replace(`VH${mask}L`,`VH${mask}Z`);
    assert.equal(verifySourceRoute(f).autoApprove,false,'A different visible letter must stay pending');
  });
}
function expressSendFixture(amountBlock:string):SourceRouteInput {
  const f=fixture();
  f.expectedAmount=160;
  f.payment.receiverName='Renato Vhal Alves';
  f.payment.submittedReference='0044123456789';
  f.timing.bookingStartedAt='2026-09-09T09:53:48Z';
  f.vision.confidence=.92;
  f.vision.text=`TNT GLOBE 5:55\nExpress Send\nRE....O VH⚫L A.\n${phone}\nSent via GCash\n${amountBlock}\nRef No. 0044 123 456789\nSep 09, 2026 5:55 PM\n279g (gCO2e)\nDownload`;
  return f;
}
// Layout reconstructions, not a replay of retained production OCR.
for (const [label,amountBlock] of Object.entries({
  row:'Amount\n160.00\nTotal Amount Sent\n₱160.00',
  column:'Amount\nTotal Amount Sent\n160.00\n₱160.00',
  flattened:'Amount 160.00 Total Amount Sent ₱160.00',
})) Deno.test(`Express Send amount displays and leading-zero reference (${label})`,()=>{
  const f=expressSendFixture(amountBlock);
  const p=parseGcashReceipt(f.vision.text,{typedReference:f.payment.submittedReference});
  const r=verifySourceRoute(f);
  assert.equal(p.amount.amount,160);
  assert.equal(p.amount.matchingPrimaryAmountDisplays,true);
  assert.equal(p.reference.value,'0044123456789');
  assert.equal(p.reference.typedMatch,'match');
  assert.equal(r.autoApprove,true,JSON.stringify(r.flags));
});
for (const [label,amountBlock] of Object.entries({
  one_display_collected_by_currency_and_label:'Total Amount Sent ₱160.00',
  unlabeled_repeated_currency:'Amount ₱160.00 ₱160.00\nTotal Amount Sent',
  conflicting_displays:'Amount 160.00 Total Amount Sent ₱161.00',
  fee_is_not_confirmation:'Amount\n160.00\nTotal Amount Sent\nTransfer Fee ₱160.00',
  reference_is_not_confirmation:'Amount\n160.00\nTotal Amount Sent\nRef No. 160.00',
  statusbar_is_not_confirmation:'160.00\n57%\nAmount\n160.00\nTotal Amount Sent',
})) Deno.test(`Express Send stays pending: ${label}`,()=>{
  const f=expressSendFixture(amountBlock);
  const p=parseGcashReceipt(f.vision.text,{typedReference:f.payment.submittedReference});
  const r=verifySourceRoute(f);
  assert.equal(r.autoApprove,false,JSON.stringify(r.flags));
  if(label==='one_display_collected_by_currency_and_label') {
    assert.equal(p.amount.candidates.length,1);
    assert.equal(p.amount.matchingPrimaryAmountDisplays,false);
  }
});
for(const [name,mutate] of Object.entries({
  wrong_phone:(f:SourceRouteInput)=>{f.vision.text=f.vision.text.replace(phone,'+639170000002')+'\nSender\nMarta Davina Cruz\n'+phone;},
  wrong_visible_initial:(f:SourceRouteInput)=>{f.vision.text=f.vision.text.replace('M•• DA•••A C.','Z•• DA•••A C.');},
  wrong_visible_final:(f:SourceRouteInput)=>{f.vision.text=f.vision.text.replace('M•• DA•••A C.','M•• DA•••Z C.');},
  masked_phone:(f:SourceRouteInput)=>{f.vision.text=f.vision.text.replace(phone,'+63 9•• ••• 0001');},
  conflicting_amount_displays:(f:SourceRouteInput)=>{f.vision.text=f.vision.text.replace('Total Amount Sent\n₱2.00','Total Amount Sent\n₱3.00');},
  amount_mismatch:(f:SourceRouteInput)=>{f.expectedAmount=3;},
  reference_mismatch:(f:SourceRouteInput)=>{f.payment.submittedReference='1234567890124';},
  expired_receipt:(f:SourceRouteInput)=>{f.timing.bookingStartedAt='2026-09-08T01:40:00Z';},
  failure_state:(f:SourceRouteInput)=>{f.vision.text+='\nTransfer Failed';},
  missing_native_confidence:(f:SourceRouteInput)=>{f.vision.confidence=null;},
  low_native_confidence:(f:SourceRouteInput)=>{f.vision.confidence=.89;},
  missing_confirmation_amount:(f:SourceRouteInput)=>{f.vision.text=f.vision.text.replace('Total Amount Sent\n₱2.00','');},
  missing_recipient_name:(f:SourceRouteInput)=>{f.vision.text=f.vision.text.replace('M•• DA•••A C.\n','');},
})) Deno.test(`GCash mismatch stays pending: ${name}`,()=>{const f=fixture();mutate(f);assert.equal(verifySourceRoute(f).autoApprove,false);});
