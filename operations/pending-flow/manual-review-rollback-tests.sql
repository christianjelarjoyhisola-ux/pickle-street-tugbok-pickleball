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

create temporary table ps_manual_results(name text primary key,passed boolean);
create function pg_temp.ps_manual_isolated_court() returns uuid language plpgsql as $$
declare c uuid:=extensions.gen_random_uuid();seed jsonb;columns_sql text;
begin
 select to_jsonb(court)||jsonb_build_object('id',c,'slug','rollback-review-'||c::text,'name','Rollback review court '||c::text)
   into seed from public.courts court where tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a' and status='active' order by id limit 1;
 select string_agg(quote_ident(attname),',' order by attnum) into columns_sql from pg_attribute
   where attrelid='public.courts'::regclass and attnum>0 and not attisdropped and attgenerated='' and attidentity='';
 execute format('insert into public.courts(%1$s) select %1$s from jsonb_populate_record(null::public.courts,$1)',columns_sql) using seed;
 return c;
end;$$;
-- Reproduce a historical short-payment booking created before pending-flow 001.
-- A fixture-only in-progress audit grants a scoped marker for the accepted first
-- payment. All transitions use live triggers. The fixture audit then closes.
create function pg_temp.ps_manual_short_fixture(n integer) returns jsonb language plpgsql as $$
declare t constant uuid:='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';b uuid;q uuid:=extensions.gen_random_uuid();
 s uuid;r uuid;actor uuid;initial_job jsonb;fixture_review public.picklestreet_receipt_staff_reviews%rowtype;
begin
 b:=pg_temp.ps_booking(n);
 select user_id into actor from public.platform_profiles where is_platform_owner order by user_id limit 1;
 initial_job:=pg_temp.ps_manual_begin(b,n);
 r:=(initial_job->>'verificationId')::uuid;
 select payment_session_id into s from public.receipt_verifications where id=r and tenant_id=t;
 insert into public.picklestreet_receipt_staff_reviews(tenant_id,booking_id,verification_id,payment_session_id,expected_attempt_id,idempotency_key,
   decision,review_note,actor_user_id,before_state)
 values(t,b,r,s,(initial_job->>'attemptId')::uuid,extensions.gen_random_uuid(),'approve','Rollback fixture: historical accepted first payment',actor,'{"syntheticLegacyFixture":true}')
 returning * into fixture_review;
 perform set_config('app.picklestreet_staff_review',fixture_review.authorization_token::text,true);
 update public.payment_sessions set status='paid',amount=175 where tenant_id=t and id=s;
 update public.receipt_verifications set status='short_payment',reviewed_by=actor,reviewed_at=now() where tenant_id=t and id=r;
 update public.bookings set status='payment_review',payment_status='partial',expires_at=now()+interval '5 minutes' where id=b;
 update public.picklestreet_receipt_jobs set lease_token=null,lease_until=null where tenant_id=t and booking_id=b;
 update public.picklestreet_receipt_staff_reviews set completed_at=clock_timestamp(),result='{"syntheticLegacyFixture":true,"status":"short_payment"}' where id=fixture_review.id;
 perform set_config('app.picklestreet_staff_review','',true);
 if not exists(select 1 from public.receipt_verifications receipt join public.bookings booking on booking.tenant_id=receipt.tenant_id and booking.id=receipt.booking_id
   join public.payment_sessions payment on payment.tenant_id=receipt.tenant_id and payment.id=receipt.payment_session_id and payment.booking_id=booking.id
   where receipt.id=r and receipt.tenant_id=t and receipt.status='short_payment' and receipt.expected_amount=215
     and payment.id=s and payment.status='paid' and payment.amount=175 and receipt.reviewed_by=actor) then raise exception 'Legacy fixture references invalid';end if;
 insert into public.booking_balance_requests(id,tenant_id,booking_id,issued_by,original_verification_id,accepted_amount,remaining_amount,currency,status,deadline_at,token_hash,request_type,request_details)
 values(q,t,b,actor,r,175,40,'PHP','awaiting_payment',now()+interval '5 minutes',repeat('c',64),'short_payment','{}');
 update public.bookings set expires_at=now()+interval '5 minutes' where id=b;
 update public.booking_slots set hold_expires_at=now()+interval '5 minutes' where booking_id=b;
 return jsonb_build_object('b',b,'q',q,'originalPaymentId',s,'originalVerificationId',r);
