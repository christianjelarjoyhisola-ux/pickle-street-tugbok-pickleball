-- Run after the existing group hold/payment rollback fixtures, inside ROLLBACK.
-- Synthetic bookings and OCR only; no receipt upload, email or persistent write.
set local request.jwt.claim.role='service_role';
set local request.jwt.claims='{"role":"service_role"}';
create temporary table ps_duplicate_identity_results(name text primary key,passed boolean not null);

create function pg_temp.ps_identity_snapshot(method text) returns jsonb language sql as $$
 select jsonb_build_object('method',method,'name',m.account_name,'account',m.account_reference,'destinationMethod','gcash',
   'verificationSettingsRevision',coalesce((select revision from public.picklestreet_receipt_route_settings where tenant_id=m.tenant_id),0))
 from public.tenant_payment_methods m where m.tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a' and m.method_code='gcash';
$$;
create function pg_temp.ps_identity_begin(n integer,method text,ref text) returns jsonb language plpgsql as $$
declare b jsonb;k uuid:=extensions.gen_random_uuid();j jsonb;
begin
 b:=pg_temp.ps_group_payment_fixture(n);
 j:=public.begin_picklestreet_receipt_attempt((b->>'bookingId')::uuid,'upload',k,
   'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a/receipts/'||(b->>'bookingId')||'/'||k::text||'.png',
   encode(extensions.digest(k::text,'sha256'),'hex'),method,ref);
 return j||jsonb_build_object('testBookingId',b->>'bookingId');
end;$$;
create function pg_temp.ps_identity_data(j jsonb,secondary text default null) returns jsonb language sql as $$
 select jsonb_build_object('schemaVersion',2,'provider','google_vision','feature','DOCUMENT_TEXT_DETECTION','ocrCharacterCount',180,
   'file',jsonb_build_object('mimeType','image/png','sizeBytes',300),
   'detected',jsonb_build_object('paymentReference',j->>'submittedReference','route',jsonb_build_object(
     'schemaVersion',1,'routeId',public.picklestreet_source_provider(j->>'paymentMethod')||'_to_gcash','sourceProvider',public.picklestreet_source_provider(j->>'paymentMethod'),
     'destinationProvider','gcash','destinationMethodCode','gcash','parserVersion',case when j->>'paymentMethod'='gcash' then 'gcash_v1' else public.picklestreet_source_provider(j->>'paymentMethod')||'_to_gcash_v1' end,
     'sourceMatched',true,'destinationMatched',true,'recipientMatched',true,'referenceMatched',true,'successMatched',true,
     'secondaryReferences',case when j->>'paymentMethod'='gcash' then '[]'::jsonb else jsonb_build_array(jsonb_build_object('kind',case
       when public.picklestreet_source_provider(j->>'paymentMethod')='maya' then 'maya_instapay'
       when public.picklestreet_source_provider(j->>'paymentMethod')='bdopay' then 'bdopay_invoice'
       when public.picklestreet_source_provider(j->>'paymentMethod')='bpi' then 'bpi_transaction' else 'instapay' end,'value',secondary)) end)),
   'comparison',jsonb_build_object('currency','PHP','expectedAmount',(j->>'expectedAmount')::numeric,'amountMatched',true),
   'timing',jsonb_build_object('bookingStartedAt',j->>'bookingStartedAt','tenantTimezone','Asia/Manila',
     'receiptDate',to_char((j->>'bookingStartedAt')::timestamptz at time zone 'Asia/Manila','YYYY-MM-DD'),
     'receiptTime',to_char((j->>'bookingStartedAt')::timestamptz at time zone 'Asia/Manila','HH24:MI'),
     'receiptDateTime',date_trunc('minute',(j->>'bookingStartedAt')::timestamptz),'withinWindow',true,'allowedWindowMinutes',15,'earlyToleranceMinutes',2),
   'confidence',jsonb_build_object('vision',0.99,'effective',0.99,'evidence',1,'source','google_vision_plus_evidence'));
