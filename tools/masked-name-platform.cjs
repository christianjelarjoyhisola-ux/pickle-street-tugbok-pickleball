const fs=require('node:fs'),crypto=require('node:crypto');
const {query}=require('./pending-platform.cjs');
const dir='operations/pending-flow/';const read=n=>fs.readFileSync(dir+n,'utf8');
const migration=read('047-masked-name-exact-account.sql');const hash=crypto.createHash('sha256').update(migration).digest('hex');
async function main(){
 const mode=process.argv[2];if(!['validate','apply','verify'].includes(mode))throw Error('Use validate/apply/verify');
 const baseline=read('masked-name.baseline.sql');
 const live=await query("select pg_get_functiondef('public.picklestreet_receipt_route_ready(text,jsonb,jsonb)'::regprocedure) definition",true);
 if(mode!=='verify'&&live[0].definition!==baseline)throw Error('Live function changed');
 if(mode==='apply'){
  const validation=JSON.parse(read('masked-name-validation.json'));if(validation.hash!==hash||!validation.rolledBack)throw Error('Validate exact migration');
  await query(migration);console.log('Applied field confidence gate');return;
 }
 const hold=read('group-hold-rollback-tests.sql').split('\ndo $$');
 const setup=hold[0]+'\ndo $$'+hold[1];
 const fixture=read('group-payment-rollback-tests.sql').split('create function pg_temp.ps_group_payment_begin')[0];
 const identity=read('duplicate-identity-rollback-tests.sql').split('create function pg_temp.ps_identity_pending')[0];
 const sql=(mode==='verify'?'begin;':migration.replace(/commit;\s*$/,''))+`
 create temp table protected_bookings as select id,md5(to_jsonb(b)::text) fingerprint from public.bookings b;
 `+setup+fixture+identity+read('masked-name-tests.sql')+`
 do $$ begin if exists(select 1 from protected_bookings p left join public.bookings b on b.id=p.id where b.id is null or p.fingerprint<>md5(to_jsonb(b)::text)) then raise exception 'Existing booking modified';end if;end $$;
 select * from critical_confidence_results;
 rollback;`;
 const result=await query(sql);const report={hash,rolledBack:true,at:new Date().toISOString(),result};
 fs.writeFileSync(dir+`masked-name-${mode==='verify'?'live-verification':'validation'}.json`,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
