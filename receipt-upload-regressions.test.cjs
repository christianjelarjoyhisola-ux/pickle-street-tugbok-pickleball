'use strict';
const test=require('node:test'),fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(require('node:path').join(__dirname,'index.html'),'utf8');
const start=source.indexOf('async function submitPlatformBooking() {');
const end=source.indexOf('async function submitBooking(e)',start);
assert(start>=0&&end>start);
const code=source.slice(start,end);
function harness(status,{uploadError=Object.assign(new TypeError('Load failed'),{receiptRequestId:'current-upload'})}={}){
  const events={submissions:[],messages:[],order:[],stopped:0,reset:0,statusSaved:0,polling:0,statusReads:0};
  const file={name:'TEST-RECEIPT.jpeg',type:'image/jpeg',size:1024};
  const access={reference:'TEST-BOOKING',bookingToken:'TEST-ACCESS',booking:{expiresAt:'2030-01-01T00:00:00Z'}};
  const fields={wizNextBtn:{disabled:false,textContent:'Confirm Booking'},bPay:{value:'gcash'},bGcashRef:{value:'1234567890123'}};
  const c={
    $:id=>fields[id],_platformBookingAccess:access,_receiptFile:file,
    normalizePaymentRef:ref=>ref,isDigitalPayMethod:()=>true,
    isGcashRefValid:()=>true,isBdoPayRefValid:()=>true,isMayaRefValid:()=>true,isBpiConfirmationValid:()=>true,
    refundPolicyFeatureEnabled:()=>false,currentRefundPolicyAccepted:()=>true,
    PaymentSourceUI:{referenceError:()=>''},
    toast:(message,type)=>{events.messages.push({message,type});events.order.push('toast');},
    bookingValidationError:message=>events.messages.push({message,type:'validation'}),
    DB:{submitPublicPaymentReceipt:async payload=>{events.order.push('upload');events.submissions.push(payload);throw uploadError;},getPublicBookingStatus:async()=>{events.order.push('status');events.statusReads++;if(status instanceof Error)throw status;return status;}},
    savePlatformStatusAccess:()=>events.statusSaved++,stopSlotCountdown:()=>events.stopped++,
    startSavedPlatformBookingPolling:async()=>events.polling++,resetForm:()=>events.reset++,
  };
  c.window=c;vm.createContext(c);
  for(const name of ['platformAccessIsPreliminary','platformAccessRequest','adoptPlatformBookingStatus','fetchAndAdoptPlatformBookingStatus']){
    const match=new RegExp('^(?:async )?function '+name+'\\s*\\(','m').exec(source);
    assert.ok(match,name);vm.runInContext(source.slice(match.index,source.indexOf('\n}',match.index)+2),c);
  }
  vm.runInContext(code,c);
  return{c,events,file,access,fields};
}
function retained(h){
  assert.equal(h.c._receiptFile,h.file,'selected receipt remains available');
  assert.equal(h.c._platformBookingAccess,h.access,'private access remains available');
  assert.equal(h.access.booking.expiresAt,'2030-01-01T00:00:00Z','server hold deadline is not restarted');
  assert.equal(h.fields.bGcashRef.value,'1234567890123','payment reference is retained');
  assert.equal(h.fields.bPay.value,'gcash','selected payment method is retained');
  assert.equal(h.events.reset,0,'form is not cleared without proof');
  assert.equal(h.events.stopped,0,'receipt failure does not stop the active hold countdown');
  assert.equal(h.events.statusSaved,0,'no received-proof state is synthesized');
  assert.equal(h.fields.wizNextBtn.disabled,false,'retry button is enabled');
  assert.equal(h.events.submissions.length,1,'no automatic duplicate upload');
  assert.equal(h.events.statusReads,1,'protected status is reconciled once');
  assert(!h.events.messages.some(row=>/proof.*was received|booking.*confirmed/i.test(row.message)),'no false success message');
}

test('transient upload failures retain receipt, reference, access and original hold',async()=>{
  const h=harness({status:'pending_payment',receiptStatus:'none'});await h.c.submitPlatformBooking();retained(h);
});

test('failed status reconciliation retains the receipt and original hold for retry',async()=>{
  const h=harness(new TypeError('Load failed'));await h.c.submitPlatformBooking();retained(h);
});

test('expired, cancelled or other states without proof never claim the receipt was received',async()=>{
  for(const status of ['expired','cancelled','payment_review','confirmed','completed']){
    const h=harness({status,paymentStatus:'pending',receiptStatus:'none'});await h.c.submitPlatformBooking();
    try{retained(h);}catch(error){error.message=status+': '+error.message;throw error;}
  }
});

