begin;

do $test$
declare
  route_definition text;
  approval_definition text;
  duplicate_definition text;
  receiver_snapshot jsonb;
  evidence jsonb;
begin
  select pg_get_functiondef(
    'public.picklestreet_receipt_route_ready(text,jsonb,jsonb)'::regprocedure
  ) into route_definition;
  if position('source = ''bpi''' in route_definition) = 0
    or position('source in (''bdopay'',''bpi'')' in route_definition) > 0
  then
    raise exception 'BDO still depends on private QR identity';
  end if;

  select jsonb_build_object(
    'method', 'bdo_pay',
    'name', account_name,
    'account', account_reference,
    'destinationMethod', 'gcash',
    'verificationSettingsRevision', coalesce((
      select revision from public.picklestreet_receipt_route_settings
      where tenant_id = 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'
    ), 0)
  ) into receiver_snapshot
  from public.tenant_payment_methods
  where tenant_id = 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'
    and method_code = 'gcash';

  evidence := jsonb_build_object(
    'detected', jsonb_build_object('route', jsonb_build_object(
      'schemaVersion', 1,
      'sourceProvider', 'bdopay',
      'routeId', 'bdopay_to_gcash',
      'destinationProvider', 'gcash',
      'destinationMethodCode', 'gcash',
      'parserVersion', 'bdopay_to_gcash_v1',
      'sourceMatched', true,
      'destinationMatched', true,
      'recipientMatched', true,
      'referenceMatched', true,
      'successMatched', true,
      'secondaryReferences', jsonb_build_array(
        jsonb_build_object('kind', 'bdopay_invoice', 'value', '595974')
      )
    )),
    'confidence', jsonb_build_object('vision', 0.99, 'effective', 0.99),
    'timing', jsonb_build_object(
      'allowedWindowMinutes', 15,
      'earlyToleranceMinutes', 2,
      'withinWindow', true
    )
  );
  if not public.picklestreet_receipt_route_ready(
    'bdo_pay', evidence, receiver_snapshot
  ) then
    raise exception 'Native BDO route did not pass without QR identity';
  end if;

  select pg_get_functiondef(
    'public.auto_approve_picklestreet_receipt_route(uuid)'::regprocedure
  ) into approval_definition;
  if position('in(''maya'',''bdopay'')' in approval_definition) = 0
    or position('picklestreet_source_provider(v_payment_method)' in approval_definition) = 0
  then
    raise exception 'BDO typed reference is not required by auto approval';
  end if;

  select pg_get_functiondef(
    'public.reject_picklestreet_duplicate(uuid)'::regprocedure
  ) into duplicate_definition;
  if position('source in(''maya'',''bdopay'')' in duplicate_definition) = 0
    or position('nullif(btrim(a.submitted_reference)' in duplicate_definition) = 0
  then
    raise exception 'BDO typed reference is not required by duplicate checks';
  end if;
end;
$test$;

rollback;
