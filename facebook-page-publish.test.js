'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const worker = fs.readFileSync('_worker.js', 'utf8');
const studio = fs.readFileSync('availability-graphic.js', 'utf8');

test('Facebook Page token stays server-side and publishing requires a verified dashboard owner', () => {
  assert.match(worker, /env\.FACEBOOK_PAGE_ACCESS_TOKEN/);
  assert.doesNotMatch(studio, /FACEBOOK_PAGE_ACCESS_TOKEN/);
  assert.match(worker, /get_my_tenant_session/);
  assert.match(worker, /ALLOWED_PUBLISH_ROLES/);
  assert.match(worker, /session\?\.tenantId !== TENANT_ID/);
  assert.match(worker, /session\?\.status !== 'active'/);
});

test('Facebook publisher validates same-origin PNG uploads and sends caption with every post', () => {
  assert.match(worker, /origin !== new URL\(request\.url\)\.origin/);
  assert.match(worker, /image\.type !== 'image\/png'/);
  assert.match(worker, /MAX_IMAGE_COUNT = 4/);
  assert.match(worker, /body\.append\('message', caption\)/);
  assert.match(worker, /attached_media\[\$\{index\}\]/);
  assert.match(worker, /publishFacebookPost\(env, caption, images\)/);
});

test('availability studio publishes generated graphics directly instead of using the device share sheet', () => {
  assert.match(studio, />Post to Facebook Page</);
  assert.match(studio, /\/api\/facebook-page\/publish/);
  assert.match(studio, /Authorization: `Bearer \$\{accessToken\}`/);
  assert.match(studio, /form\.append\('caption', caption\)/);
  assert.match(studio, /form\.append\('images', item\.blob, item\.name\)/);
  assert.doesNotMatch(studio, /navigator\.share\(/);
});
