'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');
const root=__dirname;
const admin=fs.readFileSync(path.join(root,'admin.html'),'utf8');
const migration=fs.readFileSync(path.join(root,'operations','pending-flow','032-six-live-blocked-dates.sql'),'utf8');

test('court closure form displays and enforces the six-live-closure limit',()=>{
  assert.match(admin,/const MAX_LIVE_BLOCKED_DATES = 6/);
  assert.match(admin,/Active\/upcoming closures: \$\{_liveBlockedDateCount\} of \$\{MAX_LIVE_BLOCKED_DATES\}/);
  assert.match(admin,/_liveBlockedDateCount \+ rangeDays > MAX_LIVE_BLOCKED_DATES/);
  assert.match(admin,/button\.disabled = limitReached \|\| requestTooLarge/);
  assert.match(admin,/syncBlockedLiveLimit\(\)/);
});

test('protected backend serializes creates and caps active rows at six',()=>{
  assert.match(migration,/pg_advisory_xact_lock/);
  assert.match(migration,/blocked_on >= v_today/);
  assert.match(migration,/v_existing_count \+ v_requested_count > 6/);
  assert.match(migration,/Existing[\s\S]*closures are grandfathered/i);
  assert.match(migration,/Only 6 active or upcoming court closures can be live at one time/);
});
