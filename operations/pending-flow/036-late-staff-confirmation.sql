-- Late receipt review settles the original booking; it never changes its schedule.
begin;
do $migration$
declare
  original text;
  patched text;
  timing_guard constant text := 'if target_start<=clock_timestamp() or b.starts_at<=clock_timestamp() then raise exception ''booking_started'' using errcode=''22023'';end if;';
begin
  select pg_get_functiondef('public.review_picklestreet_pending_receipt(uuid,uuid,uuid,text,text,uuid)'::regprocedure) into original;
  if (length(original)-length(replace(original,timing_guard,'')))/length(timing_guard) <> 2 then
    raise exception 'Receipt review timing guards changed; inspect before migrating.';
  end if;
  patched := replace(original,timing_guard,
    'if q.request_type=''reschedule_adjustment'' and (target_start<=clock_timestamp() or b.starts_at<=clock_timestamp()) then raise exception ''booking_started'' using errcode=''22023'';end if;');
  patched := replace(patched,'v_note text:=btrim(p_review_note);',
    'v_note text:=case when p_decision=''approve'' then coalesce(nullif(btrim(p_review_note),''''),''Payment receipt reviewed; payment confirmed as received by staff.'') else btrim(p_review_note) end;');
  if patched not like '%coalesce(nullif(btrim(p_review_note)%' then raise exception 'Review note declaration changed.'; end if;
  execute patched;

  select pg_get_functiondef('public.guard_receipt_approval_before_play()'::regprocedure) into original;
  if original not like '%if v_starts_at <= now()%' then raise exception 'Receipt approval guard changed.';end if;
  -- The scoped marker exists only inside the authorized, locked staff transaction.
  -- Public callers and automatic receipt processing retain the existing policy.
  patched := replace(original,'if v_starts_at <= now()',
    'if v_starts_at <= now()
       and not (new.tenant_id = ''f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a''::uuid
         and public.picklestreet_staff_review_authorized(''receipt'',new.id))');
  execute patched;
end;
$migration$;
commit;
