'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {query}=require('./pending-platform.cjs');
const dir=path.resolve(__dirname,'../operations/pending-flow');
const read=name=>fs.readFileSync(path.join(dir,name),'utf8');
const altered=['guard_picklestreet_group_schedule','finish_picklestreet_balance_receipt_attempt','review_picklestreet_pending_receipt','dispatch_picklestreet_rejection_emails','run_picklestreet_balance_hold_cleanup'];
const names=altered.map(s=>"'"+s+"'").join(',');
const tenant='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';
const prelude=`
set local statement_timeout='120s';set local lock_timeout='5s';
create temp table gr_existing_functions as select p.oid,p.proname,md5(pg_get_functiondef(p.oid)) fingerprint from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f';
create temp table gr_preserved(table_name text primary key,query_text text,fingerprint text);
do $$ declare r record;q text;f text;begin
 for r in select t.table_name from information_schema.tables t join information_schema.columns c on c.table_schema=t.table_schema and c.table_name=t.table_name and c.column_name='tenant_id' where t.table_schema='public' and t.table_type='BASE TABLE' loop
  q:=format('select md5(coalesce(string_agg(md5(to_jsonb(t)::text),'''' order by md5(to_jsonb(t)::text)),'''')) from public.%I t where tenant_id<>%L::uuid',r.table_name,'${tenant}');
  execute q into f;insert into gr_preserved values(r.table_name,q,f);
 end loop;
end $$;
`;
const checks=`
do $$ declare r record;f text;begin
 if exists(select 1 from gr_existing_functions x left join pg_proc p on p.oid=x.oid where x.proname not in(${names}) and(p.oid is null or md5(pg_get_functiondef(p.oid))<>x.fingerprint)) then raise exception 'Unrelated public function changed';end if;
 for r in select * from gr_preserved loop execute r.query_text into f;if f is distinct from r.fingerprint then raise exception 'Another tenant changed in %',r.table_name;end if;end loop;
 if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and not exists(select 1 from gr_existing_functions x where x.oid=p.oid)
   and(has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE'))) then raise exception 'New private RPC exposed to public client';end if;
end $$;
`;
async function main(){
 const mode=process.argv[2];if(!['validate','apply'].includes(mode))throw Error('Use validate or apply');
 const migration=read('013-group-reschedule.sql');
 if(!/^begin;$/m.test(migration)||! /commit;\s*$/i.test(migration))throw Error('Expected transaction wrapper');
 const migrationHash=crypto.createHash('sha256').update(migration).digest('hex');
 const base=migration.replace(/^begin;$/m,()=> 'begin isolation level repeatable read;\n'+prelude).replace(/commit;\s*$/i,'');
 if(mode==='validate'){
  const sql=base+'\n'+read('group-hold-rollback-tests.sql')+'\n'+read('group-payment-rollback-tests.sql')+'\n'+read('group-reschedule-rollback-tests.sql')+'\n'+checks+`
   select jsonb_build_object('preservedTenantTables',(select count(*) from gr_preserved),'unrelatedFunctionsUnchanged',true,
    'groupHoldChecks',(select jsonb_agg(to_jsonb(r) order by name) from ps_hold_results r),
    'groupPaymentChecks',(select jsonb_agg(to_jsonb(r) order by name) from ps_group_payment_results r),
    'groupRescheduleChecks',(select jsonb_agg(to_jsonb(r) order by name) from ps_group_reschedule_results r)) as checks;
   rollback;`;
  const result=await query(sql);
  const report={checkedAt:new Date().toISOString(),migrationHash,rolledBack:true,result};
  fs.writeFileSync(path.join(dir,'group-reschedule-validation.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
 }else{
  const validation=JSON.parse(read('group-reschedule-validation.json'));
  if(validation.migrationHash!==migrationHash || !validation.rolledBack)throw Error('Validate exact migration first');
  const state=await query("select to_regclass('public.picklestreet_group_reschedule_requests') is not null as installed",true);if(state[0]?.installed)throw Error('Migration already installed; inspect rather than reapply');
  const result=await query(base+'\n'+checks+"\nselect jsonb_build_object('preservedTenantTables',(select count(*) from gr_preserved),'unrelatedFunctionsUnchanged',true) as isolation;\ncommit;");
  const report={appliedAt:new Date().toISOString(),migrationHash,result};
  fs.writeFileSync(path.join(dir,'group-reschedule-release.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
 }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
