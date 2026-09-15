-- Keep public booking ready when a canonical midnight-to-midnight schedule
-- uses multiple complete, adjacent pricing bands.
begin;
set local lock_timeout = '8s';
set local statement_timeout = '30s';

do $migration$
declare
  function_oid oid;
  definition text;
  original_block constant text := E'  if v_band_count = 1\n     and v_start_keys[1] = ''00:00''\n     and v_end_value_minutes[1] = 1440 then\n    return true;\n  end if;';
  replacement_block constant text := E'  if v_band_count = 1\n     and v_start_keys[1] = ''00:00''\n     and v_end_value_minutes[1] = 1440 then\n    return true;\n  end if;\n\n  -- A multi-tier full day forms a deliberate midnight cycle. Validate its\n  -- canonical stored order as one exact 1,440-minute chain.\n  if v_start_keys[1] = ''00:00''\n     and v_end_value_minutes[v_band_count] = 1440 then\n    v_expected_start := 0;\n    for v_loop_index in 1..v_band_count loop\n      if v_start_clock_minutes[v_loop_index] <> v_expected_start\n         or v_end_value_minutes[v_loop_index] <= v_expected_start\n         or v_end_value_minutes[v_loop_index] > 1440 then\n        return false;\n      end if;\n      v_expected_start := v_end_value_minutes[v_loop_index];\n    end loop;\n    return v_expected_start = 1440;\n  end if;';
begin
  select procedure.oid
  into function_oid
  from pg_catalog.pg_proc procedure
  join pg_catalog.pg_namespace namespace
    on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public'
    and procedure.proname = 'has_valid_regular_rate_bands'
    and pg_catalog.pg_get_function_identity_arguments(procedure.oid) = 'p_pricing_config jsonb';

  if function_oid is null then
    raise exception 'Required pricing readiness function was not found.';
  end if;

  definition := pg_catalog.pg_get_functiondef(function_oid);
  if pg_catalog.strpos(definition, replacement_block) > 0 then
    return;
  end if;
  if pg_catalog.strpos(definition, original_block) = 0 then
    raise exception 'Pricing readiness function changed; migration stopped safely.';
  end if;

  execute pg_catalog.replace(definition, original_block, replacement_block);
end;
$migration$;

do $verification$
declare
  tenant_uuid uuid;
begin
  select id into tenant_uuid
  from public.tenants
  where slug = 'pickle-street-tugbok' and status = 'active';

  if tenant_uuid is null then
    raise exception 'Pickle Street Tugbok tenant was not found.';
  end if;

  if exists (
    select 1
    from public.courts
    where tenant_id = tenant_uuid
      and status = 'active'
      and not public.has_valid_regular_rate_bands(pricing_config)
  ) then
    raise exception 'An active Pickle Street court still has invalid pricing bands.';
  end if;
end;
$verification$;

commit;
