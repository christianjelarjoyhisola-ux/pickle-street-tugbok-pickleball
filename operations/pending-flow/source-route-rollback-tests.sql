-- Temporary fixture rows are confined to Pickle Street and rolled back with the migration.
set local request.jwt.claims='{"role":"service_role"}';
set local request.jwt.claim.role='service_role';
create temporary table ps_test_results (name text primary key, passed boolean);
create function pg_temp.ps_receiver() returns jsonb language sql as $$
 select jsonb_build_object('method',method_code,'name',account_name,'account',account_reference) from public.tenant_payment_methods
 where tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a' and method_code='gcash' and is_active
$$;
create function pg_temp.ps_booking(n integer) returns uuid language plpgsql as $$
declare b uuid:=extensions.gen_random_uuid();c uuid;start_time timestamptz;
begin
 select id into c from public.courts where tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a' and status='active' order by id limit 1;
 start_time:=(current_date+400)::timestamp at time zone 'Asia/Manila'+n*interval '1 hour';
 insert into public.bookings(id,tenant_id,court_id,reference,customer_name,customer_phone,starts_at,ends_at,local_booking_date,subtotal_amount,service_fee_amount,total_amount,expires_at,metadata)
 values(b,'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a',c,'PS-ROLLBACK-'||n,'Rollback fixture','00000000000',start_time,start_time+interval '1 hour',(start_time at time zone 'Asia/Manila')::date,200,15,215,now()+interval '15 minutes','{"fullPaymentOnly":true}');
 insert into public.booking_slots(tenant_id,booking_id,court_id,starts_at,ends_at,status,hold_expires_at)
 values('f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a',b,c,start_time,start_time+interval '1 hour','held',now()+interval '15 minutes');
 return b;
end;$$;
create function pg_temp.ps_data(b uuid,ref text) returns jsonb language sql as $$
select jsonb_build_object('schemaVersion',2,'provider','google_vision','feature','DOCUMENT_TEXT_DETECTION','ocrCharacterCount',160,'file',jsonb_build_object('mimeType','image/png','sizeBytes',100),
'detected',jsonb_build_object('paymentReference',ref),
'comparison',jsonb_build_object('currency','PHP','expectedAmount',215,'amountMatched',true),
'timing',jsonb_build_object('bookingStartedAt',created_at,'tenantTimezone','Asia/Manila','receiptDate',to_char(created_at at time zone 'Asia/Manila','YYYY-MM-DD'),'receiptTime',to_char(created_at at time zone 'Asia/Manila','HH24:MI'),'receiptDateTime',date_trunc('minute',created_at),'withinWindow',true,'allowedWindowMinutes',10,'earlyToleranceMinutes',2),
'confidence',jsonb_build_object('effective',0.99)) from public.bookings where tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a' and id=b
$$;
-- Synthetic target-tenant fixtures. The caller rolls back this entire transaction.
set local request.jwt.claims='{"role":"service_role"}';
set local request.jwt.claim.role='service_role';
create temporary table ps2_results(name text primary key,passed boolean);
create function pg_temp.ps2_fixture(n integer) returns jsonb language plpgsql as $$
declare t constant uuid:='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';b uuid:=extensions.gen_random_uuid();q uuid:=extensions.gen_random_uuid();c uuid;start_time timestamptz;
begin
 select id into c from public.courts where tenant_id=t and status='active' order by id limit 1;
 start_time:=((current_date+401)::timestamp+n*interval '4 hours') at time zone 'Asia/Manila';
 insert into public.bookings(id,tenant_id,court_id,reference,customer_name,customer_phone,status,payment_status,starts_at,ends_at,local_booking_date,subtotal_amount,service_fee_amount,total_amount,expires_at,metadata)
 values(b,t,c,'PS-BALANCE-ROLLBACK-'||n,'Rollback fixture','00000000000','confirmed','paid',start_time,start_time+interval '1 hour',(start_time at time zone 'Asia/Manila')::date,200,15,215,null,'{"fullPaymentOnly":true}');
 insert into public.booking_slots(tenant_id,booking_id,court_id,starts_at,ends_at,status,hold_expires_at)
 values(t,b,c,start_time,start_time+interval '1 hour','confirmed',null);
 insert into public.booking_balance_requests(id,tenant_id,booking_id,issued_by,accepted_amount,remaining_amount,currency,status,deadline_at,token_hash,request_type,request_details)
 values(q,t,b,(select user_id from public.platform_profiles where is_platform_owner order by user_id limit 1),215,40,'PHP','awaiting_payment',now()+interval '5 minutes',repeat('a',64),'reschedule_adjustment',jsonb_build_object(
 'idempotencyKey',extensions.gen_random_uuid(),'oldStartsAt',start_time,'oldEndsAt',start_time+interval '1 hour','newStartsAt',start_time+interval '2 hours','newEndsAt',start_time+interval '3 hours',
 'newLocalDate',((start_time+interval '2 hours') at time zone 'Asia/Manila')::date,'newStartTime',((start_time+interval '2 hours') at time zone 'Asia/Manila')::time,
 'newSubtotalAmount',240,'newTotalAmount',255,'reasonCode','customer_request','publicReason','Requested later time','notifyCustomer',false));
 insert into public.booking_slots(tenant_id,booking_id,court_id,starts_at,ends_at,status,hold_expires_at,balance_request_id)
 values(t,b,c,start_time+interval '2 hours',start_time+interval '3 hours','held',now()+interval '5 minutes',q);
 return jsonb_build_object('b',b,'q',q,'c',c);
