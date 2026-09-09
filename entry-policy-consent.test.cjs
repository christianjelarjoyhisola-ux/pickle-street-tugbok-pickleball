'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const page = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
function source(name) {
  const start = page.search(new RegExp('^(?:async )?function ' + name + '\\(', 'm'));
  assert.ok(start >= 0, 'Missing function ' + name);
  const end = page.indexOf('\n}', start);
  assert.ok(end > start, 'Missing function end ' + name);
  return page.slice(start, end + 2);
}
function node() {
  const classes = new Set(['active']);
  return { value:'', checked:false, disabled:false, hidden:false, textContent:'', dataset:{}, style:{}, isConnected:true,
    classList:{ contains:name=>classes.has(name), add:name=>classes.add(name), remove:name=>classes.delete(name), toggle(name,on){ if(on)classes.add(name);else classes.delete(name); } },
    dispatchEvent(){}, focus(){}, setAttribute(){}, removeAttribute(){}, querySelectorAll:()=>[], querySelector:()=>null };
}
function harness({ entry=true, ready=true } = {}) {
  const nodes = new Map();
  const $ = id => { if(!nodes.has(id)) nodes.set(id,node());return nodes.get(id); };
  const calls = { popup:0, complete:[], save:[], messages:[], submissions:0 };
  const version = 'entry-policy-test-v1', signature = 'entry-policy-test-signature';
  const expiry = new Date(Date.now()+600000).toISOString();
  const c = { $, window:{ PB_PLATFORM_V1:true }, document:{ querySelectorAll:()=>[], body:{style:{}}, activeElement:null }, Event:class Event{},
    REFUND_POLICY_CONFIGURED:ready, REFUND_POLICY_VERSION:ready?version:'', REFUND_POLICY_SIGNATURE:ready?signature:'',
    REFUND_POLICY_ACCEPTED_VERSION:'', REFUND_POLICY_ACCEPTED_SIGNATURE:'',
    refundPolicyFeatureEnabled:()=>true, syncRefundPolicyAcceptanceUi(){}, syncRefundPolicyFeatureUi(){},
    _platformHoldCreatePromise:null, _platformHoldCompletePromise:null, _proceedToBookPromise:null,
    _platformBookingAccess:{reference:'TEST-HOLD',bookingToken:'test-capability',expiresAt:expiry,preliminaryHold:true,booking:{detailsCompleted:false,status:'pending_payment',reservationHeld:true,expiresAt:expiry}},
    wizStep:4, bookingMode:'regular', payFull:true, EVENT_MAX_GUESTS:50, ALL_PAYMENT_METHODS:['gcash'],paymentMethods:{gcash:true},
    isEventBooking:()=>false, savePlatformRecovery:access=>calls.save.push(JSON.parse(JSON.stringify(access))),
    saveGuestBookingResume:extra=>calls.save.push(extra||{}),
    bookingReservationDeadlineMs:()=>Date.parse(expiry), readPlatformPendingDraft:()=>null,
    requestAnimationFrame:()=>{}, openRefundPolicyForBooking:()=>{calls.popup++;},
    toast:message=>calls.messages.push(message), bookingValidationError:(message,field,step)=>{calls.messages.push(message);if(step)c.wizStep=step;},
    wizGoTo:step=>{c.wizStep=step;}, submitBooking:async()=>{calls.submissions++;},
    fetchAndAdoptPlatformBookingStatus:async()=>c._platformBookingAccess.booking,
    loadOperatingHours:async()=>{}, closeRefundPolicy(){}, closeBookModal(){},
    normalizePaymentRef:value=>value, updateRefCount(){}, pickPay:method=>{$('bPay').value=method;}, setPayAmount(){},
    DB:{ clearCache(){},completePublicBookingHold:async payload=>{calls.complete.push(JSON.parse(JSON.stringify(payload)));if(c.completionError)throw c.completionError;if(c.completionDelay)await c.completionDelay;return {reference:'TEST-HOLD',detailsCompleted:true,expiresAt:expiry};} },
  };
  if(entry)c.window.PB_ENTRY_POLICY_CONSENT={version,signature};
  $('refundPolicyModal').dataset={policyConfigured:ready?'true':'false',policyVersion:ready?version:''};
  $('bName').value='Test Player';$('bPhone').value='09170000000';$('bEmail').value='player@example.test';$('bPay').value='gcash';
  const functions=['currentEntryPolicyConsent','applyEntryPolicyAcceptance','currentRefundPolicyAccepted','clearRefundPolicyAcceptance',
    'guestResumeFormDraft','restoreGuestResumeDraft','platformPolicyContextStillCurrent','platformPolicyChangedError','platformHoldHasDetails','platformHoldIsUsable',
    'platformAccessIsPreliminary','platformDetailsFromForm','recordPlatformHoldConsent','completePlatformBookingHold','platformWizardNext'];
  vm.runInNewContext(functions.map(source).join('\n'),c);
  return {c,$,calls,version,signature,expiry};
}

