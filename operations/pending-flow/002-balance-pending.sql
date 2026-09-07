-- TEMP proposal; requires initial pending-flow migration 001 with balance exclusion.
-- Only Pickle Street initial-balance and reschedule-adjustment receipts are affected.
begin;
create table public.picklestreet_balance_receipt_jobs (
  tenant_id uuid not null default 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a' check(tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid),
  booking_id uuid not null, balance_request_id uuid not null,
  receipt_id uuid, payment_session_id uuid, current_attempt_id uuid, reschedule_event_id uuid,
  version bigint not null default 0, lease_token uuid, lease_until timestamptz,
  hold_deadline_at timestamptz not null check(isfinite(hold_deadline_at)),
  request_type text not null check(request_type in ('short_payment','reschedule_adjustment')),
  original_starts_at timestamptz not null check(isfinite(original_starts_at)), original_ends_at timestamptz not null check(isfinite(original_ends_at) and original_ends_at>original_starts_at),
  expected_amount numeric not null check(expected_amount>0), currency text not null,
  settled_at timestamptz, hold_released_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  primary key(tenant_id,balance_request_id),
  foreign key(tenant_id,booking_id) references public.bookings(tenant_id,id),
  foreign key(tenant_id,balance_request_id) references public.booking_balance_requests(tenant_id,id),
  foreign key(tenant_id,receipt_id) references public.receipt_verifications(tenant_id,id),
  foreign key(tenant_id,payment_session_id) references public.payment_sessions(tenant_id,id),
  foreign key(tenant_id,reschedule_event_id) references public.booking_reschedule_events(tenant_id,id)
);
create index picklestreet_balance_receipt_due_holds_idx on public.picklestreet_balance_receipt_jobs(hold_deadline_at,booking_id)
  where settled_at is null and hold_released_at is null;
create table public.picklestreet_balance_receipt_attempts (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null default 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a' check(tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid),
  booking_id uuid not null,balance_request_id uuid not null,receipt_id uuid not null,payment_session_id uuid,
  version bigint not null,idempotency_key uuid not null,
  action text not null check(action in ('upload','replace','retry','legacy_snapshot')),
  storage_path text not null,file_sha256 text check(file_sha256 is null or file_sha256~'^[a-f0-9]{64}$'),
  payment_method text,submitted_reference text,payment_reference text,
  confidence numeric check(confidence is null or confidence between 0 and 1),
  flags text[] not null default '{}',extracted_data jsonb not null default '{}' check(jsonb_typeof(extracted_data)='object'),
  receiver_snapshot jsonb,outcome text not null default 'processing'
    check(outcome in ('processing','pending','auto_approved','superseded','legacy_snapshot')),
  error_code text,actor_user_id uuid references auth.users(id),created_at timestamptz not null default now(),completed_at timestamptz,
  unique(tenant_id,balance_request_id,version),unique(tenant_id,balance_request_id,idempotency_key),
  foreign key(tenant_id,booking_id) references public.bookings(tenant_id,id),
  foreign key(tenant_id,balance_request_id) references public.booking_balance_requests(tenant_id,id),
  foreign key(tenant_id,receipt_id) references public.receipt_verifications(tenant_id,id),
  foreign key(tenant_id,payment_session_id) references public.payment_sessions(tenant_id,id),
  check(storage_path like tenant_id::text||'/receipts/'||booking_id::text||'/%'),
  check(not(extracted_data ?| array['rawText','rawOcr','fullText','documentText','textAnnotations']))
);
create index picklestreet_balance_receipt_hash_idx on public.picklestreet_balance_receipt_attempts(tenant_id,file_sha256);
create index picklestreet_balance_receipt_reference_idx on public.picklestreet_balance_receipt_attempts(tenant_id,payment_reference);
create index picklestreet_balance_receipt_path_idx on public.picklestreet_balance_receipt_attempts(tenant_id,storage_path);
alter table public.picklestreet_balance_receipt_jobs enable row level security;
alter table public.picklestreet_balance_receipt_attempts enable row level security;
revoke all on public.picklestreet_balance_receipt_jobs,public.picklestreet_balance_receipt_attempts from public,anon,authenticated;
grant all on public.picklestreet_balance_receipt_jobs,public.picklestreet_balance_receipt_attempts to service_role;

create function public.guard_picklestreet_balance_receipt_state() returns trigger
language plpgsql security definer set search_path='' set row_security=off as $$
declare j public.picklestreet_balance_receipt_jobs%rowtype;
begin
  if new.tenant_id<>'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid or new.balance_request_id is null then return new;end if;
  select * into j from public.picklestreet_balance_receipt_jobs where tenant_id=new.tenant_id and balance_request_id=new.balance_request_id;
  if not found then
    if tg_op='INSERT' then raise exception 'PICKLESTREET_BALANCE_FLOW_REQUIRED' using errcode='22023';end if;
    if old.status in ('pending','manual_review') and new.status not in ('pending','manual_review') then
      raise exception 'PICKLESTREET_BALANCE_FLOW_REQUIRED' using errcode='22023';end if;
    return new;
  end if;
  if new.status not in ('pending','manual_review','auto_approved') then raise exception 'PICKLESTREET_BALANCE_REMAINS_PENDING' using errcode='22023';end if;
  if tg_op='UPDATE' and old.status='auto_approved' and new.status is distinct from old.status then
    raise exception 'PICKLESTREET_SETTLED_RECEIPT_IMMUTABLE' using errcode='22023';end if;
  if new.status='auto_approved' and(tg_op='INSERT' or old.status is distinct from new.status)
    and(auth.role() is distinct from 'service_role' or coalesce(current_setting('app.picklestreet_balance_auto',true),'')<>new.id::text) then
    raise exception 'PICKLESTREET_AUTOMATIC_VERIFICATION_REQUIRED' using errcode='42501';end if;
  return new;
end;$$;
create trigger receipt_verifications_picklestreet_balance_state before insert or update on public.receipt_verifications
for each row execute function public.guard_picklestreet_balance_receipt_state();