end;$$;
create function pg_temp.ps_manual_begin(b uuid,n integer,finish boolean default true) returns jsonb language plpgsql as $$
declare k uuid:=extensions.gen_random_uuid();j jsonb;x jsonb;
begin
 j:=public.begin_picklestreet_receipt_attempt(b,'upload',k,'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a/receipts/'||b::text||'/'||k::text||'.png',
   md5(n::text)||md5((n+1)::text),'gcash',(9000000000000::bigint+n)::text);
 if finish then x:=public.finish_picklestreet_receipt_attempt((j->>'attemptId')::uuid,(j->>'leaseToken')::uuid,p_error_code=>'verifier_unavailable');end if;
 return j;
end;$$;
create function pg_temp.ps_manual_call(j jsonb,decision text default 'approve',k uuid default extensions.gen_random_uuid(),note text default 'Staff verified payment with receiving account')
returns jsonb language sql as $$
 select public.review_picklestreet_pending_receipt((j->>'verificationId')::uuid,(j->>'attemptId')::uuid,k,decision,note,
   (select user_id from public.platform_profiles where is_platform_owner order by user_id limit 1));
$$;
do $$
declare t constant uuid:='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';b uuid;b2 uuid;j jsonb;j2 jsonb;r jsonb;prior jsonb;
 f jsonb;f2 jsonb;k uuid;actor uuid;denied boolean;start_time timestamptz;old_receipt uuid;isolated_court uuid;
