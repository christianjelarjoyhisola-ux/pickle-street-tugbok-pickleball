// LOCAL FILE GENERATION ONLY. No network, credentials, or database execution.
// Root may review and submit court-promo-validation-rollback.sql to the Management API.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sourceDir=path.resolve(__dirname,'../operations/pending-flow');
const migration = fs.readFileSync(path.join(sourceDir,'006-court-promo.sql'),'utf8').replace(/\r\n/g,'\n');
let tests = fs.readFileSync(path.join(sourceDir,'court-promo-rollback-tests.sql'),'utf8').replace(/\r\n/g,'\n');
if ((migration.match(/^commit;\s*$/gmi)||[]).length !== 1 || !/commit;\s*$/i.test(migration)) throw Error('Expected one final migration COMMIT');
if ((migration.match(/^begin;\s*$/gmi)||[]).length !== 1) throw Error('Expected one top-level BEGIN');
tests = tests.replace(/select check_name,passed from ps_promo_results order by check_name;\s*$/i,'');
const prefix = `begin;
set local statement_timeout = '45s';
set local lock_timeout = '8s';
create temporary table ps_promo_before_function_hashes on commit drop as
select p.oid, p.oid::regprocedure::text as signature, md5(pg_get_functiondef(p.oid)) as definition_hash
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.prokind in ('f','p');
create temporary table ps_promo_before_row_hashes(kind text primary key, row_count bigint, fingerprint text) on commit drop;
insert into ps_promo_before_row_hashes
select 'foreign_courts',count(*),md5(coalesce(string_agg(to_jsonb(c)::text,'|' order by c.id),''))
from public.courts c where tenant_id <> 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid
union all
select 'foreign_tenants',count(*),md5(coalesce(string_agg(to_jsonb(t)::text,'|' order by t.id),''))
from public.tenants t where id <> 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid
union all
select 'target_courts',count(*),md5(coalesce(string_agg(to_jsonb(c)::text,'|' order by c.id),''))
from public.courts c where tenant_id = 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid;
`;
const beforeTests = `
do $$ declare current_count bigint;current_hash text; begin
select count(*),md5(coalesce(string_agg(to_jsonb(c)::text,'|' order by c.id),'')) into current_count,current_hash
from public.courts c where tenant_id = 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid;
if not exists(select 1 from ps_promo_before_row_hashes where kind='target_courts' and row_count=current_count and fingerprint=current_hash) then
 raise exception 'Migration changed existing target court rows before any fixture mutation'; end if;
end; $$;
`;
const afterTests = `
do $$ declare current_count bigint;current_hash text; begin
if exists(select 1 from ps_promo_before_function_hashes before_hash left join pg_proc p on p.oid=before_hash.oid
 where p.oid is null or md5(pg_get_functiondef(p.oid)) is distinct from before_hash.definition_hash) then
 raise exception 'An existing shared function definition changed'; end if;
insert into ps_promo_results values ('Every preexisting public function definition is unchanged',true);
select count(*),md5(coalesce(string_agg(to_jsonb(c)::text,'|' order by c.id),'')) into current_count,current_hash
from public.courts c where tenant_id <> 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid;
if not exists(select 1 from ps_promo_before_row_hashes where kind='foreign_courts' and row_count=current_count and fingerprint=current_hash) then
 raise exception 'Foreign tenant court fingerprint changed'; end if;
select count(*),md5(coalesce(string_agg(to_jsonb(t)::text,'|' order by t.id),'')) into current_count,current_hash
from public.tenants t where id <> 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid;
if not exists(select 1 from ps_promo_before_row_hashes where kind='foreign_tenants' and row_count=current_count and fingerprint=current_hash) then
 raise exception 'Foreign tenant configuration fingerprint changed'; end if;
insert into ps_promo_results values ('Other tenant court and tenant configuration fingerprints unchanged',true);
insert into ps_promo_results values ('Pre-migration target court fingerprint preserved through installation',true);
end; $$;
select check_name,passed from ps_promo_results order by check_name;
rollback;
`;
const bookingTests=fs.readFileSync(path.join(sourceDir,'court-promo-booking-integration.sql'),'utf8');
const sql = prefix + migration.replace(/^begin;\s*$/mi,'').replace(/commit;\s*$/i,'') + beforeTests + tests + bookingTests + afterTests;
const output = path.resolve(__dirname,'../artifacts/court-promo-validation-rollback.sql');
fs.writeFileSync(output,sql);
console.log(JSON.stringify({generated:true,executed:false,path:output,migrationSha256:crypto.createHash('sha256').update(migration).digest('hex')}));
