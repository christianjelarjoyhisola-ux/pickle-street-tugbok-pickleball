import assert from 'node:assert/strict';
import { recoverReceiptReading } from './ocr-recovery.ts';
import { googleVisionLayoutText } from '../_shared/receipt-layout.ts';
import { verifySourceRoute, SOURCE_ROUTE_TENANT_ID, SOURCE_ROUTE_TENANT_SLUG, type SourceRouteInput } from './source-routes.ts';
import { publicPendingReason } from './parsers.ts';

// Anonymized transcriptions of the audited structures, not fresh OCR results.
const receipt = (name='MA....A S. C.', amount=320, phone='+63 917 123 4567') => `${name}\n${phone}\nSent via GCash\nAmount\n${amount}.00\nTotal Amount Sent\nP${amount}.00\nRef No. 3045300000123 Sep 24, 2026 6:17 AM`;
function input(text=receipt()): SourceRouteInput {
  return {vision:{text,confidence:.97},image:{mimeType:'image/png',sizeBytes:40000},expectedAmount:320,currency:'PHP',payment:{paymentMethod:'gcash',submittedReference:'3045300000123',receiverName:'MARIANA SANTOS CRUZ',receiverReference:'09171234567'},timing:{bookingStartedAt:'2026-09-23T22:16:00Z',tenantTimezone:'Asia/Manila'},route:{tenantId:SOURCE_ROUTE_TENANT_ID,tenantSlug:SOURCE_ROUTE_TENANT_SLUG,sourceProvider:'gcash',destinationProvider:'gcash',destinationMethodCode:'gcash',enabled:true,autoApprovalEnabled:true}};
}
async function recover(text:string, alternate:string, layoutText?:string) {
  const f=input(text); f.vision.layoutText=layoutText;
  return await recoverReceiptReading({primary:verifySourceRoute(f),vision:f.vision,method:'gcash',verify:vision=>verifySourceRoute({...f,vision}),retry:async()=>({text:alternate,confidence:.97})});
}
Deno.test('audited GCash amounts pass with full coherent evidence',()=>{
  for(const amount of [110,220,320,420,430,580]) {
    const f=input(receipt(undefined,amount));f.expectedAmount=amount;
    assert.equal(verifySourceRoute(f).autoApprove,true,JSON.stringify(verifySourceRoute(f).flags));
  }
});
Deno.test('independent OCR can recover lost masks and missing second amount without name aliases',async()=>{
  const broken=receipt('MAA S. C.').replace('P320.00','');
  assert.equal(verifySourceRoute(input(broken)).autoApprove,false);
  assert.equal((await recover(broken,receipt())).autoApprove,true);
  assert.equal((await recover(broken,broken)).autoApprove,false);
  assert.equal((await recover(broken,broken,receipt())).autoApprove,true);
});
Deno.test('partial OCR readings cannot be combined into approval',async()=>{
  // MAA now correctly matches the compact GCash mask; MAZ still contradicts
  // the configured name, so neither complete reading is approval eligible.
  assert.equal((await recover(receipt('MAZ S. C.'),receipt().replace('P320.00',''))).autoApprove,false);
});
Deno.test('OCR recovery cannot hide pending status, wrong amount, or conflicting references',async()=>{
  for(const text of [receipt()+'\nProcessing',receipt(undefined,200),receipt('MAA S. C.').replace('3045300000123','3045300000999')]) {
    assert.equal((await recover(text,receipt())).autoApprove,false,text);
  }
});
Deno.test('masked phone, wrong recipient, masked settings and low confidence stay pending',()=>{
  const samples=[input(receipt(undefined,320,'+63 9..... 4567')),input(receipt('OTHER PERSON',320)),input()];
  samples[2].payment.receiverName='MA****A S. C.';
  const low=input();low.vision.confidence=.6;samples.push(low);
  for(const f of samples) assert.equal(verifySourceRoute(f).autoApprove,false);
});
Deno.test('failed optional OCR retains original diagnostics',async()=>{
  const f=input(receipt('MAA S. C.').replace('P320.00','')),primary=verifySourceRoute(f);
  assert.strictEqual(await recoverReceiptReading({primary,vision:f.vision,method:'gcash',verify:vision=>verifySourceRoute({...f,vision}),retry:async()=>{throw Error('timeout');}}),primary);
});
function mari(status='') {
  const f=input();f.payment.paymentMethod='maribank';f.route.sourceProvider='maribank';f.payment.submittedReference='123456';
  f.vision.text=`MariBank\nTransaction Receipt\n${status}\nPHP 320.00\nFrom\nSENDER NAME\nMariBank: *******1111\nTo\nMariana Santos Cruz\nG-Xchange / GCash\nMobile No.: 09171234567\nTransfer Amount\nPHP 320.00\nTransfer Fee\nFREE\nTotal Amount\nPHP 320.00\nReference Number\n123456\nTransfer Method\ninstapay\nProcessing Time\nRealtime\nTransaction Date & Time\n24 Sep 2026, 06:17`;
  return f;
}
Deno.test('native MariBank reads To block and six-digit reference but Realtime alone is not completed',()=>{
  for(const status of ['', 'Transfer Successful!']) {
    const r=verifySourceRoute(mari(status));
    assert.equal(r.extractedData.detected.route.recipientMatched,true,JSON.stringify(r.flags));
    assert.equal(r.extractedData.comparison.amountMatched,true);
    assert.equal(r.paymentReference,'123456');
    assert.equal(r.autoApprove,!!status,JSON.stringify(r.flags));
  }
});
Deno.test('MariBank sender account cannot substitute for missing or wrong destination',()=>{
  for(const replacement of ['', 'Mobile No.: 09179999999']) {
    const f=mari('Transfer Successful!');f.vision.text=f.vision.text.replace('*******1111','09171234567').replace('Mobile No.: 09171234567',replacement);
    assert.equal(verifySourceRoute(f).autoApprove,false);
  }
});
Deno.test('visual rows keep label/value and all recognized words, incomplete geometry rejected',()=>{
  const word=(text:string,x:number,y:number)=>({symbols:[{text}],boundingBox:{vertices:[{x,y},{x:x+70,y},{x:x+70,y:y+20},{x,y:y+20}]}});
  const words=[word('Amount',0,0),word('Total',0,30),word('320.00',150,0),word('320.00',150,30)];
  const annotation={pages:[{width:400,height:400,blocks:[{paragraphs:[{words}]}]}]};
  assert.equal(googleVisionLayoutText(annotation),'Amount 320.00\nTotal 320.00');
  (words as unknown[]).push({symbols:[{text:'Processing'}]});
  assert.equal(googleVisionLayoutText(annotation),'');
});
Deno.test('pending guidance prioritizes incomplete transfer and wrong sending app',()=>{
  assert.match(publicPendingReason(['maya_provider_confirmation_required','transaction_not_successful']),/still processing/);
  assert.match(publicPendingReason(['payment_source_unverified','payment_receiver_unverified']),/app you sent money from/);
});
