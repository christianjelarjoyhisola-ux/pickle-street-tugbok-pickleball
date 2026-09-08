create temp table qr_checks(name text,passed boolean default true);
do $$
declare t constant uuid:='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';actor uuid;g public.tenant_payment_methods%rowtype;patch jsonb;revision timestamptz;denied boolean;
begin
 select user_id into strict actor from public.platform_profiles where is_platform_owner order by user_id limit 1;
 perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated','iss','https://neqvrwtofiolcuxewdze.supabase.co/auth/v1')::text,true);
 perform set_config('request.jwt.claim.sub',actor::text,true);
 perform set_config('request.jwt.claim.role','authenticated',true);
 perform set_config('request.headers','{"origin":"https://picklestreet.pages.dev"}',true);
 select * into strict g from public.tenant_payment_methods where tenant_id=t and method_code='gcash';
 select jsonb_build_object('paymentMethods',jsonb_agg(jsonb_build_object('methodCode',m.method_code,'displayName',m.display_name,
   'accountName',case when m.method_code='maya' then 'NATIVE MAYA TEST RECEIVER' when m.method_code in('bdo_pay','bpi','gotyme','maribank') then g.account_name else m.account_name end,
   'accountNumber',case when m.method_code='maya' then '09990000001' when m.method_code in('bdo_pay','bpi','gotyme','maribank') then g.account_reference else m.account_reference end,
   'qrUrl',case when m.method_code in('gcash','bdo_pay','bpi','gotyme','maribank') then g.qr_image_url else m.qr_image_url end,
   'instructions',case when m.method_code='maya' then 'Pay Maya to Maya' else m.instructions end,
   'isActive',case when m.method_code='maya' then true else m.is_active end,'sortOrder',m.sort_order) order by m.sort_order)) into patch
 from public.tenant_payment_methods m where m.tenant_id=t;
 select updated_at into revision from public.tenants where id=t;
 perform public.save_picklestreet_payment_settings('pickle-street-tugbok','picklestreet.pages.dev',revision,patch);
 if not exists(select 1 from public.tenant_payment_methods where tenant_id=t and method_code='maya' and account_name='NATIVE MAYA TEST RECEIVER' and account_reference='09990000001' and is_active and qr_image_url is null) then raise exception 'Maya independence failed';end if;
 if not exists(select 1 from public.tenant_payment_methods where tenant_id=t and method_code='gcash' and account_name=g.account_name and account_reference=g.account_reference and qr_image_url=g.qr_image_url and qr_storage_path=g.qr_storage_path) then raise exception 'GCash modified';end if;
 insert into qr_checks(name) values('Independent Maya account saves without inheriting GCash identity or QR');
 select updated_at into revision from public.tenants where id=t;
 perform public.save_picklestreet_payment_settings('pickle-street-tugbok','picklestreet.pages.dev',revision,patch);
 insert into qr_checks(name) values('Repeated native Maya settings save succeeds');
 if public.picklestreet_receipt_route_ready('maya','{}','{}') then raise exception 'Unvalidated native Maya auto approval enabled';end if;
 insert into qr_checks(name) values('Old Maya-to-GCash approval gate is disabled for native Maya');
 patch:=jsonb_set(patch,'{paymentMethods}',(select jsonb_agg(m) from jsonb_array_elements(patch->'paymentMethods') m where m->>'methodCode'<>'maya'));
 select updated_at into revision from public.tenants where id=t;
 perform public.save_picklestreet_payment_settings('pickle-street-tugbok','picklestreet.pages.dev',revision,patch);
 if not exists(select 1 from public.tenant_payment_methods where tenant_id=t and method_code='maya' and not is_active and account_name is null and account_reference is null) then raise exception 'Missing Maya draft QR upload target';end if;
 insert into qr_checks(name) values('Unconfigured Maya retains a disabled target for its own QR upload');
 denied:=false;begin perform public.save_picklestreet_payment_settings('another-venue','picklestreet.pages.dev',revision,patch);exception when sqlstate '42501' then denied:=true;end;
 if not denied then raise exception 'Wrong tenant allowed';end if;
 insert into qr_checks(name) values('Wrong tenant rejected');
end $$;
