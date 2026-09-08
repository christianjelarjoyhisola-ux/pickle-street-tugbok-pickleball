-- Pickle Street: atomic changes to all or selected paid court sessions.
-- All public entry points are service-only and verify an authenticated tenant owner/admin.
begin;

create table public.picklestreet_group_reschedule_requests (
 id uuid primary key default extensions.gen_random_uuid(),
 tenant_id uuid not null check(tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'),
 booking_id uuid not null, actor_user_id uuid not null references auth.users(id),
 idempotency_key uuid not null unique, request_sha256 text not null,
 quote jsonb not null, reason_code text not null, public_reason text not null,
 internal_note text, notify_customer boolean not null,
 balance_request_id uuid, event_id uuid,
 authorization_token uuid not null default extensions.gen_random_uuid(), transaction_id bigint,
 created_at timestamptz not null default now(), applied_at timestamptz,
 foreign key(tenant_id,booking_id) references public.bookings(tenant_id,id),
 foreign key(tenant_id,balance_request_id) references public.booking_balance_requests(tenant_id,id),
 foreign key(tenant_id,event_id) references public.booking_reschedule_events(tenant_id,id)
);
create table public.picklestreet_group_reschedule_events (
 event_id uuid primary key, tenant_id uuid not null check(tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'),
 booking_id uuid not null, before_sessions jsonb not null, after_sessions jsonb not null, quote jsonb not null,
 created_at timestamptz not null default now(),
 foreign key(tenant_id,event_id) references public.booking_reschedule_events(tenant_id,id),
 foreign key(tenant_id,booking_id) references public.bookings(tenant_id,id)
);
alter table public.picklestreet_group_reschedule_requests enable row level security;
alter table public.picklestreet_group_reschedule_events enable row level security;
revoke all on public.picklestreet_group_reschedule_requests,public.picklestreet_group_reschedule_events from public,anon,authenticated,service_role;
grant select on public.picklestreet_group_reschedule_requests,public.picklestreet_group_reschedule_events to service_role;

-- A grouped move can change the overall min/max envelope while each paid session
-- keeps its own duration. The exception requires the exact protected request quote.
create function public.picklestreet_group_event_intervals_valid(p_tenant uuid,p_booking uuid,p_key uuid,p_old_start timestamptz,p_old_end timestamptz,p_new_start timestamptz,p_new_end timestamptz)
returns boolean language sql security definer set search_path='' set row_security=off as $$
 select p_tenant='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid and exists(select 1 from public.picklestreet_group_reschedule_requests r
  where r.tenant_id=p_tenant and r.booking_id=p_booking and r.idempotency_key=p_key
  and (select min((s->>'startsAt')::timestamptz) from jsonb_array_elements(r.quote->'beforeSessions') s)=p_old_start
  and (select max((s->>'endsAt')::timestamptz) from jsonb_array_elements(r.quote->'beforeSessions') s)=p_old_end
  and (select min((s->>'startsAt')::timestamptz) from jsonb_array_elements(r.quote->'sessions') s)=p_new_start
  and (select max((s->>'endsAt')::timestamptz) from jsonb_array_elements(r.quote->'sessions') s)=p_new_end
  and jsonb_array_length(r.quote->'beforeSessions')=jsonb_array_length(r.quote->'sessions')
  and not exists(select 1 from jsonb_array_elements(r.quote->'beforeSessions') old
    where not exists(select 1 from jsonb_array_elements(r.quote->'sessions') new where old->>'sessionId'=new->>'sessionId'
     and old->>'courtId'=new->>'courtId' and(old->>'endsAt')::timestamptz-(old->>'startsAt')::timestamptz=(new->>'endsAt')::timestamptz-(new->>'startsAt')::timestamptz)));
$$;
revoke all on function public.picklestreet_group_event_intervals_valid(uuid,uuid,uuid,timestamptz,timestamptz,timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.picklestreet_group_event_intervals_valid(uuid,uuid,uuid,timestamptz,timestamptz,timestamptz,timestamptz) to service_role;
alter table public.booking_reschedule_events drop constraint booking_reschedule_events_intervals_valid;
alter table public.booking_reschedule_events add constraint booking_reschedule_events_intervals_valid check(
 old_ends_at>old_starts_at and new_ends_at>new_starts_at and(old_ends_at-old_starts_at=new_ends_at-new_starts_at
 or(tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a' and public.picklestreet_group_event_intervals_valid(tenant_id,booking_id,idempotency_key,old_starts_at,old_ends_at,new_starts_at,new_ends_at))));

create function public.assert_picklestreet_group_reschedule_actor(p_actor_user_id uuid) returns void
language plpgsql security definer set search_path='' set row_security=off as $$
begin
 if auth.role() is distinct from 'service_role' or p_actor_user_id is null or (not exists(
  select 1 from public.tenant_memberships where tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'
   and user_id=p_actor_user_id and status='active' and role in('owner','admin'))
   and not exists(select 1 from public.platform_profiles where user_id=p_actor_user_id and is_platform_owner)) then
  raise exception 'GROUP_RESCHEDULE_ACCESS_DENIED' using errcode='42501';end if;
end;$$;

create function public.picklestreet_group_schedule_snapshot(p_booking_id uuid) returns jsonb
language plpgsql security definer set search_path='' set row_security=off as $$
declare b public.bookings%rowtype;s jsonb;sessions jsonb:='[]';zone text;version text;
begin
 select * into b from public.bookings where tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a' and id=p_booking_id;
 if not found then raise exception 'GROUP_BOOKING_NOT_FOUND' using errcode='42501';end if;
 if b.metadata->'atomicMultiSessionBookingV1' is distinct from 'true'::jsonb or jsonb_typeof(b.metadata->'sessions') is distinct from 'array'
  then raise exception 'GROUP_BOOKING_REQUIRED' using errcode='22023';end if;
 select timezone into strict zone from public.tenants where id=b.tenant_id and status='active';
 for s in select value from jsonb_array_elements(b.metadata->'sessions') loop
  sessions:=sessions||jsonb_build_array(s||jsonb_build_object('sessionId',coalesce(s->>'sessionId',
   encode(extensions.digest(concat_ws('|',b.id,s->>'courtId',(s->>'startsAt')::timestamptz,(s->>'endsAt')::timestamptz),'sha256'),'hex')),
   'bookingDate',to_char((s->>'startsAt')::timestamptz at time zone zone,'YYYY-MM-DD'),
   'startTime',to_char((s->>'startsAt')::timestamptz at time zone zone,'HH24:MI')));
 end loop;
 version:=encode(extensions.digest(jsonb_build_object('sessions',sessions,'status',b.status,'paymentStatus',b.payment_status,
  'totalAmount',b.total_amount,'subtotalAmount',b.subtotal_amount,'serviceFeeAmount',b.service_fee_amount,
  'checkedInAt',b.checked_in_at,'archivedAt',b.archived_at)::text,'sha256'),'hex');
 return jsonb_build_object('booking',jsonb_build_object('id',b.id,'reference',b.reference,'customerName',b.customer_name,
  'customerEmail',b.customer_email,'status',b.status,'paymentStatus',b.payment_status,'totalAmount',b.total_amount,
  'subtotalAmount',b.subtotal_amount,'serviceFeeAmount',b.service_fee_amount,'currency',b.currency,
  'startsAt',b.starts_at,'endsAt',b.ends_at,'checkedInAt',b.checked_in_at,'archivedAt',b.archived_at),
  'sessions',sessions,'version',version,'timezone',zone);
end;$$;

create function public.get_picklestreet_group_reschedule(p_booking_id uuid,p_actor_user_id uuid) returns jsonb
language plpgsql security definer set search_path='' set row_security=off as $$
declare result jsonb;pending jsonb;
begin
 perform public.assert_picklestreet_group_reschedule_actor(p_actor_user_id);
 result:=public.picklestreet_group_schedule_snapshot(p_booking_id);
 select jsonb_build_object('id',q.id,'status',q.status,'remainingAmount',q.remaining_amount,'deadlineAt',q.deadline_at)
 into pending from public.booking_balance_requests q where q.tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a' and q.booking_id=p_booking_id
  and(q.status='payment_review' or(q.status='awaiting_payment' and q.deadline_at>clock_timestamp())) limit 1;
 return result||jsonb_build_object('history',coalesce((select jsonb_agg(jsonb_build_object('eventId',e.id,'beforeSessions',g.before_sessions,'sessions',g.after_sessions,
  'reasonCode',e.reason_code,'publicReason',e.public_reason,'rescheduledAt',e.created_at,'email',jsonb_build_object('status',e.email_status,'sentAt',e.email_sent_at)) order by e.created_at desc)
  from public.picklestreet_group_reschedule_events g join public.booking_reschedule_events e on e.tenant_id=g.tenant_id and e.id=g.event_id
  where g.tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a' and g.booking_id=p_booking_id),'[]'::jsonb),'pendingAdjustment',pending,'eligible',result#>>'{booking,status}'='confirmed'
  and result#>>'{booking,paymentStatus}'='paid' and result#>'{booking,checkedInAt}'='null'::jsonb and pending is null,
  'reasonCodes',jsonb_build_array('customer_request','weather','court_maintenance','schedule_conflict','admin_correction','other'));
end;$$;

-- Validate complete proposed sessions against opening hours, blocks and independent occupancies.
-- Old hours owned by this booking can be retained, reused or swapped between its sessions.
create function public.assert_picklestreet_group_target(p_booking_id uuid,p_sessions jsonb,p_changed_ids jsonb,p_enforce_booking_window boolean default true) returns void
language plpgsql security definer set search_path='' set row_security=off as $$
declare t constant uuid:='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';s jsonb;c public.courts%rowtype;zone text;
 starts timestamptz;ends timestamptz;local_start timestamp;local_end timestamp;op_date date;op_start timestamp;op_end timestamp;lead_minutes int;advance_days int;
begin
 select timezone into strict zone from public.tenants where id=t;
 if exists(select 1 from jsonb_array_elements(p_sessions) with ordinality a(v,n)
  join jsonb_array_elements(p_sessions) with ordinality b(v,n) on a.n<b.n and a.v->>'courtId'=b.v->>'courtId'
  and(a.v->>'startsAt')::timestamptz<(b.v->>'endsAt')::timestamptz and(b.v->>'startsAt')::timestamptz<(a.v->>'endsAt')::timestamptz) then
  raise exception 'GROUP_SESSIONS_OVERLAP' using errcode='22023';end if;
 for s in select value from jsonb_array_elements(p_sessions) where p_changed_ids ? (value->>'sessionId') loop
  select * into c from public.courts where tenant_id=t and id=(s->>'courtId')::uuid and status='active' for share;
  if not found then raise exception 'reservation_court_unavailable' using errcode='22023';end if;
  starts:=(s->>'startsAt')::timestamptz;ends:=(s->>'endsAt')::timestamptz;
  local_start:=starts at time zone zone;local_end:=ends at time zone zone;
  if not isfinite(starts) or not isfinite(ends) or ends<=starts or ends-starts<>make_interval(hours=>(s->>'durationHours')::int)
   or (s->>'durationHours')::int not between 1 and 18 or extract(minute from local_start)<>0 or extract(second from local_start)<>0 then
   raise exception 'GROUP_SESSION_DURATION_INVALID' using errcode='22023';end if;
  lead_minutes:=coalesce((c.public_config->>'minimumLeadMinutes')::int,30);advance_days:=coalesce((c.public_config->>'maximumAdvanceDays')::int,180);
  if starts<=clock_timestamp() or(p_enforce_booking_window and(starts<clock_timestamp()+make_interval(mins=>greatest(0,lead_minutes))
   or local_start::date>(clock_timestamp() at time zone zone)::date+advance_days)) then
   raise exception 'GROUP_DATE_OUTSIDE_BOOKING_WINDOW' using errcode='22023';end if;
  op_date:=local_start::date;
  if c.closes_at<=c.opens_at and local_start::time<c.closes_at then op_date:=op_date-1;end if;
  op_start:=op_date+c.opens_at;
  op_end:=case when c.closes_at<=c.opens_at or c.closes_at=time '23:59:59' then op_date+1+case when c.closes_at=time '23:59:59' then time '00:00' else c.closes_at end else op_date+c.closes_at end;
  if local_start<op_start or local_end>op_end then raise exception 'GROUP_OUTSIDE_OPENING_HOURS' using errcode='22023';end if;
  if exists(select 1 from public.blocked_dates d where d.tenant_id=t and(d.court_id is null or d.court_id=c.id)
   and tsrange(local_start,local_end,'[)') && case when d.starts_at is null then tsrange(d.blocked_on::timestamp,(d.blocked_on+1)::timestamp,'[)') else
    tsrange(d.blocked_on+d.starts_at,case when d.ends_at=time '23:59:59' then(d.blocked_on+1)::timestamp else d.blocked_on+d.ends_at end,'[)') end) then
   raise exception 'reservation_court_blocked' using errcode='22023';end if;
  if exists(select 1 from public.court_occupancies o where o.tenant_id=t and o.court_id=c.id and o.starts_at<ends and o.ends_at>starts
   and(o.status='confirmed' or(o.status='held' and o.hold_expires_at>clock_timestamp()))
   and not(o.source_kind='booking_slot' and exists(select 1 from public.booking_slots own where own.tenant_id=t and own.booking_id=p_booking_id and own.id=o.source_id))) then
   raise exception 'reservation_time_unavailable' using errcode='23P01';end if;
 end loop;
end;$$;

create function public.preview_picklestreet_group_reschedule(p_booking_id uuid,p_actor_user_id uuid,p_changes jsonb,p_reason_code text,p_expected_version text) returns jsonb
language plpgsql security definer set search_path='' set row_security=off as $$
declare snapshot jsonb;b public.bookings%rowtype;s jsonb;change jsonb;next_s jsonb;proposed jsonb:='[]';ids jsonb:='[]';
 zone text;st timestamptz;en timestamptz;rate numeric;subtotal numeric:=0;equipment numeric;raw_subtotal numeric;new_subtotal numeric;additional numeric;
 configs jsonb;result jsonb;reason text:=lower(btrim(p_reason_code));
begin
 perform public.assert_picklestreet_group_reschedule_actor(p_actor_user_id);
 snapshot:=public.picklestreet_group_schedule_snapshot(p_booking_id);
 select * into strict b from public.bookings where tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a' and id=p_booking_id;
 if snapshot->>'version' is distinct from p_expected_version then raise exception 'GROUP_RESCHEDULE_STALE' using errcode='22023';end if;
 if b.status<>'confirmed' or b.payment_status<>'paid' or b.checked_in_at is not null or b.archived_at is not null then
  raise exception 'GROUP_BOOKING_NOT_ELIGIBLE' using errcode='22023';end if;
 if reason is null or reason not in('customer_request','weather','court_maintenance','schedule_conflict','admin_correction','other') then
  raise exception 'GROUP_REASON_INVALID' using errcode='22023';end if;
 if jsonb_typeof(p_changes) is distinct from 'array' or jsonb_array_length(p_changes) not between 1 and 18
  or exists(select 1 from jsonb_array_elements(p_changes) v where jsonb_typeof(v) is distinct from 'object' or not(v?&array['sessionId','newDate','newStartTime'])
   or exists(select 1 from jsonb_object_keys(v) k where k not in('sessionId','newDate','newStartTime'))
   or v->>'newDate' !~ '^\d{4}-\d{2}-\d{2}$' or v->>'newStartTime' !~ '^(?:[01][0-9]|2[0-3]):00$')
  or(select count(distinct v->>'sessionId') from jsonb_array_elements(p_changes) v)<>jsonb_array_length(p_changes)
  or exists(select 1 from jsonb_array_elements(p_changes) v where not exists(select 1 from jsonb_array_elements(snapshot->'sessions') saved where saved->>'sessionId'=v->>'sessionId')) then
  raise exception 'GROUP_CHANGES_INVALID' using errcode='22023';end if;
 if exists(select 1 from public.weather_refund_incidents where tenant_id=b.tenant_id and booking_id=b.id)
  or exists(select 1 from public.player_rain_claims where tenant_id=b.tenant_id and booking_id=b.id and status in('submitted','awaiting_proof')) then
  raise exception 'GROUP_WEATHER_CLAIM_REQUIRES_REVIEW' using errcode='22023';end if;
 zone:=snapshot->>'timezone';
 for s in select value from jsonb_array_elements(snapshot->'sessions') loop
  next_s:=s;select value into change from jsonb_array_elements(p_changes) where value->>'sessionId'=s->>'sessionId';
  if change is not null then
   st:=((change->>'newDate')::date+(change->>'newStartTime')::time) at time zone zone;en:=st+make_interval(hours=>(s->>'durationHours')::int);
   if st is distinct from(s->>'startsAt')::timestamptz then
    if reason<>'weather' and(s->>'startsAt')::timestamptz<=clock_timestamp() then raise exception 'booking_started' using errcode='22023';end if;
    ids:=ids||jsonb_build_array(s->>'sessionId');
    if reason='weather' then rate:=(s->>'subtotalAmount')::numeric;
    else select public.regular_reschedule_court_subtotal(pricing_config,(change->>'newStartTime')::time,(s->>'durationHours')::int) into strict rate
     from public.courts where tenant_id=b.tenant_id and id=(s->>'courtId')::uuid;end if;
    next_s:=s||jsonb_build_object('startsAt',st,'endsAt',en,'bookingDate',change->>'newDate','startTime',change->>'newStartTime','subtotalAmount',rate);
   end if;
  end if;
  subtotal:=subtotal+(next_s->>'subtotalAmount')::numeric;proposed:=proposed||jsonb_build_array(next_s);
 end loop;
 if jsonb_array_length(ids)=0 then raise exception 'GROUP_RESCHEDULE_NO_CHANGE' using errcode='22023';end if;
 perform public.assert_picklestreet_group_target(b.id,proposed,ids);
 equipment:=coalesce((b.metadata->>'equipmentRentalFeeAmount')::numeric,0);raw_subtotal:=round(subtotal+equipment,2);
 new_subtotal:=case when reason='weather' then b.subtotal_amount else greatest(b.subtotal_amount,raw_subtotal) end;
 additional:=round(new_subtotal-b.subtotal_amount,2);
 select jsonb_agg(jsonb_build_object('id',c.id,'pricing',c.pricing_config,'opensAt',c.opens_at,'closesAt',c.closes_at,'config',c.public_config) order by c.id)
 into configs from public.courts c where c.tenant_id=b.tenant_id and exists(select 1 from jsonb_array_elements(proposed) target_session where target_session->>'courtId'=c.id::text);
 result:=jsonb_build_object('booking',snapshot->'booking','beforeSessions',snapshot->'sessions','sessions',proposed,'changedSessionIds',ids,
  'version',snapshot->>'version','reasonCode',reason,'timezone',zone,'price',jsonb_build_object('originalTotalAmount',b.total_amount,
   'newSubtotalAmount',new_subtotal,'newTotalAmount',new_subtotal+b.service_fee_amount,'quotedCourtSubtotalAmount',subtotal,
   'serviceFeeAmount',b.service_fee_amount,'additionalAmount',additional,'paymentRequired',additional>0,
   'retainedAmount',greatest(0,new_subtotal-raw_subtotal),'rainPricePreserved',reason='weather','currency',b.currency));
 return result||jsonb_build_object('quoteHash',encode(extensions.digest((result||jsonb_build_object('protectedCourtSettings',configs))::text,'sha256'),'hex'));
end;$$;

create function public.options_picklestreet_group_reschedule(p_booking_id uuid,p_actor_user_id uuid,p_session_id text,p_local_date date,p_expected_version text) returns jsonb
language plpgsql security definer set search_path='' set row_security=off as $$
declare snap jsonb;s jsonb;candidate jsonb;proposed jsonb;options jsonb:='[]';hr int;st timestamptz;en timestamptz;available boolean;reason text;
begin
 perform public.assert_picklestreet_group_reschedule_actor(p_actor_user_id);snap:=public.picklestreet_group_schedule_snapshot(p_booking_id);
 if snap->>'version' is distinct from p_expected_version then raise exception 'GROUP_RESCHEDULE_STALE' using errcode='22023';end if;
 select value into s from jsonb_array_elements(snap->'sessions') where value->>'sessionId'=p_session_id;
 if s is null or p_local_date is null then raise exception 'GROUP_SESSION_NOT_FOUND' using errcode='22023';end if;
 for hr in 0..23 loop
  st:=(p_local_date+make_time(hr,0,0)) at time zone(snap->>'timezone');en:=st+make_interval(hours=>(s->>'durationHours')::int);
  candidate:=s||jsonb_build_object('startsAt',st,'endsAt',en);available:=true;reason:=null;
  select jsonb_agg(case when value->>'sessionId'=p_session_id then candidate else value end) into proposed from jsonb_array_elements(snap->'sessions');
  begin perform public.assert_picklestreet_group_target(p_booking_id,jsonb_build_array(candidate),jsonb_build_array(p_session_id));
  exception when sqlstate '22023' or sqlstate '23P01' then available:=false;reason:=sqlerrm;end;
  options:=options||jsonb_build_array(jsonb_build_object('startTime',to_char(st at time zone(snap->>'timezone'),'HH24:MI'),
   'endTime',to_char(en at time zone(snap->>'timezone'),'HH24:MI'),'startsAt',st,'endsAt',en,'available',available,'unavailableReason',reason));
 end loop;
 return jsonb_build_object('options',options,'sessionId',p_session_id,'version',p_expected_version,'bookingDate',p_local_date);
end;$$;

-- The guard requires an unforgeable transaction-local request capability AND exact target.
create or replace function public.guard_picklestreet_group_schedule() returns trigger
language plpgsql security definer set search_path='' set row_security=off as $$
begin
 if old.tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a' and old.metadata->'atomicMultiSessionBookingV1'='true'::jsonb
  and(new.court_id is distinct from old.court_id or new.starts_at is distinct from old.starts_at or new.ends_at is distinct from old.ends_at or new.metadata->'sessions' is distinct from old.metadata->'sessions')
  and not(auth.role()='service_role' and exists(select 1 from public.picklestreet_group_reschedule_requests r where r.tenant_id=old.tenant_id and r.booking_id=old.id
   and r.authorization_token::text=current_setting('app.picklestreet_group_reschedule',true) and r.transaction_id=txid_current() and r.applied_at is null
   and r.quote->'sessions'=new.metadata->'sessions' and new.court_id=old.court_id)) then
  raise exception 'Multi-session bookings require a grouped reschedule; a single-court change is not allowed.' using errcode='22023';end if;
 return new;
end;$$;

-- Internal commit primitive. Its caller is either the authenticated apply RPC or the
-- existing receipt verifier/staff review after successful payment evidence checks.
create function public.commit_picklestreet_group_reschedule(p_request_id uuid) returns uuid
language plpgsql security definer set search_path='' set row_security=off as $$
declare r public.picklestreet_group_reschedule_requests%rowtype;b public.bookings%rowtype;v_event_id uuid;first_start timestamptz;last_end timestamptz;
 snap jsonb;zone text;new_total numeric;new_subtotal numeric;original_total numeric;prior text;pending public.booking_balance_requests%rowtype;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'PICKLESTREET_SERVICE_REQUIRED' using errcode='42501';end if;
 select * into strict r from public.picklestreet_group_reschedule_requests where tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a' and id=p_request_id for update;
 if r.applied_at is not null then return r.event_id;end if;
 select * into strict b from public.bookings where tenant_id=r.tenant_id and id=r.booking_id for update;
 snap:=public.picklestreet_group_schedule_snapshot(b.id);
 if snap->>'version' is distinct from r.quote->>'version' or b.status<>'confirmed' or b.payment_status<>'paid' then raise exception 'original_booking_changed' using errcode='22023';end if;
 if b.checked_in_at is not null then raise exception 'booking_checked_in' using errcode='22023';end if;
 -- Payment review can outlive the quote. Recheck weather claims under the booking
 -- lock even when moving a middle session leaves the outer booking range intact.
 if exists(select 1 from public.weather_refund_incidents where tenant_id=r.tenant_id and booking_id=b.id)
  or exists(select 1 from public.player_rain_claims where tenant_id=r.tenant_id and booking_id=b.id and status in('submitted','awaiting_proof')) then
  raise exception 'GROUP_WEATHER_CLAIM_REQUIRES_REVIEW' using errcode='22023';end if;
 if r.balance_request_id is not null then
  select * into strict pending from public.booking_balance_requests where tenant_id=r.tenant_id and id=r.balance_request_id;
  if not(public.picklestreet_staff_review_authorized('balance',pending.id) or exists(select 1 from public.picklestreet_balance_receipt_jobs j
    where j.tenant_id=r.tenant_id and j.balance_request_id=pending.id and j.receipt_id::text=current_setting('app.picklestreet_balance_auto',true)
    and j.settled_at is null and j.closed_at is null)) then raise exception 'GROUP_SETTLEMENT_ACCESS_DENIED' using errcode='42501';end if;
  if pending.status<>'payment_review' or pending.remaining_amount is distinct from(r.quote#>>'{price,additionalAmount}')::numeric
   or pending.accepted_amount<>b.total_amount then raise exception 'GROUP_SETTLEMENT_CHANGED' using errcode='22023';end if;
 end if;
 perform public.assert_picklestreet_group_target(b.id,r.quote->'sessions',r.quote->'changedSessionIds',false);
 -- Every original slot must still be present and confirmed; additional targets must
 -- correspond exactly to the requested difference (never a flattened court range).
 if exists(with expected as(select(s->>'courtId')::uuid court_id,g starts_at,g+interval '1 hour' ends_at from jsonb_array_elements(r.quote->'beforeSessions') s,
   lateral generate_series((s->>'startsAt')::timestamptz,(s->>'endsAt')::timestamptz-interval '1 hour',interval '1 hour') g),
  actual as(select court_id,starts_at,ends_at from public.booking_slots where tenant_id=r.tenant_id and booking_id=b.id and balance_request_id is null and status='confirmed')
  select 1 from((select * from expected except all select * from actual) union all(select * from actual except all select * from expected)) diff) then
  raise exception 'original_booking_changed' using errcode='22023';end if;
 if r.balance_request_id is not null and exists(with target as(select(s->>'courtId')::uuid court_id,g starts_at,g+interval '1 hour' ends_at from jsonb_array_elements(r.quote->'sessions') s,
   lateral generate_series((s->>'startsAt')::timestamptz,(s->>'endsAt')::timestamptz-interval '1 hour',interval '1 hour') g),
  expected as(select * from target except select court_id,starts_at,ends_at from public.booking_slots where tenant_id=r.tenant_id and booking_id=b.id and balance_request_id is null),
  actual as(select court_id,starts_at,ends_at from public.booking_slots where tenant_id=r.tenant_id and booking_id=b.id and balance_request_id=r.balance_request_id and status in('held','expired'))
  select 1 from((select * from expected except all select * from actual) union all(select * from actual except all select * from expected)) diff) then
  raise exception 'reservation_slots_changed' using errcode='22023';end if;
 select min((s->>'startsAt')::timestamptz),max((s->>'endsAt')::timestamptz) into first_start,last_end from jsonb_array_elements(r.quote->'sessions') s;
 zone:=r.quote->>'timezone';new_total:=(r.quote#>>'{price,newTotalAmount}')::numeric;new_subtotal:=(r.quote#>>'{price,newSubtotalAmount}')::numeric;
 insert into public.booking_reschedule_events(tenant_id,booking_id,court_id,rescheduled_by,reason_code,public_reason,internal_note,notify_customer,
  customer_email_snapshot,old_starts_at,old_ends_at,new_starts_at,new_ends_at,subtotal_amount,service_fee_amount,total_amount,currency,idempotency_key,email_status)
 values(r.tenant_id,b.id,b.court_id,r.actor_user_id,r.reason_code,r.public_reason,r.internal_note,r.notify_customer,
  nullif(lower(btrim(b.customer_email)),''),b.starts_at,b.ends_at,first_start,last_end,new_subtotal,b.service_fee_amount,new_total,b.currency,r.idempotency_key,case when r.notify_customer then 'pending' else 'not_requested' end) returning id into v_event_id;
 -- The transaction retains original occupancies until all checks pass. Exclusion
 -- constraints arbitrate concurrent writers and roll back this entire operation.
 delete from public.booking_slots stale where stale.tenant_id=r.tenant_id and stale.booking_id=b.id
  and stale.balance_request_id is not null and stale.balance_request_id is distinct from r.balance_request_id and stale.status in('cancelled','expired')
  and exists(select 1 from jsonb_array_elements(r.quote->'sessions') s where stale.court_id=(s->>'courtId')::uuid
   and stale.starts_at>=(s->>'startsAt')::timestamptz and stale.ends_at<=(s->>'endsAt')::timestamptz);
 delete from public.booking_slots where tenant_id=r.tenant_id and booking_id=b.id and(balance_request_id is null or balance_request_id=r.balance_request_id);
 insert into public.booking_slots(tenant_id,booking_id,court_id,starts_at,ends_at,status)
 select r.tenant_id,b.id,(s->>'courtId')::uuid,g,g+interval '1 hour','confirmed' from jsonb_array_elements(r.quote->'sessions') s,
  lateral generate_series((s->>'startsAt')::timestamptz,(s->>'endsAt')::timestamptz-interval '1 hour',interval '1 hour') g order by(s->>'courtId'),g;
 prior:=current_setting('app.picklestreet_group_reschedule',true);
 update public.picklestreet_group_reschedule_requests set transaction_id=txid_current() where id=r.id;
 perform set_config('app.picklestreet_group_reschedule',r.authorization_token::text,true);
 update public.bookings set starts_at=first_start,ends_at=last_end,local_booking_date=(first_start at time zone zone)::date,
  subtotal_amount=new_subtotal,total_amount=new_total,metadata=metadata||jsonb_build_object('sessions',r.quote->'sessions',
   'courtSubtotalAmount',new_subtotal-coalesce((metadata->>'equipmentRentalFeeAmount')::numeric,0),
   'rescheduleRetainedAmount',(r.quote#>>'{price,retainedAmount}')::numeric,'lastReschedule',jsonb_build_object('eventId',v_event_id,
   'groupRescheduleV1',true,'reasonCode',r.reason_code,'publicReason',r.public_reason,'rescheduledBy',r.actor_user_id,'rescheduledAt',clock_timestamp(),
   'oldStartsAt',b.starts_at,'oldEndsAt',b.ends_at,'newStartsAt',first_start,'newEndsAt',last_end,'priceAdjustmentAmount',new_total-b.total_amount))
 where tenant_id=r.tenant_id and id=b.id;
 perform set_config('app.picklestreet_group_reschedule',coalesce(prior,''),true);
 insert into public.picklestreet_group_reschedule_events(event_id,tenant_id,booking_id,before_sessions,after_sessions,quote)
 values(v_event_id,r.tenant_id,b.id,r.quote->'beforeSessions',r.quote->'sessions',r.quote);
 update public.picklestreet_group_reschedule_requests set event_id=v_event_id,applied_at=clock_timestamp() where id=r.id;
 return v_event_id;
end;$$;

create function public.apply_picklestreet_group_reschedule(p_booking_id uuid,p_actor_user_id uuid,p_changes jsonb,p_reason_code text,p_expected_version text,
 p_expected_quote_hash text,p_public_reason text,p_internal_note text,p_notify_customer boolean,p_idempotency_key uuid,p_balance_request_id uuid,p_access_token_hash text) returns jsonb
language plpgsql security definer set search_path='' set row_security=off as $$
declare t constant uuid:='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';r public.picklestreet_group_reschedule_requests%rowtype;b public.bookings%rowtype;
 q jsonb;fingerprint text;result jsonb;balance public.booking_balance_requests%rowtype;deadline timestamptz;event_id uuid;first_start timestamptz;last_end timestamptz;
begin
 perform public.assert_picklestreet_group_reschedule_actor(p_actor_user_id);
 if p_idempotency_key is null or p_notify_customer is null or length(btrim(coalesce(p_public_reason,''))) not between 3 and 500
  or(nullif(btrim(p_internal_note),'') is not null and length(btrim(p_internal_note)) not between 3 and 1000) then
  raise exception 'GROUP_REQUEST_INVALID' using errcode='22023';end if;
 fingerprint:=encode(extensions.digest(jsonb_build_object('bookingId',p_booking_id,'actorUserId',p_actor_user_id,'changes',p_changes,'reason',p_reason_code,
  'version',p_expected_version,'quoteHash',p_expected_quote_hash,'publicReason',btrim(p_public_reason),'internalNote',nullif(btrim(p_internal_note),''),'notify',p_notify_customer)::text,'sha256'),'hex');
 perform pg_advisory_xact_lock(hashtextextended('picklestreet-group-reschedule:'||p_booking_id,0));
 select * into r from public.picklestreet_group_reschedule_requests where tenant_id=t and idempotency_key=p_idempotency_key;
 if found then
  if r.request_sha256 is distinct from fingerprint then raise exception 'GROUP_IDEMPOTENCY_CONFLICT' using errcode='22023';end if;
 else
  -- Preview authorizes before row locks. The locked preview catches stale changes.
  perform public.picklestreet_group_schedule_snapshot(p_booking_id);
  select * into strict b from public.bookings where tenant_id=t and id=p_booking_id for update;
  if exists(select 1 from public.booking_balance_requests where tenant_id=t and booking_id=b.id and(status='payment_review' or(status='awaiting_payment' and deadline_at>clock_timestamp()))) then
   raise exception 'GROUP_PAYMENT_REQUEST_PENDING' using errcode='22023';end if;
  perform set_config('lock_timeout','1500ms',true);lock table public.blocked_dates in share mode;
  q:=public.preview_picklestreet_group_reschedule(p_booking_id,p_actor_user_id,p_changes,p_reason_code,p_expected_version);
  if q->>'quoteHash' is distinct from p_expected_quote_hash then raise exception 'GROUP_PRICE_QUOTE_STALE' using errcode='22023';end if;
  insert into public.picklestreet_group_reschedule_requests(tenant_id,booking_id,actor_user_id,idempotency_key,request_sha256,quote,reason_code,public_reason,internal_note,notify_customer)
  values(t,b.id,p_actor_user_id,p_idempotency_key,fingerprint,q,lower(btrim(p_reason_code)),btrim(p_public_reason),nullif(btrim(p_internal_note),''),p_notify_customer) returning * into r;
  if(q#>>'{price,additionalAmount}')::numeric>0 then
   if p_balance_request_id is null or p_access_token_hash is null or p_access_token_hash !~ '^[a-f0-9]{64}$' then raise exception 'GROUP_BALANCE_CREDENTIAL_INVALID' using errcode='22023';end if;
   deadline:=clock_timestamp()+interval '15 minutes';
   select min((s->>'startsAt')::timestamptz),max((s->>'endsAt')::timestamptz) into first_start,last_end from jsonb_array_elements(q->'sessions') s;
   if exists(select 1 from jsonb_array_elements(q->'sessions') s where q->'changedSessionIds' ? (s->>'sessionId') and(s->>'startsAt')::timestamptz<=deadline) then
    raise exception 'GROUP_PAYMENT_WINDOW_TOO_SHORT' using errcode='22023';end if;
   insert into public.booking_balance_requests(id,tenant_id,booking_id,token_hash,accepted_amount,remaining_amount,currency,status,deadline_at,issued_by,request_type,request_details)
   values(p_balance_request_id,t,b.id,p_access_token_hash,b.total_amount,(q#>>'{price,additionalAmount}')::numeric,b.currency,'awaiting_payment',deadline,p_actor_user_id,'reschedule_adjustment',
    jsonb_build_object('groupRescheduleV1',true,'groupRequestId',r.id,'originalSessions',q->'beforeSessions','proposedSessions',q->'sessions','quote',q,
     'idempotencyKey',p_idempotency_key,'oldStartsAt',b.starts_at,'oldEndsAt',b.ends_at,'newStartsAt',first_start,'newEndsAt',last_end,
     'newLocalDate',to_char(first_start at time zone(q->>'timezone'),'YYYY-MM-DD'),'newStartTime',to_char(first_start at time zone(q->>'timezone'),'HH24:MI'),
     'newSubtotalAmount',q#>'{price,newSubtotalAmount}','newTotalAmount',q#>'{price,newTotalAmount}','reasonCode',r.reason_code,
     'publicReason',r.public_reason,'internalNote',r.internal_note,'notifyCustomer',r.notify_customer));
   update public.picklestreet_group_reschedule_requests set balance_request_id=p_balance_request_id where id=r.id returning * into r;
   delete from public.booking_slots stale where stale.tenant_id=t and stale.booking_id=b.id and stale.balance_request_id is not null
    and stale.balance_request_id<>p_balance_request_id and stale.status in('cancelled','expired')
    and exists(select 1 from jsonb_array_elements(q->'sessions') s where stale.court_id=(s->>'courtId')::uuid
     and stale.starts_at>=(s->>'startsAt')::timestamptz and stale.ends_at<=(s->>'endsAt')::timestamptz);
   insert into public.booking_slots(tenant_id,booking_id,court_id,starts_at,ends_at,status,hold_expires_at,balance_request_id)
   select t,b.id,(s->>'courtId')::uuid,g,g+interval '1 hour','held',deadline,p_balance_request_id from jsonb_array_elements(q->'sessions') s,
    lateral generate_series((s->>'startsAt')::timestamptz,(s->>'endsAt')::timestamptz-interval '1 hour',interval '1 hour') g
    where not exists(select 1 from public.booking_slots old where old.tenant_id=t and old.booking_id=b.id and old.balance_request_id is null
     and old.court_id=(s->>'courtId')::uuid and old.starts_at=g and old.ends_at=g+interval '1 hour') order by(s->>'courtId'),g;
  else
   event_id:=public.commit_picklestreet_group_reschedule(r.id);
   select * into r from public.picklestreet_group_reschedule_requests where id=r.id;
  end if;
 end if;
 if r.balance_request_id is not null then select * into balance from public.booking_balance_requests where tenant_id=t and id=r.balance_request_id;end if;
 return jsonb_build_object('booking',public.picklestreet_group_schedule_snapshot(p_booking_id)->'booking','sessions',r.quote->'sessions','beforeSessions',r.quote->'beforeSessions',
  'price',r.quote->'price','rescheduleEventId',r.event_id,'groupRescheduleEventId',r.event_id,'groupRescheduleV1',true,'paymentRequired',r.balance_request_id is not null and r.applied_at is null,
  'balanceRequest',case when balance.id is null then null else jsonb_build_object('id',balance.id,'status',balance.status,'remainingAmount',balance.remaining_amount,'deadlineAt',balance.deadline_at) end,
  'idempotent',r.created_at<statement_timestamp());
end;$$;

-- Receipt integration and service grants are generated below, with exact anchors.
CREATE OR REPLACE FUNCTION public.finish_picklestreet_balance_receipt_attempt(p_attempt_id uuid, p_lease_token uuid, p_extracted_data jsonb DEFAULT NULL::jsonb, p_flags text[] DEFAULT '{}'::text[], p_payment_reference text DEFAULT NULL::text, p_confidence numeric DEFAULT NULL::numeric, p_auto_approve boolean DEFAULT false, p_error_code text DEFAULT NULL::text, p_receiver_snapshot jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET row_security TO 'off'
AS $function$
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
 if data#>'{detected,route}' is not null then
   if not public.picklestreet_receipt_route_config_current(method,p_receiver_snapshot) and p_error_code is null then
     candidate:=false;v_flags:=array['payment_receiver_settings_changed'];end if;
 else
 perform 1 from public.tenant_payment_methods m where m.tenant_id=t and m.method_code=method and m.is_active
   and p_receiver_snapshot=jsonb_build_object('method',m.method_code,'name',m.account_name,'account',m.account_reference) for share;
 if not found and p_error_code is null then candidate:=false;v_flags:=array['payment_receiver_settings_changed'];end if;
 end if;
 if candidate and(coalesce(p_confidence,0)<0.9 or coalesce((data#>>'{confidence,effective}')::numeric,0)<0.9
   or coalesce((data#>>'{comparison,amountMatched}')::boolean,false) is not true
   or coalesce((data#>>'{timing,withinWindow}')::boolean,false) is not true
   or nullif(data#>>'{timing,receiptDate}','') is null or nullif(data#>>'{timing,receiptTime}','') is null
   or ref is null or char_length(regexp_replace(coalesce(a.submitted_reference,''),'[^A-Za-z0-9]','','g'))<6
   or regexp_replace(upper(a.submitted_reference),'[^A-Z0-9]','','g')<>regexp_replace(upper(ref),'[^A-Z0-9]','','g')
   or cfg->>'bookingApprovalMode'='manual' or not(case when data#>'{detected,route}' is not null
     then public.picklestreet_receipt_route_ready(method,data,p_receiver_snapshot)
     else method='gcash' or(method='gotyme' and coalesce(cfg->'receiptAutoApprovalMethods','[]') @> '["gotyme"]') end)
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
     if q.request_details->'groupRescheduleV1'='true'::jsonb then
       perform set_config('app.picklestreet_balance_auto',r.id::text,true);
       reschedule_id:=public.commit_picklestreet_group_reschedule((q.request_details->>'groupRequestId')::uuid);
     else
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
       when sqlerrm='duplicate_payment_route_reference' then 'duplicate_payment_route_reference'
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
end;$function$
;
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
   if q.request_details->'groupRescheduleV1'='true'::jsonb then
     reschedule_id:=public.commit_picklestreet_group_reschedule((q.request_details->>'groupRequestId')::uuid);
   else
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
end;$function$
;
revoke all on function public.assert_picklestreet_group_reschedule_actor(uuid) from public,anon,authenticated,service_role;
revoke all on function public.picklestreet_group_schedule_snapshot(uuid) from public,anon,authenticated,service_role;
revoke all on function public.assert_picklestreet_group_target(uuid,jsonb,jsonb,boolean) from public,anon,authenticated,service_role;
revoke all on function public.commit_picklestreet_group_reschedule(uuid) from public,anon,authenticated,service_role;
revoke all on function public.get_picklestreet_group_reschedule(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_picklestreet_group_reschedule(uuid,uuid) to service_role;
revoke all on function public.options_picklestreet_group_reschedule(uuid,uuid,text,date,text) from public,anon,authenticated,service_role;
grant execute on function public.options_picklestreet_group_reschedule(uuid,uuid,text,date,text) to service_role;
revoke all on function public.preview_picklestreet_group_reschedule(uuid,uuid,jsonb,text,text) from public,anon,authenticated,service_role;
grant execute on function public.preview_picklestreet_group_reschedule(uuid,uuid,jsonb,text,text) to service_role;
revoke all on function public.apply_picklestreet_group_reschedule(uuid,uuid,jsonb,text,text,text,text,text,boolean,uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.apply_picklestreet_group_reschedule(uuid,uuid,jsonb,text,text,text,text,text,boolean,uuid,uuid,text) to service_role;
create function public.expire_picklestreet_group_unsubmitted_reschedules() returns integer
language plpgsql security definer set search_path='' set row_security=off as $$
declare t constant uuid:='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';candidate record;q public.booking_balance_requests%rowtype;n integer:=0;
begin
 if auth.role() is distinct from 'service_role' and session_user is distinct from 'postgres' then raise exception 'PICKLESTREET_SERVICE_REQUIRED' using errcode='42501';end if;
 for candidate in select id from public.booking_balance_requests where tenant_id=t and request_details->'groupRescheduleV1'='true'::jsonb
  and status='awaiting_payment' and deadline_at<=clock_timestamp() order by id loop
  perform pg_advisory_xact_lock(hashtextextended('picklestreet-balance:'||candidate.id,0));
  select * into q from public.booking_balance_requests where tenant_id=t and id=candidate.id and status='awaiting_payment' and deadline_at<=clock_timestamp() for update;
  if not found then continue;end if;
  if exists(select 1 from public.receipt_verifications where tenant_id=t and balance_request_id=q.id and status<>'rejected')
   or exists(select 1 from public.payment_sessions where tenant_id=t and booking_id=q.booking_id and provider_payload->>'balanceRequestId'=q.id::text and status not in('failed','expired','refunded'))
   or exists(select 1 from public.payment_receipt_uploads where tenant_id=t and balance_request_id=q.id and status in('uploaded','finalizing')) then continue;end if;
  update public.booking_balance_requests set status='expired' where tenant_id=t and id=q.id;
  update public.booking_slots set status='expired',hold_expires_at=q.deadline_at where tenant_id=t and booking_id=q.booking_id and balance_request_id=q.id and status='held';
  n:=n+1;
 end loop;
 return n;
end;$$;
revoke all on function public.expire_picklestreet_group_unsubmitted_reschedules() from public,anon,authenticated;
grant execute on function public.expire_picklestreet_group_unsubmitted_reschedules() to service_role;

create or replace function public.run_picklestreet_balance_hold_cleanup() returns integer
language plpgsql security definer set search_path='' set row_security=off set lock_timeout='1000ms' as $$
declare n integer;
begin
 n:=public.expire_picklestreet_group_unsubmitted_reschedules();
 return n+public.expire_picklestreet_balance_receipt_holds(null);
end;$$;

create function public.list_due_picklestreet_group_reschedule_emails() returns table(event_id uuid,booking_id uuid)
language sql security definer set search_path='' set row_security=off as $$
 select e.id,e.booking_id from public.picklestreet_group_reschedule_events g
 join public.booking_reschedule_events e on e.tenant_id=g.tenant_id and e.id=g.event_id
 join public.bookings b on b.tenant_id=e.tenant_id and b.id=e.booking_id
 where auth.role()='service_role' and g.tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'
  and b.metadata#>>'{lastReschedule,eventId}'=e.id::text and b.status='confirmed' and b.payment_status='paid' and b.archived_at is null
  and b.ends_at>clock_timestamp() and e.notify_customer and(e.email_status='pending' or(e.email_status='failed'
   and(e.email_started_at is null or e.email_started_at<clock_timestamp()-interval '1 minute')))
 order by e.created_at,e.id limit 10;
$$;
revoke all on function public.list_due_picklestreet_group_reschedule_emails() from public,anon,authenticated;
grant execute on function public.list_due_picklestreet_group_reschedule_emails() to service_role;
CREATE OR REPLACE FUNCTION public.dispatch_picklestreet_rejection_emails()
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare dispatch_secret text; request_id bigint;
begin
  if not exists(select 1 from public.picklestreet_rejection_emails
    where tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a' and status<>'sent'
      and (lease_until is null or lease_until<now())) and not exists(
    select 1 from public.picklestreet_group_reschedule_events g
    join public.booking_reschedule_events e on e.tenant_id=g.tenant_id and e.id=g.event_id
    join public.bookings b on b.tenant_id=e.tenant_id and b.id=e.booking_id
    where g.tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a' and b.metadata#>>'{lastReschedule,eventId}'=e.id::text
      and b.status='confirmed' and b.payment_status='paid' and b.archived_at is null and b.ends_at>clock_timestamp()
      and e.notify_customer and(e.email_status='pending' or(e.email_status='failed'
        and(e.email_started_at is null or e.email_started_at<clock_timestamp()-interval '1 minute')))
  ) then return null;end if;
  select decrypted_secret into strict dispatch_secret from vault.decrypted_secrets
    where name='picklestreet_email_dispatch_secret';
  select net.http_post(
    url:='https://neqvrwtofiolcuxewdze.supabase.co/functions/v1/picklestreet-email-dispatch',
    headers:=jsonb_build_object('Content-Type','application/json','x-dispatch-secret',dispatch_secret),
    body:='{}'::jsonb,timeout_milliseconds:=30000
  ) into request_id;
  return request_id;
end;$function$
;
commit;
