-- Root-reviewed ROLLBACK fixture only. Append after court-promo-rollback-tests.sql
-- and before the final fingerprint assertions/ROLLBACK. Never submit this file alone.
-- Uses a new synthetic court, null customer email, existing billing/policy settings.

create function pg_temp.ps_promo_session(p_court uuid, p_start timestamptz, p_subtotal numeric, p_metadata jsonb)
returns jsonb language sql as $$
  select jsonb_build_object(
    'courtId',p_court,'bookingDate',to_char(p_start at time zone 'Asia/Manila','YYYY-MM-DD'),
    'startTime',to_char(p_start at time zone 'Asia/Manila','HH24:MI'),'durationHours',1,
    'startsAt',p_start,'endsAt',p_start+interval '1 hour',
    'slots',jsonb_build_array(jsonb_build_object('startsAt',p_start,'endsAt',p_start+interval '1 hour')),
    'subtotalAmount',p_subtotal,'serviceFeeAmount',1,'totalAmount',p_subtotal+1,'currency','PHP',
    'metadata',p_metadata||jsonb_build_object('courtSubtotalAmount',p_subtotal,'equipmentRentalFeeAmount',0,
      'equipmentRental',jsonb_build_object('extraPaddles',0,'balls',0),
      'equipmentRentalRates',coalesce((select jsonb_build_object(
        'extraPaddle',case when pricing.enabled then pricing.extra_paddle_rate else 0 end,
        'ball',case when pricing.enabled then pricing.ball_rate else 0 end)
        from public.tenant_equipment_rental_pricing pricing
        where pricing.tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid),
        jsonb_build_object('extraPaddle',0,'ball',0)),
      'fullPaymentOnly',true)
  )
$$;

do $$
declare
  tenant_key constant uuid := 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';
  actor uuid;
  court_key uuid;
  core_id uuid;
  group_id uuid;
  new_group_id uuid;
  court_price jsonb;
  policy_row public.settings%rowtype;
  metadata jsonb := jsonb_build_object('testOnly',true,'testDescription','Rollback promo pricing integration',
    'fullPaymentOnly',true,'courtName','TEST ONLY - promo rollback court');
  policy_hash text;
  start_at timestamptz := (((now() at time zone 'Asia/Manila')::date+14)+time '08:00') at time zone 'Asia/Manila';
  core_key text := 'PS-PROMO-CORE-'||gen_random_uuid()::text;
  group_key text := 'PS-PROMO-GROUP-'||gen_random_uuid()::text;
  group_fingerprint text := replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','');
  group_token_hash text := replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','');
  session_row jsonb;
  group_session jsonb;
  result jsonb;
  retry_result jsonb;
  old_core public.bookings%rowtype;
  old_group public.bookings%rowtype;
  denied boolean;
