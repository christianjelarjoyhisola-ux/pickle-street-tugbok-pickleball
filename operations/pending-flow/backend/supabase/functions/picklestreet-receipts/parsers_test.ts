import assert from 'node:assert/strict';
import {verifyByMethod,publicPendingReason} from './parsers.ts';
import {handleRequest} from './index.ts';
// Synthetic text fixtures exercise decision gates, not genuine bank payments.
function fixture(){return {
 vision:{confidence:0.99,text:'GCash Receipt\nSent to\nTEST PERSON ONLY\n09171234567\nAmount: PHP 215.00\nTotal Amount Sent: PHP 215.00\nReference No. 1234567890123\nSep 7, 2026 10:05 AM'},
 image:{mimeType:'image/png' as const,sizeBytes:2048},expectedAmount:215,currency:'PHP',
 payment:{paymentMethod:'gcash',submittedReference:'1234567890123',receiverName:'TEST PERSON ONLY',receiverReference:'09171234567',autoApprovalEnabled:true},
 timing:{bookingStartedAt:'2026-09-07T02:00:00Z',tenantTimezone:'Asia/Manila'},
};}
Deno.test('complete supported GCash evidence is an approval candidate',()=>{const r=verifyByMethod(fixture());assert.equal(r.autoApprove,true,JSON.stringify(r.flags));});
for(const state of ['Failed','Pending','Processing','Scheduled','Reversed','Refunded','Cancelled'])Deno.test(state+' overrides otherwise matching receipt',()=>{const f=fixture();f.vision.text+='\n'+state;const r=verifyByMethod(f);assert.equal(r.autoApprove,false);assert.ok(r.flags.includes('transaction_not_successful'));});
for(const method of ['maya','bdo_pay','bdo','bdopay','bpi','pnb','unknown'])Deno.test(method+' uses pending fallback rather than the GCash approval gate',()=>{const f=fixture();f.payment.paymentMethod=method;const r=verifyByMethod(f);assert.equal(r.autoApprove,false);assert.ok(r.flags.includes('automatic_method_unsupported'));});
Deno.test('disabled automatic approval is respected even for GCash',()=>{const f=fixture();f.payment.autoApprovalEnabled=false;assert.equal(verifyByMethod(f).autoApprove,false);});
Deno.test('sender account cannot satisfy recipient match',()=>{const f=fixture();f.vision.text=f.vision.text.replace('09171234567','09999999999')+'\nSender: 09171234567';assert.equal(verifyByMethod(f).autoApprove,false);});
Deno.test('matching one name cannot satisfy complete receiving name',()=>{const f=fixture();f.vision.text=f.vision.text.replace('TEST PERSON ONLY','TEST OTHER PERSON');assert.equal(verifyByMethod(f).autoApprove,false);});
Deno.test('masked recipient number remains pending',()=>{const f=fixture();f.vision.text=f.vision.text.replace('09171234567','0917***4567');assert.equal(verifyByMethod(f).autoApprove,false);});
Deno.test('matching total cannot hide a different principal payment',()=>{const f=fixture();f.vision.text=f.vision.text.replace('Amount: PHP 215.00','Amount: PHP 200.00');assert.equal(verifyByMethod(f).autoApprove,false);});
Deno.test('missing and mismatched references remain pending',()=>{for(const reference of ['','9999999999999']){const f=fixture();f.payment.submittedReference=reference;assert.equal(verifyByMethod(f).autoApprove,false);}});
Deno.test('payment outside original booking window remains pending on retry',()=>{const f=fixture();f.vision.text=f.vision.text.replace('10:05 AM','10:30 AM');assert.equal(verifyByMethod(f).autoApprove,false);});
Deno.test('blank OCR text remains pending',()=>{const f=fixture();f.vision.text='';assert.equal(verifyByMethod(f).autoApprove,false);});
Deno.test('customer pending reasons avoid rejection instructions',()=>{for(const flags of [['duplicate_receipt_file'],['automatic_method_unsupported'],['payment_receiver_unverified'],['amount_mismatch'],['receipt_time_not_detected'],['vision_timeout']]){const r=publicPendingReason(flags);assert.match(r,/^Pending/);assert.doesNotMatch(r,/cancelled|rejected|pay again/i);}});
Deno.test('foreign tenant request is denied before database configuration access',async()=>{const response=await handleRequest(new Request('https://example.test?tenantSlug=other',{method:'POST',headers:{Origin:'https://picklestreet.pages.dev'}}));assert.equal(response.status,403);});
Deno.test('internal credentials are never accepted from this endpoint',async()=>{const response=await handleRequest(new Request('https://example.test?tenantSlug=pickle-street-tugbok',{method:'POST',headers:{'x-internal-secret':'invalid',Origin:'https://picklestreet.pages.dev'}}));assert.equal(response.status,403);});
