-- Enable Maya as a sending app to the venue's existing GCash receiver.
-- The receipt verifier still requires independently visible completed evidence;
-- a manually entered Reference ID is only an OCR cross-check.

begin;

-- Keep the protected database gate aligned with the dedicated Maya parser.
-- Maya is the source app; the venue's configured GCash account is the
-- destination. A native Maya receipt may legitimately have no separate
-- InstaPay reference, so the typed Maya Reference ID remains mandatory.
create or replace function public.picklestreet_receipt_route_ready(
  p_method text,
  p_data jsonb,
  p_snapshot jsonb
)
returns boolean
language plpgsql
security definer
set search_path to ''
set row_security to 'off'
as $function$
declare
  t constant uuid := 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';
  source text := public.picklestreet_source_provider(p_method);
  route jsonb := p_data #> '{detected,route}';
  secondary_count integer;
begin
  if source is null
    or source not in ('gcash','bdopay','maya','bpi','gotyme','maribank')
    or jsonb_typeof(route) is distinct from 'object'
    or route->>'schemaVersion' is distinct from '1'
    or route->>'sourceProvider' is distinct from source
    or route->>'routeId' is distinct from source || '_to_gcash'
    or route->>'destinationProvider' is distinct from 'gcash'
    or route->>'destinationMethodCode' is distinct from 'gcash'
    or route->>'parserVersion' is distinct from (
      case when source = 'gcash' then 'gcash_v1'
      else source || '_to_gcash_v1' end
    )
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
    or (source = 'maya' and secondary_count not between 0 and 1)
    or (source not in ('gcash','maya') and secondary_count <> 1)
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
  if source in ('bdopay','bpi') and not exists (
    select 1
    from public.picklestreet_receipt_route_settings
    where tenant_id = t
      and char_length(btrim(gcash_qr_alias)) >= 2
      and regexp_replace(upper(gcash_qr_token), '[^A-Z0-9]', '', 'g')
        ~ '^[A-Z0-9]{10,40}$'
      and gcash_qr_token ~* '[a-z]'
      and gcash_qr_token ~ '[0-9]'
  ) then
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
$function$;

create or replace function public.picklestreet_receipt_route_config_current(
  p_method text,
  p_snapshot jsonb
)
returns boolean
language plpgsql
security definer
set search_path to ''
set row_security to 'off'
as $function$
declare
  t constant uuid := 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';
  dest public.tenant_payment_methods%rowtype;
  settings public.picklestreet_receipt_route_settings%rowtype;
begin
  perform 1 from public.tenants
  where id = t and slug = 'pickle-street-tugbok' and status = 'active'
  for share;
  if not found then return false; end if;

  select * into dest
  from public.tenant_payment_methods
  where tenant_id = t
    and method_code = 'gcash'
    and char_length(btrim(coalesce(account_name, ''))) >= 2
    and char_length(btrim(coalesce(account_reference, ''))) >= 3
  for share;
  if not found then return false; end if;

  perform 1 from public.tenant_payment_methods
  where tenant_id = t
    and method_code = lower(p_method)
    and is_active
    and account_name = dest.account_name
    and account_reference = dest.account_reference
  for share;
  if not found then return false; end if;

  select * into settings
  from public.picklestreet_receipt_route_settings
  where tenant_id = t
  for share;
  return p_snapshot = jsonb_build_object(
    'method', p_method,
    'name', dest.account_name,
    'account', dest.account_reference,
    'destinationMethod', 'gcash',
    'verificationSettingsRevision', coalesce(settings.revision, 0)
  );
end;
$function$;

-- These two functions contain booking/duplicate state transitions that are
-- intentionally unchanged. Replace only their old Maya-to-Maya route clauses
-- and fail the migration if the expected protected definitions are absent.
do $migration$
declare
  definition text;
  original text;
