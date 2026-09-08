
do $$
declare b jsonb;j jsonb;r jsonb;k uuid:=extensions.gen_random_uuid();bid uuid;ref text:='9700000000003';
begin
 b:=pg_temp.ps_group_payment_fixture(4);bid:=(b->>'bookingId')::uuid;
 j:=public.begin_picklestreet_receipt_attempt(bid,'upload',k,'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a/receipts/'||bid||'/'||k||'.png',encode(extensions.digest(k::text,'sha256'),'hex'),'gcash',ref);
 perform public.finish_picklestreet_receipt_attempt((j->>'attemptId')::uuid,(j->>'leaseToken')::uuid,p_error_code=>'verifier_unavailable');
 update public.picklestreet_receipt_attempts set payment_reference='1234567890123' where id=(j->>'attemptId')::uuid;
 r:=public.reject_picklestreet_duplicate((j->>'attemptId')::uuid);
 if r->>'rejected'<>'false' then raise exception 'Mismatched OCR must remain pending';end if;
 update public.picklestreet_receipt_attempts set payment_reference=ref where id=(j->>'attemptId')::uuid;
 r:=public.reject_picklestreet_duplicate((j->>'attemptId')::uuid);
 if r->>'rejected'<>'true' then raise exception 'Proven duplicate not rejected: %',r;end if;
 if not exists(select 1 from public.bookings where id=bid and status='cancelled' and payment_status='rejected')
 or exists(select 1 from public.booking_slots where booking_id=bid and status<>'cancelled')
 or not exists(select 1 from public.payment_sessions where booking_id=bid and status='failed')
 or not exists(select 1 from public.receipt_verifications where booking_id=bid and status='rejected') then raise exception 'Duplicate must reject all group slots and payment';end if;
 perform public.reject_picklestreet_duplicate((j->>'attemptId')::uuid);
 if (select count(*) from public.picklestreet_rejection_emails where booking_id=bid)<>1 then raise exception 'Retry queued duplicate emails';end if;
 if not exists(select 1 from public.receipt_verifications where payment_reference=ref and status='auto_approved') then raise exception 'Original payment changed';end if;
 perform set_config('request.jwt.claim.role','anon',true);perform set_config('request.jwt.claims','{"role":"anon"}',true);
 begin
   perform public.reject_picklestreet_duplicate((j->>'attemptId')::uuid);
   raise exception 'Anonymous access accepted';
 exception when insufficient_privilege then null;end;
end;$$;
select 'Duplicate cancellation, all grouped slots, original payment unchanged, idempotent email queue, OCR mismatch pending and service authorization passed' as result;
