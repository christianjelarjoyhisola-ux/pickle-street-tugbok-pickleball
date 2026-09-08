-- Run after group-hold-rollback-tests.sql inside the migration's ROLLBACK transaction.
-- Uses only synthetic courts/bookings and synthetic OCR evidence; no email/storage calls.
set local request.jwt.claim.role='service_role';
set local request.jwt.claims='{"role":"service_role"}';
create temporary table ps_group_payment_results(name text primary key,passed boolean not null);

create function pg_temp.ps_group_payment_fixture(n integer) returns jsonb language plpgsql as $$
declare f ps_hold_fixture%rowtype;c uuid:=extensions.gen_random_uuid();seed jsonb;cols text;
 k uuid:=extensions.gen_random_uuid();hash text;r jsonb;policy public.settings%rowtype;s timestamptz;
begin
 select * into strict f from ps_hold_fixture;
 select to_jsonb(court)||jsonb_build_object('id',c,'slug','test-group-pay-'||c::text,'name','TEST ONLY group payment court '||n::text) into seed
 from public.courts court where court.id=f.court_id;
 select string_agg(quote_ident(attname),',' order by attnum) into cols from pg_attribute
 where attrelid='public.courts'::regclass and attnum>0 and not attisdropped and attgenerated='' and attidentity='';
 execute format('insert into public.courts(%1$s) select %1$s from jsonb_populate_record(null::public.courts,$1)',cols) using seed;
 s:=f.starts_at+n*interval '1 day';hash:=encode(extensions.digest(k::text,'sha256'),'hex');
 r:=public.create_picklestreet_group_hold('picklestreet.pages.dev',k,hash,hash,jsonb_build_array(
   pg_temp.group_session(f.court_id,s),pg_temp.group_session(c,s),pg_temp.group_session(f.court_id,s+interval '3 hours')));
 select * into strict policy from public.settings where tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a' and key='refund_reschedule_policy';
 r:=public.complete_picklestreet_provisional_hold('picklestreet.pages.dev',r->>'reference',hash,
   'TEST ONLY One Group Payer','group-payment@example.invalid','09000000000',true,policy.value->>'version',
   public.refund_reschedule_policy_sha256(policy.value),1,null,null);
 return r;
end;$$;

create function pg_temp.ps_group_payment_begin(b uuid,n integer) returns jsonb language plpgsql as $$
declare k uuid:=extensions.gen_random_uuid();
begin
 return public.begin_picklestreet_receipt_attempt(b,'upload',k,
   'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a/receipts/'||b::text||'/'||k::text||'.png',
   encode(extensions.digest(k::text,'sha256'),'hex'),'gcash',(9700000000000::bigint+n)::text);
end;$$;

create function pg_temp.ps_assert_group_paid(b uuid,ref text) returns void language plpgsql as $$
begin
 if (select count(*) from public.bookings where id=b and reference=ref and status='confirmed' and payment_status='paid'
   and customer_name='TEST ONLY One Group Payer')<>1
   or (select count(*) from public.booking_slots where booking_id=b)<>3
   or (select count(distinct court_id) from public.booking_slots where booking_id=b)<>2
   or exists(select 1 from public.booking_slots where booking_id=b and(status<>'confirmed' or hold_expires_at is not null))
   or (select count(*) from public.payment_sessions where booking_id=b)<>1
   or not exists(select 1 from public.payment_sessions p join public.bookings booking on booking.id=p.booking_id
     where p.booking_id=b and p.status='paid' and p.amount=booking.total_amount)
   or (select count(*) from public.receipt_verifications where booking_id=b)<>1
 then raise exception 'Grouped payment must confirm exactly one reference/customer/payment and all three court sessions';end if;
 if exists(
   with expected as (select (s->>'courtId')::uuid court_id,g starts_at,g+interval '1 hour' ends_at
     from public.bookings booking,jsonb_array_elements(booking.metadata->'sessions') s,
     lateral generate_series((s->>'startsAt')::timestamptz,(s->>'endsAt')::timestamptz-interval '1 hour',interval '1 hour') g where booking.id=b),
   actual as (select court_id,starts_at,ends_at from public.booking_slots where booking_id=b)
   select * from ((select * from expected except all select * from actual) union all (select * from actual except all select * from expected)) difference
 ) then raise exception 'Confirmation changed the grouped court/time selections';end if;
end;$$;

