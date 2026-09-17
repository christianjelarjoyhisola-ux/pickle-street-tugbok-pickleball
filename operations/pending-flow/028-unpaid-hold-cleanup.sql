-- Reconcile ordinary unpaid booking holds every minute. Balance-payment holds
-- retain their separate reconciler because they have different settlement and
-- restoration rules.

begin;

create or replace function public.run_picklestreet_unpaid_hold_cleanup()
returns integer
language plpgsql
security definer
set search_path to ''
set row_security to 'off'
set lock_timeout to '1000ms'
as $function$
begin
  -- This entry point is scheduler-only. Public receipt/status paths continue
  -- to call the tenant-scoped reconciler through their trusted server role.
  if session_user is distinct from 'postgres' then
    raise exception 'PICKLESTREET_SCHEDULER_REQUIRED' using errcode = '42501';
  end if;
  return public.expire_stale_tenant_holds(
    'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid
  );
end;
$function$;

revoke all on function public.run_picklestreet_unpaid_hold_cleanup()
  from public, anon, authenticated, service_role;
grant execute on function public.run_picklestreet_unpaid_hold_cleanup()
  to postgres;

do $schedule$
declare
  existing_job bigint;
begin
  for existing_job in
    select jobid
    from cron.job
    where jobname = 'picklestreet-unpaid-holds-f19f457a'
  loop
    perform cron.unschedule(existing_job);
  end loop;
  perform cron.schedule(
    'picklestreet-unpaid-holds-f19f457a',
    '* * * * *',
    'select public.run_picklestreet_unpaid_hold_cleanup();'
  );
end;
$schedule$;

commit;
