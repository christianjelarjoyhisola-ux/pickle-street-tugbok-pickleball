-- PROPOSAL ONLY. Root owns validation and deployment. No existing rows are changed.
begin;

create table public.picklestreet_provisional_holds (
  tenant_id uuid not null default 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'
    check (tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid),
  booking_id uuid primary key,
  client_request_id uuid not null unique,
  token_hash text not null check(token_hash ~ '^[a-f0-9]{64}$'),
  client_ip_hash text not null check(client_ip_hash ~ '^[a-f0-9]{64}$'),
  selection_sha256 text not null check(selection_sha256 ~ '^[a-f0-9]{64}$'),
  access_expires_at timestamptz not null,
  hold_expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  completion_sha256 text check(completion_sha256 ~ '^[a-f0-9]{64}$'),
  constraint picklestreet_hold_token_unique unique(tenant_id,token_hash),
  constraint picklestreet_hold_booking_tenant_fk foreign key(tenant_id,booking_id)
    references public.bookings(tenant_id,id) on delete cascade,
  constraint picklestreet_hold_completion_consistent check
    ((completed_at is null and completion_sha256 is null) or
     (completed_at is not null and completion_sha256 is not null))
);
create index picklestreet_hold_ip_created on public.picklestreet_provisional_holds(client_ip_hash,created_at);
alter table public.picklestreet_provisional_holds enable row level security;
revoke all on public.picklestreet_provisional_holds from public,anon,authenticated;
grant select on public.picklestreet_provisional_holds to service_role;

create function public.picklestreet_hold_context(p_hostname text)
returns uuid language plpgsql security definer set search_path='' set row_security=off as $$
declare v_tenant constant uuid:='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'PICKLESTREET_SERVICE_REQUIRED' using errcode='42501';
  end if;
  if public.resolve_tenant_id('pickle-street-tugbok',p_hostname) is distinct from v_tenant then
    raise exception 'PICKLESTREET_TENANT_ORIGIN_DENIED' using errcode='42501';
  end if;
  return v_tenant;
end;$$;
revoke all on function public.picklestreet_hold_context(text) from public,anon,authenticated;

