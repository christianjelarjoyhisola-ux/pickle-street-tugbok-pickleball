'use strict';
// Proposed regression coverage. Run from the Pickle Street checkout.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const admin = fs.readFileSync('admin.html', 'utf8');
const config = fs.readFileSync('supabase-config.js', 'utf8');
function extract(source, name) {
  const start = source.search(new RegExp('^(?:async )?function ' + name + '\\(', 'm'));
  assert.ok(start >= 0, 'Missing function ' + name);
  const end = source.indexOf('\n}', start);
  assert.ok(end > start, 'Missing function end ' + name);
  return source.slice(start, end + 2);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function element() {
  return { value: '', hidden: false, disabled: false, textContent: '', innerHTML: '', src: '', href: '',
    dataset: {}, style: {}, classList: { add() {}, remove() {}, contains() { return true; } },
    removeAttribute(name) { this[name] = ''; }, setAttribute(name, value) { this[name] = value; },
    insertAdjacentHTML(_position, value) { this.innerHTML += value; },
    querySelectorAll() { return []; }, focus() {} };
}
function elements() {
  const nodes = new Map();
  return id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); };
}

function courtDateHarness({settingsWait=false}={}) {
  const source=fs.readFileSync('index.html','utf8'),oldResponse=deferred(),$=elements();
  const events={painted:0,terminal:[]};let loads=0;
  const context={$,sharedCourtDate:'2026-09-30',todayStr:()=> '2026-09-08',
    selectedCourtBrowseDate:()=>context.sharedCourtDate,
    window:{PB_PLATFORM_V1:true,PB_PUBLIC_BOOKING_ENABLED:true},
    loadOperatingHours:async()=>{if(settingsWait&&++loads===1)return oldResponse.promise;},
    refundPolicyReady:()=>true,
    DB:{getCourts:async()=>[],getBookings:async({date})=>!settingsWait&&date==='2026-09-30'?oldResponse.promise:[]},
    renderPublicTerminalState:(...args)=>events.terminal.push(args),updateWelcomePromotion:()=>{}, setPublicSplashBookingState:()=>{},
    document:{querySelector:()=>element()},syncBookingModeUi:()=>{},syncConfiguredBookingUi:()=>events.painted++,
    isEventBooking:()=>false,esc:value=>value,PUBLIC_BUSINESS_NAME:'Test venue'};
  vm.runInNewContext('let _courtsRenderGeneration=0;\n'+extract(source,'renderCourts'),context);
  return {context,events,oldResponse,$};
}

test('slow previous-date availability cannot repaint the current date or replace it with an error',async()=>{
  for(const fail of [false,true]){
    const h=courtDateHarness(),old=h.context.renderCourts();await new Promise(resolve=>setImmediate(resolve));
    h.context.sharedCourtDate='2026-09-08';await h.context.renderCourts();
    const currentHtml=h.$('courtsGrid').innerHTML;
    if(fail)h.oldResponse.reject(new Error('Old date request failed'));else h.oldResponse.resolve([]);
    await old;assert.equal(h.events.painted,1);assert.equal(h.events.terminal.length,0);
    assert.equal(h.$('courtsGrid').innerHTML,currentHtml);assert.equal(h.context.sharedCourtDate,'2026-09-08');
  }
});

test('stale readiness failure cannot hide newly loaded court availability',async()=>{
  const h=courtDateHarness({settingsWait:true}),old=h.context.renderCourts();
  h.context.sharedCourtDate='2026-09-08';await h.context.renderCourts();
  h.oldResponse.reject(new Error('Old readiness request failed'));await old;
  assert.equal(h.events.painted,1);assert.equal(h.events.terminal.length,0);
});

