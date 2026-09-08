begin;
alter table public.blocked_date_access_grants drop constraint blocked_date_access_grants_duration_valid;
alter table public.blocked_date_access_grants add constraint blocked_date_access_grants_duration_valid check (duration_days in (1,2,3) or (tenant_id = 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid and duration_days = 0 and expires_at = 'infinity'::timestamptz));
CREATE OR REPLACE FUNCTION public.set_blocked_date_access(p_tenant_slug text, p_action text, p_duration_days smallint DEFAULT NULL::smallint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET row_security TO 'off'
AS $function$
declare
  v_tenant_id uuid;
  v_action text := lower(btrim(coalesce(p_action, '')));
  v_now timestamptz := clock_timestamp();
begin
  if auth.uid() is null or auth.role() <> 'authenticated' then
    raise exception 'A valid System Owner session is required.' using errcode = '42501';
  end if;

  v_tenant_id := public.resolve_tenant_id(
    p_tenant_slug,
    public.request_origin_hostname()
  );
  if v_tenant_id is null then
    raise exception 'The booking system was not found.' using errcode = '22023';
  end if;
  if not public.is_platform_owner() then
    raise exception 'Only the System Owner can change Court Owner blocked-date access.'
      using errcode = '42501';
  end if;

  if v_action = 'grant' then
    if p_duration_days is null or (p_duration_days not in (1, 2, 3) and not (p_duration_days = 0 and v_tenant_id = 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid)) then
      raise exception 'Choose an access duration of 1, 2, or 3 days.'
        using errcode = '22023';
    end if;

    insert into public.blocked_date_access_grants (
      tenant_id,
      duration_days,
      granted_by,
      granted_at,
      expires_at,
      revoked_at,
      revoked_by
    ) values (
      v_tenant_id,
      p_duration_days,
      auth.uid(),
      v_now,
      case when p_duration_days = 0 then 'infinity'::timestamptz else v_now + make_interval(days => p_duration_days) end,
      null,
      null
    )
    on conflict (tenant_id) do update set
      duration_days = excluded.duration_days,
      granted_by = excluded.granted_by,
      granted_at = excluded.granted_at,
      expires_at = excluded.expires_at,
      revoked_at = null,
      revoked_by = null;
  elsif v_action = 'revoke' then
    update public.blocked_date_access_grants access set
      revoked_at = v_now,
      revoked_by = auth.uid()
    where access.tenant_id = v_tenant_id
      and access.revoked_at is null;
  else
    raise exception 'The blocked-date access action is invalid.' using errcode = '22023';
  end if;

  return public.blocked_date_access_payload(v_tenant_id);
end;
$function$
;
commit;
