-- Keep the already-published dashboard compatible while storing the truthful
-- Auto Verified status. Older clients expect `receiptStatus = approved` from a
-- successful owner review, then reload the authoritative stored status.

begin;

do $migration$
declare
  function_oid regprocedure := to_regprocedure(
    'public.review_picklestreet_pending_receipt(uuid,uuid,uuid,text,text,uuid)'
  );
  original_definition text;
  patched_definition text;
begin
  if function_oid is null then
    raise exception 'Required pending-receipt review function was not found.'
      using errcode = '42883';
  end if;

  select pg_get_functiondef(function_oid)
    into original_definition;
  if original_definition not like '%system_owner boolean:=false%'
     or original_definition not like '%case when system_owner then ''auto_approved'' else ''approved'' end%' then
    raise exception 'System Owner auto-verification must be installed first.'
      using errcode = '22023';
  end if;

  patched_definition := replace(
    original_definition,
    E'''status'',r.status,''receiptStatus'',r.status,''verificationId''',
    E'''status'',r.status,''receiptStatus'',case when system_owner and p_decision=''approve'' then ''approved'' else r.status end,''storedReceiptStatus'',r.status,''verificationId'''
  );
  if patched_definition = original_definition then
    raise exception 'Pending-receipt result shape has changed; migration stopped safely.'
      using errcode = '22023';
  end if;

  execute patched_definition;
end;
$migration$;

commit;
