const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(
  path.join(__dirname, 'operations/pending-flow/035-protect-receipt-review-slots.sql'),
  'utf8',
);

test('a durable receipt awaiting review receives a non-expiring slot hold', () => {
  assert.match(migration, /verification\.status in \('pending', 'manual_review'\)/i);
  assert.match(migration, /nullif\(btrim\(verification\.storage_path\), ''\) is not null/i);
  assert.match(migration, /then 'infinity'::timestamptz/i);
  assert.match(migration, /slot\.status = 'held'/i);
});

test('the protection is deferred and limited to primary Pickle Street receipts', () => {
  assert.match(migration, /create constraint trigger receipt_verifications_protect_review_slots/i);
  assert.match(migration, /deferrable initially deferred/i);
  assert.match(migration, /f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a/i);
  assert.match(migration, /new\.balance_request_id is null/i);
});

test('terminal receipt decisions are left to existing approval and rejection flows', () => {
  assert.doesNotMatch(migration, /new\.status in \([^)]*approved/i);
  assert.doesNotMatch(migration, /new\.status in \([^)]*rejected/i);
  assert.doesNotMatch(migration, /update public\.bookings[\s\S]*set status/i);
});
