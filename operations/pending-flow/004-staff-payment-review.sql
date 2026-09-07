-- Additive Pickle Street staff payment review. Apply only after rollback validation.
begin;
create table public.picklestreet_receipt_staff_reviews (
 id uuid primary key default extensions.gen_random_uuid(),
 tenant_id uuid not null default 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'
   check(tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid),
 booking_id uuid not null, verification_id uuid not null, payment_session_id uuid not null,
 balance_request_id uuid, expected_attempt_id uuid not null, idempotency_key uuid not null,
 decision text not null check(decision in('approve','reject')),
 review_note text not null check(char_length(review_note) between 3 and 1000),
 actor_user_id uuid not null references auth.users(id),
 authorization_token uuid not null default extensions.gen_random_uuid(),
 transaction_id bigint not null default txid_current(),
 before_state jsonb not null, result jsonb,
 created_at timestamptz not null default clock_timestamp(), completed_at timestamptz,
 unique(tenant_id,idempotency_key), unique(tenant_id,verification_id),
 foreign key(tenant_id,booking_id) references public.bookings(tenant_id,id),
 foreign key(tenant_id,verification_id) references public.receipt_verifications(tenant_id,id),
 foreign key(tenant_id,payment_session_id) references public.payment_sessions(tenant_id,id),
 foreign key(tenant_id,balance_request_id) references public.booking_balance_requests(tenant_id,id),
 check((result is null and completed_at is null) or (result is not null and completed_at is not null))
);
alter table public.picklestreet_receipt_staff_reviews enable row level security;
-- Service callers can read context; only SECURITY DEFINER review can write audit rows.
revoke all on public.picklestreet_receipt_staff_reviews from public,anon,authenticated,service_role;
grant select on public.picklestreet_receipt_staff_reviews to service_role;
alter table public.picklestreet_balance_receipt_jobs add column closed_at timestamptz;

create function public.picklestreet_staff_review_authorized(p_kind text,p_id uuid)
returns boolean language sql stable security definer set search_path='' set row_security=off as $$
 select auth.role()='service_role' and exists(
   select 1 from public.picklestreet_receipt_staff_reviews d
   where d.tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'
   and d.authorization_token::text=coalesce(current_setting('app.picklestreet_staff_review',true),'')
   and d.transaction_id=txid_current() and d.completed_at is null
   and case p_kind when 'receipt' then d.verification_id=p_id when 'booking' then d.booking_id=p_id
     when 'balance' then d.balance_request_id=p_id when 'payment' then d.payment_session_id=p_id else false end
 );
$$;
revoke execute on function public.picklestreet_staff_review_authorized(text,uuid) from public,anon,authenticated,service_role;

create function public.guard_picklestreet_staff_review_audit() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_op='DELETE' or old.completed_at is not null then raise exception 'STAFF_REVIEW_AUDIT_IMMUTABLE' using errcode='42501';end if;
 if new.id is distinct from old.id or new.tenant_id is distinct from old.tenant_id
   or new.booking_id is distinct from old.booking_id or new.verification_id is distinct from old.verification_id
   or new.payment_session_id is distinct from old.payment_session_id or new.balance_request_id is distinct from old.balance_request_id
   or new.expected_attempt_id is distinct from old.expected_attempt_id or new.idempotency_key is distinct from old.idempotency_key
   or new.decision is distinct from old.decision or new.review_note is distinct from old.review_note
   or new.actor_user_id is distinct from old.actor_user_id or new.authorization_token is distinct from old.authorization_token
   or new.transaction_id is distinct from old.transaction_id or new.before_state is distinct from old.before_state
   or new.created_at is distinct from old.created_at or new.completed_at is null or new.result is null
   or not public.picklestreet_staff_review_authorized('receipt',old.verification_id) then
   raise exception 'STAFF_REVIEW_AUDIT_IMMUTABLE' using errcode='42501';end if;
 return new;
end;$$;
create trigger picklestreet_staff_review_audit_immutable before update or delete on public.picklestreet_receipt_staff_reviews
for each row execute function public.guard_picklestreet_staff_review_audit();
revoke execute on function public.guard_picklestreet_staff_review_audit() from public,anon,authenticated,service_role;

create or replace function public.guard_picklestreet_receipt_state()
returns trigger language plpgsql security definer set search_path='' set row_security=off as $$
begin

  if new.tenant_id<>'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid then return new;end if;
  if public.picklestreet_staff_review_authorized('receipt',new.id) then return new;end if;
  if tg_op='UPDATE' and new.tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid
    and old.status in('approved','rejected') and exists(select 1 from public.picklestreet_receipt_staff_reviews d
      where d.tenant_id=new.tenant_id and d.verification_id=new.id and d.completed_at is not null) then
    if new.status is distinct from old.status then raise exception 'PICKLESTREET_STAFF_DECISION_IMMUTABLE' using errcode='22023';end if;
    return new;
  end if;
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

