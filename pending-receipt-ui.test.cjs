'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');
function helper(slug='pickle-street-tugbok'){
 const c={window:{PB_TENANT_CONFIG:{tenantSlug:slug,receiptReviewMode:'auto_pending'}},Intl,Date};vm.runInNewContext(fs.readFileSync('receipt-pending.js','utf8'),c);return c.window.PBReceiptPending;
}
function manualHelper(slug='pickle-street-tugbok') {
 const c={window:{PB_TENANT_CONFIG:{tenantSlug:slug,receiptReviewMode:'auto_pending',manualReceiptReviewEnabled:true}},Intl,Date};
 vm.runInNewContext(fs.readFileSync('receipt-pending.js','utf8'),c);return c.window.PBReceiptPending;
}
const pendingProof={ref:'PS-TEST',paymentMethod:'gcash',status:'pending',paymentStatus:'for_verification',receiptStatus:'manual_review',receiptVerificationId:'receipt-1',receiptImageUrl:'protected'};
test('manual buttons target pending proof only for Pickle Street when staff review is enabled',()=>{
 assert.equal(manualHelper().manualReviewTarget(pendingProof).verificationId,'receipt-1');
 for(const h of [manualHelper('other'),helper()])assert.equal(h.manualReviewTarget(pendingProof),null);
 for(const patch of [{status:'confirmed',paymentStatus:'paid'},{status:'cancelled'},{receiptStatus:'rejected'},{receiptImageUrl:null},{items:[{},{}]}])assert.equal(manualHelper().manualReviewTarget({...pendingProof,...patch}),null);
});
test('pending booking cards expose Confirm and Reject while settled cards do not',()=>{
 const admin=fs.readFileSync('admin.html','utf8'),start=admin.lastIndexOf('function bookingActionsHtml(');
 const source=admin.slice(start,admin.indexOf('\n}',start)+2);
 const c={sess:{role:'staff'},Auth:{can:()=>false},window:{PB_PLATFORM_V1:true,PBReceiptPending:manualHelper()},bookingDetailsButton:()=>'<button>Details</button>',weatherRefundActionButton:()=>'',multiSessionRescheduleNotice:()=>'',canRescheduleBooking:()=>false,canRestoreCancelledBooking:()=>false,jsArg:s=>s};
 vm.runInNewContext(source,c);
 const html=c.bookingActionsHtml(pendingProof,false);assert.match(html,/>Confirm<\/button>/);assert.match(html,/>Reject<\/button>/);assert.match(html,/reviewAction:'approve'/);assert.match(html,/reviewAction:'reject'/);
 const settled=c.bookingActionsHtml({...pendingProof,status:'confirmed',paymentStatus:'paid'},false);assert.doesNotMatch(settled,/reviewAction/);
});

