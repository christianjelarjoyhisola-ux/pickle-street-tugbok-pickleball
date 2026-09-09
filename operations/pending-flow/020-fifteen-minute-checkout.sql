-- New Pickle Street checkout holds last 15 minutes. Existing deadlines are preserved.
begin;
CREATE OR REPLACE FUNCTION public.create_picklestreet_provisional_hold(p_hostname text, p_client_request_id uuid, p_access_token_hash text, p_client_ip_hash text, p_court_id uuid, p_booking_type text, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_slots jsonb, p_subtotal_amount numeric, p_service_fee_amount numeric, p_total_amount numeric, p_currency text, p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET row_security TO 'off'
AS $function$
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
  update public.bookings set expires_at=created_at+interval '15 minutes' where tenant_id=v_tenant and id=v_booking.id returning * into v_booking;
  update public.booking_slots set hold_expires_at=v_booking.expires_at where tenant_id=v_tenant and booking_id=v_booking.id;
  insert into public.picklestreet_provisional_holds(tenant_id,booking_id,client_request_id,token_hash,client_ip_hash,
    selection_sha256,access_expires_at,hold_expires_at) values(v_tenant,v_booking.id,p_client_request_id,p_access_token_hash,p_client_ip_hash,
    v_fingerprint,greatest(v_booking.ends_at+interval '30 days',clock_timestamp()+interval '1 day'),v_booking.expires_at);
  return public.picklestreet_hold_result(v_booking.id)||jsonb_build_object('idempotent',false);
end;$function$
;
CREATE OR REPLACE FUNCTION public.create_picklestreet_group_hold(p_hostname text, p_client_request_id uuid, p_access_token_hash text, p_client_ip_hash text, p_sessions jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET row_security TO 'off'
AS $function$
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
 update public.bookings set expires_at=created_at+interval '15 minutes',starts_at=first_start,ends_at=last_end,subtotal_amount=subtotal,service_fee_amount=fee,total_amount=subtotal+fee,
  metadata=jsonb_build_object('source','picklestreet_provisional_hold','clientRequestId',p_client_request_id,'picklestreetProvisionalHold',true,
   'atomicMultiSessionBookingV1',true,'sessions',sessions,'courtHours',hours,'courtSubtotalAmount',subtotal,'equipmentRentalFeeAmount',0,
   'equipmentRental',jsonb_build_object('extraPaddles',0,'balls',0),'fullPaymentOnly',true,
   'courtName',(select string_agg(distinct s->>'courtName',', ' order by s->>'courtName') from jsonb_array_elements(sessions) s))
  where tenant_id=tenant_key and id=primary_id returning * into parent;
 update public.booking_slots set hold_expires_at=parent.expires_at where tenant_id=tenant_key and booking_id=primary_id;
 insert into public.picklestreet_provisional_holds(tenant_id,booking_id,client_request_id,token_hash,client_ip_hash,selection_sha256,access_expires_at,hold_expires_at)
 values(tenant_key,primary_id,p_client_request_id,p_access_token_hash,p_client_ip_hash,fingerprint,greatest(last_end+interval '30 days',clock_timestamp()+interval '1 day'),parent.expires_at);
 return public.picklestreet_hold_result(primary_id)||jsonb_build_object('idempotent',false);
end;$function$
;
CREATE OR REPLACE FUNCTION public.apply_picklestreet_group_reschedule(p_booking_id uuid, p_actor_user_id uuid, p_changes jsonb, p_reason_code text, p_expected_version text, p_expected_quote_hash text, p_public_reason text, p_internal_note text, p_notify_customer boolean, p_idempotency_key uuid, p_balance_request_id uuid, p_access_token_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET row_security TO 'off'
AS $function$
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
end;$function$
;
commit;
