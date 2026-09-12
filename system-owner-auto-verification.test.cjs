'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

const migration=fs.readFileSync('operations/pending-flow/024-system-owner-auto-verification.sql','utf8');
const compatibility=fs.readFileSync('operations/pending-flow/025-system-owner-auto-verification-compatibility.sql','utf8');

test('database migration derives Auto Verified only from the trusted System Owner profile',()=>{
  assert.match(migration,/platform_profiles where user_id=p_actor_user_id and is_platform_owner/);
  assert.match(migration,/system_owner:=found/);
  assert.match(migration,/case when system_owner then ''auto_approved'' else ''approved'' end/);
  assert.doesNotMatch(migration,/p_system_owner|body\.|metadata.*system.owner/i);
});

test('published dashboard compatibility returns success while preserving the stored Auto Verified status',()=>{
  assert.match(compatibility,/receiptStatus.*approved.*storedReceiptStatus.*r\.status/);
  assert.match(compatibility,/system_owner and p_decision=''approve''/);
  assert.match(compatibility,/commit;\s*$/);
});

test('migration is transactional and refuses to patch an unexpected live function',()=>{
  assert.match(migration,/^begin;/m);
  assert.match(migration,/commit;\s*$/);
  assert.equal((migration.match(/migration stopped safely/g)||[]).length,3);
});