end;$$;
create function pg_temp.ps2_begin(f jsonb,hash text,ref text,action text default 'upload') returns jsonb language plpgsql as $$
declare k uuid:=extensions.gen_random_uuid();
begin
 update public.picklestreet_balance_receipt_attempts set created_at=now()-interval '1 minute' where balance_request_id=(f->>'q')::uuid;
 return public.begin_picklestreet_balance_receipt_attempt((f->>'b')::uuid,(f->>'q')::uuid,action,k,
 case when action='retry' then null else 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a/receipts/'||(f->>'b')||'/'||k::text||'.png' end,
 case when action='retry' then null else hash end,'gcash',ref);
end;$$;
create function pg_temp.ps2_finish(j jsonb,err text default null,receiver_ok boolean default true) returns jsonb language plpgsql as $$
declare d jsonb;s timestamptz:=(j->>'bookingStartedAt')::timestamptz;receiver jsonb;
begin
 select jsonb_build_object('method',method_code,'name',account_name,'account',account_reference) into receiver from public.tenant_payment_methods
 where tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a' and method_code='gcash' and is_active;
 if not receiver_ok then receiver:=jsonb_build_object('method','gcash','name','Wrong Receiver','account','00000000000');end if;
 d:=jsonb_build_object('schemaVersion',2,'provider','google_vision','feature','DOCUMENT_TEXT_DETECTION','ocrCharacterCount',160,'file',jsonb_build_object('mimeType','image/png','sizeBytes',100),
 'detected',jsonb_build_object('paymentReference',j->>'submittedReference'),'comparison',jsonb_build_object('currency','PHP','expectedAmount',40,'amountMatched',true),
 'timing',jsonb_build_object('bookingStartedAt',s,'tenantTimezone','Asia/Manila','receiptDate',to_char(s at time zone 'Asia/Manila','YYYY-MM-DD'),'receiptTime',to_char(s at time zone 'Asia/Manila','HH24:MI'),
 'receiptDateTime',date_trunc('minute',s),'withinWindow',true,'allowedWindowMinutes',10,'earlyToleranceMinutes',2),'confidence',jsonb_build_object('effective',0.99));
 return public.finish_picklestreet_balance_receipt_attempt((j->>'attemptId')::uuid,(j->>'leaseToken')::uuid,
 case when err is null then d else null end,array['auto_approval_eligible'],case when err is null then j->>'submittedReference' else null end,
 case when err is null then 0.99 else null end,err is null,err,receiver);
