'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { query } = require('./pending-platform.cjs');

const root = path.resolve(__dirname, '..');
const migrationPath = path.join(root, 'operations', 'pending-flow', '033-unlimited-live-blocked-dates.sql');
const migration = fs.readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n');
const signature = "public.manage_blocked_dates(text,text,uuid,date,date,uuid,time without time zone,time without time zone,text,text)";
const tenant = 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';

function verificationSql() {
  return `
select
  pg_get_functiondef('${signature}'::regprocedure) not like '%v_existing_count%' as no_live_count,
  pg_get_functiondef('${signature}'::regprocedure) not like '%Only 6 active or upcoming court closures%' as no_live_cap,
  pg_get_functiondef('${signature}'::regprocedure) like '%p_start_date + 1 > 6%' as batch_guard;
`;
}

async function blockedFingerprint() {
  const rows = await query(`
select count(*)::integer as row_count,
  md5(coalesce(string_agg(md5(to_jsonb(b)::text), '' order by b.id), '')) as fingerprint
from public.blocked_dates b
where b.tenant_id = '${tenant}'::uuid;
`, true);
  return rows[0];
}

async function main() {
  assert.equal((migration.match(/^commit;\s*$/gmi) || []).length, 1);
  const before = await blockedFingerprint();

  const validationSql = migration.replace(/commit;\s*$/i, `${verificationSql()}\nrollback;`);
  const validation = await query(validationSql);
  assert.equal(validation[0]?.no_live_count, true);
  assert.equal(validation[0]?.no_live_cap, true);
  assert.equal(validation[0]?.batch_guard, true);

  await query(migration);
  const installed = await query(verificationSql(), true);
  assert.equal(installed[0]?.no_live_count, true);
  assert.equal(installed[0]?.no_live_cap, true);
  assert.equal(installed[0]?.batch_guard, true);

  const after = await blockedFingerprint();
  assert.deepEqual(after, before, 'Existing blocked dates changed while removing the cap');
  console.log(JSON.stringify({ applied: true, existingBlockedDatesPreserved: after.row_count }));
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