begin
  if not exists(select 1 from public.tenant_platform_billing where tenant_id=tenant_key and fee_mode='fixed_per_hour' and fee_amount=1) then
    raise exception 'Fixture expects existing one-peso hourly fee; do not change billing settings';
  end if;
  select user_id into actor from public.platform_profiles where is_platform_owner order by user_id limit 1;
  if actor is null then raise exception 'Fixture requires existing platform owner'; end if;
  select * into policy_row from public.settings s where s.tenant_id=tenant_key and s.key='refund_reschedule_policy' for share;
  if found then
    policy_hash := public.refund_reschedule_policy_sha256(policy_row.value);
    if policy_row.is_public is distinct from true or policy_hash is null then raise exception 'Current public policy is invalid'; end if;
    metadata := metadata || jsonb_build_object('policyAcceptance',jsonb_build_object(
      'accepted',true,'version',policy_row.value->>'version','sha256',policy_hash));
  end if;
  perform set_config('request.jwt.claim.sub',actor::text,true);
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',actor)::text,true);
  perform set_config('request.headers','{"origin":"https://picklestreet.pages.dev"}',true);
  court_price := '{"regular":{"bands":[{"start":"05:00","end":"24:00","standardHourlyRate":200,"promoHourlyRate":150,"promoEnabled":true}],"minimumHours":1,"maximumHours":18,"fullPaymentRequired":true},"event":{"enabled":false,"hourlyRate":0,"minimumHours":0,"maximumGuests":0,"fullPaymentRequired":true}}';
  result := public.manage_picklestreet_court('pickle-street-tugbok','picklestreet.pages.dev','save',null,
    jsonb_build_object('slug','promo-booking-rollback-'||gen_random_uuid()::text,'name','TEST ONLY - promo rollback court',
      'description','Synthetic court confined to rollback validation','status','active','sortOrder',9999,
      'opensAt','05:00','closesAt','00:00','currency','PHP','pricingConfig',court_price,
      'publicConfig',jsonb_build_object('testOnly',true,'minimumLeadMinutes',0,'maximumAdvanceDays',30)),pg_temp.ps_promo_revisions());
  court_key := (result->>'id')::uuid;
  court_price := result->'pricing_config';

  -- Edge create-booking invokes protected SQL using its service identity.
  perform set_config('request.jwt.claim.sub','',true);
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  session_row := pg_temp.ps_promo_session(court_key,start_at,150,metadata);
  result := public.create_public_booking_core('pickle-street-tugbok','picklestreet.pages.dev',court_key,'regular',
    'TEST ONLY - promo core',null,'00000000000',1,start_at,start_at+interval '1 hour',session_row->'slots',
    150,1,151,'PHP',session_row->'metadata',core_key);
  core_id := (result->>'bookingId')::uuid;
  select * into strict old_core from public.bookings where tenant_id=tenant_key and id=core_id;
  if old_core.subtotal_amount <> 150 or old_core.service_fee_amount <> 1 or old_core.total_amount <> 151
     or old_core.status <> 'pending_payment' or old_core.payment_status <> 'unpaid' or old_core.customer_email is not null
     or (select count(*) from public.booking_slots where tenant_id=tenant_key and booking_id=core_id and court_id=court_key and status='held') <> 1 then
    raise exception 'Core failed to create one unpaid promo hold at 150+1';
  end if;
  insert into ps_promo_results values ('Core booking persists one promo hour at 150 plus configured fee one',true);

  denied := false;
  session_row := pg_temp.ps_promo_session(court_key,start_at+interval '1 hour',149,metadata);
  begin
    perform public.create_public_booking_core('pickle-street-tugbok','picklestreet.pages.dev',court_key,'regular',
      'TEST ONLY - rejected core',null,'00000000000',1,start_at+interval '1 hour',start_at+interval '2 hours',
      session_row->'slots',149,1,150,'PHP',session_row->'metadata','PS-PROMO-INVALID-'||gen_random_uuid()::text);
  exception when sqlstate '22023' then
    if sqlerrm not like 'Court subtotal does not match the current protected rate calculation.%' then raise; end if;
    denied := true;
  end;
  if not denied or exists(select 1 from public.booking_slots where court_id=court_key and starts_at=start_at+interval '1 hour') then
    raise exception 'Core accepted a forged subtotal or left its rejected hold';
  end if;
  insert into ps_promo_results values ('Core rejects a mismatched promo subtotal before holding any slot',true);

  group_session := pg_temp.ps_promo_session(court_key,start_at+interval '2 hours',150,metadata);
  result := public.create_public_booking_group_with_access('pickle-street-tugbok','picklestreet.pages.dev','regular',
    'TEST ONLY - promo group',null,'00000000000',1,jsonb_build_array(group_session),
    (group_session->'metadata')||jsonb_build_object('groupFingerprint',group_fingerprint),group_key,group_token_hash);
  group_id := (result->>'bookingId')::uuid;
  select * into strict old_group from public.bookings where tenant_id=tenant_key and id=group_id;
  if (result->>'totalAmount')::numeric <> 151 or old_group.subtotal_amount <> 150 or old_group.service_fee_amount <> 1
     or old_group.total_amount <> 151 or old_group.customer_email is not null or old_group.status <> 'pending_payment'
     or old_group.payment_status <> 'unpaid'
     or not exists(select 1 from public.booking_access_tokens where tenant_id=tenant_key and booking_id=group_id and token_hash=group_token_hash)
     or (select count(*) from public.booking_slots where tenant_id=tenant_key and booking_id=group_id and court_id=court_key and status='held') <> 1 then
    raise exception 'Actual Edge group route failed to persist promo hold and access token';
  end if;
  if policy_row.id is not null and not exists(select 1 from public.booking_policy_acceptances
      where tenant_id=tenant_key and booking_id=group_id and policy_sha256=policy_hash) then
    raise exception 'Group route did not record current policy evidence';
  end if;
  insert into ps_promo_results values ('Actual group booking route persists 151 hold with access and policy evidence',true);

  perform set_config('request.jwt.claim.sub',actor::text,true);
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',actor)::text,true);
  court_price := jsonb_set(court_price,'{regular,bands,0,promoEnabled}','false');
  perform public.manage_picklestreet_court('pickle-street-tugbok','picklestreet.pages.dev','save',court_key,
    jsonb_build_object('pricingConfig',court_price),pg_temp.ps_promo_revisions());
  if (select (pricing_config #>> '{regular,bands,0,hourlyRate}')::numeric from public.courts where id=court_key) <> 200 then
    raise exception 'Manager promo toggle did not restore regular pricing';
  end if;
  if exists(select 1 from public.bookings where id in(core_id,group_id) and (subtotal_amount<>150 or service_fee_amount<>1 or total_amount<>151
      or status<>'pending_payment' or payment_status<>'unpaid')) then raise exception 'Promo switch repriced an existing hold'; end if;
  if (select expires_at from public.bookings where id=core_id) is distinct from old_core.expires_at
     or (select expires_at from public.bookings where id=group_id) is distinct from old_group.expires_at then
    raise exception 'Promo switch changed hold deadlines';
  end if;
  insert into ps_promo_results values ('Turning promo off preserves both existing hold amounts and deadlines',true);

  perform set_config('request.jwt.claim.sub','',true);
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  session_row := pg_temp.ps_promo_session(court_key,start_at,150,metadata);
  retry_result := public.create_public_booking_core('pickle-street-tugbok','picklestreet.pages.dev',court_key,'regular',
    'TEST ONLY - promo core',null,'00000000000',1,start_at,start_at+interval '1 hour',session_row->'slots',
    150,1,151,'PHP',session_row->'metadata',core_key);
  if (retry_result->>'bookingId')::uuid <> core_id then raise exception 'Core replay created a different booking'; end if;
  retry_result := public.create_public_booking_group_with_access('pickle-street-tugbok','picklestreet.pages.dev','regular',
    'TEST ONLY - promo group',null,'00000000000',1,jsonb_build_array(group_session),
    (group_session->'metadata')||jsonb_build_object('groupFingerprint',group_fingerprint),group_key,group_token_hash);
  if (retry_result->>'bookingId')::uuid <> group_id or (retry_result->>'totalAmount')::numeric <> 151
     or (select count(*) from public.bookings where tenant_id=tenant_key and court_id=court_key) <> 2
     or (select count(*) from public.booking_slots where tenant_id=tenant_key and court_id=court_key and status='held') <> 2 then
    raise exception 'Replay repriced or duplicated existing holds';
  end if;
  insert into ps_promo_results values ('Core and actual group idempotent replays keep the original 151 total',true);

  denied := false;
  session_row := pg_temp.ps_promo_session(court_key,start_at+interval '3 hours',150,metadata);
  begin
    perform public.create_public_booking_group_with_access('pickle-street-tugbok','picklestreet.pages.dev','regular',
      'TEST ONLY - stale promo quote',null,'00000000000',1,jsonb_build_array(session_row),
      (session_row->'metadata')||jsonb_build_object('groupFingerprint',repeat('e',64)),
      'PS-PROMO-STALE-'||gen_random_uuid()::text,replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-',''));
  exception when sqlstate '22023' then
    if sqlerrm not like 'Court subtotal does not match the current protected rate calculation.%' then raise; end if;
    denied := true;
  end;
  if not denied or exists(select 1 from public.booking_slots where court_id=court_key and starts_at=start_at+interval '3 hours') then
    raise exception 'Group route accepted a stale promo price or leaked rejected slots';
  end if;
  insert into ps_promo_results values ('Actual group route rejects stale promo quotes after the switch changes',true);

  session_row := pg_temp.ps_promo_session(court_key,start_at+interval '4 hours',200,metadata);
  result := public.create_public_booking_group_with_access('pickle-street-tugbok','picklestreet.pages.dev','regular',
    'TEST ONLY - regular group',null,'00000000000',1,jsonb_build_array(session_row),
    (session_row->'metadata')||jsonb_build_object('groupFingerprint',repeat('f',64)),
    'PS-REGULAR-GROUP-'||gen_random_uuid()::text,replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-',''));
  new_group_id := (result->>'bookingId')::uuid;
  if (result->>'totalAmount')::numeric <> 201 or not exists(select 1 from public.bookings where id=new_group_id
      and tenant_id=tenant_key and court_id=court_key and subtotal_amount=200 and service_fee_amount=1 and total_amount=201
      and status='pending_payment' and payment_status='unpaid' and customer_email is null) then
    raise exception 'New booking did not use restored regular price and unchanged fee';
  end if;
  if exists(select 1 from public.bookings where id in(core_id,group_id) and total_amount<>151)
     or exists(select 1 from public.booking_email_deliveries where booking_id in(core_id,group_id,new_group_id))
     or exists(select 1 from public.receipt_verifications where booking_id in(core_id,group_id,new_group_id)) then
    raise exception 'Fixture changed old totals or triggered receipt/email work';
  end if;
  insert into ps_promo_results values ('New regular booking charges 201 while earlier promo holds remain 151',true);
end;
$$;
