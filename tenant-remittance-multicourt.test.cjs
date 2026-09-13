const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(
  path.join(__dirname, 'supabase', 'migrations', '20260913124500_multicourt_remittance_court_hours.sql'),
  'utf8',
);

test('multi-court remittance units use the immutable court-hour snapshot', () => {
  assert.match(migration, /jsonb_typeof\(booking\.metadata -> 'courtHours'\) = 'number'/i);
  assert.match(migration, /booking\.metadata ->> 'courtHours'/i);
  assert.match(
    migration,
    /booking\.service_fee_amount\s*\/\s*greatest\(booking\.resolved_fee_units, 1\)/i,
  );
});

test('single-court legacy rows retain an elapsed-hours fallback', () => {
  assert.match(
    migration,
    /extract\(epoch from \(booking\.ends_at - booking\.starts_at\)\) \/ 3600\.0/i,
  );
});

test('the correction does not rewrite booking money or finalized remittance items', () => {
  assert.doesNotMatch(migration, /update\s+public\.bookings/i);
  assert.doesNotMatch(migration, /update\s+public\.remittance_items/i);
  assert.doesNotMatch(migration, /delete\s+from/i);
});
