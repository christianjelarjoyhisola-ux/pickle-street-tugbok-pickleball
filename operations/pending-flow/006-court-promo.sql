-- Pickle Street regular court promotions. Validate this migration with the rollback suite before applying.
-- Existing court rows and prices are deliberately not backfilled or updated by this migration.
-- Only two Pickle Street manager RPCs are exposed; no shared RPC definitions are replaced.
-- hourlyRate is materialized effective price; standardHourlyRate survives promo toggles.
begin;
set local lock_timeout = '8s';
set local statement_timeout = '45s';
create function public.picklestreet_normalize_court_promo_bands(p_opens_at text, p_closes_at text, p_bands jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $function$
declare
  v_tenant_id uuid;
  v_tenant_slug text;
  v_opens_text text := pg_catalog.btrim(coalesce(p_opens_at, ''));
  v_closes_text text := pg_catalog.btrim(coalesce(p_closes_at, ''));
  v_opens_at time;
  v_closes_at time;
  v_open_minutes integer;
  v_close_minutes integer;
  v_band jsonb;
  v_band_start text;
  v_band_end text;
  v_band_start_clock_minutes integer;
  v_band_end_clock_minutes integer;
  v_band_start_minutes integer;
  v_band_end_minutes integer;
  v_rate numeric;
  v_expected_start integer;
  v_normalized_bands jsonb := '[]'::jsonb;
  v_court_ids jsonb := '[]'::jsonb;
  v_court_count integer := 0;
  v_updated_count integer := 0;
  v_standard_rate numeric;
  v_promo_rate numeric;
  v_promo_enabled boolean;
begin
  if v_opens_text !~ '^(?:[01][0-9]|2[0-3]):00$'
     or v_closes_text !~ '^(?:[01][0-9]|2[0-3]):00$' then
    raise exception 'SHARED_COURT_SCHEDULE_INVALID'
      using errcode = '22023';
  end if;

  v_open_minutes := pg_catalog.split_part(v_opens_text, ':', 1)::integer * 60;
  v_close_minutes := pg_catalog.split_part(v_closes_text, ':', 1)::integer * 60;
  if v_close_minutes = v_open_minutes then
    raise exception 'SHARED_COURT_SCHEDULE_INVALID'
      using errcode = '22023';
  end if;
  if v_close_minutes < v_open_minutes then
    v_close_minutes := v_close_minutes + 1440;
  end if;

  v_opens_at := v_opens_text::time;
  v_closes_at := v_closes_text::time;

  if pg_catalog.jsonb_typeof(p_bands) is distinct from 'array'
     or pg_catalog.jsonb_array_length(p_bands) not between 1 and 24 then
    raise exception 'SHARED_COURT_SCHEDULE_INVALID'
      using errcode = '22023';
  end if;

  for v_band in
    select band.value
    from pg_catalog.jsonb_array_elements(p_bands) with ordinality
      as band(value, position)
    order by band.position
  loop
    if pg_catalog.jsonb_typeof(v_band) is distinct from 'object'
       or not (v_band ?& array['start', 'end'])
       or exists (
         select 1
         from pg_catalog.jsonb_object_keys(v_band) as band_key(key)
         where band_key.key not in ('start', 'end', 'hourlyRate', 'standardHourlyRate', 'promoHourlyRate', 'promoEnabled')
       )
       or pg_catalog.jsonb_typeof(v_band -> 'start') is distinct from 'string'
       or pg_catalog.jsonb_typeof(v_band -> 'end') is distinct from 'string'
       then
      raise exception 'SHARED_COURT_SCHEDULE_INVALID'
        using errcode = '22023';
    end if;

    v_band_start := v_band ->> 'start';
    v_band_end := v_band ->> 'end';
    if v_band_start !~ '^(?:[01][0-9]|2[0-3]):00$'
       or v_band_end !~ '^(?:(?:[01][0-9]|2[0-3]):00|24:00)$' then
      raise exception 'SHARED_COURT_SCHEDULE_INVALID'
        using errcode = '22023';
    end if;

    v_band_start_clock_minutes :=
      pg_catalog.split_part(v_band_start, ':', 1)::integer * 60;
    v_band_end_clock_minutes := case
      when v_band_end = '24:00' then 0
      else pg_catalog.split_part(v_band_end, ':', 1)::integer * 60
    end;
    if v_band_start_clock_minutes = v_band_end_clock_minutes then
      raise exception 'SHARED_COURT_SCHEDULE_INVALID'
        using errcode = '22023';
    end if;

    v_band_start_minutes := v_band_start_clock_minutes;
    if v_band_start_minutes < v_open_minutes then
      v_band_start_minutes := v_band_start_minutes + 1440;
    end if;
    v_band_end_minutes := case
      when v_band_end = '24:00' then 1440
      else v_band_end_clock_minutes
    end;
    if v_band_end_minutes < v_open_minutes then
      v_band_end_minutes := v_band_end_minutes + 1440;
    end if;

    if v_band ?| array['standardHourlyRate', 'promoHourlyRate', 'promoEnabled'] then
      if not (v_band ?& array['standardHourlyRate', 'promoHourlyRate', 'promoEnabled'])
         or pg_catalog.jsonb_typeof(v_band -> 'standardHourlyRate') is distinct from 'number'
         or pg_catalog.jsonb_typeof(v_band -> 'promoEnabled') is distinct from 'boolean'
         or pg_catalog.jsonb_typeof(v_band -> 'promoHourlyRate') not in ('number', 'null') then
        raise exception 'PICKLESTREET_PROMO_RATE_INVALID' using errcode = '22023';
      end if;
      v_standard_rate := (v_band ->> 'standardHourlyRate')::numeric;
      v_promo_rate := (v_band ->> 'promoHourlyRate')::numeric;
      v_promo_enabled := (v_band ->> 'promoEnabled')::boolean;
    else
      if pg_catalog.jsonb_typeof(v_band -> 'hourlyRate') is distinct from 'number' then
        raise exception 'PICKLESTREET_PROMO_RATE_INVALID' using errcode = '22023';
      end if;
      v_standard_rate := (v_band ->> 'hourlyRate')::numeric;
      v_promo_rate := null;
      v_promo_enabled := false;
    end if;
    if v_standard_rate <= 0 or v_standard_rate > 9999999999.99
       or v_standard_rate <> pg_catalog.round(v_standard_rate, 2)
       or (v_promo_rate is not null and (
         v_promo_rate <= 0 or v_promo_rate > 9999999999.99
         or (v_promo_enabled and v_promo_rate >= v_standard_rate)
         or v_promo_rate <> pg_catalog.round(v_promo_rate, 2)
       )) or (v_promo_enabled and v_promo_rate is null) then
      raise exception 'PICKLESTREET_PROMO_RATE_INVALID' using errcode = '22023';
    end if;
    begin
      v_rate := case when v_promo_enabled then v_promo_rate else v_standard_rate end;
    exception
      when invalid_text_representation or numeric_value_out_of_range then
        raise exception 'SHARED_COURT_SCHEDULE_INVALID'
          using errcode = '22023';
    end;

    if v_band_end_minutes <= v_band_start_minutes
       or v_band_start_minutes < v_open_minutes
       or v_band_end_minutes > v_close_minutes
       or v_rate <= 0
       or v_rate > 9999999999.99
       or v_rate <> pg_catalog.round(v_rate, 2) then
      raise exception 'SHARED_COURT_SCHEDULE_INVALID'
        using errcode = '22023';
    end if;

    v_normalized_bands := v_normalized_bands || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'start', v_band_start,
        'end', v_band_end,
        'hourlyRate', v_rate,
        'standardHourlyRate', v_standard_rate,
        'promoHourlyRate', v_promo_rate,
        'promoEnabled', v_promo_enabled
      )
    );
  end loop;

  -- Order by the operating-day timeline, not wall-clock time, so post-midnight
  -- bands remain after the pre-midnight bands. Already ordered input remains
  -- byte-compatible with existing same-day configuration.
  select coalesce(pg_catalog.jsonb_agg(band.value order by
    case
      when pg_catalog.split_part(band.value ->> 'start', ':', 1)::integer * 60
        < v_open_minutes
        then pg_catalog.split_part(band.value ->> 'start', ':', 1)::integer * 60
          + 1440
      else pg_catalog.split_part(band.value ->> 'start', ':', 1)::integer * 60
    end,
    case
      when band.value ->> 'end' = '24:00' then 1440
      when pg_catalog.split_part(band.value ->> 'end', ':', 1)::integer * 60
        < v_open_minutes
        then pg_catalog.split_part(band.value ->> 'end', ':', 1)::integer * 60
          + 1440
      else pg_catalog.split_part(band.value ->> 'end', ':', 1)::integer * 60
    end
  ), '[]'::jsonb)
  into v_normalized_bands
  from pg_catalog.jsonb_array_elements(v_normalized_bands) as band(value);

  v_expected_start := v_open_minutes;
  for v_band in
    select band.value
    from pg_catalog.jsonb_array_elements(v_normalized_bands) with ordinality
      as band(value, position)
    order by band.position
  loop
    v_band_start_clock_minutes :=
      pg_catalog.split_part(v_band ->> 'start', ':', 1)::integer * 60;
    v_band_start_minutes := v_band_start_clock_minutes;
    if v_band_start_minutes < v_open_minutes then
      v_band_start_minutes := v_band_start_minutes + 1440;
    end if;

    v_band_end_clock_minutes := case
      when v_band ->> 'end' = '24:00' then 0
      else pg_catalog.split_part(v_band ->> 'end', ':', 1)::integer * 60
    end;
    v_band_end_minutes := case
      when v_band ->> 'end' = '24:00' then 1440
      else v_band_end_clock_minutes
    end;
    if v_band_end_minutes < v_open_minutes then
      v_band_end_minutes := v_band_end_minutes + 1440;
    end if;

    if v_band_start_minutes <> v_expected_start then
      raise exception 'SHARED_COURT_SCHEDULE_INVALID'
        using errcode = '22023';
    end if;
    v_expected_start := v_band_end_minutes;
  end loop;
  if v_expected_start <> v_close_minutes then
    raise exception 'SHARED_COURT_SCHEDULE_INVALID'
      using errcode = '22023';
  end if;

  return v_normalized_bands;
