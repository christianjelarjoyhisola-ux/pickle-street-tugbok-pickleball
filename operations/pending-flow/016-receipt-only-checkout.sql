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
  update public.bookings set expires_at=created_at+interval '10 minutes' where tenant_id=v_tenant and id=v_booking.id returning * into v_booking;
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
 update public.bookings set expires_at=created_at+interval '10 minutes',starts_at=first_start,ends_at=last_end,subtotal_amount=subtotal,service_fee_amount=fee,total_amount=subtotal+fee,
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
   deadline:=clock_timestamp()+interval '10 minutes';
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
CREATE OR REPLACE FUNCTION public.picklestreet_receipt_route_ready(p_method text, p_data jsonb, p_snapshot jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET row_security TO 'off'
AS $function$
declare t constant uuid:='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';source text:=public.picklestreet_source_provider(p_method);
 route jsonb:=p_data#>'{detected,route}';
begin
 -- Old Maya-to-GCash evidence must never approve a native Maya payment.
 if lower(p_method)='maya' then return false;end if;
 if source is null or source not in('gcash','bdopay','maya','bpi','gotyme','maribank') or jsonb_typeof(route) is distinct from 'object'
   or route->>'schemaVersion' is distinct from '1' or route->>'sourceProvider' is distinct from source
   or route->>'routeId' is distinct from source||'_to_gcash' or route->>'destinationProvider' is distinct from 'gcash'
   or route->>'destinationMethodCode' is distinct from 'gcash'
   or route->>'parserVersion' is distinct from (case when source='gcash' then 'gcash_v1' else source||'_to_gcash_v1' end)
   or route->'sourceMatched' is distinct from 'true'::jsonb
   or route->'destinationMatched' is distinct from 'true'::jsonb
   or route->'recipientMatched' is distinct from 'true'::jsonb
   or route->'referenceMatched' is distinct from 'true'::jsonb
   or route->'successMatched' is distinct from 'true'::jsonb
   or jsonb_typeof(p_data#>'{confidence,vision}') is distinct from 'number'
   or jsonb_typeof(p_data#>'{confidence,effective}') is distinct from 'number'
   or coalesce((p_data#>>'{confidence,vision}')::numeric,0) not between 0.9 and 1
   or coalesce((p_data#>>'{confidence,effective}')::numeric,0) not between 0.9 and (p_data#>>'{confidence,vision}')::numeric
   or coalesce((p_data#>>'{timing,allowedWindowMinutes}')::numeric,0)<>10
   or coalesce((p_data#>>'{timing,earlyToleranceMinutes}')::numeric,11) not between 0 and 2 then return false;end if;
 if jsonb_typeof(route->'secondaryReferences') is distinct from 'array' then return false;end if;
 if jsonb_array_length(route->'secondaryReferences')<>(case when source='gcash' then 0 else 1 end) then return false;end if;
 if source<>'gcash' and ((route#>>'{secondaryReferences,0,kind}') is distinct from (case source
     when 'bdopay' then 'bdopay_invoice' when 'bpi' then 'bpi_transaction' when 'maya' then 'maya_instapay' else 'instapay' end)
   or coalesce(route#>>'{secondaryReferences,0,value}','') !~ '^[A-Z0-9]{3,64}$') then return false;end if;
 if not public.picklestreet_receipt_route_config_current(p_method,p_snapshot) then return false;end if;
 if source in('bdopay','bpi') and not exists(select 1 from public.picklestreet_receipt_route_settings where tenant_id=t
   and char_length(btrim(gcash_qr_alias))>=2
   and regexp_replace(upper(gcash_qr_token),'[^A-Z0-9]','','g') ~ '^[A-Z0-9]{10,40}$'
   and gcash_qr_token ~* '[a-z]' and gcash_qr_token ~ '[0-9]') then return false;end if;
 return exists(select 1 from public.tenants where id=t and coalesce(public_config->>'bookingApprovalMode','')<>'manual');
exception when invalid_text_representation or numeric_value_out_of_range then return false;
end;$function$
;
CREATE OR REPLACE FUNCTION public.auto_approve_picklestreet_receipt_route(p_verification_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET row_security TO 'off'
AS $function$
declare
  v_verification public.receipt_verifications%rowtype;
  v_booking public.bookings%rowtype;
  v_payment public.payment_sessions%rowtype;
  v_balance_request public.booking_balance_requests%rowtype;
  v_payment_method text;
  v_submitted_reference text;
  v_detected_reference text;
  v_expected_started_at timestamptz;
  v_active_slot_count integer;
  v_total_slot_count integer;
begin
  if auth.role() is distinct from 'service_role' or coalesce(current_setting('app.picklestreet_auto_approval',true),'')<>p_verification_id::text then
    raise exception 'PICKLESTREET_SERVICE_REQUIRED' using errcode='42501';end if;
  select * into v_verification
  from public.receipt_verifications
  where id = p_verification_id and tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'
  for update;
  if not found then
    raise exception 'receipt_verification_not_found' using errcode = '22023';
  end if;
  if v_verification.status = 'auto_approved' then
    select * into v_booking from public.bookings
    where tenant_id = v_verification.tenant_id
      and id = v_verification.booking_id;
    return jsonb_build_object(
      'id', v_verification.id,
      'status', v_verification.status,
      'confidence', v_verification.confidence,
      'flags', to_jsonb(v_verification.flags),
      'bookingReference', v_booking.reference,
      'bookingStatus', v_booking.status,
      'paymentStatus', v_booking.payment_status
    );
  end if;
  if v_verification.status <> 'manual_review'
     or v_verification.flags <> array['auto_approval_eligible']::text[]
     or v_verification.extracted_data ->> 'schemaVersion' <> '2'
     or v_verification.extracted_data ->> 'feature' <> 'DOCUMENT_TEXT_DETECTION'
     or coalesce(v_verification.confidence, 0) < 0.9
     or coalesce(
       (v_verification.extracted_data #>> '{confidence,effective}')::numeric, 0
     ) < 0.9
     or coalesce(
       (v_verification.extracted_data #>> '{comparison,amountMatched}')::boolean,
       false
     ) is not true
     or coalesce(
       (v_verification.extracted_data #>> '{timing,withinWindow}')::boolean,
       false
     ) is not true
     or nullif(v_verification.extracted_data #>> '{timing,receiptDate}', '') is null
     or nullif(v_verification.extracted_data #>> '{timing,receiptTime}', '') is null
     or nullif(v_verification.extracted_data #>> '{timing,receiptDateTime}', '') is null
     or v_verification.payment_reference is null
     or v_verification.payment_session_id is null then
    raise exception 'receipt_not_eligible_for_auto_approval'
      using errcode = '22023';
  end if;

  select * into v_payment
  from public.payment_sessions
  where tenant_id = v_verification.tenant_id
    and booking_id = v_verification.booking_id
    and id = v_verification.payment_session_id
    and provider in ('manual_receipt', 'manual_balance_receipt')
    and status in ('created', 'pending')
  for update;
  if not found then
    raise exception 'payment_session_not_eligible_for_auto_approval'
      using errcode = '22023';
  end if;

  v_payment_method := lower(coalesce(
    v_payment.provider_payload ->> 'paymentMethod', ''
  ));
  if public.picklestreet_source_provider(v_payment_method) not in('gcash','bdopay','maya','bpi','gotyme','maribank')
    or v_verification.extracted_data#>>'{detected,route,sourceProvider}' is distinct from public.picklestreet_source_provider(v_payment_method)
    or v_verification.extracted_data#>>'{detected,route,destinationProvider}' is distinct from 'gcash'
    or v_verification.balance_request_id is not null then
    raise exception 'payment_session_not_eligible_for_auto_approval' using errcode='22023';end if;

  v_submitted_reference := pg_catalog.regexp_replace(
    upper(v_payment.provider_payload ->> 'submittedReference'),
    '[^A-Z0-9]', '', 'g'
  );
  v_detected_reference := pg_catalog.regexp_replace(
    upper(v_verification.payment_reference), '[^A-Z0-9]', '', 'g'
  );
  if char_length(v_detected_reference) < 6 or (nullif(v_submitted_reference,'') is not null and
     (char_length(v_submitted_reference) < 6 or v_detected_reference <> v_submitted_reference)) then
    raise exception 'payment_reference_mismatch' using errcode = '22023';
  end if;

  select * into v_booking
  from public.bookings
  where tenant_id = v_verification.tenant_id
    and id = v_verification.booking_id
  for update;
  v_expected_started_at := case
    when v_payment.provider = 'manual_balance_receipt' then v_payment.created_at
    else v_booking.created_at
  end;
  if not found
     or v_booking.status <> 'payment_review'
     or v_booking.payment_status <> 'pending'
     or v_booking.expires_at is null
     or v_booking.expires_at <= now()
     or v_expected_started_at <>
       (v_verification.extracted_data #>> '{timing,bookingStartedAt}')::timestamptz
     or v_payment.amount <> v_verification.expected_amount
     or v_payment.currency <> v_booking.currency then
    raise exception 'booking_not_eligible_for_auto_approval'
      using errcode = '22023';
  end if;

  if v_verification.balance_request_id is null then
    if v_payment.provider <> 'manual_receipt'
       or v_payment.amount <> v_booking.total_amount then
      raise exception 'booking_not_eligible_for_auto_approval'
        using errcode = '22023';
    end if;
  else
    select * into v_balance_request
    from public.booking_balance_requests
    where tenant_id = v_booking.tenant_id
      and booking_id = v_booking.id
      and id = v_verification.balance_request_id
    for update;
    if not found
       or v_payment.provider <> 'manual_balance_receipt'
       or v_balance_request.status <> 'payment_review'
       or v_balance_request.deadline_at <= now()
       or v_payment.amount <> v_balance_request.remaining_amount then
      raise exception 'balance_request_not_eligible_for_auto_approval'
        using errcode = '22023';
    end if;
  end if;

  select count(*), count(*) filter (
    where status = 'held' and hold_expires_at > now()
  )
  into v_total_slot_count, v_active_slot_count
  from public.booking_slots
  where tenant_id = v_booking.tenant_id
    and booking_id = v_booking.id;
  if v_total_slot_count < 1 or v_active_slot_count <> v_total_slot_count then
    raise exception 'booking_slots_not_eligible_for_auto_approval'
      using errcode = '22023';
  end if;

  update public.receipt_verifications
  set status = 'auto_approved',
      reviewed_at = now(),
      extracted_data = extracted_data || jsonb_build_object(
        'automation', jsonb_build_object(
          'decision', 'approved',
          'ruleVersion', 'picklestreet_source_route_v1'
        )
      )
  where id = v_verification.id;
  update public.bookings
  set status = 'confirmed',
      payment_status = 'paid',
      confirmed_at = now(),
      expires_at = null
  where tenant_id = v_booking.tenant_id
    and id = v_booking.id;
  update public.booking_slots
  set status = 'confirmed', hold_expires_at = null
  where tenant_id = v_booking.tenant_id
    and booking_id = v_booking.id
    and status = 'held';
  update public.payment_sessions
  set status = 'paid'
  where tenant_id = v_payment.tenant_id
    and id = v_payment.id
    and status in ('created', 'pending');
  if v_balance_request.id is not null then
    update public.booking_balance_requests
    set status = 'settled',
        settled_at = now()
    where id = v_balance_request.id;
  end if;

  return jsonb_build_object(
    'id', v_verification.id,
    'status', 'auto_approved',
    'confidence', v_verification.confidence,
    'flags', to_jsonb(v_verification.flags),
    'bookingReference', v_booking.reference,
    'bookingStatus', 'confirmed',
    'paymentStatus', 'paid'
  );
end;
$function$
;
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
   or ref is null or (nullif(btrim(a.submitted_reference),'') is not null and (char_length(regexp_replace(a.submitted_reference,'[^A-Za-z0-9]','','g'))<6
   or regexp_replace(upper(a.submitted_reference),'[^A-Z0-9]','','g')<>regexp_replace(upper(ref),'[^A-Z0-9]','','g')))
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
CREATE OR REPLACE FUNCTION public.reject_picklestreet_duplicate(p_attempt_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
 t constant uuid:='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';
 a public.picklestreet_receipt_attempts%rowtype;
 b public.bookings%rowtype;
 r public.receipt_verifications%rowtype;
 ref text; source text; route jsonb; item jsonb; refs jsonb:='[]'; claim record;
 duplicate_found boolean:=false; expected_kind text; evidence jsonb;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED' using errcode='42501';end if;
 select * into a from public.picklestreet_receipt_attempts where tenant_id=t and id=p_attempt_id;
 if not found then return jsonb_build_object('rejected',false);end if;
 select * into b from public.bookings where tenant_id=t and id=a.booking_id for update;
 if not found then return jsonb_build_object('rejected',false);end if;
 if b.metadata->>'duplicateReferenceRejected'='true' then
   return jsonb_build_object('rejected',true,'bookingReference',b.reference,'bookingId',b.id,'status','rejected','bookingStatus','cancelled','paymentStatus','rejected');
 end if;
 if b.status not in ('payment_review','pending_payment','expired') or b.payment_status<>'pending'
   or a.completed_at is null or a.outcome<>'pending' then return jsonb_build_object('rejected',false);end if;
 perform 1 from public.picklestreet_receipt_jobs where tenant_id=t and booking_id=b.id and current_attempt_id=a.id for update;
 if not found then return jsonb_build_object('rejected',false);end if;
 select * into r from public.receipt_verifications where tenant_id=t and booking_id=b.id and id=a.receipt_id for update;
 if not found or r.balance_request_id is not null or r.status not in ('pending','manual_review') then return jsonb_build_object('rejected',false);end if;

 -- A parsed value is not reliable when its dedicated parser explicitly says
 -- the reference/invoice is unreadable or ambiguous (notably Maya InstaPay).
 if (a.error_code is not null and a.error_code not in('duplicate_payment_route_reference','duplicate_payment_reference'))
   or exists(select 1 from unnest(coalesce(a.flags,'{}'::text[])) flag
     where (upper(flag) ~ '(REF|REFERENCE|INVOICE)' and upper(flag) ~ '(AMBIGUOUS|UNREADABLE|UNVERIFIED|MISMATCH|INVALID|MISSING|UNAVAILABLE)')
       or lower(flag) in('receipt_parser_unavailable','verification_unavailable','tenant_context_invalid','native_ocr_confidence_missing'))
 then return jsonb_build_object('rejected',false);end if;

 source:=public.picklestreet_source_provider(a.payment_method);
 ref:=regexp_replace(upper(coalesce(a.payment_reference,'')),'[^A-Z0-9]','','g');
 evidence:=a.extracted_data;
 route:=evidence#>'{detected,route}';
 -- An OCR error, source mismatch or unknown receiver is not proof of reuse.
 -- Amount/timing failures do not change the identity of a proven transaction.
 if source is null or source not in('gcash','bdopay','maya','bpi','gotyme','maribank')
   or length(ref) not between 6 and 64
   or (nullif(btrim(a.submitted_reference),'') is not null and ref is distinct from regexp_replace(upper(a.submitted_reference),'[^A-Z0-9]','','g'))
   or ref is distinct from regexp_replace(upper(coalesce(evidence#>>'{detected,paymentReference}','')),'[^A-Z0-9]','','g')
   or evidence->>'provider' is distinct from 'google_vision'
   or jsonb_typeof(evidence#>'{confidence,vision}') is distinct from 'number'
   or (case when jsonb_typeof(evidence#>'{confidence,vision}')='number' then (evidence#>>'{confidence,vision}')::numeric not between 0.9 and 1 else true end)
   or jsonb_typeof(route) is distinct from 'object'
   or route->>'schemaVersion' is distinct from '1'
   or route->>'sourceProvider' is distinct from source
   or route->>'routeId' is distinct from source||'_to_gcash'
   or route->>'destinationProvider' is distinct from 'gcash'
   or route->>'destinationMethodCode' is distinct from 'gcash'
   or route->>'parserVersion' is distinct from (case when source='gcash' then 'gcash_v1' else source||'_to_gcash_v1' end)
   or route->'sourceMatched' is distinct from 'true'::jsonb
   or route->'destinationMatched' is distinct from 'true'::jsonb
   or route->'recipientMatched' is distinct from 'true'::jsonb
   or route->'referenceMatched' is distinct from 'true'::jsonb
   or route->'successMatched' is distinct from 'true'::jsonb
 then return jsonb_build_object('rejected',false);end if;
 if not exists(select 1 from public.payment_sessions ps where ps.tenant_id=t and ps.booking_id=b.id and ps.id=r.payment_session_id
   and public.picklestreet_source_provider(ps.provider_payload->>'paymentMethod')=source
   and (nullif(btrim(ps.provider_payload->>'submittedReference'),'') is null or regexp_replace(upper(ps.provider_payload->>'submittedReference'),'[^A-Z0-9]','','g')=ref))
 then return jsonb_build_object('rejected',false);end if;
 if jsonb_typeof(route->'secondaryReferences') is distinct from 'array' then return jsonb_build_object('rejected',false);end if;
 if jsonb_array_length(route->'secondaryReferences')<>(case when source='gcash' then 0 else 1 end)
 then return jsonb_build_object('rejected',false);end if;
 expected_kind:=case source when 'bdopay' then 'bdopay_invoice' when 'bpi' then 'bpi_transaction'
   when 'maya' then 'maya_instapay' else 'instapay' end;
 for item in select value from jsonb_array_elements(route->'secondaryReferences') loop
   if jsonb_typeof(item) is distinct from 'object' or item->>'kind' is distinct from expected_kind
     or jsonb_typeof(item->'value') is distinct from 'string' or item->>'value' !~ '^[A-Z0-9]{3,64}$'
     or exists(select 1 from jsonb_object_keys(item) k where k not in('kind','value'))
   then return jsonb_build_object('rejected',false);end if;
   refs:=refs||jsonb_build_array(jsonb_build_object('namespace',case when expected_kind='maya_instapay' then 'instapay' else expected_kind end,'value',item->>'value'));
 end loop;
 refs:=refs||jsonb_build_array(jsonb_build_object('namespace',source||'.primary','value',ref));
 -- The same deterministic namespace/hash locks as accepted-reference claims.
 for claim in select distinct value->>'namespace' as namespace,encode(extensions.digest(value->>'value','sha256'),'hex') as hash
   from jsonb_array_elements(refs) order by 1,2 loop
   perform pg_advisory_xact_lock(hashtextextended('picklestreet-route-reference:'||claim.namespace||':'||claim.hash,0));
   if exists(select 1 from public.picklestreet_receipt_reference_claims c
     join public.receipt_verifications prior on prior.tenant_id=t and prior.id=c.verification_id and prior.booking_id=c.booking_id
     join public.payment_sessions ps on ps.tenant_id=t and ps.id=prior.payment_session_id and ps.booking_id=prior.booking_id
     where c.tenant_id=t and c.namespace=claim.namespace and c.reference_hash=claim.hash
       and c.booking_id<>b.id and prior.status in('approved','auto_approved') and ps.status='paid')
   then duplicate_found:=true;end if;
 end loop;
 if not duplicate_found then return jsonb_build_object('rejected',false);end if;

 perform set_config('app.picklestreet_duplicate_reject',r.id::text,true);
 update public.receipt_verifications set status='rejected',flags=array['duplicate_payment_reference'],reviewed_at=now(),
   extracted_data=extracted_data||jsonb_build_object('automaticRejection','duplicate_payment_reference') where tenant_id=t and id=r.id;
 update public.payment_sessions set status='failed' where tenant_id=t and id=r.payment_session_id and status<>'paid';
 update public.booking_slots set status='cancelled',hold_expires_at=null where tenant_id=t and booking_id=b.id and status in ('held','expired');
 update public.bookings set status='cancelled',payment_status='rejected',cancelled_at=now(),expires_at=null,
   metadata=metadata||jsonb_build_object('duplicateReferenceRejected',true,'paymentRejectionReason','This payment reference has already been used for another booking.') where tenant_id=t and id=b.id;
 update public.picklestreet_receipt_jobs set lease_token=null,lease_until=null where tenant_id=t and booking_id=b.id;
 insert into public.picklestreet_rejection_emails(tenant_id,booking_id,receipt_id) values(t,b.id,r.id) on conflict do nothing;
 return jsonb_build_object('rejected',true,'bookingReference',b.reference,'bookingId',b.id,'status','rejected','bookingStatus','cancelled','paymentStatus','rejected','flags',jsonb_build_array('duplicate_payment_reference'));
end;$function$
;
commit;
