'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const assert=require('node:assert/strict');
const {query}=require('./pending-platform.cjs');

const directory=path.resolve(__dirname,'../operations/pending-flow');
const migration=fs.readFileSync(path.join(directory,'025-system-owner-auto-verification-compatibility.sql'),'utf8').replace(/\r\n/g,'\n');
const hash=crypto.createHash('sha256').update(migration).digest('hex');
const validationPath=path.join(directory,'system-owner-auto-verification-compatibility-validation.json');
const releasePath=path.join(directory,'system-owner-auto-verification-compatibility-release.json');

async function main(){
  const command=process.argv[2];
  if(command==='validate'){
    const sql=migration.replace(/commit;\s*$/i,`select pg_get_functiondef('public.review_picklestreet_pending_receipt(uuid,uuid,uuid,text,text,uuid)'::regprocedure) like '%storedReceiptStatus%' as compatible; rollback;`);
    const result=await query(sql);
    const check=result.find(row=>Object.hasOwn(row,'compatible'));
    assert.equal(check?.compatible,true);
    fs.writeFileSync(validationPath,JSON.stringify({checkedAt:new Date().toISOString(),migrationHash:hash,rolledBack:true,result:[check]},null,2)+'\n');
    console.log(JSON.stringify({validated:true,migrationHash:hash}));
  }else if(command==='apply'){
    const validation=JSON.parse(fs.readFileSync(validationPath,'utf8'));
    if(validation.migrationHash!==hash||validation.rolledBack!==true)throw Error('Validate this exact migration first.');
    const current=await query(`select pg_get_functiondef('public.review_picklestreet_pending_receipt(uuid,uuid,uuid,text,text,uuid)'::regprocedure) like '%storedReceiptStatus%' as deployed`,true);
    if(current[0]?.deployed)throw Error('Compatibility result is already deployed.');
    await query(migration);
    const verified=await query(`select pg_get_functiondef('public.review_picklestreet_pending_receipt(uuid,uuid,uuid,text,text,uuid)'::regprocedure) like '%storedReceiptStatus%' as deployed`,true);
    assert.equal(verified[0]?.deployed,true);
    fs.writeFileSync(releasePath,JSON.stringify({appliedAt:new Date().toISOString(),migrationHash:hash,deployed:true},null,2)+'\n');
    console.log(JSON.stringify({applied:true,migrationHash:hash}));
  }else throw Error('Use validate or apply.');
}

main().catch(error=>{console.error(error.message);process.exitCode=1;});
