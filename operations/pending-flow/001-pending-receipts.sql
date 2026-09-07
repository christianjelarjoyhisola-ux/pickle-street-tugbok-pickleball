-- Pickle Street receipt workflow. Apply only after rollback validation.
-- Source: exact live definitions captured 2026-09-07 in operations/pending-flow/deployed.
-- Scope: initial booking receipts for Pickle Street Tugbok only; no balance/open-play changes.
begin;

create table public.picklestreet_receipt_jobs (
  tenant_id uuid not null default 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'
    check (tenant_id = 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid),
  booking_id uuid not null,
  receipt_id uuid,
  current_attempt_id uuid,
  version bigint not null default 0 check (version >= 0),
  lease_token uuid,
  lease_until timestamptz,
  original_hold_expires_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, booking_id),
  foreign key (tenant_id, booking_id) references public.bookings(tenant_id,id),
  foreign key (tenant_id, receipt_id) references public.receipt_verifications(tenant_id,id)
);

create table public.picklestreet_receipt_attempts (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null default 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'
    check (tenant_id = 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid),
  booking_id uuid not null,
  receipt_id uuid not null,
  payment_session_id uuid,
  version bigint not null check (version >= 0),
  idempotency_key uuid not null,
  action text not null check (action in ('upload','replace','retry','legacy_snapshot')),
  storage_path text not null,
  file_sha256 text check (file_sha256 is null or file_sha256 ~ '^[a-f0-9]{64}$'),
  payment_method text,
  submitted_reference text,
  payment_reference text,
  confidence numeric check (confidence is null or confidence between 0 and 1),
  flags text[] not null default '{}',
  extracted_data jsonb not null default '{}' check (jsonb_typeof(extracted_data) = 'object'),
  outcome text not null default 'processing'
    check (outcome in ('processing','pending','auto_approved','superseded','legacy_snapshot')),
  error_code text,
  actor_user_id uuid references auth.users(id),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  foreign key (tenant_id,booking_id) references public.bookings(tenant_id,id),
  foreign key (tenant_id,receipt_id) references public.receipt_verifications(tenant_id,id),
  foreign key (tenant_id,payment_session_id) references public.payment_sessions(tenant_id,id),
  unique (tenant_id,booking_id,version),
  unique (tenant_id,booking_id,idempotency_key),
  check (storage_path like tenant_id::text || '/receipts/' || booking_id::text || '/%'),
  check (not (extracted_data ?| array['rawText','rawOcr','fullText','documentText','textAnnotations']))
);
create index picklestreet_receipt_attempts_hash_idx
  on public.picklestreet_receipt_attempts(tenant_id,file_sha256) where file_sha256 is not null;
create index picklestreet_receipt_attempts_reference_idx
  on public.picklestreet_receipt_attempts(tenant_id,payment_reference) where payment_reference is not null;
create index picklestreet_receipt_attempts_path_idx
  on public.picklestreet_receipt_attempts(tenant_id,storage_path);
alter table public.picklestreet_receipt_jobs enable row level security;
alter table public.picklestreet_receipt_attempts enable row level security;
revoke all on public.picklestreet_receipt_jobs, public.picklestreet_receipt_attempts
  from public,anon,authenticated;
grant all on public.picklestreet_receipt_jobs, public.picklestreet_receipt_attempts to service_role;

-- Marked rows use the new flow. These guards do not change any existing shared function.
create function public.guard_picklestreet_receipt_state()
returns trigger language plpgsql security definer set search_path='' set row_security=off as $$
begin
  if new.balance_request_id is not null then return new; end if;
  if new.tenant_id = 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid and new.balance_request_id is null and tg_op='INSERT'
     and not exists(select 1 from public.picklestreet_receipt_jobs j where j.tenant_id=new.tenant_id and j.booking_id=new.booking_id) then
    raise exception 'PICKLESTREET_PENDING_FLOW_REQUIRED' using errcode='22023';
  end if;
  if new.tenant_id <> 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid
     or not exists (select 1 from public.picklestreet_receipt_jobs j
       where j.tenant_id=new.tenant_id and j.booking_id=new.booking_id) then
    return new;
  end if;
  if new.status not in ('pending','manual_review','auto_approved') then
    raise exception 'PICKLESTREET_RECEIPT_REMAINS_PENDING' using errcode='22023';
  end if;
  if new.status='auto_approved' and (tg_op='INSERT' or old.status is distinct from new.status)
     and (auth.role() is distinct from 'service_role'
       or coalesce(current_setting('app.picklestreet_auto_approval',true),'') <> new.id::text) then
    raise exception 'PICKLESTREET_AUTOMATIC_VERIFICATION_REQUIRED' using errcode='42501';
  end if;
  return new;
