-- Pickle Street only. New methods remain disabled until an owner saves settings.
begin;
create table public.picklestreet_receipt_route_settings(
 tenant_id uuid primary key default 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'
 check(tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid)
 references public.tenants(id),
 gcash_qr_alias text not null default '' check(char_length(gcash_qr_alias)<=120),
 gcash_qr_token text not null default '' check(char_length(gcash_qr_token)<=512),
 revision bigint not null default 0 check(revision>=0),
 updated_at timestamptz not null default clock_timestamp(),updated_by uuid references auth.users(id)
);
alter table public.picklestreet_receipt_route_settings enable row level security;
revoke all on public.picklestreet_receipt_route_settings from public,anon,authenticated,service_role;
grant select on public.picklestreet_receipt_route_settings to service_role;

create function public.get_picklestreet_payment_settings(p_tenant_slug text,p_hostname text)
returns jsonb language plpgsql security definer set search_path='' set row_security=off as $$
declare t constant uuid:='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';s public.picklestreet_receipt_route_settings%rowtype;d jsonb;
begin
 if auth.uid() is null or public.resolve_tenant_id(p_tenant_slug,p_hostname) is distinct from t
   or not(public.is_platform_owner() or public.has_tenant_role(t,array['owner','admin'])) then
   raise exception 'TENANT_ACCESS_DENIED' using errcode='42501';end if;
 d:=public.get_tenant_activation_settings(p_tenant_slug,p_hostname);
 select * into s from public.picklestreet_receipt_route_settings where tenant_id=t;
 return d||jsonb_build_object('receiptVerification',jsonb_build_object('gcashQrAlias',coalesce(s.gcash_qr_alias,''),
   'gcashQrToken',coalesce(s.gcash_qr_token,'')),'receiptVerificationRevision',coalesce(s.revision,0));
end;$$;
revoke execute on function public.get_picklestreet_payment_settings(text,text) from public,anon;
grant execute on function public.get_picklestreet_payment_settings(text,text) to authenticated;

create function public.save_picklestreet_payment_settings(p_tenant_slug text,p_hostname text,p_expected_revision timestamptz,p_patch jsonb)
returns jsonb language plpgsql security definer set search_path='' set row_security=off as $$
declare t constant uuid:='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';current_revision timestamptz;
 s public.picklestreet_receipt_route_settings%rowtype;v jsonb;downstream jsonb;method jsonb;gcash jsonb;