-- Private projection: callers must first validate hostname and capability.
create function public.picklestreet_hold_result(p_booking_id uuid)
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
  'bookingId',b.id,'reference',b.reference,'courtId',b.court_id,'courtName',c.name,
  'bookingType',b.booking_type,
  'status',case when b.status='pending_payment' and b.expires_at<=clock_timestamp() then 'expired' else b.status end,
  'paymentStatus',b.payment_status,'startsAt',b.starts_at,'endsAt',b.ends_at,
  'expiresAt',coalesce(b.expires_at,h.hold_expires_at),'accessExpiresAt',h.access_expires_at,
  'bookingDate',to_char(b.starts_at at time zone t.timezone,'YYYY-MM-DD'),
  'startTime',to_char(b.starts_at at time zone t.timezone,'HH24:MI'),
  'durationHours',extract(epoch from(b.ends_at-b.starts_at))/3600,'tenantTimezone',t.timezone,
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
  'slots',coalesce((select jsonb_agg(jsonb_build_object('startsAt',s.starts_at,'endsAt',s.ends_at,
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

-- Tenant-only guard. Existing bookings (without a provisional row) return immediately.
create function public.guard_picklestreet_provisional_booking()
returns trigger language plpgsql security definer set search_path='' set row_security=off as $$
declare v_complete boolean;
begin
  if old.tenant_id<>'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid then return new;end if;
  if not exists(select 1 from public.picklestreet_provisional_holds h
    where h.tenant_id=old.tenant_id and h.booking_id=old.id and h.completed_at is null) then return new;end if;
  v_complete:=auth.role()='service_role' and
    coalesce(current_setting('app.picklestreet_hold_complete',true),'')=old.id::text;
  if new.tenant_id is distinct from old.tenant_id or new.court_id is distinct from old.court_id
    or new.reference is distinct from old.reference or new.idempotency_key is distinct from old.idempotency_key
    or new.booking_type is distinct from old.booking_type or new.starts_at is distinct from old.starts_at
    or new.ends_at is distinct from old.ends_at
    or (new.expires_at is distinct from old.expires_at and not(new.status='cancelled' and new.expires_at is null))
    or new.subtotal_amount is distinct from old.subtotal_amount or new.service_fee_amount is distinct from old.service_fee_amount
    or new.total_amount is distinct from old.total_amount or new.currency is distinct from old.currency then
    raise exception 'PICKLESTREET_PROVISIONAL_HOLD_IMMUTABLE' using errcode='22023';
  end if;
  if new.status not in('pending_payment','cancelled','expired') or new.payment_status<>'unpaid' then
    raise exception 'PICKLESTREET_CUSTOMER_DETAILS_REQUIRED' using errcode='22023';
  end if;
  if old.status in('cancelled','expired') and new.status is distinct from old.status then
    raise exception 'PICKLESTREET_PROVISIONAL_HOLD_TERMINAL' using errcode='22023';end if;
  if not v_complete and (new.customer_name is distinct from old.customer_name
    or new.customer_email is distinct from old.customer_email or new.customer_phone is distinct from old.customer_phone
    or new.guest_count is distinct from old.guest_count
    or (new.metadata is distinct from old.metadata and not(
      (new.status='expired' and new.metadata-'expiration'=old.metadata-'expiration') or
      (new.status='cancelled' and new.metadata-'cancellation'=old.metadata-'cancellation')))) then
    raise exception 'PICKLESTREET_CUSTOMER_DETAILS_REQUIRED' using errcode='22023';
  end if;
  return new;
end;$$;
revoke all on function public.guard_picklestreet_provisional_booking() from public,anon,authenticated;
create trigger zzzz_bookings_picklestreet_provisional before update on public.bookings
  for each row execute function public.guard_picklestreet_provisional_booking();

-- Prevent all automatic/manual receipt routes from creating payment state before completion.
create function public.guard_picklestreet_provisional_payment()
returns trigger language plpgsql security definer set search_path='' set row_security=off as $$
begin
  if new.tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid and exists(
    select 1 from public.picklestreet_provisional_holds h
    where h.tenant_id=new.tenant_id and h.booking_id=new.booking_id and h.completed_at is null
  ) then raise exception 'PICKLESTREET_CUSTOMER_DETAILS_REQUIRED' using errcode='22023';end if;
  return new;
end;$$;
revoke all on function public.guard_picklestreet_provisional_payment() from public,anon,authenticated;
create trigger zzzz_payment_sessions_picklestreet_provisional before insert or update on public.payment_sessions
  for each row execute function public.guard_picklestreet_provisional_payment();
create trigger zzzz_receipts_picklestreet_provisional before insert or update on public.receipt_verifications
  for each row execute function public.guard_picklestreet_provisional_payment();

create function public.create_picklestreet_provisional_hold(
  p_hostname text,p_client_request_id uuid,p_access_token_hash text,p_client_ip_hash text,
  p_court_id uuid,p_booking_type text,p_starts_at timestamptz,p_ends_at timestamptz,p_slots jsonb,
  p_subtotal_amount numeric,p_service_fee_amount numeric,p_total_amount numeric,p_currency text,p_metadata jsonb default '{}'
) returns jsonb language plpgsql security definer set search_path='' set row_security=off as $$
declare
  v_tenant uuid:=public.picklestreet_hold_context(p_hostname);
  v_hold public.picklestreet_provisional_holds%rowtype;
  v_booking public.bookings%rowtype;
  v_fingerprint text;
  v_result jsonb;
  v_metadata jsonb;
  v_key text;
begin
  if p_client_request_id is null or p_client_request_id::text !~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
    or p_access_token_hash is null or p_access_token_hash !~ '^[a-f0-9]{64}$'
    or p_client_ip_hash is null or p_client_ip_hash !~ '^[a-f0-9]{64}$'
    or p_booking_type is null or p_booking_type not in('regular','event')
    or p_metadata is null or jsonb_typeof(p_metadata)<>'object' then
    raise exception 'PICKLESTREET_HOLD_INPUT_INVALID' using errcode='22023';
  end if;
  -- Amounts, contact details, policy and server quote timestamps do not identify a selection.
  v_fingerprint:=encode(extensions.digest(jsonb_build_object('courtId',p_court_id,'bookingType',p_booking_type,
    'startsAt',p_starts_at,'endsAt',p_ends_at,'slots',p_slots,
    'equipmentRental',coalesce(p_metadata->'equipmentRental','{"extraPaddles":0,"balls":0}'::jsonb))::text,'sha256'),'hex');
  perform pg_advisory_xact_lock(hashtextextended('picklestreet-hold-request:'||p_client_request_id::text,0));
  select * into v_hold from public.picklestreet_provisional_holds h where h.tenant_id=v_tenant and h.client_request_id=p_client_request_id;
  if found then
    if v_hold.token_hash is distinct from p_access_token_hash or v_hold.selection_sha256 is distinct from v_fingerprint then
      raise exception 'PICKLESTREET_HOLD_IDEMPOTENCY_CONFLICT' using errcode='22023';
    end if;
    return public.picklestreet_hold_result(v_hold.booking_id)||jsonb_build_object('idempotent',true);
  end if;
  perform pg_advisory_xact_lock(hashtextextended('picklestreet-hold-ip:'||p_client_ip_hash,0));
  if (select count(*) from public.picklestreet_provisional_holds h where h.tenant_id=v_tenant
      and h.client_ip_hash=p_client_ip_hash and h.created_at>clock_timestamp()-interval '15 minutes')>=10 then
    raise exception 'PICKLESTREET_HOLD_RATE_LIMITED' using errcode='22023';
  end if;
  if (public.tenant_booking_activation_state(v_tenant)->'publicBookingEnabled') is distinct from 'true'::jsonb then
    raise exception 'PICKLESTREET_BOOKING_NOT_READY' using errcode='22023';
  end if;
  -- Build only a server-owned quote snapshot. Never accept claimed policy or customer fields.
  select coalesce(jsonb_object_agg(entry.key,entry.value),'{}'::jsonb) into v_metadata
  from jsonb_each(p_metadata) entry where entry.key=any(array[
    'rateBreakdown','fullPaymentOnly','equipmentRental','equipmentRentalRates','equipmentRentalFeeAmount','courtSubtotalAmount']);
  v_metadata:=v_metadata||jsonb_build_object('source','picklestreet_provisional_hold',
    'clientRequestId',p_client_request_id,'picklestreetProvisionalHold',true,'notes',null);
  v_key:='PS-HOLD-'||p_client_request_id::text;
  v_result:=public.create_public_booking('pickle-street-tugbok',p_hostname,p_court_id,p_booking_type,
    'Reservation pending',null,'Pending',1,p_starts_at,p_ends_at,p_slots,
    p_subtotal_amount,p_service_fee_amount,p_total_amount,p_currency,v_metadata,v_key);
  select * into strict v_booking from public.bookings b where b.tenant_id=v_tenant and b.id=(v_result->>'bookingId')::uuid;
  insert into public.picklestreet_provisional_holds(tenant_id,booking_id,client_request_id,token_hash,client_ip_hash,
    selection_sha256,access_expires_at,hold_expires_at) values(v_tenant,v_booking.id,p_client_request_id,p_access_token_hash,p_client_ip_hash,
    v_fingerprint,greatest(v_booking.ends_at+interval '30 days',clock_timestamp()+interval '1 day'),v_booking.expires_at);
  return public.picklestreet_hold_result(v_booking.id)||jsonb_build_object('idempotent',false);
end;$$;
revoke all on function public.create_picklestreet_provisional_hold(text,uuid,text,text,uuid,text,timestamptz,timestamptz,jsonb,numeric,numeric,numeric,text,jsonb) from public,anon,authenticated;
grant execute on function public.create_picklestreet_provisional_hold(text,uuid,text,text,uuid,text,timestamptz,timestamptz,jsonb,numeric,numeric,numeric,text,jsonb) to service_role;

create function public.get_picklestreet_provisional_hold(p_hostname text,p_booking_reference text,p_access_token_hash text)
returns jsonb language plpgsql security definer set search_path='' set row_security=off as $$
declare v_tenant uuid:=public.picklestreet_hold_context(p_hostname);v_booking uuid;
begin
  select h.booking_id into v_booking from public.picklestreet_provisional_holds h
    join public.bookings b on b.tenant_id=h.tenant_id and b.id=h.booking_id
    where h.tenant_id=v_tenant and b.reference=upper(btrim(p_booking_reference))
    and h.token_hash=p_access_token_hash and h.access_expires_at>clock_timestamp();
  if not found then raise exception 'BOOKING_ACCESS_DENIED' using errcode='42501';end if;
  return public.picklestreet_hold_result(v_booking);
end;$$;
revoke all on function public.get_picklestreet_provisional_hold(text,text,text) from public,anon,authenticated;
grant execute on function public.get_picklestreet_provisional_hold(text,text,text) to service_role;

create function public.cancel_picklestreet_provisional_hold(p_hostname text,p_booking_reference text,p_access_token_hash text)
returns jsonb language plpgsql security definer set search_path='' set row_security=off as $$
declare v_tenant uuid:=public.picklestreet_hold_context(p_hostname);v_hold public.picklestreet_provisional_holds%rowtype;v_booking public.bookings%rowtype;v_id uuid;v_old_status text;
begin
  select h.booking_id into v_id from public.picklestreet_provisional_holds h join public.bookings b on b.tenant_id=h.tenant_id and b.id=h.booking_id
    where h.tenant_id=v_tenant and b.reference=upper(btrim(p_booking_reference)) and h.token_hash=p_access_token_hash and h.access_expires_at>clock_timestamp();
  if not found then raise exception 'BOOKING_ACCESS_DENIED' using errcode='42501';end if;
  perform pg_advisory_xact_lock(hashtextextended('picklestreet-receipt:'||v_id::text,0));
  select * into strict v_booking from public.bookings b where b.tenant_id=v_tenant and b.id=v_id for update;
  select * into strict v_hold from public.picklestreet_provisional_holds h where h.tenant_id=v_tenant and h.booking_id=v_id for update;
  if v_hold.completed_at is not null then raise exception 'PICKLESTREET_HOLD_ALREADY_COMPLETED' using errcode='22023';end if;
  if v_booking.status not in('pending_payment','cancelled','expired') or v_booking.payment_status<>'unpaid' then
    raise exception 'PICKLESTREET_HOLD_CANCEL_NOT_ALLOWED' using errcode='22023';end if;
  v_old_status:=v_booking.status;
  if v_booking.status='pending_payment' then
    update public.bookings set status='cancelled' where tenant_id=v_tenant and id=v_id;
    update public.booking_slots set status='cancelled' where tenant_id=v_tenant and booking_id=v_id and status='held';
  end if;
  return public.picklestreet_hold_result(v_id)||jsonb_build_object('cancelled',true,'idempotent',v_old_status<>'pending_payment');
end;$$;
revoke all on function public.cancel_picklestreet_provisional_hold(text,text,text) from public,anon,authenticated;
grant execute on function public.cancel_picklestreet_provisional_hold(text,text,text) to service_role;

create function public.complete_picklestreet_provisional_hold(
  p_hostname text,p_booking_reference text,p_access_token_hash text,
  p_customer_name text,p_customer_email text,p_customer_phone text,
  p_policy_accepted boolean,p_policy_version text,p_policy_sha256 text,
  p_guest_count integer default 1,p_event_type text default null,p_event_setup_notes text default null
) returns jsonb language plpgsql security definer set search_path='' set row_security=off as $$
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
  v_expected_count:=extract(epoch from(v_booking.ends_at-v_booking.starts_at))::integer/3600;
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
end;$$;
revoke all on function public.complete_picklestreet_provisional_hold(text,text,text,text,text,text,boolean,text,text,integer,text,text) from public,anon,authenticated;
grant execute on function public.complete_picklestreet_provisional_hold(text,text,text,text,text,text,boolean,text,text,integer,text,text) to service_role;

commit;