test('background court refresh uses the latest date chosen while settings were loading',async()=>{
  const waiting=deferred(),dates=[];
  const context={sharedCourtDate:'2026-09-30',selectedCourtBrowseDate:()=>context.sharedCourtDate,
    loadOperatingHours:()=>waiting.promise,renderCourts:async()=>dates.push(context.sharedCourtDate),court:null};
  vm.runInNewContext(extract(fs.readFileSync('index.html','utf8'),'refreshLiveViews'),context);
  const task=context.refreshLiveViews();context.sharedCourtDate='2026-09-08';waiting.resolve();await task;
  assert.deepEqual(dates,['2026-09-08']);
});

test('clearing the reschedule date invalidates a pending availability response', async () => {
  const pending = deferred();
  const $ = elements();
  $('rsNewDate').value = '2026-10-10';
  const state = { booking: { ref: 'PS-TEST' }, options: [], selectedIndex: -1, previewSeq: 0, saving: false };
  const context = { $, _rescheduleState: state, DB: { previewBookingReschedule: () => pending.promise },
    setRescheduleError() {}, updateRescheduleSaveState() {}, applyReschedulePolicies() {},
    renderRescheduleOptions() {}, rescheduleDurationLabel: () => '2 hours', fmtD: value => value };
  vm.runInNewContext(extract(admin, 'loadRescheduleOptions'), context);
  const loading = context.loadRescheduleOptions();
  $('rsNewDate').value = '';
  await context.loadRescheduleOptions();
  pending.resolve({ options: [{ available: true, startTime: '18:00' }] });
  await loading;
  assert.equal(state.options.length, 0, 'Cleared date must not retain another date\'s options');
  assert.equal(state.selectedIndex, -1);
});

function receiptHarness(getReceiptSignedUrl, getReceiptDiagnostics) {
  const $ = elements();
  const context = { $, window:{PB_PLATFORM_V1:Boolean(getReceiptDiagnostics)}, DB: { getReceiptSignedUrl, getReceiptDiagnostics }, _vmReceiptLoadSeq: 0,
    receiptFlagsForDisplay: () => [], receiptFlagChips: () => '', receiptDetailsHtml: () => '',
    receiptReasonText: () => '', _verifyModalOpenSeq: 0 };
  vm.runInNewContext(['receiptHasHistoricalChecks','receiptWithDiagnostics','vmPopulateReceipt'].map(name=>extract(admin,name)).join('\n'), context);
  return { $, context, populate: context.vmPopulateReceipt };
}
test('a failed receipt load removes the previous customer receipt', async () => {
  const pending = deferred();
  const h = receiptHarness(() => pending.promise);
  h.$('vmReceiptImg').src = 'https://example.test/previous-customer';
  h.$('vmReceiptLink').href = 'https://example.test/previous-customer';
  const loading = h.populate({ ref: 'PS-NEXT', receiptImageUrl: 'protected', receiptStatus: 'manual_review' });
  assert.equal(h.$('vmReceiptImg').src, '', 'Previous receipt must disappear before awaiting the next URL');
  assert.equal(h.$('vmReceiptLink').href, '');
  await new Promise(resolve=>setImmediate(resolve)); // Let the independent image request start before rejecting it.
  pending.reject(new Error('Receipt unavailable'));
  await loading;
  assert.equal(h.$('vmReceiptImg').src, '');
  assert.equal(h.$('vmReceiptNoImg').style.display, '');
});
test('a slower previous receipt cannot replace the currently selected receipt', async () => {
  const first = deferred(), second = deferred();
  const h = receiptHarness(ref => ref === 'PS-FIRST' ? first.promise : second.promise);
  const a = h.populate({ ref: 'PS-FIRST', receiptImageUrl: 'protected', receiptStatus: 'manual_review' });
  await new Promise(resolve=>setImmediate(resolve)); // Keep an actual first signing request in flight.
  const b = h.populate({ ref: 'PS-SECOND', receiptImageUrl: 'protected', receiptStatus: 'manual_review' });
  second.resolve('https://example.test/second-receipt');
  await b;
  h.$('vmReceiptImg').onload();
  first.resolve('https://example.test/first-receipt');
  await a;
  assert.equal(h.$('vmReceiptImg').src, 'https://example.test/second-receipt');
  assert.equal(h.$('vmReceiptLink').href, 'https://example.test/second-receipt');
});

