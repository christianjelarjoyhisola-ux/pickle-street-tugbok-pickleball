begin;
create extension if not exists pg_net with schema extensions;

-- The dedicated dispatch credential is provisioned separately in Vault and Edge
-- secrets. No shared tenant endpoint or existing scheduled job is modified.
create or replace function public.dispatch_picklestreet_rejection_emails()
returns bigint language plpgsql security definer set search_path='' as $$
declare dispatch_secret text; request_id bigint;
begin
  if not exists(select 1 from public.picklestreet_rejection_emails
    where tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a' and status<>'sent'
      and (lease_until is null or lease_until<now())) then return null;end if;
  select decrypted_secret into strict dispatch_secret from vault.decrypted_secrets
    where name='picklestreet_email_dispatch_secret';
  select net.http_post(
    url:='https://neqvrwtofiolcuxewdze.supabase.co/functions/v1/picklestreet-email-dispatch',
    headers:=jsonb_build_object('Content-Type','application/json','x-dispatch-secret',dispatch_secret),
    body:='{}'::jsonb,timeout_milliseconds:=30000
  ) into request_id;
  return request_id;
end;$$;
revoke all on function public.dispatch_picklestreet_rejection_emails() from public,anon,authenticated;
grant execute on function public.dispatch_picklestreet_rejection_emails() to service_role;

select cron.schedule('picklestreet-rejection-email-dispatch','* * * * *',
  'select public.dispatch_picklestreet_rejection_emails();');
commit;