test('entry agreement waits for matching configured policy instead of accepting unloaded terms',()=>{
  const {c,$,version,signature}=harness({ready:false});
  assert.equal(c.currentEntryPolicyConsent(),null);
  c.applyEntryPolicyAcceptance();assert.equal($('bookingPolicyAgree').checked,false);
  c.REFUND_POLICY_CONFIGURED=true;c.REFUND_POLICY_VERSION=version;c.REFUND_POLICY_SIGNATURE=signature;
  $('refundPolicyModal').dataset={policyConfigured:'true',policyVersion:version};
  c.applyEntryPolicyAcceptance();assert.equal(c.currentRefundPolicyAccepted(),true);
});

test('entry agreement requires both current version and exact policy signature',()=>{
  for(const field of ['version','signature']){
    const {c,$}=harness();c.window.PB_ENTRY_POLICY_CONSENT[field]='other-policy';
    assert.equal(c.currentEntryPolicyConsent(),null);c.applyEntryPolicyAcceptance();
    assert.equal($('bookingPolicyAgree').checked,false);assert.equal(c.currentRefundPolicyAccepted(),false);
  }
});

test('initial settings load applies buffered consent; a policy revision invalidates it permanently',()=>{
  const {c,$}=harness({ready:false});
  const policy={version:'policy-v1',title:'Booking policy',intro:'Owner-approved booking terms.',content:'Keep the courts safe and enjoy your booking.'};
  c.normalizePublicRefundPolicy=settings=>settings.policy;
  c.replaceRefundPolicyBody=value=>{$('refundPolicyModal').dataset={policyConfigured:value?'true':'false',policyVersion:value?.version||''};};
  vm.runInNewContext(source('refundPolicySignature')+'\n'+source('configureRefundPolicyFromSettings'),c);
  c.window.PB_ENTRY_POLICY_CONSENT={version:policy.version,signature:c.refundPolicySignature(policy)};
  assert.equal(c.configureRefundPolicyFromSettings({policy}),true);
  assert.equal(c.currentRefundPolicyAccepted(),true);
  c.configureRefundPolicyFromSettings({policy:{...policy,content:'Changed owner-approved terms require another agreement.'}});
  assert.equal(c.currentRefundPolicyAccepted(),false);assert.equal(c.window.PB_ENTRY_POLICY_CONSENT,null);
  c.configureRefundPolicyFromSettings({policy});assert.equal(c.currentRefundPolicyAccepted(),false);
});

test('automatic recovery without an explicit entry or saved agreement remains unaccepted',()=>{
  const {c,$}=harness({entry:false});
  c.applyEntryPolicyAcceptance();c.restoreGuestResumeDraft({step:4});
  assert.equal(c.currentRefundPolicyAccepted(),false);assert.equal($('bookingPolicyAgree').checked,false);
});

test('restoring an older unaccepted draft preserves a new matching explicit entry agreement',()=>{
  const {c}=harness();
  c.restoreGuestResumeDraft({step:4,policyAgreed:false,policyVersion:'',policySignature:''});
  assert.equal(c.currentRefundPolicyAccepted(),true);
  const saved=c.guestResumeFormDraft();assert.equal(saved.policyAgreed,true);assert.equal(saved.policyVersion,c.REFUND_POLICY_VERSION);
});

test('saved checkout agreement restores only for the exact current policy',()=>{
  const {c,version,signature}=harness({entry:false});
  c.restoreGuestResumeDraft({policyAgreed:true,policyVersion:version,policySignature:signature});
  assert.equal(c.currentRefundPolicyAccepted(),true);
  c.restoreGuestResumeDraft({policyAgreed:true,policyVersion:version,policySignature:'outdated-text'});
  assert.equal(c.currentRefundPolicyAccepted(),false);
});

test('Payment Method Next saves agreed policy and details on the server without a second popup',async()=>{
  const {c,calls,version,expiry}=harness();
  await c.platformWizardNext();
  assert.equal(calls.popup,0);assert.equal(calls.complete.length,1);assert.equal(c.wizStep,5);
  assert.equal(calls.complete[0].policyAccepted,true);assert.equal(calls.complete[0].policyVersion,version);
  assert.equal(calls.complete[0].customer.name,'Test Player');assert.equal(c._platformBookingAccess.booking.detailsCompleted,true);
  assert.equal(c._platformBookingAccess.expiresAt,expiry);assert.equal(c.currentRefundPolicyAccepted(),true);
});

test('payment cannot open when saving agreed customer details fails',async()=>{
  const {c,calls}=harness();c.completionError=new Error('Temporary connection failure');
  await c.platformWizardNext();
  assert.equal(c.wizStep,4);assert.equal(calls.complete.length,1);assert.equal(calls.submissions,0);
  assert.equal(c._platformBookingAccess.booking.detailsCompleted,false);assert.ok(calls.messages.some(message=>/connection|save|try again/i.test(message)));
});

test('server policy mismatch clears entry acceptance and prevents repeated silent acceptance',async()=>{
  const {c,calls}=harness();c.completionError=Object.assign(new Error('The venue policy changed.'),{code:'POLICY_VERSION_STALE'});
  await c.platformWizardNext();
  assert.equal(c.wizStep,4);assert.equal(c.currentRefundPolicyAccepted(),false);assert.equal(c.window.PB_ENTRY_POLICY_CONSENT,null);
  await c.platformWizardNext();assert.equal(calls.popup,1);assert.equal(calls.complete.length,1);
});

