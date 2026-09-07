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
do $$
declare t constant uuid:='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';f jsonb;f2 jsonb;j jsonb;j2 jsonb;r jsonb;denied boolean;old_start timestamptz;
begin
 f:=pg_temp.ps2_fixture(0);j:=pg_temp.ps2_begin(f,repeat('1',64),'2011111111111');
 select starts_at into old_start from public.bookings where id=(f->>'b')::uuid;
 r:=pg_temp.ps2_finish(j,'provider_unavailable');
 if r->>'status'<>'manual_review' or r->>'bookingStatus'<>'confirmed' or r->>'paymentStatus'<>'paid' or r->>'balanceStatus'<>'payment_review' then raise exception 'Pending adjustment changed original: %',r;end if;
 if not exists(select 1 from public.booking_balance_requests where id=(f->>'q')::uuid and isfinite(deadline_at)) then raise exception 'Hold became infinite';end if;
 insert into ps2_results values('OCR failure keeps original paid booking and finite proposed hold',true);
 update public.picklestreet_balance_receipt_jobs set hold_deadline_at=now()-interval '1 minute' where balance_request_id=(f->>'q')::uuid;
 perform public.expire_picklestreet_balance_receipt_holds((f->>'b')::uuid);
 if not exists(select 1 from public.booking_slots where booking_id=(f->>'b')::uuid and balance_request_id is null and status='confirmed')
 or not exists(select 1 from public.booking_slots where booking_id=(f->>'b')::uuid and balance_request_id=(f->>'q')::uuid and status='expired') then raise exception 'Wrong slots expired';end if;
 insert into ps2_results values('Expired proposed time frees the court and preserves original reservation',true);
 j2:=pg_temp.ps2_begin(f,null,null,'retry');
 if j2->>'bookingStartedAt'<>j->>'bookingStartedAt' then raise exception 'Retry moved payment window';end if;
 r:=pg_temp.ps2_finish(j2);
 if r->>'status'<>'auto_approved' or r->>'balanceStatus'<>'settled' or r->>'rescheduleEventId' is null then raise exception 'Automatic move did not commit: %',r;end if;
 if exists(select 1 from public.booking_slots where booking_id=(f->>'b')::uuid and (balance_request_id is not null or status<>'confirmed'))
 or not exists(select 1 from public.bookings where id=(f->>'b')::uuid and starts_at=old_start+interval '2 hours' and payment_status='paid') then raise exception 'Partial reschedule settlement';end if;
 insert into ps2_results values('Verified retry atomically changes schedule and settles exact extra amount',true);
 f:=pg_temp.ps2_fixture(1);j:=pg_temp.ps2_begin(f,repeat('2',64),'2022222222222');r:=pg_temp.ps2_finish(j,'provider_unavailable');
 denied:=false;begin update public.receipt_verifications set status='rejected' where balance_request_id=(f->>'q')::uuid;exception when sqlstate '22023' then denied:=true;end;
 if not denied then raise exception 'Balance rejection allowed';end if;
 denied:=false;begin update public.receipt_verifications set status='approved' where balance_request_id=(f->>'q')::uuid;exception when sqlstate '22023' then denied:=true;end;
 if not denied then raise exception 'Manual balance approval allowed';end if;
 update public.bookings set status='completed' where id=(f->>'b')::uuid;
 if not exists(select 1 from public.bookings where id=(f->>'b')::uuid and status='completed' and payment_status='paid') then raise exception 'Original booking cannot complete';end if;
 insert into ps2_results values('No manual rejection or approval; original booking remains usable',true);
 f:=pg_temp.ps2_fixture(2);j:=pg_temp.ps2_begin(f,repeat('3',64),'2033333333333');r:=pg_temp.ps2_finish(j,'provider_unavailable');
 update public.picklestreet_balance_receipt_jobs set hold_deadline_at=now()-interval '1 minute' where balance_request_id=(f->>'q')::uuid;
 perform public.expire_picklestreet_balance_receipt_holds((f->>'b')::uuid);
 f2:=pg_temp.ps2_fixture(3);
 update public.booking_slots set starts_at=(select starts_at from public.bookings where id=(f->>'b')::uuid)+interval '2 hours',ends_at=(select ends_at from public.bookings where id=(f->>'b')::uuid)+interval '2 hours'
 where booking_id=(f2->>'b')::uuid and balance_request_id is null;
 j2:=pg_temp.ps2_begin(f,null,null,'retry');r:=pg_temp.ps2_finish(j2);
 if r->>'status'<>'manual_review' or r->>'bookingStatus'<>'confirmed' or not(r->'flags' ? 'reservation_time_unavailable') then raise exception 'Occupied proposed time was accepted: %',r;end if;
 if not exists(select 1 from public.booking_slots where booking_id=(f->>'b')::uuid and balance_request_id is null and status='confirmed') then raise exception 'Original slot lost on conflict';end if;
 insert into ps2_results values('Conflicting new reservation leaves extra payment pending and original intact',true);
 f:=pg_temp.ps2_fixture(4);j:=pg_temp.ps2_begin(f,repeat('4',64),'2044444444444');r:=pg_temp.ps2_finish(j,'provider_unavailable');
 j2:=pg_temp.ps2_begin(f,repeat('5',64),'2055555555555');r:=pg_temp.ps2_finish(j2,'provider_unavailable');
 f2:=pg_temp.ps2_fixture(5);j:=pg_temp.ps2_begin(f2,repeat('4',64),'2066666666666');r:=pg_temp.ps2_finish(j);
 if r->>'status'<>'manual_review' or not(r->'flags' ? 'duplicate_receipt_file') then raise exception 'Replaced old image reuse approved';end if;
 insert into ps2_results values('Replaced receipt history prevents reuse for a different balance',true);
 f:=pg_temp.ps2_fixture(6);j:=pg_temp.ps2_begin(f,repeat('6',64),'2077777777777');
 update public.picklestreet_balance_receipt_jobs set lease_until=now()-interval '1 second' where balance_request_id=(f->>'q')::uuid;
 j2:=pg_temp.ps2_begin(f,null,null,'retry');r:=pg_temp.ps2_finish(j);
 if r->>'stale'<>'true' then raise exception 'Stale verifier accepted';end if;
 r:=pg_temp.ps2_finish(j2,null,false);
 if r->>'status'<>'manual_review' or not(r->'flags' ? 'payment_receiver_settings_changed') then raise exception 'Changed receiver accepted';end if;
 insert into ps2_results values('Stale attempts and changed receiving accounts cannot approve',true);
end;$$;
select jsonb_agg(to_jsonb(ps2_results) order by name) as checks from ps2_results;
