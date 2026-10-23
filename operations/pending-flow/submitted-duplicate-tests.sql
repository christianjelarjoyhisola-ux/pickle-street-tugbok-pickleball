create temp table submitted_duplicate_results(name text,passed boolean);
do $$
declare original_ref text; j jsonb; b jsonb; k uuid; bid uuid; result jsonb; n integer; submitted text; label text;
begin
 select r.payment_reference into strict original_ref
 from public.picklestreet_receipt_reference_claims c
 join public.receipt_verifications r on r.id=c.verification_id
 join public.payment_sessions ps on ps.id=r.payment_session_id
 where c.tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a' and c.namespace='maya.primary'
   and r.status in('approved','auto_approved') and ps.status='paid'
   and c.reference_hash=encode(extensions.digest(regexp_replace(upper(r.payment_reference),'[^A-Z0-9]','','g'),'sha256'),'hex')
 order by r.created_at desc limit 1;
 for n in 1..6 loop
  b:=pg_temp.ps_group_payment_fixture(n);bid:=(b->>'bookingId')::uuid;k:=extensions.gen_random_uuid();
  submitted:=case when n=4 then 'UNCLAIMED'||replace(k::text,'-','') when n=2 then lower(original_ref) else original_ref end;
  j:=public.begin_picklestreet_receipt_attempt(bid,'upload',k,
    'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a/receipts/'||bid||'/'||k||'.png',
    encode(extensions.digest(k::text,'sha256'),'hex'),case when n=5 then 'gcash' else 'maya' end,submitted);
  perform public.finish_picklestreet_receipt_attempt((j->>'attemptId')::uuid,(j->>'leaseToken')::uuid,p_error_code=>'verifier_unavailable');
  if n=3 then
   update public.picklestreet_receipt_attempts set error_code=null,flags=array['ref_unreadable','amount_unreadable','transfer_pending'],extracted_data='{}' where id=(j->>'attemptId')::uuid;
  end if;
  if n=6 then update public.picklestreet_receipt_attempts set submitted_reference='DIFFERENTREFERENCE' where id=(j->>'attemptId')::uuid;end if;
  result:=public.reject_picklestreet_duplicate((j->>'attemptId')::uuid);
  if (result->>'rejected')::boolean is distinct from (n<=3) then raise exception 'Wrong decision case %: %',n,result;end if;
  if n<=3 then
   if not exists(select 1 from public.bookings where id=bid and status='cancelled' and payment_status='rejected')
     or exists(select 1 from public.booking_slots where booking_id=bid and status<>'cancelled')
     or not exists(select 1 from public.payment_sessions where booking_id=bid and status='failed')
     or not exists(select 1 from public.receipt_verifications where booking_id=bid and status='rejected') then raise exception 'Incomplete rejection';end if;
   result:=public.reject_picklestreet_duplicate((j->>'attemptId')::uuid);
   if result->>'rejected'<>'true' or (select count(*) from public.picklestreet_rejection_emails where booking_id=bid)<>1 then raise exception 'Replay duplicated email';end if;
  elsif not exists(select 1 from public.bookings where id=bid and status='payment_review' and payment_status='pending') then raise exception 'Nonduplicate changed';end if;
  label:=case n when 1 then 'OCR service failure does not hide exact submitted duplicate' when 2 then 'Reference normalization and idempotent rejection' when 3 then 'Unreadable receipt does not hide submitted duplicate' when 4 then 'Unclaimed reference stays pending' when 5 then 'Different provider namespace stays pending' else 'Attempt/session mismatch stays pending' end;
  insert into submitted_duplicate_results values(label,true);
 end loop;
 perform set_config('request.jwt.claim.role','anon',true);perform set_config('request.jwt.claims','{"role":"anon"}',true);
 begin
  perform public.reject_picklestreet_duplicate((j->>'attemptId')::uuid);
  raise exception 'Anonymous rejection accepted';
 exception when insufficient_privilege then null;end;
 insert into submitted_duplicate_results values('Anonymous rejection denied; original bookings unchanged',true);
end $$;