end;
$$;
create trigger receipt_verifications_picklestreet_state
before insert or update on public.receipt_verifications
for each row execute function public.guard_picklestreet_receipt_state();

create function public.guard_picklestreet_booking_state()
returns trigger language plpgsql security definer set search_path='' set row_security=off as $$
declare v_receipt_id uuid;
begin
  if new.tenant_id <> 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid then return new; end if;
  select j.receipt_id into v_receipt_id from public.picklestreet_receipt_jobs j
    join public.receipt_verifications r on r.tenant_id=j.tenant_id and r.id=j.receipt_id and r.balance_request_id is null
    join public.payment_sessions p on p.tenant_id=r.tenant_id and p.id=r.payment_session_id
    where j.tenant_id=new.tenant_id and j.booking_id=new.id and p.status <> 'paid';
  if not found then return new; end if;
  if new.status='cancelled' and old.status in ('pending_payment','payment_review','expired') then
    raise exception 'PICKLESTREET_RECEIPT_REMAINS_PENDING' using errcode='22023';
  end if;
  if new.payment_status='rejected' then
    raise exception 'PICKLESTREET_PAYMENT_REMAINS_PENDING' using errcode='22023';
  end if;
  if new.payment_status='paid' and old.payment_status is distinct from 'paid'
     and (auth.role() is distinct from 'service_role'
       or coalesce(current_setting('app.picklestreet_auto_approval',true),'') <> v_receipt_id::text) then
    raise exception 'PICKLESTREET_AUTOMATIC_VERIFICATION_REQUIRED' using errcode='42501';
  end if;
  -- Runs after bookings_extend_payment_review_hold alphabetically. Preserve the
  -- original finite reservation deadline; retry/correction never renews it.
  if new.status='payment_review' and old.status is distinct from 'payment_review' then
    if coalesce(current_setting('app.picklestreet_rehold',true),'')=new.id::text then
      new.expires_at := least(clock_timestamp()+interval '2 minutes',new.starts_at);
    else
      new.expires_at := old.expires_at;
    end if;
  end if;
  return new;
end;
$$;
create trigger zz_bookings_picklestreet_state
before update on public.bookings
for each row execute function public.guard_picklestreet_booking_state();

create function public.guard_picklestreet_payment_session_state()
returns trigger language plpgsql security definer set search_path='' set row_security=off as $$
declare v_receipt_id uuid;
begin
  if new.tenant_id <> 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid then return new; end if;
  select j.receipt_id into v_receipt_id from public.picklestreet_receipt_jobs j
    join public.receipt_verifications r on r.tenant_id=j.tenant_id and r.id=j.receipt_id
    where j.tenant_id=new.tenant_id and j.booking_id=new.booking_id
      and r.payment_session_id=new.id and r.balance_request_id is null and r.status in ('pending','manual_review');
  if not found then return new; end if;
  if old.status in ('created','pending') and new.status in ('failed','expired') then
    new.status := 'pending';
    new.provider_payload := new.provider_payload || jsonb_build_object('reservationExpiredAt',now());
  elsif new.status='paid' and old.status is distinct from 'paid'
    and (auth.role() is distinct from 'service_role'
      or coalesce(current_setting('app.picklestreet_auto_approval',true),'') <> v_receipt_id::text) then
    raise exception 'PICKLESTREET_AUTOMATIC_VERIFICATION_REQUIRED' using errcode='42501';
  end if;
  return new;
end;
$$;
create trigger zz_payment_sessions_picklestreet_state
before update on public.payment_sessions
for each row execute function public.guard_picklestreet_payment_session_state();

