'use strict';
const fs = require('node:fs');
const pkg = JSON.parse(fs.readFileSync('package.json','utf8'));
pkg.name = 'pickle-street-tugbok';
pkg.description = 'Pickle Street Tugbok booking and venue management on the protected multi-tenant platform';
pkg.scripts = {
  dev:'node tools/local-server.js',
  build:'node tools/check-site.cjs && node tools/build-site.cjs',
  check:'node tools/check-site.cjs',
  test:'node --test tenant-isolation.test.cjs reschedule-integration.test.cjs shared-booking-balance.test.js shared-blocked-date-access.test.js shared-open-play-data.test.js shared-open-play-reporting.test.js',
  'verify:platform':'node tools/verify-platform-readonly.cjs',
};
fs.writeFileSync('package.json',JSON.stringify(pkg,null,2)+'\n');
const lock=JSON.parse(fs.readFileSync('package-lock.json','utf8'));
lock.name=pkg.name;if(lock.packages?.[''])lock.packages[''].name=pkg.name;
fs.writeFileSync('package-lock.json',JSON.stringify(lock,null,2)+'\n');
fs.writeFileSync('.env.example','# This static frontend needs no server secrets.\n# Public tenant routing is fixed in tenant-config.js.\n# Configure courts, hours, prices, payment accounts, policies, and venue details in the dashboard.\n# Never deploy the reference Supabase migrations or standalone setup scripts to the shared project.\n');
fs.writeFileSync('_headers',`/*
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
  Content-Security-Policy: default-src 'self'; base-uri 'self'; object-src 'none'; form-action 'self'; frame-src https://challenges.cloudflare.com; script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob: https:; connect-src 'self' https://neqvrwtofiolcuxewdze.supabase.co wss://neqvrwtofiolcuxewdze.supabase.co https://challenges.cloudflare.com; worker-src 'self' blob:; upgrade-insecure-requests

/*.html
  Cache-Control: no-cache

/tenant-config.js
  Cache-Control: no-store

/supabase-config.js
  Cache-Control: no-store

/open-play-reporting.js
  Cache-Control: no-cache

/open-play-reporting.css
  Cache-Control: no-cache

/booking-management.html
  Cache-Control: no-store
`);
for(const file of ['index.html','admin.html','login.html']) {
  let source=fs.readFileSync(file,'utf8');
  source=source.replaceAll('20260728-qdink-v1','20260907-pickle-street').replaceAll('qdink_developer_promo_seen_v1','pickle-street-developer-promo-seen').replaceAll("Q'Dink branded splash",'Legacy entrance markup');
  source=source.replaceAll('type="image/jpeg" href="assets/pickle-street-mark.svg"','type="image/svg+xml" href="assets/pickle-street-mark.svg"');
  fs.writeFileSync(file,source);
}
