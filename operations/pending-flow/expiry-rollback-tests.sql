do $$
begin
 if (select count(*) from cron.job where jobname='picklestreet-balance-holds-f19f457a'
   and active and schedule='* * * * *' and command='select public.run_picklestreet_balance_hold_cleanup();')<>1 then
   raise exception 'Target hold-expiry job is not configured correctly';end if;
 if has_function_privilege('anon','public.run_picklestreet_balance_hold_cleanup()','EXECUTE')
   or has_function_privilege('authenticated','public.run_picklestreet_balance_hold_cleanup()','EXECUTE')
   or has_function_privilege('service_role','public.run_picklestreet_balance_hold_cleanup()','EXECUTE') then
   raise exception 'Scheduler wrapper is exposed';end if;
end;$$;
select public.run_picklestreet_balance_hold_cleanup() as released_holds;
select 'Target-only expiry job configured; scheduler wrapper private' as check,true as passed;
