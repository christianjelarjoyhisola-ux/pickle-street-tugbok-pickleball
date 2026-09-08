create temp table qr_checks(name text,passed boolean default true);
do $$
declare t constant uuid:='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';actor uuid;g public.tenant_payment_methods%rowtype;patch jsonb;bad jsonb;revision timestamptz;denied boolean;result jsonb;
begin
 select user_id into strict actor from public.platform_profiles where is_platform_owner order by user_id limit 1;
 perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated','iss','https://neqvrwtofiolcuxewdze.supabase.co/auth/v1')::text,true);
 perform set_config('request.jwt.claim.sub',actor::text,true);
 perform set_config('request.jwt.claim.role','authenticated',true);
 perform set_config('request.headers','{"origin":"https://picklestreet.pages.dev"}',true);
 select * into strict g from public.tenant_payment_methods where tenant_id=t and method_code='gcash';
 if g.qr_image_url is null or g.qr_storage_path is null then raise exception 'Expected existing managed QR for regression';end if;
 select jsonb_build_object('paymentMethods',jsonb_agg(jsonb_build_object('methodCode',m.method_code,'displayName',m.display_name,
   'accountName',case when m.method_code in('gcash','bdo_pay','maya','bpi','gotyme','maribank') then g.account_name else m.account_name end,
   'accountNumber',case when m.method_code in('gcash','bdo_pay','maya','bpi','gotyme','maribank') then g.account_reference else m.account_reference end,
   'qrUrl',case when m.method_code in('gcash','bdo_pay','maya','bpi','gotyme','maribank') then g.qr_image_url else m.qr_image_url end,
   'instructions',m.instructions,'isActive',m.is_active,'sortOrder',m.sort_order) order by m.sort_order)) into patch
 from public.tenant_payment_methods m where m.tenant_id=t;
 select updated_at into revision from public.tenants where id=t;
 result:=public.save_picklestreet_payment_settings('pickle-street-tugbok','picklestreet.pages.dev',revision,patch);
 if not exists(select 1 from public.tenant_payment_methods where tenant_id=t and method_code='gcash' and qr_image_url=g.qr_image_url and qr_storage_path=g.qr_storage_path)
  or exists(select 1 from public.tenant_payment_methods where tenant_id=t and method_code in('bdo_pay','maya','bpi','gotyme','maribank') and qr_image_url=g.qr_image_url) then raise exception 'Managed ownership was not preserved';end if;
 insert into qr_checks(name) values('Shared GCash save preserves uploaded QR without copying its asset to other payment sources');
 denied:=false;begin perform public.save_picklestreet_payment_settings('pickle-street-tugbok','picklestreet.pages.dev',revision,patch);exception when sqlstate '40001' then denied:=true;end;
 if not denied then raise exception 'Stale settings save accepted';end if;
 insert into qr_checks(name) values('Stale settings revision remains protected');
 select updated_at into revision from public.tenants where id=t;
 perform public.save_picklestreet_payment_settings('pickle-street-tugbok','picklestreet.pages.dev',revision,patch);
 insert into qr_checks(name) values('Repeated save with latest revision succeeds');
 bad:=jsonb_set(patch,'{paymentMethods}',(select jsonb_agg(case when m->>'methodCode' in('gcash','bdo_pay','maya','bpi','gotyme','maribank') then jsonb_set(m,'{qrUrl}','"https://example.invalid/unmanaged.png"') else m end) from jsonb_array_elements(patch->'paymentMethods') m));
 select updated_at into revision from public.tenants where id=t;
 denied:=false;begin perform public.save_picklestreet_payment_settings('pickle-street-tugbok','picklestreet.pages.dev',revision,bad);exception when sqlstate '22023' then denied:=true;end;
 if not denied then raise exception 'Unmanaged QR accepted';end if;
 insert into qr_checks(name) values('Unmanaged QR replacement remains rejected');
 result:=public.manage_tenant_payment_qr_asset('pickle-street-tugbok','picklestreet.pages.dev','gcash',g.qr_image_url,g.qr_storage_path,null,null,true);
 patch:=jsonb_set(patch,'{paymentMethods}',(select jsonb_agg(case when m->>'methodCode' in('gcash','bdo_pay','maya','bpi','gotyme','maribank') then jsonb_set(m,'{qrUrl}','null') else m end) from jsonb_array_elements(patch->'paymentMethods') m));
 select updated_at into revision from public.tenants where id=t;
 perform public.save_picklestreet_payment_settings('pickle-street-tugbok','picklestreet.pages.dev',revision,patch);
 if exists(select 1 from public.tenant_payment_methods where tenant_id=t and method_code='gcash' and(qr_image_url is not null or qr_storage_path is not null)) then raise exception 'Managed removal did not persist';end if;
 insert into qr_checks(name) values('Managed QR removal followed by settings save succeeds');
 denied:=false;begin perform public.save_picklestreet_payment_settings('another-venue','picklestreet.pages.dev',revision,patch);exception when sqlstate '42501' then denied:=true;end;
 if not denied then raise exception 'Another tenant accepted';end if;
 insert into qr_checks(name) values('Wrong tenant rejected');
end $$;
