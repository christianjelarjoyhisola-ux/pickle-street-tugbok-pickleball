'use strict';
// Synthetic extraction records only; current source is read and never modified.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const repo=__dirname;
const admin=fs.readFileSync(path.join(repo,'admin.html'),'utf8');
function part(source,first,next){const a=source.indexOf(first),b=source.indexOf(next,a);assert(a>=0&&b>a,first);return source.slice(a,b);}
const displaySource=part(admin,'const RECEIPT_FLAG_LABELS =','function bookingSourceLabel(');
function display(){
  const c={window:{},fmt:n=>`PHP ${Number(n).toFixed(2)}`,esc:value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]))};
  vm.createContext(c);vm.runInContext(displaySource,c);return c;
}
function fixture(){return {paymentMethod:'gcash',receiptStatus:'manual_review',receiptFlags:['manual_review_required','payment_receiver_unverified','payment_receiver_name_unverified','payment_principal_unverified','existing_gcash_checks_pending'],receiptConfidence:6/7,
  receiptExtracted:{schemaVersion:2,provider:'google_vision',detected:{amounts:[2],paymentReference:'1234567890123',route:{recipientMatched:false}},comparison:{expectedAmount:2,amountMatched:true},
    timing:{receiptDate:'2026-09-08',receiptTime:'10:11',bookingStartedAt:'2026-09-08T02:09:45.963Z',tenantTimezone:'Asia/Manila',ageMinutes:1.23395,allowedWindowMinutes:15,earlyToleranceMinutes:2,withinWindow:true},confidence:{vision:.96,effective:6/7}}};}

test('a detected matching amount remains distinct from an unresolved strict principal check',()=>{
  const h=display(),html=h.receiptDetailsHtml(fixture());
  assert.match(html,/PHP 2\.00/);assert.match(html,/Transferred amount could not be verified/);
  assert.match(html,/Receiver could not be verified/);assert.doesNotMatch(html,/All visible checks passed/);
  assert.match(html,/96% Google Vision.*86% final score/);
});

test('recipient-name failure alone cannot be displayed as a matched account',()=>{
  const h=display(),b=fixture();b.receiptFlags=['payment_receiver_name_unverified'];
  assert.doesNotMatch(h.receiptReceiverValue(b.receiptExtracted,b),/Matched configured account/);
});

test('explicit failed route recipient evidence cannot be replaced by an absent-flag inference',()=>{
  const h=display(),b=fixture();b.receiptFlags=[];
  assert.doesNotMatch(h.receiptReceiverValue(b.receiptExtracted,b),/Matched configured account/);
});

test('internal strict-check wrapper flags have readable labels in reasons and chips',()=>{
  const h=display();
  for(const rendered of [h.receiptReasonText(['existing_gcash_checks_pending']),h.receiptFlagChips(['existing_gcash_checks_pending'])]) {
    assert.doesNotMatch(rendered,/existing_gcash_checks_pending/);assert.match(rendered,/GCash|check|verif/i);
  }
});

test('pending unreadable checks collapse into three clear review reasons instead of duplicate red warnings',()=>{
  const h=display(),b=fixture();
  b.paymentMethod='gotyme';
  b.receiptFlags=['automatic_checks_pending','instapay_unreadable','instapay_ref_unreadable','ref_unreadable','number_unreadable','payment_receiver_unverified','payment_reference_unverified','secondary_reference_unverified'];
  const flags=h.receiptFlagsForDisplay(b);
  assert.deepEqual(Array.from(flags),['payment_receiver_unverified','payment_reference_unverified','secondary_reference_unverified']);
  const review=h.receiptFlagChips(flags,'review'),history=h.receiptFlagChips(flags,'history');
  assert.equal((review.match(/receipt-chip/g)||[]).length,3);assert.match(review,/is-review/);assert.doesNotMatch(review,/unreadable/i);
  assert.match(history,/is-history/);assert.match(admin,/\.receipt-chip\.is-review/);assert.match(admin,/\.receipt-chip\.is-history/);
});

test('timing rounds display precision without changing the stored window decision',()=>{
  const h=display(),b=fixture(),original=JSON.stringify(b.receiptExtracted.timing),html=h.receiptDetailsHtml(b);
  assert.doesNotMatch(html,/1\.23395 min/);assert.match(html,/1\.2 min after/);assert.match(html,/Within window/);
  assert.equal(JSON.stringify(b.receiptExtracted.timing),original);
});

