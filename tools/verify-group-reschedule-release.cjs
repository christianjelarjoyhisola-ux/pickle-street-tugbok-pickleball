'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { query } = require('./pending-platform.cjs');
const root = path.resolve(__dirname, '..');
const origin = 'https://picklestreet.pages.dev';
const project = 'neqvrwtofiolcuxewdze';
const tenant = 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';
const slug = 'pickle-street-tugbok';
const base = `https://${project}.supabase.co`;
const apikey = 'sb_publishable_UHMKYGsygjeMl79VRfPNVw_RyWiV5Yr';
const changed = ['picklestreet-reschedule', 'picklestreet-receipts', 'picklestreet-email-dispatch'];
const baselinePath = path.join(os.tmpdir(), 'picklestreet-group-reschedule-function-baseline.json');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
async function functions() {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  assert.ok(token, 'Management access is required for read-only release verification');
  const response = await fetch(`https://api.supabase.com/v1/projects/${project}/functions`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000),
  });
  assert.equal(response.status, 200, 'Read deployed function metadata');
  return (await response.json()).map(row => ({ slug: row.slug, version: row.version, status: row.status, updated_at: row.updated_at }));
}
async function request(pathname, body, requestOrigin = origin, method = 'POST') {
  const response = await fetch(base + pathname, {
    method, headers: { apikey, Origin: requestOrigin, 'Content-Type': 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000),
  });
  return { status: response.status, origin: response.headers.get('access-control-allow-origin') };
}
async function main() {
  const deployed = await functions();
  if (process.argv[2] === 'baseline') {
    fs.writeFileSync(baselinePath, JSON.stringify(deployed));
    console.log(JSON.stringify({ baselineSaved: true, existingFunctionCount: deployed.length }));
    return;
  }
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  const current = new Map(deployed.map(row => [row.slug, row]));
  for (const row of baseline.filter(row => !changed.includes(row.slug))) {
    assert.deepEqual(current.get(row.slug), row, `Unrelated function changed: ${row.slug}`);
  }
  for (const name of changed) assert.equal(current.get(name)?.status, 'ACTIVE', `${name} must be active`);
  const endpoint = `/functions/v1/picklestreet-reschedule?tenantSlug=${slug}`;
  const body = { action: 'context', tenantSlug: slug, bookingReference: 'PB-VERIFY-ONLY' };
  const preflight = await request(endpoint, null, origin, 'OPTIONS');
  assert.equal(preflight.status, 204); assert.equal(preflight.origin, origin);
  const unauthenticated = await request(endpoint, body);
  assert.equal(unauthenticated.status, 401);
  const wrongTenant = await request(endpoint, { ...body, tenantSlug: 'another-venue' });
  assert.equal(wrongTenant.status, 403);
  const wrongOrigin = await request(endpoint, body, 'https://example.invalid');
  assert.ok(wrongOrigin.status >= 400 && wrongOrigin.status < 500);
  const directRpc = await request('/rest/v1/rpc/get_picklestreet_group_reschedule', { p_booking_id: '00000000-0000-4000-8000-000000000001', p_actor_user_id: '00000000-0000-4000-8000-000000000002' });
  assert.ok([401, 403].includes(directRpc.status), 'Anonymous clients must not execute the private RPC');
  const publicDispatch = await request('/functions/v1/picklestreet-email-dispatch', {});
  assert.equal(publicDispatch.status, 401);
  const assets = [];
  for (const name of ['admin-group-reschedule.js', 'admin-group-reschedule.css', 'supabase-config.js']) {
    const response = await fetch(`${origin}/${name}?release=group-reschedule-v1`, { signal: AbortSignal.timeout(30000) });
    assert.equal(response.status, 200);
    const hash = sha(Buffer.from(await response.arrayBuffer()));
    assert.equal(hash, sha(fs.readFileSync(path.join(root, 'dist', name))), `${name} must match the release`);
    assets.push({ name, sha256: hash });
  }
  const state = await query(`select
    to_regclass('public.picklestreet_group_reschedule_requests') is not null as installed,
    (select count(*) from public.courts where tenant_id='${tenant}' and name like 'TEST ONLY%') as fixture_courts,
    (select count(*) from public.bookings where tenant_id='${tenant}' and customer_email='reschedule@example.invalid') as fixture_bookings,
    (select count(*) from cron.job where active and command like '%run_picklestreet_balance_hold_cleanup%') as active_expiry_jobs`, true);
  assert.equal(state[0].installed, true);
  assert.equal(Number(state[0].fixture_courts), 0);
  assert.equal(Number(state[0].fixture_bookings), 0);
  assert.ok(Number(state[0].active_expiry_jobs) > 0);
  const report = { checkedAt: new Date().toISOString(), origin, readOnly: true, liveTestBookingsCreated: 0,
    unrelatedFunctionsUnchanged: baseline.filter(row => !changed.includes(row.slug)).length,
    deployedFunctions: changed.map(name => current.get(name)),
    authAndTenantChecks: { preflight, unauthenticated, wrongTenant, wrongOrigin, directRpc, publicDispatch }, assets, database: state[0] };
  fs.writeFileSync(path.join(root, 'operations/group-reschedule-release-verification.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
