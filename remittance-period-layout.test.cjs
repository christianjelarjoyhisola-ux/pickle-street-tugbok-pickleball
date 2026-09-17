'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const admin = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8');

test('remittance accumulation timestamps use separate readable fields', () => {
  assert.match(admin, /aria-label="Current accumulation period"/);
  assert.match(admin, /rm-live-moment-label">Started</);
  assert.match(admin, /rm-live-moment-label">Current cutoff</);
  assert.match(admin, /rmLivePeriod'\)\.textContent = rmPeriodStart\(live\) \? rmDateTime/);
  assert.match(admin, /rmLiveAsOf'\)\.textContent = rmDateTime\(serverNow\)/);
});

test('remittance period becomes one column on narrow phones', () => {
  assert.match(admin, /@media\(max-width:520px\)[\s\S]*?\.rm-live-meta \{ grid-template-columns:1fr; \}/);
});
