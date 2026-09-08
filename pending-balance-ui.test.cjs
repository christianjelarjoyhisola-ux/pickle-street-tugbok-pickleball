'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function source(file){return fs.readFileSync(path.join(__dirname,file),'utf8');}
function helper(slug='pickle-street-tugbok') {const c={window:{PB_TENANT_CONFIG:{tenantSlug:slug,receiptReviewMode:'auto_pending'}},Intl,Date};vm.runInNewContext(source('receipt-pending.js'),c);return c.window.PBReceiptPending;}
function extract(file,start,next){const s=source(file),a=s.indexOf(start),b=s.indexOf(next,a);assert(a>=0&&b>a);return s.slice(a,b);}
const balanceBooking={ref:'PS-TEST',status:'confirmed',platformStatus:'confirmed',paymentStatus:'paid',paymentMethod:'gcash',receiptBalanceRequestId:'balance-1',balanceRequestId:'balance-1',balanceRequestStatus:'payment_review',receiptVerificationId:'receipt-1',balanceReservationHeld:false,balanceRequestType:'reschedule_adjustment'};

test('every generated script parses',()=>{for(const file of ['receipt-pending.js','supabase-config.js'])new vm.Script(source(file),{filename:file});for(const file of ['index.html','admin.html'])for(const [i,m] of [...source(file).matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].entries())new vm.Script(m[1],{filename:file+':script'+i});});
test('pending adjustment retains confirmed original booking and retries only its own receipt',()=>{const h=helper(),b=balanceBooking;assert.equal(h.automatic(b),true);assert.equal(h.pending(b),false);assert.equal(h.label(b),'confirmed');assert.equal(h.balancePending(b),true);assert.equal(h.receiptPending(b),true);assert.equal(h.receiptRetryTarget(b).balanceRequestId,'balance-1');assert.match(h.receiptHold(b),/original confirmed schedule remains/);});
test('new adjustment cannot retry original receipt or a different older balance receipt',()=>{const h=helper();assert.equal(h.receiptRetryTarget({...balanceBooking,receiptBalanceRequestId:null}),null);assert.equal(h.receiptRetryTarget({...balanceBooking,receiptBalanceRequestId:'older-balance'}),null);assert.equal(h.receiptRetryTarget({...balanceBooking,balanceRequestStatus:'settled'}),null);});
test('other tenants and historical cancelled bookings retain original behavior',()=>{assert.equal(helper('other').automatic(balanceBooking),false);const h=helper();assert.equal(h.pending({...balanceBooking,status:'cancelled',platformStatus:'cancelled',paymentStatus:'pending',receiptPending:true}),false);});
test('only flow-marked expired requests keep their matching receipt retryable',()=>{const h=helper(),expired={...balanceBooking,balanceRequestStatus:'expired',receiptStatus:'manual_review'};assert.equal(h.receiptRetryTarget(expired),null);assert.equal(h.receiptRetryTarget({...expired,balanceReceiptFlow:'picklestreet_pending_v1'}).balanceRequestId,'balance-1');assert.equal(h.receiptRetryTarget({...expired,balanceReceiptFlow:'picklestreet_pending_v1',status:'cancelled',platformStatus:'cancelled'}),null);assert.equal(h.receiptRetryTarget({...expired,balanceReceiptFlow:'picklestreet_pending_v1',receiptBalanceRequestId:'old'}),null);});
test('hold state requires all slots and uses original slots only for short payment',()=>{const s=source('supabase-config.js'),start=s.indexOf('balanceReservationHeld:')+'balanceReservationHeld:'.length,end=s.indexOf('    balanceAcceptedAmount:',start);const expr=s.slice(start,end).trim().replace(/,$/,'');function held(type,slots){const c={balanceRequest:{id:'balance-1',request_type:type},bookingSlots:slots,Date};vm.runInNewContext('held='+expr,c);return c.held;}const original={status:'confirmed'},future={status:'held',balance_request_id:'balance-1',hold_expires_at:'2099-01-01'},released={status:'released',balance_request_id:'balance-1'};assert.equal(held('reschedule_adjustment',[original,future,released]),false);assert.equal(held('reschedule_adjustment',[original,future]),true);assert.equal(held('reschedule_adjustment',[original]),false);assert.equal(held('short_payment',[original,released]),true);assert.equal(held('short_payment',[{status:'released'},future]),false);});
test('replacement upload remains enabled after released hold only with explicit server eligibility',()=>{const c={window:{PB_PLATFORM_V1:true,PBReceiptPending:helper()}};vm.runInNewContext(extract('index.html','function automaticBalanceReceiptFlow() {','function balanceStatusCopy('),c);assert.equal(c.balanceCanSubmitReceipt({status:'payment_review',canSubmitReceipt:true,reservationHeld:false}),true);assert.equal(c.balanceCanSubmitReceipt({status:'payment_review',reservationHeld:false}),false);assert.equal(c.balanceCanSubmitReceipt({status:'settled',canSubmitReceipt:true}),false);});
test('balance status route stays guest-capable and sends the balance token',async()=>{const calls=[];const c={PB_PLATFORM_V1:true,PB_TENANT_SLUG:'pickle-street-tugbok',window:{PB_TENANT_CONFIG:{receiptReviewMode:'auto_pending'}},_invokeEdgeFunction:async(...args)=>{calls.push(args);return {ok:true,balance:{status:'payment_review'}};}};const method=extract('supabase-config.js','  async getPublicBalancePaymentStatus(','  async submitPublicBalanceReceipt(');vm.runInNewContext('methods={'+method+'}',c);await c.methods.getPublicBalancePaymentStatus({balanceRequestId:'balance-1',balanceToken:'private'});assert.equal(calls[0][0],'picklestreet-receipts?tenantSlug=pickle-street-tugbok');assert.equal(calls[0][1].action,'balance_status');assert.equal(calls[0][1].balanceToken,'private');assert.match(source('supabase-config.js'),/\['status','balance_status'\]\.includes\(payload.action\)/);});
test('staff retry uses balance identity; original paid state never means adjustment confirmed',async()=>{let release;const calls=[],messages=[];const c={_receiptRetryKeys:new Map(),_verifyPaymentSaving:false,_curSection:'payreview',$:()=>({dataset:{ref:'PS-TEST'}}),window:{PBReceiptPending:helper(),crypto:{randomUUID:()=> 'stable-key'}},getBookingGroupByRef:async()=>balanceBooking,setVerifyPaymentSaving(v){c._verifyPaymentSaving=v;},DB:{retryPaymentReceipt(...args){calls.push(args);return new Promise(resolve=>release=resolve);}},toast:(...args)=>messages.push(args),closeVerifyModal(){},renderBookings:async()=>{},renderDash:async()=>{},renderPaymentReview:async()=>{}};vm.runInNewContext(extract('admin.html','async function retryAutomaticReceipt() {','async function performRejectPayment('),c);const pending=c.retryAutomaticReceipt();await new Promise(r=>setImmediate(r));await c.retryAutomaticReceipt();assert.equal(calls.length,1);assert.deepEqual(calls[0],['PS-TEST','stable-key','balance-1']);release({bookingStatus:'confirmed',paymentStatus:'paid',balanceStatus:'payment_review'});await pending;assert.match(messages[0][0],/remains pending/);assert.equal(messages[0][1],'inf');});

