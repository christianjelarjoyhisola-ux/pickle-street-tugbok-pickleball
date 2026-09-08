const assert = require('node:assert/strict');
const test = require('node:test');
const Access = require('./blocked-date-access.js');

const NOW = Date.parse('2026-07-22T07:00:00.000Z');

test('the System Owner always retains blocked-date management', () => {
  assert.equal(Access.canManage('owner', null, NOW), true);
  assert.equal(Access.canManage('owner', { status: 'expired' }, NOW), true);
});

test('a Court Owner can manage only during an active unrevoked grant', () => {
  const active = {
    canManage: true,
    status: 'active',
    durationDays: 1,
    expiresAt: '2026-07-23T07:00:00.000Z',
  };
  assert.equal(Access.canManage('court_owner', active, NOW), true);
  assert.equal(Access.canManage('court_owner', { ...active, revokedAt: '2026-07-22T08:00:00.000Z' }, NOW), false);
  assert.equal(Access.canManage('staff', active, NOW), false);
});

test('Court Owner access fails closed at the exact expiration instant', () => {
  const access = {
    canManage: true,
    status: 'active',
    expiresAt: '2026-07-23T07:00:00.000Z',
  };
  assert.equal(Access.canManage('court_owner', access, Date.parse('2026-07-23T06:59:59.999Z')), true);
  assert.equal(Access.canManage('court_owner', access, Date.parse('2026-07-23T07:00:00.000Z')), false);
  assert.equal(Access.normalize(access, Date.parse('2026-07-23T07:00:00.000Z')).status, 'expired');
});

test('remaining time is stable and never becomes negative', () => {
  const access = { canManage: true, expiresAt: '2026-07-23T08:02:03.000Z' };
  assert.deepEqual(Access.remainingParts(access, NOW), {
    remainingMs: 90123000,
    days: 1,
    hours: 1,
    minutes: 2,
    seconds: 3,
  });
  assert.equal(Access.remainingParts(access, Date.parse('2026-07-24T00:00:00.000Z')).remainingMs, 0);
});

test('expiry follows server time when the device clock is inaccurate', () => {
  const slowDeviceNow = Date.parse('2026-07-22T06:55:00.000Z');
  const access = Access.normalize({
    canManage: true,
    status: 'active',
    serverNow: '2026-07-22T07:00:00.000Z',
    expiresAt: '2026-07-22T07:01:00.000Z',
  }, slowDeviceNow);
  assert.equal(access.clockOffsetMs, 300000);
  assert.equal(Access.canManage('court_owner', access, slowDeviceNow), true);
  assert.equal(Access.canManage('court_owner', access, slowDeviceNow + 60000), false);
});

 test('unlimited access survives time passage, but revocation and role restrictions still apply', () => {
 const access = {canManage:true, durationDays:0, expiresAt:'infinity'};
 assert.equal(Access.canManage('court_owner', access, NOW + 1000 * 86400 * 36500), true);
 assert.equal(Access.normalize(access, NOW).unlimited, true);
 assert.equal(Access.canManage('staff', access, NOW), false);
 assert.equal(Access.canManage('court_owner', {...access, revokedAt:new Date(NOW).toISOString()}, NOW), false);
 assert.equal(Access.canManage('court_owner', {...access, expiresAt:null}, NOW), false);
 assert.equal(Access.canManage('court_owner', {...access, canManage:false}, NOW), false);
 });
