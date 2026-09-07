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
do $$
declare t constant uuid:='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';b uuid; b2 uuid;b3 uuid;b4 uuid; key uuid; job jsonb;job2 jsonb;result jsonb;prior_deadline timestamptz;receipt_id uuid;blocked boolean;
begin
 if auth.role()<>'service_role' then raise exception 'Service claim unavailable for rollback tests';end if;
 b:=pg_temp.ps_booking(6);key:=extensions.gen_random_uuid();
 select expires_at into prior_deadline from public.bookings where id=b;
 job:=public.begin_picklestreet_receipt_attempt(b,'upload',key,t::text||'/receipts/'||b::text||'/'||key::text||'.png',repeat('a',64),'gcash','1234567890123');
 if job->>'claimed'<>'true' then raise exception 'Initial claim failed';end if;
 receipt_id:=(job->>'verificationId')::uuid;
 if not exists(select 1 from public.bookings where id=b and status='payment_review' and payment_status='pending' and expires_at=prior_deadline) then raise exception 'Pending state or deadline incorrect';end if;
 result:=public.finish_picklestreet_receipt_attempt((job->>'attemptId')::uuid,(job->>'leaseToken')::uuid,p_error_code=>'vision_timeout');
 if result->>'status'<>'manual_review' or result->>'paymentStatus'<>'pending' then raise exception 'OCR error did not remain pending';end if;
 insert into ps_test_results values('OCR error persists pending proof without extending court hold',true);
 blocked:=false;begin update public.receipt_verifications set status='rejected' where id=receipt_id;exception when sqlstate '22023' then blocked:=true;end;
 if not blocked then raise exception 'Receipt rejection was allowed';end if;
 blocked:=false;begin update public.bookings set status='cancelled' where id=b;exception when sqlstate '22023' then blocked:=true;end;
 if not blocked then raise exception 'Pending booking cancellation was allowed';end if;
 blocked:=false;begin update public.receipt_verifications set status='approved' where id=receipt_id;exception when sqlstate '22023' then blocked:=true;end;
 if not blocked then raise exception 'Manual receipt approval was allowed';end if;
 insert into ps_test_results values('Rejected, cancelled and manual approval transitions blocked',true);
 result:=public.begin_picklestreet_receipt_attempt(b,'upload',key,t::text||'/receipts/'||b::text||'/'||key::text||'.png',repeat('a',64),'gcash','1234567890123');
 if result->>'idempotent'<>'true' then raise exception 'Idempotent recovery failed';end if;
 blocked:=false;begin perform public.begin_picklestreet_receipt_attempt(b,'retry',extensions.gen_random_uuid());exception when sqlstate '22023' then blocked:=true;end;
 if not blocked then raise exception 'Retry cooldown was not enforced';end if;
 insert into ps_test_results values('Idempotent upload recovery and retry rate limit',true);
 update public.picklestreet_receipt_attempts set created_at=now()-interval '1 minute' where booking_id=b;
 key:=extensions.gen_random_uuid();job2:=public.begin_picklestreet_receipt_attempt(b,'upload',key,t::text||'/receipts/'||b::text||'/'||key::text||'.png',repeat('b',64),'gcash','1234567890123');
 if job2->>'verificationId'<>receipt_id::text or (select count(*) from public.receipt_verifications where booking_id=b)<>1 then raise exception 'Canonical receipt replaced incorrectly';end if;
 result:=public.finish_picklestreet_receipt_attempt((job->>'attemptId')::uuid,(job->>'leaseToken')::uuid,p_error_code=>'vision_timeout');
 if result->>'stale'<>'true' then raise exception 'Stale OCR response was accepted';end if;
 result:=public.finish_picklestreet_receipt_attempt((job2->>'attemptId')::uuid,(job2->>'leaseToken')::uuid,pg_temp.ps_data(b,'1234567890123'),array['auto_approval_eligible'],'1234567890123',0.99,true,null,pg_temp.ps_receiver());
 if result->>'bookingStatus'<>'confirmed' or result->>'paymentStatus'<>'paid' then raise exception 'Verified receipt did not auto-confirm: %',result;end if;
 insert into ps_test_results values('Corrected proof keeps history, ignores stale OCR and auto-confirms',true);
 update public.bookings set status='payment_review',payment_status='partial',expires_at=now()+interval '20 minutes' where id=b;
 if not exists(select 1 from public.bookings where id=b and expires_at is not null) then raise exception 'Completed initial flow erased reschedule payment hold';end if;
 update public.bookings set status='confirmed',payment_status='paid',expires_at=null where id=b;
 insert into ps_test_results values('Settled original payments do not block later reschedule restoration',true);
 b2:=pg_temp.ps_booking(8);key:=extensions.gen_random_uuid();job:=public.begin_picklestreet_receipt_attempt(b2,'upload',key,t::text||'/receipts/'||b2::text||'/'||key::text||'.png',repeat('b',64),'gcash','9999999999999');
 result:=public.finish_picklestreet_receipt_attempt((job->>'attemptId')::uuid,(job->>'leaseToken')::uuid,pg_temp.ps_data(b2,'9999999999999'),array['auto_approval_eligible'],'9999999999999',0.99,true,null,pg_temp.ps_receiver());
 if result->>'bookingStatus'<>'payment_review' or not (result->'flags' ? 'duplicate_receipt_file') then raise exception 'Duplicate file did not remain pending';end if;
 insert into ps_test_results values('Reused receipt file stays pending',true);
 update public.bookings set expires_at=now()-interval '1 second' where id=b2;
 update public.booking_slots set hold_expires_at=now()-interval '1 second' where booking_id=b2;
 perform public.expire_stale_tenant_holds(t);
 if not exists(select 1 from public.bookings where id=b2 and status='expired' and payment_status='pending') or not exists(select 1 from public.payment_sessions where booking_id=b2 and status='pending') then raise exception 'Hold expiry erased pending payment';end if;
 insert into ps_test_results values('Hold expiry releases court and preserves pending payment',true);
 update public.picklestreet_receipt_attempts set created_at=now()-interval '1 minute' where booking_id=b2;
 key:=extensions.gen_random_uuid();job:=public.begin_picklestreet_receipt_attempt(b2,'upload',key,t::text||'/receipts/'||b2::text||'/'||key::text||'.png',repeat('c',64),'gcash','9999999999999');
 result:=public.finish_picklestreet_receipt_attempt((job->>'attemptId')::uuid,(job->>'leaseToken')::uuid,pg_temp.ps_data(b2,'9999999999999'),array['auto_approval_eligible'],'9999999999999',0.99,true,null,pg_temp.ps_receiver());
 if result->>'bookingStatus'<>'confirmed' or result->>'reservationRestored'<>'true' then raise exception 'Available expired hold did not safely re-confirm: %',result;end if;
 insert into ps_test_results values('Corrected verified payment rechecks and restores available time',true);
 b3:=pg_temp.ps_booking(10);key:=extensions.gen_random_uuid();job:=public.begin_picklestreet_receipt_attempt(b3,'upload',key,t::text||'/receipts/'||b3::text||'/'||key::text||'.png',repeat('d',64),'gcash','8888888888888');
 update public.bookings set expires_at=now()-interval '1 second' where id=b3;
 update public.booking_slots set hold_expires_at=now()-interval '1 second' where booking_id=b3;
 perform public.expire_stale_tenant_holds(t);
 b4:=pg_temp.ps_booking(12);
 update public.booking_slots set starts_at=(select starts_at from public.bookings where id=b3),ends_at=(select ends_at from public.bookings where id=b3),status='confirmed',hold_expires_at=null where booking_id=b4;
 result:=public.finish_picklestreet_receipt_attempt((job->>'attemptId')::uuid,(job->>'leaseToken')::uuid,pg_temp.ps_data(b3,'8888888888888'),array['auto_approval_eligible'],'8888888888888',0.99,true,null,pg_temp.ps_receiver());
 if result->>'bookingStatus'<>'expired' or result->>'paymentStatus'<>'pending' then raise exception 'Unavailable time was confirmed';end if;
 if exists(select 1 from public.booking_slots where booking_id=b3 and status in ('held','confirmed')) then raise exception 'Failed rehold left occupied slots';end if;
 insert into ps_test_results values('Taken court remains pending with no partial rehold',true);
 b4:=pg_temp.ps_booking(14);key:=extensions.gen_random_uuid();job:=public.begin_picklestreet_receipt_attempt(b4,'upload',key,t::text||'/receipts/'||b4::text||'/'||key::text||'.png',repeat('e',64),'gcash','7777777777777');
 result:=public.finish_picklestreet_receipt_attempt((job->>'attemptId')::uuid,(job->>'leaseToken')::uuid,pg_temp.ps_data(b4,'7777777777777'),array['auto_approval_eligible'],'7777777777777',0.99,true,null,'{"method":"gcash","name":"Wrong Receiver","account":"00000000000"}');
 if result->>'bookingStatus'<>'payment_review' or result->>'paymentStatus'<>'pending' then raise exception 'Changed receiver settings auto-approved';end if;
 insert into ps_test_results values('Changed receiving-account settings require a new check',true);
 blocked:=false;begin perform public.begin_picklestreet_receipt_attempt(extensions.gen_random_uuid(),'retry',extensions.gen_random_uuid());exception when sqlstate '22023' then blocked:=true;end;
 if not blocked then raise exception 'Foreign/unknown booking accepted';end if;
 perform set_config('request.jwt.claim.role','authenticated',true);perform set_config('request.jwt.claims','{"role":"authenticated"}',true);
 blocked:=false;begin perform public.begin_picklestreet_receipt_attempt(b3,'retry',extensions.gen_random_uuid());exception when sqlstate '42501' then blocked:=true;end;
 if not blocked then raise exception 'Unprivileged caller accepted';end if;
 insert into ps_test_results values('Unknown booking and unprivileged service calls denied',true);
end;$$;
select jsonb_agg(to_jsonb(ps_test_results) order by name) as checks from ps_test_results;
