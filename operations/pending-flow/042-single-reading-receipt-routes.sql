begin;
CREATE OR REPLACE FUNCTION public.picklestreet_receipt_route_ready(p_method text, p_data jsonb, p_snapshot jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET row_security TO 'off'
AS $function$
declare
  t constant uuid := 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';
  source text := public.picklestreet_source_provider(p_method);
  route jsonb := p_data #> '{detected,route}';
  secondary_count integer;
begin
  if source='gcash' and route->>'sourceProvider'='maribank' then
    if not public.picklestreet_receipt_route_config_current('maribank',jsonb_set(p_snapshot,'{method}','"maribank"'::jsonb)) then return false; end if;
    source:='maribank';
  end if;
  if p_data#>'{timing,withinWindow}' is distinct from 'true'::jsonb
    or p_data#>'{comparison,amountMatched}' is distinct from 'true'::jsonb
    or nullif(p_data#>>'{timing,receiptDateTime}','') is null then return false; end if;
  if source is null
    or source not in ('gcash','bdopay','maya','bpi','gotyme','maribank')
    or jsonb_typeof(route) is distinct from 'object'
    or route->>'schemaVersion' is distinct from '1'
    or route->>'sourceProvider' is distinct from source
    or route->>'routeId' is distinct from source || '_to_gcash'
    or route->>'destinationProvider' is distinct from 'gcash'
    or route->>'destinationMethodCode' is distinct from 'gcash'
    or (case when source = 'gotyme' then
      coalesce(route->>'parserVersion', '') not in ('gotyme_to_gcash_v1','gotyme_to_gcash_v2')
      else route->>'parserVersion' is distinct from (
        case when source = 'gcash' then 'gcash_v1' else source || '_to_gcash_v1' end
      ) end)
    or route->'sourceMatched' is distinct from 'true'::jsonb
    or route->'destinationMatched' is distinct from 'true'::jsonb
    or route->'recipientMatched' is distinct from 'true'::jsonb
    or route->'referenceMatched' is distinct from 'true'::jsonb
    or route->'successMatched' is distinct from 'true'::jsonb
    or jsonb_typeof(p_data #> '{confidence,vision}') is distinct from 'number'
    or jsonb_typeof(p_data #> '{confidence,effective}') is distinct from 'number'
    or coalesce((p_data #>> '{confidence,vision}')::numeric, 0) not between 0.9 and 1
    or coalesce((p_data #>> '{confidence,effective}')::numeric, 0)
      not between 0.9 and (p_data #>> '{confidence,vision}')::numeric
    or coalesce((p_data #>> '{timing,allowedWindowMinutes}')::numeric, 0) <> 15
    or coalesce((p_data #>> '{timing,earlyToleranceMinutes}')::numeric, 11)
      not between 0 and 2
  then
    return false;
  end if;

  if jsonb_typeof(route->'secondaryReferences') is distinct from 'array' then
    return false;
  end if;
  secondary_count := jsonb_array_length(route->'secondaryReferences');
  if (source = 'gcash' and secondary_count <> 0)
    or (source in ('maya','maribank') and secondary_count not between 0 and 1)
    or (source not in ('gcash','maya','maribank') and secondary_count <> 1)
  then
    return false;
  end if;
  if secondary_count = 1 and source <> 'gcash' and (
    route #>> '{secondaryReferences,0,kind}' is distinct from (
      case source
        when 'bdopay' then 'bdopay_invoice'
        when 'bpi' then 'bpi_transaction'
        when 'maya' then 'maya_instapay'
        else 'instapay'
      end
    )
    or coalesce(route #>> '{secondaryReferences,0,value}', '')
      !~ '^[A-Z0-9]{3,64}$'
  ) then
    return false;
  end if;

  if not public.picklestreet_receipt_route_config_current(p_method, p_snapshot)
  then
    return false;
  end if;
  return exists (
    select 1 from public.tenants
    where id = t
      and coalesce(public_config->>'bookingApprovalMode', '') <> 'manual'
  );
exception
  when invalid_text_representation or numeric_value_out_of_range then
    return false;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.guard_picklestreet_receipt_reference_claims()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET row_security TO 'off'
AS $function$
declare t constant uuid:='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';source text;session_ref text;route jsonb;refs jsonb:='[]';item jsonb;claim record;
 existing public.picklestreet_receipt_reference_claims%rowtype;keyvalue text;keyhash text;
begin
 if new.tenant_id<>t or new.status not in('approved','auto_approved') then return new;end if;
 if tg_op='UPDATE' and old.status in('approved','auto_approved') then return new;end if;
 select public.picklestreet_source_provider(provider_payload->>'paymentMethod'),provider_payload->>'submittedReference' into source,session_ref from public.payment_sessions
   where tenant_id=t and booking_id=new.booking_id and id=new.payment_session_id;
 if source is null or source not in('gcash','bdopay','maya','bpi','gotyme','maribank','pnb') then return new;end if;
 keyvalue:=regexp_replace(upper(coalesce(nullif(new.payment_reference,''),session_ref,'')),'[^A-Z0-9]','','g');
 route:=new.extracted_data#>'{detected,route}';
 if source='gcash' and route->>'sourceProvider'='maribank' and route->>'routeId'='maribank_to_gcash' then source:='maribank';end if;
 if route is not null then
   if jsonb_typeof(route) is distinct from 'object' or route->>'sourceProvider' is distinct from source
     or jsonb_typeof(route->'secondaryReferences') is distinct from 'array' or jsonb_array_length(route->'secondaryReferences')>8 then
     raise exception 'RECEIPT_ROUTE_REFERENCES_INVALID' using errcode='22023';end if;
   for item in select value from jsonb_array_elements(route->'secondaryReferences') loop
     if jsonb_typeof(item) is distinct from 'object' or not(item ?& array['kind','value']) or item->>'kind' not in('instapay','maya_instapay','bdopay_invoice','bpi_transaction')
       or jsonb_typeof(item->'value') is distinct from 'string' or item->>'value' !~ '^[A-Z0-9]{3,64}$'
       or exists(select 1 from jsonb_object_keys(item) k where k not in('kind','value')) then
       raise exception 'RECEIPT_ROUTE_REFERENCES_INVALID' using errcode='22023';end if;
     -- GoTyme Trace IDs are scoped to their full transaction reference.
     -- Missing/cropped references remain manual review; do not claim OCR amounts.
     if source='gotyme' and route->>'parserVersion'='gotyme_to_gcash_v2' and item->>'kind'='instapay' then
       if keyvalue ~ '^(ITO[0-9]{12,20}|GTY[A-Z0-9]{12,24})$' and item->>'value' ~ '^[0-9]{4,12}$' then
         refs:=refs||jsonb_build_array(jsonb_build_object('namespace','instapay','value','gotyme:'||keyvalue||':'||(item->>'value')));
       end if;
     else
     refs:=refs||jsonb_build_array(jsonb_build_object('namespace',case when item->>'kind'='maya_instapay' then 'instapay' else item->>'kind' end,'value',item->>'value'));
     end if;
   end loop;
 end if;

 if char_length(keyvalue)>=6 then refs:=refs||jsonb_build_array(jsonb_build_object('namespace',source||'.primary','value',keyvalue));end if;
 -- Sorted namespaces/hashes acquire one deterministic lock order across providers.
 for claim in select distinct value->>'namespace' as namespace,encode(extensions.digest(value->>'value','sha256'),'hex') as hash
   from jsonb_array_elements(refs) order by 1,2 loop
   perform pg_advisory_xact_lock(hashtextextended('picklestreet-route-reference:'||claim.namespace||':'||claim.hash,0));
   select * into existing from public.picklestreet_receipt_reference_claims where tenant_id=t and namespace=claim.namespace and reference_hash=claim.hash;
   if found and existing.verification_id<>new.id then raise exception 'duplicate_payment_route_reference' using errcode='23505';end if;
   insert into public.picklestreet_receipt_reference_claims(tenant_id,namespace,reference_hash,verification_id,booking_id,balance_request_id)
     values(t,claim.namespace,claim.hash,new.id,new.booking_id,new.balance_request_id) on conflict do nothing;
 end loop;
 return new;
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
     or coalesce((v_verification.extracted_data #>> '{timing,withinWindow}')::boolean,false) is not true
     or nullif(v_verification.extracted_data #>> '{timing,receiptDateTime}','') is null
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
    or (v_verification.extracted_data#>>'{detected,route,sourceProvider}' is distinct from public.picklestreet_source_provider(v_payment_method)
      and not (public.picklestreet_source_provider(v_payment_method)='gcash'
        and v_verification.extracted_data#>>'{detected,route,sourceProvider}'='maribank'
        and v_verification.extracted_data#>>'{detected,route,routeId}'='maribank_to_gcash'))
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
  if char_length(v_detected_reference) < 6
     or (nullif(v_submitted_reference,'') is not null and
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
commit;
