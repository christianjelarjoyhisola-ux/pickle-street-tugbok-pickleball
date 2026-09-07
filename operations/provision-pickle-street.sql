-- Runs only the shared platform's existing guarded onboarding functions.
-- No shared schema, policies, triggers, functions, or existing tenant is changed.
begin;
create temporary table ps_onboarding_baseline on commit drop as
select 'tenants' as table_name, md5(coalesce(jsonb_agg(to_jsonb(t) order by t.id)::text, '[]')) as digest from public.tenants t
union all select 'tenant_domains', md5(coalesce(jsonb_agg(to_jsonb(t) order by t.id)::text, '[]')) from public.tenant_domains t
union all select 'courts', md5(coalesce(jsonb_agg(to_jsonb(t) order by t.id)::text, '[]')) from public.courts t;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
select public.provision_tenant('tenant-provision-pickle-street-tugbok-20260907-v1', 'pickle-street-tugbok', 'Pickle Street Tugbok', 'Asia/Manila');
select public.provision_tenant_domain(
  'domain-provision-pickle-street-tugbok-sites-20260907-v1',
  (select id from public.tenants where slug = 'pickle-street-tugbok'),
  'pickle-street-tugbok.boothsandbeyondoffic.chatgpt.site', true
);
reset role;

do $$
declare tenant_uuid uuid; current_digest text;
begin
  select id into strict tenant_uuid from public.tenants where slug = 'pickle-street-tugbok';
  select md5(coalesce(jsonb_agg(to_jsonb(t) order by t.id)::text,'[]')) into current_digest from public.tenants t where id <> tenant_uuid;
  if current_digest <> (select digest from ps_onboarding_baseline where table_name='tenants') then raise exception 'Existing tenant identity changed'; end if;
  select md5(coalesce(jsonb_agg(to_jsonb(t) order by t.id)::text,'[]')) into current_digest from public.tenant_domains t where tenant_id <> tenant_uuid;
  if current_digest <> (select digest from ps_onboarding_baseline where table_name='tenant_domains') then raise exception 'Existing tenant domain changed'; end if;
  select md5(coalesce(jsonb_agg(to_jsonb(t) order by t.id)::text,'[]')) into current_digest from public.courts t where tenant_id <> tenant_uuid;
  if current_digest <> (select digest from ps_onboarding_baseline where table_name='courts') then raise exception 'Existing tenant court changed'; end if;
end $$;
commit;

select t.id, t.slug, t.name, s.status as setup_status,
  (select count(*) from public.courts c where c.tenant_id=t.id) as courts,
  (select count(*) from public.tenant_memberships m where m.tenant_id=t.id) as memberships
from public.tenants t join public.tenant_setup_status s on s.tenant_id=t.id
where t.slug='pickle-street-tugbok';
