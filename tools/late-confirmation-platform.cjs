const fs=require('node:fs');
const crypto=require('node:crypto');
const {query}=require('./pending-platform.cjs');
const dir='operations/late-confirmation';
const mode=process.argv[2];
const migration=fs.readFileSync('operations/pending-flow/036-late-staff-confirmation.sql','utf8');
const hash=crypto.createHash('sha256').update(migration).digest('hex');
const prelude=`
set local lock_timeout='5s';set local statement_timeout='90s';
create temp table lc_bookings_before as select id,to_jsonb(b) data from public.bookings b;
create temp table lc_functions_before as select oid,proname,md5(pg_get_functiondef(oid)) fingerprint from pg_proc where pronamespace='public'::regnamespace and prokind='f';
create temp table lc_tenant_before as select id,to_jsonb(t) data from public.tenants t;
`;
const checks=`
do $$ begin
 if exists(select 1 from lc_bookings_before old left join public.bookings b using(id) where old.data is distinct from to_jsonb(b)) then raise exception 'An existing customer booking changed';end if;
 if exists(select 1 from lc_tenant_before old left join public.tenants t using(id) where old.data is distinct from to_jsonb(t)) then raise exception 'An existing tenant changed';end if;
 if exists(select 1 from lc_functions_before old left join pg_proc p using(oid) where old.proname not in ('review_picklestreet_pending_receipt','guard_receipt_approval_before_play') and (p.oid is null or old.fingerprint<>md5(pg_get_functiondef(p.oid)))) then raise exception 'Unrelated function changed';end if;
end $$;
`;
(async()=>{
 if(!['validate','apply','verify'].includes(mode))throw Error('Use validate, apply or verify');
 if(mode==='verify'){
  console.log(JSON.stringify(await query(`select pg_get_functiondef('public.review_picklestreet_pending_receipt(uuid,uuid,uuid,text,text,uuid)'::regprocedure) like '%if q.request_type=''reschedule_adjustment'' and (target_start%' as late_confirmation_enabled`,true)));return;
 }
 if(mode==='apply'){
  const validation=JSON.parse(fs.readFileSync(dir+'/validation.json','utf8'));
  if(validation.hash!==hash||!validation.rolledBack)throw Error('Validate this exact migration first');
 }
 let sql=migration.replace('begin;','begin isolation level repeatable read;\n'+prelude).replace(/commit;\s*$/,'');
 if(mode==='validate'){
  const legacy=fs.readFileSync('operations/pending-flow/manual-review-rollback-tests.sql','utf8');
  sql+='\n'+legacy.slice(0,legacy.indexOf('\ndo $$'));
  sql+='\n'+fs.readFileSync(dir+'/rollback-tests.sql','utf8');
  for(const file of ['group-hold-rollback-tests.sql','group-payment-rollback-tests.sql','group-reschedule-rollback-tests.sql']) {
   let suite=fs.readFileSync('operations/pending-flow/'+file,'utf8');
   suite=suite.replaceAll("r->>'status'<>'approved'","r->>'status' not in ('approved','auto_approved')");
   sql+='\n'+suite;
  }
  sql+="\ninsert into lc_results select 'Group hold: '||name,passed from ps_hold_results;\ninsert into lc_results select 'Group payment: '||name,passed from ps_group_payment_results;\ninsert into lc_results select 'Group reschedule: '||name,passed from ps_group_reschedule_results;";
 }
 sql+='\n'+checks+'\nselect '+(mode==='validate'?"jsonb_agg(to_jsonb(r)) as checks from lc_results r":"true as existing_bookings_and_unrelated_functions_preserved")+';\n'+(mode==='validate'?'rollback;':'commit;');
 const result=await query(sql);
 fs.mkdirSync(dir,{recursive:true});
 const report={at:new Date().toISOString(),hash,rolledBack:mode==='validate',result};
 fs.writeFileSync(dir+'/'+(mode==='validate'?'validation':'release')+'.json',JSON.stringify(report,null,2));
 console.log(JSON.stringify(report));
})().catch(error=>{console.error(error.message);process.exitCode=1;});