create function public.begin_picklestreet_receipt_attempt(
  p_booking_id uuid,p_action text,p_idempotency_key uuid,
  p_storage_path text default null,p_file_sha256 text default null,
  p_payment_method text default null,p_submitted_reference text default null,
  p_actor_user_id uuid default null
) returns jsonb language plpgsql security definer set search_path='' set row_security=off as $$
declare
  v_tenant constant uuid := 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';
  v_booking public.bookings%rowtype;
  v_receipt public.receipt_verifications%rowtype;
  v_payment public.payment_sessions%rowtype;
  v_job public.picklestreet_receipt_jobs%rowtype;
  v_attempt public.picklestreet_receipt_attempts%rowtype;
  v_previous public.picklestreet_receipt_attempts%rowtype;
  v_path text := p_storage_path;
  v_hash text := lower(p_file_sha256);
  v_method text := lower(btrim(p_payment_method));
  v_reference text := nullif(btrim(p_submitted_reference),'');
  v_token uuid := extensions.gen_random_uuid();
  v_timezone text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'PICKLESTREET_SERVICE_REQUIRED' using errcode='42501';
  end if;
  if p_action not in ('upload','replace','retry') or p_action is null or p_idempotency_key is null then
    raise exception 'PICKLESTREET_ATTEMPT_INVALID' using errcode='22023';
  end if;
  -- Serialize all new-flow writes for one booking. Receipt/booking lock order
  -- matches the shared approval/review RPCs, preventing a review/retry deadlock.
  perform pg_advisory_xact_lock(hashtextextended('picklestreet-receipt:'||p_booking_id::text,0));
  select * into v_receipt from public.receipt_verifications
    where tenant_id=v_tenant and booking_id=p_booking_id and balance_request_id is null for update;
  select * into v_booking from public.bookings where tenant_id=v_tenant and id=p_booking_id for update;
  if not found then raise exception 'BOOKING_NOT_FOUND' using errcode='22023'; end if;
  select timezone into v_timezone from public.tenants where id=v_tenant and slug='pickle-street-tugbok' and status='active';
  if not found then raise exception 'TENANT_UNAVAILABLE' using errcode='22023'; end if;
  select * into v_job from public.picklestreet_receipt_jobs where tenant_id=v_tenant and booking_id=p_booking_id for update;
  select * into v_attempt from public.picklestreet_receipt_attempts
    where tenant_id=v_tenant and booking_id=p_booking_id and idempotency_key=p_idempotency_key;
  if found then
    if v_attempt.action <> p_action or (p_action <> 'retry' and
       (v_attempt.storage_path is distinct from p_storage_path or v_attempt.file_sha256 is distinct from lower(p_file_sha256)
        or v_attempt.payment_method is distinct from v_method or v_attempt.submitted_reference is distinct from v_reference)) then
      raise exception 'PICKLESTREET_IDEMPOTENCY_CONFLICT' using errcode='22023';
    end if;
    return jsonb_build_object('claimed',false,'idempotent',true,'attemptId',v_attempt.id,
      'verificationId',v_attempt.receipt_id,'outcome',v_attempt.outcome,'flags',to_jsonb(v_attempt.flags),
      'status',v_receipt.status,'bookingReference',v_booking.reference,'bookingStatus',v_booking.status,'paymentStatus',v_booking.payment_status);
  end if;
  if v_job.lease_until>clock_timestamp() then
    return jsonb_build_object('claimed',false,'busy',true,'retryAfterSeconds',ceil(extract(epoch from v_job.lease_until-clock_timestamp())));
  end if;
  if exists(select 1 from public.picklestreet_receipt_attempts where tenant_id=v_tenant and booking_id=p_booking_id and action<>'legacy_snapshot' and created_at>clock_timestamp()-interval '30 seconds')
     or (select count(*) from public.picklestreet_receipt_attempts where tenant_id=v_tenant and booking_id=p_booking_id and action<>'legacy_snapshot' and created_at>clock_timestamp()-interval '1 hour')>=10 then
    raise exception 'PICKLESTREET_RETRY_COOLDOWN' using errcode='22023';
  end if;
  if v_booking.payment_status in ('paid','refunded','rejected','partial')
    or v_booking.status not in ('pending_payment','payment_review','expired')
    or (v_booking.status='expired' and v_booking.payment_status<>'pending') then
    raise exception 'PICKLESTREET_RECEIPT_NOT_ALLOWED' using errcode='22023';
  end if;
  if v_receipt.id is null then
    if p_action<>'upload' or v_booking.status<>'pending_payment' or v_booking.payment_status<>'unpaid'
       or v_booking.expires_at is null or v_booking.expires_at<=clock_timestamp() then
      raise exception 'PICKLESTREET_INITIAL_WINDOW_EXPIRED' using errcode='22023';
    end if;
  elsif v_receipt.status not in ('pending','manual_review') then
    raise exception 'PICKLESTREET_RECEIPT_NOT_PENDING' using errcode='22023';
  end if;
  if p_action='retry' then
    if v_receipt.id is null then raise exception 'RECEIPT_NOT_FOUND' using errcode='22023'; end if;
    v_path := v_receipt.storage_path;
    v_hash := lower(v_receipt.file_sha256);
    select * into v_previous from public.picklestreet_receipt_attempts
      where tenant_id=v_tenant and booking_id=p_booking_id and storage_path=v_path
      order by version desc limit 1;
    v_hash := coalesce(v_hash,v_previous.file_sha256,lower(p_file_sha256));
  end if;
  if v_path is null or v_path !~ ('^'||v_tenant::text||'/receipts/'||p_booking_id::text||'/[a-f0-9-]{36}\.(jpg|jpeg|png|webp)$')
     or (v_hash is not null and v_hash !~ '^[a-f0-9]{64}$')
     or (p_action<>'retry' and v_hash is null) then
    raise exception 'PICKLESTREET_RECEIPT_FILE_INVALID' using errcode='22023';
  end if;
  if v_receipt.payment_session_id is not null then
    select * into v_payment from public.payment_sessions where tenant_id=v_tenant
      and booking_id=p_booking_id and id=v_receipt.payment_session_id for update;
  else
    select * into v_payment from public.payment_sessions where tenant_id=v_tenant
      and booking_id=p_booking_id and status in ('created','pending') for update;
  end if;
  if v_payment.id is not null and (v_payment.provider<>'manual_receipt' or v_payment.status in ('paid','refunded')) then
    raise exception 'PICKLESTREET_PAYMENT_SESSION_CONFLICT' using errcode='22023';
  end if;
  if p_action='retry' then
    v_method := lower(v_payment.provider_payload->>'paymentMethod');
    v_reference := nullif(btrim(v_payment.provider_payload->>'submittedReference'),'');
  end if;
  if v_method is null or v_method !~ '^[a-z][a-z0-9_-]{1,39}$'
    or char_length(coalesce(v_reference,''))>64 then
    raise exception 'PICKLESTREET_PAYMENT_DETAILS_INVALID' using errcode='22023';
  end if;
  if not exists (select 1 from public.tenant_payment_methods where tenant_id=v_tenant
    and method_code=v_method and is_active) then
    raise exception 'PAYMENT_METHOD_UNAVAILABLE' using errcode='22023';
  end if;
  if v_job.booking_id is null then
    insert into public.picklestreet_receipt_jobs(tenant_id,booking_id,original_hold_expires_at)
      values(v_tenant,p_booking_id,v_booking.expires_at) returning * into v_job;
    if v_receipt.id is not null then
      insert into public.picklestreet_receipt_attempts(tenant_id,booking_id,receipt_id,payment_session_id,
        version,idempotency_key,action,storage_path,file_sha256,payment_reference,confidence,flags,
        extracted_data,outcome,completed_at,payment_method,submitted_reference)
      values(v_tenant,p_booking_id,v_receipt.id,v_receipt.payment_session_id,0,extensions.gen_random_uuid(),
        'legacy_snapshot',v_receipt.storage_path,lower(v_receipt.file_sha256),v_receipt.payment_reference,
        v_receipt.confidence,v_receipt.flags,v_receipt.extracted_data,'legacy_snapshot',now(),
        v_payment.provider_payload->>'paymentMethod',v_payment.provider_payload->>'submittedReference');
    end if;
  end if;
  if v_payment.id is null then
    insert into public.payment_sessions(tenant_id,booking_id,provider,status,amount,currency,expires_at,provider_payload)
      values(v_tenant,p_booking_id,'manual_receipt','pending',v_booking.total_amount,v_booking.currency,
        v_booking.expires_at,jsonb_build_object('source','picklestreet_pending_receipt','paymentMethod',v_method,'submittedReference',v_reference))
      returning * into v_payment;
  else
    update public.payment_sessions set status='pending',amount=v_booking.total_amount,currency=v_booking.currency,
      provider_payload=provider_payload||jsonb_build_object('source','picklestreet_pending_receipt','paymentMethod',v_method,'submittedReference',v_reference)
      where tenant_id=v_tenant and id=v_payment.id returning * into v_payment;
  end if;
  -- The placeholder is durable before OCR. Null hash/reference avoid turning a
  -- duplicate-evidence concern into a failed upload; the attempt keeps evidence.
  if v_receipt.id is null then
    insert into public.receipt_verifications(tenant_id,booking_id,payment_session_id,storage_path,
      status,flags,extracted_data,expected_amount)
      values(v_tenant,p_booking_id,v_payment.id,v_path,'manual_review',array['verification_pending'],
        '{}'::jsonb,v_booking.total_amount) returning * into v_receipt;
  else
    update public.receipt_verifications set payment_session_id=v_payment.id,storage_path=v_path,
      file_sha256=null,payment_reference=null,confidence=null,flags=array['verification_pending'],
      extracted_data='{}'::jsonb,status='manual_review',reviewed_at=null,reviewed_by=null,
      expected_amount=v_booking.total_amount
      where tenant_id=v_tenant and id=v_receipt.id returning * into v_receipt;
  end if;
  update public.picklestreet_receipt_attempts set outcome='superseded',completed_at=now(),
    flags=array['verification_interrupted'],error_code='verification_interrupted'
    where tenant_id=v_tenant and id=v_job.current_attempt_id and outcome='processing';
  insert into public.picklestreet_receipt_attempts(tenant_id,booking_id,receipt_id,payment_session_id,
    version,idempotency_key,action,storage_path,file_sha256,payment_method,submitted_reference,actor_user_id)
    values(v_tenant,p_booking_id,v_receipt.id,v_payment.id,v_job.version+1,p_idempotency_key,p_action,
      v_path,v_hash,v_method,v_reference,p_actor_user_id) returning * into v_attempt;
  update public.picklestreet_receipt_jobs set receipt_id=v_receipt.id,current_attempt_id=v_attempt.id,
    version=v_attempt.version,lease_token=v_token,lease_until=clock_timestamp()+interval '90 seconds',updated_at=now()
    where tenant_id=v_tenant and booking_id=p_booking_id;
  update public.bookings set payment_status='pending',
    status=case when status='pending_payment' then 'payment_review' else status end,
    metadata=metadata||jsonb_build_object('receiptFlow','picklestreet_pending_v1')
    where tenant_id=v_tenant and id=p_booking_id returning * into v_booking;
  return jsonb_build_object('claimed',true,'attemptId',v_attempt.id,'leaseToken',v_token,
    'version',v_attempt.version,'verificationId',v_receipt.id,'storagePath',v_path,'fileSha256',v_hash,
    'paymentSessionId',v_payment.id,'paymentMethod',v_method,'submittedReference',v_reference,
    'expectedAmount',v_booking.total_amount,'currency',v_booking.currency,
    'bookingStartedAt',v_booking.created_at,'tenantTimezone',v_timezone,
    'status','manual_review','bookingStatus',v_booking.status,'paymentStatus',v_booking.payment_status);
