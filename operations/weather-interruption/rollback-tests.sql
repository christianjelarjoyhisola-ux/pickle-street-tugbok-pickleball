create temp table wi_results(name text primary key,passed boolean);
do $$
declare actor uuid;c uuid;b uuid;b2 uuid;unpaid uuid;j jsonb;w jsonb;r jsonb;saved jsonb;key uuid:=extensions.gen_random_uuid();denied boolean;before jsonb;
begin
 select user_id into actor from public.platform_profiles where is_platform_owner order by user_id limit 1;
 c:=pg_temp.ps_manual_isolated_court();
 b:=pg_temp.wc_target(9850,c,120);j:=pg_temp.ps_manual_begin(b,9850);perform pg_temp.ps_manual_call(j);
 b2:=pg_temp.wc_target(9851,c,120);j:=pg_temp.ps_manual_begin(b2,9851);perform pg_temp.ps_manual_call(j);
 unpaid:=pg_temp.wc_target(9852,c,60);
 select jsonb_agg(to_jsonb(x) order by id) into before from public.bookings x where id in(b,b2,unpaid);
 select jsonb_agg(jsonb_build_object('courtId',court_id,'start',starts_at+interval '30 minutes','end',ends_at)) into w from public.bookings where id in(b,b2,unpaid);
 r:=public.preview_picklestreet_weather_interruption(actor,w);
 if jsonb_array_length(r->'bookings')<>3 or (select count(*) from jsonb_array_elements(r->'bookings') x where (x->>'eligible')::boolean)<>2
 or exists(select 1 from jsonb_array_elements(r->'bookings') x where (x->>'eligible')::boolean and x->>'minutes'<>'90') then raise exception 'Overlap preview incorrect %',r;end if;
 insert into wi_results values('Multiple ranges compute only overlapped paid time; unpaid booking excluded',true);
 denied:=false;begin perform public.preview_picklestreet_weather_interruption(actor,w||jsonb_build_array(w->0));exception when others then denied:=true;end;
 if not denied then raise exception 'Overlapping ranges accepted';end if;
 insert into wi_results values('Overlapping court ranges rejected before duplicate hours can be counted',true);
 denied:=false;begin perform public.issue_picklestreet_weather_interruption(actor,key,w,array['PS-ROLLBACK-9850','PS-ROLLBACK-9852'],r->>'snapshot','rain');exception when others then denied:=true;end;
 if not denied or exists(select 1 from public.picklestreet_weather_credits where booking_id=b) then raise exception 'Mixed eligibility partially issued';end if;
 insert into wi_results values('Ineligible selection rejects the whole batch without partial issuance',true);
 saved:=public.issue_picklestreet_weather_interruption(actor,key,w,array['PS-ROLLBACK-9850','PS-ROLLBACK-9851'],r->>'snapshot','rain');
 if jsonb_array_length(saved->'bookings')<>2 or exists(select 1 from public.picklestreet_weather_credits where booking_id in(b,b2) and minutes<>90) then raise exception 'Bulk issue incorrect';end if;
 if public.issue_picklestreet_weather_interruption(actor,key,w,array['PS-ROLLBACK-9850','PS-ROLLBACK-9851'],r->>'snapshot','rain')<>saved then raise exception 'Retry not stable';end if;
 if before is distinct from (select jsonb_agg(to_jsonb(x) order by id) from public.bookings x where id in(b,b2,unpaid)) then raise exception 'Original bookings changed';end if;
 insert into wi_results values('Atomic issuance and identical retry preserve bookings and issue each code once',true);
 denied:=false;begin perform public.issue_picklestreet_weather_interruption(actor,extensions.gen_random_uuid(),w,array['PS-ROLLBACK-9850'],r->>'snapshot','rain');exception when others then denied:=true;end;
 if not denied then raise exception 'Stale preview accepted';end if;
 r:=public.preview_picklestreet_weather_interruption(actor,w);
 if exists(select 1 from jsonb_array_elements(r->'bookings') x where (x->>'eligible')::boolean) then raise exception 'Already issued time eligible';end if;
 insert into wi_results values('Stale previews and previously credited bookings cannot issue again',true);
 denied:=false;begin perform public.preview_picklestreet_weather_interruption(null,w);exception when insufficient_privilege then denied:=true;end;
 if not denied then raise exception 'Unauthenticated actor accepted';end if;
 insert into wi_results values('Owner authorization required even through service RPC',true);
end;$$;
do $$
declare actor uuid;source jsonb;j jsonb;w jsonb;r jsonb;expected integer;denied boolean;
begin
 select user_id into actor from public.platform_profiles where is_platform_owner order by user_id limit 1;
 source:=pg_temp.ps_group_payment_fixture(1);j:=pg_temp.ps_group_payment_begin((source->>'bookingId')::uuid,9950);
 perform public.finish_picklestreet_receipt_attempt((j->>'attemptId')::uuid,(j->>'leaseToken')::uuid,p_error_code=>'verifier_unavailable');perform pg_temp.ps_manual_call(j);
 select jsonb_agg(jsonb_build_object('courtId',court_id,'start',starts_at,'end',least(ends_at,starts_at+interval '30 minutes'))),count(*)*30 into w,expected
 from public.booking_slots where booking_id=(source->>'bookingId')::uuid and status='confirmed';
 r:=public.preview_picklestreet_weather_interruption(actor,w);
 if jsonb_array_length(r->'bookings')<>1 or (r->'bookings'->0->>'minutes')::integer<>expected then raise exception 'Grouped court-hours counted incorrectly %',r;end if;
 perform public.issue_picklestreet_weather_interruption(actor,extensions.gen_random_uuid(),w,array[source->>'reference'],r->>'snapshot','wet_court');
 if (select minutes from public.picklestreet_weather_credits where booking_id=(source->>'bookingId')::uuid)<>expected then raise exception 'Grouped hours issue incorrect';end if;
 insert into wi_results values('Multiple courts and grouped sessions aggregate into one accurate customer credit',true);
 denied:=false;begin perform public.preview_picklestreet_weather_interruption(actor,jsonb_build_array(jsonb_build_object('courtId',extensions.gen_random_uuid(),'start',now(),'end',now()+interval '1 hour')));exception when others then denied:=true;end;
 if not denied then raise exception 'Unknown or foreign court accepted';end if;
 insert into wi_results values('Unknown and foreign courts cannot enter the preview',true);
end;$$;