begin
 select user_id into actor from public.platform_profiles where is_platform_owner order by user_id limit 1;
 if actor is null then raise exception 'Fixture needs existing platform owner';end if;
 if has_function_privilege('authenticated','public.review_picklestreet_pending_receipt(uuid,uuid,uuid,text,text,uuid)','EXECUTE')
   or has_function_privilege('anon','public.review_picklestreet_pending_receipt(uuid,uuid,uuid,text,text,uuid)','EXECUTE')
   or has_table_privilege('service_role','public.picklestreet_receipt_staff_reviews','INSERT')
   or has_table_privilege('service_role','public.picklestreet_receipt_staff_reviews','UPDATE') then raise exception 'Review authority leaked';end if;
 insert into ps_manual_results values('Service-only RPC and protected audit writer',true);

 b:=pg_temp.ps_booking(1500);j:=pg_temp.ps_manual_begin(b,1500);k:=extensions.gen_random_uuid();
 denied:=false;begin update public.receipt_verifications set status='approved' where id=(j->>'verificationId')::uuid;exception when sqlstate '22023' then denied:=true;end;
 if not denied then raise exception 'Old/direct approve bypassed review';end if;
 denied:=false;begin update public.receipt_verifications set status='rejected' where id=(j->>'verificationId')::uuid;exception when sqlstate '22023' then denied:=true;end;
 if not denied then raise exception 'Old/direct reject bypassed review';end if;
 perform set_config('app.picklestreet_staff_review',extensions.gen_random_uuid()::text,true);
 denied:=false;begin update public.bookings set status='confirmed',payment_status='paid' where id=b;exception when sqlstate '42501' then denied:=true;end;
 if not denied then raise exception 'Forged marker bypassed review';end if;
 perform set_config('app.picklestreet_staff_review','',true);
 insert into ps_manual_results values('Old paths and fabricated transaction marker denied',true);
 denied:=false;begin perform public.review_picklestreet_pending_receipt((j->>'verificationId')::uuid,(j->>'attemptId')::uuid,k,'approve','Payment checked',extensions.gen_random_uuid());exception when sqlstate '42501' then denied:=true;end;
 if not denied then raise exception 'Unrelated actor accepted';end if;
 denied:=false;begin perform public.review_picklestreet_pending_receipt(extensions.gen_random_uuid(),(j->>'attemptId')::uuid,k,'approve','Payment checked',actor);exception when sqlstate '22023' then denied:=true;end;
 if not denied then raise exception 'Unknown/foreign receipt accepted';end if;
 perform set_config('request.jwt.claim.role','authenticated',true);perform set_config('request.jwt.claims','{"role":"authenticated"}',true);
 denied:=false;begin perform pg_temp.ps_manual_call(j);exception when sqlstate '42501' then denied:=true;end;
 if not denied then raise exception 'Unprivileged RPC accepted';end if;
 perform set_config('request.jwt.claim.role','service_role',true);perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 insert into ps_manual_results values('Actor, tenant lookup and service role enforced',true);
 r:=pg_temp.ps_manual_call(j,'approve',k);
 if r->>'status'<>'approved' or r->>'bookingStatus'<>'confirmed' or r->>'paymentStatus'<>'paid'
   or not exists(select 1 from public.receipt_verifications where id=(j->>'verificationId')::uuid and reviewed_by=actor and flags @> array['verifier_unavailable'])
   or exists(select 1 from public.booking_slots where booking_id=b and (status<>'confirmed' or hold_expires_at is not null)) then
   raise exception 'Manual approval did not record staff decision distinctly: %',r;end if;
 prior:=pg_temp.ps_manual_call(j,'approve',k);
 if prior->>'idempotent'<>'true' or prior->>'reviewId'<>r->>'reviewId' then raise exception 'Idempotency failed';end if;
 denied:=false;begin perform pg_temp.ps_manual_call(j,'reject',k,'Reject changed payload');exception when sqlstate '22023' then denied:=true;end;
 if not denied then raise exception 'Conflicting idempotency payload accepted';end if;
 denied:=false;begin update public.picklestreet_receipt_staff_reviews set review_note='Tampered' where verification_id=(j->>'verificationId')::uuid;exception when sqlstate '42501' then denied:=true;end;
 if not denied then raise exception 'Audit mutable';end if;
 denied:=false;begin update public.receipt_verifications set status='manual_review' where id=(j->>'verificationId')::uuid;exception when sqlstate '22023' then denied:=true;end;
 if not denied then raise exception 'Final decision reversible';end if;
 insert into ps_manual_results values('Staff confirmation, final audit immutability and idempotency',true);

 b:=pg_temp.ps_booking(1502);j:=pg_temp.ps_manual_begin(b,1502,false);r:=pg_temp.ps_manual_call(j);
 prior:=public.finish_picklestreet_receipt_attempt((j->>'attemptId')::uuid,(j->>'leaseToken')::uuid,p_error_code=>'verifier_unavailable');
 if prior->>'stale'<>'true' or(select status from public.receipt_verifications where id=(j->>'verificationId')::uuid)<>'approved' then raise exception 'Late OCR overrode staff decision';end if;
 insert into ps_manual_results values('Late OCR fenced after explicit approval',true);

 b:=pg_temp.ps_booking(1504);j:=pg_temp.ps_manual_begin(b,1504);r:=pg_temp.ps_manual_call(j,'reject',extensions.gen_random_uuid(),'Receiving account has no matching payment');
 if r->>'status'<>'rejected' or r->>'bookingStatus'<>'cancelled' or r->>'paymentStatus'<>'rejected'
   or exists(select 1 from public.booking_slots where booking_id=b and status in('held','confirmed'))
   or(select status from public.payment_sessions where booking_id=b and provider='manual_receipt')<>'failed' then raise exception 'Initial rejection wrong: %',r;end if;
 insert into ps_manual_results values('Initial rejection records reason and releases reservation',true);

 b:=pg_temp.ps_booking(1506);j:=pg_temp.ps_manual_begin(b,1506);
 update public.bookings set expires_at=now()-interval '1 second' where id=b;
 update public.booking_slots set status='expired',hold_expires_at=now()-interval '1 second' where booking_id=b;
 update public.bookings set status='expired' where id=b;
 r:=pg_temp.ps_manual_call(j);
 if r->>'bookingStatus'<>'confirmed' or r->>'reservationRestored'<>'true' then raise exception 'Available expired hold not restored';end if;
 insert into ps_manual_results values('Expired original reservation safely reclaimed',true);

 b:=pg_temp.ps_booking(1508);j:=pg_temp.ps_manual_begin(b,1508);
 update public.booking_slots set status='expired',hold_expires_at=now()-interval '1 second' where booking_id=b;
 update public.bookings set status='expired',expires_at=now()-interval '1 second' where id=b;
 b2:=pg_temp.ps_booking(1510);
 update public.booking_slots set starts_at=(select starts_at from public.bookings where id=b),ends_at=(select ends_at from public.bookings where id=b),status='confirmed',hold_expires_at=null where booking_id=b2;
 denied:=false;begin perform pg_temp.ps_manual_call(j);exception when sqlstate '22023' then denied:=sqlerrm='reservation_time_unavailable';end;
 if not denied or exists(select 1 from public.picklestreet_receipt_staff_reviews where booking_id=b)
   or(select payment_status from public.bookings where id=b)<>'pending' then raise exception 'Unavailable original court changed payment';end if;
 insert into ps_manual_results values('Occupied original court rolls back confirmation without partial payment',true);

 b:=pg_temp.ps_booking(1512);j:=pg_temp.ps_manual_begin(b,1512);
 update public.picklestreet_receipt_attempts set created_at=now()-interval '1 minute' where booking_id=b;
 j2:=pg_temp.ps_manual_begin(b,1513);
 denied:=false;begin perform pg_temp.ps_manual_call(j);exception when sqlstate '22023' then denied:=sqlerrm='RECEIPT_CHANGED';end;
 if not denied then raise exception 'Stale displayed receipt version accepted';end if;
 insert into ps_manual_results values('Replacement upload invalidates stale displayed approval',true);

 f:=pg_temp.ps2_fixture(1500);j:=pg_temp.ps2_begin(f,md5('balance-manual-1')||md5('balance-manual-2'),'9811111111111');
 r:=pg_temp.ps2_finish(j,'verifier_unavailable');
 select starts_at into start_time from public.bookings where id=(f->>'b')::uuid;
 update public.picklestreet_balance_receipt_jobs set hold_deadline_at=now()-interval '1 minute' where balance_request_id=(f->>'q')::uuid;
 perform public.expire_picklestreet_balance_receipt_holds((f->>'b')::uuid);
 r:=pg_temp.ps_manual_call(j);
 if r->>'status'<>'approved' or r->>'balanceStatus'<>'settled' or r->>'rescheduleEventId' is null
   or(select starts_at from public.bookings where id=(f->>'b')::uuid)<>start_time+interval '2 hours'
   or exists(select 1 from public.booking_slots where booking_id=(f->>'b')::uuid and(status<>'confirmed' or balance_request_id is not null)) then
   raise exception 'Manual balance settlement not atomic: %',r;end if;
 insert into ps_manual_results values('Expired reschedule adjustment confirmed atomically with staff audit',true);

 f:=pg_temp.ps2_fixture(1502);j:=pg_temp.ps2_begin(f,md5('balance-reject-1')||md5('balance-reject-2'),'9822222222222');
 select to_jsonb(bookings) into prior from public.bookings where id=(f->>'b')::uuid;
 r:=pg_temp.ps_manual_call(j,'reject',extensions.gen_random_uuid(),'Additional transfer not received');
 if r->>'status'<>'rejected' or r->>'balanceStatus'<>'cancelled' or r->>'bookingStatus'<>'confirmed' or r->>'paymentStatus'<>'paid'
   or(select to_jsonb(bookings) from public.bookings where id=(f->>'b')::uuid)<>prior
   or not exists(select 1 from public.booking_slots where booking_id=(f->>'b')::uuid and balance_request_id is null and status='confirmed')
   or exists(select 1 from public.booking_slots where booking_id=(f->>'b')::uuid and balance_request_id=(f->>'q')::uuid and status in('held','confirmed')) then
   raise exception 'Rejected adjustment damaged original booking: %',r;end if;
 r:=pg_temp.ps2_finish(j,'verifier_unavailable');
 if r->>'status'<>'rejected' or r->>'balanceStatus'<>'cancelled' then raise exception 'Late OCR reopened rejected adjustment';end if;
 update public.booking_balance_requests set deadline_at=deadline_at where id=(f->>'q')::uuid;
 update public.payment_sessions set provider_payload=provider_payload||jsonb_build_object('rollbackMetadataCheck',true)
   where id=(select payment_session_id from public.receipt_verifications where id=(j->>'verificationId')::uuid);
 if(select status from public.booking_balance_requests where id=(f->>'q')::uuid)<>'cancelled'
   or(select status from public.payment_sessions where id=(select payment_session_id from public.receipt_verifications where id=(j->>'verificationId')::uuid))<>'failed' then
   raise exception 'Metadata update reopened rejected balance/payment';end if;
 update public.bookings set status='completed' where id=(f->>'b')::uuid;
 insert into ps_manual_results values('Reschedule rejection closes only adjustment and fences late OCR',true);

 f:=pg_temp.ps2_fixture(1504);j:=pg_temp.ps2_begin(f,md5('balance-conflict-1')||md5('balance-conflict-2'),'9833333333333');r:=pg_temp.ps2_finish(j,'verifier_unavailable');
 update public.picklestreet_balance_receipt_jobs set hold_deadline_at=now()-interval '1 minute' where balance_request_id=(f->>'q')::uuid;
 perform public.expire_picklestreet_balance_receipt_holds((f->>'b')::uuid);
 f2:=pg_temp.ps2_fixture(1506);
 update public.booking_slots set starts_at=(select starts_at from public.bookings where id=(f->>'b')::uuid)+interval '2 hours',
   ends_at=(select ends_at from public.bookings where id=(f->>'b')::uuid)+interval '2 hours' where booking_id=(f2->>'b')::uuid and balance_request_id is null;
 denied:=false;begin perform pg_temp.ps_manual_call(j);exception when sqlstate '22023' then denied:=sqlerrm='reservation_time_unavailable';end;
 if not denied or not exists(select 1 from public.booking_slots where booking_id=(f->>'b')::uuid and balance_request_id is null and status='confirmed')
   or(select status from public.receipt_verifications where id=(j->>'verificationId')::uuid)<>'manual_review' then raise exception 'Conflicting adjustment harmed original';end if;
 insert into ps_manual_results values('Occupied proposed time keeps original booking and pending proof',true);

 f:=pg_temp.ps2_fixture(1508);j:=pg_temp.ps2_begin(f,md5('completed-reject-1')||md5('completed-reject-2'),'9844444444444');r:=pg_temp.ps2_finish(j,'verifier_unavailable');
 update public.bookings set status='completed' where id=(f->>'b')::uuid;
 denied:=false;begin perform pg_temp.ps_manual_call(j);exception when sqlstate '22023' then denied:=sqlerrm='original_booking_changed';end;
 if not denied then raise exception 'Completed original booking moved';end if;
 r:=pg_temp.ps_manual_call(j,'reject',extensions.gen_random_uuid(),'Unused additional payment proof rejected');
 if r->>'bookingStatus'<>'completed' or r->>'paymentStatus'<>'paid' or r->>'balanceStatus'<>'cancelled' then raise exception 'Completed original booking rejected';end if;
 insert into ps_manual_results values('Completed paid booking cannot move and survives adjustment rejection',true);

 f:=pg_temp.ps_manual_short_fixture(1600);j:=pg_temp.ps2_begin(f,md5('short-confirm-1')||md5('short-confirm-2'),'9855555555555');r:=pg_temp.ps2_finish(j,'verifier_unavailable');
 update public.picklestreet_balance_receipt_jobs set hold_deadline_at=now()-interval '1 minute' where balance_request_id=(f->>'q')::uuid;
 perform public.expire_picklestreet_balance_receipt_holds((f->>'b')::uuid);
 r:=pg_temp.ps_manual_call(j);
 if r->>'status'<>'approved' or r->>'balanceStatus'<>'settled' or r->>'bookingStatus'<>'confirmed' or r->>'paymentStatus'<>'paid'
   or not exists(select 1 from public.payment_sessions where id=(f->>'originalPaymentId')::uuid and status='paid' and amount=175)
   or not exists(select 1 from public.receipt_verifications where id=(f->>'originalVerificationId')::uuid and status='short_payment') then raise exception 'Short payment settlement wrong: %',r;end if;
 insert into ps_manual_results values('Expired short-payment balance confirms while preserving accepted first payment',true);
 f:=pg_temp.ps_manual_short_fixture(1602);j:=pg_temp.ps2_begin(f,md5('short-reject-1')||md5('short-reject-2'),'9866666666666');r:=pg_temp.ps2_finish(j,'verifier_unavailable');
 r:=pg_temp.ps_manual_call(j,'reject',extensions.gen_random_uuid(),'Remaining payment not received');
 if r->>'status'<>'rejected' or r->>'balanceStatus'<>'cancelled' or r->>'bookingStatus'<>'expired'
   or r->>'paymentStatus' not in('pending','partial')
   or exists(select 1 from public.booking_slots where booking_id=(f->>'b')::uuid and status in('held','confirmed'))
   or not exists(select 1 from public.payment_sessions where id=(f->>'originalPaymentId')::uuid and status='paid' and amount=175)
   or not exists(select 1 from public.receipt_verifications where id=(f->>'originalVerificationId')::uuid and status='short_payment') then raise exception 'Short payment rejection reversed accepted funds: %',r;end if;
 insert into ps_manual_results values('Short-payment rejection releases reservation and preserves accepted first payment',true);
 b:=pg_temp.ps_booking(1610);j:=pg_temp.ps_manual_begin(b,1610,false);
 r:=public.finish_picklestreet_receipt_attempt((j->>'attemptId')::uuid,(j->>'leaseToken')::uuid,
   pg_temp.ps_data(b,j->>'submittedReference'),array['auto_approval_eligible'],j->>'submittedReference',0.99,true,null,pg_temp.ps_receiver());
 if r->>'status'<>'auto_approved' or r->>'bookingStatus'<>'confirmed' or r->>'paymentStatus'<>'paid'
   or exists(select 1 from public.picklestreet_receipt_staff_reviews where booking_id=b) then raise exception 'Initial automatic path changed: %',r;end if;
 f:=pg_temp.ps2_fixture(1612);j:=pg_temp.ps2_begin(f,md5('auto-balance-1')||md5('auto-balance-2'),'9877777777777');r:=pg_temp.ps2_finish(j);
 if r->>'status'<>'auto_approved' or r->>'balanceStatus'<>'settled' or r->>'bookingStatus'<>'confirmed' or r->>'paymentStatus'<>'paid'
   or exists(select 1 from public.picklestreet_receipt_staff_reviews where booking_id=(f->>'b')::uuid) then raise exception 'Balance automatic path changed: %',r;end if;
 insert into ps_manual_results values('Initial and balance automatic approvals continue with automatic status',true);
 isolated_court:=pg_temp.ps_manual_isolated_court();
 b:=pg_temp.ps_booking(1620);j:=pg_temp.ps_manual_begin(b,1620);
 update public.bookings set court_id=isolated_court,starts_at=now()-interval '5 minutes',ends_at=now()+interval '55 minutes',
   local_booking_date=(now() at time zone 'Asia/Manila')::date,expires_at=now()+interval '15 minutes' where id=b;
 update public.booking_slots set court_id=isolated_court,starts_at=now()-interval '5 minutes',ends_at=now()+interval '55 minutes',hold_expires_at=now()+interval '15 minutes' where booking_id=b;
 denied:=false;begin perform pg_temp.ps_manual_call(j);exception when sqlstate '22023' then denied:=sqlerrm='booking_started';end;
 if not denied or(select payment_status from public.bookings where id=b)<>'pending'
   or exists(select 1 from public.picklestreet_receipt_staff_reviews where booking_id=b) then raise exception 'Underway booking confirmed contrary to shared policy';end if;
 insert into ps_manual_results values('Underway initial confirmation respects shared before-play policy',true);
 isolated_court:=pg_temp.ps_manual_isolated_court();
 b:=pg_temp.ps_booking(1622);j:=pg_temp.ps_manual_begin(b,1622);
 update public.bookings set court_id=isolated_court,starts_at=now()-interval '5 minutes',ends_at=now()+interval '55 minutes',
   local_booking_date=(now() at time zone 'Asia/Manila')::date,status='expired',expires_at=now()-interval '1 minute' where id=b;
 update public.booking_slots set court_id=isolated_court,starts_at=now()-interval '5 minutes',ends_at=now()+interval '55 minutes',status='expired',hold_expires_at=now()-interval '1 minute' where booking_id=b;
 denied:=false;begin perform pg_temp.ps_manual_call(j);exception when sqlstate '22023' then denied:=sqlerrm='booking_started';end;
 if not denied or(select payment_status from public.bookings where id=b)<>'pending'
   or exists(select 1 from public.picklestreet_receipt_staff_reviews where booking_id=b) then raise exception 'Released underway booking restored';end if;
 insert into ps_manual_results values('Released underway initial booking remains pending',true);
end;$$;
select jsonb_agg(to_jsonb(ps_manual_results) order by name) as checks from ps_manual_results;
