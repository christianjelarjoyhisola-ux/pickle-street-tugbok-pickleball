-- Emergency containment for authenticated clients repeatedly replaying stale
-- Pickle Street settings writes. No business data is changed by this migration.
--
-- The original functions are retained under private implementation names. The
-- public signatures become small admission-control wrappers which:
--   * serialize each actor independently for this tenant and operation;
--   * admit at most one call per second for that actor/operation;
--   * turn the two expected optimistic-concurrency SQLSTATE 40001 failures into
--     structured JSON instead of high-volume PostgreSQL errors.

begin;

-- Fail rather than replacing an unexpected partial/previous installation.
do $block$
begin
  if pg_catalog.to_regprocedure(
       'public.save_picklestreet_payment_settings_unthrottled_20260915(text,text,timestamp with time zone,jsonb)'
     ) is not null
     or pg_catalog.to_regprocedure(
       'public.manage_picklestreet_court_schedule_change_unthrottled_20260915(text,text,text,uuid,timestamp with time zone,text,text,jsonb,jsonb)'
     ) is not null then
    raise exception 'PICKLESTREET_RPC_CONTAINMENT_ALREADY_INSTALLED';
  end if;
  if pg_catalog.to_regprocedure(
       'public.save_picklestreet_payment_settings(text,text,timestamp with time zone,jsonb)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.manage_picklestreet_court_schedule_change(text,text,text,uuid,timestamp with time zone,text,text,jsonb,jsonb)'
     ) is null then
    raise exception 'PICKLESTREET_RPC_CONTAINMENT_SOURCE_MISSING';
  end if;
end;
$block$;

alter function public.save_picklestreet_payment_settings(
  text, text, timestamptz, jsonb
) rename to save_picklestreet_payment_settings_unthrottled_20260915;

alter function public.manage_picklestreet_court_schedule_change(
  text, text, text, uuid, timestamptz, text, text, jsonb, jsonb
) rename to manage_picklestreet_court_schedule_change_unthrottled_20260915;

revoke all on function public.save_picklestreet_payment_settings_unthrottled_20260915(
  text, text, timestamptz, jsonb
) from public, anon, authenticated, service_role;

revoke all on function public.manage_picklestreet_court_schedule_change_unthrottled_20260915(
  text, text, text, uuid, timestamptz, text, text, jsonb, jsonb
) from public, anon, authenticated, service_role;

create function public.save_picklestreet_payment_settings(
  p_tenant_slug text,
  p_hostname text,
  p_expected_revision timestamptz,
  p_patch jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set row_security = off
as $function$
declare
  v_actor_id uuid := auth.uid();
  v_tenant_id uuid;
  v_lock_key bigint;
begin
  if v_actor_id is null then
    raise exception 'TENANT_ACCESS_DENIED' using errcode = '42501';
  end if;
  v_tenant_id := public.resolve_tenant_id(p_tenant_slug, p_hostname);
  if v_tenant_id is distinct from 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid
     or not (
       public.is_platform_owner()
       or public.has_tenant_role(v_tenant_id, array['owner','admin'])
     ) then
    raise exception 'TENANT_ACCESS_DENIED' using errcode = '42501';
  end if;

  -- Authorization is completed before admission control. It performs no row
  -- lock or write. Including the verified tenant and actor prevents one account
  -- from blocking a different administrator or another tenant.
  v_lock_key := pg_catalog.hashtextextended(
    'picklestreet-rpc-containment:' || v_tenant_id::text || ':'
      || v_actor_id::text || ':payment-settings',
    0
  );
  if not pg_catalog.pg_try_advisory_xact_lock(v_lock_key) then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'errorCode', 'PICKLESTREET_WRITE_IN_PROGRESS',
      'operation', 'payment-settings',
      'retryAfterMs', 1500
    );
  end if;

  -- Holding the transaction lock for one second bounds this actor to one
  -- admitted attempt per second even when the stale check fails immediately.
  -- Repeated calls can therefore occupy at most one sleeping connection for
  -- this actor/tenant/operation; other actors and operations use different keys.
  perform pg_catalog.pg_sleep(1.0);
  begin
    return public.save_picklestreet_payment_settings_unthrottled_20260915(
      p_tenant_slug, p_hostname, p_expected_revision, p_patch
    );
  exception
    when serialization_failure then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'errorCode', 'BUSINESS_SETTINGS_STALE',
        'operation', 'payment-settings',
        'retryAfterMs', 1500
      );
  end;
end;
$function$;

create function public.manage_picklestreet_court_schedule_change(
  p_tenant_slug text,
  p_hostname text,
  p_action text,
  p_change_id uuid default null,
  p_effective_at timestamptz default null,
  p_opens_at text default null,
  p_closes_at text default null,
  p_bands jsonb default null,
  p_expected_revisions jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set row_security = off
as $function$
declare
  v_actor_id uuid := auth.uid();
  v_tenant_id uuid;
  v_lock_key bigint;
begin
  if v_actor_id is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;
  v_tenant_id := public.resolve_tenant_id(p_tenant_slug, p_hostname);
  if v_tenant_id is distinct from 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid
     or not public.has_tenant_role(v_tenant_id, array['owner','admin']) then
    raise exception 'TENANT_COURT_ACCESS_DENIED' using errcode = '42501';
  end if;

  v_lock_key := pg_catalog.hashtextextended(
    'picklestreet-rpc-containment:' || v_tenant_id::text || ':'
      || v_actor_id::text || ':court-schedule-change',
    0
  );
  if not pg_catalog.pg_try_advisory_xact_lock(v_lock_key) then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'errorCode', 'PICKLESTREET_WRITE_IN_PROGRESS',
      'operation', 'court-schedule-change',
      'retryAfterMs', 1500
    );
  end if;

  -- Bounded to one sleeping connection for this actor/tenant/operation.
  perform pg_catalog.pg_sleep(1.0);
  begin
    return public.manage_picklestreet_court_schedule_change_unthrottled_20260915(
      p_tenant_slug,
      p_hostname,
      p_action,
      p_change_id,
      p_effective_at,
      p_opens_at,
      p_closes_at,
      p_bands,
      p_expected_revisions
    );
  exception
    when serialization_failure then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'errorCode', 'PICKLESTREET_COURT_REVISION_CONFLICT',
        'operation', 'court-schedule-change',
        'retryAfterMs', 1500
      );
  end;
end;
$function$;

revoke all on function public.save_picklestreet_payment_settings(
  text, text, timestamptz, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.save_picklestreet_payment_settings(
  text, text, timestamptz, jsonb
) to authenticated;

revoke all on function public.manage_picklestreet_court_schedule_change(
  text, text, text, uuid, timestamptz, text, text, jsonb, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.manage_picklestreet_court_schedule_change(
  text, text, text, uuid, timestamptz, text, text, jsonb, jsonb
) to authenticated;

notify pgrst, 'reload schema';

commit;
