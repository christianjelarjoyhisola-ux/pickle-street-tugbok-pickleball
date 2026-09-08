-- Append within the proposed migration transaction; the builder ends with ROLLBACK.
-- No HTTP/storage/email calls. All new bookings use a synthetic court removed by rollback.
set local request.jwt.claim.role='service_role';
set local request.jwt.claims='{"role":"service_role"}';
set local request.headers='{"origin":"https://picklestreet.pages.dev"}';
create temporary table ps_hold_results(name text primary key,passed boolean not null default true);
create temporary table ps_hold_fixture(court_id uuid,starts_at timestamptz,fee_mode text,fee_amount numeric);

do $$
declare v_id uuid:=extensions.gen_random_uuid();v_seed jsonb;v_columns text;
begin
  select to_jsonb(c)||jsonb_build_object('id',v_id,'slug','test-hold-'||v_id::text,'name','TEST ONLY provisional hold rollback',
    'description','Synthetic rollback fixture','opens_at','05:00','closes_at','00:00','sort_order',9999,
    'pricing_config','{"regular":{"bands":[{"start":"05:00","end":"24:00","hourlyRate":10}],"minimumHours":1,"maximumHours":18,"fullPaymentRequired":true},"event":{"enabled":false,"hourlyRate":0,"minimumHours":0,"maximumGuests":0,"fullPaymentRequired":true}}'::jsonb,
    'public_config',coalesce(c.public_config,'{}')||'{"testOnly":true,"minimumLeadMinutes":0,"maximumAdvanceDays":90}'::jsonb)
    into v_seed from public.courts c where c.tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a' and c.status='active' order by c.id limit 1;
  if v_seed is null then raise exception 'Fixture requires an active target court to clone';end if;
  select string_agg(quote_ident(attname),',' order by attnum) into v_columns from pg_attribute
    where attrelid='public.courts'::regclass and attnum>0 and not attisdropped and attgenerated='' and attidentity='';
  execute format('insert into public.courts(%1$s) select %1$s from jsonb_populate_record(null::public.courts,$1)',v_columns) using v_seed;
  insert into ps_hold_fixture select v_id,(((now() at time zone 'Asia/Manila')::date+14)+time '08:00') at time zone 'Asia/Manila',fee_mode,fee_amount
    from public.tenant_platform_billing where tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';
end;$$;

create function pg_temp.group_session(c uuid,s timestamptz) returns jsonb language plpgsql as $$
declare f ps_hold_fixture%rowtype;fee numeric;
begin
 select * into strict f from ps_hold_fixture;
 fee:=round(case f.fee_mode when 'fixed_per_booking' then f.fee_amount when 'fixed_per_hour' then f.fee_amount when 'percentage' then 10*f.fee_amount/100 end,2);
 return jsonb_build_object('courtId',c,'startsAt',s,'endsAt',s+interval '1 hour','slots',jsonb_build_array(jsonb_build_object('startsAt',s,'endsAt',s+interval '1 hour')),
 'subtotalAmount',10,'serviceFeeAmount',fee,'totalAmount',10+fee,'currency','PHP','metadata','{"fullPaymentOnly":true}'::jsonb);
end;$$;
do $$
declare f ps_hold_fixture%rowtype;c2 uuid:=extensions.gen_random_uuid();seed jsonb;cols text;key uuid:=extensions.gen_random_uuid();hash text;
 sessions jsonb;r jsonb;again jsonb;done jsonb;before_count integer;denied boolean;policy public.settings%rowtype;expected_fee numeric;
