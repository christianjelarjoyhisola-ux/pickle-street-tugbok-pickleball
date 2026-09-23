-- Remove the Pickle Street active/upcoming closure cap. Keep the six-date
-- per-request guard so accidental large ranges cannot overload time-slot data.

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
    and p_start_date is not null
    and coalesce(p_end_date, p_start_date) - p_start_date + 1 > 6 then
    raise exception 'To prevent time-slot data from overloading the database, reserve a maximum of 6 dates at a time.'
      using errcode = '22023';
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