function submitContext(resultOrError) {
  const controls=[{disabled:false}];const inputs={balancePayReference:{value:'1234567890123'},balancePayMethod:{value:'gcash'}};const calls=[],messages=[],renders=[];const file={name:'proof.png'};
  const c={_balanceReceiptSaving:false,_balancePaymentAccess:{balanceRequestId:'balance-1',balanceToken:'private'},_balancePaymentState:{status:'payment_review',canSubmitReceipt:true,bookingReference:'PS-TEST',requestType:'reschedule_adjustment',reservationHeld:false},_balanceReceiptFile:file,_balanceReceiptPreviewUrl:'',_balanceReceiptAttempt:null,$:id=>inputs[id],window:{crypto:{randomUUID:()=> 'upload-key'}},automaticBalanceReceiptFlow:()=>true,balanceCanSubmitReceipt:b=>b.canSubmitReceipt===true,document:{querySelectorAll:()=>controls,contains:()=>true},URL:{revokeObjectURL(){}},DB:{submitPublicBalanceReceipt:async args=>{calls.push(args);if(resultOrError instanceof Error)throw resultOrError;return resultOrError;},getPublicBalancePaymentStatus:async()=>{throw Error('network');}},renderBalancePayment:b=>renders.push(b),toast:(...args)=>messages.push(args)};
  vm.runInNewContext(source('payment-source-ui.js'),c);
  vm.runInNewContext(extract('index.html','async function submitBalanceReceipt() {','async function openBalancePaymentFromLink('),c);return {c,calls,messages,renders,file};
}
test('replacement cannot claim schedule moved from OCR approval when balance stays pending',async()=>{const {c,calls,renders,messages}=submitContext({status:'auto_approved',balanceStatus:'payment_review',bookingStatus:'confirmed',paymentStatus:'paid',reservationHeld:false});await c.submitBalanceReceipt();assert.equal(calls[0].balanceRequestId,'balance-1');assert.equal(calls[0].idempotencyKey,'upload-key');assert.equal(renders[0].status,'payment_review');assert.equal(renders[0].canSubmitReceipt,true);assert.equal(messages[0][1],'inf');});
test('interrupted replacement retains same attempt and file without treating old proof as success',async()=>{const {c,calls,renders,file}=submitContext(new Error('interrupted'));await c.submitBalanceReceipt();await c.submitBalanceReceipt();assert.equal(calls[0].idempotencyKey,calls[1].idempotencyKey);assert.equal(c._balanceReceiptFile,file);assert.equal(renders.length,0);assert.equal(c._balanceReceiptSaving,false);});

