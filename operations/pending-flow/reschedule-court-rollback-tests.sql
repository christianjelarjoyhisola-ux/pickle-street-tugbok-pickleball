-- Synthetic fixtures only. Execute after migration inside a transaction ending in ROLLBACK.
set local request.headers='{"origin":"https://picklestreetcourt.com"}';
select set_config('request.jwt.claim.sub',(select user_id::text from public.platform_profiles where is_platform_owner limit 1),true);
set local request.jwt.claim.role='authenticated';
create function pg_temp.court_fixture(p_day date,p_hour integer,p_total numeric) returns uuid language plpgsql as $$
declare t uuid:='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';b uuid:=extensions.gen_random_uuid();c uuid;s timestamptz;begin
select id into c from public.courts where tenant_id=t and name='Court 1';s:=(p_day+make_time(p_hour,0,0)) at time zone 'Asia/Manila';
insert into public.bookings(id,tenant_id,court_id,reference,customer_name,customer_phone,customer_email,status,payment_status,starts_at,ends_at,local_booking_date,subtotal_amount,service_fee_amount,total_amount,metadata)
values(b,t,c,'PB-'||upper(substr(replace(b::text,'-',''),1,12)),'Synthetic reschedule test','00000000000','test@example.invalid','confirmed','paid',s,s+interval '2 hours',p_day,p_total,0,p_total,'{"fullPaymentOnly":true}');
insert into public.booking_slots(tenant_id,booking_id,court_id,starts_at,ends_at,status) select t,b,c,g,g+interval '1 hour','confirmed' from generate_series(s,s+interval '1 hour',interval '1 hour') g;return b;end;$$;
do $$
declare t uuid:='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';b uuid;c1 uuid;c2 uuid;c3 uuid;k uuid:=extensions.gen_random_uuid();day date:=(now() at time zone 'Asia/Manila')::date+25;r jsonb;q uuid;blocked_id uuid:=extensions.gen_random_uuid();j jsonb;d jsonb;snap jsonb;ref text:='9988776655432';begin
select id into c1 from public.courts where tenant_id=t and name='Court 1';select id into c2 from public.courts where tenant_id=t and name='Court 2';select id into c3 from public.courts where tenant_id=t and name='Court 3';
b:=pg_temp.court_fixture(day,8,1000);
r:=public.preview_picklestreet_court_reschedule(b,day);
if jsonb_array_length(r->'courts')<>3 then raise exception 'All three courts must be returned';end if;
if not exists(select 1 from jsonb_array_elements(r->'options') o where o->>'courtId'=c1::text and o->>'startTime'='08:00' and o->>'unavailableReason'='current_schedule') then raise exception 'Current court/time not excluded';end if;
if not exists(select 1 from jsonb_array_elements(r->'options') o where o->>'courtId'=c2::text and o->>'startTime'='08:00' and (o->>'available')::boolean) then raise exception 'Different court at same time should be selectable';end if;
-- Reserve Court 2 independently; preview and commit must both reject it.
insert into public.court_occupancies(tenant_id,court_id,source_kind,source_id,starts_at,ends_at,status) values(t,c2,'open_play_session',extensions.gen_random_uuid(),(day+time '08:00') at time zone 'Asia/Manila',(day+time '10:00') at time zone 'Asia/Manila','confirmed');
r:=public.preview_picklestreet_court_reschedule(b,day);
if exists(select 1 from jsonb_array_elements(r->'options') o where o->>'courtId'=c2::text and o->>'startTime'='08:00' and (o->>'available')::boolean) then raise exception 'Occupied court shown available';end if;
begin
perform public.prepare_picklestreet_court_reschedule(b,day,'08:00','customer_request','Synthetic court change',null,false,k,extensions.gen_random_uuid(),repeat('a',64),now()+interval '15 minutes',c2);
raise exception 'Occupied court accepted';exception when exclusion_violation then null;end;
delete from public.court_occupancies where tenant_id=t and court_id=c2 and starts_at=(day+time '08:00') at time zone 'Asia/Manila';
insert into public.blocked_dates(id,tenant_id,court_id,blocked_on,public_label) values(blocked_id,t,c2,day,'Synthetic block');
r:=public.preview_picklestreet_court_reschedule(b,day);
if not exists(select 1 from jsonb_array_elements(r->'options') o where o->>'courtId'=c2::text and o->>'startTime'='08:00' and o->>'unavailableReason'='blocked') then raise exception 'Target court block ignored';end if;
delete from public.blocked_dates where id=blocked_id;
begin
 perform public.prepare_picklestreet_court_reschedule(b,day,'08:00','customer_request','Synthetic court change',null,false,k,extensions.gen_random_uuid(),repeat('a',64),now()+interval '15 minutes',(select id from public.courts where tenant_id<>t limit 1));
 raise exception 'Peer tenant court accepted';exception when invalid_parameter_value then null;end;
