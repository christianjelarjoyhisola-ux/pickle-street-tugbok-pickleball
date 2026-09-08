-- Pickle Street only: one owner, capability and reference for atomic court sessions.
begin;
create function public.create_picklestreet_group_hold(
 p_hostname text,p_client_request_id uuid,p_access_token_hash text,p_client_ip_hash text,p_sessions jsonb
) returns jsonb language plpgsql security definer set search_path='' set row_security=off as $$
declare
 tenant_key uuid:=public.picklestreet_hold_context(p_hostname);
 held public.picklestreet_provisional_holds%rowtype;
 parent public.bookings%rowtype;
 child public.bookings%rowtype;
 billing public.tenant_platform_billing%rowtype;
 session jsonb; result jsonb; sessions jsonb:='[]'; identity_json jsonb;
 fingerprint text; primary_id uuid; first_start timestamptz; last_end timestamptz;
 subtotal numeric:=0; fee numeric; hours integer:=0; idx integer:=0; currency_code text; day_key date; zone text;
begin
 if p_client_request_id is null or p_access_token_hash is null or p_access_token_hash !~ '^[a-f0-9]{64}$'
  or p_client_ip_hash is null or p_client_ip_hash !~ '^[a-f0-9]{64}$'
  or p_sessions is null or jsonb_typeof(p_sessions)<>'array' or jsonb_array_length(p_sessions) not between 1 and 18 then
  raise exception 'PICKLESTREET_HOLD_INPUT_INVALID' using errcode='22023';end if;
 select jsonb_agg(jsonb_build_object('courtId',s->>'courtId','startsAt',s->>'startsAt','endsAt',s->>'endsAt','slots',s->'slots') order by s->>'courtId',s->>'startsAt')
 into identity_json from jsonb_array_elements(p_sessions) s;
 fingerprint:=encode(extensions.digest(identity_json::text,'sha256'),'hex');
 perform pg_advisory_xact_lock(hashtextextended('picklestreet-hold-request:'||p_client_request_id::text,0));
 select * into held from public.picklestreet_provisional_holds where tenant_id=tenant_key and client_request_id=p_client_request_id;
 if found then
  if held.token_hash is distinct from p_access_token_hash or held.selection_sha256 is distinct from fingerprint then
   raise exception 'PICKLESTREET_HOLD_IDEMPOTENCY_CONFLICT' using errcode='22023';end if;
  return public.picklestreet_hold_result(held.booking_id)||jsonb_build_object('idempotent',true);
 end if;
 perform pg_advisory_xact_lock(hashtextextended('picklestreet-hold-ip:'||p_client_ip_hash,0));
 if (select count(*) from public.picklestreet_provisional_holds where tenant_id=tenant_key and client_ip_hash=p_client_ip_hash and created_at>clock_timestamp()-interval '15 minutes')>=10 then
  raise exception 'PICKLESTREET_HOLD_RATE_LIMITED' using errcode='22023';end if;
 if (public.tenant_booking_activation_state(tenant_key)->'publicBookingEnabled') is distinct from 'true'::jsonb then
  raise exception 'PICKLESTREET_BOOKING_NOT_READY' using errcode='22023';end if;
 select timezone into strict zone from public.tenants where id=tenant_key;
 select * into strict billing from public.tenant_platform_billing where tenant_id=tenant_key for share;
 -- Deterministic order prevents opposite-order concurrent requests from deadlocking.
 for session in select value from jsonb_array_elements(p_sessions) order by value->>'courtId',value->>'startsAt' loop
  idx:=idx+1;
  if jsonb_typeof(session->'slots') is distinct from 'array' or jsonb_typeof(session->'metadata') is distinct from 'object' then
   raise exception 'PICKLESTREET_HOLD_INPUT_INVALID' using errcode='22023';end if;
  hours:=hours+jsonb_array_length(session->'slots');
  if hours>18 then raise exception 'PICKLESTREET_HOLD_INPUT_INVALID' using errcode='22023';end if;
  if day_key is null then day_key:=((session->>'startsAt')::timestamptz at time zone zone)::date;
  elsif day_key<>((session->>'startsAt')::timestamptz at time zone zone)::date then
   raise exception 'PICKLESTREET_HOLD_INPUT_INVALID' using errcode='22023';end if;
  result:=public.create_public_booking('pickle-street-tugbok',p_hostname,(session->>'courtId')::uuid,'regular',
   'Reservation pending',null,'Pending',1,(session->>'startsAt')::timestamptz,(session->>'endsAt')::timestamptz,session->'slots',
   (session->>'subtotalAmount')::numeric,(session->>'serviceFeeAmount')::numeric,(session->>'totalAmount')::numeric,session->>'currency',
   session->'metadata','PS-GROUP-'||p_client_request_id::text||':'||idx);
  select * into strict child from public.bookings where tenant_id=tenant_key and id=(result->>'bookingId')::uuid;
  if primary_id is null then primary_id:=child.id;currency_code:=child.currency;
  else
   if child.currency<>currency_code then raise exception 'PICKLESTREET_HOLD_INPUT_INVALID' using errcode='22023';end if;
   update public.booking_slots set booking_id=primary_id where tenant_id=tenant_key and booking_id=child.id;
   delete from public.bookings where tenant_id=tenant_key and id=child.id;
  end if;
  first_start:=least(first_start,child.starts_at);last_end:=greatest(last_end,child.ends_at);subtotal:=subtotal+child.subtotal_amount;
  sessions:=sessions||jsonb_build_array(jsonb_build_object('courtId',child.court_id,
   'courtName',(select name from public.courts where tenant_id=tenant_key and id=child.court_id),
   'bookingDate',to_char(child.starts_at at time zone zone,'YYYY-MM-DD'),'startTime',to_char(child.starts_at at time zone zone,'HH24:MI'),
   'durationHours',jsonb_array_length(session->'slots'),'startsAt',child.starts_at,'endsAt',child.ends_at,'subtotalAmount',child.subtotal_amount));
 end loop;
 fee:=round(case billing.fee_mode when 'fixed_per_booking' then billing.fee_amount when 'fixed_per_hour' then billing.fee_amount*hours
  when 'percentage' then subtotal*billing.fee_amount/100 end,2);
 if fee is null then raise exception 'PICKLESTREET_HOLD_INPUT_INVALID' using errcode='22023';end if;
 update public.bookings set starts_at=first_start,ends_at=last_end,subtotal_amount=subtotal,service_fee_amount=fee,total_amount=subtotal+fee,
  metadata=jsonb_build_object('source','picklestreet_provisional_hold','clientRequestId',p_client_request_id,'picklestreetProvisionalHold',true,
   'atomicMultiSessionBookingV1',true,'sessions',sessions,'courtHours',hours,'courtSubtotalAmount',subtotal,'equipmentRentalFeeAmount',0,
   'equipmentRental',jsonb_build_object('extraPaddles',0,'balls',0),'fullPaymentOnly',true,
   'courtName',(select string_agg(distinct s->>'courtName',', ' order by s->>'courtName') from jsonb_array_elements(sessions) s))
  where tenant_id=tenant_key and id=primary_id returning * into parent;
 update public.booking_slots set hold_expires_at=parent.expires_at where tenant_id=tenant_key and booking_id=primary_id;
 insert into public.picklestreet_provisional_holds(tenant_id,booking_id,client_request_id,token_hash,client_ip_hash,selection_sha256,access_expires_at,hold_expires_at)
 values(tenant_key,primary_id,p_client_request_id,p_access_token_hash,p_client_ip_hash,fingerprint,greatest(last_end+interval '30 days',clock_timestamp()+interval '1 day'),parent.expires_at);
 return public.picklestreet_hold_result(primary_id)||jsonb_build_object('idempotent',false);
