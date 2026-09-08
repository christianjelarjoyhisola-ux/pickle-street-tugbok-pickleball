begin;
CREATE OR REPLACE FUNCTION public.save_picklestreet_payment_settings(p_tenant_slug text, p_hostname text, p_expected_revision timestamp with time zone, p_patch jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET row_security TO 'off'
AS $function$
declare t constant uuid:='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';current_revision timestamptz;
 s public.picklestreet_receipt_route_settings%rowtype;v jsonb;downstream jsonb;method jsonb;gcash jsonb;
begin
 if auth.uid() is null or public.resolve_tenant_id(p_tenant_slug,p_hostname) is distinct from t
   or not(public.is_platform_owner() or public.has_tenant_role(t,array['owner','admin'])) then
   raise exception 'TENANT_ACCESS_DENIED' using errcode='42501';end if;
 if p_patch is null or jsonb_typeof(p_patch)<>'object' or p_patch='{}'::jsonb or exists(
   select 1 from jsonb_object_keys(p_patch) k where k not in('venue','paymentMethods','receiptVerification','receiptVerificationRevision')) then
   raise exception 'PAYMENT_SETTINGS_INVALID' using errcode='22023';end if;
 select updated_at into current_revision from public.tenants where id=t for update;
 if p_expected_revision is null or current_revision is distinct from p_expected_revision then
   raise exception 'BUSINESS_SETTINGS_STALE' using errcode='40001';end if;
 select * into s from public.picklestreet_receipt_route_settings where tenant_id=t for update;
 if p_patch ? 'receiptVerification' then
   v:=p_patch->'receiptVerification';
   if jsonb_typeof(v) is distinct from 'object' or not(v ?& array['gcashQrAlias','gcashQrToken'])
     or exists(select 1 from jsonb_object_keys(v) k where k not in('gcashQrAlias','gcashQrToken'))
     or jsonb_typeof(v->'gcashQrAlias') is distinct from 'string' or jsonb_typeof(v->'gcashQrToken') is distinct from 'string'
     or char_length(btrim(v->>'gcashQrAlias'))>120 or char_length(btrim(v->>'gcashQrToken'))>512
     or (v->>'gcashQrAlias') ~ '[[:cntrl:]]' or (v->>'gcashQrToken') ~ '[[:cntrl:]]'
     or jsonb_typeof(p_patch->'receiptVerificationRevision') is distinct from 'number'
     or (p_patch->>'receiptVerificationRevision')::numeric<>trunc((p_patch->>'receiptVerificationRevision')::numeric) then
     raise exception 'RECEIPT_SETTINGS_INVALID' using errcode='22023';end if;
   if (p_patch->>'receiptVerificationRevision')::numeric<>coalesce(s.revision,0) then
     raise exception 'RECEIPT_SETTINGS_STALE' using errcode='40001';end if;
 elsif p_patch ? 'receiptVerificationRevision' then raise exception 'RECEIPT_SETTINGS_INVALID' using errcode='22023';end if;
 if p_patch ? 'paymentMethods' then
   if jsonb_typeof(p_patch->'paymentMethods') is distinct from 'array' then raise exception 'PAYMENT_SETTINGS_INVALID' using errcode='22023';end if;
   select value into gcash from jsonb_array_elements(p_patch->'paymentMethods') where value->>'methodCode'='gcash';
   for method in select value from jsonb_array_elements(p_patch->'paymentMethods') loop
     if method->>'methodCode' not in('gcash','bdo_pay','bdo','bdopay','maya','bpi','gotyme','maribank','pnb','cash') then
       raise exception 'PAYMENT_METHOD_UNSUPPORTED' using errcode='22023';end if;
     if method->>'methodCode'='cash' and coalesce((method->>'isActive')::boolean,false) then
       raise exception 'CASH_PUBLIC_CHECKOUT_UNAVAILABLE' using errcode='22023';end if;
     if method->>'methodCode' in('bdo_pay','bdo','bdopay','maya','bpi','gotyme','maribank') then
       if gcash is null or btrim(method->>'accountName') is distinct from btrim(gcash->>'accountName')
         or btrim(method->>'accountNumber') is distinct from btrim(gcash->>'accountNumber')
         or nullif(btrim(method->>'qrUrl'),'') is distinct from nullif(btrim(gcash->>'qrUrl'),'') then
         raise exception 'GCASH_DESTINATION_MISMATCH' using errcode='22023';end if;
     end if;
   end loop;
 end if;
 downstream:=p_patch-'receiptVerification'-'receiptVerificationRevision';
 if downstream<>'{}'::jsonb then
   perform public.update_tenant_business_settings_if_current(p_tenant_slug,p_hostname,p_expected_revision,downstream);
 else
   update public.tenants set updated_at=clock_timestamp() where id=t;
 end if;
 if v is not null then
   insert into public.picklestreet_receipt_route_settings(tenant_id,gcash_qr_alias,gcash_qr_token,revision,updated_by)
   values(t,btrim(v->>'gcashQrAlias'),btrim(v->>'gcashQrToken'),1,auth.uid())
   on conflict(tenant_id) do update set gcash_qr_alias=excluded.gcash_qr_alias,gcash_qr_token=excluded.gcash_qr_token,
     revision=picklestreet_receipt_route_settings.revision+1,updated_at=clock_timestamp(),updated_by=auth.uid();
 end if;
 return public.get_picklestreet_payment_settings(p_tenant_slug,p_hostname);
end;$function$
;
commit;
