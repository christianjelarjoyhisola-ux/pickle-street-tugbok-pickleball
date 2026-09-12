-- Relabel earlier completed System Owner approvals as Auto Verified.
-- The immutable staff-review ledger is the sole source used to select rows.

begin;

-- This is a label correction on an already-approved payment, not a new
-- post-play approval. Permit only an exact, evidence-backed relabel whose
-- other immutable receipt fields remain unchanged.
create or replace function public.picklestreet_system_owner_auto_relabel_allowed(
  p_old public.receipt_verifications,
  p_new public.receipt_verifications
)
returns boolean
language sql
stable
security definer
set search_path to ''
set row_security to 'off'
as $function$
  select p_old.tenant_id = 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid
    and p_new.tenant_id = p_old.tenant_id
    and p_old.status = 'approved'
    and p_new.status = 'auto_approved'
    and p_new.reviewed_by is not null
    and p_new.reviewed_by is not distinct from p_old.reviewed_by
    and (to_jsonb(p_new) - 'status' - 'extracted_data')
      = (to_jsonb(p_old) - 'status' - 'extracted_data')
    and exists (
      select 1
      from public.picklestreet_receipt_staff_reviews review
      join public.platform_profiles profile
        on profile.user_id = review.actor_user_id
       and profile.is_platform_owner
      where review.tenant_id = p_old.tenant_id
        and review.verification_id = p_old.id
        and review.actor_user_id = p_old.reviewed_by
        and review.decision = 'approve'
        and review.completed_at is not null
        and p_new.extracted_data = p_old.extracted_data || jsonb_build_object(
          'systemOwnerBackfill',
          jsonb_build_object(
            'source', 'completed_staff_review_ledger',
            'originallyConfirmedAt', review.completed_at
          )
        )
    );
$function$;

revoke all on function public.picklestreet_system_owner_auto_relabel_allowed(
  public.receipt_verifications,
  public.receipt_verifications
) from public, anon, authenticated, service_role;

do $guard_patch$
declare
  function_name text;
  function_oid regprocedure;
  original_definition text;
  patched_definition text;
begin
  foreach function_name in array array[
    'guard_receipt_approval_before_play',
    'guard_picklestreet_receipt_state',
    'guard_picklestreet_balance_receipt_state'
  ] loop
    function_oid := to_regprocedure('public.' || function_name || '()');
    if function_oid is null then
      raise exception 'Required receipt guard % was not found.', function_name
        using errcode = '42883';
    end if;
    select pg_get_functiondef(function_oid) into original_definition;
    original_definition := replace(original_definition, E'\r\n', E'\n');
    patched_definition := replace(
      original_definition,
      E'begin\n',
      E'begin\n  if tg_op = ''UPDATE''\n     and public.picklestreet_system_owner_auto_relabel_allowed(old, new) then\n    return new;\n  end if;\n'
    );
    if patched_definition = original_definition then
      raise exception 'Receipt guard % changed; migration stopped safely.', function_name
        using errcode = '22023';
    end if;
    execute patched_definition;
  end loop;
end;
$guard_patch$;

do $migration$
declare
  t constant uuid := 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';
  candidate record;
  changed integer := 0;
begin
  for candidate in
    select receipt.id, review.authorization_token, review.completed_at
    from public.picklestreet_receipt_staff_reviews review
    join public.platform_profiles profile
      on profile.user_id = review.actor_user_id
     and profile.is_platform_owner
    join public.receipt_verifications receipt
      on receipt.tenant_id = review.tenant_id
     and receipt.id = review.verification_id
    where review.tenant_id = t
      and review.decision = 'approve'
      and review.completed_at is not null
      and receipt.status = 'approved'
    order by review.completed_at, receipt.id
    for update of receipt
  loop
    perform set_config(
      'app.picklestreet_staff_review',
      candidate.authorization_token::text,
      true
    );
    update public.receipt_verifications
       set status = 'auto_approved',
           extracted_data = extracted_data || jsonb_build_object(
             'systemOwnerBackfill',
             jsonb_build_object(
               'source', 'completed_staff_review_ledger',
               'originallyConfirmedAt', candidate.completed_at
             )
           )
     where tenant_id = t
       and id = candidate.id
       and status = 'approved';
    changed := changed + 1;
  end loop;
  perform set_config('app.picklestreet_staff_review', '', true);
  raise notice 'Backfilled % System Owner payment confirmations.', changed;
end;
$migration$;

commit;