end;
$function$;
revoke all on function public.picklestreet_normalize_court_promo_bands(text,text,jsonb) from public, anon, authenticated;

create function public.guard_picklestreet_court_promo_rates()
returns trigger language plpgsql security definer set search_path = '' set row_security = off as $function$
declare v_bands jsonb;
begin
  -- This trigger performs no reads, locks, or writes for other tenants.
  if new.tenant_id is distinct from 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid then return new; end if;
  if tg_op = 'UPDATE' and new.pricing_config is not distinct from old.pricing_config
     and new.opens_at is not distinct from old.opens_at
     and new.closes_at is not distinct from old.closes_at then return new; end if;
  v_bands := new.pricing_config #> '{regular,bands}';
  if pg_catalog.jsonb_typeof(v_bands) is distinct from 'array'
     or extract(minute from new.opens_at) <> 0 or extract(second from new.opens_at) <> 0
     or extract(minute from new.closes_at) <> 0 or extract(second from new.closes_at) <> 0 then
    raise exception 'SHARED_COURT_SCHEDULE_INVALID' using errcode = '22023';
  end if;
  if tg_op = 'UPDATE' and pg_catalog.jsonb_typeof(old.pricing_config #> '{regular,bands}') = 'array' then
    if exists (select 1 from pg_catalog.jsonb_array_elements(old.pricing_config #> '{regular,bands}') as band(value)
        where band.value ?| array['standardHourlyRate', 'promoHourlyRate', 'promoEnabled'])
       and exists (select 1 from pg_catalog.jsonb_array_elements(v_bands) as band(value)
        where not (band.value ?& array['standardHourlyRate', 'promoHourlyRate', 'promoEnabled'])) then
      -- A cached legacy save must never replace a preserved regular price with its discounted effective value.
      raise exception 'PICKLESTREET_PROMO_METADATA_REQUIRED' using errcode = '22023';
    end if;
  end if;
  v_bands := public.picklestreet_normalize_court_promo_bands(
    pg_catalog.to_char(new.opens_at, 'HH24:MI'), pg_catalog.to_char(new.closes_at, 'HH24:MI'), v_bands
  );
  new.pricing_config := pg_catalog.jsonb_set(new.pricing_config, '{regular,bands}', v_bands, false);
  return new;
end;
$function$;
revoke all on function public.guard_picklestreet_court_promo_rates() from public, anon, authenticated;
create trigger aa_picklestreet_court_promo_rates before insert or update of pricing_config, opens_at, closes_at
on public.courts for each row
when (new.tenant_id = 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid)
execute function public.guard_picklestreet_court_promo_rates();

create function public.lock_picklestreet_court_revisions(p_tenant_slug text, p_hostname text, p_expected_revisions jsonb)
returns void language plpgsql security definer set search_path = '' set row_security = off as $function$
declare v_tenant_id uuid; v_court public.courts%rowtype; v_expected_at timestamptz; v_count integer := 0;
begin
  if auth.uid() is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501'; end if;
  v_tenant_id := public.resolve_tenant_id(p_tenant_slug, p_hostname);
  if v_tenant_id is distinct from 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid then
    raise exception 'PICKLESTREET_TENANT_ORIGIN_DENIED' using errcode = '42501';
  end if;
  if not public.has_tenant_role(v_tenant_id, array['owner','admin']) then
    raise exception 'TENANT_COURT_ACCESS_DENIED' using errcode = '42501';
  end if;
  perform 1 from public.tenants where id = v_tenant_id for update;
  if public.resolve_tenant_id(p_tenant_slug, p_hostname) is distinct from v_tenant_id
     or not public.has_tenant_role(v_tenant_id, array['owner','admin']) then
    raise exception 'TENANT_COURT_ACCESS_DENIED' using errcode = '42501';
  end if;
  if pg_catalog.jsonb_typeof(p_expected_revisions) is distinct from 'object' then
    raise exception 'PICKLESTREET_COURT_REVISION_REQUIRED' using errcode = '22023';
  end if;
  for v_court in select c.* from public.courts c where c.tenant_id = v_tenant_id order by c.id for update loop
    v_count := v_count + 1;
    if pg_catalog.jsonb_typeof(p_expected_revisions -> v_court.id::text) is distinct from 'string' then
      raise exception 'PICKLESTREET_COURT_REVISION_CONFLICT' using errcode = '40001';
    end if;
    begin
      v_expected_at := (p_expected_revisions ->> v_court.id::text)::timestamptz;
    exception when others then
      raise exception 'PICKLESTREET_COURT_REVISION_CONFLICT' using errcode = '40001';
    end;
    if v_expected_at is distinct from v_court.updated_at then
      raise exception 'PICKLESTREET_COURT_REVISION_CONFLICT' using errcode = '40001';
    end if;
  end loop;
  if (select count(*) from pg_catalog.jsonb_object_keys(p_expected_revisions)) <> v_count then
    raise exception 'PICKLESTREET_COURT_REVISION_CONFLICT' using errcode = '40001';
  end if;
end;
$function$;
revoke all on function public.lock_picklestreet_court_revisions(text,text,jsonb) from public, anon, authenticated;
CREATE OR REPLACE FUNCTION public.apply_shared_picklestreet_court_schedule(p_tenant_slug text, p_hostname text, p_opens_at text, p_closes_at text, p_bands jsonb, p_expected_revisions jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET row_security TO 'off'
AS $function$
declare
  v_tenant_id uuid;
  v_tenant_slug text;
  v_opens_text text := pg_catalog.btrim(coalesce(p_opens_at, ''));
  v_closes_text text := pg_catalog.btrim(coalesce(p_closes_at, ''));
  v_opens_at time;
  v_closes_at time;
  v_open_minutes integer;
  v_close_minutes integer;
  v_band jsonb;
  v_band_start text;
  v_band_end text;
  v_band_start_clock_minutes integer;
  v_band_end_clock_minutes integer;
  v_band_start_minutes integer;
  v_band_end_minutes integer;
  v_rate numeric;
  v_expected_start integer;
  v_normalized_bands jsonb := '[]'::jsonb;
  v_court_ids jsonb := '[]'::jsonb;
  v_court_count integer := 0;
  v_updated_count integer := 0;
begin
  perform public.lock_picklestreet_court_revisions(p_tenant_slug, p_hostname, p_expected_revisions);
  p_bands := public.picklestreet_normalize_court_promo_bands(p_opens_at, p_closes_at, p_bands);
  if auth.uid() is null then

    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;

  v_tenant_id := public.resolve_tenant_id(p_tenant_slug, p_hostname);
  if v_tenant_id is null then
    raise exception 'TENANT_ORIGIN_DENIED' using errcode = '42501';
  end if;
  if not public.has_tenant_role(v_tenant_id, array['owner', 'admin']) then
    raise exception 'TENANT_COURT_ACCESS_DENIED' using errcode = '42501';
  end if;

  select tenant.slug
  into v_tenant_slug
  from public.tenants tenant
  where tenant.id = v_tenant_id
  for update;
  if not found
     or public.resolve_tenant_id(p_tenant_slug, p_hostname)
       is distinct from v_tenant_id then
    raise exception 'TENANT_ORIGIN_DENIED' using errcode = '42501';
  end if;
  if not public.has_tenant_role(v_tenant_id, array['owner', 'admin']) then
    raise exception 'TENANT_COURT_ACCESS_DENIED' using errcode = '42501';
  end if;

  if v_opens_text !~ '^(?:[01][0-9]|2[0-3]):00$'
     or v_closes_text !~ '^(?:[01][0-9]|2[0-3]):00$' then
    raise exception 'SHARED_COURT_SCHEDULE_INVALID'
      using errcode = '22023';
  end if;

  v_open_minutes := pg_catalog.split_part(v_opens_text, ':', 1)::integer * 60;
  v_close_minutes := pg_catalog.split_part(v_closes_text, ':', 1)::integer * 60;
  if v_close_minutes = v_open_minutes then
    raise exception 'SHARED_COURT_SCHEDULE_INVALID'
      using errcode = '22023';
  end if;
  if v_close_minutes < v_open_minutes then
    v_close_minutes := v_close_minutes + 1440;
  end if;

  v_opens_at := v_opens_text::time;
  v_closes_at := v_closes_text::time;

  if pg_catalog.jsonb_typeof(p_bands) is distinct from 'array'
     or pg_catalog.jsonb_array_length(p_bands) not between 1 and 24 then
    raise exception 'SHARED_COURT_SCHEDULE_INVALID'
      using errcode = '22023';
  end if;

  for v_band in
    select band.value
    from pg_catalog.jsonb_array_elements(p_bands) with ordinality
      as band(value, position)
    order by band.position
  loop
    if pg_catalog.jsonb_typeof(v_band) is distinct from 'object'
       or not (v_band ?& array['start', 'end', 'hourlyRate'])
       or exists (
         select 1
         from pg_catalog.jsonb_object_keys(v_band) as band_key(key)
         where band_key.key not in ('start', 'end', 'hourlyRate', 'standardHourlyRate', 'promoHourlyRate', 'promoEnabled')
       )
       or pg_catalog.jsonb_typeof(v_band -> 'start') is distinct from 'string'
       or pg_catalog.jsonb_typeof(v_band -> 'end') is distinct from 'string'
       or pg_catalog.jsonb_typeof(v_band -> 'hourlyRate') is distinct from 'number' then
      raise exception 'SHARED_COURT_SCHEDULE_INVALID'
        using errcode = '22023';
    end if;

    v_band_start := v_band ->> 'start';
    v_band_end := v_band ->> 'end';
    if v_band_start !~ '^(?:[01][0-9]|2[0-3]):00$'
       or v_band_end !~ '^(?:(?:[01][0-9]|2[0-3]):00|24:00)$' then
      raise exception 'SHARED_COURT_SCHEDULE_INVALID'
        using errcode = '22023';
    end if;

    v_band_start_clock_minutes :=
      pg_catalog.split_part(v_band_start, ':', 1)::integer * 60;
    v_band_end_clock_minutes := case
      when v_band_end = '24:00' then 0
      else pg_catalog.split_part(v_band_end, ':', 1)::integer * 60
    end;
    if v_band_start_clock_minutes = v_band_end_clock_minutes then
      raise exception 'SHARED_COURT_SCHEDULE_INVALID'
        using errcode = '22023';
    end if;

    v_band_start_minutes := v_band_start_clock_minutes;
    if v_band_start_minutes < v_open_minutes then
      v_band_start_minutes := v_band_start_minutes + 1440;
    end if;
    v_band_end_minutes := case
      when v_band_end = '24:00' then 1440
      else v_band_end_clock_minutes
    end;
    if v_band_end_minutes < v_open_minutes then
      v_band_end_minutes := v_band_end_minutes + 1440;
    end if;

    begin
      v_rate := (v_band ->> 'hourlyRate')::numeric;
    exception
      when invalid_text_representation or numeric_value_out_of_range then
        raise exception 'SHARED_COURT_SCHEDULE_INVALID'
          using errcode = '22023';
    end;

    if v_band_end_minutes <= v_band_start_minutes
       or v_band_start_minutes < v_open_minutes
       or v_band_end_minutes > v_close_minutes
       or v_rate <= 0
       or v_rate > 9999999999.99
       or v_rate <> pg_catalog.round(v_rate, 2) then
      raise exception 'SHARED_COURT_SCHEDULE_INVALID'
        using errcode = '22023';
    end if;

    v_normalized_bands := v_normalized_bands || pg_catalog.jsonb_build_array(
      v_band || pg_catalog.jsonb_build_object(
        'start', v_band_start,
        'end', v_band_end,
        'hourlyRate', v_rate
      )
    );
  end loop;

  -- Order by the operating-day timeline, not wall-clock time, so post-midnight
  -- bands remain after the pre-midnight bands. Already ordered input remains
  -- byte-compatible with existing same-day configuration.
  select coalesce(pg_catalog.jsonb_agg(band.value order by
    case
      when pg_catalog.split_part(band.value ->> 'start', ':', 1)::integer * 60
        < v_open_minutes
        then pg_catalog.split_part(band.value ->> 'start', ':', 1)::integer * 60
          + 1440
      else pg_catalog.split_part(band.value ->> 'start', ':', 1)::integer * 60
    end,
    case
      when band.value ->> 'end' = '24:00' then 1440
      when pg_catalog.split_part(band.value ->> 'end', ':', 1)::integer * 60
        < v_open_minutes
        then pg_catalog.split_part(band.value ->> 'end', ':', 1)::integer * 60
          + 1440
      else pg_catalog.split_part(band.value ->> 'end', ':', 1)::integer * 60
    end
  ), '[]'::jsonb)
  into v_normalized_bands
  from pg_catalog.jsonb_array_elements(v_normalized_bands) as band(value);

  v_expected_start := v_open_minutes;
  for v_band in
    select band.value
    from pg_catalog.jsonb_array_elements(v_normalized_bands) with ordinality
      as band(value, position)
    order by band.position
  loop
    v_band_start_clock_minutes :=
      pg_catalog.split_part(v_band ->> 'start', ':', 1)::integer * 60;
    v_band_start_minutes := v_band_start_clock_minutes;
    if v_band_start_minutes < v_open_minutes then
      v_band_start_minutes := v_band_start_minutes + 1440;
    end if;

    v_band_end_clock_minutes := case
      when v_band ->> 'end' = '24:00' then 0
      else pg_catalog.split_part(v_band ->> 'end', ':', 1)::integer * 60
    end;
    v_band_end_minutes := case
      when v_band ->> 'end' = '24:00' then 1440
      else v_band_end_clock_minutes
    end;
    if v_band_end_minutes < v_open_minutes then
      v_band_end_minutes := v_band_end_minutes + 1440;
    end if;

    if v_band_start_minutes <> v_expected_start then
      raise exception 'SHARED_COURT_SCHEDULE_INVALID'
        using errcode = '22023';
    end if;
    v_expected_start := v_band_end_minutes;
  end loop;
  if v_expected_start <> v_close_minutes then
    raise exception 'SHARED_COURT_SCHEDULE_INVALID'
      using errcode = '22023';
  end if;

  perform 1
  from public.courts court
  where court.tenant_id = v_tenant_id
  order by court.id
  for update;
  get diagnostics v_court_count = row_count;
  if v_court_count = 0 then
    raise exception 'TENANT_COURTS_REQUIRED' using errcode = 'P0002';
  end if;

  if exists (
    select 1
    from public.courts court
    where court.tenant_id = v_tenant_id
      and court.pricing_config ? 'regular'
      and pg_catalog.jsonb_typeof(court.pricing_config -> 'regular') <> 'object'
  ) then
    raise exception 'COURT_PRICING_CONFIG_INVALID'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.courts court
    where court.tenant_id = v_tenant_id
      and (
        (
          case
            when pg_catalog.jsonb_typeof(
              court.pricing_config #> '{regular,minimumHours}'
            ) = 'number'
              then (court.pricing_config #>> '{regular,minimumHours}')::numeric
            else null
          end
            > (v_close_minutes - v_open_minutes)::numeric / 60
        )
        or (
          court.pricing_config #> '{event,enabled}' = 'true'::jsonb
          and case
            when pg_catalog.jsonb_typeof(
              court.pricing_config #> '{event,minimumHours}'
            ) = 'number'
              then (court.pricing_config #>> '{event,minimumHours}')::numeric
            else null
          end
            > (v_close_minutes - v_open_minutes)::numeric / 60
        )
      )
  ) then
    raise exception 'COURT_BOOKING_POLICY_INCOMPATIBLE'
      using errcode = '22023';
  end if;

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.to_jsonb(court.id)
      order by court.sort_order, court.name, court.id
    ),
    '[]'::jsonb
  )
  into v_court_ids
  from public.courts court
  where court.tenant_id = v_tenant_id;

  update public.courts court
  set opens_at = v_opens_at,
      closes_at = v_closes_at,
      pricing_config = pg_catalog.jsonb_set(
        court.pricing_config,
        '{regular}',
        coalesce(court.pricing_config -> 'regular', '{}'::jsonb)
          || pg_catalog.jsonb_build_object('bands', v_normalized_bands),
        true
      )
  where court.tenant_id = v_tenant_id
    and (
      court.opens_at is distinct from v_opens_at
      or court.closes_at is distinct from v_closes_at
      or court.pricing_config #> '{regular,bands}'
        is distinct from v_normalized_bands
    );
  get diagnostics v_updated_count = row_count;

  return pg_catalog.jsonb_build_object(
    'tenantId', v_tenant_id,
    'tenantSlug', v_tenant_slug,
    'courtCount', v_court_count,
    'updatedCourtCount', v_updated_count,
    'courtIds', v_court_ids,
    'schedule', pg_catalog.jsonb_build_object(
      'opensAt', v_opens_text,
      'closesAt', v_closes_text,
      'bands', v_normalized_bands
    ),
    'revisions', (select coalesce(pg_catalog.jsonb_object_agg(c.id::text, pg_catalog.to_jsonb(c.updated_at)), '{}'::jsonb)
      from public.courts c where c.tenant_id = v_tenant_id),
    'readiness', public.tenant_booking_activation_state(v_tenant_id)
  );
end;
$function$;
revoke all on function public.apply_shared_picklestreet_court_schedule(text,text,text,text,jsonb,jsonb) from public, anon;
grant execute on function public.apply_shared_picklestreet_court_schedule(text,text,text,text,jsonb,jsonb) to authenticated;

create function public.manage_picklestreet_court(p_tenant_slug text, p_hostname text, p_action text,
  p_court_id uuid default null, p_patch jsonb default '{}'::jsonb, p_expected_revisions jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' set row_security = off as $function$
declare v_result jsonb;
begin
  perform public.lock_picklestreet_court_revisions(p_tenant_slug, p_hostname, p_expected_revisions);
  -- Preserve the shared court contract, delete FK protection and audit triggers. The target-only
  -- court guard validates all schedule coverage and derives the effective hourly rate on save.
  v_result := public.manage_tenant_court(p_tenant_slug, p_hostname, p_action, p_court_id, p_patch);
  return v_result || pg_catalog.jsonb_build_object('revisions', (
    select coalesce(pg_catalog.jsonb_object_agg(c.id::text, pg_catalog.to_jsonb(c.updated_at)), '{}'::jsonb)
    from public.courts c where c.tenant_id = 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid
  ));
end;
$function$;
revoke all on function public.manage_picklestreet_court(text,text,text,uuid,jsonb,jsonb) from public, anon;
grant execute on function public.manage_picklestreet_court(text,text,text,uuid,jsonb,jsonb) to authenticated;

commit;
