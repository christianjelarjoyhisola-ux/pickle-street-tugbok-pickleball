'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');
function helper(slug='pickle-street-tugbok'){
 const c={window:{PB_TENANT_CONFIG:{tenantSlug:slug,receiptReviewMode:'auto_pending'}},Intl,Date};vm.runInNewContext(fs.readFileSync('receipt-pending.js','utf8'),c);return c.window.PBReceiptPending;
}
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
