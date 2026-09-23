'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'index.html'),'utf8');
const start=source.indexOf('async function submitPlatformBooking() {');
const code=source.slice(start,source.indexOf('\nasync function submitBooking(e)',start));
function harness(result,{lostResponse=false}={}){
  const events={messages:[],invoices:[],reset:0};
  const fields=Object.fromEntries(['bName','bPhone','bEmail','bPay','bGcashRef'].map(id=>[id,{value:'TEST'}]));
  fields.bPay.value='gcash';fields.bGcashRef.value='1234567890123';fields.wizNextBtn={disabled:false};
  const c={$:id=>fields[id],_platformBookingAccess:{reference:'TEST-REF',bookingToken:'test-token',booking:{totalAmount:150}},_receiptFile:{},
    normalizePaymentRef:x=>x,isDigitalPayMethod:()=>true,isGcashRefValid:()=>true,isBdoPayRefValid:()=>true,isMayaRefValid:()=>true,isBpiConfirmationValid:()=>true,
    refundPolicyFeatureEnabled:()=>false,currentRefundPolicyAccepted:()=>true,overnightPolicyAccepted:()=>true,PaymentSourceUI:{referenceError:()=>''},
    DB:{submitPublicPaymentReceipt:async()=>{if(lostResponse)throw new TypeError('Load failed');return result;}},
    activeBookingItems:()=>[{total:150,courtName:'Test court'}],bookingMode:'regular',
    showInvoice:b=>events.invoices.push(b),toast:(message,type)=>events.messages.push({message,type}),
    savePlatformStatusAccess:()=>{},stopSlotCountdown:()=>{},startSavedPlatformBookingPolling:async()=>{},
    resetForm:()=>events.reset++,renderCourts:async()=>{},fetchAndAdoptPlatformBookingStatus:async()=>result};
  c.window=c;vm.createContext(c);vm.runInContext(code,c);return {c,events};
}

test('replayed cancelled status displays a cancelled invoice without requiring result.rejected',async()=>{
  const h=harness({status:'rejected',bookingStatus:'cancelled',paymentStatus:'rejected',flags:['duplicate_payment_reference']});
  await h.c.submitPlatformBooking();
  assert.equal(h.events.invoices[0].status,'cancelled');
  assert.equal(h.events.invoices[0].paymentStatus,'rejected');
  assert.equal(h.events.invoices[0]._receiptResult.status,'rejected');
  assert.match(h.events.messages[0].message,/cancelled/);
  assert.equal(h.events.messages[0].type,'err');
});

test('a response loss followed by authoritative cancelled status stops retries and explains the cancellation',async()=>{
  const h=harness({status:'cancelled',paymentStatus:'rejected',publicReason:'Booking cancelled — reference already used.'},{lostResponse:true});
  await h.c.submitPlatformBooking();
  assert.equal(h.events.reset,1);
  assert.equal(h.events.messages[0].message,'Booking cancelled — reference already used.');
  assert.equal(h.events.messages[0].type,'err');
  assert.doesNotMatch(h.events.messages[0].message,/track its review|retry|not confirmed/i);
});

test('unreadable receipt results still display pending and verified receipts still display confirmed',async()=>{
  for(const [result,expected] of [
    [{status:'manual_review',bookingStatus:'payment_review',paymentStatus:'pending'},'pending'],
    [{status:'auto_approved',bookingStatus:'confirmed',paymentStatus:'paid'},'confirmed'],
  ]){
    const h=harness(result);await h.c.submitPlatformBooking();
    assert.equal(h.events.invoices[0].status,expected);
    assert.equal(h.events.messages[0].type,'ok');
  }
});

test('receipt-only checkout submits without a typed transaction reference',async()=>{
 const h=harness({status:'manual_review',bookingStatus:'payment_review',paymentStatus:'pending'});
 h.c.$('bGcashRef').value='';let submitted;
 h.c.DB.submitPublicPaymentReceipt=async args=>{submitted=args;return {status:'manual_review',bookingStatus:'payment_review',paymentStatus:'pending'};};
 await h.c.submitPlatformBooking();assert(submitted);assert.equal(submitted.paymentReference,'');assert.equal(submitted.receiptFile,h.c._receiptFile);
});
