'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {query}=require('./pending-platform.cjs');
const dir=path.resolve(__dirname,'../operations/pending-flow');
const read=name=>fs.readFileSync(path.join(dir,name),'utf8');
const checks=`
create temp table qr_other_rows as select md5(jsonb_build_object(
 'tenants',(select jsonb_agg(to_jsonb(t) order by id) from public.tenants t where id<>'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'),
 'methods',(select jsonb_agg(to_jsonb(t) order by id) from public.tenant_payment_methods t where tenant_id<>'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'))::text) fingerprint;
create temp table qr_functions as select oid,md5(pg_get_functiondef(oid)) fingerprint from pg_proc where pronamespace='public'::regnamespace and prokind='f' and proname not in ('picklestreet_receipt_route_ready','picklestreet_receipt_route_config_current','auto_approve_picklestreet_receipt_route','reject_picklestreet_duplicate');
`;
const verify=`
do $$ begin
 if exists(select 1 from qr_functions f where md5(pg_get_functiondef(f.oid))<>f.fingerprint) then raise exception 'Unrelated function changed';end if;
 if (select fingerprint from qr_other_rows) is distinct from md5(jsonb_build_object(
 'tenants',(select jsonb_agg(to_jsonb(t) order by id) from public.tenants t where id<>'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'),
 'methods',(select jsonb_agg(to_jsonb(t) order by id) from public.tenant_payment_methods t where tenant_id<>'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'))::text) then raise exception 'Other tenant data changed';end if;
end $$;
`;
(async()=>{
 const mode=process.argv[2];if(!['validate','apply'].includes(mode))throw Error('Use validate or apply');
 const sql=read('018-maya-configured-receiver.sql'),hash=crypto.createHash('sha256').update(sql).digest('hex');
 const base=sql.replace(/^begin;$/m,()=>"begin isolation level repeatable read;\nset local lock_timeout='5s';\n"+checks).replace(/commit;\s*$/i,'');
 if(mode==='apply'){
   const v=JSON.parse(read('maya-configured-validation.json'));if(v.hash!==hash||!v.rolledBack)throw Error('Validate exact migration first');
 }
 const result=await query(base+(mode==='validate'?'\n'+read('maya-configured-rollback-tests.sql'):'')+'\n'+verify+(mode==='validate'?"\nselect * from maya_results;rollback;":"\nselect true as unrelatedFunctionsAndTenantSettingsPreserved;commit;"));
 const report={at:new Date().toISOString(),hash,rolledBack:mode==='validate',result};
 fs.writeFileSync(path.join(dir,mode==='validate'?'maya-configured-validation.json':'maya-configured-release.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
})().catch(e=>{console.error(e.message);process.exitCode=1;});