end;
$$;

create function public.finish_picklestreet_receipt_attempt(
  p_attempt_id uuid,p_lease_token uuid,p_extracted_data jsonb default null,
  p_flags text[] default '{}',p_payment_reference text default null,p_confidence numeric default null,
  p_auto_approve boolean default false,p_error_code text default null,p_receiver_snapshot jsonb default null
) returns jsonb language plpgsql security definer set search_path='' set row_security=off as $$
declare
  v_tenant constant uuid := 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';
  v_attempt public.picklestreet_receipt_attempts%rowtype;
  v_job public.picklestreet_receipt_jobs%rowtype;
  v_booking public.bookings%rowtype;
  v_receipt public.receipt_verifications%rowtype;
  v_flags text[] := coalesce(p_flags,'{}');
  v_data jsonb := coalesce(p_extracted_data,'{}');
  v_reference text := nullif(p_payment_reference,'');
  v_hash text;
  v_candidate boolean := coalesce(p_auto_approve,false);
  v_result jsonb;
  v_reason text;
  v_timezone text;
  v_reheld boolean := false;
  v_count integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'PICKLESTREET_SERVICE_REQUIRED' using errcode='42501';
  end if;
  select * into v_attempt from public.picklestreet_receipt_attempts where tenant_id=v_tenant and id=p_attempt_id;
  if not found then raise exception 'ATTEMPT_NOT_FOUND' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('picklestreet-receipt:'||v_attempt.booking_id::text,0));
  select * into v_receipt from public.receipt_verifications where tenant_id=v_tenant and id=v_attempt.receipt_id for update;
  select * into v_booking from public.bookings where tenant_id=v_tenant and id=v_attempt.booking_id for update;
  select * into v_job from public.picklestreet_receipt_jobs where tenant_id=v_tenant and booking_id=v_attempt.booking_id for update;
  select * into v_attempt from public.picklestreet_receipt_attempts where tenant_id=v_tenant and id=p_attempt_id for update;
  if v_job.current_attempt_id is distinct from p_attempt_id or v_job.lease_token is distinct from p_lease_token then
    return jsonb_build_object('ok',true,'stale',true,'status',v_receipt.status,
      'flags',to_jsonb(v_receipt.flags),'verificationId',v_receipt.id);
  end if;
  if v_attempt.outcome<>'processing' then
    return jsonb_build_object('ok',true,'existing',true,'status',v_receipt.status,
      'flags',to_jsonb(v_receipt.flags),'verificationId',v_receipt.id);
  end if;
  if v_receipt.status not in ('pending','manual_review') or v_booking.payment_status<>'pending'
     or v_booking.status not in ('pending_payment','payment_review','expired') then
    raise exception 'PICKLESTREET_RECEIPT_NOT_PENDING' using errcode='22023';
  end if;
  if cardinality(v_flags)>20 or exists(select 1 from unnest(v_flags) f where f is null or f !~ '^[a-z0-9_]{1,40}$')
     or (v_reference is not null and v_reference !~ '^[A-Z0-9][A-Z0-9-]{5,63}$')
     or (p_confidence is not null and (p_confidence<0 or p_confidence>1)) then
    raise exception 'PICKLESTREET_EVIDENCE_INVALID' using errcode='22023';
  end if;
  select timezone into v_timezone from public.tenants where id=v_tenant;
  if p_error_code is not null then
    if p_error_code !~ '^[a-z0-9_]{1,40}$' then raise exception 'PICKLESTREET_ERROR_INVALID' using errcode='22023'; end if;
    v_flags := array[p_error_code]; v_data := '{}'::jsonb; v_candidate := false;
  else
    -- Trusted Edge supplies the hardened extractor's safe v2 schema. Bind its
    -- amount, time and confidence to protected records; existing auto_approve
    -- remains the final atomic eligibility gate.
    if jsonb_typeof(v_data) is distinct from 'object'
      or v_data->>'schemaVersion' is distinct from '2'
      or v_data->>'provider' is distinct from 'google_vision'
      or v_data->>'feature' is distinct from 'DOCUMENT_TEXT_DETECTION'
      or (select count(*) from jsonb_object_keys(v_data))<>9
      or exists(select 1 from jsonb_object_keys(v_data) k where k<>all(array[
        'schemaVersion','provider','feature','ocrCharacterCount','file','detected','comparison','timing','confidence']))
      or jsonb_typeof(v_data->'file') is distinct from 'object'
      or jsonb_typeof(v_data->'detected') is distinct from 'object'
      or jsonb_typeof(v_data->'comparison') is distinct from 'object'
      or jsonb_typeof(v_data->'timing') is distinct from 'object'
      or jsonb_typeof(v_data->'confidence') is distinct from 'object'
      or v_data#>>'{comparison,currency}' is distinct from v_booking.currency
      or (v_data#>>'{comparison,expectedAmount}')::numeric is distinct from v_booking.total_amount
      or (v_data#>>'{timing,bookingStartedAt}')::timestamptz is distinct from v_booking.created_at
      or v_data#>>'{timing,tenantTimezone}' is distinct from v_timezone
      or (v_data#>>'{confidence,effective}')::numeric is distinct from p_confidence
      or coalesce(v_data#>>'{detected,paymentReference}','')<>coalesce(v_reference,'') then
      raise exception 'PICKLESTREET_EVIDENCE_INVALID' using errcode='22023';
    end if;
    -- Recompute the timestamp relation instead of accepting a supplied true flag.
    if (v_data#>>'{timing,withinWindow}')::boolean is true and (
      v_data#>>'{timing,receiptDateTime}' is null
      or to_char((v_data#>>'{timing,receiptDateTime}')::timestamptz at time zone v_timezone,'YYYY-MM-DD')
          is distinct from v_data#>>'{timing,receiptDate}'
      or to_char((v_data#>>'{timing,receiptDateTime}')::timestamptz at time zone v_timezone,'HH24:MI')
          is distinct from v_data#>>'{timing,receiptTime}'
      or (v_data#>>'{timing,allowedWindowMinutes}')::numeric not between 1 and 60
      or (v_data#>>'{timing,earlyToleranceMinutes}')::numeric not between 0 and 10
      or extract(epoch from ((v_data#>>'{timing,receiptDateTime}')::timestamptz-v_booking.created_at))/60
          not between -(v_data#>>'{timing,earlyToleranceMinutes}')::numeric
          and (v_data#>>'{timing,allowedWindowMinutes}')::numeric
    ) then raise exception 'PICKLESTREET_TIMING_INVALID' using errcode='22023'; end if;
  end if;
  -- A stable hash/reference advisory lock prevents two new-flow finishes from
  -- simultaneously claiming evidence. Canonical unique indexes also guard old flows.
  v_hash := v_attempt.file_sha256;
  if v_hash is null then
    v_flags := array_append(array_remove(v_flags,'auto_approval_eligible'),'receipt_fingerprint_unavailable');
    v_candidate := false;
  end if;
  if v_hash is not null then
    perform pg_advisory_xact_lock(hashtextextended('picklestreet-file:'||v_hash,0));
    if exists(select 1 from public.receipt_verifications where tenant_id=v_tenant
        and booking_id<>v_booking.id and lower(file_sha256)=v_hash)
      or exists(select 1 from public.picklestreet_receipt_attempts where tenant_id=v_tenant
        and booking_id<>v_booking.id and file_sha256=v_hash) then
      v_flags := array_append(array_remove(v_flags,'auto_approval_eligible'),'duplicate_receipt_file');
      v_hash := null; v_candidate := false;
    end if;
  end if;
  if v_reference is not null then
    perform pg_advisory_xact_lock(hashtextextended('picklestreet-reference:'||
      regexp_replace(upper(v_reference),'[^A-Z0-9]','','g'),0));
    if exists(select 1 from public.receipt_verifications where tenant_id=v_tenant
        and booking_id<>v_booking.id and regexp_replace(upper(payment_reference),'[^A-Z0-9]','','g')=
          regexp_replace(upper(v_reference),'[^A-Z0-9]','','g'))
      or exists(select 1 from public.picklestreet_receipt_attempts where tenant_id=v_tenant
        and booking_id<>v_booking.id and regexp_replace(upper(payment_reference),'[^A-Z0-9]','','g')=
          regexp_replace(upper(v_reference),'[^A-Z0-9]','','g')) then
      v_flags := array_append(array_remove(v_flags,'auto_approval_eligible'),'duplicate_payment_reference');
      v_reference := null; v_candidate := false;
    end if;
  end if;
  if not v_candidate then v_flags:=array_remove(v_flags,'auto_approval_eligible'); end if;
  if v_candidate then
    perform 1 from public.tenant_payment_methods m
    where m.tenant_id=v_tenant and m.method_code=v_attempt.payment_method and m.is_active
      and p_receiver_snapshot=jsonb_build_object('method',m.method_code,'name',m.account_name,'account',m.account_reference)
    for share;
    if not found then
      v_candidate:=false;v_flags:=array['payment_receiver_settings_changed'];
    end if;
    perform 1 from public.tenants t where t.id=v_tenant and t.slug='pickle-street-tugbok' and t.status='active'
      and coalesce(t.public_config->>'bookingApprovalMode','')<>'manual'
      and (v_attempt.payment_method='gcash' or (v_attempt.payment_method='gotyme' and t.public_config->'receiptAutoApprovalMethods' @> '["gotyme"]'::jsonb))
    for share;
    if not found then v_candidate:=false;v_flags:=array['automatic_method_disabled'];end if;
  end if;
  if cardinality(v_flags)=0 then v_flags:=array['verification_pending']; end if;
  -- A concurrent legacy-flow insert can win either unique constraint after the
  -- lookup. Retain the attempt but remove canonical claims on that safe fallback.
  begin
    update public.receipt_verifications set file_sha256=v_hash,payment_reference=v_reference,
      confidence=p_confidence,flags=v_flags,extracted_data=v_data,status='manual_review'
      where tenant_id=v_tenant and id=v_receipt.id;
  exception when unique_violation then
    v_candidate:=false;
    v_flags:=array_append(array_remove(v_flags,'auto_approval_eligible'),'duplicate_receipt_evidence');
    update public.receipt_verifications set file_sha256=null,payment_reference=null,
      confidence=p_confidence,flags=v_flags,extracted_data=v_data,status='manual_review'
      where tenant_id=v_tenant and id=v_receipt.id;
  end;
  if v_candidate and v_flags=array['auto_approval_eligible']::text[] then
    -- Approval and optional rehold are one subtransaction. Any expired-time,
    -- closure, occupancy, or approval failure rolls back every tentative hold.
    begin
      if v_booking.starts_at<=clock_timestamp() then
        raise exception 'booking_started' using errcode='P0001';
      end if;
      perform s.id from public.booking_slots s where s.tenant_id=v_tenant and s.booking_id=v_booking.id
        order by s.starts_at,s.id for update;
      select count(*) into v_count from public.booking_slots where tenant_id=v_tenant and booking_id=v_booking.id;
      if v_count<1 then raise exception 'reservation_slots_missing' using errcode='P0001'; end if;
      if v_booking.status='expired' or v_booking.expires_at is null or v_booking.expires_at<=clock_timestamp()
        or exists(select 1 from public.booking_slots where tenant_id=v_tenant and booking_id=v_booking.id
          and (status<>'held' or hold_expires_at is null or hold_expires_at<=clock_timestamp())) then
        -- Match the live restore RPC's court/time/closure/overlap rules, plus
        -- block concurrent closure writes until this short transaction commits.
        perform set_config('lock_timeout','1000ms',true);
        lock table public.blocked_dates in share mode;
        perform c.id from public.courts c where c.tenant_id=v_tenant and exists(
          select 1 from public.booking_slots s where s.tenant_id=c.tenant_id and s.booking_id=v_booking.id and s.court_id=c.id)
          order by c.id for share;
        if exists(select 1 from public.booking_slots s left join public.courts c
          on c.tenant_id=s.tenant_id and c.id=s.court_id
          where s.tenant_id=v_tenant and s.booking_id=v_booking.id and (
            s.status not in ('held','expired') or s.balance_request_id is not null
            or s.starts_at<v_booking.starts_at or s.ends_at>v_booking.ends_at
            or c.id is null or c.status<>'active')) then
          raise exception 'reservation_court_unavailable' using errcode='P0001';
        end if;
        if exists(select 1 from public.booking_slots s join public.blocked_dates b
          on b.tenant_id=s.tenant_id and (b.court_id is null or b.court_id=s.court_id)
          and b.blocked_on between (s.starts_at at time zone v_timezone)::date
            and ((s.ends_at-interval '1 microsecond') at time zone v_timezone)::date
          where s.tenant_id=v_tenant and s.booking_id=v_booking.id
          and tsrange(s.starts_at at time zone v_timezone,s.ends_at at time zone v_timezone,'[)') &&
            case when b.starts_at is null then tsrange(b.blocked_on::timestamp,(b.blocked_on+1)::timestamp,'[)')
            else tsrange(b.blocked_on+b.starts_at,case when b.ends_at=time '23:59:59'
              then (b.blocked_on+1)::timestamp else b.blocked_on+b.ends_at end,'[)') end) then
          raise exception 'reservation_court_blocked' using errcode='P0001';
        end if;
        if exists(select 1 from public.booking_slots target join public.booking_slots active
          on active.tenant_id=target.tenant_id and active.court_id=target.court_id and active.booking_id<>target.booking_id
          and active.starts_at<target.ends_at and active.ends_at>target.starts_at
          and (active.status='confirmed' or (active.status='held' and active.hold_expires_at>clock_timestamp()))
          where target.tenant_id=v_tenant and target.booking_id=v_booking.id) then
          raise exception 'reservation_time_unavailable' using errcode='P0001';
        end if;
        perform set_config('app.picklestreet_rehold',v_booking.id::text,true);
        update public.bookings set status='payment_review',expires_at=least(clock_timestamp()+interval '2 minutes',starts_at)
          where tenant_id=v_tenant and id=v_booking.id;
        update public.booking_slots set status='held',hold_expires_at=least(clock_timestamp()+interval '2 minutes',v_booking.starts_at)
          where tenant_id=v_tenant and booking_id=v_booking.id;
        v_reheld:=true;
      end if;
      if v_booking.starts_at<=clock_timestamp() then
        raise exception 'booking_started' using errcode='P0001';
      end if;
      perform set_config('app.picklestreet_auto_approval',v_receipt.id::text,true);
      v_result:=public.auto_approve_receipt_verification(v_receipt.id);
      if v_result->>'status' is distinct from 'auto_approved' then
        raise exception 'automatic_approval_unavailable' using errcode='P0001';
      end if;
    exception when others then
      v_reheld:=false;
      v_reason:=case
        when sqlerrm in ('booking_started','reservation_slots_missing','reservation_court_unavailable',
          'reservation_court_blocked','reservation_time_unavailable') then sqlerrm
        when sqlstate='23P01' then 'reservation_time_unavailable'
        when sqlstate in ('55P03','40P01','57014') then 'reservation_check_unavailable'
        else 'automatic_approval_unavailable' end;
      v_flags:=array[v_reason];
      update public.receipt_verifications set flags=v_flags,status='manual_review'
        where tenant_id=v_tenant and id=v_receipt.id;
    end;
  end if;
  select * into v_receipt from public.receipt_verifications where tenant_id=v_tenant and id=v_receipt.id;
  select * into v_booking from public.bookings where tenant_id=v_tenant and id=v_booking.id;
  update public.picklestreet_receipt_attempts set extracted_data=v_data,confidence=p_confidence,
    payment_reference=p_payment_reference,flags=v_receipt.flags,error_code=coalesce(p_error_code,v_reason),
    outcome=case when v_receipt.status='auto_approved' then 'auto_approved' else 'pending' end,completed_at=now()
    where tenant_id=v_tenant and id=p_attempt_id;
  -- Keep the winning token for idempotent finish responses; only release time.
  update public.picklestreet_receipt_jobs set lease_until=null,updated_at=now()
    where tenant_id=v_tenant and booking_id=v_booking.id;
  return jsonb_build_object('ok',true,'status',v_receipt.status,'flags',to_jsonb(v_receipt.flags),
    'verificationId',v_receipt.id,'attemptId',p_attempt_id,'bookingReference',v_booking.reference,'bookingStatus',v_booking.status,
    'paymentStatus',v_booking.payment_status,'confidence',v_receipt.confidence,
    'reservationRestored',v_reheld,'holdExpiresAt',v_booking.expires_at,
    'reservationStatus',case when v_booking.status='confirmed' then 'confirmed'
      when v_booking.expires_at is null or v_booking.expires_at<=clock_timestamp() then 'expired' else 'held' end);
end;
$$;

revoke execute on function public.guard_picklestreet_receipt_state(),
  public.guard_picklestreet_booking_state(),public.guard_picklestreet_payment_session_state()
  from public,anon,authenticated;
revoke execute on function public.begin_picklestreet_receipt_attempt(uuid,text,uuid,text,text,text,text,uuid),
  public.finish_picklestreet_receipt_attempt(uuid,uuid,jsonb,text[],text,numeric,boolean,text,jsonb)
  from public,anon,authenticated;
grant execute on function public.begin_picklestreet_receipt_attempt(uuid,text,uuid,text,text,text,text,uuid),
  public.finish_picklestreet_receipt_attempt(uuid,uuid,jsonb,text[],text,numeric,boolean,text,jsonb) to service_role;
commit;
