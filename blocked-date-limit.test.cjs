const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = __dirname;
const admin = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
const migration = fs.readFileSync(
  path.join(root, 'operations', 'pending-flow', '033-unlimited-live-blocked-dates.sql'),
  'utf8'
);

test('blocked-date form clearly limits one reservation to six dates', () => {
  assert.match(admin, /prevent accidental oversized requests/);
  assert.match(admin, /Maximum: 6 dates per reservation\./);
  assert.match(admin, /rangeDays > 6/);
  assert.match(admin, /maximum\.setDate\(maximum\.getDate\(\) \+ 5\)/);
  assert.doesNotMatch(admin, /date range of 90 days or less/);
});

test('blocked-date form has no active or upcoming closure cap', () => {
  assert.match(admin, /Active and upcoming closures are unlimited\./);
  assert.doesNotMatch(admin, /MAX_LIVE_BLOCKED_DATES/);
  assert.doesNotMatch(admin, /The 6-closure limit has been reached/);
});

test('protected backend rejects Pickle Street batches larger than six dates', () => {
  assert.match(migration, /f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a/);
  assert.match(migration, /coalesce\(p_end_date, p_start_date\) - p_start_date \+ 1 > 6/);
  assert.match(migration, /To prevent time-slot data from overloading the database/);
});

test('protected backend no longer caps active or upcoming closures', () => {
  assert.doesNotMatch(migration, /v_existing_count/);
  assert.doesNotMatch(migration, /Only 6 active or upcoming court closures/);
  assert.doesNotMatch(migration, /picklestreet-live-blocked-limit/);
});