function manualDecisionHarness({response={ok:true,receiptStatus:'approved',bookingStatus:'confirmed',paymentStatus:'paid'},answer='Payment not received',rejectOnce=false}={}){
 const admin=fs.readFileSync('admin.html','utf8'),start=admin.indexOf('async function performPendingReceiptReview(');
 const source=admin.slice(start,admin.indexOf('\n}',start)+2),calls=[],messages=[];
 const c={_verifyModalReviewContext:{bookingReference:'PS-TEST',verificationId:'receipt-1',attemptId:'attempt-1'},_manualReceiptDecisionKeys:new Map(),_curSection:'payreview',
 $:()=>({dataset:{ref:'PS-TEST'}}),window:{crypto:{randomUUID:()=> 'stable-request-key'}},prompt:()=>answer,toast:m=>messages.push(m),
 DB:{reviewPendingReceipt:async input=>{calls.push(input);if(rejectOnce&&calls.length===1)throw Error('Network interrupted');return response;}},
 closeVerifyModal:()=>{c.closed=true;},renderBookings:async()=>{},renderDash:async()=>{},renderPaymentReview:async()=>{}};
 vm.runInNewContext(source,c);return {c,calls,messages};
}
test('manual Confirm sends the displayed attempt and records staff confirmation separately from automatic approval',async()=>{
 const {c,calls,messages}=manualDecisionHarness();await c.performPendingReceiptReview('approve');
 assert.equal(calls.length,1);assert.equal(calls[0].decision,'approve');assert.equal(calls[0].expectedAttemptId,'attempt-1');assert.match(calls[0].note,/received by staff/);assert.equal(c.closed,true);assert.match(messages[0],/Booking confirmed/);
});
test('Reject requires a reason and preserves the previous payment when rejecting an additional receipt',async()=>{
 for(const answer of [null,'x','a'.repeat(1001)]){const h=manualDecisionHarness({answer});await h.c.performPendingReceiptReview('reject');assert.equal(h.calls.length,0);}
 const h=manualDecisionHarness({response:{ok:true,receiptStatus:'rejected',bookingStatus:'confirmed',paymentStatus:'paid',balanceStatus:'cancelled'}});h.c._verifyModalReviewContext.balanceRequestId='balance-1';await h.c.performPendingReceiptReview('reject');
 assert.equal(h.calls[0].decision,'reject');assert.match(h.messages[0],/previously accepted payments are preserved/);assert.doesNotMatch(h.messages[0],/Booking cancelled/);
});
test('manual review interruption preserves the idempotency key and never reports success for a pending result',async()=>{
 const h=manualDecisionHarness({rejectOnce:true});await assert.rejects(h.c.performPendingReceiptReview('approve'),/Network interrupted/);await h.c.performPendingReceiptReview('approve');assert.equal(h.calls[0].idempotencyKey,h.calls[1].idempotencyKey);
 const pending=manualDecisionHarness({response:{ok:true,receiptStatus:'manual_review'}});await assert.rejects(pending.c.performPendingReceiptReview('approve'),/check whether/);assert.equal(pending.c.closed,undefined);assert.equal(pending.messages.length,0);
 const absent=manualDecisionHarness();absent.c._verifyModalReviewContext=null;await absent.c.performPendingReceiptReview('approve');assert.equal(absent.calls.length,0);
});
test('unresolved receipt remains Pending after its court hold expires',()=>{const h=helper();const b={receiptFlow:'picklestreet_pending_v1',receiptPending:true,status:'expired',paymentStatus:'pending',reservationHeld:false};assert.equal(h.label(b),'Pending');assert.match(h.hold(b),/hold has ended/);});
test('historical cancellations and completed bookings keep their real status',()=>{const h=helper();for(const status of ['cancelled','completed']){const b={paymentMethod:'gcash',status,paymentStatus:'pending'};assert.equal(h.pending(b),false);assert.equal(h.label(b),status);}});
test('the pending policy does not apply to another tenant',()=>{assert.equal(helper('other').pending({receiptPending:true}),false);});
test('a reschedule balance never marks the original paid booking pending',()=>{const h=helper();const b={receiptFlow:'picklestreet_pending_v1',receiptPending:true,paymentMethod:'gcash',receiptBalanceRequestId:'balance-id',status:'confirmed',paymentStatus:'paid'};assert.equal(h.automatic(b),true);assert.equal(h.pending(b),false);});
test('money received excludes unverified booking totals',()=>{
 const admin=fs.readFileSync('admin.html','utf8');const start=admin.indexOf('  const receivedTotals={};');const end=admin.indexOf('  const receivedEntries=',start);
 const c={window:{BookingBalance:require('./booking-balance.js')},activeTxns:[{paymentMethod:'gcash',paymentStatus:'for_verification',total:430},{paymentMethod:'gcash',paymentStatus:'paid',total:215}],forfeitedTxns:[],receivedAccountKey:b=>b.paymentMethod};
 const result=vm.runInNewContext(admin.slice(start,end)+'receivedTotals',c);assert.equal(result.gcash,215);
});
test('staff retry cannot turn a pending result into a manual confirmation',async()=>{
 const admin=fs.readFileSync('admin.html','utf8');const start=admin.indexOf('async function retryAutomaticReceipt()');const source=admin.slice(start,admin.indexOf('\n}',start)+2);
 let resolve,writes=0;const messages=[];const c={_receiptRetryKeys:new Map(),_verifyPaymentSaving:false,_curSection:'payreview',$:()=>({dataset:{ref:'PS-TEST'}}),window:{PBReceiptPending:{receiptRetryTarget:()=>({verificationId:'receipt-id',balanceRequestId:''})},crypto:{randomUUID:()=> 'request-id'}},getBookingGroupByRef:async()=>({}),setVerifyPaymentSaving(v){c._verifyPaymentSaving=v;},DB:{retryPaymentReceipt:()=>{writes++;return new Promise(r=>resolve=r);}},toast:m=>messages.push(m),closeVerifyModal(){},renderBookings:async()=>{},renderDash:async()=>{},renderPaymentReview:async()=>{}};
 vm.runInNewContext(source,c);const first=c.retryAutomaticReceipt();await new Promise(r=>setImmediate(r));await c.retryAutomaticReceipt();assert.equal(writes,1);resolve({bookingStatus:'payment_review',paymentStatus:'pending',publicReason:'Pending — amount mismatch.'});await first;assert.deepEqual(messages,['Pending — amount mismatch.']);assert.equal(c._verifyPaymentSaving,false);
});