create or replace function public.guard_picklestreet_booking_state()
returns trigger language plpgsql security definer set search_path='' set row_security=off as $$
declare v_receipt_id uuid;
begin

  if new.tenant_id<>'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid then return new;end if;
  if public.picklestreet_staff_review_authorized('booking',new.id) then return new;end if;
  if new.tenant_id <> 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid then return new; end if;
  select j.receipt_id into v_receipt_id from public.picklestreet_receipt_jobs j
    join public.receipt_verifications r on r.tenant_id=j.tenant_id and r.id=j.receipt_id and r.balance_request_id is null and r.status not in('approved','rejected')
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

create or replace function public.guard_picklestreet_payment_session_state()
returns trigger language plpgsql security definer set search_path='' set row_security=off as $$
declare v_receipt_id uuid;
begin

  if new.tenant_id<>'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid then return new;end if;
  if public.picklestreet_staff_review_authorized('payment',new.id) then return new;end if;
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

create or replace function public.guard_picklestreet_balance_receipt_state() returns trigger
language plpgsql security definer set search_path='' set row_security=off as $$
declare j public.picklestreet_balance_receipt_jobs%rowtype;
begin

  if new.tenant_id<>'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid then return new;end if;
  if public.picklestreet_staff_review_authorized('receipt',new.id) then return new;end if;
  if tg_op='UPDATE' and new.tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid
    and old.status in('approved','rejected') and exists(select 1 from public.picklestreet_receipt_staff_reviews d
      where d.tenant_id=new.tenant_id and d.verification_id=new.id and d.completed_at is not null) then
    if new.status is distinct from old.status then raise exception 'PICKLESTREET_STAFF_DECISION_IMMUTABLE' using errcode='22023';end if;
    return new;
  end if;
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

create or replace function public.guard_picklestreet_balance_request_state() returns trigger
language plpgsql security definer set search_path='' set row_security=off as $$
declare j public.picklestreet_balance_receipt_jobs%rowtype;
begin

  if new.tenant_id<>'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid then return new;end if;
  if public.picklestreet_staff_review_authorized('balance',new.id) then return new;end if;
  if new.tenant_id<>'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid then return new;end if;
  select * into j from public.picklestreet_balance_receipt_jobs where tenant_id=new.tenant_id and balance_request_id=new.id;
  if not found or j.settled_at is not null then return new;end if;
  if j.closed_at is not null then
    if new.status is distinct from old.status then raise exception 'PICKLESTREET_STAFF_DECISION_IMMUTABLE' using errcode='22023';end if;
    return new;
  end if;
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

create or replace function public.guard_picklestreet_balance_booking_state() returns trigger
language plpgsql security definer set search_path='' set row_security=off as $$
declare j public.picklestreet_balance_receipt_jobs%rowtype;
begin

  if new.tenant_id<>'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid then return new;end if;
  if public.picklestreet_staff_review_authorized('booking',new.id) then return new;end if;
  if new.tenant_id<>'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid then return new;end if;
  select * into j from public.picklestreet_balance_receipt_jobs where tenant_id=new.tenant_id and booking_id=new.id and settled_at is null and closed_at is null limit 1;
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

create or replace function public.guard_picklestreet_balance_payment_state() returns trigger
language plpgsql security definer set search_path='' set row_security=off as $$
declare j public.picklestreet_balance_receipt_jobs%rowtype;
begin

  if new.tenant_id<>'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid then return new;end if;
  if public.picklestreet_staff_review_authorized('payment',new.id) then return new;end if;
  if new.tenant_id<>'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid then return new;end if;
  select * into j from public.picklestreet_balance_receipt_jobs where tenant_id=new.tenant_id and payment_session_id=new.id and settled_at is null;
  if not found then return new;end if;
  if j.closed_at is not null then
    if new.status is distinct from old.status then raise exception 'PICKLESTREET_STAFF_DECISION_IMMUTABLE' using errcode='22023';end if;
    return new;
  end if;
  if new.status in ('failed','expired') then new.status:='pending';end if;
  if new.status='paid' and old.status is distinct from 'paid' and coalesce(current_setting('app.picklestreet_balance_auto',true),'')<>j.receipt_id::text then
    raise exception 'PICKLESTREET_AUTOMATIC_VERIFICATION_REQUIRED' using errcode='42501';end if;
  return new;
end;$$;
create function public.review_picklestreet_pending_receipt(
 p_verification_id uuid,p_expected_attempt_id uuid,p_idempotency_key uuid,
 p_decision text,p_review_note text,p_actor_user_id uuid
) returns jsonb language plpgsql security definer set search_path='' set row_security=off as $$
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
end;$$;
revoke execute on function public.review_picklestreet_pending_receipt(uuid,uuid,uuid,text,text,uuid) from public,anon,authenticated;
grant execute on function public.review_picklestreet_pending_receipt(uuid,uuid,uuid,text,text,uuid) to service_role;

commit;
