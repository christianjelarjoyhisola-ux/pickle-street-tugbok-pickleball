'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const { query } = require('./pending-platform.cjs');
const dir = 'operations/pending-flow/';
const attempt = 'e63c91e7-eea3-4f15-8874-81770a91fae8';
const migration = fs.readFileSync(dir + '028-duplicate-reference-recipient-independent.sql', 'utf8');
const baseline = fs.readFileSync(dir + 'duplicate-current.baseline.sql', 'utf8');
const hash = crypto.createHash('sha256').update(migration).digest('hex');
const role = `set local request.jwt.claim.role='service_role'; set local request.jwt.claims='{"role":"service_role"}';`;
const assertDecision = (expected) => `do $$ declare result jsonb; begin
 result:=public.reject_picklestreet_duplicate('${attempt}');
 if result->>'rejected' is distinct from '${expected}' then raise exception 'Unexpected duplicate decision: %',result; end if;
 end $$;`;
const guards = `create temp table untouched_functions as select oid,md5(pg_get_functiondef(oid)) fingerprint from pg_proc where pronamespace='public'::regnamespace and prokind='f' and proname<>'reject_picklestreet_duplicate';
create temp table untouched_bookings as select id,md5(to_jsonb(b)::text) fingerprint from public.bookings b where id<>(select booking_id from public.picklestreet_receipt_attempts where id='${attempt}');`;
const verify = `do $$ begin
 if exists(select 1 from untouched_functions f where md5(pg_get_functiondef(f.oid))<>f.fingerprint) then raise exception 'Unrelated function changed'; end if;
 if exists(select 1 from untouched_bookings f left join public.bookings b on b.id=f.id where b.id is null or md5(to_jsonb(b)::text)<>f.fingerprint) then raise exception 'Unrelated booking changed'; end if;
end $$;`;
async function main() {
 const mode=process.argv[2];
 if(!['validate','apply'].includes(mode)) throw Error('Use validate or apply');
 const live=await query("select pg_get_functiondef('public.reject_picklestreet_duplicate(uuid)'::regprocedure) definition",true);
 if(live[0].definition!==baseline) throw Error('Live definition changed since inspection');
 if(mode==='apply') {
  const validation=JSON.parse(fs.readFileSync(dir+'duplicate-recipient-validation.json','utf8'));
  if(validation.hash!==hash || !validation.rolledBack) throw Error('Validate this exact migration first');
 }
 let sql=migration.replace(/^begin;/,'begin;\nset local lock_timeout=\'5s\';\n'+guards).replace(/commit;\s*$/,'')+'\n'+role;
 if(mode==='validate') {
  const cases=[
   ['low OCR confidence',"extracted_data=jsonb_set(extracted_data,'{confidence,vision}','0.5')"],
   ['ambiguous reference',"flags=flags||array['AMBIGUOUS_REFERENCE']"],
   ['source mismatch',"extracted_data=jsonb_set(extracted_data,'{detected,route,sourceMatched}','false')"],
   ['typed reference mismatch',"submitted_reference='BN9999999999999999'"],
   ['unclaimed reference and invoice',"payment_reference='BN9999999999999999',submitted_reference='BN9999999999999999',extracted_data=jsonb_set(jsonb_set(extracted_data,'{detected,paymentReference}','\"BN9999999999999999\"'),'{detected,route,secondaryReferences}','[{\"kind\":\"bdopay_invoice\",\"value\":\"UNCLAIMED999999\"}]')"],
  ];
  for(const [name,change] of cases) {
   sql+=`\nsavepoint negative_case; update public.picklestreet_receipt_attempts set ${change} where id='${attempt}';`;
   if(name==='unclaimed reference and invoice') sql+=`update public.payment_sessions set provider_payload=jsonb_set(provider_payload,'{submittedReference}','"BN9999999999999999"') where id=(select r.payment_session_id from public.receipt_verifications r join public.picklestreet_receipt_attempts a on a.receipt_id=r.id where a.id='${attempt}');`;
   sql+=assertDecision(false)+' rollback to savepoint negative_case;';
  }
  sql+=`\nsavepoint unprivileged; set local request.jwt.claim.role='authenticated'; set local request.jwt.claims='{"role":"authenticated"}';
do $$ begin begin perform public.reject_picklestreet_duplicate('${attempt}'); raise exception 'Unauthorized call succeeded'; exception when insufficient_privilege then null; end; end $$;
rollback to savepoint unprivileged;`;
 }
 sql+=assertDecision(true)+assertDecision(true)+`
do $$ declare bid uuid; begin
 select booking_id into bid from public.picklestreet_receipt_attempts where id='${attempt}';
 if not exists(select 1 from public.bookings where id=bid and status='cancelled' and payment_status='rejected') then raise exception 'Booking not rejected'; end if;
 if exists(select 1 from public.booking_slots where booking_id=bid and status in('held','confirmed')) then raise exception 'Slots not released'; end if;
 if (select count(*) from public.picklestreet_rejection_emails where booking_id=bid)<>1 then raise exception 'Email queue not idempotent'; end if;
end $$;`+verify;
 sql+=`select reference,status,payment_status from public.bookings where id=(select booking_id from public.picklestreet_receipt_attempts where id='${attempt}');`+(mode==='validate'?'rollback;':'commit;');
 const result=await query(sql);
 const report={at:new Date().toISOString(),hash,rolledBack:mode==='validate',checks:['uncertain identity remains pending','unauthorized rejection blocked','verified duplicate rejects despite unreadable recipient','idempotent rejection','slots released','unrelated functions and bookings unchanged'],result};
 fs.writeFileSync(dir+`duplicate-recipient-${mode==='validate'?'validation':'release'}.json`,JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report,null,2));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