do $$
declare b jsonb;j jsonb;r jsonb;actor uuid;k uuid;prior jsonb;n integer;data jsonb;receiver jsonb;
begin
 select user_id into actor from public.platform_profiles where is_platform_owner order by user_id limit 1;
 if actor is null then raise exception 'Grouped payment fixture needs existing platform owner';end if;
 -- Staff approval while held, then after expiration with all original times still free.
 for n in 1..2 loop
   b:=pg_temp.ps_group_payment_fixture(n);j:=pg_temp.ps_group_payment_begin((b->>'bookingId')::uuid,n);
   perform public.finish_picklestreet_receipt_attempt((j->>'attemptId')::uuid,(j->>'leaseToken')::uuid,p_error_code=>'verifier_unavailable');
   if n=2 then
     update public.booking_slots set hold_expires_at=now()-interval '1 minute' where booking_id=(b->>'bookingId')::uuid;
     update public.bookings set expires_at=now()-interval '1 minute' where id=(b->>'bookingId')::uuid;
     perform public.expire_stale_tenant_holds('f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a');
   end if;
   k:=extensions.gen_random_uuid();
   r:=public.review_picklestreet_pending_receipt((j->>'verificationId')::uuid,(j->>'attemptId')::uuid,k,'approve','Synthetic rollback staff payment review',actor);
   if r->>'status'<>'approved' then raise exception 'Grouped staff approval failed: %',r;end if;
   perform pg_temp.ps_assert_group_paid((b->>'bookingId')::uuid,b->>'reference');
   prior:=public.review_picklestreet_pending_receipt((j->>'verificationId')::uuid,(j->>'attemptId')::uuid,k,'approve','Synthetic rollback staff payment review',actor);
   if prior->>'idempotent'<>'true' or prior->>'reviewId'<>r->>'reviewId' then raise exception 'Grouped manual retry was not idempotent';end if;
   insert into ps_group_payment_results values(case n when 1 then 'Manual confirmation: one payer/reference/payment, all court sessions confirmed' else 'Expired grouped hold restores all free sessions atomically on manual confirmation' end,true);
 end loop;

 b:=pg_temp.ps_group_payment_fixture(3);j:=pg_temp.ps_group_payment_begin((b->>'bookingId')::uuid,3);
 data:=jsonb_build_object('schemaVersion',2,'provider','google_vision','feature','DOCUMENT_TEXT_DETECTION','ocrCharacterCount',180,
   'file',jsonb_build_object('mimeType','image/png','sizeBytes',300),
   'detected',jsonb_build_object('paymentReference',j->>'submittedReference','route',jsonb_build_object(
     'schemaVersion',1,'routeId','gcash_to_gcash','sourceProvider','gcash','destinationProvider','gcash','destinationMethodCode','gcash','parserVersion','gcash_v1',
     'sourceMatched',true,'destinationMatched',true,'recipientMatched',true,'referenceMatched',true,'successMatched',true,'secondaryReferences','[]'::jsonb)),
   'comparison',jsonb_build_object('currency','PHP','expectedAmount',(j->>'expectedAmount')::numeric,'amountMatched',true),
   'timing',jsonb_build_object('bookingStartedAt',j->>'bookingStartedAt','tenantTimezone','Asia/Manila',
     'receiptDate',to_char((j->>'bookingStartedAt')::timestamptz at time zone 'Asia/Manila','YYYY-MM-DD'),
     'receiptTime',to_char((j->>'bookingStartedAt')::timestamptz at time zone 'Asia/Manila','HH24:MI'),
     'receiptDateTime',date_trunc('minute',(j->>'bookingStartedAt')::timestamptz),'withinWindow',true,'allowedWindowMinutes',15,'earlyToleranceMinutes',2),
   'confidence',jsonb_build_object('vision',0.99,'effective',0.99,'evidence',1,'source','google_vision_plus_evidence'));
 select jsonb_build_object('method','gcash','name',m.account_name,'account',m.account_reference,'destinationMethod','gcash',
   'verificationSettingsRevision',coalesce((select revision from public.picklestreet_receipt_route_settings where tenant_id=m.tenant_id),0))
 into receiver from public.tenant_payment_methods m where m.tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a' and m.method_code='gcash' and m.is_active;
 if receiver is null then raise exception 'Grouped automatic fixture requires configured active GCash recipient';end if;
 r:=public.finish_picklestreet_receipt_attempt((j->>'attemptId')::uuid,(j->>'leaseToken')::uuid,data,array['auto_approval_eligible'],j->>'submittedReference',0.99,true,null,receiver);
 perform pg_temp.ps_assert_group_paid((b->>'bookingId')::uuid,b->>'reference');
 if not exists(select 1 from public.receipt_verifications where id=(j->>'verificationId')::uuid and status='auto_approved') then
   raise exception 'Grouped receipt was not automatically approved: %',r;end if;
 insert into ps_group_payment_results values('Automatic verification: one receipt covers aggregate total and confirms every session',true);
end;$$;
select * from ps_group_payment_results order by name;
