const fs=require('node:fs');
const crypto=require('node:crypto');
const {query}=require('./pending-platform.cjs');
const dir='operations/pending-flow/';
const read=n=>fs.readFileSync(dir+n,'utf8');
const migration=read('045-submitted-duplicate-reference.sql');
const hash=crypto.createHash('sha256').update(migration).digest('hex');
async function main(){
 const mode=process.argv[2];
 if(!['validate','apply','verify'].includes(mode))throw Error('Use validate, apply or verify');
 const live=await query("select pg_get_functiondef('public.reject_picklestreet_duplicate(uuid)'::regprocedure) definition",true);
 if(mode!=='verify' && live[0].definition!==read('duplicate-submitted.baseline.sql'))throw Error('Live function changed; inspect before applying');
 if(mode==='apply'){
  const report=JSON.parse(read('submitted-duplicate-validation.json'));
  if(report.hash!==hash||!report.rolledBack)throw Error('Validate exact migration first');
  await query(migration);
  console.log('Applied submitted-reference duplicate rejection');return;
 }
 const setup=read('group-hold-rollback-tests.sql').split('\ndo $$')[0]+'\ndo $$'+read('group-hold-rollback-tests.sql').split('\ndo $$')[1];
 const fixture=read('group-payment-rollback-tests.sql').split('create function pg_temp.ps_group_payment_begin')[0];
 const sql=(mode==='verify'?'begin;':migration.replace(/commit;\s*$/,''))+`
 create temp table original_bookings as select id,md5(to_jsonb(b)::text) fingerprint from public.bookings b;
 `+setup+fixture+read('submitted-duplicate-tests.sql')+`
 do $$ begin
 if exists(select 1 from original_bookings o left join public.bookings b on b.id=o.id where b.id is null or o.fingerprint<>md5(to_jsonb(b)::text)) then raise exception 'An existing booking changed';end if;
 end $$;
 select * from submitted_duplicate_results order by name;
 rollback;`;
 const results=await query(sql);
 const report={hash,rolledBack:true,checkedAt:new Date().toISOString(),results};
 fs.writeFileSync(dir+`submitted-duplicate-${mode==='verify'?'live-verification':'validation'}.json`,JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report,null,2));
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
