'use strict';
const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');
const dir=path.resolve(__dirname,'../operations/pending-flow');
async function query(query,read_only=false){
 if(!process.env.SUPABASE_ACCESS_TOKEN)throw Error('Management authentication unavailable');
 const response=await fetch('https://api.supabase.com/v1/projects/neqvrwtofiolcuxewdze/database/query',{method:'POST',headers:{Authorization:'Bearer '+process.env.SUPABASE_ACCESS_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({query,read_only})});
 const result=await response.json();if(!response.ok)throw Error(JSON.stringify(result));return result;
}
async function main(){
 const command=process.argv[2];
 const configurations={initial:['001-pending-receipts.sql','rollback-tests.sql','rollback-validation.json','migration-release.json','public.picklestreet_receipt_jobs'],balance:['002-balance-pending.sql','balance-rollback-tests.sql','balance-rollback-validation.json','balance-migration-release.json','public.picklestreet_balance_receipt_jobs'],expiry:['003-balance-expiry.sql','expiry-rollback-tests.sql','expiry-rollback-validation.json','expiry-migration-release.json','public.run_picklestreet_balance_hold_cleanup']};
 configurations.manual=['004-staff-payment-review.sql','manual-review-rollback-tests.sql','manual-review-rollback-validation.json','manual-review-migration-release.json','public.picklestreet_receipt_staff_reviews'];
 const config=configurations[process.argv[3]||'initial'];if(!config)throw Error('Choose initial, balance, expiry, or manual');
 const migration=fs.readFileSync(path.join(dir,config[0]),'utf8');
 const hash=crypto.createHash('sha256').update(migration).digest('hex');
 if(command==='validate'){
   if(!/\bcommit;\s*$/i.test(migration)||(migration.match(/^commit;\s*$/gmi)||[]).length!==1)throw Error('Migration must end with its only top-level COMMIT before rollback validation');
   const tests=fs.readFileSync(path.join(dir,config[1]),'utf8');
   const sql=migration.replace(/\bcommit;\s*$/i,'')+'\n'+tests+'\nrollback;';
   const result=await query(sql);console.log(JSON.stringify(result));
   fs.writeFileSync(path.join(dir,config[2]),JSON.stringify({checkedAt:new Date().toISOString(),migrationHash:hash,rolledBack:true,result},null,2));
 }else if(command==='apply'){
   const validation=JSON.parse(fs.readFileSync(path.join(dir,config[2]),'utf8'));
   if(validation.migrationHash!==hash||!validation.rolledBack)throw Error('Validate this exact migration first');
   const exists=await query(`select ${process.argv[3]==='expiry'?'to_regproc':'to_regclass'}('${config[4]}') is not null as deployed`,true);
   if(exists[0]?.deployed)throw Error('Workflow already exists; inspect before applying');
   const result=await query(migration);console.log(JSON.stringify({applied:true,result}));
   fs.writeFileSync(path.join(dir,config[3]),JSON.stringify({appliedAt:new Date().toISOString(),migrationHash:hash},null,2));
 }else throw Error('Use validate or apply');
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1});
module.exports={query};