test('missing or stale agreement still requires the current policy before payment',async()=>{
  for(const entry of [false,true]){
    const {c,calls}=harness({entry});if(entry)c.window.PB_ENTRY_POLICY_CONSENT.signature='stale';
    await c.platformWizardNext();assert.equal(c.wizStep,4);assert.equal(calls.popup,1);assert.equal(calls.complete.length,0);
  }
});

test('repeated Next during server completion does not create duplicate completion requests',async()=>{
  const {c,calls}=harness();let release;c.completionDelay=new Promise(resolve=>{release=resolve;});
  const first=c.platformWizardNext();await Promise.resolve();await c.platformWizardNext();
  assert.equal(calls.complete.length,1);release();await first;assert.equal(c.wizStep,5);
});

test('already completed checkout keeps its acceptance without sending details again',async()=>{
  const {c,calls}=harness();c._platformBookingAccess.booking.detailsCompleted=true;c._platformBookingAccess.preliminaryHold=false;
  await c.platformWizardNext();assert.equal(c.wizStep,5);assert.equal(calls.complete.length,0);assert.equal(calls.popup,0);
});

test('a lost completion reply reconciles saved details and retries without resubmitting consent',async()=>{
  const {c,calls}=harness();
  c.completionError=new Error('Response was lost after save');
  c.fetchAndAdoptPlatformBookingStatus=async()=>{c._platformBookingAccess.booking.detailsCompleted=true;c._platformBookingAccess.preliminaryHold=false;return c._platformBookingAccess.booking;};
  await c.platformWizardNext();assert.equal(c.wizStep,4);assert.equal(calls.complete.length,1);
  await c.platformWizardNext();assert.equal(c.wizStep,5);assert.equal(calls.complete.length,1);assert.equal(calls.popup,0);
});

test('retrying a pending hold after reload preserves its restored matching agreement',async()=>{
  const {c,version,signature}=harness({entry:false});
  c.restoreGuestResumeDraft({policyAgreed:true,policyVersion:version,policySignature:signature});
  assert.equal(c.currentRefundPolicyAccepted(),true);
  c._platformBookingAccess=null;
  c.uniqueBookingSelections=value=>value;c.activeBookingItems=()=>[{courtId:'test-court',date:'2026-10-01',slots:[10]}];
  c.slotsAreConsecutive=()=>true;c.readPlatformPendingDraft=()=>({kind:'selection_hold'});
  c.platformHoldRequestIdentity=async()=>({clientRequestId:'same-retry-request',fingerprint:'same-retry-fingerprint'});
  let pending;c.savePlatformPendingDraft=value=>{pending=value;};
  c.DB.createPublicBookingHold=async()=>{throw new Error('Simulated retry connectivity failure');};
  vm.runInNewContext(source('createPlatformBookingHold'),c);
  await assert.rejects(c.createPlatformBookingHold(),/Simulated retry/);
  assert.equal(pending.form.policyAgreed,true);assert.equal(pending.form.policyVersion,version);assert.equal(pending.form.policySignature,signature);
});

test('single and grouped preliminary holds preserve explicit agreement in the saved checkout draft',async()=>{
  for(const count of [1,3]){
    const {c,calls,version,signature,expiry}=harness();
    const items=Array.from({length:count},(_,index)=>({courtId:'test-court-'+index,courtName:'Court '+(index+1),date:'2026-10-01',slots:[10,11]}));
    c._platformBookingAccess=null;c.RESERVATION_MINUTES=10;
    c.uniqueBookingSelections=value=>value;c.activeBookingItems=()=>items;c.slotsAreConsecutive=()=>true;
    c.platformHoldRequestIdentity=async()=>({clientRequestId:'test-request',fingerprint:'test-fingerprint'});
    const pending=[];c.savePlatformPendingDraft=value=>pending.push(JSON.parse(JSON.stringify(value)));
    c.DB.createPublicBookingHold=async draft=>{calls.create=draft;return{reference:'TEST-HOLD',bookingToken:'test-capability',expiresAt:expiry,detailsCompleted:false,status:'pending_payment',reservationHeld:true};};
    c.platformBookingItemsFromSaved=draft=>draft.sessions||[draft];
    c.updatePrice=()=>{};c.startSlotCountdown=()=>{};c.reservationSecondsLeft=()=>599;c.showBookingIntro=()=>{};
    vm.runInNewContext(source('createPlatformBookingHold'),c);
    const access=await c.createPlatformBookingHold();
    assert.equal(pending.length,1);assert.equal(pending[0].form.policyAgreed,true);
    assert.equal(access.form.policyVersion,version);assert.equal(access.form.policySignature,signature);
    assert.equal(c.currentRefundPolicyAccepted(),true);assert.equal(access.expiresAt,expiry);
    assert.equal(calls.create.policyAccepted,undefined,'Selection hold must not claim that customer details were completed');
    if(count>1)assert.equal(calls.create.sessions.length,count);
  }
});