test('useful network guidance replaces raw Safari error after protected reconciliation',async()=>{
  for(const error of [new TypeError('Load failed'),new TypeError('Failed to fetch'),Object.assign(new Error('signal is aborted without reason'),{name:'AbortError'}),new Error('The request timed out. Please check your connection and try again.')]){
    const h=harness({status:'pending_payment',receiptStatus:'none'},{uploadError:error});await h.c.submitPlatformBooking();
    assert.equal(h.events.messages.length,1);
    const message=h.events.messages[0].message;
    assert.notEqual(message,'Load failed');assert.notEqual(message,'Failed to fetch');
    assert.match(message,/connection|network|upload|receipt/i,'explain what is uncertain');
    assert.match(message,/retry|try again|check|refresh/i,'give a next action');
    assert.match(message,/pay again/i,'avoid a duplicate payment after an uncertain receipt request');
    assert(h.events.order.indexOf('status')<h.events.order.indexOf('toast'),'reconcile before guidance');
    retained(h);
  }
});

test('a recorded pending or manual-review receipt reconciles as received',async()=>{
  for(const status of [{status:'payment_review',receipt:{status:'pending'}},{status:'payment_review',receipt:{status:'manual_review'}},{status:'expired',receiptStatus:'manual_review'}]){
    const h=harness({...status,receiptUploadRequestId:'current-upload'});await h.c.submitPlatformBooking();
    assert.equal(h.events.statusSaved,1);assert.equal(h.events.stopped,1);assert.equal(h.events.polling,1);assert.equal(h.events.reset,1);
    assert.match(h.events.messages.at(-1).message,/received|saved/i);
    assert.equal(h.events.submissions.length,1);assert.equal(h.fields.wizNextBtn.disabled,false);
  }
});

test('an older stored receipt does not clear a replacement image after a failed upload',async()=>{
  const h=harness({status:'payment_review',receipt:{status:'manual_review'},receiptUploadRequestId:'previous-upload'});
  await h.c.submitPlatformBooking();retained(h);
});

test('successful proof submission stays successful when the later availability refresh fails',async()=>{
  const h=harness({status:'pending_payment',receiptStatus:'none'});
  h.c.DB.submitPublicPaymentReceipt=async()=>({ok:true,status:'manual_review',bookingStatus:'payment_review',paymentStatus:'pending'});
  for(const id of ['bName','bPhone','bEmail'])h.fields[id]={value:'Test only'};
  h.c.activeBookingItems=()=>[{total:215,courtName:'Test court'}];h.c.bookingMode='regular';
  h.c.showInvoice=()=>{};h.c.renderCourts=async()=>{throw new TypeError('Load failed');};
  await h.c.submitPlatformBooking();
  assert.equal(h.events.reset,1);assert.equal(h.events.statusReads,0);
  assert.equal(h.events.messages.length,1);assert.equal(h.events.messages[0].type,'ok');
  assert.match(h.events.messages[0].message,/awaiting payment review/);
});

test('confirmed plus paid state reconciles even when the status DTO omits receipt details',async()=>{
  const h=harness({status:'confirmed',paymentStatus:'paid'});await h.c.submitPlatformBooking();
  assert.equal(h.events.statusSaved,1);assert.equal(h.events.polling,1);assert.equal(h.events.reset,1);
});

test('explicit image validation errors retain their actionable message and selected image',async()=>{
  for(const message of ['Use a JPEG, PNG, or WebP receipt image.','The receipt image must be 8 MB or smaller.']){
    const h=harness({status:'pending_payment',receiptStatus:'none'},{uploadError:new Error(message)});await h.c.submitPlatformBooking();
    assert.equal(h.events.messages.at(-1).message,message);retained(h);
  }
});

function adapterHarness({slug='pickle-street-tugbok',fetchFailure=false}={}) {
  const adapter=fs.readFileSync(require('node:path').join(__dirname,'supabase-config.js'),'utf8');
  const helpers=adapter.slice(adapter.indexOf('const _pbReceiptAttemptKeys ='),adapter.indexOf('// Keep Supabase Auth'));
  const submit=adapter.slice(adapter.indexOf('  async submitPublicPaymentReceipt('),adapter.indexOf('  async getPublicBalancePaymentStatus('));
  const balance=adapter.slice(adapter.indexOf('  async submitPublicBalanceReceipt('),adapter.indexOf('  async startPlayerRainReport('));
  const requests=[];let serial=0;
  const c={URL,Headers,FormData,AbortController,setTimeout,clearTimeout,WeakMap,Map,
    PB_PLATFORM_V1:true,PB_TENANT_SLUG:slug,PB_PAGE_DATA_SCOPE:'public',PB_REQUEST_TIMEOUT_MS:1000,PB_RECEIPT_TIMEOUT_MS:1000,
    SUPABASE_URL:'https://neqvrwtofiolcuxewdze.supabase.co',SUPABASE_ANON_KEY:'test-public-key',
    // Image preparation can return a new Blob on each retry; the identity must use the original File.
    _pbPrepareReceiptImage:async file=>new Blob([await file.arrayBuffer()],{type:file.type}),
    _safeJsonParse:JSON.parse,_pbClearFastCache:()=>{},_pbApiErrorMessage:(_result,_text,fallback)=>fallback,
    fetch:async(url,init)=>{requests.push({url,init});if(fetchFailure)throw new TypeError('Load failed');return {ok:true,text:async()=>JSON.stringify({ok:true,bookingStatus:'payment_review',status:'manual_review'})};},
    window:{PB_TENANT_CONFIG:{receiptReviewMode:'auto_pending'},PB_PAYMENT_METHOD_CODES:{bdopay:'bdo_pay'},crypto:{randomUUID:()=>`00000000-0000-4000-8000-${String(++serial).padStart(12,'0')}`}},
  };
  vm.createContext(c);vm.runInContext(helpers+'\nglobalThis.adapter={'+submit+balance+'};',c);
  const payload={bookingReference:'PS-TEST',bookingToken:'test-private-token',paymentMethod:'gcash',paymentReference:'1234567890123',receiptFile:new File(['test-only'],'TEST-RECEIPT.png',{type:'image/png'})};
  return {c,requests,payload};
}

