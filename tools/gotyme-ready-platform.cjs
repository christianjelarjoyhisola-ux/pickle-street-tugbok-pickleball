'use strict';
const fs=require('node:fs'),crypto=require('node:crypto');
const {query}=require('./pending-platform.cjs');
const dir='operations/pending-flow/';
const migration=fs.readFileSync(dir+'030-gotyme-parser-version.sql','utf8');
const hash=crypto.createHash('sha256').update(migration).digest('hex');
const tests=`
do $$ declare data jsonb; snapshot jsonb; variant jsonb; version text; begin
 select extracted_data into data from public.picklestreet_receipt_attempts where id='8293b7ca-1ed9-4d55-bdd1-fda702a72db3';
 -- Synthetic recovery candidate; never update the customer's saved evidence.
 data:=jsonb_set(jsonb_set(data,'{detected,route,recipientMatched}','true'),'{confidence,effective}',data#>'{confidence,vision}');
 select jsonb_build_object('method','gotyme','name',m.account_name,'account',m.account_reference,'destinationMethod','gcash','verificationSettingsRevision',s.revision) into snapshot
 from public.tenant_payment_methods m join public.picklestreet_receipt_route_settings s on s.tenant_id=m.tenant_id
 where m.tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a' and m.method_code='gcash';
 foreach version in array array['gotyme_to_gcash_v1','gotyme_to_gcash_v2'] loop
  if public.picklestreet_receipt_route_ready('gotyme',jsonb_set(data,'{detected,route,parserVersion}',to_jsonb(version)),snapshot) is distinct from true then raise exception 'Supported parser blocked: %',version; end if;
 end loop;
 for variant in select value from jsonb_array_elements(jsonb_build_array(
  jsonb_set(data,'{detected,route,parserVersion}','"gotyme_to_gcash_v999"'),
  jsonb_set(data,'{detected,route,recipientMatched}','false'),
  jsonb_set(data,'{detected,route,referenceMatched}','false'),
  jsonb_set(data,'{detected,route,successMatched}','false'),
  jsonb_set(data,'{detected,route,sourceProvider}','"gcash"'),
  jsonb_set(data,'{confidence,vision}','0.8'),
  jsonb_set(data,'{confidence,effective}','0.8')
 )) loop
  if public.picklestreet_receipt_route_ready('gotyme',variant,snapshot) is distinct from false then raise exception 'Invalid evidence accepted'; end if;
 end loop;
 if public.picklestreet_receipt_route_ready('gotyme',data,jsonb_set(snapshot,'{verificationSettingsRevision}','-1')) is distinct from false then raise exception 'Stale settings accepted'; end if;
end $$;`;
(async()=>{
 const mode=process.argv[2];if(!['validate','apply'].includes(mode))throw Error('Use validate or apply');
 const baseline=JSON.parse(fs.readFileSync(dir+'gotyme-ready-baseline.json')).find(x=>x.proname==='picklestreet_receipt_route_ready').definition;
 const live=await query("select pg_get_functiondef('public.picklestreet_receipt_route_ready(text,jsonb,jsonb)'::regprocedure) definition",true);
 if(live[0].definition!==baseline)throw Error('Live function changed since inspection');
 if(mode==='apply'){const v=JSON.parse(fs.readFileSync(dir+'gotyme-ready-validation.json'));if(v.hash!==hash||!v.rolledBack)throw Error('Validate this migration first');}
 const prelude="set local lock_timeout='5s'; create temp table gotyme_unchanged as select oid,md5(pg_get_functiondef(oid)) fingerprint from pg_proc where pronamespace='public'::regnamespace and prokind='f' and proname<>'picklestreet_receipt_route_ready';";
 const verify="do $$ begin if exists(select 1 from gotyme_unchanged where fingerprint<>md5(pg_get_functiondef(oid))) then raise exception 'Unrelated function changed'; end if;end $$;";
 const result=await query(migration.replace(/^begin;/,()=> 'begin;\n'+prelude).replace(/commit;\s*$/,'')+tests+verify+'select true as passed;'+(mode==='validate'?'rollback;':'commit;'));
 const report={at:new Date().toISOString(),hash,rolledBack:mode==='validate',checks:['GoTyme v1 and v2 supported','unrecognized versions rejected','recipient, reference, status, source and confidence checks preserved','stale settings rejected','unrelated functions preserved'],result};
 fs.writeFileSync(dir+`gotyme-ready-${mode==='validate'?'validation':'release'}.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
})().catch(e=>{console.error(e.message);process.exitCode=1;});
