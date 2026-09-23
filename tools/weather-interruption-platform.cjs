const fs=require('node:fs'),crypto=require('node:crypto');const {query}=require('./pending-platform.cjs');
const dir='operations/weather-interruption',mode=process.argv[2];
(async()=>{
 if(!['validate','apply'].includes(mode))throw Error('Use validate or apply');
 const migration=fs.readFileSync('operations/pending-flow/038-weather-interruption-batches.sql','utf8');
 const hash=crypto.createHash('sha256').update(migration).digest('hex');
 if(mode==='apply'){const v=JSON.parse(fs.readFileSync(dir+'/validation.json','utf8'));if(v.hash!==hash||!v.rolledBack)throw Error('Validate exact migration first');}
 let sql=migration.replace('begin;',`begin isolation level repeatable read;
 set local lock_timeout='5s';set local statement_timeout='90s';
 create temp table wi_bookings_before as select id,to_jsonb(b) data from public.bookings b;
 create temp table wi_functions_before as select oid,md5(pg_get_functiondef(oid)) fingerprint from pg_proc where pronamespace='public'::regnamespace and prokind='f';
 `).replace(/commit;\s*$/,'');
 if(mode==='validate'){
  for(const file of ['operations/pending-flow/manual-review-rollback-tests.sql','operations/pending-flow/group-hold-rollback-tests.sql','operations/pending-flow/group-payment-rollback-tests.sql','operations/weather-credit/rollback-tests.sql']){const s=fs.readFileSync(file,'utf8');sql+='\n'+(file.includes('group-hold')?s:s.slice(0,s.indexOf('\ndo $$')));}
  sql+='\n'+fs.readFileSync(dir+'/rollback-tests.sql','utf8');
 }
 sql+=`\ndo $$ begin
 if exists(select 1 from wi_bookings_before old left join public.bookings b using(id) where old.data is distinct from to_jsonb(b)) then raise exception 'Existing customer booking changed';end if;
 if exists(select 1 from wi_functions_before old left join pg_proc p using(oid) where p.oid is null or old.fingerprint<>md5(pg_get_functiondef(p.oid))) then raise exception 'Existing function changed';end if;
 end $$;\n`;
 sql+=mode==='validate'?'select jsonb_agg(to_jsonb(r)) checks from wi_results r;rollback;':'select true existing_bookings_and_functions_preserved;commit;';
 const result=await query(sql);const report={at:new Date().toISOString(),hash,rolledBack:mode==='validate',result};
 fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(dir+'/'+(mode==='validate'?'validation':'release')+'.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
})().catch(e=>{console.error(e.message);process.exitCode=1;});