test('same initial proof retry reuses the request key after a lost response',async()=>{
  const h=adapterHarness({fetchFailure:true});
  for(let i=0;i<2;i++)await assert.rejects(h.c.adapter.submitPublicPaymentReceipt(h.payload),error=>{
    assert.match(error.message,/Load failed/);assert.equal(error.receiptRequestId,h.requests.at(-1).init.headers.get('x-idempotency-key'));return true;
  });
  assert.equal(h.requests.length,2);
  assert.equal(h.requests[0].init.headers.get('x-idempotency-key'),h.requests[1].init.headers.get('x-idempotency-key'));
  assert.notEqual(h.requests[0].init.body.get('receiptFile'),h.requests[1].init.body.get('receiptFile'),'prepared image identities differ');
});

test('a changed receipt, reference, booking or balance gets its own request key',async()=>{
  const h=adapterHarness();
  const variants=[{}, {receiptFile:new File(['other'],'OTHER.png',{type:'image/png'})}, {paymentReference:'9876543210123'}, {bookingReference:'PS-OTHER'}, {bookingToken:'other-token'}, {paymentMethod:'maya'}, {balanceRequestId:'00000000-0000-4000-8000-000000000001'}];
  for(const patch of variants)await h.c.adapter.submitPublicPaymentReceipt({...h.payload,...patch});
  assert.equal(new Set(h.requests.map(r=>r.init.headers.get('x-idempotency-key'))).size,variants.length);
  await h.c.adapter.submitPublicPaymentReceipt({...h.payload,idempotencyKey:'caller-stable-key'});
  assert.equal(h.requests.at(-1).init.headers.get('x-idempotency-key'),'caller-stable-key');
});

test('every source payment method sends the tenant-scoped multipart upload contract',async()=>{
  const h=adapterHarness();
  for(const method of ['gcash','maya','bdopay','bpi','gotyme','maribank','pnb']){
    await h.c.adapter.submitPublicPaymentReceipt({...h.payload,paymentMethod:method});
    const {url,init}=h.requests.at(-1);
    assert.match(url,/\/picklestreet-receipts\?tenantSlug=pickle-street-tugbok$/);
    assert.equal(init.method,'POST');assert.equal(init.headers.get('x-tenant-slug'),'pickle-street-tugbok');
    assert.equal(init.headers.get('x-booking-reference'),h.payload.bookingReference);assert.equal(init.headers.get('x-booking-token'),h.payload.bookingToken);
    assert.equal(init.headers.get('x-payment-method'),method==='bdopay'?'bdo_pay':method);
    assert.equal(init.headers.get('x-payment-reference'),h.payload.paymentReference);
    assert.equal(init.headers.has('content-type'),false,'browser supplies the multipart boundary');
    assert.equal(await init.body.get('receiptFile').text(),'test-only');
  }
});

test('balance receipt retry preserves its key and uses private balance access',async()=>{
  const h=adapterHarness();const payload={...h.payload,balanceRequestId:'00000000-0000-4000-8000-000000000001',balanceToken:'private-balance-token'};
  await h.c.adapter.submitPublicBalanceReceipt(payload);await h.c.adapter.submitPublicBalanceReceipt(payload);
  const [first,second]=h.requests.map(r=>r.init.headers);
  assert.equal(first.get('x-idempotency-key'),second.get('x-idempotency-key'));
  assert.equal(first.get('x-balance-request'),payload.balanceRequestId);assert.equal(first.get('x-booking-token'),payload.balanceToken);
});

test('other tenants retain the shared upload endpoint without the new header',async()=>{
  const h=adapterHarness({slug:'other-venue'});await h.c.adapter.submitPublicPaymentReceipt(h.payload);
  assert.match(h.requests[0].url,/\/submit-payment-receipt\?tenantSlug=other-venue$/);
  assert.equal(h.requests[0].init.headers.has('x-idempotency-key'),false);
});