end;$$;
-- Only synthetic evidence is used; caller must ROLLBACK the whole transaction.
create temporary table ps_route_results(name text primary key,passed boolean);
create temporary table ps_route_other_tenants as select id,md5(to_jsonb(t)::text) as digest from public.tenants t where id<>'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';
create temporary table ps_route_other_methods as select id,md5(to_jsonb(m)::text) as digest from public.tenant_payment_methods m where tenant_id<>'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';
create temporary table ps_route_fixture_methods as select * from public.tenant_payment_methods where tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';

create function pg_temp.ps_route_snapshot(method text) returns jsonb language sql as $$
 select jsonb_build_object('method',method,'name',m.account_name,'account',m.account_reference,'destinationMethod','gcash',
  'verificationSettingsRevision',coalesce((select revision from public.picklestreet_receipt_route_settings where tenant_id=m.tenant_id),0))
 from public.tenant_payment_methods m where m.tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a' and m.method_code='gcash';
$$;
create function pg_temp.ps_route_begin(n integer,method text) returns jsonb language plpgsql as $$
declare b uuid;k uuid:=extensions.gen_random_uuid();
begin
 b:=pg_temp.ps_booking(n);
 return public.begin_picklestreet_receipt_attempt(b,'upload',k,'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a/receipts/'||b||'/'||k||'.png',
   md5(n::text)||md5((n+1)::text),method,('98'||lpad(n::text,11,'0')));
end;$$;
create function pg_temp.ps_route_data(j jsonb,secondary text default null) returns jsonb language sql as $$
 select jsonb_build_object('schemaVersion',2,'provider','google_vision','feature','DOCUMENT_TEXT_DETECTION','ocrCharacterCount',180,
  'file',jsonb_build_object('mimeType','image/png','sizeBytes',300),
  'detected',jsonb_build_object('paymentReference',j->>'submittedReference','route',jsonb_build_object(
   'schemaVersion',1,'routeId',public.picklestreet_source_provider(j->>'paymentMethod')||'_to_gcash','sourceProvider',public.picklestreet_source_provider(j->>'paymentMethod'),
   'destinationProvider','gcash','destinationMethodCode','gcash','parserVersion',case when j->>'paymentMethod'='gcash' then 'gcash_v1' else public.picklestreet_source_provider(j->>'paymentMethod')||'_to_gcash_v1' end,
   'sourceMatched',true,'destinationMatched',true,'recipientMatched',true,'referenceMatched',true,'successMatched',true,
   'secondaryReferences',case when secondary is null or j->>'paymentMethod'='gcash' then '[]'::jsonb else jsonb_build_array(jsonb_build_object('kind',case
     when public.picklestreet_source_provider(j->>'paymentMethod')='maya' then 'maya_instapay'
     when public.picklestreet_source_provider(j->>'paymentMethod')='bdopay' then 'bdopay_invoice'
     when public.picklestreet_source_provider(j->>'paymentMethod')='bpi' then 'bpi_transaction' else 'instapay' end,'value',secondary)) end)),
  'comparison',jsonb_build_object('currency','PHP','expectedAmount',(j->>'expectedAmount')::numeric,'amountMatched',true),
  'timing',jsonb_build_object('bookingStartedAt',j->>'bookingStartedAt','tenantTimezone','Asia/Manila',
   'receiptDate',to_char((j->>'bookingStartedAt')::timestamptz at time zone 'Asia/Manila','YYYY-MM-DD'),
   'receiptTime',to_char((j->>'bookingStartedAt')::timestamptz at time zone 'Asia/Manila','HH24:MI'),
   'receiptDateTime',date_trunc('minute',(j->>'bookingStartedAt')::timestamptz),'withinWindow',true,'allowedWindowMinutes',15,'earlyToleranceMinutes',2),
  'confidence',jsonb_build_object('vision',0.99,'effective',0.99,'evidence',1,'source','google_vision_plus_evidence'));
