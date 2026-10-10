-- Synthetic bookings and payments only. Run inside a transaction ending with ROLLBACK.
set local request.jwt.claims='{"role":"service_role"}';
set local request.jwt.claim.role='service_role';
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
create function pg_temp.ps_route_snapshot(method text) returns jsonb language sql as $$
 select jsonb_build_object('method',method,'name',m.account_name,'account',m.account_reference,'destinationMethod','gcash',
  'verificationSettingsRevision',coalesce((select revision from public.picklestreet_receipt_route_settings where tenant_id=m.tenant_id),0))
 from public.tenant_payment_methods m where m.tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a' and m.method_code='gcash';
$$;
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

do $$ declare j jsonb;d jsonb;r jsonb;b uuid;k uuid;method text;source text;ref text;n integer:=33000;begin
foreach method in array array['gcash','bdo_pay','maya','bpi','gotyme','maribank'] loop
 n:=n+1;b:=pg_temp.ps_booking(n);k:=extensions.gen_random_uuid();ref:='97'||lpad(n::text,11,'0');
 j:=public.begin_picklestreet_receipt_attempt(b,'upload',k,'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a/receipts/'||b||'/'||k||'.png',md5(k::text)||md5(ref),method,case when method='maya' then ref||'88' else null end);
 -- GCash selection exercises detected BPI source. Other routes stay selected.
 source:=case when method='gcash' then 'bpi' else public.picklestreet_source_provider(method) end;
 d:=pg_temp.ps_route_data(j||jsonb_build_object('submittedReference',ref),case when source='maribank' then null else ref||'88' end);
 if method='gcash' then d:=jsonb_set(d,'{detected,route,secondaryReferences}',jsonb_build_array(jsonb_build_object('kind','bpi_transaction','value',ref||'88')));end if;
 d:=jsonb_set(d,'{detected,route,sourceProvider}',to_jsonb(source));
 d:=jsonb_set(d,'{detected,route,routeId}',to_jsonb(source||'_to_gcash'));
 d:=jsonb_set(d,'{detected,route,parserVersion}',to_jsonb(source||'_to_gcash_v1'));
 r:=public.finish_picklestreet_receipt_attempt((j->>'attemptId')::uuid,(j->>'leaseToken')::uuid,d,array['auto_approval_eligible'],ref,0.99,true,null,pg_temp.ps_route_snapshot(method));
 if r->>'verificationStatus' is distinct from 'auto_approved' and r->>'status' is distinct from 'auto_approved' then
  raise exception 'End-to-end approval failed for %: %',method,r;
 end if;
 if not exists(select 1 from public.bookings where id=b and status='confirmed' and payment_status='paid') then raise exception 'Booking was not confirmed';end if;
end loop;end $$;
select true as end_to_end_passed;
do $$ declare j jsonb;d jsonb;r jsonb;b uuid;k uuid;ref text:='97'||lpad('33001',11,'0');begin
 if not exists(select 1 from public.picklestreet_receipt_reference_claims where namespace='bpi.primary' and booking_id in(select id from bookings where reference='PS-ROLLBACK-33001')) then raise exception 'Detected BPI did not claim its reference namespace';end if;
 b:=pg_temp.ps_booking(34001);k:=extensions.gen_random_uuid();
 j:=public.begin_picklestreet_receipt_attempt(b,'upload',k,'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a/receipts/'||b||'/'||k||'.png',md5(k::text)||md5(ref),'bpi',null);
 d:=pg_temp.ps_route_data(j||jsonb_build_object('submittedReference',ref),ref||'88');
 r:=public.finish_picklestreet_receipt_attempt((j->>'attemptId')::uuid,(j->>'leaseToken')::uuid,d,array['auto_approval_eligible'],ref,0.99,true,null,pg_temp.ps_route_snapshot('bpi'));
 if r->>'status'='auto_approved' or exists(select 1 from public.bookings where id=b and payment_status='paid') then raise exception 'Duplicate reference approved';end if;
 if public.picklestreet_receipt_route_ready('bpi',jsonb_set(d,'{comparison,amountMatched}','false'::jsonb),pg_temp.ps_route_snapshot('bpi')) then raise exception 'Wrong amount eligible';end if;
end $$;
select true as duplicate_and_amount_guards_passed;
