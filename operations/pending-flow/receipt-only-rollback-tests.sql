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
   'receiptDateTime',date_trunc('minute',(j->>'bookingStartedAt')::timestamptz),'withinWindow',true,'allowedWindowMinutes',10,'earlyToleranceMinutes',2),
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
declare b uuid;j jsonb;d jsonb;r jsonb;k uuid:=extensions.gen_random_uuid();ref text:='9876543201234';duplicate_job jsonb;
begin
 b:=pg_temp.ps_booking(44001);
 j:=public.begin_picklestreet_receipt_attempt(b,'upload',k,'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a/receipts/'||b||'/'||k||'.png',repeat('a',64),'gcash',null);
 if j->>'submittedReference' is not null then raise exception 'Unexpected manual reference';end if;
 d:=pg_temp.ps_route_data(j||jsonb_build_object('submittedReference',ref));
 r:=public.finish_picklestreet_receipt_attempt((j->>'attemptId')::uuid,(j->>'leaseToken')::uuid,d,array['auto_approval_eligible'],ref,0.99,true,null,pg_temp.ps_route_snapshot('gcash'));
 if r->>'bookingStatus' is distinct from 'confirmed' then raise exception 'Receipt-only approval failed %',r;end if;
 insert into ps_route_results values('No typed reference: matching receipt confirms booking',true);
 b:=pg_temp.ps_booking(44002);k:=extensions.gen_random_uuid();
 j:=public.begin_picklestreet_receipt_attempt(b,'upload',k,'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a/receipts/'||b||'/'||k||'.png',repeat('b',64),'gcash',null);
 d:=pg_temp.ps_route_data(j||jsonb_build_object('submittedReference',ref));
 r:=public.finish_picklestreet_receipt_attempt((j->>'attemptId')::uuid,(j->>'leaseToken')::uuid,d,array['auto_approval_eligible'],ref,0.99,true,null,pg_temp.ps_route_snapshot('gcash'));
 r:=public.reject_picklestreet_duplicate((j->>'attemptId')::uuid);
 if r->>'rejected' is distinct from 'true' then raise exception 'Duplicate not rejected %',r;end if;
 insert into ps_route_results values('OCR duplicate reference rejects entire booking without typed entry',true);
 b:=pg_temp.ps_booking(44003);k:=extensions.gen_random_uuid();
 j:=public.begin_picklestreet_receipt_attempt(b,'upload',k,'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a/receipts/'||b||'/'||k||'.png',repeat('c',64),'gcash',null);
 r:=public.finish_picklestreet_receipt_attempt((j->>'attemptId')::uuid,(j->>'leaseToken')::uuid,pg_temp.ps_route_data(j),array['payment_reference_unverified'],null,0.99,false,null,pg_temp.ps_route_snapshot('gcash'));
 if r->>'bookingStatus'='confirmed' then raise exception 'Unreadable receipt autoapproved';end if;
 insert into ps_route_results values('Unreadable reference saved for review',true);
end;$$;
select * from ps_route_results;

do $$
declare f jsonb;j jsonb;d jsonb;r jsonb;ref text:='9876543299999';
begin
 f:=pg_temp.ps2_fixture(44501);
 j:=pg_temp.ps2_begin(f,repeat('d',64),null);
 d:=pg_temp.ps_route_data(j||jsonb_build_object('submittedReference',ref));
 r:=public.finish_picklestreet_balance_receipt_attempt((j->>'attemptId')::uuid,(j->>'leaseToken')::uuid,d,array['auto_approval_eligible'],ref,0.99,true,null,pg_temp.ps_route_snapshot('gcash'));
 if r->>'balanceStatus' is distinct from 'settled' then raise exception 'Receipt-only balance did not settle %',r;end if;
 insert into ps_route_results values('Additional-payment receipt confirms without typed reference',true);
end;$$;