$$;
create function pg_temp.ps_route_finish(j jsonb,d jsonb,bal boolean default false,snapshot jsonb default null) returns jsonb language plpgsql as $$
begin
 if bal then return public.finish_picklestreet_balance_receipt_attempt((j->>'attemptId')::uuid,(j->>'leaseToken')::uuid,d,array['auto_approval_eligible'],
   j->>'submittedReference',0.99,true,null,coalesce(snapshot,pg_temp.ps_route_snapshot(j->>'paymentMethod')));end if;
 return public.finish_picklestreet_receipt_attempt((j->>'attemptId')::uuid,(j->>'leaseToken')::uuid,d,array['auto_approval_eligible'],
   j->>'submittedReference',0.99,true,null,coalesce(snapshot,pg_temp.ps_route_snapshot(j->>'paymentMethod')));
end;$$;

do $$
declare t constant uuid:='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';actor uuid;d jsonb;r jsonb;j jsonb;j2 jsonb;f jsonb;
 method text;n integer:=22000;denied boolean;rev timestamptz;private_rev bigint;methods jsonb;prior_methods jsonb;source_count integer;key uuid;
begin
 select user_id into actor from public.platform_profiles where is_platform_owner order by user_id limit 1;
 if actor is null then raise exception 'Fixture needs existing platform owner';end if;
 if has_table_privilege('anon','public.picklestreet_receipt_route_settings','SELECT')
   or has_table_privilege('authenticated','public.picklestreet_receipt_route_settings','SELECT')
   or has_table_privilege('service_role','public.picklestreet_receipt_route_settings','UPDATE')
   or has_function_privilege('anon','public.get_picklestreet_payment_settings(text,text)','EXECUTE')
   or has_function_privilege('authenticated','public.auto_approve_picklestreet_receipt_route(uuid)','EXECUTE') then
   raise exception 'Source route privilege leak';end if;
 insert into ps_route_results values('Private configuration and internal auto-approval permissions isolated',true);
 perform set_config('request.jwt.claim.sub',actor::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('role','service_role','sub',actor)::text,true);
 select updated_at into rev from public.tenants where id=t;
 r:=public.get_picklestreet_payment_settings('pickle-street-tugbok','picklestreet.pages.dev');
 if jsonb_typeof(r->'paymentMethods') is distinct from 'array' or jsonb_array_length(r->'paymentMethods')<1
   or jsonb_typeof(r->'venue') is distinct from 'object' or not((r->'venue') ? 'emailEnabled')
   or jsonb_typeof(r->'readiness') is distinct from 'object' then raise exception 'Manager activation DTO incomplete';end if;
 private_rev:=(r->>'receiptVerificationRevision')::bigint;
 prior_methods:=r->'paymentMethods';
 r:=public.save_picklestreet_payment_settings('pickle-street-tugbok','picklestreet.pages.dev',rev,jsonb_build_object(
   'receiptVerification',jsonb_build_object('gcashQrAlias','SYNTHETIC QR NAME','gcashQrToken','SYNTHETICQR12345'),
   'receiptVerificationRevision',private_rev));
 if(r->>'receiptVerificationRevision')::bigint<>private_rev+1 or r->'paymentMethods' is distinct from prior_methods then
   raise exception 'Private settings save changed method selection';end if;
 if public.get_public_tenant_bootstrap('pickle-street-tugbok','picklestreet.pages.dev')::text like '%SYNTHETICQR12345%'
   or public.get_public_tenant_bootstrap('pickle-street-tugbok','picklestreet.pages.dev')::text like '%gcashQrToken%' then
   raise exception 'Private receipt identities leaked in public bootstrap';end if;
 denied:=false;begin perform public.save_picklestreet_payment_settings('pickle-street-tugbok','picklestreet.pages.dev',rev,
   jsonb_build_object('receiptVerification',jsonb_build_object('gcashQrAlias','Wrong','gcashQrToken','WRONGTOKEN123'),'receiptVerificationRevision',private_rev));
 exception when sqlstate '40001' then denied:=true;end;
 if not denied then raise exception 'Stale business revision accepted';end if;
 select updated_at into rev from public.tenants where id=t;
 denied:=false;begin perform public.save_picklestreet_payment_settings('pickle-street-tugbok','picklestreet.pages.dev',rev,
   jsonb_build_object('receiptVerification',jsonb_build_object('gcashQrAlias','Wrong','gcashQrToken','WRONGTOKEN123'),'receiptVerificationRevision',private_rev));
 exception when sqlstate '40001' then denied:=true;end;
 if not denied then raise exception 'Stale private revision accepted';end if;
 denied:=false;begin perform public.get_picklestreet_payment_settings('foreign-tenant','picklestreet.pages.dev');exception when sqlstate '42501' then denied:=true;end;
 if not denied then raise exception 'Foreign tenant settings accepted';end if;
 insert into ps_route_results values('Manager settings preserve switches, enforce both revisions and stay private',true);

 -- Enable synthetic configured routes only inside the rolled-back fixtures.
 for method in select unnest(array['bdo_pay','maya','bpi','gotyme','maribank']) loop
   insert into public.tenant_payment_methods(tenant_id,method_code,display_name,account_name,account_reference,is_active,sort_order)
   select t,method,'Synthetic '||method,account_name,account_reference,true,100 from public.tenant_payment_methods where tenant_id=t and method_code='gcash'
   on conflict(tenant_id,method_code) do update set account_name=excluded.account_name,account_reference=excluded.account_reference,is_active=true;
 end loop;
 update public.tenants set public_config=public_config-'bookingApprovalMode' where id=t;
 -- Saving a shared receiving identity updates every selected source atomically.
 select jsonb_agg((value-'updatedAt')||jsonb_build_object('accountName','SYNTHETIC RECEIVING ACCOUNT','accountNumber','09170000000','qrUrl',null))
   into methods from jsonb_array_elements(public.get_picklestreet_payment_settings('pickle-street-tugbok','picklestreet.pages.dev')->'paymentMethods');
 select updated_at into rev from public.tenants where id=t;
 r:=public.save_picklestreet_payment_settings('pickle-street-tugbok','picklestreet.pages.dev',rev,jsonb_build_object('paymentMethods',methods));
 if jsonb_array_length(r->'paymentMethods')<>6 or jsonb_typeof(r->'venue') is distinct from 'object'
   or jsonb_typeof(r->'readiness') is distinct from 'object'
   or exists(select 1 from jsonb_array_elements(r->'paymentMethods') where value->>'accountName'<>'SYNTHETIC RECEIVING ACCOUNT') then
   raise exception 'Save did not return full activation DTO and shared identity';end if;
 if(select count(*) from public.tenant_payment_methods where tenant_id=t and is_active and account_name='SYNTHETIC RECEIVING ACCOUNT' and account_reference='09170000000')<>6 then
   raise exception 'Shared receiver did not update all six configured source rows';end if;
 select updated_at into rev from public.tenants where id=t;
 denied:=false;begin perform public.save_picklestreet_payment_settings('pickle-street-tugbok','picklestreet.pages.dev',rev,
   jsonb_build_object('paymentMethods',jsonb_set(methods,'{0,accountName}','"WRONG SOURCE DESTINATION"')));exception when sqlstate '22023' then denied:=true;end;
 if not denied or exists(select 1 from public.tenant_payment_methods where tenant_id=t and account_name='WRONG SOURCE DESTINATION') then
   raise exception 'Mismatched source destination changed stored settings';end if;
 insert into ps_route_results values('Shared destination saves atomically across configured source switches',true);
 for method in select unnest(array['gcash','bdo_pay','maya','bpi','gotyme','maribank']) loop
   j:=pg_temp.ps_route_begin(n,method);d:=pg_temp.ps_route_data(j,'SECONDARY'||n);
   r:=pg_temp.ps_route_finish(j,d);
   if r->>'status'<>'auto_approved' or r->>'paymentStatus'<>'paid' then raise exception 'Source route approval failed for %: %',method,r;end if;
   n:=n+2;
 end loop;
 insert into ps_route_results values('All six configured source routes confirm initial payments',true);
 update public.tenant_payment_methods set is_active=false where tenant_id=t and method_code='gcash';
 j:=pg_temp.ps_route_begin(22020,'maya');r:=pg_temp.ps_route_finish(j,pg_temp.ps_route_data(j,'INACTIVEGCASH22020'));
 if r->>'status'<>'auto_approved' then raise exception 'Inactive direct GCash option blocked configured destination';end if;
 update public.tenant_payment_methods set is_active=true where tenant_id=t and method_code='gcash';
 insert into ps_route_results values('Receiving GCash identity independent of direct GCash switch',true);

 j:=pg_temp.ps_route_begin(22022,'bpi');d:=jsonb_set(pg_temp.ps_route_data(j,'NATIVE22022'),'{confidence,vision}','null');
 r:=pg_temp.ps_route_finish(j,d);
 if r->>'status'<>'manual_review' or r->>'paymentStatus'<>'pending' then raise exception 'Missing native confidence auto-approved';end if;
 j:=pg_temp.ps_route_begin(22024,'bpi');d:=pg_temp.ps_route_data(j,'STALE22024');
 r:=pg_temp.ps_route_finish(j,d,false,jsonb_set(pg_temp.ps_route_snapshot('bpi'),'{verificationSettingsRevision}','0'));
 if r->>'status'<>'manual_review' then raise exception 'Stale destination verification settings approved';end if;
 j:=pg_temp.ps_route_begin(22026,'bpi');d:=pg_temp.ps_route_data(j,'DISABLED22026');
 update public.tenant_payment_methods set is_active=false where tenant_id=t and method_code='bpi';
 r:=pg_temp.ps_route_finish(j,d);if r->>'status'<>'manual_review' then raise exception 'Disabled source approved';end if;
 update public.tenant_payment_methods set is_active=true where tenant_id=t and method_code='bpi';
 insert into ps_route_results values('Missing confidence, stale private identity and disabled source stay pending',true);

 j:=pg_temp.ps_route_begin(22050,'bpi');d:=jsonb_set(pg_temp.ps_route_data(j,'MALFORMED22050'),'{confidence,vision}','99');
 r:=pg_temp.ps_route_finish(j,d);if r->>'status'<>'manual_review' then raise exception 'Out-of-range native confidence approved';end if;
 j:=pg_temp.ps_route_begin(22052,'bpi');d:=jsonb_set(pg_temp.ps_route_data(j,'MALFORMED22052'),'{confidence,vision}','0.95');
 r:=pg_temp.ps_route_finish(j,d);if r->>'status'<>'manual_review' then raise exception 'Invented higher effective confidence approved';end if;
 j:=pg_temp.ps_route_begin(22054,'bpi');d:=pg_temp.ps_route_data(j,null);
 r:=pg_temp.ps_route_finish(j,d);if r->>'status'<>'manual_review' then raise exception 'Missing required secondary reference approved';end if;
 j:=pg_temp.ps_route_begin(22056,'bpi');d:=jsonb_set(pg_temp.ps_route_data(j,'MALFORMED22056'),'{detected,route,parserVersion}','"unknown_v1"');
 r:=pg_temp.ps_route_finish(j,d);if r->>'status'<>'manual_review' then raise exception 'Unknown parser version approved';end if;
 insert into ps_route_results values('Malformed parser versions, inflated confidence and missing rail evidence fail closed',true);
 j:=pg_temp.ps_route_begin(22058,'bpi');d:=pg_temp.ps_route_data(j,'MISSINGQR22058');
 update public.picklestreet_receipt_route_settings set gcash_qr_alias='',gcash_qr_token='' where tenant_id=t;
 r:=pg_temp.ps_route_finish(j,d);if r->>'status'<>'manual_review' then raise exception 'Missing configured QR identity approved';end if;
 update public.picklestreet_receipt_route_settings set gcash_qr_alias='SYNTHETIC QR NAME',gcash_qr_token='SYNTHETICQR12345' where tenant_id=t;
 insert into ps_route_results values('Bank QR source routes require explicit private recipient identity',true);

 j:=pg_temp.ps_route_begin(22028,'maya');r:=pg_temp.ps_route_finish(j,pg_temp.ps_route_data(j,'CROSSRAIL22028'));
 if r->>'status'<>'auto_approved' then raise exception 'Secondary original ownership failed';end if;
 j2:=pg_temp.ps_route_begin(22030,'gotyme');r:=pg_temp.ps_route_finish(j2,pg_temp.ps_route_data(j2,'CROSSRAIL22028'));
 if r->>'status'<>'manual_review' or not(r->'flags' @> '["duplicate_payment_route_reference"]') then raise exception 'Cross-provider rail duplicate approved: %',r;end if;
 denied:=false;begin perform public.review_picklestreet_pending_receipt((j2->>'verificationId')::uuid,(j2->>'attemptId')::uuid,extensions.gen_random_uuid(),
   'approve','Synthetic staff duplicate check',actor);exception when unique_violation then denied:=sqlerrm='duplicate_payment_route_reference';end;
 if not denied or exists(select 1 from public.picklestreet_receipt_staff_reviews where verification_id=(j2->>'verificationId')::uuid) then
   raise exception 'Staff approval bypassed rail ownership or left partial audit';end if;
 insert into ps_route_results values('Cross-provider secondary duplicates block automatic and staff approval atomically',true);

 f:=pg_temp.ps2_fixture(22040);key:=extensions.gen_random_uuid();
 j:=public.begin_picklestreet_balance_receipt_attempt((f->>'b')::uuid,(f->>'q')::uuid,'upload',key,
   t::text||'/receipts/'||(f->>'b')||'/'||key||'.png',md5('bpi-balance22040')||md5('bpi-balance22041'),'bpi','9800000022040');
 r:=pg_temp.ps_route_finish(j,pg_temp.ps_route_data(j,'BPIBALANCE22040'),true);
 if r->>'status'<>'auto_approved' or r->>'balanceStatus'<>'settled' or r->>'rescheduleEventId' is null then raise exception 'BPI balance reschedule failed: %',r;end if;
 f:=pg_temp.ps2_fixture(22042);key:=extensions.gen_random_uuid();
 j:=public.begin_picklestreet_balance_receipt_attempt((f->>'b')::uuid,(f->>'q')::uuid,'upload',key,
   t::text||'/receipts/'||(f->>'b')||'/'||key||'.png',md5('maya-balance22042')||md5('maya-balance22043'),'maya','9800000022042');
 r:=pg_temp.ps_route_finish(j,pg_temp.ps_route_data(j,'CROSSRAIL22028'),true);
 if r->>'status'<>'manual_review' or r->>'balanceStatus'<>'payment_review' or r->>'bookingStatus'<>'confirmed' or r->>'paymentStatus'<>'paid' then
   raise exception 'Initial-to-balance duplicate harmed original booking: %',r;end if;
 insert into ps_route_results values('Source-route reschedule settles and cross-purpose duplicates preserve original paid booking',true);

 if exists(select 1 from public.tenants tenant_row join ps_route_other_tenants prior using(id) where md5(to_jsonb(tenant_row)::text)<>prior.digest)
   or exists(select 1 from public.tenant_payment_methods m join ps_route_other_methods prior using(id) where md5(to_jsonb(m)::text)<>prior.digest) then
   raise exception 'Another tenant changed';end if;
 insert into ps_route_results values('Other tenant settings and method rows unchanged',true);
end;$$;
select jsonb_agg(to_jsonb(ps_route_results) order by name) as checks from ps_route_results;