test('public pending explanations request existing proof or retry and never request another payment',()=>{
  const parser=fs.readFileSync(path.join(repo,'operations/pending-flow/backend/supabase/functions/picklestreet-receipts/parsers.ts'),'utf8');
  const start=parser.indexOf('export function publicPendingReason(');assert(start>=0);
  const fn=parser.slice(start).replace('export function','function').replace('flags:string[]','flags').replace("errorCode=''):string","errorCode='')");
  const c={};vm.createContext(c);vm.runInContext(fn,c);
  for(const flags of [['payment_receiver_name_unverified','payment_principal_unverified','existing_gcash_checks_pending'],['payment_principal_unverified'],['existing_gcash_checks_pending'],['verification_unavailable']]) {
    const reason=c.publicPendingReason(flags);assert.match(reason,/^Pending/);assert.doesNotMatch(reason,/pay again|another payment|rejected|cancelled|existing_gcash_checks_pending/i);
  }
});

function retryHarness({balanceRequestId='',responses=[]}={}){
  const calls=[],messages=[],refreshes=[];let uuid=0;
  const c={_receiptRetryKeys:new Map(),_verifyPaymentSaving:false,_curSection:'payreview',
    $:()=>({dataset:{ref:'PS-SYNTHETIC'}}),window:{PBReceiptPending:{receiptRetryTarget:()=>({verificationId:'synthetic-receipt-id',balanceRequestId})},crypto:{randomUUID:()=>`synthetic-key-${++uuid}`}},
    getBookingGroupByRef:async()=>({}),setVerifyPaymentSaving:value=>{c._verifyPaymentSaving=value;},
    DB:{retryPaymentReceipt:async(...args)=>{calls.push(args);const result=responses.shift();if(result instanceof Error)throw result;return result||{bookingStatus:'payment_review',paymentStatus:'pending'};}},
    toast:(message,kind)=>messages.push({message,kind}),closeVerifyModal:()=>{c.closed=(c.closed||0)+1;},
    renderBookings:async()=>refreshes.push('bookings'),renderDash:async()=>refreshes.push('dash'),renderPaymentReview:async()=>refreshes.push('review')};
  vm.createContext(c);vm.runInContext(part(admin,'async function retryAutomaticReceipt()','async function performRejectPayment()'),c);return {c,calls,messages,refreshes};
}

test('interrupted staff retry retains its key, then completed pending attempt permits a fresh retry',async()=>{
  const h=retryHarness({responses:[new Error('Network interrupted'),{bookingStatus:'payment_review',paymentStatus:'pending'},{bookingStatus:'payment_review',paymentStatus:'pending'}]});
  await h.c.retryAutomaticReceipt();assert.equal(h.c.closed,undefined);assert.equal(h.c._verifyPaymentSaving,false);
  await h.c.retryAutomaticReceipt();assert.equal(h.calls[0][1],h.calls[1][1]);assert.equal(h.c.closed,1);assert.equal(h.c._receiptRetryKeys.size,0);
  await h.c.retryAutomaticReceipt();assert.notEqual(h.calls[1][1],h.calls[2][1]);assert.equal(h.refreshes.length,6);
  assert.ok(h.messages.slice(1).every(x=>x.kind==='inf'));assert.ok(h.messages.slice(1).every(x=>/pending/i.test(x.message)));
});

test('pending balance retry never reports the original paid booking as an approved additional payment',async()=>{
  const h=retryHarness({balanceRequestId:'synthetic-balance-id',responses:[{bookingStatus:'confirmed',paymentStatus:'paid',balanceStatus:'payment_review'}]});
  await h.c.retryAutomaticReceipt();assert.equal(h.calls[0][2],'synthetic-balance-id');assert.equal(h.messages[0].kind,'inf');assert.match(h.messages[0].message,/remains pending/i);
});

const c=display();
const extraction=(recipientMatched,recipient)=>({provider:'google_vision',expectedReceiverName:'CONFIGURED EXPECTATION',expectedReceiverNumber:'09170000000',detected:{route:{recipientMatched,recipient}}});

test('observed masked name and full observed number remain distinct from expected settings',()=>{
  const ex=extraction(true,{observedName:'TE** VE***',observedNumber:'09171111111',phoneMatch:'exact',nameMatch:'masked_compatible'});
  assert.equal(c.receiptReceiverValue(ex),'TE** VE*** / 09171111111');
  assert.equal(c.receiptRecipientCheckValue(ex,{}),'Account number matches; the masked name is consistent');
  assert.doesNotMatch(c.receiptReceiverValue(ex),/CONFIGURED|09170000000/);
});

