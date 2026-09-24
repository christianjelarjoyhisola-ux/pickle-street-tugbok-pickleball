import assert from 'node:assert/strict';
import {verifySourceRoute,SOURCE_ROUTE_TENANT_ID,SOURCE_ROUTE_TENANT_SLUG,type SourceRouteInput} from './source-routes.ts';
function fixture():SourceRouteInput {
  return {vision:{confidence:.954,text:`4:56
Transfer successful!
Thursday, Sep 24 2026; 04:56:47 PM (GMT +8)
Confirmation No. 1626700000123
Transaction Ref. No. 147311
Sent via BPI
Transfer to
GCash/G-Xchange
Mariana Santos Cruz
09171234567
Add to Favorites
Transfer amount
PHP 110.00
Fee
PHP 0.00
New transfer
Go to Accounts`},image:{mimeType:'image/png',sizeBytes:339991},expectedAmount:110,currency:'PHP',payment:{paymentMethod:'bpi',submittedReference:'',receiverName:'MARIANA SANTOS CRUZ',receiverReference:'09171234567'},timing:{bookingStartedAt:'2026-09-24T08:53:19.73851Z',tenantTimezone:'Asia/Manila'},route:{tenantId:SOURCE_ROUTE_TENANT_ID,tenantSlug:SOURCE_ROUTE_TENANT_SLUG,sourceProvider:'bpi',destinationProvider:'gcash',destinationMethodCode:'gcash',enabled:true,autoApprovalEnabled:true,gcashQrAlias:'',gcashQrToken:''}};
}
Deno.test('BPI direct transfer uses full configured name and mobile, without QR settings',()=>{
 const r=verifySourceRoute(fixture());assert.equal(r.autoApprove,true,JSON.stringify(r.flags));assert.equal(r.paymentReference,'1626700000123');assert.equal(r.extractedData.timing.receiptDateTime,'2026-09-24T08:56:47Z');assert.equal(r.extractedData.detected.route.recipientMatched,true);assert.equal(r.extractedData.comparison.amountMatched,true);
});
Deno.test('BPI direct transfers accept international full mobile and comma timestamp',()=>{
 const f=fixture();f.vision.text=f.vision.text.replace('09171234567','+63 917 123 4567').replace('2026;','2026,');assert.equal(verifySourceRoute(f).autoApprove,true);
});
Deno.test('BPI direct transfer does not depend on unrelated QR alias',()=>{
 const f=fixture();f.route.gcashQrAlias='Different QR merchant';f.route.gcashQrToken='ABCD123456789';assert.equal(verifySourceRoute(f).autoApprove,true);
});
Deno.test('BPI direct transfer rejects wrong phone, wrong name, masked phone and misleading sender number',()=>{
 for(const change of [
  (s:string)=>s.replace('09171234567','09179999999'),
  (s:string)=>s.replace('Mariana Santos Cruz','Another Person'),
  (s:string)=>s.replace('09171234567','*******4567'),
  (s:string)=>'From\n09171234567\n'+s.replace('09171234567','*******4567'),
 ]){const f=fixture();f.vision.text=change(f.vision.text);assert.equal(verifySourceRoute(f).autoApprove,false);}
});
Deno.test('BPI direct transfer still needs amount, both references, transaction time and success',()=>{
 for(const change of [
  (s:string)=>s.replace('PHP 110.00','PHP 100.00'),
  (s:string)=>s.replace('Transaction Ref. No. 147311',''),
  (s:string)=>s.replace('Confirmation No. 1626700000123',''),
  (s:string)=>s.replace('Thursday, Sep 24 2026; 04:56:47 PM (GMT +8)',''),
  (s:string)=>s.replace('04:56:47 PM','05:56:47 PM'),
  (s:string)=>s.replace('Transfer successful!','Processing'),
 ]){const f=fixture();f.vision.text=change(f.vision.text);assert.equal(verifySourceRoute(f).autoApprove,false);}
});
Deno.test('BPI QR marker cannot use full-phone direct bypass',()=>{
 const f=fixture();f.vision.text=f.vision.text.replace('Mariana Santos Cruz','Mariana Santos Cruz (QR Code)');const r=verifySourceRoute(f);assert.equal(r.autoApprove,false);assert(r.flags.includes('qr_receipt_identity_unconfigured'));
});
