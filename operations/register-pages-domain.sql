-- This transaction changes only Pickle Street's own domain routing.
begin isolation level repeatable read;
do $$
begin
  if not exists (select 1 from public.tenants where id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a' and slug='pickle-street-tugbok') then
    raise exception 'Pickle Street identity mismatch';
  end if;
end $$;
select id from public.tenants where id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a' for update;
create temporary table ps_pages_baseline on commit drop as
select 'tenants' as table_name, md5(coalesce(jsonb_agg(to_jsonb(t) order by t.id)::text,'[]')) as digest from public.tenants t
union all select 'tenant_domains', md5(coalesce(jsonb_agg(to_jsonb(t) order by t.id)::text,'[]')) from public.tenant_domains t where tenant_id<>'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'
union all select 'courts', md5(coalesce(jsonb_agg(to_jsonb(t) order by t.id)::text,'[]')) from public.courts t;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
set local role service_role;
select public.provision_tenant_domain('domain-provision-pickle-street-pages-20260907-v1','f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a','picklestreet.pages.dev',false);
reset role;
-- Only the two explicitly known domains are eligible for this primary switch.
do $$
begin
  if exists(select 1 from public.tenant_domains where tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a' and is_primary and is_active and hostname not in ('picklestreet.pages.dev','pickle-street-tugbok.boothsandbeyondoffic.chatgpt.site')) then
    raise exception 'Unexpected Pickle Street primary domain';
  end if;
end $$;
update public.tenant_domains set is_primary=false where tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a' and hostname='pickle-street-tugbok.boothsandbeyondoffic.chatgpt.site' and is_primary;
update public.tenant_domains set is_primary=true where tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a' and hostname='picklestreet.pages.dev' and is_active and not is_primary;
do $$
declare current_digest text;
begin
  if not exists(select 1 from public.tenant_domains where tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a' and hostname='picklestreet.pages.dev' and is_active and is_primary) then raise exception 'Pages routing is not ready'; end if;
  select md5(coalesce(jsonb_agg(to_jsonb(t) order by t.id)::text,'[]')) into current_digest from public.tenants t;
  if current_digest<>(select digest from ps_pages_baseline where table_name='tenants') then raise exception 'Tenant identity changed'; end if;
  select md5(coalesce(jsonb_agg(to_jsonb(t) order by t.id)::text,'[]')) into current_digest from public.tenant_domains t where tenant_id<>'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';
  if current_digest<>(select digest from ps_pages_baseline where table_name='tenant_domains') then raise exception 'Other tenant routing changed'; end if;
  select md5(coalesce(jsonb_agg(to_jsonb(t) order by t.id)::text,'[]')) into current_digest from public.courts t;
  if current_digest<>(select digest from ps_pages_baseline where table_name='courts') then raise exception 'Court data changed'; end if;
end $$;
commit;
select hostname,is_active,is_primary from public.tenant_domains where tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a' order by hostname;