end;$$;
revoke all on function public.create_picklestreet_group_hold(text,uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.create_picklestreet_group_hold(text,uuid,text,text,jsonb) to service_role;
-- Tenant-only projection and completion updates appended below by the release author.

create or replace function public.picklestreet_hold_result(p_booking_id uuid)
returns jsonb language plpgsql security definer set search_path='' set row_security=off as $$
declare v_result jsonb;
begin
-- Promotion must not leave a second, unrevocable copy of the normal capability.
-- The live token table uses deletion, token_hash rotation and expires_at (no revoked_at).
if exists(select 1 from public.picklestreet_provisional_holds h
  where h.tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid and h.booking_id=p_booking_id
  and h.completed_at is not null and not exists(select 1 from public.booking_access_tokens access
    where access.tenant_id=h.tenant_id and access.booking_id=h.booking_id
      and access.token_hash=h.token_hash and access.expires_at>clock_timestamp())) then
  raise exception 'BOOKING_ACCESS_DENIED' using errcode='42501';
end if;
select jsonb_build_object(
  'bookingId',b.id,'reference',b.reference,'courtId',b.court_id,'courtName',coalesce(b.metadata->>'courtName',c.name),'sessions',coalesce(b.metadata->'sessions','[]'::jsonb),
  'bookingType',b.booking_type,
  'status',case when b.status='pending_payment' and b.expires_at<=clock_timestamp() then 'expired' else b.status end,
  'paymentStatus',b.payment_status,'startsAt',b.starts_at,'endsAt',b.ends_at,
  'expiresAt',coalesce(b.expires_at,h.hold_expires_at),'accessExpiresAt',h.access_expires_at,
  'bookingDate',to_char(b.starts_at at time zone t.timezone,'YYYY-MM-DD'),
  'startTime',to_char(b.starts_at at time zone t.timezone,'HH24:MI'),
  'durationHours',coalesce((b.metadata->>'courtHours')::numeric,extract(epoch from(b.ends_at-b.starts_at))/3600),'tenantTimezone',t.timezone,
  'reservationHeld',b.status='pending_payment' and b.expires_at>clock_timestamp()
    and exists(select 1 from public.booking_slots s where s.tenant_id=b.tenant_id and s.booking_id=b.id and s.balance_request_id is null)
    and not exists(select 1 from public.booking_slots s where s.tenant_id=b.tenant_id and s.booking_id=b.id and s.balance_request_id is null
      and (s.status<>'held' or s.hold_expires_at is null or s.hold_expires_at<=clock_timestamp())),
  'subtotalAmount',b.subtotal_amount,'courtSubtotalAmount',coalesce((b.metadata->>'courtSubtotalAmount')::numeric,b.subtotal_amount),
  'equipmentRentalFeeAmount',coalesce((b.metadata->>'equipmentRentalFeeAmount')::numeric,0),
  'equipmentRental',coalesce(b.metadata->'equipmentRental','{"extraPaddles":0,"balls":0}'::jsonb),
  'serviceFeeAmount',b.service_fee_amount,'totalAmount',b.total_amount,'currency',b.currency,
  'fullPaymentOnly',coalesce((b.metadata->>'fullPaymentOnly')::boolean,true),
  'detailsCompleted',h.completed_at is not null,'provisional',h.completed_at is null,
  'customerName',case when h.completed_at is not null then b.customer_name else null end,
  'customerEmail',case when h.completed_at is not null then b.customer_email else null end,
  'customerPhone',case when h.completed_at is not null then b.customer_phone else null end,
  'guestCount',b.guest_count,'eventType',b.metadata->'eventType','eventSetupNotes',b.metadata->'eventSetupNotes',
  'slots',coalesce((select jsonb_agg(jsonb_build_object('courtId',s.court_id,'startsAt',s.starts_at,'endsAt',s.ends_at,
    'status',case when s.status='held' and s.hold_expires_at<=clock_timestamp() then 'expired' else s.status end)
    order by s.starts_at) from public.booking_slots s where s.tenant_id=b.tenant_id and s.booking_id=b.id),'[]'::jsonb)
) into v_result
from public.picklestreet_provisional_holds h
join public.bookings b on b.tenant_id=h.tenant_id and b.id=h.booking_id
join public.courts c on c.tenant_id=b.tenant_id and c.id=b.court_id
join public.tenants t on t.id=b.tenant_id
where h.tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid and h.booking_id=p_booking_id;
return v_result;
end;
$$;
revoke all on function public.picklestreet_hold_result(uuid) from public,anon,authenticated;


CREATE OR REPLACE FUNCTION public.complete_picklestreet_provisional_hold(p_hostname text, p_booking_reference text, p_access_token_hash text, p_customer_name text, p_customer_email text, p_customer_phone text, p_policy_accepted boolean, p_policy_version text, p_policy_sha256 text, p_guest_count integer DEFAULT 1, p_event_type text DEFAULT NULL::text, p_event_setup_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET row_security TO 'off'
AS $function$
declare
  v_tenant uuid:=public.picklestreet_hold_context(p_hostname);v_hold public.picklestreet_provisional_holds%rowtype;
  v_booking public.bookings%rowtype;v_court public.courts%rowtype;v_policy public.settings%rowtype;
  v_id uuid;v_hash text;v_complete_hash text;v_name text:=btrim(p_customer_name);
  v_email text:=lower(btrim(p_customer_email));v_phone text:=btrim(p_customer_phone);
  v_event_type text:=nullif(btrim(p_event_type),'');v_notes text:=nullif(btrim(p_event_setup_notes),'');
  v_max_guests integer;v_count integer;v_expected_count integer;
begin
  if char_length(coalesce(v_name,'')) not between 2 and 100
    or char_length(coalesce(v_email,'')) not between 5 and 254 or v_email !~ '^[^[:space:]@<>]+@[^[:space:]@<>]+[.][^[:space:]@<>]+$'
    or char_length(coalesce(v_phone,'')) not between 7 and 30 or v_phone !~ '^[+0-9][0-9 ()+.-]{6,29}$'
    or p_guest_count is null or p_guest_count not between 1 and 500
    or char_length(coalesce(v_event_type,''))>100 or char_length(coalesce(v_notes,''))>1000
    or p_policy_accepted is distinct from true or p_policy_version is null or p_policy_sha256 is null
    or p_policy_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception 'PICKLESTREET_CUSTOMER_DETAILS_INVALID' using errcode='22023';end if;
  select h.booking_id into v_id from public.picklestreet_provisional_holds h join public.bookings b on b.tenant_id=h.tenant_id and b.id=h.booking_id
    where h.tenant_id=v_tenant and b.reference=upper(btrim(p_booking_reference)) and h.token_hash=p_access_token_hash and h.access_expires_at>clock_timestamp();
  if not found then raise exception 'BOOKING_ACCESS_DENIED' using errcode='42501';end if;
  perform pg_advisory_xact_lock(hashtextextended('picklestreet-receipt:'||v_id::text,0));
  select * into strict v_booking from public.bookings b where b.tenant_id=v_tenant and b.id=v_id for update;
  select * into strict v_hold from public.picklestreet_provisional_holds h where h.tenant_id=v_tenant and h.booking_id=v_id for update;
  v_complete_hash:=encode(extensions.digest(jsonb_build_object('name',v_name,'email',v_email,'phone',v_phone,
    'guestCount',p_guest_count,'eventType',v_event_type,'eventSetupNotes',v_notes,
    'policyVersion',p_policy_version,'policySha256',p_policy_sha256)::text,'sha256'),'hex');
  if v_hold.completed_at is not null then
    if v_hold.completion_sha256 is distinct from v_complete_hash then
      raise exception 'PICKLESTREET_HOLD_COMPLETION_CONFLICT' using errcode='22023';end if;
    -- Lost completion response: do not reprice, rewrite policy, mutate details or mint a new token.
    return public.picklestreet_hold_result(v_id)||jsonb_build_object('idempotent',true);
  end if;
  if v_booking.status<>'pending_payment' or v_booking.payment_status<>'unpaid'
    or v_booking.expires_at is null or v_booking.expires_at<=clock_timestamp() or v_booking.starts_at<=clock_timestamp() then
    raise exception 'PICKLESTREET_HOLD_EXPIRED' using errcode='22023';end if;
  perform 1 from public.booking_slots s where s.tenant_id=v_tenant and s.booking_id=v_id order by s.starts_at for update;
  select count(*) into v_count from public.booking_slots s where s.tenant_id=v_tenant and s.booking_id=v_id
    and s.status='held' and s.hold_expires_at=v_booking.expires_at and s.hold_expires_at>clock_timestamp();
  v_expected_count:=coalesce((v_booking.metadata->>'courtHours')::integer,extract(epoch from(v_booking.ends_at-v_booking.starts_at))::integer/3600);
  if v_count<>v_expected_count or exists(select 1 from public.payment_sessions where tenant_id=v_tenant and booking_id=v_id)
    or exists(select 1 from public.receipt_verifications where tenant_id=v_tenant and booking_id=v_id) then
    raise exception 'PICKLESTREET_HOLD_NOT_ACTIVE' using errcode='22023';end if;
  select * into strict v_court from public.courts c where c.tenant_id=v_tenant and c.id=v_booking.court_id for share;
  v_max_guests:=coalesce((v_court.pricing_config#>>array[v_booking.booking_type,'maximumGuests'])::integer,
    case when v_booking.booking_type='event' then 50 else 500 end);
  if p_guest_count>v_max_guests then raise exception 'GUEST_LIMIT_EXCEEDED' using errcode='22023';end if;
  if v_booking.booking_type='event' then
    if v_event_type is null or not public.has_valid_event_booking_config(v_court.pricing_config)
      or not exists(select 1 from public.tenants t where t.id=v_tenant and t.public_config->'eventBookingEnabled'='true'::jsonb) then
      raise exception 'EVENT_BOOKING_UNAVAILABLE' using errcode='22023';end if;
  elsif v_event_type is not null then raise exception 'PICKLESTREET_CUSTOMER_DETAILS_INVALID' using errcode='22023';end if;
  select * into v_policy from public.settings s where s.tenant_id=v_tenant and s.key='refund_reschedule_policy' for share;
  if v_policy.id is null or v_policy.is_public is distinct from true then
    raise exception 'booking_policy_not_configured' using errcode='22023';end if;
  v_hash:=public.refund_reschedule_policy_sha256(v_policy.value);
  if v_hash is null then raise exception 'booking_policy_not_configured' using errcode='22023';end if;
  if p_policy_version is distinct from v_policy.value->>'version' then
    raise exception 'booking_policy_version_stale' using errcode='22023';end if;
  if p_policy_sha256 is distinct from v_hash then raise exception 'booking_policy_evidence_mismatch' using errcode='22023';end if;
  perform set_config('app.picklestreet_hold_complete',v_id::text,true);
  update public.bookings set customer_name=v_name,customer_email=v_email,customer_phone=v_phone,guest_count=p_guest_count,
    metadata=metadata||jsonb_build_object('picklestreetProvisionalHold',false,'notes',nullif(concat_ws(' - ',v_event_type,v_notes),''),
      'eventType',v_event_type,'eventSetupNotes',v_notes,'policyAcceptance',jsonb_build_object('accepted',true,'version',p_policy_version,'sha256',v_hash))
    where tenant_id=v_tenant and id=v_id;
  -- The existing AFTER INSERT trigger records the authentic current policy snapshot.
  insert into public.booking_access_tokens(tenant_id,booking_id,token_hash,expires_at)
    values(v_tenant,v_id,v_hold.token_hash,v_hold.access_expires_at);
  update public.picklestreet_provisional_holds set completed_at=clock_timestamp(),completion_sha256=v_complete_hash where tenant_id=v_tenant and booking_id=v_id;
  perform set_config('app.picklestreet_hold_complete','',true);
  return public.picklestreet_hold_result(v_id)||jsonb_build_object('idempotent',false);
end;$function$;


create function public.assert_picklestreet_group_slots(p_booking_id uuid)
returns void language plpgsql security definer set search_path='' set row_security=off as $$
declare b public.bookings%rowtype;zone text;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'BOOKING_ACCESS_DENIED' using errcode='42501';end if;
 select * into strict b from public.bookings where tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a' and id=p_booking_id;
 select timezone into strict zone from public.tenants where id=b.tenant_id;
 if b.metadata->'atomicMultiSessionBookingV1' is distinct from 'true'::jsonb then raise exception 'reservation_slots_changed' using errcode='22023';end if;
 if exists(
  with expected as (select (s->>'courtId')::uuid court_id,g starts_at,g+interval '1 hour' ends_at from jsonb_array_elements(b.metadata->'sessions') s,
   lateral generate_series((s->>'startsAt')::timestamptz,(s->>'endsAt')::timestamptz-interval '1 hour',interval '1 hour') g),
  actual as (select court_id,starts_at,ends_at from public.booking_slots where tenant_id=b.tenant_id and booking_id=b.id and balance_request_id is null)
  select * from ((select * from expected except all select * from actual) union all (select * from actual except all select * from expected)) difference
 ) or exists(select 1 from public.booking_slots where tenant_id=b.tenant_id and booking_id=b.id and (status not in('held','expired') or balance_request_id is not null)) then
  raise exception 'reservation_slots_changed' using errcode='22023';end if;
 perform 1 from public.courts c where c.tenant_id=b.tenant_id and exists(select 1 from public.booking_slots s where s.booking_id=b.id and s.tenant_id=b.tenant_id and s.court_id=c.id) for share;
 if exists(select 1 from public.booking_slots s left join public.courts c on c.id=s.court_id and c.tenant_id=s.tenant_id
  where s.tenant_id=b.tenant_id and s.booking_id=b.id and (c.id is null or c.status<>'active')) then
  raise exception 'reservation_court_unavailable' using errcode='22023';end if;
 if exists(select 1 from public.booking_slots s join public.blocked_dates d on d.tenant_id=s.tenant_id and(d.court_id is null or d.court_id=s.court_id)
  where s.tenant_id=b.tenant_id and s.booking_id=b.id and tsrange(s.starts_at at time zone zone,s.ends_at at time zone zone,'[)') &&
  case when d.starts_at is null then tsrange(d.blocked_on::timestamp,(d.blocked_on+1)::timestamp,'[)') else
   tsrange(d.blocked_on+d.starts_at,case when d.ends_at=time '23:59:59' then(d.blocked_on+1)::timestamp else d.blocked_on+d.ends_at end,'[)') end) then
  raise exception 'reservation_court_blocked' using errcode='22023';end if;
 if exists(select 1 from public.booking_slots s join public.court_occupancies o on o.tenant_id=s.tenant_id and o.court_id=s.court_id and o.starts_at<s.ends_at and o.ends_at>s.starts_at
  where s.tenant_id=b.tenant_id and s.booking_id=b.id and(o.status='confirmed' or(o.status='held' and o.hold_expires_at>clock_timestamp()))
  and not(o.source_kind='booking_slot' and exists(select 1 from public.booking_slots own where own.tenant_id=b.tenant_id and own.booking_id=b.id and own.id=o.source_id))) then
  raise exception 'reservation_time_unavailable' using errcode='22023';end if;
end;$$;
revoke all on function public.assert_picklestreet_group_slots(uuid) from public,anon,authenticated;

create function public.guard_picklestreet_group_schedule()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if old.tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a' and old.metadata->'atomicMultiSessionBookingV1'='true'::jsonb
  and(new.court_id is distinct from old.court_id or new.starts_at is distinct from old.starts_at or new.ends_at is distinct from old.ends_at
   or new.metadata->'sessions' is distinct from old.metadata->'sessions') then
  raise exception 'Multi-session bookings require a grouped reschedule; a single-court change is not allowed.' using errcode='22023';end if;
 return new;
end;$$;
revoke all on function public.guard_picklestreet_group_schedule() from public,anon,authenticated;
create trigger zzzz_picklestreet_group_schedule before update on public.bookings for each row execute function public.guard_picklestreet_group_schedule();

CREATE OR REPLACE FUNCTION public.review_picklestreet_pending_receipt(p_verification_id uuid, p_expected_attempt_id uuid, p_idempotency_key uuid, p_decision text, p_review_note text, p_actor_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET row_security TO 'off'
AS $function$
declare
 t constant uuid:='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';
 r public.receipt_verifications%rowtype;b public.bookings%rowtype;s public.payment_sessions%rowtype;
 q public.booking_balance_requests%rowtype;j public.picklestreet_receipt_jobs%rowtype;
 bj public.picklestreet_balance_receipt_jobs%rowtype;d public.picklestreet_receipt_staff_reviews%rowtype;
 e public.booking_reschedule_events%rowtype;
 authorized boolean:=false;zone text;v_note text:=btrim(p_review_note);
 target_start timestamptz;target_end timestamptz;target_count integer;target_duration numeric;
 target_min timestamptz;target_max timestamptz;active_count integer;
 new_total numeric;new_subtotal numeric;reschedule_id uuid;restored boolean:=false;
 v_result jsonb;prior_claims text;prior_sub text;prior_marker text;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'PICKLESTREET_SERVICE_REQUIRED' using errcode='42501';end if;
 if p_verification_id is null or p_expected_attempt_id is null or p_idempotency_key is null or p_actor_user_id is null
   or p_decision is null or p_decision not in('approve','reject') or v_note is null or char_length(v_note) not between 3 and 1000 then
   raise exception 'STAFF_REVIEW_INVALID' using errcode='22023';end if;
 perform 1 from public.tenant_memberships where tenant_id=t and user_id=p_actor_user_id and status='active'
   and role in('owner','admin','staff') for share;
 authorized:=found;
 perform 1 from public.platform_profiles where user_id=p_actor_user_id and is_platform_owner for share;
 authorized:=authorized or found;
 if not authorized then raise exception 'TENANT_ACCESS_DENIED' using errcode='42501';end if;
 select timezone into zone from public.tenants where id=t and slug='pickle-street-tugbok' and status='active' for share;
 if not found then raise exception 'TENANT_UNAVAILABLE' using errcode='22023';end if;
 -- Serializes a key even if a caller tries to reuse it on a different payment.
 perform pg_advisory_xact_lock(hashtextextended('picklestreet-staff-review:'||p_idempotency_key::text,0));
 select * into d from public.picklestreet_receipt_staff_reviews where tenant_id=t and idempotency_key=p_idempotency_key;
 if found then
   if d.verification_id<>p_verification_id or d.expected_attempt_id<>p_expected_attempt_id or d.decision<>p_decision
     or d.review_note<>v_note or d.actor_user_id<>p_actor_user_id then raise exception 'IDEMPOTENCY_CONFLICT' using errcode='22023';end if;
   if d.completed_at is null then raise exception 'STAFF_REVIEW_IN_PROGRESS' using errcode='22023';end if;
   return d.result||jsonb_build_object('idempotent',true);
 end if;
 select * into r from public.receipt_verifications where tenant_id=t and id=p_verification_id;
 if not found then raise exception 'RECEIPT_NOT_FOUND' using errcode='22023';end if;
 -- Use the same lock and row order as automatic finalization.
 if r.balance_request_id is null then
   perform pg_advisory_xact_lock(hashtextextended('picklestreet-receipt:'||r.booking_id::text,0));
 else
   perform pg_advisory_xact_lock(hashtextextended('picklestreet-balance:'||r.balance_request_id::text,0));
 end if;
 select * into r from public.receipt_verifications where tenant_id=t and id=p_verification_id for update;
 if r.balance_request_id is not null then
   select * into q from public.booking_balance_requests where tenant_id=t and id=r.balance_request_id and booking_id=r.booking_id for update;
   if not found then raise exception 'BALANCE_CONTEXT_CHANGED' using errcode='22023';end if;
 end if;
 select * into b from public.bookings where tenant_id=t and id=r.booking_id for update;
 if not found or b.archived_at is not null then raise exception 'BOOKING_NOT_REVIEWABLE' using errcode='22023';end if;
 select * into s from public.payment_sessions where tenant_id=t and id=r.payment_session_id and booking_id=b.id for update;
 if not found or s.status not in('created','pending') or s.currency<>b.currency or s.amount<>r.expected_amount
   or r.status not in('pending','manual_review') or nullif(btrim(r.storage_path),'') is null then
   raise exception 'RECEIPT_NOT_PENDING' using errcode='22023';end if;
 if exists(select 1 from public.picklestreet_receipt_staff_reviews where tenant_id=t and verification_id=r.id) then
   raise exception 'STAFF_REVIEW_ALREADY_DECIDED' using errcode='22023';end if;
 if q.id is null then
   select * into j from public.picklestreet_receipt_jobs where tenant_id=t and booking_id=b.id for update;
   if not found or j.receipt_id is distinct from r.id or j.current_attempt_id is distinct from p_expected_attempt_id then
     raise exception 'RECEIPT_CHANGED' using errcode='22023';end if;
   if b.status not in('pending_payment','payment_review','expired') or b.payment_status<>'pending'
     or s.provider<>'manual_receipt' or s.amount<>b.total_amount
     or exists(select 1 from public.booking_balance_requests where tenant_id=t and booking_id=b.id and status in('awaiting_payment','payment_review')) then
     raise exception 'BOOKING_PAYMENT_CONTEXT_CHANGED' using errcode='22023';end if;
   if not exists(select 1 from public.picklestreet_receipt_attempts where tenant_id=t and id=p_expected_attempt_id
     and booking_id=b.id and receipt_id=r.id and version=j.version and storage_path=r.storage_path) then
     raise exception 'RECEIPT_CHANGED' using errcode='22023';end if;
 else
   select * into bj from public.picklestreet_balance_receipt_jobs where tenant_id=t and booking_id=b.id and balance_request_id=q.id for update;
   if not found or bj.receipt_id is distinct from r.id or bj.current_attempt_id is distinct from p_expected_attempt_id
     or bj.closed_at is not null or bj.settled_at is not null then raise exception 'RECEIPT_CHANGED' using errcode='22023';end if;
   if q.status not in('awaiting_payment','payment_review','expired') or q.remaining_amount<>bj.expected_amount
     or q.currency<>bj.currency or s.amount<>q.remaining_amount or s.currency<>q.currency
     or s.provider<>'manual_balance_receipt' or s.provider_payload->>'balanceRequestId' is distinct from q.id::text then
     raise exception 'BALANCE_CONTEXT_CHANGED' using errcode='22023';end if;
   if not exists(select 1 from public.picklestreet_balance_receipt_attempts where tenant_id=t and id=p_expected_attempt_id
     and booking_id=b.id and balance_request_id=q.id and receipt_id=r.id and version=bj.version and storage_path=r.storage_path) then
     raise exception 'RECEIPT_CHANGED' using errcode='22023';end if;
   if q.request_type='reschedule_adjustment' then
     if b.status not in('confirmed','completed') or b.payment_status<>'paid' or b.starts_at is distinct from bj.original_starts_at
       or b.ends_at is distinct from bj.original_ends_at or b.total_amount<>q.accepted_amount then
       raise exception 'ORIGINAL_BOOKING_CHANGED' using errcode='22023';end if;
   elsif q.request_type='short_payment' then
     if b.status not in('payment_review','expired') or b.payment_status not in('partial','pending')
       or q.accepted_amount+q.remaining_amount<>b.total_amount then raise exception 'BALANCE_BOOKING_CHANGED' using errcode='22023';end if;
   else raise exception 'BALANCE_CONTEXT_CHANGED' using errcode='22023';end if;
 end if;
 insert into public.picklestreet_receipt_staff_reviews(tenant_id,booking_id,verification_id,payment_session_id,balance_request_id,
   expected_attempt_id,idempotency_key,decision,review_note,actor_user_id,before_state)
 values(t,b.id,r.id,s.id,q.id,p_expected_attempt_id,p_idempotency_key,p_decision,v_note,p_actor_user_id,
   jsonb_build_object('receipt',to_jsonb(r),'booking',to_jsonb(b),'payment',to_jsonb(s),'balance',case when q.id is null then null else to_jsonb(q) end)) returning * into d;
 prior_marker:=current_setting('app.picklestreet_staff_review',true);
 perform set_config('app.picklestreet_staff_review',d.authorization_token::text,true);
 -- Set the already-authorized actor for existing audit/past-booking checks.
 prior_claims:=current_setting('request.jwt.claims',true);prior_sub:=current_setting('request.jwt.claim.sub',true);
 perform set_config('request.jwt.claims',(coalesce(nullif(prior_claims,''),'{}')::jsonb||jsonb_build_object('role','service_role','sub',p_actor_user_id))::text,true);
 perform set_config('request.jwt.claim.sub',p_actor_user_id::text,true);
 if p_decision='approve' then
   if b.checked_in_at is not null then raise exception 'booking_checked_in' using errcode='22023';end if;
   if q.request_type='reschedule_adjustment' then
     if b.status<>'confirmed' or(q.request_details->>'oldStartsAt')::timestamptz is distinct from b.starts_at
       or(q.request_details->>'oldEndsAt')::timestamptz is distinct from b.ends_at then raise exception 'original_booking_changed' using errcode='22023';end if;
     target_start:=(q.request_details->>'newStartsAt')::timestamptz;target_end:=(q.request_details->>'newEndsAt')::timestamptz;
     new_subtotal:=(q.request_details->>'newSubtotalAmount')::numeric;new_total:=(q.request_details->>'newTotalAmount')::numeric;
     if new_total is null or new_subtotal is null or new_total<>q.accepted_amount+q.remaining_amount or new_total<>new_subtotal+b.service_fee_amount
       or(q.request_details->>'newLocalDate')::date is distinct from(target_start at time zone zone)::date then
       raise exception 'reschedule_price_changed' using errcode='22023';end if;
   else
     target_start:=b.starts_at;target_end:=b.ends_at;
     if q.request_type='short_payment' and not exists(select 1 from public.receipt_verifications original join public.payment_sessions payment
       on payment.tenant_id=original.tenant_id and payment.id=original.payment_session_id
       where original.tenant_id=t and original.id=q.original_verification_id and original.status='short_payment' and payment.status='paid') then
       raise exception 'original_payment_unverified' using errcode='22023';end if;
   end if;
   if target_start is null or target_end is null or not isfinite(target_start) or not isfinite(target_end) or target_end<=target_start
     or target_end-target_start<>b.ends_at-b.starts_at then raise exception 'reservation_slots_changed' using errcode='22023';end if;
   if target_start<=clock_timestamp() or b.starts_at<=clock_timestamp() then raise exception 'booking_started' using errcode='22023';end if;
   perform set_config('lock_timeout','1000ms',true);
   lock table public.blocked_dates in share mode;
   perform 1 from public.courts where tenant_id=t and id=b.court_id and status='active' for share;
   if not found then raise exception 'reservation_court_unavailable' using errcode='22023';end if;
   perform slot.id from public.booking_slots slot where slot.tenant_id=t and slot.booking_id=b.id order by slot.starts_at,slot.id for update;
   select count(*),coalesce(sum(extract(epoch from(ends_at-starts_at))),0),min(starts_at),max(ends_at),
     count(*) filter(where status='held' and hold_expires_at>clock_timestamp())
   into target_count,target_duration,target_min,target_max,active_count from public.booking_slots where tenant_id=t and booking_id=b.id
     and(case when q.request_type='reschedule_adjustment' then balance_request_id=q.id else balance_request_id is null end);
   if b.metadata->'atomicMultiSessionBookingV1'='true'::jsonb and q.id is null then
     perform public.assert_picklestreet_group_slots(b.id);
   else
   if target_count<1 or target_duration<>extract(epoch from(target_end-target_start)) or target_min<>target_start or target_max<>target_end
     or exists(select 1 from public.booking_slots where tenant_id=t and booking_id=b.id
       and(case when q.request_type='reschedule_adjustment' then balance_request_id=q.id else balance_request_id is null end)
       and(status not in('held','expired') or court_id<>b.court_id or starts_at<target_start or ends_at>target_end))
     or exists(select 1 from public.booking_slots one join public.booking_slots two on two.tenant_id=one.tenant_id
       and two.booking_id=one.booking_id and two.id<>one.id and two.starts_at<one.ends_at and two.ends_at>one.starts_at
       where one.tenant_id=t and one.booking_id=b.id
       and(case when q.request_type='reschedule_adjustment' then one.balance_request_id=q.id and two.balance_request_id=q.id
         else one.balance_request_id is null and two.balance_request_id is null end)) then
     raise exception 'reservation_slots_changed' using errcode='22023';end if;
   if exists(select 1 from public.blocked_dates blocked where blocked.tenant_id=t and(blocked.court_id is null or blocked.court_id=b.court_id)
     and blocked.blocked_on between(target_start at time zone zone)::date and((target_end-interval '1 microsecond') at time zone zone)::date
     and tsrange(target_start at time zone zone,target_end at time zone zone,'[)') && case when blocked.starts_at is null then
       tsrange(blocked.blocked_on::timestamp,(blocked.blocked_on+1)::timestamp,'[)') else tsrange(blocked.blocked_on+blocked.starts_at,
       case when blocked.ends_at=time '23:59:59' then(blocked.blocked_on+1)::timestamp else blocked.blocked_on+blocked.ends_at end,'[)') end) then
     raise exception 'reservation_court_blocked' using errcode='22023';end if;
   if exists(select 1 from public.court_occupancies occupancy where occupancy.tenant_id=t and occupancy.court_id=b.court_id
     and occupancy.starts_at<target_end and occupancy.ends_at>target_start
     and(occupancy.status='confirmed' or(occupancy.status='held' and occupancy.hold_expires_at>clock_timestamp()))
     and not(occupancy.source_kind='booking_slot' and exists(select 1 from public.booking_slots own where own.tenant_id=t
       and own.booking_id=b.id and own.id=occupancy.source_id
       and(case when q.request_type='reschedule_adjustment' then own.balance_request_id=q.id else own.balance_request_id is null end)))) then
     raise exception 'reservation_time_unavailable' using errcode='22023';end if;
   end if;
   if target_start<=clock_timestamp() or b.starts_at<=clock_timestamp() then raise exception 'booking_started' using errcode='22023';end if;
   restored:=active_count<>target_count;
   if q.request_type='reschedule_adjustment' then
     if not exists(select 1 from public.booking_slots where tenant_id=t and booking_id=b.id and balance_request_id is null)
       or(select coalesce(sum(extract(epoch from(ends_at-starts_at))),0) from public.booking_slots where tenant_id=t and booking_id=b.id and balance_request_id is null)<>extract(epoch from(b.ends_at-b.starts_at))
       or exists(select 1 from public.booking_slots where tenant_id=t and booking_id=b.id and balance_request_id is null
         and(status<>'confirmed' or court_id<>b.court_id or starts_at<b.starts_at or ends_at>b.ends_at)) then
       raise exception 'original_booking_changed' using errcode='22023';end if;
     insert into public.booking_reschedule_events(tenant_id,booking_id,court_id,rescheduled_by,reason_code,public_reason,internal_note,notify_customer,
       customer_email_snapshot,old_starts_at,old_ends_at,new_starts_at,new_ends_at,subtotal_amount,service_fee_amount,total_amount,currency,idempotency_key,email_status)
     values(t,b.id,b.court_id,p_actor_user_id,q.request_details->>'reasonCode',q.request_details->>'publicReason',nullif(q.request_details->>'internalNote',''),
       coalesce((q.request_details->>'notifyCustomer')::boolean,false),nullif(lower(btrim(b.customer_email)),''),b.starts_at,b.ends_at,target_start,target_end,
       new_subtotal,b.service_fee_amount,new_total,b.currency,(q.request_details->>'idempotencyKey')::uuid,'not_requested') returning * into e;
     reschedule_id:=e.id;
     delete from public.booking_slots where tenant_id=t and booking_id=b.id and balance_request_id is null;
     update public.booking_slots set status='confirmed',hold_expires_at=null,balance_request_id=null where tenant_id=t and booking_id=b.id and balance_request_id=q.id;
     update public.bookings set starts_at=target_start,ends_at=target_end,local_booking_date=(q.request_details->>'newLocalDate')::date,
       subtotal_amount=new_subtotal,total_amount=new_total,metadata=metadata||jsonb_build_object('lastReschedule',jsonb_build_object(
         'eventId',e.id,'reasonCode',e.reason_code,'publicReason',e.public_reason,'rescheduledBy',p_actor_user_id,'rescheduledAt',e.created_at,
         'oldStartsAt',e.old_starts_at,'oldEndsAt',e.old_ends_at,'newStartsAt',e.new_starts_at,'newEndsAt',e.new_ends_at,
         'priceAdjustmentAmount',q.remaining_amount,'staffReceiptReviewId',d.id)) where tenant_id=t and id=b.id;
   else
     update public.booking_slots set status='confirmed',hold_expires_at=null where tenant_id=t and booking_id=b.id and balance_request_id is null;
     update public.bookings set status='confirmed',payment_status='paid',confirmed_at=now(),expires_at=null where tenant_id=t and id=b.id;
   end if;
   update public.receipt_verifications set status='approved',reviewed_at=now(),reviewed_by=p_actor_user_id,
     extracted_data=extracted_data||jsonb_build_object('review',jsonb_build_object('decision','approved','note',v_note),
       'staffReview',jsonb_build_object('reviewId',d.id,'decision','approve','note',v_note,'actorUserId',p_actor_user_id)) where tenant_id=t and id=r.id;
   update public.payment_sessions set status='paid',provider_payload=provider_payload||jsonb_build_object('staffReceiptReviewId',d.id) where tenant_id=t and id=s.id;
   if q.id is not null then
     update public.booking_balance_requests set status='settled',settled_at=now() where tenant_id=t and id=q.id;
     update public.picklestreet_balance_receipt_jobs set settled_at=now(),closed_at=now(),reschedule_event_id=reschedule_id where tenant_id=t and balance_request_id=q.id;
   end if;
 else
   -- Reject only this proof/payment case. Accepted funds are never reversed.
   update public.receipt_verifications set status='rejected',reviewed_at=now(),reviewed_by=p_actor_user_id,
     extracted_data=extracted_data||jsonb_build_object('review',jsonb_build_object('decision','rejected','note',v_note),
       'staffReview',jsonb_build_object('reviewId',d.id,'decision','reject','note',v_note,'actorUserId',p_actor_user_id)) where tenant_id=t and id=r.id;
   update public.payment_sessions set status='failed',provider_payload=provider_payload||jsonb_build_object('staffReceiptReviewId',d.id,'staffRejectionNote',v_note) where tenant_id=t and id=s.id;
   if q.id is null then
     update public.booking_slots set status='cancelled',hold_expires_at=null where tenant_id=t and booking_id=b.id and balance_request_id is null and status in('held','expired');
     update public.bookings set status='cancelled',payment_status='rejected',cancelled_at=now(),expires_at=null,
       metadata=metadata||jsonb_build_object('staffReceiptReviewId',d.id,'paymentRejectionReason',v_note) where tenant_id=t and id=b.id;
   else
     update public.booking_balance_requests set status='cancelled',settled_at=null where tenant_id=t and id=q.id;
     update public.booking_slots set status='cancelled',hold_expires_at=null where tenant_id=t and booking_id=b.id
       and(case when q.request_type='reschedule_adjustment' then balance_request_id=q.id else balance_request_id is null end) and status in('held','expired');
     update public.picklestreet_balance_receipt_jobs set closed_at=now(),hold_released_at=coalesce(hold_released_at,now()) where tenant_id=t and balance_request_id=q.id;
     if q.request_type='short_payment' then
       update public.bookings set status='expired',expires_at=now(),metadata=metadata||jsonb_build_object('staffReceiptReviewId',d.id,'balanceRejectionReason',v_note)
       where tenant_id=t and id=b.id;
     end if;
   end if;
 end if;
 -- Invalidate OCR leases without rewriting immutable receipt-attempt history.
 if q.id is null then
   update public.picklestreet_receipt_jobs set lease_token=null,lease_until=null,updated_at=now() where tenant_id=t and booking_id=b.id;
 else
   update public.picklestreet_balance_receipt_jobs set lease_token=null,lease_until=null,updated_at=now() where tenant_id=t and balance_request_id=q.id;
 end if;
 select * into r from public.receipt_verifications where tenant_id=t and id=r.id;
 select * into b from public.bookings where tenant_id=t and id=b.id;
 if q.id is not null then select * into q from public.booking_balance_requests where tenant_id=t and id=q.id;end if;
 v_result:=jsonb_build_object('ok',true,'status',r.status,'receiptStatus',r.status,'verificationId',r.id,'reviewId',d.id,'decision',p_decision,
   'bookingReference',b.reference,'bookingStatus',b.status,'paymentStatus',b.payment_status,'balanceRequestId',q.id,
   'requestType',q.request_type,'balanceStatus',q.status,'rescheduleEventId',reschedule_id,'reservationRestored',restored,
   'reviewedBy',p_actor_user_id,'reviewedAt',r.reviewed_at,'reviewNote',v_note);
 update public.picklestreet_receipt_staff_reviews set result=v_result,completed_at=clock_timestamp() where tenant_id=t and id=d.id;
 perform set_config('app.picklestreet_staff_review',coalesce(prior_marker,''),true);
 perform set_config('request.jwt.claims',coalesce(prior_claims,''),true);perform set_config('request.jwt.claim.sub',coalesce(prior_sub,''),true);
 return v_result;
end;$function$;

commit;
