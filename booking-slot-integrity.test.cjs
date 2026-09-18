const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(
  path.join(__dirname, 'operations/pending-flow/034-booking-slot-integrity.sql'),
  'utf8',
);

test('active Pickle Street bookings require an occupying slot at commit', () => {
  assert.match(migration, /create constraint trigger bookings_require_active_slot/i);
  assert.match(migration, /create constraint trigger booking_slots_preserve_active_booking/i);
  assert.match(migration, /deferrable initially deferred/gi);
  assert.match(
    migration,
    /parent\.status in \('pending_payment', 'payment_review', 'confirmed', 'completed'\)/i,
  );
  assert.match(migration, /slot\.status in \('held', 'confirmed'\)/i);
  assert.match(migration, /PICKLESTREET_ACTIVE_BOOKING_REQUIRES_SLOT/i);
});

test('guard is tenant-scoped and does not weaken the overlap constraint', () => {
  assert.match(migration, /f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a/i);
  assert.doesNotMatch(migration, /drop constraint/i);
  assert.doesNotMatch(migration, /disable trigger/i);
});
