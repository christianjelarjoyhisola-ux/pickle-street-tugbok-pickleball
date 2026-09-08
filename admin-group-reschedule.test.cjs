'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { normalizeSession, collectChanges, validatePrice, scheduleLabel } = require('./admin-group-reschedule.js');
const sessions = [
  normalizeSession({ sessionId: 'court-one-morning', courtId: 'one', courtName: 'Court 1', bookingDate: '2026-09-12', startTime: '08:00', durationHours: 2 }),
  normalizeSession({ sessionId: 'court-two-evening', courtId: 'two', courtName: 'Court 2', bookingDate: '2026-09-12', startTime: '18:00', durationHours: 1 }),
];
const draft = (selected, newDate, newStartTime) => ({ selected, newDate, newStartTime });
test('multi-court changes preserve distinct session identity and do not combine court-hours', () => {
  const changes = collectChanges(sessions, {
    'court-one-morning': draft(true, '2026-09-14', '09:00'),
    'court-two-evening': draft(true, '2026-09-15', '19:00'),
  }, 'all');
  assert.deepEqual(changes, [
    { sessionId: 'court-one-morning', newDate: '2026-09-14', newStartTime: '09:00' },
    { sessionId: 'court-two-evening', newDate: '2026-09-15', newStartTime: '19:00' },
  ]);
  assert.equal(sessions[0].durationHours, 2);
  assert.equal(sessions[1].durationHours, 1);
});
test('selected-session changes preserve every unselected original session', () => {
  assert.deepEqual(collectChanges(sessions, {
    'court-one-morning': draft(false, '', ''),
    'court-two-evening': draft(true, '2026-09-15', '19:00'),
  }, 'selected'), [{ sessionId: 'court-two-evening', newDate: '2026-09-15', newStartTime: '19:00' }]);
});
test('all-session mode prevents an unnoticed partial reschedule', () => {
  assert.throws(() => collectChanges(sessions, {
    'court-one-morning': draft(true, '2026-09-12', '08:00'),
    'court-two-evening': draft(true, '2026-09-15', '19:00'),
  }, 'all'), /every session/);
});
test('unchanged selections are excluded and an empty change is not submitted', () => {
  assert.throws(() => collectChanges(sessions, {
    'court-one-morning': draft(true, '2026-09-12', '08:00'),
    'court-two-evening': draft(false, '', ''),
  }, 'selected'), /at least one/);
});
test('no missing availability selection is submitted as a fallback time', () => {
  assert.throws(() => collectChanges(sessions, {
    'court-one-morning': draft(true, '2026-09-12', ''),
    'court-two-evening': draft(false, '', ''),
  }, 'selected'), /available date and time/);
});
test('an invalid session is never assigned a guessed identity or duration', () => {
  assert.throws(() => normalizeSession({ date: '2026-09-12', startTime: '08:00', durationHours: 2 }), /could not be verified/);
  assert.throws(() => normalizeSession({ sessionId: 'one', date: '2026-09-12', startTime: '08:00', durationHours: 0 }), /could not be verified/);
});
test('price review requires complete consistent server amounts', () => {
  assert.deepEqual(validatePrice({ oldTotalAmount: 450, newTotalAmount: 600, additionalAmount: 150 }), { oldTotalAmount: 450, newTotalAmount: 600, additionalAmount: 150 });
  for (const price of [null, {}, { oldTotalAmount: 450, newTotalAmount: 600 }, { oldTotalAmount: 450, newTotalAmount: 600, additionalAmount: 0 }, { oldTotalAmount: 450, newTotalAmount: -1, additionalAmount: 0 }]) {
    assert.throws(() => validatePrice(price), /price could not be verified/);
  }
});
test('rain or equal-rate reschedule can preserve the original paid amount', () => {
  assert.equal(validatePrice({ oldTotalAmount: 450, newTotalAmount: 450, additionalAmount: 0 }).additionalAmount, 0);
});
test('session labels format an overnight booking in Philippine time', () => {
  const label = scheduleLabel({ startsAt: '2026-09-12T15:00:00Z', endsAt: '2026-09-12T16:00:00Z' });
  assert.match(label, /Sep 12, 2026/);
  assert.match(label, /11:00 PM/);
  assert.match(label, /12:00 AM/);
});
function adapterHarness() {
  const source = fs.readFileSync('supabase-config.js', 'utf8');
  const methods = source.slice(source.indexOf('  async _groupReschedule('), source.indexOf('  async previewBookingReschedule('));
  const calls = [];
  const context = {
    PB_PLATFORM_V1: true, PB_TENANT_SLUG: 'pickle-street-tugbok',
    _invokeEdgeFunction: async (endpoint, payload) => { calls.push({ endpoint, payload }); return { ok: true, version: 'v1' }; },
    _pbClearFastCache: () => {}, _pbPlatformBookingResponseToLegacy: async booking => booking,
  };
  vm.runInNewContext(`adapter = {${methods}}`, context);
  return { context, calls, adapter: context.adapter };
}
test('grouped reschedule adapter binds the correct tenant and carries optimistic concurrency', async () => {
  const { adapter, calls } = adapterHarness();
  await adapter.rescheduleGroupBooking(' pb-reference ', { changes: [{ sessionId: 'one', newDate: '2026-09-12', newStartTime: '09:00' }], expectedVersion: 'version-a', expectedQuoteHash: 'quote-a', reasonCode: 'weather', publicReason: 'Rain interruption', internalNote: '', notifyCustomer: true, idempotencyKey: 'request-a' });
  assert.equal(calls[0].endpoint, 'picklestreet-reschedule?tenantSlug=pickle-street-tugbok');
  assert.equal(calls[0].payload.tenantSlug, 'pickle-street-tugbok');
  assert.equal(calls[0].payload.bookingReference, 'PB-REFERENCE');
  assert.equal(calls[0].payload.expectedVersion, 'version-a');
  assert.equal(calls[0].payload.expectedQuoteHash, 'quote-a');
  assert.equal(calls[0].payload.idempotencyKey, 'request-a');
});
test('grouped reschedule is unavailable for another tenant', async () => {
  const { adapter, context, calls } = adapterHarness();
  context.PB_TENANT_SLUG = 'another-tenant';
  await assert.rejects(adapter.groupRescheduleContext('PB-REFERENCE'), /unavailable for this venue/);
  assert.equal(calls.length, 0);
});
test('available-time queries bind the session and exact booking version', async () => {
  const { adapter, calls } = adapterHarness();
  await adapter.groupRescheduleOptions('PB-REFERENCE', { sessionId: 'session-a', bookingDate: '2026-09-12', expectedVersion: 'version-a', reasonCode: 'weather' });
  assert.equal(calls[0].payload.action, 'options');
  assert.equal(calls[0].payload.sessionId, 'session-a');
  assert.equal(calls[0].payload.expectedVersion, 'version-a');
  assert.deepEqual(Object.keys(calls[0].payload).sort(), ['action','bookingDate','bookingReference','expectedVersion','sessionId','tenantSlug'].sort());
});

