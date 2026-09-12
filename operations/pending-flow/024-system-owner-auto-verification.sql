-- A payment confirmation made by the System Owner is recorded as Auto Verified.
-- Court-owner and staff confirmations remain ordinary reviewed approvals.

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
  patched_definition := replace(
    original_definition,
    'authorized boolean:=false;zone text;',
    'authorized boolean:=false;system_owner boolean:=false;zone text;'
  );
  if patched_definition = original_definition then
    raise exception 'Pending-receipt reviewer declaration has changed; migration stopped safely.'
      using errcode = '22023';
  end if;

  original_definition := patched_definition;
  patched_definition := replace(
    original_definition,
    E'perform 1 from public.platform_profiles where user_id=p_actor_user_id and is_platform_owner for share;\n authorized:=authorized or found;',
    E'perform 1 from public.platform_profiles where user_id=p_actor_user_id and is_platform_owner for share;\n system_owner:=found;\n authorized:=authorized or system_owner;'
  );
  if patched_definition = original_definition then
    raise exception 'System Owner authorization lookup has changed; migration stopped safely.'
      using errcode = '22023';
  end if;

  original_definition := patched_definition;
  patched_definition := replace(
    original_definition,
    E'update public.receipt_verifications set status=''approved'',reviewed_at=now(),reviewed_by=p_actor_user_id,\n     extracted_data=',
    E'update public.receipt_verifications set status=case when system_owner then ''auto_approved'' else ''approved'' end,reviewed_at=now(),reviewed_by=p_actor_user_id,\n     extracted_data='
  );
  if patched_definition = original_definition then
    raise exception 'Pending-receipt approval update has changed; migration stopped safely.'
      using errcode = '22023';
  end if;

  execute patched_definition;
end;
$migration$;

commit;
