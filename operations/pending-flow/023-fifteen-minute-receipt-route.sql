-- Keep the protected receipt-route gate aligned with the 15-minute checkout.
-- Migration 020 extended booking holds and the receipt verifier already emits
-- allowedWindowMinutes=15, but the live route gate still required the old 10.

begin;

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
begin
  if source is null
    or source not in ('gcash','bdopay','maya','bpi','gotyme','maribank')
    or jsonb_typeof(route) is distinct from 'object'
    or route->>'schemaVersion' is distinct from '1'
    or route->>'sourceProvider' is distinct from source
    or route->>'routeId' is distinct from (
      case when source = 'maya' then 'maya_configured_receiver'
      else source || '_to_gcash' end
    )
    or route->>'destinationProvider' is distinct from (
      case when source = 'maya' then 'maya' else 'gcash' end
    )
    or route->>'destinationMethodCode' is distinct from (
      case when source = 'maya' then 'maya' else 'gcash' end
    )
    or route->>'parserVersion' is distinct from (
      case
        when source = 'maya' then 'maya_configured_receiver_v1'
        when source = 'gcash' then 'gcash_v1'
        else source || '_to_gcash_v1'
      end
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
  if jsonb_array_length(route->'secondaryReferences') <>
    (case when source = 'gcash' then 0 else 1 end)
  then
    return false;
  end if;
  if source <> 'gcash' and (
    route #>> '{secondaryReferences,0,kind}' is distinct from (
      case source
        when 'bdopay' then 'bdopay_invoice'
        when 'bpi' then 'bpi_transaction'
        when 'maya' then 'maya_instapay'
        else 'instapay'
      end
    )
    or coalesce(route #>> '{secondaryReferences,0,value}', '') !~ '^[A-Z0-9]{3,64}$'
  ) then
    return false;
  end if;

  if not public.picklestreet_receipt_route_config_current(
    p_method,
    p_snapshot
  ) then
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
    select 1
    from public.tenants
    where id = t
      and coalesce(public_config->>'bookingApprovalMode', '') <> 'manual'
  );
exception
  when invalid_text_representation or numeric_value_out_of_range then
    return false;
end;
$function$;

commit;