test('a delayed diagnostic lookup clears previous image and evidence before waiting', async () => {
  const pending=deferred();let signed=0;
  const h=receiptHarness(async()=>{signed++;return 'https://example.test/current-receipt';},()=>pending.promise);
  h.$('vmReceiptImg').src='https://example.test/previous-receipt';h.$('vmReceiptLink').href='https://example.test/previous-receipt';
  h.$('vmReceiptDetails').innerHTML='Previous customer evidence';h.$('vmReceiptFlags').innerHTML='Previous flags';
  const loading=h.populate({ref:'PS-CURRENT',receiptVerificationId:'current',receiptImageUrl:'protected',receiptStatus:'approved'});
  assert.equal(h.$('vmReceiptImg').src,'');assert.equal(h.$('vmReceiptLink').href,'');
  assert.equal(h.$('vmReceiptDetails').innerHTML,'');assert.equal(h.$('vmReceiptFlags').innerHTML,'');assert.equal(signed,0);
  pending.resolve({verificationId:'current',recipientMatched:true,observedName:'CURRENT'});
  await loading;assert.equal(signed,1);assert.equal(h.$('vmReceiptImg').src,'https://example.test/current-receipt');
});

function normalizeBooking(row) {
  const context = { _pbZonedHour: value => Number(new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Manila', hour: '2-digit', hourCycle: 'h23' }).format(new Date(value))),
    _fmtBookingHour: hour => String(hour), _bookingSlotsTimeLabel: slots => slots.join(','),
    _pbPlatformRescheduleEventToLegacy: value => value, _pbNormalizeWeatherRefund: () => null };
  vm.runInNewContext(extract(config, '_pbPlatformBookingToLegacy'), context);
  return context._pbPlatformBookingToLegacy(row, new Map(), 'Asia/Manila');
}
const original = { id: 'booking-1', reference: 'PS-TEST', status: 'confirmed', payment_status: 'paid',
  starts_at: '2026-10-10T09:00:00+08:00', ends_at: '2026-10-10T11:00:00+08:00',
  local_booking_date: '2026-10-10', total_amount: 600 };

test('sanitized manager receipt availability reaches the protected image loader without a private path', async () => {
  const booking = normalizeBooking({ ...original, receipt_verifications: [{
    id: 'receipt-1', status: 'manual_review', created_at: '2026-10-10T01:00:00Z', image_available: true,
  }] });
  assert.equal(booking.receiptImageUrl, 'protected');
  let request;
  const h = receiptHarness(async (ref, id) => { request = {ref, id}; return 'https://example.test/private-receipt'; });
  await h.populate(booking);
  assert.deepEqual(request, {ref: 'PS-TEST', id: 'receipt-1'});
  assert.match(h.$('vmReceiptNoImg').textContent, /Loading uploaded receipt/);
  assert.equal(h.$('vmReceiptLink').style.display, 'none', 'Do not offer an image before it loads');
  h.$('vmReceiptImg').onload();
  assert.equal(h.$('vmReceiptNoImg').style.display, 'none');
  assert.equal(h.$('vmReceiptLink').href, 'https://example.test/private-receipt');
});

test('receipt availability respects explicit false and malformed flags and supports older projections', () => {
  for (const availability of [false, 'true', null, 1]) {
    const b = normalizeBooking({...original, receipt_verifications:[{id:'r', image_available:availability, storage_path:'private/path'}]});
    assert.equal(b.receiptImageUrl, null);
  }
  for (const receipt of [{id:'r', imageAvailable:true}, {id:'r', storage_path:'private/path'}, {id:'r', storagePath:'private/path'}]) {
    const b = normalizeBooking({...original, receipt_verifications:[receipt]});
    assert.equal(b.receiptImageUrl, 'protected');
  }
  assert.equal(normalizeBooking(original).receiptImageUrl, null);
});

test('only truly absent receipt evidence shows the missing-upload message without a signing request', async () => {
  let calls = 0;
  const h = receiptHarness(async () => { calls++; });
  await h.populate({ref:'PS-EMPTY', receiptStatus:'manual_review', receiptImageUrl:null});
  assert.equal(calls, 0);
  assert.match(h.$('vmReceiptNoImg').textContent, /No receipt image was uploaded/);
  assert.equal(h.$('vmReceiptImageRetry').style.display, 'none');
});

test('image download failure preserves uploaded status and a retry obtains a fresh link', async () => {
  let calls = 0;
  const h = receiptHarness(async () => 'https://example.test/receipt-' + ++calls);
  const booking = {ref:'PS-RETRY', receiptImageUrl:'protected', receiptStatus:'manual_review'};
  await h.populate(booking);
  h.$('vmReceiptImg').onerror();
  assert.equal(h.$('vmReceiptImg').src, '');
  assert.match(h.$('vmReceiptNoImg').textContent, /receipt is uploaded/);
  assert.equal(h.$('vmReceiptImageRetry').style.display, '');
  await h.populate(booking);
  h.$('vmReceiptImg').onload();
  assert.equal(h.$('vmReceiptLink').href, 'https://example.test/receipt-2');
  assert.equal(h.$('vmReceiptNoImg').style.display, 'none');
});

test('late image events and signing failures do not change a newer receipt or reopen a closed preview', async () => {
  const h = receiptHarness(async ref => 'https://example.test/' + ref);
  await h.populate({ref:'PS-A', receiptImageUrl:'protected'});
  const oldLoad = h.$('vmReceiptImg').onload, oldError = h.$('vmReceiptImg').onerror;
  await h.populate({ref:'PS-B', receiptImageUrl:'protected'});
  h.$('vmReceiptImg').onload();
  oldError(); oldLoad();
  assert.equal(h.$('vmReceiptLink').href, 'https://example.test/PS-B');
  vm.runInNewContext(extract(admin, 'closeVerifyModal'), h.context);
  const lateLoad = h.$('vmReceiptImg').onload;
  h.context.closeVerifyModal({restoreFocus:false});
  lateLoad();
  assert.equal(h.$('vmReceiptImg').src, '');
  assert.equal(h.$('vmReceiptLink').href, '');
  assert.equal(h.$('vmReceiptImg').onload, null);
});

test('a failed old reload cannot overwrite a reopened preview for the same booking', async () => {
  const pending = deferred(), $ = elements();
  $('verifyModal').dataset.ref = 'PS-SAME';
  const context = {$, _verifyPaymentSaving:false, _verifyModalLastFocus:null, _verifyModalOpenSeq:1};
  context.openVerifyModal = () => { context._verifyModalOpenSeq++; return pending.promise; };
  vm.runInNewContext(extract(admin,'vmReloadReceiptPreview'),context);
  const loading = context.vmReloadReceiptPreview();
  context._verifyModalOpenSeq += 2; // Close, then reopen the same reference.
  $('vmReceiptNoImg').textContent = 'New receipt loaded';
  $('vmReceiptImageRetry').disabled = true; // A newer reload is running.
  pending.reject(new Error('Old request failed'));
  await loading;
  assert.equal($('vmReceiptNoImg').textContent,'New receipt loaded');
  assert.equal($('vmReceiptImageRetry').disabled,true);
});
test('a pending paid reschedule retains only the original confirmed hours in the booking projection', () => {
  const booking = normalizeBooking({ ...original, booking_slots: [
    { status: 'confirmed', starts_at: '2026-10-10T09:00:00+08:00' },
    { status: 'confirmed', starts_at: '2026-10-10T10:00:00+08:00' },
    { status: 'held', starts_at: '2026-10-11T18:00:00+08:00', balance_request_id: 'request-1' },
    { status: 'held', starts_at: '2026-10-11T19:00:00+08:00', balance_request_id: 'request-1' },
  ] });
  assert.deepEqual(Array.from(booking.slots), [9, 10]);
  assert.equal(booking.duration, 2);
  assert.equal(booking.date, '2026-10-10');
});
test('settled reschedule slots remain visible even though they retain a balance-request id', () => {
  const booking = normalizeBooking({ ...original, starts_at: '2026-10-11T18:00:00+08:00',
    ends_at: '2026-10-11T20:00:00+08:00', local_booking_date: '2026-10-11', booking_slots: [
      { status: 'confirmed', starts_at: '2026-10-11T18:00:00+08:00', balance_request_id: 'request-1' },
      { status: 'confirmed', starts_at: '2026-10-11T19:00:00+08:00', balance_request_id: 'request-1' },
    ] });
  assert.deepEqual(Array.from(booking.slots), [18, 19]);
  assert.equal(booking.date, '2026-10-11');
});

function verificationHarness({ emailStatus = 'sent', refreshFails = false } = {}) {
  const pending = deferred();
  const $ = elements();
  $('verifyModal').dataset.ref = 'PS-TEST';
  let writes = 0, emails = 0, reads = 0;
  const messages = [];
  const booking = { ref: 'PS-TEST', total: 600, downpayment: 600, paymentMethod: 'gcash',
    receiptImageUrl: 'protected', email: 'guest@example.test' };
  const context = { $, _verifyPaymentSaving: false, _curSection: 'bookings',
    document: { querySelectorAll: () => [$('approveButton'), $('rejectButton')] },
    window: { PB_PLATFORM_V1: true },
    getBookingGroupByRef: async () => { reads++; return pending.promise; },
    isDigitalPayment: () => true,
    updateBookingGroupByRef: async () => { writes++; return { ...booking, reviewResults: [
      { ok: true, confirmationEmail: emailStatus } ] }; },
    closeVerifyModal() {}, toast: message => messages.push(message),
    renderBookings: async () => { if (refreshFails) throw new Error('Table refresh failed'); },
    renderPaymentReview: async () => {}, renderDash: async () => {},
    sendBookingConfirmationNotice: async () => { emails++; }, notifyBookingUpdateSafe: async () => {},
  };
  vm.runInNewContext(extract(admin, 'setVerifyPaymentSaving') + '\n' + extract(admin, 'verifyAndConfirm'), context);
  return { $, context, messages, pending, booking, writes: () => writes, emails: () => emails, reads: () => reads };
}
test('two confirmation clicks issue one review and do not resend the backend confirmation email', async () => {
  const h = verificationHarness();
  const first = h.context.verifyAndConfirm();
  const second = h.context.verifyAndConfirm();
  assert.equal(h.reads(), 1, 'The second click must stop before fetching or reviewing a booking');
  assert.equal(h.$('approveButton').disabled, true);
  h.pending.resolve(h.booking);
  await Promise.all([first, second]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.writes(), 1);
  assert.equal(h.emails(), 0, 'The backend already handled the confirmation email');
  assert.equal(h.$('approveButton').disabled, false);
});
test('a committed review stays successful when dashboard refresh fails and reports backend email failure', async () => {
  const h = verificationHarness({ emailStatus: 'failed', refreshFails: true });
  const confirming = h.context.verifyAndConfirm();
  h.pending.resolve(h.booking);
  await confirming;
  assert.equal(h.writes(), 1);
  assert.ok(h.messages.some(message => /booking confirmed/i.test(message)));
  assert.ok(h.messages.some(message => /email was not sent/i.test(message)));
  assert.ok(h.messages.every(message => !/failed to confirm|table refresh failed/i.test(message)));
  assert.equal(h.context._verifyPaymentSaving, false);
});

function rejectionHarness(reason, { readFails = false } = {}) {
  const $ = elements();
  $('verifyModal').dataset.ref = 'PS-TEST';
  const writes = [], messages = [];
  let confirmations = 0;
  const context = { $, window:{}, _verifyPaymentSaving: false, _curSection: 'bookings',
    document: { querySelectorAll: () => [$('approveButton'), $('rejectButton')] },
    getBookingGroupByRef: async () => {
      if (readFails) throw new Error('Booking reload unavailable');
      return { ref: 'PS-TEST', receiptBalanceRequestId: 'balance-request-1', balanceRequestType: 'reschedule_adjustment' };
    },
    prompt: () => reason, confirm: () => { confirmations++; return true; },
    updateBookingGroupByRef: async (ref, updates) => { writes.push({ ref, ...updates }); },
    closeVerifyModal() {}, toast: message => messages.push(message),
    renderBookings: async () => {}, renderPaymentReview: async () => {}, renderDash: async () => {},
    notifyBookingUpdateSafe: async () => {},
  };
  vm.runInNewContext(['setVerifyPaymentSaving', 'performRejectPayment', 'rejectPayment']
    .map(name => extract(admin, name)).join('\n'), context);
  return { context, writes, messages, confirmations: () => confirmations };
}
test('receipt rejection stops before confirmation or write when the required reason is missing or invalid', async () => {
  for (const reason of [null, '', '  ', 'ab', 'x'.repeat(1001)]) {
    const h = rejectionHarness(reason);
    await h.context.rejectPayment();
    assert.equal(h.writes.length, 0);
    assert.equal(h.confirmations(), 0);
    assert.equal(h.context._verifyPaymentSaving, false);
  }
});
test('receipt rejection sends the trimmed backend review reason once and preserves original balance-booking status copy', async () => {
  const h = rejectionHarness('  Payment was not received  ');
  await Promise.all([h.context.rejectPayment(), h.context.rejectPayment()]);
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].reviewNote, 'Payment was not received');
  assert.equal(h.writes[0].paymentStatus, 'rejected');
  assert.ok(h.messages.some(message => /original booking status is unchanged/i.test(message)));
  assert.equal(h.context._verifyPaymentSaving, false);
});
test('rejection and short-payment actions surface initial read errors and always release their busy state', async () => {
  for (const [action, implementation] of [['rejectPayment', 'performRejectPayment'], ['markPaymentShort', 'performMarkPaymentShort']]) {
    const h = rejectionHarness('Payment was not received', { readFails: true });
    vm.runInNewContext(extract(admin, implementation) + '\n' + extract(admin, action), h.context);
    await assert.doesNotReject(h.context[action]());
    assert.ok(h.messages.some(message => /Booking reload unavailable|Could not load/i.test(message)));
    assert.equal(h.writes.length, 0);
    assert.equal(h.context._verifyPaymentSaving, false);
  }
});
test('a cheaper reschedule keeps the original booked total and does not imply a refund', () => {
  const $ = elements();
  $('rsNewDate').value = '2026-10-11';
  const booking = { date: '2026-10-10', total: 700, startTime: '18:00', endTime: '20:00' };
  const option = { startsAt: '2026-10-11T08:00:00+08:00', startTime: '08:00', endTime: '10:00',
    originalTotalAmount: 700, newTotalAmount: 500, additionalAmount: 0 };
  const context = { $, _rescheduleState: { booking }, rescheduleSelectedOption: () => option,
    fmt: value => 'PHP ' + value, fmtD: value => value, rescheduleClockLabel: value => value,
    updateRescheduleSaveState() {} };
  vm.runInNewContext(extract(admin, 'updateRescheduleSummary'), context);
  context.updateRescheduleSummary();
  assert.equal($('rsOriginalTotal').textContent, 'PHP 700');
  assert.equal($('rsNewTotal').textContent, 'PHP 700');
  assert.equal($('rsAdditionalAmount').textContent, 'None');
});
