const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = __dirname;
const verifier = fs.readFileSync(path.join(
  root,
  'operations/pending-flow/backend/supabase/functions/picklestreet-receipts/source-routes.ts',
), 'utf8');
const migration = fs.readFileSync(path.join(
  root,
  'operations/pending-flow/023-fifteen-minute-receipt-route.sql',
), 'utf8');

test('receipt verifier and protected route gate use the same 15-minute window', () => {
  assert.match(verifier, /SOURCE_ROUTE_WINDOW_MINUTES\s*=\s*15/);
  assert.match(
    migration,
    /\{timing,allowedWindowMinutes\}'\)::numeric,\s*0\)\s*<>\s*15/,
  );
  assert.doesNotMatch(migration, /allowedWindowMinutes[\s\S]{0,80}<>\s*10/);
});

test('the route gate still requires every trusted receipt match', () => {
  for (const field of [
    'sourceMatched',
    'destinationMatched',
    'recipientMatched',
    'referenceMatched',
    'successMatched',
  ]) {
    assert.match(migration, new RegExp(`${field}.*true`));
  }
  assert.match(migration, /confidence,vision/);
  assert.match(migration, /picklestreet_receipt_route_config_current/);
});
