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

async function main(){
  const command=process.argv[2];
  if(!/^begin;$/m.test(migration)||!/commit;\s*$/i.test(migration))throw Error('Expected one transactional migration.');
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