begin
  select pg_get_functiondef(
    'public.auto_approve_picklestreet_receipt_route(uuid)'::regprocedure
  ) into definition;
  original := definition;
  definition := replace(
    definition,
    $old$or v_verification.extracted_data#>>'{detected,route,destinationProvider}' is distinct from (case when v_payment_method='maya' then 'maya' else 'gcash' end)$old$,
    $new$or v_verification.extracted_data#>>'{detected,route,destinationProvider}' is distinct from 'gcash'$new$
  );
  definition := replace(
    definition,
    $old$if char_length(v_detected_reference) < 6 or (nullif(v_submitted_reference,'') is not null and$old$,
    $new$if char_length(v_detected_reference) < 6
     or (v_payment_method='maya' and nullif(v_submitted_reference,'') is null)
     or (nullif(v_submitted_reference,'') is not null and$new$
  );
  if definition = original
    or position($old$then 'maya' else 'gcash'$old$ in definition) > 0
    or position($new$v_payment_method='maya' and nullif(v_submitted_reference,'') is null$new$ in definition) = 0
  then
    raise exception 'Unexpected auto-approval function definition';
  end if;
  execute definition;

  select pg_get_functiondef(
    'public.reject_picklestreet_duplicate(uuid)'::regprocedure
  ) into definition;
  original := definition;
  definition := replace(definition,
    $old$(case when source='maya' then 'maya_configured_receiver' else source||'_to_gcash' end)$old$,
    $new$(source||'_to_gcash')$new$);
  definition := replace(definition,
    $old$(case when source='maya' then 'maya' else 'gcash' end)$old$,
    $new$'gcash'$new$);
  definition := replace(definition,
    $old$(case when source='maya' then 'maya_configured_receiver_v1' when source='gcash' then 'gcash_v1' else source||'_to_gcash_v1' end)$old$,
    $new$(case when source='gcash' then 'gcash_v1' else source||'_to_gcash_v1' end)$new$);
  definition := replace(definition,
    $old$or length(ref) not between 6 and 64$old$,
    $new$or length(ref) not between 6 and 64
   or (source='maya' and nullif(btrim(a.submitted_reference),'') is null)$new$);
  definition := replace(definition,
    $old$if jsonb_array_length(route->'secondaryReferences')<>(case when source='gcash' then 0 else 1 end)
 then return jsonb_build_object('rejected',false);end if;$old$,
    $new$if (source='gcash' and jsonb_array_length(route->'secondaryReferences')<>0)
   or (source='maya' and jsonb_array_length(route->'secondaryReferences') not between 0 and 1)
   or (source not in('gcash','maya') and jsonb_array_length(route->'secondaryReferences')<>1)
 then return jsonb_build_object('rejected',false);end if;$new$);
  if definition = original
    or position('maya_configured_receiver' in definition) > 0
    or position($new$source='maya' and nullif(btrim(a.submitted_reference),'') is null$new$ in definition) = 0
  then
    raise exception 'Unexpected duplicate-rejection function definition';
  end if;
  execute definition;
end;
$migration$;

insert into public.tenant_payment_methods (
  tenant_id,
  method_code,
  display_name,
  account_name,
  account_reference,
  instructions,
  is_active,
  sort_order
)
select
  gcash.tenant_id,
  'maya',
  'Maya → GCash',
  gcash.account_name,
  gcash.account_reference,
  'In Maya, use Bank Transfer to GCash. Wait for Completed, enter the Reference ID, and upload the full transaction details screen.',
  true,
  3
from public.tenant_payment_methods gcash
where gcash.tenant_id = 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'
  and gcash.method_code = 'gcash'
  and gcash.is_active
  and char_length(btrim(coalesce(gcash.account_name, ''))) >= 2
  and char_length(btrim(coalesce(gcash.account_reference, ''))) >= 3
on conflict (tenant_id, method_code) do update
set display_name = excluded.display_name,
    account_name = excluded.account_name,
    account_reference = excluded.account_reference,
    instructions = excluded.instructions,
    is_active = true,
    sort_order = excluded.sort_order,
    updated_at = clock_timestamp();

update public.tenants
set updated_at = clock_timestamp()
where id = 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';

commit;