create function public.guard_picklestreet_balance_request_state() returns trigger
language plpgsql security definer set search_path='' set row_security=off as $$
declare j public.picklestreet_balance_receipt_jobs%rowtype;
begin
  if new.tenant_id<>'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid then return new;end if;
  select * into j from public.picklestreet_balance_receipt_jobs where tenant_id=new.tenant_id and balance_request_id=new.id;
  if not found or j.settled_at is not null then return new;end if;
  if new.booking_id is distinct from old.booking_id or new.request_type is distinct from old.request_type
    or new.accepted_amount is distinct from old.accepted_amount or new.remaining_amount is distinct from old.remaining_amount
    or new.currency is distinct from old.currency or new.original_verification_id is distinct from old.original_verification_id
    or new.request_details is distinct from old.request_details then
    raise exception 'PICKLESTREET_BALANCE_CONTEXT_IMMUTABLE' using errcode='22023';end if;
  if new.status in ('expired','cancelled') then new.status:='payment_review';new.settled_at:=null;end if;
  if new.status='settled' and(auth.role() is distinct from 'service_role'
    or coalesce(current_setting('app.picklestreet_balance_auto',true),'')<>j.receipt_id::text) then
    raise exception 'PICKLESTREET_AUTOMATIC_VERIFICATION_REQUIRED' using errcode='42501';end if;
  new.deadline_at:=j.hold_deadline_at;
  return new;
end;$$;
create trigger zz_balance_requests_picklestreet_state before update on public.booking_balance_requests
for each row execute function public.guard_picklestreet_balance_request_state();

create function public.guard_picklestreet_balance_booking_state() returns trigger
language plpgsql security definer set search_path='' set row_security=off as $$
declare j public.picklestreet_balance_receipt_jobs%rowtype;
begin
  if new.tenant_id<>'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid then return new;end if;
  select * into j from public.picklestreet_balance_receipt_jobs where tenant_id=new.tenant_id and booking_id=new.id and settled_at is null limit 1;
  if not found then return new;end if;
  if new.status='cancelled' or new.payment_status='rejected' then raise exception 'PICKLESTREET_BALANCE_REMAINS_PENDING' using errcode='22023';end if;
  if j.request_type='reschedule_adjustment' and((new.status is distinct from old.status and not(old.status='confirmed' and new.status='completed'))
      or new.payment_status is distinct from old.payment_status or new.court_id is distinct from old.court_id
      or new.starts_at is distinct from old.starts_at or new.ends_at is distinct from old.ends_at or new.total_amount is distinct from old.total_amount
      or new.subtotal_amount is distinct from old.subtotal_amount or new.service_fee_amount is distinct from old.service_fee_amount or new.currency is distinct from old.currency)
    and(auth.role() is distinct from 'service_role' or coalesce(current_setting('app.picklestreet_balance_auto',true),'')<>j.receipt_id::text) then
    raise exception 'PICKLESTREET_ORIGINAL_BOOKING_PROTECTED' using errcode='22023';end if;
  if j.request_type='short_payment' and new.status in ('payment_review','expired') then new.expires_at:=j.hold_deadline_at;end if;
  return new;
end;$$;
create trigger zzz_bookings_picklestreet_balance_state before update on public.bookings
for each row execute function public.guard_picklestreet_balance_booking_state();

create function public.guard_picklestreet_balance_payment_state() returns trigger
language plpgsql security definer set search_path='' set row_security=off as $$
declare j public.picklestreet_balance_receipt_jobs%rowtype;
begin
  if new.tenant_id<>'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid then return new;end if;
  select * into j from public.picklestreet_balance_receipt_jobs where tenant_id=new.tenant_id and payment_session_id=new.id and settled_at is null;
  if not found then return new;end if;
  if new.status in ('failed','expired') then new.status:='pending';end if;
  if new.status='paid' and old.status is distinct from 'paid' and coalesce(current_setting('app.picklestreet_balance_auto',true),'')<>j.receipt_id::text then
    raise exception 'PICKLESTREET_AUTOMATIC_VERIFICATION_REQUIRED' using errcode='42501';end if;
  return new;
end;$$;
create trigger zz_payment_sessions_picklestreet_balance_state before update on public.payment_sessions
for each row execute function public.guard_picklestreet_balance_payment_state();

create function public.expire_picklestreet_balance_receipt_holds(p_booking_id uuid default null) returns integer
language plpgsql security definer set search_path='' set row_security=off as $$
declare j public.picklestreet_balance_receipt_jobs%rowtype;n integer:=0;c integer;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'PICKLESTREET_SERVICE_REQUIRED' using errcode='42501';end if;
  for j in select * from public.picklestreet_balance_receipt_jobs where settled_at is null and hold_released_at is null and hold_deadline_at<=clock_timestamp()
    and(p_booking_id is null or booking_id=p_booking_id) order by booking_id,balance_request_id loop
    perform pg_advisory_xact_lock(hashtextextended('picklestreet-balance:'||j.balance_request_id::text,0));
    perform 1 from public.receipt_verifications where tenant_id=j.tenant_id and id=j.receipt_id for update;
    perform 1 from public.booking_balance_requests where tenant_id=j.tenant_id and id=j.balance_request_id for update;
    perform 1 from public.bookings where tenant_id=j.tenant_id and id=j.booking_id for update;
    if not exists(select 1 from public.picklestreet_balance_receipt_jobs where tenant_id=j.tenant_id and balance_request_id=j.balance_request_id
      and settled_at is null and hold_released_at is null) then continue;end if;
    update public.booking_slots set status='expired',hold_expires_at=j.hold_deadline_at
      where tenant_id=j.tenant_id and booking_id=j.booking_id and status='held'
        and(case when j.request_type='reschedule_adjustment' then balance_request_id=j.balance_request_id else balance_request_id is null end);
    get diagnostics c=row_count;n:=n+c;
    if j.request_type='short_payment' then
      update public.bookings set status='expired',expires_at=j.hold_deadline_at
        where tenant_id=j.tenant_id and id=j.booking_id and status in ('pending_payment','payment_review');
    end if;
    update public.picklestreet_balance_receipt_jobs set hold_released_at=clock_timestamp(),updated_at=now()
      where tenant_id=j.tenant_id and balance_request_id=j.balance_request_id;
  end loop;
  return n;
end;$$;