r:=public.prepare_picklestreet_court_reschedule(b,day,'08:00','customer_request','Synthetic court change',null,false,k,extensions.gen_random_uuid(),repeat('a',64),now()+interval '15 minutes',c2);
if (r->>'paymentRequired')::boolean or not exists(select 1 from public.bookings where id=b and court_id=c2 and total_amount=1000) then raise exception 'Court change failed';end if;
if exists(select 1 from public.booking_slots where booking_id=b and court_id<>c2) then raise exception 'Original court slots were not released';end if;
r:=public.prepare_picklestreet_court_reschedule(b,day,'08:00','customer_request','Synthetic court change',null,false,k,extensions.gen_random_uuid(),repeat('a',64),now()+interval '15 minutes',c2);
if r->>'idempotent'<>'true' then raise exception 'Retry not idempotent';end if;
begin
perform public.prepare_picklestreet_court_reschedule(b,day,'08:00','customer_request','Synthetic court change',null,false,k,extensions.gen_random_uuid(),repeat('a',64),now()+interval '15 minutes',c3);
raise exception 'Different court reused same key';exception when invalid_parameter_value then null;end;
-- Price increase holds target Court 3 while retaining Court 1 until receipt approval.
b:=pg_temp.court_fixture(day+1,8,1);q:=extensions.gen_random_uuid();k:=extensions.gen_random_uuid();
r:=public.prepare_picklestreet_court_reschedule(b,day+1,'18:00','customer_request','Synthetic paid court change',null,false,k,q,repeat('b',64),now()+interval '15 minutes',c3);
if r->>'paymentRequired'<>'true' or not exists(select 1 from public.bookings where id=b and court_id=c1 and total_amount=1) then raise exception 'Original booking changed before payment';end if;
if not exists(select 1 from public.booking_slots where booking_id=b and balance_request_id=q and court_id=c3 and status='held') then raise exception 'New court not held';end if;
perform set_config('request.jwt.claim.role','service_role',true);perform set_config('request.jwt.claims','{"role":"service_role"}',true);
k:=extensions.gen_random_uuid();j:=public.begin_picklestreet_balance_receipt_attempt(b,q,'upload',k,t||'/receipts/'||b||'/'||k||'.png',md5(k::text)||md5(q::text),'gcash',ref,null);
d:=jsonb_build_object('schemaVersion',2,'provider','google_vision','feature','DOCUMENT_TEXT_DETECTION','ocrCharacterCount',180,'file',jsonb_build_object('mimeType','image/png','sizeBytes',300),'detected',jsonb_build_object('paymentReference',ref,'route',jsonb_build_object('schemaVersion',1,'routeId','gcash_to_gcash','sourceProvider','gcash','destinationProvider','gcash','destinationMethodCode','gcash','parserVersion','gcash_v1','sourceMatched',true,'destinationMatched',true,'recipientMatched',true,'referenceMatched',true,'successMatched',true,'secondaryReferences','[]'::jsonb)),
'comparison',jsonb_build_object('currency','PHP','expectedAmount',(j->>'expectedAmount')::numeric,'amountMatched',true),'timing',jsonb_build_object('bookingStartedAt',j->>'bookingStartedAt','tenantTimezone','Asia/Manila','receiptDate',to_char((j->>'bookingStartedAt')::timestamptz at time zone 'Asia/Manila','YYYY-MM-DD'),'receiptTime',to_char((j->>'bookingStartedAt')::timestamptz at time zone 'Asia/Manila','HH24:MI'),'receiptDateTime',date_trunc('minute',(j->>'bookingStartedAt')::timestamptz),'withinWindow',true,'allowedWindowMinutes',15,'earlyToleranceMinutes',2),'confidence',jsonb_build_object('vision',0.99,'effective',0.99,'evidence',1,'source','google_vision_plus_evidence'));
select jsonb_build_object('method','gcash','name',m.account_name,'account',m.account_reference,'destinationMethod','gcash','verificationSettingsRevision',s.revision) into snap from public.tenant_payment_methods m join public.picklestreet_receipt_route_settings s using(tenant_id) where m.tenant_id=t and m.method_code='gcash';
r:=public.finish_picklestreet_balance_receipt_attempt((j->>'attemptId')::uuid,(j->>'leaseToken')::uuid,d,array['auto_approval_eligible'],ref,.99,true,null,snap);
if not exists(select 1 from public.bookings where id=b and court_id=c3 and status='confirmed' and payment_status='paid' and total_amount>1) then raise exception 'Paid court change failed: %',r;end if;
if exists(select 1 from public.booking_slots where booking_id=b and court_id<>c3 and status in('held','confirmed')) then raise exception 'Old court still reserved after payment';end if;
end $$;
set constraints all immediate;
select true as court_selection_passed;