test('observed mismatched details stay visible and never become a successful check',()=>{
  const ex=extraction(false,{observedName:'OTHER OBSERVED NAME',observedNumber:'09172222222',phoneMatch:'mismatch',nameMatch:'mismatch'});
  assert.match(c.receiptReceiverValue(ex),/OTHER OBSERVED NAME/);assert.match(c.receiptRecipientCheckValue(ex,{}),/could not/);
  ex.detected.route.recipientMatched=true;
  assert.match(c.receiptRecipientCheckValue(ex,{receiptFlags:['payment_receiver_name_unverified']}),/could not/);
});

test('missing diagnostic fields show absence instead of an invented match or expected identity',()=>{
  for(const ex of [{},extraction(undefined,null),extraction(undefined,[]),{provider:'google_vision',expectedReceiverName:'CONFIGURED EXPECTATION'}]) {
    assert.match(c.receiptReceiverValue(ex),/not recorded/);assert.match(c.receiptRecipientCheckValue(ex,{}),/not recorded/);
    assert.doesNotMatch(c.receiptReceiverValue(ex),/CONFIGURED EXPECTATION/);
  }
});

test('OCR recipient observations are escaped before rendering',()=>{
  const ex=extraction(false,{observedName:'<img src=x onerror=bad()>',observedNumber:'09&"'});
  const html=c.receiptReceiverValue(ex);assert.doesNotMatch(html,/<img/);assert.match(html,/&lt;img/);assert.match(html,/&amp;&quot;/);
});

test('display rounding preserves sub-minute timing and does not mutate evidence',()=>{
  assert.equal(c.receiptWindowAgeText(1.23395),'1.2');assert.equal(c.receiptWindowAgeText(-1.9999),'2');
  assert.equal(c.receiptWindowAgeText(null),'');assert.equal(c.receiptWindowAgeText(0),'0');
});

function actionSavingHarness({canApprove=true,hasContext=true,retryDisabled=true}={}) {
  const buttons={vmRejectPaymentBtn:{disabled:!hasContext,hidden:false},vmManualConfirmBtn:{disabled:!hasContext||!canApprove,hidden:false},vmShortPaymentBtn:{disabled:false,hidden:true},vmPendingCloseBtn:{disabled:false,hidden:false},vmRetryReceiptBtn:{disabled:retryDisabled,hidden:false}};
  const c={_verifyPaymentSaving:false,_verifyPaymentDisabledBeforeSave:null,_verifyModalReviewContext:hasContext?{canApprove}:null,document:{querySelectorAll:()=>Object.values(buttons)},$:id=>id==='verifyModal'?{dataset:{receiptManual:'required'}}:buttons[id]};
  vm.createContext(c);vm.runInContext(part(admin,'function setVerifyPaymentSaving(','function canIssueShortPayment('),c);return {c,buttons};
}

test('leaving saving mode preserves an unavailable Retry action and hidden actions',()=>{
  const {c,buttons}=actionSavingHarness();c.setVerifyPaymentSaving(true);assert.ok(Object.values(buttons).every(b=>b.disabled));c.setVerifyPaymentSaving(false);
  assert.equal(buttons.vmRetryReceiptBtn.disabled,true);assert.equal(buttons.vmPendingCloseBtn.disabled,false);assert.equal(buttons.vmShortPaymentBtn.hidden,true);
});

test('repeated saving notifications restore enabled actions without enabling restricted Confirm',()=>{
  const {c,buttons}=actionSavingHarness({canApprove:false,retryDisabled:false});c.setVerifyPaymentSaving(true);c.setVerifyPaymentSaving(true);c.setVerifyPaymentSaving(false);
  assert.equal(buttons.vmRejectPaymentBtn.disabled,false);assert.equal(buttons.vmRetryReceiptBtn.disabled,false);assert.equal(buttons.vmManualConfirmBtn.disabled,true);
});

test('missing review context keeps financial actions disabled after saving',()=>{
  const {c,buttons}=actionSavingHarness({hasContext:false,retryDisabled:false});c.setVerifyPaymentSaving(true);c.setVerifyPaymentSaving(false);
  assert.equal(buttons.vmRejectPaymentBtn.disabled,true);assert.equal(buttons.vmManualConfirmBtn.disabled,true);assert.equal(buttons.vmRetryReceiptBtn.disabled,false);
});