create function public.begin_picklestreet_balance_receipt_attempt(
 p_booking_id uuid,p_balance_request_id uuid,p_action text,p_idempotency_key uuid,
 p_storage_path text default null,p_file_sha256 text default null,p_payment_method text default null,
 p_submitted_reference text default null,p_actor_user_id uuid default null
) returns jsonb language plpgsql security definer set search_path='' set row_security=off as $$
declare
 t constant uuid:='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';b public.bookings%rowtype;q public.booking_balance_requests%rowtype;
 r public.receipt_verifications%rowtype;s public.payment_sessions%rowtype;j public.picklestreet_balance_receipt_jobs%rowtype;
 a public.picklestreet_balance_receipt_attempts%rowtype;prev public.picklestreet_balance_receipt_attempts%rowtype;
 path text:=p_storage_path;hash text:=lower(p_file_sha256);method text:=lower(btrim(p_payment_method));ref text:=nullif(btrim(p_submitted_reference),'');
 deadline timestamptz;token uuid:=extensions.gen_random_uuid();zone text;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'PICKLESTREET_SERVICE_REQUIRED' using errcode='42501';end if;
 if p_action is null or p_action not in ('upload','replace','retry') or p_idempotency_key is null then raise exception 'ATTEMPT_INVALID' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended('picklestreet-balance:'||p_balance_request_id::text,0));
 select * into r from public.receipt_verifications where tenant_id=t and booking_id=p_booking_id and balance_request_id=p_balance_request_id
   and status in ('pending','manual_review','auto_approved','approved') order by created_at desc limit 1 for update;
 select * into q from public.booking_balance_requests where tenant_id=t and booking_id=p_booking_id and id=p_balance_request_id for update;
 if not found then raise exception 'BALANCE_REQUEST_NOT_FOUND' using errcode='22023';end if;
 select * into b from public.bookings where tenant_id=t and id=p_booking_id for update;
 if not found then raise exception 'BOOKING_NOT_FOUND' using errcode='22023';end if;
 select timezone into zone from public.tenants where id=t and slug='pickle-street-tugbok' and status='active';
 if not found then raise exception 'TENANT_UNAVAILABLE' using errcode='22023';end if;
 select * into j from public.picklestreet_balance_receipt_jobs where tenant_id=t and balance_request_id=q.id for update;
 select * into a from public.picklestreet_balance_receipt_attempts where tenant_id=t and balance_request_id=q.id and idempotency_key=p_idempotency_key;
 if found then
   if a.action<>p_action or(p_action<>'retry' and(a.storage_path is distinct from path or a.file_sha256 is distinct from hash
     or a.payment_method is distinct from method or a.submitted_reference is distinct from ref)) then raise exception 'IDEMPOTENCY_CONFLICT' using errcode='22023';end if;
   return jsonb_build_object('claimed',false,'idempotent',true,'attemptId',a.id,'verificationId',r.id,'status',r.status,'flags',to_jsonb(r.flags),
     'balanceRequestId',q.id,'requestType',q.request_type,'balanceStatus',q.status,'bookingReference',b.reference,'bookingStatus',b.status,'paymentStatus',b.payment_status,
     'rescheduleEventId',j.reschedule_event_id);
 end if;
 if j.lease_until>clock_timestamp() then return jsonb_build_object('claimed',false,'busy',true);end if;
 if exists(select 1 from public.picklestreet_balance_receipt_attempts where tenant_id=t and balance_request_id=q.id and action<>'legacy_snapshot'
   and created_at>clock_timestamp()-interval '30 seconds') or(select count(*) from public.picklestreet_balance_receipt_attempts
   where tenant_id=t and balance_request_id=q.id and action<>'legacy_snapshot' and created_at>clock_timestamp()-interval '1 hour')>=10 then
   raise exception 'PICKLESTREET_RETRY_COOLDOWN' using errcode='22023';end if;
 if q.status in ('settled','cancelled') or(r.id is not null and r.status not in ('pending','manual_review')) then raise exception 'BALANCE_NOT_PENDING' using errcode='22023';end if;
 if q.request_type='reschedule_adjustment' then
   if b.status not in ('confirmed','completed') or b.payment_status<>'paid' then raise exception 'ORIGINAL_BOOKING_CHANGED' using errcode='22023';end if;
 else
   if b.status not in ('payment_review','expired') or b.payment_status not in ('partial','pending') then raise exception 'BALANCE_BOOKING_CHANGED' using errcode='22023';end if;
 end if;
 if r.id is null and(p_action<>'upload' or q.status<>'awaiting_payment' or q.deadline_at<=clock_timestamp()) then raise exception 'BALANCE_INITIAL_WINDOW_EXPIRED' using errcode='22023';end if;
 if p_action='retry' then
   if r.id is null then raise exception 'RECEIPT_NOT_FOUND' using errcode='22023';end if;
   path:=r.storage_path;hash:=lower(r.file_sha256);
   select * into prev from public.picklestreet_balance_receipt_attempts where tenant_id=t and balance_request_id=q.id and storage_path=path order by version desc limit 1;
   hash:=coalesce(hash,prev.file_sha256,lower(p_file_sha256));
 end if;
 if path is null or path !~('^'||t::text||'/receipts/'||b.id::text||'/[a-f0-9-]{36}\.(jpg|jpeg|png|webp)$')
   or(hash is not null and hash !~'^[a-f0-9]{64}$') or(p_action<>'retry' and hash is null) then raise exception 'RECEIPT_FILE_INVALID' using errcode='22023';end if;
 if r.payment_session_id is not null then
   select * into s from public.payment_sessions where tenant_id=t and booking_id=b.id and id=r.payment_session_id for update;
 else
   select * into s from public.payment_sessions where tenant_id=t and booking_id=b.id and provider='manual_balance_receipt'
     and provider_payload->>'balanceRequestId'=q.id::text and status in ('created','pending') for update;
 end if;
 if s.id is not null and(s.provider<>'manual_balance_receipt' or s.provider_payload->>'balanceRequestId' is distinct from q.id::text or s.status in ('paid','refunded')) then
   raise exception 'PAYMENT_SESSION_CONFLICT' using errcode='22023';end if;
 if p_action='retry' then method:=lower(s.provider_payload->>'paymentMethod');ref:=nullif(btrim(s.provider_payload->>'submittedReference'),'');end if;
 if method is null or method !~'^[a-z][a-z0-9_-]{1,39}$' or char_length(coalesce(ref,''))>64 then raise exception 'PAYMENT_DETAILS_INVALID' using errcode='22023';end if;
 if not exists(select 1 from public.tenant_payment_methods where tenant_id=t and method_code=method and is_active) then raise exception 'PAYMENT_METHOD_UNAVAILABLE' using errcode='22023';end if;
 if j.balance_request_id is null then
   deadline:=q.deadline_at;
   if not isfinite(deadline) then
     begin deadline:=(q.request_details->>'originalPaymentDeadlineAt')::timestamptz;exception when others then deadline:=null;end;
   end if;
   if deadline is null or not isfinite(deadline) then deadline:=clock_timestamp();end if;
   insert into public.picklestreet_balance_receipt_jobs(tenant_id,booking_id,balance_request_id,hold_deadline_at,request_type,
     original_starts_at,original_ends_at,expected_amount,currency)
     values(t,b.id,q.id,deadline,q.request_type,b.starts_at,b.ends_at,q.remaining_amount,q.currency) returning * into j;
   if r.id is not null then
     insert into public.picklestreet_balance_receipt_attempts(tenant_id,booking_id,balance_request_id,receipt_id,payment_session_id,version,idempotency_key,action,
       storage_path,file_sha256,payment_reference,confidence,flags,extracted_data,outcome,completed_at,payment_method,submitted_reference)
       values(t,b.id,q.id,r.id,r.payment_session_id,0,extensions.gen_random_uuid(),'legacy_snapshot',r.storage_path,lower(r.file_sha256),r.payment_reference,
       r.confidence,r.flags,r.extracted_data,'legacy_snapshot',now(),s.provider_payload->>'paymentMethod',s.provider_payload->>'submittedReference');
   end if;
 end if;
 if q.remaining_amount<>j.expected_amount or q.currency<>j.currency then raise exception 'BALANCE_AMOUNT_CHANGED' using errcode='22023';end if;
 if s.id is null then
   insert into public.payment_sessions(tenant_id,booking_id,provider,status,amount,currency,expires_at,provider_payload)
     values(t,b.id,'manual_balance_receipt','pending',q.remaining_amount,q.currency,j.hold_deadline_at,
       jsonb_build_object('source','picklestreet_pending_balance_receipt','balanceRequestId',q.id,'requestType',q.request_type,'paymentMethod',method,'submittedReference',ref)) returning * into s;
 else
   update public.payment_sessions set status='pending',provider_payload=provider_payload||jsonb_build_object('source','picklestreet_pending_balance_receipt','paymentMethod',method,'submittedReference',ref)
     where tenant_id=t and id=s.id returning * into s;
 end if;
 if s.amount<>q.remaining_amount or s.currency<>q.currency then raise exception 'PAYMENT_AMOUNT_CHANGED' using errcode='22023';end if;
 -- Pending placeholder deliberately avoids shared AFTER INSERT infinity-hold logic.
 if r.id is null then
   insert into public.receipt_verifications(tenant_id,booking_id,balance_request_id,payment_session_id,storage_path,status,flags,extracted_data,expected_amount)
     values(t,b.id,q.id,s.id,path,'pending',array['verification_pending'],'{}',q.remaining_amount) returning * into r;
 else
   update public.receipt_verifications set payment_session_id=s.id,storage_path=path,file_sha256=null,payment_reference=null,confidence=null,
     status='pending',flags=array['verification_pending'],extracted_data='{}',reviewed_at=null,reviewed_by=null
     where tenant_id=t and id=r.id returning * into r;
 end if;
 update public.picklestreet_balance_receipt_jobs set receipt_id=r.id,payment_session_id=s.id where tenant_id=t and balance_request_id=q.id;
 -- Request transition happens while receipt is pending, avoiding the shared reschedule suspension.
 update public.booking_balance_requests set status='payment_review',deadline_at=j.hold_deadline_at,settled_at=null where tenant_id=t and id=q.id returning * into q;
 if q.request_type='short_payment' then
   update public.bookings set expires_at=j.hold_deadline_at where tenant_id=t and id=b.id;
 end if;
 update public.bookings set metadata=metadata||jsonb_build_object('balanceReceiptFlow','picklestreet_pending_balance_v1','balanceReceiptRequestId',q.id)
   where tenant_id=t and id=b.id;
 update public.booking_slots set hold_expires_at=j.hold_deadline_at where tenant_id=t and booking_id=b.id and status='held'
   and(case when q.request_type='reschedule_adjustment' then balance_request_id=q.id else balance_request_id is null end);
 update public.picklestreet_balance_receipt_attempts set outcome='superseded',completed_at=now(),error_code='verification_interrupted',flags=array['verification_interrupted']
   where tenant_id=t and id=j.current_attempt_id and outcome='processing';
 insert into public.picklestreet_balance_receipt_attempts(tenant_id,booking_id,balance_request_id,receipt_id,payment_session_id,version,idempotency_key,action,storage_path,file_sha256,payment_method,submitted_reference,actor_user_id)
   values(t,b.id,q.id,r.id,s.id,j.version+1,p_idempotency_key,p_action,path,hash,method,ref,p_actor_user_id) returning * into a;
 update public.picklestreet_balance_receipt_jobs set current_attempt_id=a.id,version=a.version,lease_token=token,lease_until=clock_timestamp()+interval '90 seconds',updated_at=now()
   where tenant_id=t and balance_request_id=q.id;
 perform public.expire_picklestreet_balance_receipt_holds(b.id);
 select * into b from public.bookings where tenant_id=t and id=b.id;
 return jsonb_build_object('claimed',true,'attemptId',a.id,'leaseToken',token,'version',a.version,'verificationId',r.id,'storagePath',path,'fileSha256',hash,
   'paymentSessionId',s.id,'paymentMethod',method,'submittedReference',ref,'expectedAmount',q.remaining_amount,'currency',q.currency,'bookingStartedAt',s.created_at,'tenantTimezone',zone,
   'balanceRequestId',q.id,'requestType',q.request_type,'balanceStatus',q.status,'bookingReference',b.reference,'bookingStatus',b.status,'paymentStatus',b.payment_status,
   'status','pending','holdExpiresAt',j.hold_deadline_at,'originalStartsAt',j.original_starts_at,'originalEndsAt',j.original_ends_at);
