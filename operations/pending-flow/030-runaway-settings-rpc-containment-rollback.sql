-- Roll back 030-runaway-settings-rpc-containment.sql.
-- Restores the exact preserved implementations and their authenticated ACLs.
-- No business data is changed.

begin;

do $block$
begin
  if pg_catalog.to_regprocedure(
       'public.save_picklestreet_payment_settings_unthrottled_20260915(text,text,timestamp with time zone,jsonb)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.manage_picklestreet_court_schedule_change_unthrottled_20260915(text,text,text,uuid,timestamp with time zone,text,text,jsonb,jsonb)'
     ) is null then
    raise exception 'PICKLESTREET_RPC_CONTAINMENT_NOT_INSTALLED';
  end if;
end;
$block$;

drop function public.save_picklestreet_payment_settings(
  text, text, timestamptz, jsonb
);
drop function public.manage_picklestreet_court_schedule_change(
  text, text, text, uuid, timestamptz, text, text, jsonb, jsonb
);

alter function public.save_picklestreet_payment_settings_unthrottled_20260915(
  text, text, timestamptz, jsonb
) rename to save_picklestreet_payment_settings;

alter function public.manage_picklestreet_court_schedule_change_unthrottled_20260915(
  text, text, text, uuid, timestamptz, text, text, jsonb, jsonb
) rename to manage_picklestreet_court_schedule_change;

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