test('fresh paid bookings without a rain incident remain eligible for rescheduling', () => {
 const html = fs.readFileSync('admin.html','utf8');
 const context = {window:{PB_PLATFORM_V1:true,PBGroupReschedule:{}},sess:{role:'owner'},Date};
 vm.createContext(context);
 vm.runInContext(html.slice(html.indexOf('function weatherRefundIncidents('),html.indexOf('function weatherRefundChildBookings(')),context);
 vm.runInContext(html.slice(html.indexOf('function bookingCourtSessions('),html.indexOf('function canRestoreCancelledBooking(')),context);
 const booking={ref:'PB-TEST',status:'confirmed',platformStatus:'confirmed',paymentStatus:'paid',sessions:[{courtId:'one'},{courtId:'two'}]};
 context.booking=booking;
 assert.equal(vm.runInContext('canRescheduleCourtSessions(booking)',context),true);
 context.booking={...booking,weatherRefund:{id:'actual-incident'}};
 assert.equal(vm.runInContext('canRescheduleCourtSessions(booking)',context),false);
 context.booking={...booking,archivedAt:'2026-09-09'};
 assert.equal(vm.runInContext('canRescheduleCourtSessions(booking)',context),false);
 context.booking={...booking,paymentStatus:'for_verification'};
 assert.equal(vm.runInContext('canRescheduleCourtSessions(booking)',context),false);
 context.booking={...booking,sessions:[],endsAt:'2099-09-09T06:00:00Z'};
 assert.equal(vm.runInContext('canRescheduleBooking(booking)',context),true);
});

test('shared times require the complete range to be available on every court',()=>{
 const {commonOptions}=require('./admin-group-reschedule.js');
 const slot=(startTime,endTime,available=true)=>({startTime,endTime,available});
 assert.deepEqual(commonOptions([{options:[slot('06:00','07:00'),slot('07:00','08:00')]},{options:[slot('06:00','07:00'),slot('07:00','08:00',false)]},{options:[slot('06:00','07:00')]}]),[slot('06:00','07:00')]);
 assert.deepEqual(commonOptions([{options:[slot('06:00','07:00')]},{options:[slot('06:00','08:00')]}]),[]);
 assert.deepEqual(commonOptions([{options:[slot('06:00','07:00')]},{options:[]}]),[]);
});
test('one selected date and time generates every court change under one booking',()=>{
 const uniform=sessions.map(s=>({...s,durationHours:1}));
 const changes=collectChanges(uniform,Object.fromEntries(uniform.map(s=>[s.sessionId,{selected:true,newDate:'2026-09-16',newStartTime:'10:00'}])),'all');
 assert.equal(changes.length,2);assert.ok(changes.every(c=>c.newDate==='2026-09-16' && c.newStartTime==='10:00'));
});