test('staff-confirmed receipts keep earlier failure evidence under a historical label',()=>{
  const h=display(),b=fixture();b.receiptStatus='approved';b.receiptExtracted.review={decision:'approved',note:'Payment reviewed'};
  const html=h.receiptDetailsHtml(b);
  assert.match(html,/Earlier automatic-check reason/);assert.match(html,/Transferred amount could not be verified/);
  assert.equal(h.receiptHasHistoricalChecks(b),true);
  b.receiptStatus='manual_review';assert.equal(h.receiptHasHistoricalChecks(b),false);
  assert.doesNotMatch(h.receiptDetailsHtml(b),/Earlier automatic-check reason/);
});

test('System Owner-confirmed receipts display Auto Verified without claiming OCR checks passed',()=>{
  const h=display(),b=fixture();b.receiptStatus='auto_approved';b.receiptExtracted.review={decision:'approved',note:'Payment confirmed by owner'};
  assert.equal(h.receiptHasHistoricalChecks(b),true);assert.equal(h.receiptWasSystemOwnerConfirmed(b),true);
  const statusSource=part(admin,'async function vmPopulateReceipt(','async function vmReloadReceiptPreview(');
  assert.match(statusSource,/Auto Verified — confirmed by System Owner/);
});

function diagnosticsHarness() {
  const h=display(),pending=new Map(),elements=new Map();
  h.window.PB_PLATFORM_V1=true;h._vmReceiptLoadSeq=0;
  h.DB={getReceiptDiagnostics:(ref)=>new Promise(resolve=>pending.set(ref,resolve))};
  h.$=id=>{
    if(!elements.has(id))elements.set(id,{style:{},innerHTML:'',textContent:'',removeAttribute(){},insertAdjacentHTML(_place,value){this.innerHTML+=value;}});
    return elements.get(id);
  };
  vm.runInContext(part(admin,'async function receiptWithDiagnostics(','async function vmReloadReceiptPreview('),h);
  return {h,pending,elements};
}

test('saved observed recipient diagnostics hydrate the modal without rewriting the original audit evidence',async()=>{
  const {h,pending}=diagnosticsHarness(),b={...fixture(),ref:'PB-CURRENT',receiptVerificationId:'receipt-current'},original=JSON.stringify(b);
  const loading=h.receiptWithDiagnostics(b);
  pending.get(b.ref)({verificationId:b.receiptVerificationId,observedName:'TE•• VE••',observedNumber:'09171111111',recipientMatched:false,nameMatch:'mismatch',phoneMatch:'exact'});
  const hydrated=await loading;
  assert.equal(h.receiptReceiverValue(hydrated.receiptExtracted),'TE•• VE•• / 09171111111');
  assert.equal(JSON.stringify(b),original);assert.deepEqual(hydrated.receiptFlags,b.receiptFlags);
  assert.deepEqual(hydrated.receiptExtracted.timing,b.receiptExtracted.timing);
});

test('slow recipient diagnostic replies cannot overwrite a newer receipt modal',async()=>{
  const {h,pending,elements}=diagnosticsHarness();
  const earlier=h.vmPopulateReceipt({...fixture(),ref:'PB-OLD',receiptVerificationId:'old'});
  const current=h.vmPopulateReceipt({...fixture(),ref:'PB-NEW',receiptVerificationId:'new'});
  pending.get('PB-NEW')({verificationId:'new',observedName:'CURRENT RECIPIENT',observedNumber:'09171111111',recipientMatched:true});
  await current;
  const html=elements.get('vmReceiptDetails').innerHTML;assert.match(html,/CURRENT RECIPIENT/);
  pending.get('PB-OLD')({verificationId:'old',observedName:'STALE RECIPIENT',recipientMatched:false});
  await earlier;assert.equal(elements.get('vmReceiptDetails').innerHTML,html);
});

test('a diagnostic response for another verification is refused',async()=>{
  const {h,pending}=diagnosticsHarness();
  const loading=h.receiptWithDiagnostics({...fixture(),ref:'PB-CURRENT',receiptVerificationId:'current'});
  pending.get('PB-CURRENT')({verificationId:'another',observedName:'OTHER RECIPIENT'});
  await assert.rejects(loading,/changed/);
});