begin
 if auth.uid() is null or public.resolve_tenant_id(p_tenant_slug,p_hostname) is distinct from t
   or not(public.is_platform_owner() or public.has_tenant_role(t,array['owner','admin'])) then
   raise exception 'TENANT_ACCESS_DENIED' using errcode='42501';end if;
 if p_patch is null or jsonb_typeof(p_patch)<>'object' or p_patch='{}'::jsonb or exists(
   select 1 from jsonb_object_keys(p_patch) k where k not in('venue','paymentMethods','receiptVerification','receiptVerificationRevision')) then
   raise exception 'PAYMENT_SETTINGS_INVALID' using errcode='22023';end if;
 select updated_at into current_revision from public.tenants where id=t for update;
 if p_expected_revision is null or current_revision is distinct from p_expected_revision then
   raise exception 'BUSINESS_SETTINGS_STALE' using errcode='40001';end if;
 select * into s from public.picklestreet_receipt_route_settings where tenant_id=t for update;
 if p_patch ? 'receiptVerification' then
   v:=p_patch->'receiptVerification';
   if jsonb_typeof(v) is distinct from 'object' or not(v ?& array['gcashQrAlias','gcashQrToken'])
     or exists(select 1 from jsonb_object_keys(v) k where k not in('gcashQrAlias','gcashQrToken'))
     or jsonb_typeof(v->'gcashQrAlias') is distinct from 'string' or jsonb_typeof(v->'gcashQrToken') is distinct from 'string'
     or char_length(btrim(v->>'gcashQrAlias'))>120 or char_length(btrim(v->>'gcashQrToken'))>512
     or (v->>'gcashQrAlias') ~ '[[:cntrl:]]' or (v->>'gcashQrToken') ~ '[[:cntrl:]]'
     or jsonb_typeof(p_patch->'receiptVerificationRevision') is distinct from 'number'
     or (p_patch->>'receiptVerificationRevision')::numeric<>trunc((p_patch->>'receiptVerificationRevision')::numeric) then
     raise exception 'RECEIPT_SETTINGS_INVALID' using errcode='22023';end if;
   if (p_patch->>'receiptVerificationRevision')::numeric<>coalesce(s.revision,0) then
     raise exception 'RECEIPT_SETTINGS_STALE' using errcode='40001';end if;
 elsif p_patch ? 'receiptVerificationRevision' then raise exception 'RECEIPT_SETTINGS_INVALID' using errcode='22023';end if;
 if p_patch ? 'paymentMethods' then
   if jsonb_typeof(p_patch->'paymentMethods') is distinct from 'array' then raise exception 'PAYMENT_SETTINGS_INVALID' using errcode='22023';end if;
   select value into gcash from jsonb_array_elements(p_patch->'paymentMethods') where value->>'methodCode'='gcash';
   for method in select value from jsonb_array_elements(p_patch->'paymentMethods') loop
     if method->>'methodCode' not in('gcash','bdo_pay','bdo','bdopay','maya','bpi','gotyme','maribank','pnb','cash') then
       raise exception 'PAYMENT_METHOD_UNSUPPORTED' using errcode='22023';end if;
     if method->>'methodCode'='cash' and coalesce((method->>'isActive')::boolean,false) then
       raise exception 'CASH_PUBLIC_CHECKOUT_UNAVAILABLE' using errcode='22023';end if;
     if method->>'methodCode' in('bdo_pay','bdo','bdopay','maya','bpi','gotyme','maribank') then
       if gcash is null or btrim(method->>'accountName') is distinct from btrim(gcash->>'accountName')
         or btrim(method->>'accountNumber') is distinct from btrim(gcash->>'accountNumber')
         or nullif(btrim(method->>'qrUrl'),'') is distinct from nullif(btrim(gcash->>'qrUrl'),'') then
         raise exception 'GCASH_DESTINATION_MISMATCH' using errcode='22023';end if;
     end if;
   end loop;
 end if;
 downstream:=p_patch-'receiptVerification'-'receiptVerificationRevision';
 if downstream<>'{}'::jsonb then
   perform public.update_tenant_business_settings_if_current(p_tenant_slug,p_hostname,p_expected_revision,downstream);
 else
   update public.tenants set updated_at=clock_timestamp() where id=t;
 end if;
 if v is not null then
   insert into public.picklestreet_receipt_route_settings(tenant_id,gcash_qr_alias,gcash_qr_token,revision,updated_by)
   values(t,btrim(v->>'gcashQrAlias'),btrim(v->>'gcashQrToken'),1,auth.uid())
   on conflict(tenant_id) do update set gcash_qr_alias=excluded.gcash_qr_alias,gcash_qr_token=excluded.gcash_qr_token,
     revision=picklestreet_receipt_route_settings.revision+1,updated_at=clock_timestamp(),updated_by=auth.uid();
 end if;
 return public.get_picklestreet_payment_settings(p_tenant_slug,p_hostname);
end;$$;
revoke execute on function public.save_picklestreet_payment_settings(text,text,timestamptz,jsonb) from public,anon;
grant execute on function public.save_picklestreet_payment_settings(text,text,timestamptz,jsonb) to authenticated;

create function public.picklestreet_source_provider(p_method text) returns text language sql immutable set search_path='' as $$
 select case lower(p_method) when 'bdo' then 'bdopay' when 'bdo_pay' then 'bdopay' else lower(p_method) end;
$$;
revoke execute on function public.picklestreet_source_provider(text) from public,anon,authenticated,service_role;

