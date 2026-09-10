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

create function pg_temp.ps_hold_create(n integer,p_key uuid default extensions.gen_random_uuid(),p_ip text default null,p_delta numeric default 0,p_type text default 'regular')
returns jsonb language plpgsql as $$
declare f ps_hold_fixture%rowtype;s timestamptz;fee numeric;result jsonb;token_hash text:=encode(extensions.digest(p_key::text,'sha256'),'hex');
begin
  select * into strict f from ps_hold_fixture;s:=f.starts_at+n*interval '1 day';
  fee:=round(case f.fee_mode when 'fixed_per_booking' then f.fee_amount when 'fixed_per_hour' then f.fee_amount when 'percentage' then 10*f.fee_amount/100 end,2);
  result:=public.create_picklestreet_provisional_hold('picklestreet.pages.dev',p_key,token_hash,coalesce(p_ip,token_hash),f.court_id,p_type,
    s,s+interval '1 hour',jsonb_build_array(jsonb_build_object('startsAt',s,'endsAt',s+interval '1 hour')),
    10+p_delta,fee,10+p_delta+fee,'PHP','{"fullPaymentOnly":true}');
  return result||jsonb_build_object('testKey',p_key,'testHash',token_hash);
end;$$;

do $$ declare f jsonb; r jsonb; n integer; denied boolean:=false; begin
 f:=pg_temp.ps_hold_create(1);
 begin perform public.cancel_picklestreet_hold_with_reason('picklestreet.pages.dev',f->>'reference',repeat('0',64),'customer_cancel');exception when others then denied:=true;end;
 if not denied then raise exception 'Wrong capability accepted';end if;
 r:=public.cancel_picklestreet_hold_with_reason('picklestreet.pages.dev',f->>'reference',f->>'testHash','browser_timer_elapsed');
 if r->>'status'<>'cancelled' then raise exception 'Not cancelled';end if;
 if not exists(select 1 from public.audit_events where entity_id=f->>'bookingId' and action='checkout_cancelled' and metadata->>'reason'='browser_timer_elapsed' and metadata->>'serverDeadlinePassed'='false') then raise exception 'Reason not recorded';end if;
 perform public.cancel_picklestreet_hold_with_reason('picklestreet.pages.dev',f->>'reference',f->>'testHash','customer_cancel');
 select count(*) into n from public.audit_events where entity_id=f->>'bookingId' and action='checkout_cancelled';
 if n<>1 then raise exception 'Repeated cancellation duplicated or replaced reason';end if;
 end;$$;select true as reason_and_idempotency_verified;
