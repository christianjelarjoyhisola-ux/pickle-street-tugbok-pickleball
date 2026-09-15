-- Read-only verification after applying the rollback.
-- Expected: two rows, both callable by authenticated only; no containment
-- implementation names should remain.
select
  p.oid::regprocedure::text as function_signature,
  p.prosecdef as security_definer,
  p.proconfig as function_settings,
  pg_catalog.has_function_privilege(
    'authenticated', p.oid, 'EXECUTE'
  ) as authenticated_can_execute,
  pg_catalog.has_function_privilege(
    'anon', p.oid, 'EXECUTE'
  ) as anon_can_execute,
  pg_catalog.has_function_privilege(
    'service_role', p.oid, 'EXECUTE'
  ) as service_role_can_execute
from pg_catalog.pg_proc p
join pg_catalog.pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'save_picklestreet_payment_settings',
    'save_picklestreet_payment_settings_unthrottled_20260915',
    'manage_picklestreet_court_schedule_change',
    'manage_picklestreet_court_schedule_change_unthrottled_20260915'
  )
order by p.proname;
