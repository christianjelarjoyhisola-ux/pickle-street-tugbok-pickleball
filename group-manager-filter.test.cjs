'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('supabase-config.js','utf8').replace(/\r\n/g,'\n');
const start=source.indexOf('function _pbFilterCompletePicklestreetManagerBookings(');
const end=source.indexOf('\n}\n',start)+2;
const context={Date,Intl};
vm.runInNewContext(source.slice(start,end),context);
const filter=context._pbFilterCompletePicklestreetManagerBookings;
const booking={ref:'PB-GROUP',date:'2026-10-10',courtId:'court-1',sessions:[
  {courtId:'court-1',date:'2026-10-10',startsAt:'2026-10-10T10:00:00Z'},
  {courtId:'court-2',date:'2026-10-12',startsAt:'2026-10-12T09:00:00Z'},
]};
test('a grouped booking is found on its moved session date and court',()=>{
  assert.equal(filter([booking],{date:'2026-10-12',courtId:'court-2'}).length,1);
  assert.equal(filter([booking],{date:'2026-10-12'}).length,1);
  assert.equal(filter([booking],{courtId:'court-2'}).length,1);
});
test('combined date and court filters must match the same session',()=>{
  assert.equal(filter([booking],{date:'2026-10-12',courtId:'court-1'}).length,0);
  assert.equal(filter([booking],{date:'2026-10-11'}).length,0);
});
test('session dates use Philippine time and ordinary bookings retain direct filters',()=>{
  assert.equal(filter([{...booking,sessions:[{courtId:'court-2',date:'stale-date',startsAt:'2026-10-11T17:00:00Z'}]}],{date:'2026-10-12'}).length,1);
  assert.equal(filter([{ref:'PB-SINGLE',date:'2026-10-10',courtId:'court-1'}],{date:'2026-10-10',courtId:'court-1'}).length,1);
});
test('the 500-record boundary fails clearly instead of hiding later grouped sessions',()=>{
  assert.throws(()=>filter(Array(500).fill(booking),{date:'2026-10-12'}),/500-record.*No partial/);
  assert.equal(filter(Array(499).fill(booking),{date:'2026-10-12'}).length,499);
});
