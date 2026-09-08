'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {query}=require('./pending-platform.cjs');
const dir=path.resolve(__dirname,'../operations/pending-flow');
const read=name=>fs.readFileSync(path.join(dir,name),'utf8');
async function main(){
 const confidence=process.argv[2]==='confidence';
 const migration=read(confidence?'012-duplicate-reference-confidence.sql':'010-duplicate-reference-identity.sql');
 if(!/^begin;/i.test(migration)||! /commit;\s*$/i.test(migration))throw Error('Expected transaction wrapper');
 const guards=`
 do $$ begin
 if exists(select 1 from ps_hold_existing_functions f join pg_proc p on p.oid=f.oid where f.proname<>'reject_picklestreet_duplicate' and md5(pg_get_functiondef(p.oid))<>f.fingerprint)
 then raise exception 'An unrelated public function was changed';end if;
 if (select fingerprint from ps_hold_foreign_before) is distinct from pg_temp.ps_hold_foreign_fingerprint()
 then raise exception 'Another tenant was changed';end if;
 end;$$;
 select jsonb_build_object(
   'isolation','Other tenants and unrelated public functions unchanged',
   'groupHoldChecks',(select jsonb_agg(to_jsonb(r) order by name) from ps_hold_results r),
   'groupPaymentChecks',(select jsonb_agg(to_jsonb(r) order by name) from ps_group_payment_results r),
   'duplicateIdentityChecks',(select jsonb_agg(to_jsonb(r) order by name) from ps_duplicate_identity_results r)
 ) as checks;
 rollback;`;
 const sql=migration.replace(/^begin;/i,()=> 'begin;\n'+read('provisional-hold-validation-prelude.sql')).replace(/commit;\s*$/i,'')
   +'\n'+read('group-hold-rollback-tests.sql')+'\n'+read('group-payment-rollback-tests.sql')+'\n'+read('duplicate-identity-rollback-tests.sql')
   +(confidence?'\n'+read('duplicate-confidence-rollback-tests.sql'):'')+'\n'+guards;
 const results=await query(sql);
 const report={checkedAt:new Date().toISOString(),migrationHash:crypto.createHash('sha256').update(migration).digest('hex'),rolledBack:true,results};
 fs.writeFileSync(path.join(dir,confidence?'duplicate-confidence-validation.json':'duplicate-identity-validation.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report,null,2));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
