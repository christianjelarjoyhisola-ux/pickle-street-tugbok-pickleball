-- Remove the legacy Maya-to-Maya configuration path. Maya remains an enabled
-- source app, but its only destination is the venue's shared GCash receiver.
begin;

do $migration$
declare
  definition text;
  original text;
begin
  select pg_get_functiondef(
    'public.save_picklestreet_payment_settings_unthrottled_20260915(text,text,timestamptz,jsonb)'::regprocedure
  ) into definition;
  original := definition;

  definition := replace(
    definition,
    $old$method->>'methodCode' in('bdo_pay','bdo','bdopay','bpi','gotyme','maribank')$old$,
    $new$method->>'methodCode' in('bdo_pay','bdo','bdopay','maya','bpi','gotyme','maribank')$new$
  );
  definition := replace(
    definition,
    $old$item->>'methodCode' in('bdo_pay','bdo','bdopay','bpi','gotyme','maribank')$old$,
    $new$item->>'methodCode' in('bdo_pay','bdo','bdopay','maya','bpi','gotyme','maribank')$new$
  );
  definition := replace(
    definition,
    $old$ -- Keep a disabled Maya upload target available before its account is configured.
 insert into public.tenant_payment_methods(tenant_id,method_code,display_name,is_active,sort_order)
 values(t,'maya','Maya',false,3) on conflict(tenant_id,method_code) do nothing;
$old$,
    ''
  );

  if definition = original
    or position($old$method->>'methodCode' in('bdo_pay','bdo','bdopay','bpi','gotyme','maribank')$old$ in definition) > 0
    or position($old$item->>'methodCode' in('bdo_pay','bdo','bdopay','bpi','gotyme','maribank')$old$ in definition) > 0
    or position('disabled Maya upload target' in definition) > 0
  then
    raise exception 'Unexpected payment-settings function definition';
  end if;
  execute definition;
end;
$migration$;

update public.tenant_payment_methods maya
set display_name = 'Maya → GCash',
    account_name = gcash.account_name,
    account_reference = gcash.account_reference,
    qr_image_url = null,
    qr_storage_path = null,
    instructions = 'In Maya, use Bank Transfer to GCash. Wait for Completed, enter the Reference ID, and upload the full transaction details screen.',
    is_active = true,
    sort_order = 3,
    updated_at = clock_timestamp()
from public.tenant_payment_methods gcash
where maya.tenant_id = 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'
  and maya.method_code = 'maya'
  and gcash.tenant_id = maya.tenant_id
  and gcash.method_code = 'gcash'
  and gcash.is_active
  and char_length(btrim(coalesce(gcash.account_name, ''))) >= 2
  and char_length(btrim(coalesce(gcash.account_reference, ''))) >= 3;

update public.tenants
set updated_at = clock_timestamp()
where id = 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';

commit;