$$;
create function pg_temp.ps_identity_finish(j jsonb,d jsonb,approve boolean default false) returns jsonb language plpgsql as $$
begin
 return public.finish_picklestreet_receipt_attempt((j->>'attemptId')::uuid,(j->>'leaseToken')::uuid,d,
   case when approve then array['auto_approval_eligible'] else array['duplicate_test_pending'] end,
   j->>'submittedReference',0.99,approve,null,pg_temp.ps_identity_snapshot(j->>'paymentMethod'));
end;$$;
create function pg_temp.ps_identity_pending(j jsonb,label text) returns void language plpgsql as $$
declare result jsonb;
begin
 result:=public.reject_picklestreet_duplicate((j->>'attemptId')::uuid);
 if result->>'rejected'<>'false'
   or exists(select 1 from public.bookings where id=(j->>'testBookingId')::uuid and status='cancelled')
   or exists(select 1 from public.picklestreet_rejection_emails where booking_id=(j->>'testBookingId')::uuid)
 then raise exception 'Must remain pending without cancellation/email (%): %',label,result;end if;
 insert into ps_duplicate_identity_results values(label,true);
end;$$;
create function pg_temp.ps_identity_rejected(j jsonb,label text) returns void language plpgsql as $$
declare result jsonb;bid uuid:=(j->>'testBookingId')::uuid;
begin
 result:=public.reject_picklestreet_duplicate((j->>'attemptId')::uuid);
 if result->>'rejected'<>'true'
   or not exists(select 1 from public.bookings where id=bid and status='cancelled' and payment_status='rejected')
   or (select count(*) from public.booking_slots where booking_id=bid and status='cancelled')<>3
   or exists(select 1 from public.booking_slots where booking_id=bid and status<>'cancelled')
   or not exists(select 1 from public.payment_sessions where booking_id=bid and status='failed')
   or not exists(select 1 from public.receipt_verifications where booking_id=bid and status='rejected')
 then raise exception 'Proven duplicate must cancel entire group (%): %',label,result;end if;
 perform public.reject_picklestreet_duplicate((j->>'attemptId')::uuid);
 if (select count(*) from public.picklestreet_rejection_emails where booking_id=bid)<>1 then raise exception 'Retry duplicated email queue';end if;
 insert into ps_duplicate_identity_results values(label,true);
end;$$;

