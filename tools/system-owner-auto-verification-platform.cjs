'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const assert=require('node:assert/strict');
const {query}=require('./pending-platform.cjs');

const directory=path.resolve(__dirname,'../operations/pending-flow');
const migrationPath=path.join(directory,'024-system-owner-auto-verification.sql');
const validationPath=path.join(directory,'system-owner-auto-verification-validation.json');
const releasePath=path.join(directory,'system-owner-auto-verification-release.json');
const migration=fs.readFileSync(migrationPath,'utf8').replace(/\r\n/g,'\n');
const migrationHash=crypto.createHash('sha256').update(migration).digest('hex');
const backfillPath=path.join(directory,'026-backfill-system-owner-auto-verification.sql');
const backfill=fs.readFileSync(backfillPath,'utf8').replace(/\r\n/g,'\n');
const backfillHash=crypto.createHash('sha256').update(backfill).digest('hex');
const backfillValidationPath=path.join(directory,'system-owner-auto-verification-backfill-validation.json');
const backfillReleasePath=path.join(directory,'system-owner-auto-verification-backfill-release.json');

async function main(){
  const command=process.argv[2];
  if(!/^begin;$/m.test(migration)||!/commit;\s*$/i.test(migration))throw Error('Expected one transactional migration.');
  if(command==='audit'){
    const pending=await query(`select
      receipt.id as verification_id,
      booking.reference as booking_reference,
      receipt.status as receipt_status,
      review.completed_at as confirmed_at
    from public.picklestreet_receipt_staff_reviews review
    join public.platform_profiles profile
      on profile.user_id=review.actor_user_id and profile.is_platform_owner
    join public.receipt_verifications receipt
      on receipt.tenant_id=review.tenant_id and receipt.id=review.verification_id
    join public.bookings booking
      on booking.tenant_id=receipt.tenant_id and booking.id=receipt.booking_id
    where review.tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'
      and review.decision='approve'
      and review.completed_at is not null
      and receipt.status='approved'
    order by review.completed_at,receipt.id`,true);
    console.log(JSON.stringify({pendingFlowBackfill:pending},null,2));
    return;
  }
  if(command==='inspect-guard'){
    const result=await query(`select proname,pg_get_functiondef(oid) as definition from pg_proc where oid in (
      'public.guard_receipt_approval_before_play()'::regprocedure,
      'public.guard_picklestreet_receipt_state()'::regprocedure,
      'public.guard_picklestreet_balance_receipt_state()'::regprocedure,
      'public.picklestreet_staff_review_authorized(text,uuid)'::regprocedure
    ) order by proname`,true);
    console.log(result.map(row=>row.proname+'\n'+row.definition).join('\n\n'));
    return;
  }
  if(command==='validate-backfill'){
    const sql=backfill.replace(/commit;\s*$/i,`select
      count(*) filter(where receipt.status='auto_approved')::integer as relabeled,
      count(*) filter(where receipt.status<>'auto_approved')::integer as missed
    from public.picklestreet_receipt_staff_reviews review
    join public.platform_profiles profile
      on profile.user_id=review.actor_user_id and profile.is_platform_owner
    join public.receipt_verifications receipt
      on receipt.tenant_id=review.tenant_id and receipt.id=review.verification_id
    where review.tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'
      and review.decision='approve' and review.completed_at is not null;
rollback;`);
    const result=await query(sql);
    const check=result.find(row=>Object.hasOwn(row,'relabeled'));
    assert.equal(check?.missed,0);
    fs.writeFileSync(backfillValidationPath,JSON.stringify({checkedAt:new Date().toISOString(),migrationHash:backfillHash,rolledBack:true,result:[check]},null,2)+'\n');
    console.log(JSON.stringify({validated:true,migrationHash:backfillHash,check}));
    return;
  }
  if(command==='apply-backfill'){
    const validation=JSON.parse(fs.readFileSync(backfillValidationPath,'utf8'));
    if(validation.migrationHash!==backfillHash||validation.rolledBack!==true)throw Error('Validate this exact backfill first.');
    await query(backfill);
    const remaining=await query(`select count(*)::integer as count
      from public.picklestreet_receipt_staff_reviews review
      join public.platform_profiles profile on profile.user_id=review.actor_user_id and profile.is_platform_owner
      join public.receipt_verifications receipt on receipt.tenant_id=review.tenant_id and receipt.id=review.verification_id
      where review.tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'
        and review.decision='approve' and review.completed_at is not null and receipt.status='approved'`,true);
    assert.equal(remaining[0]?.count,0);
    fs.writeFileSync(backfillReleasePath,JSON.stringify({appliedAt:new Date().toISOString(),migrationHash:backfillHash,deployed:true,remaining:0},null,2)+'\n');
    console.log(JSON.stringify({applied:true,migrationHash:backfillHash,remaining:0}));
    return;
  }
  if(command==='validate'){
    const validationSql=migration.replace(/commit;\s*$/i,`select
      pg_get_functiondef('public.review_picklestreet_pending_receipt(uuid,uuid,uuid,text,text,uuid)'::regprocedure) like '%system_owner boolean:=false%' as system_owner_derived,
      pg_get_functiondef('public.review_picklestreet_pending_receipt(uuid,uuid,uuid,text,text,uuid)'::regprocedure) like '%case when system_owner then ''auto_approved'' else ''approved'' end%' as owner_auto_verified,
      pg_get_functiondef('public.review_picklestreet_pending_receipt(uuid,uuid,uuid,text,text,uuid)'::regprocedure) like '%authorized:=authorized or system_owner%' as authorization_preserved;
rollback;`);
    const result=await query(validationSql);
    const checks=result.find(row=>Object.hasOwn(row,'system_owner_derived'));
    assert.deepEqual(checks,{system_owner_derived:true,owner_auto_verified:true,authorization_preserved:true});
    fs.writeFileSync(validationPath,JSON.stringify({checkedAt:new Date().toISOString(),migrationHash,rolledBack:true,result:[checks]},null,2)+'\n');
    console.log(JSON.stringify({validated:true,migrationHash,checks}));
    return;
  }
  if(command==='apply'){
    const validation=JSON.parse(fs.readFileSync(validationPath,'utf8'));
    if(validation.migrationHash!==migrationHash||validation.rolledBack!==true)throw Error('Validate this exact migration first.');
    const current=await query(`select pg_get_functiondef('public.review_picklestreet_pending_receipt(uuid,uuid,uuid,text,text,uuid)'::regprocedure) like '%system_owner boolean:=false%' as deployed`,true);
    if(current[0]?.deployed)throw Error('System Owner auto-verification is already deployed.');
    const result=await query(migration);
    const verified=await query(`select pg_get_functiondef('public.review_picklestreet_pending_receipt(uuid,uuid,uuid,text,text,uuid)'::regprocedure) like '%case when system_owner then ''auto_approved'' else ''approved'' end%' as deployed`,true);
    assert.equal(verified[0]?.deployed,true);
    fs.writeFileSync(releasePath,JSON.stringify({appliedAt:new Date().toISOString(),migrationHash,deployed:true},null,2)+'\n');
    console.log(JSON.stringify({applied:true,migrationHash,result}));
    return;
  }
  throw Error('Use validate or apply.');
}

main().catch(error=>{console.error(error.message);process.exitCode=1;});
