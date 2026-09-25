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
  maya_reference_policy boolean := coalesce((
    source = 'maya'
    and route->>'sourceProvider' = 'maya'
    and route->>'destinationProvider' = 'gcash'
    and route->'mayaReferenceOnlyPolicy' = 'true'::jsonb
    and route->>'mayaStatus' in ('completed','processing')
    and coalesce((p_data #>> '{timing,withinWindow}')::boolean, false) is false
    and nullif(p_data #>> '{timing,receiptDate}', '') is null
    and nullif(p_data #>> '{timing,receiptTime}', '') is null
    and nullif(p_data #>> '{timing,receiptDateTime}', '') is null
  ), false);
begin
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
    or (
      route->'successMatched' is distinct from 'true'::jsonb
      and not (maya_reference_policy and route->>'mayaStatus' = 'processing')
    )
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
  if source = 'bpi' and not exists (
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
$function$
;
commit;
