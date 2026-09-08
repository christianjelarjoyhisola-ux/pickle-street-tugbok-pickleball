-- Extend the identity suite with explicit secondary-parser uncertainty flags.
set local request.jwt.claim.role='service_role';
set local request.jwt.claims='{"role":"service_role"}';
do $$
declare j jsonb;d jsonb;original_flags text[];label text;
begin
 j:=pg_temp.ps_identity_begin(20,'maya','MAYASECONDARYUNCERTAIN001');
 d:=pg_temp.ps_identity_data(j,'SHAREDINSTAPAYIDENTITY001');
 perform pg_temp.ps_identity_finish(j,d);
 select flags into original_flags from public.picklestreet_receipt_attempts where id=(j->>'attemptId')::uuid;
 foreach label in array array['INSTAPAY_REF_UNREADABLE','AMBIGUOUS_INSTAPAY_REFERENCE','secondary_reference_unverified','INVOICE_UNREADABLE','receipt_parser_unavailable'] loop
   update public.picklestreet_receipt_attempts set flags=original_flags||array[label] where id=(j->>'attemptId')::uuid;
   perform pg_temp.ps_identity_pending(j,'Explicit parser uncertainty remains pending: '||label);
 end loop;
 update public.picklestreet_receipt_attempts set flags=original_flags,error_code='verifier_unavailable' where id=(j->>'attemptId')::uuid;
 perform pg_temp.ps_identity_pending(j,'Verifier failure cannot trigger duplicate cancellation');
 update public.picklestreet_receipt_attempts set error_code=null where id=(j->>'attemptId')::uuid;
 perform pg_temp.ps_identity_rejected(j,'Proven secondary duplicate still cancels after uncertainty is resolved');
end;$$;