begin
 select * into strict f from ps_hold_fixture;
 select to_jsonb(c)||jsonb_build_object('id',c2,'slug','test-group-'||c2::text,'name','TEST ONLY second group court') into seed from public.courts c where id=f.court_id;
 select string_agg(quote_ident(attname),',' order by attnum) into cols from pg_attribute where attrelid='public.courts'::regclass and attnum>0 and not attisdropped and attgenerated='' and attidentity='';
 execute format('insert into public.courts(%1$s) select %1$s from jsonb_populate_record(null::public.courts,$1)',cols) using seed;
 hash:=encode(extensions.digest(key::text,'sha256'),'hex');
 sessions:=jsonb_build_array(pg_temp.group_session(f.court_id,f.starts_at),pg_temp.group_session(c2,f.starts_at),pg_temp.group_session(f.court_id,f.starts_at+interval '3 hours'));
 select count(*) into before_count from public.bookings where tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';
 r:=public.create_picklestreet_group_hold('picklestreet.pages.dev',key,hash,hash,sessions);
 if (select count(*) from public.bookings where tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a')<>before_count+1
  or (select count(*) from public.booking_slots where booking_id=(r->>'bookingId')::uuid)<>3 or jsonb_array_length(r->'sessions')<>3 then raise exception 'Group did not create ONE reference with three sessions';end if;
 expected_fee:=round(case f.fee_mode when 'fixed_per_booking' then f.fee_amount when 'fixed_per_hour' then 3*f.fee_amount when 'percentage' then 30*f.fee_amount/100 end,2);
 if (r->>'totalAmount')::numeric<>30+expected_fee or (r->>'expiresAt')::timestamptz<>now()+interval '15 minutes'
  or exists(select 1 from public.booking_access_tokens where booking_id=(r->>'bookingId')::uuid) then raise exception 'Group fee/deadline/preliminary access invalid';end if;
 insert into ps_hold_results values('One owner/reference/total; simultaneous courts and nonadjacent hours; one original deadline',true);
 again:=public.create_picklestreet_group_hold('picklestreet.pages.dev',key,hash,hash,sessions);
 if again->>'reference'<>r->>'reference' or again->>'expiresAt'<>r->>'expiresAt' then raise exception 'Retry changed group';end if;
 insert into ps_hold_results values('Idempotent retry keeps same reference and deadline',true);
 denied:=false;
 begin perform public.create_picklestreet_group_hold('picklestreet.pages.dev',key,hash,hash,jsonb_build_array(pg_temp.group_session(c2,f.starts_at+interval '4 hours')));
 exception when sqlstate '22023' then denied:=true;end;
 if not denied then raise exception 'Changed selection reused key';end if;
 insert into ps_hold_results values('Changed selection rejected',true);
 denied:=false;
 begin perform public.create_picklestreet_group_hold('picklestreet.pages.dev',extensions.gen_random_uuid(),repeat('b',64),repeat('b',64),jsonb_build_array(pg_temp.group_session(c2,f.starts_at+interval '2 hours'),pg_temp.group_session(f.court_id,f.starts_at)));
 exception when exclusion_violation or sqlstate '22023' then denied:=true;end;
 if not denied or exists(select 1 from public.booking_slots where court_id=c2 and starts_at=f.starts_at+interval '2 hours') then raise exception 'Conflict left partial group hold';end if;
 insert into ps_hold_results values('Unavailable session rolls back every newly requested slot',true);
 perform public.assert_picklestreet_group_slots((r->>'bookingId')::uuid);
 select * into strict policy from public.settings setting where setting.tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a' and setting.key='refund_reschedule_policy';
 done:=public.complete_picklestreet_provisional_hold('picklestreet.pages.dev',r->>'reference',hash,'TEST ONLY Group Owner','group@example.invalid','09000000000',true,policy.value->>'version',public.refund_reschedule_policy_sha256(policy.value),1,null,null);
 if done->'detailsCompleted'<>'true'::jsonb or done->>'reference'<>r->>'reference' or done->>'expiresAt'<>r->>'expiresAt'
  or (select count(*) from public.booking_access_tokens where booking_id=(r->>'bookingId')::uuid)<>1 then raise exception 'Group completion changed reference/deadline/token';end if;
 insert into ps_hold_results values('One real customer and policy complete all sessions with same capability',true);
 denied:=false;
 begin perform public.create_picklestreet_group_hold('paddleragecdo.ph',extensions.gen_random_uuid(),repeat('c',64),repeat('c',64),sessions);
 exception when sqlstate '42501' then denied:=true;end;
 if not denied then raise exception 'Foreign origin accepted';end if;
 insert into ps_hold_results values('Other venue origin cannot create a group',true);
end;$$;
select * from ps_hold_results order by name;
