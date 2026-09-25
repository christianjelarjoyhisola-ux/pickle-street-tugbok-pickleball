'use strict';
const fs=require('node:fs'),crypto=require('node:crypto');
const {query}=require('./pending-platform.cjs');
const dir='operations/pending-flow/';
const sql=fs.readFileSync(dir+'029-gotyme-trace-identity.sql','utf8');
const hash=crypto.createHash('sha256').update(sql).digest('hex');
const check=`
do $$ begin
 if exists(select 1 from before_bookings x left join public.bookings b on x.id=b.id where b.id is null or x.hash<>md5(to_jsonb(b)::text)) then raise exception 'Unrelated booking changed'; end if;
 if exists(select 1 from before_functions x where x.hash<>md5(pg_get_functiondef(x.oid))) then raise exception 'Unrelated function changed'; end if;
 if exists(select 1 from before_claims x left join public.picklestreet_receipt_reference_claims c on c.tenant_id=x.tenant_id and c.namespace=x.namespace and c.reference_hash=x.reference_hash where c.verification_id is distinct from x.verification_id) then raise exception 'Other tenant claim changed'; end if;
end $$;`;
const prelude=`
set local lock_timeout='5s';
create temp table before_bookings as select id,md5(to_jsonb(b)::text) hash from public.bookings b;
create temp table before_claims as select * from public.picklestreet_receipt_reference_claims where tenant_id<>'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';
create temp table before_functions as select oid,md5(pg_get_functiondef(oid)) hash from pg_proc where pronamespace='public'::regnamespace and prokind='f' and proname not in('guard_picklestreet_receipt_reference_claims','reject_picklestreet_duplicate');
`;
const tests=`
set local request.jwt.claim.role='service_role';set local request.jwt.claims='{"role":"service_role"}';
savepoint confirm_test;
do $$ declare a record;result jsonb; begin
 for a in select * from public.picklestreet_receipt_attempts where id in('8293b7ca-1ed9-4d55-bdd1-fda702a72db3','140f40a1-b3ab-44fe-8bad-5900e687feca') loop
 result:=public.review_picklestreet_pending_receipt(a.receipt_id,a.id,extensions.gen_random_uuid(),'approve','Owner-requested manual confirmation after receipt review.','979a1e5d-cf7e-4128-973c-9394d092680a');
 if not exists(select 1 from public.bookings where id=a.booking_id and status='confirmed' and payment_status='paid') then raise exception 'Confirmation failed: %',result; end if;
 end loop;
end $$;
rollback to savepoint confirm_test;
-- The primary transaction reference still cannot pay a second booking.
savepoint duplicate_test;
do $$ declare a record; begin
 select * into a from public.picklestreet_receipt_attempts where id='8293b7ca-1ed9-4d55-bdd1-fda702a72db3';
 begin
 update public.receipt_verifications set payment_reference='ITO260921104148001' where id=a.receipt_id;
 perform public.review_picklestreet_pending_receipt(a.receipt_id,a.id,extensions.gen_random_uuid(),'approve','Duplicate protection rollback test.','979a1e5d-cf7e-4128-973c-9394d092680a');
 raise exception 'Reused primary reference was accepted';
 exception when unique_violation then if sqlerrm<>'duplicate_payment_route_reference' and sqlerrm not like '%receipt_verifications_payment_reference_unique%' then raise; end if; end;
end $$;
rollback to savepoint duplicate_test;
`;
(async()=>{
 const mode=process.argv[2];if(!['validate','apply'].includes(mode))throw Error('Use validate or apply');
 const baseline=JSON.parse(fs.readFileSync(dir+'gotyme-trace-baseline.json','utf8'));
 const live=await query("select proname,pg_get_functiondef(oid) definition from pg_proc where pronamespace='public'::regnamespace and proname in ('guard_picklestreet_receipt_reference_claims','reject_picklestreet_duplicate')",true);
 if(baseline.some(b=>!live.some(l=>l.proname===b.proname&&l.definition===b.definition)))throw Error('Live functions changed since inspection');
 if(mode==='apply'){const v=JSON.parse(fs.readFileSync(dir+'gotyme-trace-validation.json','utf8'));if(!v.rolledBack||v.hash!==hash)throw Error('Validate first');}
 const result=await query(sql.replace(/^begin;/,'begin;\n'+prelude).replace(/commit;\s*$/,'')+(mode==='validate'?tests:'')+check+"select true as passed;"+(mode==='validate'?'rollback;':'commit;'));
 const report={at:new Date().toISOString(),hash,rolledBack:mode==='validate',checks:['both requested bookings can be manually confirmed','reused primary reference still blocked','no booking changes persisted','unrelated functions and other tenant claims unchanged'],result};
 fs.writeFileSync(dir+`gotyme-trace-${mode==='validate'?'validation':'release'}.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
})().catch(e=>{console.error(e.message);process.exitCode=1;});
