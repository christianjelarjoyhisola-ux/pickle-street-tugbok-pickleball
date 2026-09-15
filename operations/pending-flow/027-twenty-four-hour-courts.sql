-- Enable a true 24-hour Pickle Street schedule and extend the existing
-- early off-peak band from 5:00 AM back to midnight without changing rates.
begin;
set local lock_timeout = '8s';
set local statement_timeout = '45s';

do $migration$
declare
  function_name text;
  function_oid oid;
  definition text;
  original_block constant text := E'if v_close_minutes = v_open_minutes then\n    raise exception ''SHARED_COURT_SCHEDULE_INVALID''\n      using errcode = ''22023'';\n  end if;\n  if v_close_minutes < v_open_minutes then\n    v_close_minutes := v_close_minutes + 1440;\n  end if;';
  replacement_block constant text := E'if v_close_minutes = v_open_minutes\n     and not (v_open_minutes = 0 and v_close_minutes = 0) then\n    raise exception ''SHARED_COURT_SCHEDULE_INVALID''\n      using errcode = ''22023'';\n  end if;\n  if v_close_minutes <= v_open_minutes then\n    v_close_minutes := v_close_minutes + 1440;\n  end if;';
begin
  foreach function_name in array array[
    'picklestreet_normalize_court_promo_bands',
    'apply_shared_picklestreet_court_schedule'
  ] loop
    select procedure.oid
    into function_oid
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace
      on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname = function_name
      and pg_catalog.pg_get_function_identity_arguments(procedure.oid) =
        case function_name
          when 'picklestreet_normalize_court_promo_bands' then 'p_opens_at text, p_closes_at text, p_bands jsonb'
          else 'p_tenant_slug text, p_hostname text, p_opens_at text, p_closes_at text, p_bands jsonb, p_expected_revisions jsonb'
        end;

    if function_oid is null then
      raise exception 'Required schedule function % was not found.', function_name;
    end if;
    definition := pg_catalog.pg_get_functiondef(function_oid);
    if pg_catalog.strpos(definition, replacement_block) > 0 then
      continue;
    end if;
    if pg_catalog.strpos(definition, original_block) = 0 then
      raise exception 'Schedule function % has changed; migration stopped safely.', function_name;
    end if;
    definition := pg_catalog.replace(definition, original_block, replacement_block);
    execute definition;
  end loop;
end;
$migration$;

do $schedule$
declare
  tenant_uuid uuid;
  court_count integer;
  updated_count integer;
begin
  select tenant.id
  into tenant_uuid
  from public.tenants tenant
  where tenant.slug = 'pickle-street-tugbok'
    and tenant.status = 'active'
  for update;

  if tenant_uuid is null then
    raise exception 'Pickle Street Tugbok tenant was not found.';
  end if;

  select count(*)
  into court_count
  from public.courts court
  where court.tenant_id = tenant_uuid;

  if court_count = 0 then
    raise exception 'No Pickle Street Tugbok courts were found.';
  end if;

  if exists (
    select 1
    from public.courts court
    where court.tenant_id = tenant_uuid
      and (
        court.opens_at <> time '05:00'
        or court.closes_at <> time '00:00'
        or court.pricing_config #>> '{regular,bands,0,start}' <> '05:00'
      )
  ) then
    raise exception 'Court hours or the first rate band changed; migration stopped safely.';
  end if;

  update public.courts court
  set opens_at = time '00:00',
      closes_at = time '00:00',
      pricing_config = pg_catalog.jsonb_set(
        court.pricing_config,
        '{regular,bands,0,start}',
        '"00:00"'::jsonb,
        false
      )
  where court.tenant_id = tenant_uuid;
  get diagnostics updated_count = row_count;

  if updated_count <> court_count then
    raise exception 'Expected to update % courts but updated %.', court_count, updated_count;
  end if;
end;
$schedule$;

commit;
