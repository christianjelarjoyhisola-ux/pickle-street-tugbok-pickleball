'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('admin.html', 'utf8');
function extract(name) {
  const matches = [...source.matchAll(new RegExp('^(?:async )?function ' + name + '\\(', 'gm'))];
  assert.ok(matches.length, `${name} exists`);
  const start = matches.at(-1).index;
  const next = source.slice(start + 1).search(/^(?:async )?function \w+\(|^const _weatherRefundSyntheticBookings/m);
  return source.slice(start, next < 0 ? undefined : start + 1 + next);
}
const names = ['bookingCourtSessions','calendarBookingSessions','bookingDateKeys','bookingMatchesDate','bookingMatchesDateRange','sessionScheduleLabel','bookingScheduleSearchText','bookingScheduleSummaryHtml','todayBookingRange','bookingClockMinutes','todayBookingTimeLabel','sortBookingsChronologically','bookingStartHour','bookingGroupKey','normalizedPaymentRefKey','commonBookingPrefix','commonValue','bookingGroupStatus','bookingGroupReceiptStatus','bookingLogicalKey','uniqueBookingGroupItems','bookingGroupCourtLabel','bookingGroupDateLabel','bookingGroupTimeLabel','bookingGroupScheduleLabel','groupBookings','scheduleExplorerRows'];
function harness() {
  const context = { Intl, Date, Map, Set, Number, String, Array, Math, fmtD: value => value, esc: value => String(value ?? '').replaceAll('<','&lt;'), receivedAccountKey: ()=>'gcash', weatherRefundIncidents: ()=>[], $: ()=>({value:''}), isScheduleActiveBooking: ()=>true, bookingHoldsAdminSlot: ()=>true };
  for (const name of names) vm.runInNewContext(extract(name), context);
  return context;
}
const booking = {
  ref:'PB-ONE-REFERENCE',fullName:'Player',courtName:'Court 1, Court 2',date:'2026-09-12',startTime:'8:00 AM',endTime:'9:00 PM',slots:[8,20],duration:3,total:450,downpayment:450,status:'confirmed',paymentStatus:'paid',createdAt:'2026-09-09T01:00:00Z',
  sessions:[
    {sessionId:'one',courtId:'one',courtName:'Court 1',bookingDate:'2026-09-12',startTime:'08:00',durationHours:2,startsAt:'2026-09-12T00:00:00Z',endsAt:'2026-09-12T02:00:00Z'},
    {sessionId:'two',courtId:'two',courtName:'Court 2',bookingDate:'2026-09-15',startTime:'20:00',durationHours:1,startsAt:'2026-09-15T12:00:00Z',endsAt:'2026-09-15T13:00:00Z'},
  ],
};
test('a multi-date booking matches both actual session dates but not the gap',()=>{
  const h=harness();
  assert.deepEqual([...h.bookingDateKeys(booking)],['2026-09-12','2026-09-15']);
  assert.equal(h.bookingMatchesDate(booking,'2026-09-15'),true);
  assert.equal(h.bookingMatchesDate(booking,'2026-09-13'),false);
  assert.equal(h.bookingMatchesDateRange(booking,'2026-09-13','2026-09-14'),false);
  assert.equal(h.bookingMatchesDateRange(booking,'2026-09-15','2026-09-16'),true);
});
test('dashboard projections use each session clock and duration instead of the aggregate range',()=>{
  const h=harness();const rows=h.calendarBookingSessions(booking);
  assert.equal(rows.length,2);
  assert.equal(rows[0].ref,booking.ref);assert.equal(rows[1].ref,booking.ref);
  assert.equal(rows[0].duration,2);assert.equal(rows[1].duration,1);
  assert.deepEqual({...h.todayBookingRange(rows[0])},{start:480,end:600});
  assert.deepEqual({...h.todayBookingRange(rows[1])},{start:1200,end:1260});
  assert.equal(h.calendarBookingSessions(rows[0]).length,1);
});
test('upcoming and selected-day dashboard views include the later session after the first has ended',()=>{
  const h=harness();h._scheduleExplorerBookings=h.calendarBookingSessions(booking);h._scheduleExplorerMode='upcoming';
  const upcoming=h.scheduleExplorerRows({dateKey:'2026-09-14',minutes:900});
  assert.equal(upcoming.length,1);assert.equal(upcoming[0].booking.courtName,'Court 2');
  h._scheduleExplorerMode='day';h._scheduleExplorerSelectedDate='2026-09-15';
  assert.equal(h.scheduleExplorerRows({dateKey:'2026-09-14',minutes:900}).length,1);
  h._scheduleExplorerSelectedDate='2026-09-13';assert.equal(h.scheduleExplorerRows({dateKey:'2026-09-14',minutes:900}).length,0);
});
test('transaction grouping preserves one reference and one payment while exposing every session date',()=>{
  const h=harness();const groups=h.groupBookings([booking]);
  assert.equal(groups.length,1);assert.equal(groups[0].total,450);assert.equal(groups[0].downpayment,450);
  assert.equal(groups[0].displayRef,booking.ref);
  assert.match(groups[0].dateLabel,/2026-09-12/);assert.match(groups[0].dateLabel,/2026-09-15/);
  assert.match(groups[0].scheduleLabel,/Court 1/);assert.match(groups[0].scheduleLabel,/Sep 15, 2026/);
});
test('schedule cards show a date alongside each court and escape customer-controlled text',()=>{
  const h=harness();const html=h.bookingScheduleSummaryHtml({...booking,sessions:booking.sessions.map((s,i)=>({...s,courtName:i?'Court 2':'<Court 1>'}))});
  assert.match(html,/Sep 12, 2026/);assert.match(html,/Sep 15, 2026/);assert.match(html,/&lt;Court 1>/);assert.doesNotMatch(html,/<Court 1>/);
});
test('search can find the later session date or court without changing the booking reference',()=>{
  const h=harness();const search=h.bookingScheduleSearchText(booking);
  assert.match(search,/2026-09-15/);assert.match(search,/Court 2/);assert.equal(booking.ref,'PB-ONE-REFERENCE');
});