create function public.picklestreet_receipt_route_config_current(p_method text,p_snapshot jsonb)
returns boolean language plpgsql security definer set search_path='' set row_security=off as $$
declare t constant uuid:='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';dest public.tenant_payment_methods%rowtype;s public.picklestreet_receipt_route_settings%rowtype;
begin
 -- Settings writers lock tenant first; take the same order and protect a missing
 -- private settings row from a concurrent first save.
 perform 1 from public.tenants where id=t and slug='pickle-street-tugbok' and status='active'
   for share;
 if not found then return false;end if;
 select * into dest from public.tenant_payment_methods where tenant_id=t and method_code='gcash'
   and char_length(btrim(coalesce(account_name,'')))>=2 and char_length(btrim(coalesce(account_reference,'')))>=3 for share;
 if not found then return false;end if;
 perform 1 from public.tenant_payment_methods where tenant_id=t and method_code=p_method and is_active
   and account_name=dest.account_name and account_reference=dest.account_reference for share;
 if not found then return false;end if;
 select * into s from public.picklestreet_receipt_route_settings where tenant_id=t for share;
 if p_snapshot is distinct from jsonb_build_object('method',p_method,'name',dest.account_name,'account',dest.account_reference,
   'destinationMethod','gcash','verificationSettingsRevision',coalesce(s.revision,0)) then return false;end if;
 return true;
end;$$;
revoke execute on function public.picklestreet_receipt_route_config_current(text,jsonb) from public,anon,authenticated,service_role;

create function public.picklestreet_receipt_route_ready(p_method text,p_data jsonb,p_snapshot jsonb)
returns boolean language plpgsql security definer set search_path='' set row_security=off as $$
declare t constant uuid:='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';source text:=public.picklestreet_source_provider(p_method);
 route jsonb:=p_data#>'{detected,route}';
