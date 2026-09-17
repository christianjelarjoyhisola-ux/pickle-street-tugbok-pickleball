-- Limit Pickle Street to six active/upcoming court-closure rows. Existing
-- closures are grandfathered: no rows are deleted, but new rows cannot be
-- created until the live count falls below the limit.

begin;

create or replace function public.manage_blocked_dates(
  p_tenant_slug text,
  p_action text,
  p_block_id uuid default null::uuid,
  p_start_date date default null::date,
  p_end_date date default null::date,
  p_court_id uuid default null::uuid,
  p_starts_at time without time zone default null::time without time zone,
  p_ends_at time without time zone default null::time without time zone,
  p_public_label text default 'Reserved'::text,
  p_internal_reason text default null::text
)
returns jsonb
language plpgsql
security definer
set search_path to ''
set row_security to 'off'
as $function$
declare
  v_tenant_id uuid;
  v_today date;
  v_existing_count integer;
  v_requested_count integer;
begin
  if auth.uid() is null or auth.role() <> 'authenticated' then
    raise exception 'A valid dashboard session is required.' using errcode = '42501';
  end if;

  v_tenant_id := public.resolve_tenant_id(
    p_tenant_slug,
    public.request_origin_hostname()
  );
  if v_tenant_id is null then
    raise exception 'The booking system was not found.' using errcode = '22023';
  end if;
  if not public.can_manage_blocked_dates(v_tenant_id) then
    raise exception 'Only the System Owner can manage blocked dates unless temporary Court Owner access is active.'
      using errcode = '42501';
  end if;

  if v_tenant_id = 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid
    and lower(btrim(coalesce(p_action, ''))) = 'create'
  then
    if p_start_date is null or coalesce(p_end_date, p_start_date) < p_start_date then
      raise exception 'Choose a valid closure date range.' using errcode = '22023';
    end if;
    v_requested_count := coalesce(p_end_date, p_start_date) - p_start_date + 1;
    if v_requested_count > 6 then
      raise exception 'Reserve a maximum of 6 dates at a time.' using errcode = '22023';
    end if;

    -- Serialize creates so two dashboard sessions cannot both pass the count.
    perform pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'picklestreet-live-blocked-limit:' || v_tenant_id::text,
        0
      )
    );
    v_today := pg_catalog.timezone('Asia/Manila', pg_catalog.clock_timestamp())::date;
    select count(*) into v_existing_count
    from public.blocked_dates
    where tenant_id = v_tenant_id
      and blocked_on >= v_today;

    if v_existing_count + v_requested_count > 6 then
      raise exception 'Only 6 active or upcoming court closures can be live at one time. Remove a closure or wait for one to expire.'
        using errcode = '22023';
    end if;
  end if;

  return public.manage_blocked_dates_origin_unchecked(
    p_tenant_slug,
    p_action,
    p_block_id,
    p_start_date,
    p_end_date,
    p_court_id,
    p_starts_at,
    p_ends_at,
    p_public_label,
    p_internal_reason
  );
end;
$function$;

commit;