do $$
declare j jsonb;d jsonb;original jsonb;r jsonb;ref text:='9700000000003';fingerprint text;current_fingerprint text;path text[];n integer:=4;
begin
 select md5(to_jsonb(v)::text) into fingerprint from public.receipt_verifications v where v.payment_reference=ref and v.status='auto_approved';
 if fingerprint is null then raise exception 'Accepted GCash fixture missing';end if;

 j:=pg_temp.ps_identity_begin(n,'maya',ref);n:=n+1;
 perform pg_temp.ps_identity_finish(j,pg_temp.ps_identity_data(j,'UNIQUEINSTAPAYIDENTITY001'));
 perform pg_temp.ps_identity_pending(j,'Identical primary digits from a different provider remain pending');

 j:=pg_temp.ps_identity_begin(n,'gcash',ref);n:=n+1;d:=pg_temp.ps_identity_data(j);
 perform pg_temp.ps_identity_finish(j,d);
 update public.picklestreet_receipt_attempts set payment_reference='1234567890123' where id=(j->>'attemptId')::uuid;
 perform pg_temp.ps_identity_pending(j,'OCR and submitted primary mismatch remain pending');
 update public.picklestreet_receipt_attempts set payment_reference=ref where id=(j->>'attemptId')::uuid;
 foreach path slice 1 in array array[array['detected','route','recipientMatched'],array['detected','route','destinationMatched'],array['detected','route','sourceMatched'],array['detected','route','referenceMatched'],array['detected','route','successMatched']] loop
   update public.picklestreet_receipt_attempts set extracted_data=jsonb_set(d,path,'false') where id=(j->>'attemptId')::uuid;
   perform pg_temp.ps_identity_pending(j,'Uncertain identity remains pending: '||path[3]);
 end loop;
 update public.picklestreet_receipt_attempts set extracted_data=jsonb_set(d,'{confidence,vision}','0.75') where id=(j->>'attemptId')::uuid;
 perform pg_temp.ps_identity_pending(j,'Low-confidence OCR remains pending');
 update public.picklestreet_receipt_attempts set extracted_data=jsonb_set(d,'{confidence,vision}','"unreadable"') where id=(j->>'attemptId')::uuid;
 perform pg_temp.ps_identity_pending(j,'Malformed confidence remains pending without a database error');
 update public.picklestreet_receipt_attempts set extracted_data='{}' where id=(j->>'attemptId')::uuid;
 perform pg_temp.ps_identity_pending(j,'Missing parser evidence remains pending');
 update public.picklestreet_receipt_attempts set extracted_data=d where id=(j->>'attemptId')::uuid;
 perform pg_temp.ps_identity_rejected(j,'Proven same-provider primary duplicate cancels all slots and queues exactly one email');

 original:=pg_temp.ps_identity_begin(n,'gotyme','GTIDENTITYORIGINAL01');n:=n+1;
 r:=pg_temp.ps_identity_finish(original,pg_temp.ps_identity_data(original,'SHAREDINSTAPAYIDENTITY001'),true);
 if not exists(select 1 from public.receipt_verifications where id=(original->>'verificationId')::uuid and status='auto_approved')
 then raise exception 'Synthetic GoTyme reference owner not accepted: %',r;end if;
 j:=pg_temp.ps_identity_begin(n,'maya','MAYAIDENTITYREUSE001');n:=n+1;d:=pg_temp.ps_identity_data(j,'SHAREDINSTAPAYIDENTITY001');
 perform pg_temp.ps_identity_finish(j,d);
 update public.picklestreet_receipt_attempts set extracted_data=jsonb_set(d,'{detected,route,secondaryReferences,0,kind}','"bdopay_invoice"') where id=(j->>'attemptId')::uuid;
 perform pg_temp.ps_identity_pending(j,'Secondary reference kind must match the selected payment route');
 update public.picklestreet_receipt_attempts set extracted_data=d where id=(j->>'attemptId')::uuid;
 perform pg_temp.ps_identity_rejected(j,'Shared InstaPay duplicate with different primary/provider cancels the entire new booking');

 j:=pg_temp.ps_identity_begin(n,'bdo_pay','BDOIDENTITYUNIQUE01');n:=n+1;
 perform pg_temp.ps_identity_finish(j,pg_temp.ps_identity_data(j,'SHAREDINSTAPAYIDENTITY001'));
 perform pg_temp.ps_identity_pending(j,'Same secondary value in another namespace is not a duplicate');

 j:=pg_temp.ps_identity_begin(n,'gcash','9700000000999');n:=n+1;
 perform pg_temp.ps_identity_finish(j,pg_temp.ps_identity_data(j));
 original:=pg_temp.ps_identity_begin(n,'gcash','9700000000999');n:=n+1;
 perform pg_temp.ps_identity_finish(original,pg_temp.ps_identity_data(original));
 perform pg_temp.ps_identity_pending(original,'An unaccepted payment never owns a duplicate reference');
 perform pg_temp.ps_identity_pending(j,'A same-booking retry does not reject itself');

 select md5(to_jsonb(v)::text) into current_fingerprint from public.receipt_verifications v where v.payment_reference=ref and v.status='auto_approved';
 if fingerprint is distinct from current_fingerprint then raise exception 'Original accepted payment was changed';end if;
 insert into ps_duplicate_identity_results values('Original accepted payment is unchanged',true);
 perform set_config('request.jwt.claim.role','anon',true);perform set_config('request.jwt.claims','{"role":"anon"}',true);
 begin perform public.reject_picklestreet_duplicate((j->>'attemptId')::uuid);raise exception 'Anonymous access accepted';
 exception when insufficient_privilege then null;end;
 insert into ps_duplicate_identity_results values('Service authorization is required',true);
end;$$;
select * from ps_duplicate_identity_results order by name;