begin
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
   or coalesce((p_data#>>'{timing,allowedWindowMinutes}')::numeric,0)<>15
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
end;$$;
revoke execute on function public.picklestreet_receipt_route_ready(text,jsonb,jsonb) from public,anon,authenticated,service_role;

create table public.picklestreet_receipt_reference_claims(
 tenant_id uuid not null default 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'
 check(tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid),
 namespace text not null check(namespace in('gcash.primary','bdopay.primary','maya.primary','bpi.primary','gotyme.primary','maribank.primary','pnb.primary','instapay','bdopay_invoice','bpi_transaction')),
 reference_hash text not null check(reference_hash ~ '^[a-f0-9]{64}$'),
 verification_id uuid not null,booking_id uuid not null,balance_request_id uuid,
 created_at timestamptz not null default clock_timestamp(),
 primary key(tenant_id,namespace,reference_hash),
 foreign key(tenant_id,verification_id) references public.receipt_verifications(tenant_id,id),
 foreign key(tenant_id,booking_id) references public.bookings(tenant_id,id),
 foreign key(tenant_id,balance_request_id) references public.booking_balance_requests(tenant_id,id)
);
alter table public.picklestreet_receipt_reference_claims enable row level security;
revoke all on public.picklestreet_receipt_reference_claims from public,anon,authenticated,service_role;
grant select on public.picklestreet_receipt_reference_claims to service_role;

-- Preserve ownership of references from payments already accepted before this
-- additive ledger existed. Hash only; no receipt or payment record is rewritten.
insert into public.picklestreet_receipt_reference_claims(tenant_id,namespace,reference_hash,verification_id,booking_id,balance_request_id)
select distinct on(source,normalized) tenant_id,source||'.primary',encode(extensions.digest(normalized,'sha256'),'hex'),id,booking_id,balance_request_id
from(select r.tenant_id,r.id,r.booking_id,r.balance_request_id,r.created_at,
 public.picklestreet_source_provider(p.provider_payload->>'paymentMethod') as source,
 regexp_replace(upper(coalesce(nullif(r.payment_reference,''),p.provider_payload->>'submittedReference','')),'[^A-Z0-9]','','g') as normalized
 from public.receipt_verifications r join public.payment_sessions p on p.tenant_id=r.tenant_id and p.id=r.payment_session_id
 where r.tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a' and r.status in('approved','auto_approved') and p.status='paid') accepted
where source in('gcash','bdopay','maya','bpi','gotyme','maribank','pnb') and char_length(normalized) between 6 and 64
order by source,normalized,created_at,id;

create function public.guard_picklestreet_receipt_reference_claims() returns trigger
language plpgsql security definer set search_path='' set row_security=off as $$
declare t constant uuid:='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';source text;session_ref text;route jsonb;refs jsonb:='[]';item jsonb;claim record;
 existing public.picklestreet_receipt_reference_claims%rowtype;keyvalue text;keyhash text;
begin
 if new.tenant_id<>t or new.status not in('approved','auto_approved') then return new;end if;
 if tg_op='UPDATE' and old.status in('approved','auto_approved') then return new;end if;
 select public.picklestreet_source_provider(provider_payload->>'paymentMethod'),provider_payload->>'submittedReference' into source,session_ref from public.payment_sessions
   where tenant_id=t and booking_id=new.booking_id and id=new.payment_session_id;
 if source is null or source not in('gcash','bdopay','maya','bpi','gotyme','maribank','pnb') then return new;end if;
 route:=new.extracted_data#>'{detected,route}';
 if route is not null then
   if jsonb_typeof(route) is distinct from 'object' or route->>'sourceProvider' is distinct from source
     or jsonb_typeof(route->'secondaryReferences') is distinct from 'array' or jsonb_array_length(route->'secondaryReferences')>8 then
     raise exception 'RECEIPT_ROUTE_REFERENCES_INVALID' using errcode='22023';end if;
   for item in select value from jsonb_array_elements(route->'secondaryReferences') loop
     if jsonb_typeof(item) is distinct from 'object' or not(item ?& array['kind','value']) or item->>'kind' not in('instapay','maya_instapay','bdopay_invoice','bpi_transaction')
       or jsonb_typeof(item->'value') is distinct from 'string' or item->>'value' !~ '^[A-Z0-9]{3,64}$'
       or exists(select 1 from jsonb_object_keys(item) k where k not in('kind','value')) then
       raise exception 'RECEIPT_ROUTE_REFERENCES_INVALID' using errcode='22023';end if;
     refs:=refs||jsonb_build_array(jsonb_build_object('namespace',case when item->>'kind'='maya_instapay' then 'instapay' else item->>'kind' end,'value',item->>'value'));
   end loop;
 end if;
 keyvalue:=regexp_replace(upper(coalesce(nullif(new.payment_reference,''),session_ref,'')),'[^A-Z0-9]','','g');
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
end;$$;
create trigger receipt_verifications_picklestreet_route_references after insert or update of status on public.receipt_verifications
for each row execute function public.guard_picklestreet_receipt_reference_claims();
revoke execute on function public.guard_picklestreet_receipt_reference_claims() from public,anon,authenticated,service_role;

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
  if not found
     or nullif(btrim(v_payment.provider_payload ->> 'submittedReference'), '')
       is null then
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
  if char_length(v_submitted_reference) < 6
     or v_detected_reference <> v_submitted_reference then
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
$function$;

revoke execute on function public.auto_approve_picklestreet_receipt_route(uuid) from public,anon,authenticated;
grant execute on function public.auto_approve_picklestreet_receipt_route(uuid) to service_role;

CREATE OR REPLACE FUNCTION public.finish_picklestreet_receipt_attempt(p_attempt_id uuid, p_lease_token uuid, p_extracted_data jsonb DEFAULT NULL::jsonb, p_flags text[] DEFAULT '{}'::text[], p_payment_reference text DEFAULT NULL::text, p_confidence numeric DEFAULT NULL::numeric, p_auto_approve boolean DEFAULT false, p_error_code text DEFAULT NULL::text, p_receiver_snapshot jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET row_security TO 'off'
AS $function$
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
  if v_candidate and v_data#>'{detected,route}' is not null then
    if not public.picklestreet_receipt_route_ready(v_attempt.payment_method,v_data,p_receiver_snapshot) then
      v_candidate:=false;v_flags:=array['payment_route_unverified'];
    end if;
  else
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
      if v_data#>'{detected,route}' is not null then
        v_result:=public.auto_approve_picklestreet_receipt_route(v_receipt.id);
      else
        v_result:=public.auto_approve_receipt_verification(v_receipt.id);
      end if;
      if v_result->>'status' is distinct from 'auto_approved' then
        raise exception 'automatic_approval_unavailable' using errcode='P0001';
      end if;
    exception when others then
      v_reheld:=false;
      v_reason:=case
        when sqlerrm in ('booking_started','reservation_slots_missing','reservation_court_unavailable',
          'reservation_court_blocked','reservation_time_unavailable') then sqlerrm
        when sqlerrm='duplicate_payment_route_reference' then 'duplicate_payment_route_reference'
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
$function$;
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
end;$function$;
commit;
