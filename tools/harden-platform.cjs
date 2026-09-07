const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=name=>fs.readFileSync(path.join(root,name),'utf8');
const write=(name,text)=>fs.writeFileSync(path.join(root,name),text);
let adapter=read('supabase-config.js');
adapter=adapter.replace('const PB_REQUEST_TIMEOUT_MS = 45000;', `const PB_REQUEST_TIMEOUT_MS = 45000;
const PB_PAGE_DATA_SCOPE = document.documentElement.dataset.pbDataScope || 'auth';
let _pbBusinessRevision = null;
function _pbCaptureBusinessRevision(data) {
  const revision = data?.tenantRevision || data?.updatedAt || data?.settings?.updatedAt;
  if (revision) _pbBusinessRevision = revision;
  return data;
}`);
adapter=adapter.replace('if (!data?.tenant || !Array.isArray(data?.courts)) {',"if (!data?.tenant || data.tenant.slug !== PB_TENANT_SLUG || data.tenant.id !== 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a' || !Array.isArray(data?.courts)) {");
adapter=adapter.replace('if (opts.publicAvailability === true) {', "if (PB_PAGE_DATA_SCOPE !== 'manager' || opts.publicAvailability === true) {");
adapter=adapter.replace(/storage: _pbAuthStorage,/,"storage: _pbAuthStorage,\n    storageKey: 'pickle-street-tugbok-auth',");
adapter=adapter.replaceAll("'pb_session'","'pickle-street-tugbok-session'").replaceAll("'pb_remember'","'pickle-street-tugbok-remember'");
adapter=adapter.replace("const business = data?.business", "_pbCaptureBusinessRevision(data);\n    const business = data?.business");
adapter=adapter.replace("return _pbNormalizeTenantActivationSettings(result.settings);", "_pbCaptureBusinessRevision(result.settings);\n    return _pbNormalizeTenantActivationSettings(result.settings);");
adapter=adapter.replaceAll("_sb.rpc('update_tenant_business_settings', {", "_sb.rpc('update_tenant_business_settings_if_current', {\n      p_expected_revision: _pbBusinessRevision,");
adapter=adapter.replace('return data?.business || data?.tenant || data || {};', '_pbCaptureBusinessRevision(data);\n    return data?.business || data?.tenant || data || {};');
adapter=adapter.replaceAll('return _pbNormalizeTenantActivationSettings(data);','_pbCaptureBusinessRevision(data);\n    return _pbNormalizeTenantActivationSettings(data);');
adapter=adapter.replace("const { data, error } = await _sb.rpc('update_tenant_business_settings_if_current', {", "if (!_pbBusinessRevision) throw new Error('Reload the settings before saving.');\n    const { data, error } = await _sb.rpc('update_tenant_business_settings_if_current', {");
// Route all shared adapter traffic through a verified, fixed project boundary.
adapter=adapter.replace('async function _pbFetchWithTimeout(input, init = {}, timeoutMs = PB_REQUEST_TIMEOUT_MS) {', `async function _pbFetchWithTimeout(input, init = {}, timeoutMs = PB_REQUEST_TIMEOUT_MS) {
  const requestUrl = new URL(typeof input === 'string' ? input : input.url);
  if (requestUrl.origin !== 'https://neqvrwtofiolcuxewdze.supabase.co') throw new Error('Unexpected booking service address.');
  if (requestUrl.pathname.startsWith('/functions/v1/')) {
    if (requestUrl.searchParams.get('tenantSlug') !== PB_TENANT_SLUG) throw new Error('A venue-scoped request is required.');
    const headers = new Headers(init.headers || {});
    headers.set('X-Tenant-Slug', PB_TENANT_SLUG);
    init = {...init, headers};
  }
  if (requestUrl.pathname.startsWith('/rest/v1/rpc/')) {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
    if (body.p_tenant_slug !== PB_TENANT_SLUG || body.p_hostname !== _pbTenantHostname()) throw new Error('A verified venue context is required.');
  }
`);
// The public surface never reuses a manager identity for public projections.
adapter=adapter.replace("if (session && canManageTenant && document.documentElement.dataset.pbDataScope === 'manager') {", "if (session && canManageTenant && PB_PAGE_DATA_SCOPE === 'manager') {");
write('supabase-config.js',adapter);
let openPlay=read('open-play-data.js').replace('JSON.stringify({ tenantSlug, ...body })','JSON.stringify({ ...body, tenantSlug })');
openPlay=openPlay.replace('apikey: publishableKey,', "apikey: publishableKey,\n      'X-Tenant-Slug': tenantSlug,");
write('open-play-data.js',openPlay);
let index=read('index.html');
index=index.replaceAll('2026-09-19','2026-01-01');
index=index.replace(/function shouldShowDeveloperPromo\([^)]*\)\s*\{/, '$&\n  return false;');
index=index.replace(/autofocus(?=>)/g,'');
write('index.html',index);
for (const filename of ['create-accounts.js','setup-db.js','seed-demo-data.js']) write(filename,"throw new Error('Standalone database setup is disabled. Configure Pickle Street through its tenant management dashboard.');\n");
for (const filename of ['deploy-edge-functions.ps1','deploy-cloudflare-pages.ps1']) write(filename,"throw 'Standalone deployment is disabled for this shared-platform tenant. Use the reviewed Sites release workflow.'\n");
let style=read('pickle-street.css');
style+='\n.ps-nav-button{font:600 .9rem DM Sans,sans-serif;background:none;border:0;color:var(--text);cursor:pointer;padding:10px}.cc{background:var(--card)!important;border:1px solid var(--border)!important;border-radius:18px!important;box-shadow:0 5px 22px rgba(25,54,66,.045)!important;overflow:hidden}.cc-mobile-name,.cc-times-title{font-family:Manrope,sans-serif!important;font-weight:750;letter-spacing:-.02em!important}.cc-photo{background-color:#dce6e9!important}.cc-times{background:var(--card)!important}.booking-mode-btn{box-shadow:none!important;border-color:var(--border)!important}.booking-mode-btn.active{background:#e9f2ee!important;color:#255c4a!important}.developer-promo-dialog,.bg-grid,.bg-glow{display:none!important}.ps-staff-link{white-space:nowrap}.empty h3{font-size:1.4rem;margin-bottom:8px}.empty p{font-size:1rem;line-height:1.6;margin-bottom:20px}@media(max-width:620px){.ps-staff-link{display:none}.nav .sw-wrap{display:none}}\n';
write('pickle-street.css',style);
console.log('Tenant identity, public data, authentication storage, and settings revision guards applied.');