test('balance network failures give retry guidance without requesting another payment',async()=>{
  const {c,messages,file}=submitContext(new TypeError('Load failed'));await c.submitBalanceReceipt();
  assert.match(messages[0][0],/Check your connection/);assert.match(messages[0][0],/Do not pay again/);
  assert.doesNotMatch(messages[0][0],/Load failed/);assert.equal(c._balanceReceiptFile,file);
});

function balanceViewHarness(statusRequest) {
  // Mount only IDs that exist in the real overlay, so a missing footer fails this test.
  const markup=extract('index.html','<div class="balance-pay-overlay"','<!-- QR ZOOM MODAL -->');
  const elements=Object.fromEntries([...markup.matchAll(/id="([^"]+)"/g)].map(m=>[m[1],{innerHTML:'',textContent:'',hidden:true,classList:{add(){},toggle(){}},setAttribute(){},replaceChildren(){this.innerHTML='';}}]));
  elements.balancePayBody.innerHTML='Checking your secure payment link...';
  elements.balancePayBody.closest=()=>({classList:{toggle(){}}});
  const c={_balancePaymentState:{status:'old'},_balancePaymentAccess:null,$:id=>elements[id],window:{PB_PLATFORM_V1:true,PaymentSourceUI:{label:(code,label)=>label}},
    document:{body:{style:{}}},balancePaymentLinkAccess:()=>({balanceRequestId:'fixture-only',balanceToken:'fixture-token'}),
    DB:{getPublicBalancePaymentStatus:statusRequest||(async()=>({status:'expired',canSubmit:false}))},
    balanceStatusCopy:()=>['pending','Payment status'],balanceCanSubmitReceipt:b=>b.canSubmit===true,automaticBalanceReceiptFlow:()=>true,
    balancePaymentMethods:()=>[],esc:v=>String(v??'').replaceAll('<','&lt;'),fmt:n=>`PHP ${n}`,balanceScheduleLabel:()=> 'Fixture schedule',balanceDeadlineLabel:()=> 'Fixture deadline',updateBalancePaymentMethod(){}};
  vm.createContext(c);
  vm.runInContext(extract('index.html','function renderBalancePayment(balance) {','let _balanceReceiptSaving = false;'),c);
  vm.runInContext(extract('index.html','async function openBalancePaymentFromLink() {','function closeBalancePayment() {'),c);
  return {c,elements};
}

test('real additional-payment overlay renders all action states instead of staying on loading',()=>{
  const {c,elements}=balanceViewHarness();
  for(const [balance,label,count] of [
    [{status:'awaiting_payment',canSubmit:true},'Submit balance payment',3],
    [{status:'awaiting_payment',canSubmit:true,requestType:'reschedule_adjustment'},'Submit additional payment',3],
    [{status:'payment_review',canSubmit:true,receipt:{status:'manual_review'}},'Submit corrected receipt',3],
    [{status:'payment_review',canSubmit:false},'Check status',2],
    [{status:'expired',canSubmit:false},'Close',1],
  ]) {
    c.renderBalancePayment(balance);const actions=elements.balancePayActions;
    assert.ok(actions,'The overlay must contain its action footer');assert.equal(actions.hidden,false);
    assert.doesNotMatch(elements.balancePayBody.innerHTML,/Checking your secure payment link/);
    assert.equal((actions.innerHTML.match(/<button /g)||[]).length,count);assert.ok(actions.innerHTML.includes(label));
    assert.equal(actions.innerHTML.includes('id="balancePaySubmit"'),balance.canSubmit);
  }
});

test('opening a new private payment link clears stale actions while status loads',async()=>{
  let resolve;const {c,elements}=balanceViewHarness(()=>new Promise(r=>{resolve=r;}));
  c.renderBalancePayment({status:'awaiting_payment',canSubmit:true});const pending=c.openBalancePaymentFromLink();
  assert.equal(elements.balancePayActions.hidden,true);assert.equal(elements.balancePayActions.innerHTML,'');assert.equal(c._balancePaymentState,null);
  resolve({status:'payment_review',canSubmit:false});await pending;
  assert.equal(elements.balancePayActions.hidden,false);assert.doesNotMatch(elements.balancePayActions.innerHTML,/balancePaySubmit/);
});

test('an invalid private payment link displays only Close and never stale submission controls',async()=>{
  const {c,elements}=balanceViewHarness(async()=>{throw Error('This link expired');});
  c.renderBalancePayment({status:'awaiting_payment',canSubmit:true});await c.openBalancePaymentFromLink();
  assert.match(elements.balancePayBody.innerHTML,/This link expired/);assert.equal(c._balancePaymentState,null);
  assert.equal((elements.balancePayActions.innerHTML.match(/<button /g)||[]).length,1);
  assert.match(elements.balancePayActions.innerHTML,/>Close</);assert.doesNotMatch(elements.balancePayActions.innerHTML,/balancePaySubmit/);
});
