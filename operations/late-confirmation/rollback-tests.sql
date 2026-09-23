create temp table lc_results(name text primary key,passed boolean);
-- Fixtures run only inside the caller's ROLLBACK transaction. Venue-wide blocks
-- also cover synthetic courts; hide them in this transaction for isolated cases.
delete from public.blocked_dates where tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';
do $$
declare b uuid;j jsonb;r jsonb;again jsonb;k uuid;actor uuid;c uuid;n integer;original jsonb;slots jsonb;denied boolean;start_time timestamptz;conflict uuid;
begin
 select user_id into actor from public.platform_profiles where is_platform_owner order by user_id limit 1;
 if actor is null then raise exception 'Fixture needs platform owner';end if;
 for n in 1..4 loop
   c:=pg_temp.ps_manual_isolated_court();b:=pg_temp.ps_booking(9700+n);j:=pg_temp.ps_manual_begin(b,9700+n);
   start_time:=case n when 1 then now()+interval '1 day' when 2 then now()-interval '5 minutes' else now()-interval '2 days' end;
   update public.bookings set court_id=c,starts_at=start_time,ends_at=start_time+interval '1 hour',local_booking_date=(start_time at time zone 'Asia/Manila')::date,
     status=case when n=4 then 'expired' else 'payment_review' end where id=b;
   update public.booking_slots set court_id=c,starts_at=start_time,ends_at=start_time+interval '1 hour',
     status=case when n=4 then 'expired' else 'held' end,hold_expires_at=case when n=4 then now()-interval '1 minute' else 'infinity'::timestamptz end where booking_id=b;
   select to_jsonb(booking)-array['status','payment_status','confirmed_at','expires_at','updated_at'] into original from public.bookings booking where id=b;
   select jsonb_agg(jsonb_build_object('court',court_id,'start',starts_at,'end',ends_at) order by id) into slots from public.booking_slots where booking_id=b;
   k:=extensions.gen_random_uuid();
   r:=public.review_picklestreet_pending_receipt((j->>'verificationId')::uuid,(j->>'attemptId')::uuid,k,'approve','',actor);
   if r->>'bookingStatus'<>'confirmed' or r->>'paymentStatus'<>'paid' then raise exception 'Confirmation failed: %',r;end if;
   if original is distinct from (select to_jsonb(booking)-array['status','payment_status','confirmed_at','expires_at','updated_at'] from public.bookings booking where id=b) then raise exception 'Confirmation changed original booking details';end if;
   if slots is distinct from (select jsonb_agg(jsonb_build_object('court',court_id,'start',starts_at,'end',ends_at) order by id) from public.booking_slots where booking_id=b) then raise exception 'Confirmation changed slots';end if;
   if exists(select 1 from public.booking_slots where booking_id=b and status<>'confirmed') then raise exception 'Slots not confirmed';end if;
   again:=public.review_picklestreet_pending_receipt((j->>'verificationId')::uuid,(j->>'attemptId')::uuid,k,'approve','',actor);
   if again->>'idempotent'<>'true' or again->>'reviewId'<>r->>'reviewId' then raise exception 'Retry duplicated review';end if;
   insert into lc_results values(case n when 1 then 'Future confirmation' when 2 then 'Underway confirmation' when 3 then 'Past confirmation' else 'Expired past confirmation with free original slot' end || ': schedule, customer, prices, audit and retry preserved',true);
 end loop;
 c:=pg_temp.ps_manual_isolated_court();b:=pg_temp.ps_booking(9710);j:=pg_temp.ps_manual_begin(b,9710);
 start_time:=now()-interval '2 days';
 update public.bookings set court_id=c,starts_at=start_time,ends_at=start_time+interval '1 hour',local_booking_date=(start_time at time zone 'Asia/Manila')::date,status='expired' where id=b;
 update public.booking_slots set court_id=c,starts_at=start_time,ends_at=start_time+interval '1 hour',status='expired',hold_expires_at=now()-interval '1 minute' where booking_id=b;
 conflict:=pg_temp.ps_booking(9711);
 update public.bookings set court_id=c,starts_at=start_time,ends_at=start_time+interval '1 hour',local_booking_date=(start_time at time zone 'Asia/Manila')::date where id=conflict;
 update public.booking_slots set court_id=c,starts_at=start_time,ends_at=start_time+interval '1 hour',hold_expires_at='infinity'::timestamptz where booking_id=conflict;
 denied:=false;begin perform pg_temp.ps_manual_call(j);exception when sqlstate '22023' then denied:=sqlerrm='reservation_time_unavailable';end;
 if not denied or (select payment_status from public.bookings where id=b)<>'pending' or exists(select 1 from public.picklestreet_receipt_staff_reviews where booking_id=b) then raise exception 'Conflicting late confirmation was not rolled back';end if;
 insert into lc_results values('Another reservation blocks late confirmation without changing payment or audit',true);
 denied:=false;begin perform public.review_picklestreet_pending_receipt((j->>'verificationId')::uuid,(j->>'attemptId')::uuid,extensions.gen_random_uuid(),'approve','',extensions.gen_random_uuid());exception when sqlstate '42501' then denied:=true;end;
 if not denied then raise exception 'Unauthorized review accepted';end if;
 insert into lc_results values('Unauthorized reviewer rejected',true);
 denied:=false;begin perform public.review_picklestreet_pending_receipt((j->>'verificationId')::uuid,extensions.gen_random_uuid(),extensions.gen_random_uuid(),'approve','',actor);exception when sqlstate '22023' then denied:=sqlerrm='RECEIPT_CHANGED';end;
 if not denied then raise exception 'Stale receipt accepted';end if;
 insert into lc_results values('Stale receipt attempt rejected',true);
 if has_function_privilege('anon','public.review_picklestreet_pending_receipt(uuid,uuid,uuid,text,text,uuid)','EXECUTE') or has_function_privilege('authenticated','public.review_picklestreet_pending_receipt(uuid,uuid,uuid,text,text,uuid)','EXECUTE') then raise exception 'Private review exposed';end if;
 insert into lc_results values('Guest and direct authenticated access remain denied',true);
end;$$;