end;$$;

create function public.finish_picklestreet_balance_receipt_attempt(
 p_attempt_id uuid,p_lease_token uuid,p_extracted_data jsonb default null,p_flags text[] default '{}',
 p_payment_reference text default null,p_confidence numeric default null,p_auto_approve boolean default false,
 p_error_code text default null,p_receiver_snapshot jsonb default null
) returns jsonb language plpgsql security definer set search_path='' set row_security=off as $$
declare
 t constant uuid:='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';a public.picklestreet_balance_receipt_attempts%rowtype;
 j public.picklestreet_balance_receipt_jobs%rowtype;q public.booking_balance_requests%rowtype;b public.bookings%rowtype;
 r public.receipt_verifications%rowtype;s public.payment_sessions%rowtype;e public.booking_reschedule_events%rowtype;
 v_flags text[]:=coalesce(p_flags,'{}');data jsonb:=coalesce(p_extracted_data,'{}');ref text:=nullif(p_payment_reference,'');hash text;
 candidate boolean:=coalesce(p_auto_approve,false);reason text;zone text;cfg jsonb;method text;normref text;
 target_start timestamptz;target_end timestamptz;target_count integer;target_duration numeric;old_count integer;
 active_count integer;restored boolean:=false;new_total numeric;new_subtotal numeric;reschedule_id uuid;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'PICKLESTREET_SERVICE_REQUIRED' using errcode='42501';end if;
 select * into a from public.picklestreet_balance_receipt_attempts where tenant_id=t and id=p_attempt_id;
 if not found then raise exception 'ATTEMPT_NOT_FOUND' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended('picklestreet-balance:'||a.balance_request_id::text,0));
 select * into r from public.receipt_verifications where tenant_id=t and id=a.receipt_id for update;
 select * into q from public.booking_balance_requests where tenant_id=t and id=a.balance_request_id for update;
 select * into b from public.bookings where tenant_id=t and id=a.booking_id for update;
 select * into s from public.payment_sessions where tenant_id=t and id=a.payment_session_id for update;
 select * into j from public.picklestreet_balance_receipt_jobs where tenant_id=t and balance_request_id=a.balance_request_id for update;
 select * into a from public.picklestreet_balance_receipt_attempts where tenant_id=t and id=p_attempt_id for update;
 if j.current_attempt_id is distinct from a.id or j.lease_token is distinct from p_lease_token or a.outcome<>'processing' then
   return jsonb_build_object('ok',true,'stale',j.current_attempt_id is distinct from a.id,'existing',true,
     'status',r.status,'flags',to_jsonb(r.flags),'verificationId',r.id,'balanceRequestId',q.id,'requestType',q.request_type,
     'balanceStatus',q.status,'bookingReference',b.reference,'bookingStatus',b.status,'paymentStatus',b.payment_status,'rescheduleEventId',j.reschedule_event_id);
 end if;
 if r.status not in ('pending','manual_review') or q.status<>'payment_review' or j.settled_at is not null
   or q.remaining_amount<>j.expected_amount or q.currency<>j.currency or s.amount<>q.remaining_amount or s.currency<>q.currency
   or s.provider<>'manual_balance_receipt' or s.status not in ('created','pending')
   or s.provider_payload->>'balanceRequestId' is distinct from q.id::text then raise exception 'BALANCE_CONTEXT_CHANGED' using errcode='22023';end if;
 if cardinality(v_flags)>20 or exists(select 1 from unnest(v_flags) f where f is null or f !~'^[a-z0-9_]{1,40}$')
   or(ref is not null and ref !~'^[A-Z0-9][A-Z0-9-]{5,63}$') or(p_confidence is not null and(p_confidence<0 or p_confidence>1)) then
   raise exception 'EVIDENCE_INVALID' using errcode='22023';end if;
 select timezone,public_config into zone,cfg from public.tenants where id=t;
 method:=lower(s.provider_payload->>'paymentMethod');
 if method is distinct from a.payment_method or nullif(btrim(s.provider_payload->>'submittedReference'),'') is distinct from a.submitted_reference then
   candidate:=false;v_flags:=array['payment_context_changed'];end if;
 if p_error_code is not null then
   if p_error_code !~'^[a-z0-9_]{1,40}$' then raise exception 'ERROR_CODE_INVALID' using errcode='22023';end if;
   candidate:=false;v_flags:=array[p_error_code];data:='{}';
 else
   if jsonb_typeof(data) is distinct from 'object' or data->>'schemaVersion' is distinct from '2'
     or data->>'provider' is distinct from 'google_vision' or data->>'feature' is distinct from 'DOCUMENT_TEXT_DETECTION'
     or(select count(*) from jsonb_object_keys(data))<>9 or exists(select 1 from jsonb_object_keys(data) k where k<>all(array[
       'schemaVersion','provider','feature','ocrCharacterCount','file','detected','comparison','timing','confidence']))
     or jsonb_typeof(data->'file') is distinct from 'object' or jsonb_typeof(data->'detected') is distinct from 'object'
     or jsonb_typeof(data->'comparison') is distinct from 'object' or jsonb_typeof(data->'timing') is distinct from 'object'
     or jsonb_typeof(data->'confidence') is distinct from 'object'
     or data#>>'{comparison,currency}' is distinct from q.currency
     or(data#>>'{comparison,expectedAmount}')::numeric is distinct from q.remaining_amount
     or(data#>>'{timing,bookingStartedAt}')::timestamptz is distinct from s.created_at
     or data#>>'{timing,tenantTimezone}' is distinct from zone
     or(data#>>'{confidence,effective}')::numeric is distinct from p_confidence
     or coalesce(data#>>'{detected,paymentReference}','')<>coalesce(ref,'') then raise exception 'EVIDENCE_INVALID' using errcode='22023';end if;
   if(data#>>'{timing,withinWindow}')::boolean is true and(
     data#>>'{timing,receiptDateTime}' is null
     or to_char((data#>>'{timing,receiptDateTime}')::timestamptz at time zone zone,'YYYY-MM-DD') is distinct from data#>>'{timing,receiptDate}'
     or to_char((data#>>'{timing,receiptDateTime}')::timestamptz at time zone zone,'HH24:MI') is distinct from data#>>'{timing,receiptTime}'
     or(data#>>'{timing,allowedWindowMinutes}')::numeric not between 1 and 60
     or(data#>>'{timing,earlyToleranceMinutes}')::numeric not between 0 and 10
     or extract(epoch from((data#>>'{timing,receiptDateTime}')::timestamptz-s.created_at))/60
       not between -(data#>>'{timing,earlyToleranceMinutes}')::numeric and(data#>>'{timing,allowedWindowMinutes}')::numeric
   ) then raise exception 'RECEIPT_TIMING_INVALID' using errcode='22023';end if;
 end if;
 hash:=a.file_sha256;
 if hash is null then candidate:=false;v_flags:=array_append(array_remove(v_flags,'auto_approval_eligible'),'receipt_fingerprint_unavailable');end if;
 if hash is not null then
   -- Same lock namespace as the initial flow; one payment purpose owns evidence.
   perform pg_advisory_xact_lock(hashtextextended('picklestreet-file:'||hash,0));
   if exists(select 1 from public.receipt_verifications where tenant_id=t and balance_request_id is distinct from q.id and lower(file_sha256)=hash)
     or exists(select 1 from public.picklestreet_receipt_attempts where tenant_id=t and file_sha256=hash)
     or exists(select 1 from public.picklestreet_balance_receipt_attempts where tenant_id=t and balance_request_id<>q.id and file_sha256=hash) then
     candidate:=false;hash:=null;v_flags:=array_append(array_remove(v_flags,'auto_approval_eligible'),'duplicate_receipt_file');end if;
 end if;
 if ref is not null then
   normref:=regexp_replace(upper(ref),'[^A-Z0-9]','','g');
   perform pg_advisory_xact_lock(hashtextextended('picklestreet-reference:'||normref,0));
   if exists(select 1 from public.receipt_verifications where tenant_id=t and balance_request_id is distinct from q.id
       and regexp_replace(upper(payment_reference),'[^A-Z0-9]','','g')=normref)
     or exists(select 1 from public.picklestreet_receipt_attempts where tenant_id=t and regexp_replace(upper(payment_reference),'[^A-Z0-9]','','g')=normref)
     or exists(select 1 from public.picklestreet_balance_receipt_attempts where tenant_id=t and balance_request_id<>q.id
       and regexp_replace(upper(payment_reference),'[^A-Z0-9]','','g')=normref) then
     candidate:=false;ref:=null;v_flags:=array_append(array_remove(v_flags,'auto_approval_eligible'),'duplicate_payment_reference');end if;
 end if;
 -- Lock and compare exactly the account inspected by the Edge parser.
 perform 1 from public.tenant_payment_methods m where m.tenant_id=t and m.method_code=method and m.is_active
   and p_receiver_snapshot=jsonb_build_object('method',m.method_code,'name',m.account_name,'account',m.account_reference) for share;
 if not found and p_error_code is null then candidate:=false;v_flags:=array['payment_receiver_settings_changed'];end if;
 if candidate and(coalesce(p_confidence,0)<0.9 or coalesce((data#>>'{confidence,effective}')::numeric,0)<0.9
   or coalesce((data#>>'{comparison,amountMatched}')::boolean,false) is not true
   or coalesce((data#>>'{timing,withinWindow}')::boolean,false) is not true
   or nullif(data#>>'{timing,receiptDate}','') is null or nullif(data#>>'{timing,receiptTime}','') is null
   or ref is null or char_length(regexp_replace(coalesce(a.submitted_reference,''),'[^A-Za-z0-9]','','g'))<6
   or regexp_replace(upper(a.submitted_reference),'[^A-Z0-9]','','g')<>regexp_replace(upper(ref),'[^A-Z0-9]','','g')
   or cfg->>'bookingApprovalMode'='manual' or not(method='gcash' or(method='gotyme' and coalesce(cfg->'receiptAutoApprovalMethods','[]') @> '["gotyme"]'))
 ) then candidate:=false;v_flags:=array_append(array_remove(v_flags,'auto_approval_eligible'),'automatic_evidence_incomplete');end if;
 if not candidate then v_flags:=array_remove(v_flags,'auto_approval_eligible');end if;
 if cardinality(v_flags)=0 then v_flags:=array['verification_pending'];end if;
 begin
   update public.receipt_verifications set status='manual_review',file_sha256=hash,payment_reference=ref,confidence=p_confidence,flags=v_flags,extracted_data=data where tenant_id=t and id=r.id;
 exception when unique_violation then
   candidate:=false;v_flags:=array_append(array_remove(v_flags,'auto_approval_eligible'),'duplicate_receipt_evidence');
   update public.receipt_verifications set status='manual_review',file_sha256=null,payment_reference=null,confidence=p_confidence,flags=v_flags,extracted_data=data where tenant_id=t and id=r.id;
 end;
 if candidate and v_flags=array['auto_approval_eligible']::text[] then
   begin
     if b.checked_in_at is not null then raise exception 'booking_checked_in' using errcode='P0001';end if;
     if q.request_type='reschedule_adjustment' then
       if b.status<>'confirmed' or b.payment_status<>'paid' or b.starts_at is distinct from j.original_starts_at
         or b.ends_at is distinct from j.original_ends_at or b.total_amount<>q.accepted_amount
         or(q.request_details->>'oldStartsAt')::timestamptz is distinct from b.starts_at
         or(q.request_details->>'oldEndsAt')::timestamptz is distinct from b.ends_at then raise exception 'original_booking_changed' using errcode='P0001';end if;
       target_start:=(q.request_details->>'newStartsAt')::timestamptz;target_end:=(q.request_details->>'newEndsAt')::timestamptz;
       new_subtotal:=(q.request_details->>'newSubtotalAmount')::numeric;new_total:=(q.request_details->>'newTotalAmount')::numeric;
       if new_total<>q.accepted_amount+q.remaining_amount or new_total<>new_subtotal+b.service_fee_amount then raise exception 'reschedule_price_changed' using errcode='P0001';end if;
       if(q.request_details->>'newLocalDate')::date is distinct from(target_start at time zone zone)::date then
         raise exception 'reservation_slots_changed' using errcode='P0001';end if;
     else
       if b.status not in ('payment_review','expired') or b.payment_status not in ('partial','pending')
         or q.accepted_amount+q.remaining_amount<>b.total_amount then raise exception 'balance_booking_changed' using errcode='P0001';end if;
       target_start:=b.starts_at;target_end:=b.ends_at;
       if not exists(select 1 from public.receipt_verifications original join public.payment_sessions payment
         on payment.tenant_id=original.tenant_id and payment.id=original.payment_session_id
         where original.tenant_id=t and original.id=q.original_verification_id and original.status='short_payment' and payment.status='paid') then
         raise exception 'original_payment_unverified' using errcode='P0001';end if;
     end if;
     if not isfinite(target_start) or not isfinite(target_end) or target_start is null or target_end is null or target_end<=target_start
       or target_end-target_start<>j.original_ends_at-j.original_starts_at then raise exception 'reservation_slots_changed' using errcode='P0001';end if;
     if target_start<=clock_timestamp() or b.starts_at<=clock_timestamp() then raise exception 'booking_started' using errcode='P0001';end if;
     perform set_config('lock_timeout','1000ms',true);
     lock table public.blocked_dates in share mode;
     perform c.id from public.courts c where c.tenant_id=t and c.id=b.court_id for share;
     if not exists(select 1 from public.courts where tenant_id=t and id=b.court_id and status='active') then raise exception 'reservation_court_unavailable' using errcode='P0001';end if;
     perform slot.id from public.booking_slots slot where slot.tenant_id=t and slot.booking_id=b.id order by slot.starts_at,slot.id for update;
     select count(*),coalesce(sum(extract(epoch from(ends_at-starts_at))),0),count(*) filter(where status='held' and hold_expires_at>clock_timestamp())
       into target_count,target_duration,active_count from public.booking_slots where tenant_id=t and booking_id=b.id
       and(case when q.request_type='reschedule_adjustment' then balance_request_id=q.id else balance_request_id is null end);
     if target_count<1 or target_duration<>extract(epoch from(target_end-target_start)) or exists(select 1 from public.booking_slots
       where tenant_id=t and booking_id=b.id and(case when q.request_type='reschedule_adjustment' then balance_request_id=q.id else balance_request_id is null end)
       and(status not in ('held','expired') or court_id<>b.court_id or starts_at<target_start or ends_at>target_end)) then raise exception 'reservation_slots_changed' using errcode='P0001';end if;
     if exists(select 1 from public.blocked_dates blocked where blocked.tenant_id=t and(blocked.court_id is null or blocked.court_id=b.court_id)
       and blocked.blocked_on between(target_start at time zone zone)::date and((target_end-interval '1 microsecond') at time zone zone)::date
       and tsrange(target_start at time zone zone,target_end at time zone zone,'[)') && case when blocked.starts_at is null then
         tsrange(blocked.blocked_on::timestamp,(blocked.blocked_on+1)::timestamp,'[)') else tsrange(blocked.blocked_on+blocked.starts_at,
         case when blocked.ends_at=time '23:59:59' then(blocked.blocked_on+1)::timestamp else blocked.blocked_on+blocked.ends_at end,'[)') end) then
       raise exception 'reservation_court_blocked' using errcode='P0001';end if;
     -- Explicit occupancy check includes open play. Database exclusion remains
     -- authoritative for any concurrent writer after this check.
     if exists(select 1 from public.court_occupancies occupancy where occupancy.tenant_id=t and occupancy.court_id=b.court_id
       and occupancy.starts_at<target_end and occupancy.ends_at>target_start
       and(occupancy.status='confirmed' or(occupancy.status='held' and occupancy.hold_expires_at>clock_timestamp()))
       and not(occupancy.source_kind='booking_slot' and exists(select 1 from public.booking_slots own where own.tenant_id=t
         and own.booking_id=b.id and own.id=occupancy.source_id
         and(case when q.request_type='reschedule_adjustment' then own.balance_request_id=q.id else own.balance_request_id is null end)))) then
       raise exception 'reservation_time_unavailable' using errcode='P0001';end if;
     if target_start<=clock_timestamp() or b.starts_at<=clock_timestamp() then raise exception 'booking_started' using errcode='P0001';end if;
     restored:=active_count<>target_count;
     perform set_config('app.picklestreet_balance_auto',r.id::text,true);
     if q.request_type='reschedule_adjustment' then
       select count(*) into old_count from public.booking_slots where tenant_id=t and booking_id=b.id and balance_request_id is null and status='confirmed';
       if old_count<1 or(select coalesce(sum(extract(epoch from(ends_at-starts_at))),0) from public.booking_slots
         where tenant_id=t and booking_id=b.id and balance_request_id is null)<>extract(epoch from(b.ends_at-b.starts_at))
         or exists(select 1 from public.booking_slots where tenant_id=t and booking_id=b.id and balance_request_id is null
         and(status<>'confirmed' or court_id<>b.court_id or starts_at<b.starts_at or ends_at>b.ends_at)) then raise exception 'original_booking_changed' using errcode='P0001';end if;
       insert into public.booking_reschedule_events(tenant_id,booking_id,court_id,rescheduled_by,reason_code,public_reason,internal_note,notify_customer,
         customer_email_snapshot,old_starts_at,old_ends_at,new_starts_at,new_ends_at,subtotal_amount,service_fee_amount,total_amount,currency,idempotency_key,email_status)
         values(t,b.id,b.court_id,null,q.request_details->>'reasonCode',q.request_details->>'publicReason',nullif(q.request_details->>'internalNote',''),
           coalesce((q.request_details->>'notifyCustomer')::boolean,false),nullif(lower(btrim(b.customer_email)),''),b.starts_at,b.ends_at,target_start,target_end,
           new_subtotal,b.service_fee_amount,new_total,b.currency,(q.request_details->>'idempotencyKey')::uuid,'not_requested') returning * into e;
       reschedule_id:=e.id;
       delete from public.booking_slots where tenant_id=t and booking_id=b.id and balance_request_id is null;
       update public.booking_slots set status='confirmed',hold_expires_at=null,balance_request_id=null where tenant_id=t and booking_id=b.id and balance_request_id=q.id;
       update public.bookings set starts_at=target_start,ends_at=target_end,local_booking_date=(q.request_details->>'newLocalDate')::date,
         subtotal_amount=new_subtotal,total_amount=new_total,metadata=metadata||jsonb_build_object('lastReschedule',jsonb_build_object(
           'eventId',e.id,'reasonCode',e.reason_code,'publicReason',e.public_reason,'rescheduledBy',null,'rescheduledAt',e.created_at,
           'oldStartsAt',e.old_starts_at,'oldEndsAt',e.old_ends_at,'newStartsAt',e.new_starts_at,'newEndsAt',e.new_ends_at,
           'priceAdjustmentAmount',q.remaining_amount,'automaticReceiptAttemptId',a.id)) where tenant_id=t and id=b.id;
     else
       update public.booking_slots set status='confirmed',hold_expires_at=null where tenant_id=t and booking_id=b.id and balance_request_id is null;
       update public.bookings set status='confirmed',payment_status='paid',confirmed_at=now(),expires_at=null where tenant_id=t and id=b.id;
     end if;
     update public.receipt_verifications set status='auto_approved',reviewed_at=now(),reviewed_by=null,
       extracted_data=extracted_data||jsonb_build_object('automation',jsonb_build_object('decision','approved','ruleVersion','picklestreet_balance_v1','attemptId',a.id)) where tenant_id=t and id=r.id;
     update public.payment_sessions set status='paid' where tenant_id=t and id=s.id;
     update public.booking_balance_requests set status='settled',settled_at=now() where tenant_id=t and id=q.id;
     update public.picklestreet_balance_receipt_jobs set settled_at=now(),reschedule_event_id=reschedule_id where tenant_id=t and balance_request_id=q.id;
   exception when others then
     restored:=false;reschedule_id:=null;
     reason:=case when sqlerrm in('booking_checked_in','original_booking_changed','reschedule_price_changed','balance_booking_changed','original_payment_unverified',
       'booking_started','reservation_court_unavailable','reservation_slots_changed','reservation_court_blocked','reservation_time_unavailable') then sqlerrm
       when sqlstate='23P01' then 'reservation_time_unavailable' when sqlstate in('55P03','40P01','57014') then 'reservation_check_unavailable'
       else 'automatic_approval_unavailable' end;
     update public.receipt_verifications set status='manual_review',flags=array[reason] where tenant_id=t and id=r.id;
   end;
 end if;
 select * into r from public.receipt_verifications where tenant_id=t and id=r.id;
 select * into q from public.booking_balance_requests where tenant_id=t and id=q.id;
 select * into b from public.bookings where tenant_id=t and id=b.id;
 update public.picklestreet_balance_receipt_attempts set extracted_data=data,payment_reference=p_payment_reference,confidence=p_confidence,receiver_snapshot=p_receiver_snapshot,
   flags=r.flags,error_code=coalesce(p_error_code,reason),outcome=case when r.status='auto_approved' then 'auto_approved' else 'pending' end,completed_at=now()
   where tenant_id=t and id=a.id;
 update public.picklestreet_balance_receipt_jobs set lease_until=null,updated_at=now() where tenant_id=t and balance_request_id=q.id;
 return jsonb_build_object('ok',true,'status',r.status,'flags',to_jsonb(r.flags),'confidence',r.confidence,'verificationId',r.id,'attemptId',a.id,
   'balanceRequestId',q.id,'requestType',q.request_type,'balanceStatus',q.status,'bookingReference',b.reference,'bookingStatus',b.status,'paymentStatus',b.payment_status,
   'reservationRestored',restored,'reservationHeld',case when q.status='settled' then true else j.hold_deadline_at>clock_timestamp()
     and exists(select 1 from public.booking_slots where tenant_id=t and booking_id=b.id
       and(case when q.request_type='reschedule_adjustment' then balance_request_id=q.id else balance_request_id is null end))
     and not exists(select 1 from public.booking_slots where tenant_id=t and booking_id=b.id
       and(case when q.request_type='reschedule_adjustment' then balance_request_id=q.id else balance_request_id is null end)
       and(status<>'held' or hold_expires_at is null or hold_expires_at<=clock_timestamp())) end,
   'holdExpiresAt',j.hold_deadline_at,'originalStartsAt',j.original_starts_at,'originalEndsAt',j.original_ends_at,'rescheduleEventId',reschedule_id);
end;$$;

-- Initial-flow finalization must also consult the new balance history. This
-- small additive trigger prevents a stale balance image/reference from being
-- auto-approved as an initial payment after its canonical row was replaced.
create function public.guard_picklestreet_cross_payment_evidence() returns trigger
language plpgsql security definer set search_path='' set row_security=off as $$
begin
 if new.tenant_id<>'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid or new.status<>'auto_approved' or new.balance_request_id is not null then return new;end if;
 if exists(select 1 from public.picklestreet_balance_receipt_attempts a where a.tenant_id=new.tenant_id and(
   (new.file_sha256 is not null and a.file_sha256=lower(new.file_sha256)) or(new.payment_reference is not null
   and regexp_replace(upper(a.payment_reference),'[^A-Z0-9]','','g')=regexp_replace(upper(new.payment_reference),'[^A-Z0-9]','','g')))) then
   raise exception 'duplicate_balance_payment_evidence' using errcode='23505';end if;
 return new;
end;$$;
create trigger receipt_verifications_picklestreet_cross_evidence before insert or update of status on public.receipt_verifications
for each row execute function public.guard_picklestreet_cross_payment_evidence();

revoke execute on function public.guard_picklestreet_balance_receipt_state(),public.guard_picklestreet_balance_request_state(),
 public.guard_picklestreet_balance_booking_state(),public.guard_picklestreet_balance_payment_state(),public.guard_picklestreet_cross_payment_evidence()
 from public,anon,authenticated;
revoke execute on function public.expire_picklestreet_balance_receipt_holds(uuid),
 public.begin_picklestreet_balance_receipt_attempt(uuid,uuid,text,uuid,text,text,text,text,uuid),
 public.finish_picklestreet_balance_receipt_attempt(uuid,uuid,jsonb,text[],text,numeric,boolean,text,jsonb)
 from public,anon,authenticated;
grant execute on function public.expire_picklestreet_balance_receipt_holds(uuid),
 public.begin_picklestreet_balance_receipt_attempt(uuid,uuid,text,uuid,text,text,text,text,uuid),
 public.finish_picklestreet_balance_receipt_attempt(uuid,uuid,jsonb,text[],text,numeric,boolean,text,jsonb) to service_role;
commit;
