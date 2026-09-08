import assert from 'node:assert/strict';
import {verifyByMethod,publicPendingReason} from './parsers.ts';
import {handleRequest,staffReviewResponse} from './index.ts';
import {buildSafeReceiptExtraction} from '../_shared/receipt-verification.ts';
// Synthetic text fixtures exercise decision gates, not genuine bank payments.
function fixture(){return {
 vision:{confidence:0.99,text:'GCash Receipt\nSent to\nTEST PERSON ONLY\n09171234567\nSent via GCash\nAmount: PHP 215.00\nTotal Amount Sent: PHP 215.00\nReference No. 1234567890123\nSep 7, 2026 10:05 AM'},
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
for (const [time,passed] of [['10:09 AM',true],['10:10 AM',true],['10:11 AM',false],['10:16 AM',false]] as const) {
  Deno.test('Pickle Street accepts payments through 10 minutes: '+time,()=>{
    const f=fixture();f.vision.text=f.vision.text.replace('10:05 AM',time);
    const r=verifyByMethod(f);assert.equal(r.autoApprove,passed,JSON.stringify(r.flags));
    assert.equal(r.extractedData.timing.allowedWindowMinutes,10);
    assert.equal(r.flags.includes('payment_window_expired'),!passed);
  });
}
Deno.test('shared verifier still uses its existing 10-minute policy without the Pickle Street wrapper',()=>{
  const f=fixture();f.vision.text=f.vision.text.replace('10:05 AM','10:11 AM');
  const r=buildSafeReceiptExtraction(f);assert.equal(r.extractedData.timing.allowedWindowMinutes,10);assert.equal(r.autoApprove,false);
});
Deno.test('blank OCR text remains pending',()=>{const f=fixture();f.vision.text='';assert.equal(verifyByMethod(f).autoApprove,false);});
Deno.test('customer pending reasons avoid rejection instructions',()=>{for(const flags of [['duplicate_receipt_file'],['automatic_method_unsupported'],['payment_receiver_unverified'],['amount_mismatch'],['receipt_time_not_detected'],['vision_timeout']]){const r=publicPendingReason(flags);assert.match(r,/^Pending/);assert.doesNotMatch(r,/cancelled|rejected|pay again/i);}});
Deno.test('foreign tenant request is denied before database configuration access',async()=>{const response=await handleRequest(new Request('https://example.test?tenantSlug=other',{method:'POST',headers:{Origin:'https://picklestreet.pages.dev'}}));assert.equal(response.status,403);});
Deno.test('internal credentials are never accepted from this endpoint',async()=>{const response=await handleRequest(new Request('https://example.test?tenantSlug=pickle-street-tugbok',{method:'POST',headers:{'x-internal-secret':'invalid',Origin:'https://picklestreet.pages.dev'}}));assert.equal(response.status,403);});

const reviewId='10000000-0000-4000-8000-000000000001';
const attemptId='10000000-0000-4000-8000-000000000002';
function reviewDatabase(overrides:Record<string,unknown>={}) {
 const queries:{table:string;filters:unknown[]}[]=[],calls:unknown[]=[];
 const rows:Record<string,unknown>={receipt_verifications:{id:reviewId,booking_id:'booking-1',status:'manual_review',storage_path:'private/path'},
   bookings:{id:'booking-1',reference:'PS-TEST',status:'payment_review',payment_status:'pending'},
   picklestreet_receipt_jobs:{receipt_id:reviewId,current_attempt_id:attemptId},...overrides};
 const db={from(table:string){const q={table,filters:[] as unknown[]};queries.push(q);return {select(){return this;},eq(key:string,value:unknown){q.filters.push([key,value]);return this;},async maybeSingle(){return {data:rows[table],error:null};}};},
   async rpc(name:string,args:unknown){calls.push({name,args});return {data:{ok:true,receiptStatus:'rejected',status:'rejected',bookingStatus:'cancelled',paymentStatus:'rejected'},error:null};}};
 return {db,queries,calls};
}
Deno.test('staff review context returns the active attempt without disclosing storage paths',async()=>{
 const h=reviewDatabase();const r=await staffReviewResponse(h.db as any,{action:'review_context',verificationId:reviewId,bookingReference:'PS-TEST'},'verified-staff','https://picklestreet.pages.dev');
 const body=await r.json();assert.equal(body.attemptId,attemptId);assert.equal(body.paymentWindowMinutes,10);assert.equal(body.storage_path,undefined);assert.equal(h.calls.length,0);
 for(const q of h.queries)assert.ok(q.filters.some((f:any)=>f[0]==='tenant_id'&&f[1]==='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'));
});
Deno.test('manual decision RPC uses verified actor and caller attempt/idempotency, ignoring injected actors',async()=>{
 const h=reviewDatabase();await staffReviewResponse(h.db as any,{action:'review',verificationId:reviewId,bookingReference:'PS-TEST',expectedAttemptId:attemptId,idempotencyKey:'10000000-0000-4000-8000-000000000003',decision:'reject',note:'Not received',actor:'attacker'},'verified-staff','https://picklestreet.pages.dev');
 assert.equal(h.calls.length,1);const c=h.calls[0] as any;assert.equal(c.name,'review_picklestreet_pending_receipt');assert.equal(c.args.p_actor_user_id,'verified-staff');assert.equal(c.args.p_expected_attempt_id,attemptId);assert.equal(c.args.p_review_note,'Not received');
});
Deno.test('missing or changed receipt context and invalid rejection stop before the decision RPC',async()=>{
 for(const overrides of [{receipt_verifications:null},{bookings:null},{picklestreet_receipt_jobs:{receipt_id:'different',current_attempt_id:attemptId}}]){
   const h=reviewDatabase(overrides);await assert.rejects(staffReviewResponse(h.db as any,{action:'review_context',verificationId:reviewId,bookingReference:'PS-TEST'},'verified-staff','https://picklestreet.pages.dev'));assert.equal(h.calls.length,0);
 }
 const h=reviewDatabase();await assert.rejects(staffReviewResponse(h.db as any,{action:'review',verificationId:reviewId,bookingReference:'PS-TEST',decision:'reject',note:'x'},'verified-staff','https://picklestreet.pages.dev'));assert.equal(h.calls.length,0);
});
