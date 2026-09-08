'use strict';
// Root-owned, fixed-project release tool. Validation rolls every fixture back.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {query}=require('./pending-platform.cjs');
const root=path.resolve(__dirname,'..'),dir=path.join(root,'operations/pending-flow');
const migration=fs.readFileSync(path.join(dir,'006-court-promo.sql'),'utf8').replace(/\r\n/g,'\n');
const migrationHash=crypto.createHash('sha256').update(migration).digest('hex');
const validationPath=path.join(dir,'court-promo-rollback-validation.json');
async function main(){
  assert.equal((migration.match(/^commit;\s*$/gmi)||[]).length,1);
  assert.match(migration,/commit;\s*$/i);
  const command=process.argv[2];
  if(command==='validate'){
    execFileSync(process.execPath,[path.join(__dirname,'build-court-promo-validation.cjs')],{cwd:root,stdio:'inherit'});
    const sql=fs.readFileSync(path.join(root,'artifacts/court-promo-validation-rollback.sql'),'utf8');
    assert.match(sql,/rollback;\s*$/i);assert.doesNotMatch(sql,/^commit;/mi);
    const result=await query(sql);
    assert.ok(result.length>=26&&result.every(row=>row.passed===true));
    fs.writeFileSync(validationPath,JSON.stringify({checkedAt:new Date().toISOString(),migrationHash,rolledBack:true,result},null,2)+'\n');
    console.log(JSON.stringify({rolledBack:true,passed:result.length,migrationHash}));
    return;
  }
  if(command!=='apply')throw Error('Use validate or apply');
  const validation=JSON.parse(fs.readFileSync(validationPath,'utf8'));
  assert.equal(validation.migrationHash,migrationHash);assert.equal(validation.rolledBack,true);
  assert.ok(validation.result.length>=26&&validation.result.every(row=>row.passed===true));
  const installed=await query("select to_regprocedure('public.manage_picklestreet_court(text,text,text,uuid,jsonb,jsonb)') is not null as installed",true);
  assert.equal(installed[0].installed,false,'Already installed; inspect before another release.');
  // Compare all existing public functions and court rows inside the installation
  // transaction. An unexpected change aborts before COMMIT.
  const prefix=`
create temporary table ps_install_functions on commit drop as
 select p.oid,md5(pg_get_functiondef(p.oid)) as hash from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.prokind in ('f','p');
create temporary table ps_install_courts on commit drop as select id,tenant_id,md5(to_jsonb(c)::text) as hash from public.courts c;
create temporary table ps_install_tenants on commit drop as select id,md5(to_jsonb(t)::text) as hash from public.tenants t;
`;
  const suffix=`
do $$ begin
 if exists(select 1 from ps_install_functions b left join pg_proc p on p.oid=b.oid where p.oid is null or md5(pg_get_functiondef(p.oid)) is distinct from b.hash) then
  raise exception 'Existing public function changed'; end if;
 if exists(select 1 from public.courts c full join ps_install_courts b using(id) where c.id is null or b.id is null or md5(to_jsonb(c)::text) is distinct from b.hash) then
  raise exception 'Existing court rows changed'; end if;
 if exists(select 1 from public.tenants t full join ps_install_tenants b using(id) where t.id is null or b.id is null or md5(to_jsonb(t)::text) is distinct from b.hash) then
  raise exception 'Existing tenant rows changed'; end if;
end; $$;
select (select count(*) from ps_install_functions) as unchanged_function_count,
 (select count(*) from ps_install_courts) as unchanged_court_count,
 (select count(*) from ps_install_tenants) as unchanged_tenant_count,
 (select count(*) from public.courts where tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid) as target_court_count,
 (select bool_and((band.value->>'hourlyRate')::numeric=1 and coalesce((band.value->>'promoEnabled')::boolean,false)=false)
   from public.courts c cross join lateral jsonb_array_elements(c.pricing_config#>'{regular,bands}') as band(value)
   where c.tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid) as testing_rates_preserved;
commit;
`;
  const result=await query(migration.replace(/^begin;/m,()=> 'begin;\n'+prefix).replace(/commit;\s*$/i,()=>suffix));
  const report={appliedAt:new Date().toISOString(),project:'neqvrwtofiolcuxewdze',tenant:'pickle-street-tugbok',migrationHash,validationGroups:validation.result.length,result};
  fs.writeFileSync(path.join(dir,'court-promo-migration-release.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
