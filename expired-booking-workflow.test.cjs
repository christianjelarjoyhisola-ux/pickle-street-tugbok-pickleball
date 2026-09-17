'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = file => fs.readFileSync(path.join(__dirname, file), 'utf8');

test('expired unpaid platform bookings render as terminal Expired records', () => {
  const adapter = read('supabase-config.js');
  const admin = read('admin.html');
  assert.match(adapter, /expired:\s*'expired'/);
  assert.doesNotMatch(adapter, /expired:\s*'forfeited'/);
  assert.match(admin, /\['cancelled','forfeited','expired'\]/);
  assert.match(admin, /status==='expired'\)return'expired'/);
  assert.match(admin, /expired:'bdg-x'/);
  assert.match(admin, /s==='expired'\?'Expired'/);
  assert.match(admin, /<option value="expired">Expired<\/option>/);
});

test('ordinary unpaid holds have a scheduler-only minute cleanup', () => {
  const migration = read('operations/pending-flow/028-unpaid-hold-cleanup.sql');
  assert.match(migration, /run_picklestreet_unpaid_hold_cleanup/);
  assert.match(migration, /session_user is distinct from 'postgres'/);
  assert.match(migration, /revoke all[\s\S]*service_role/);
  assert.match(migration, /picklestreet-unpaid-holds-f19f457a/);
  assert.match(migration, /'\* \* \* \* \*'/);
  assert.match(migration, /expire_stale_tenant_holds/);
});
