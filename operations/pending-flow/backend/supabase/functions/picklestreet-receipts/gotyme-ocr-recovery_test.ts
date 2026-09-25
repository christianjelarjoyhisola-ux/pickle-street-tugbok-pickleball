import assert from 'node:assert/strict';
import { recoverReceiptReading } from './ocr-recovery.ts';
import { verifySourceRoute, SOURCE_ROUTE_TENANT_ID, SOURCE_ROUTE_TENANT_SLUG, type SourceRouteInput } from './source-routes.ts';

const complete = `Sent
PHP 210.00
Repeat
Add to favorites
Share
instaPay
Instant
To
Venue Recipient
0••••••2285
G-Xchange, Inc (GCash)
From
SYNTHETIC SENDER
••••••••7523
GoTyme Bank
Amount
PHP 210.00
Fee
PHP 0.00
Total
PHP 210.00
Note
Court booking payment
Trace ID
000001
Reference No.
ITO260925101519001
Date
25 Sep 2026 at 6:15 PM
Get help`;
const missingPhone=complete.replace('0••••••2285','');
const cropped=complete.slice(0,complete.indexOf('Reference No.'));
function input(text: string): SourceRouteInput {
 return {vision:{text,confidence:.94},image:{mimeType:'image/jpeg',sizeBytes:247000},expectedAmount:210,currency:'PHP',
 payment:{paymentMethod:'gotyme',submittedReference:'',receiverName:'Venue Recipient',receiverReference:'09272172285'},
 timing:{bookingStartedAt:'2026-09-25T10:14:22Z',tenantTimezone:'Asia/Manila'},
 route:{tenantId:SOURCE_ROUTE_TENANT_ID,tenantSlug:SOURCE_ROUTE_TENANT_SLUG,sourceProvider:'gotyme',destinationProvider:'gcash',destinationMethodCode:'gcash',enabled:true,autoApprovalEnabled:true}};
}
async function recover(primaryText:string, retryText=complete, layoutText?:string, retryConfidence=.94) {
 const f=input(primaryText);f.vision.layoutText=layoutText;
 let calls=0;const primary=verifySourceRoute(f);
 const result=await recoverReceiptReading({primary,vision:f.vision,method:'gotyme',verify:vision=>verifySourceRoute({...f,vision}),retry:async()=>{calls++;return {text:retryText,confidence:retryConfidence};}});
 return {result,primary,calls};
}
Deno.test('GoTyme full receipt auto-verifies without an extra OCR request',async()=>{
 const {result,calls}=await recover(complete);assert.equal(result.autoApprove,true,JSON.stringify(result.flags));assert.equal(calls,0);
});
Deno.test('GoTyme recovers a missing recipient mask from one complete independent reading',async()=>{
 const {result,primary,calls}=await recover(missingPhone);
 assert.equal(primary.autoApprove,false);assert.equal(result.autoApprove,true,JSON.stringify(result.flags));assert.equal(calls,1);
 assert.equal(result.paymentReference,'ITO260925101519001');assert.match(String((result.extractedData as {ocrFallbackReason?:string}).ocrFallbackReason),/independent text-mode/);
});
Deno.test('GoTyme visual-row recovery avoids a second Vision call',async()=>{
 const {result,calls}=await recover(missingPhone,missingPhone,complete);assert.equal(result.autoApprove,true);assert.equal(calls,0);
});
Deno.test('GoTyme cropped receipts, low-confidence retries and complementary partial reads stay pending',async()=>{
 assert.equal((await recover(cropped,cropped)).result.autoApprove,false);
 assert.equal((await recover(missingPhone,cropped)).result.autoApprove,false);
 assert.equal((await recover(missingPhone,complete,undefined,.7)).result.autoApprove,false);
});
Deno.test('GoTyme recovery cannot erase a mismatched recipient, amount, pending transfer or expired payment',async()=>{
 for(const text of [complete.replace('2285','9999'),complete.replace('Venue Recipient','Different Person'),complete.replaceAll('210.00','200.00'),complete+'\nProcessing',complete.replace('6:15 PM','6:50 PM')]){
  const {result,calls}=await recover(text);assert.equal(result.autoApprove,false,text);assert.equal(calls,0,text);
 }
});
Deno.test('GoTyme conflicting primary references remain pending',async()=>{
 const {result}=await recover(missingPhone.replace('ITO260925101519001','ITO260925101519002'));assert.equal(result.autoApprove,false);
});
Deno.test('GoTyme failed optional OCR preserves the initial evidence',async()=>{
 const f=input(missingPhone),primary=verifySourceRoute(f);
 const result=await recoverReceiptReading({primary,vision:f.vision,method:'gotyme',verify:vision=>verifySourceRoute({...f,vision}),retry:()=>Promise.reject(new Error('Vision timeout'))});
 assert.strictEqual(result,primary);
});
