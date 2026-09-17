-- Enable native BDO Pay -> GCash receipts without requiring private QR
-- identity. BDO's visible To name and full GCash number are checked against
-- the configured venue receiver. The customer-entered BDO reference remains
-- mandatory and both the reference and invoice are claimed against reuse.

begin;

do $migration$
declare
  definition text;
  original text;
begin
  select pg_get_functiondef(
    'public.picklestreet_receipt_route_ready(text,jsonb,jsonb)'::regprocedure
  ) into definition;
  original := definition;
  definition := replace(
    definition,
    $old$source in ('bdopay','bpi')$old$,
    $new$source = 'bpi'$new$
  );
  if definition = original
    or position($old$source in ('bdopay','bpi')$old$ in definition) > 0
    or position($new$source = 'bpi'$new$ in definition) = 0
  then
    raise exception 'Unexpected receipt route readiness definition';
  end if;
  execute definition;

  select pg_get_functiondef(
    'public.auto_approve_picklestreet_receipt_route(uuid)'::regprocedure
  ) into definition;
  original := definition;
  definition := replace(
    definition,
    $old$(v_payment_method='maya' and nullif(v_submitted_reference,'') is null)$old$,
    $new$(public.picklestreet_source_provider(v_payment_method) in('maya','bdopay') and nullif(v_submitted_reference,'') is null)$new$
  );
  if definition = original
    or position($new$public.picklestreet_source_provider(v_payment_method) in('maya','bdopay')$new$ in definition) = 0
  then
    raise exception 'Unexpected route auto-approval reference definition';
  end if;
  execute definition;

  select pg_get_functiondef(
    'public.reject_picklestreet_duplicate(uuid)'::regprocedure
  ) into definition;
  original := definition;
  definition := replace(
    definition,
    $old$(source='maya' and nullif(btrim(a.submitted_reference),'') is null)$old$,
    $new$(source in('maya','bdopay') and nullif(btrim(a.submitted_reference),'') is null)$new$
  );
  if definition = original
    or position($new$source in('maya','bdopay')$new$ in definition) = 0
  then
    raise exception 'Unexpected duplicate-rejection reference definition';
  end if;
  execute definition;
end;
$migration$;

update public.tenant_payment_methods
set instructions = 'Use BDO Pay Send Money to the shown GCash account. Enter the BDO Reference no. (BN-YYYYMMDD-########), not the invoice number, and upload the complete Sent receipt. The recipient, amount, time, reference and invoice must match; each reference and invoice can be used only once.',
    updated_at = clock_timestamp()
where tenant_id = 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'
  and method_code = 'bdo_pay';

update public.tenants
set updated_at = clock_timestamp()
where id = 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';

commit;
