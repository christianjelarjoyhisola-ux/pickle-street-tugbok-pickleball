-- Append after 013 (without COMMIT), group-hold-rollback-tests.sql and group-payment-rollback-tests.sql, then ROLLBACK.
-- Synthetic isolated courts, no storage/email/network side effects.
set local request.jwt.claim.role='service_role';
set local request.jwt.claims='{"role":"service_role"}';
create temporary table ps_group_reschedule_results(name text primary key,passed boolean not null default true);

create function pg_temp.gr_fixture(n integer) returns uuid language plpgsql as $$
declare f ps_hold_fixture%rowtype;c uuid:=extensions.gen_random_uuid();cfirst uuid:=extensions.gen_random_uuid();seed jsonb;cols text;key uuid:=extensions.gen_random_uuid();
 hash text;s timestamptz;sessions jsonb;one jsonb;two jsonb;r jsonb;j jsonb;actor uuid;policy public.settings%rowtype;fee numeric;
begin
 select * into strict f from ps_hold_fixture;s:=f.starts_at+make_interval(days=>n+10);hash:=encode(extensions.digest(key::text,'sha256'),'hex');
 select to_jsonb(court)||jsonb_build_object('id',c,'slug','test-gr-'||c,'name','TEST ONLY grouped reschedule court '||n) into seed from public.courts court where id=f.court_id;
 select string_agg(quote_ident(attname),',' order by attnum) into cols from pg_attribute where attrelid='public.courts'::regclass and attnum>0 and not attisdropped and attgenerated='' and attidentity='';
 execute format('insert into public.courts(%1$s) select %1$s from jsonb_populate_record(null::public.courts,$1)',cols) using seed;
 seed:=seed||jsonb_build_object('id',cfirst,'slug','test-gr-first-'||cfirst,'name','TEST ONLY grouped reschedule first court '||n);
 execute format('insert into public.courts(%1$s) select %1$s from jsonb_populate_record(null::public.courts,$1)',cols) using seed;
 f.court_id:=cfirst;
 one:=pg_temp.group_session(f.court_id,s);
 fee:=round(case f.fee_mode when 'fixed_per_booking' then f.fee_amount when 'fixed_per_hour' then 2*f.fee_amount when 'percentage' then 20*f.fee_amount/100 end,2);
 two:=jsonb_build_object('courtId',c,'startsAt',s,'endsAt',s+interval '2 hours','slots',jsonb_build_array(
  jsonb_build_object('startsAt',s,'endsAt',s+interval '1 hour'),jsonb_build_object('startsAt',s+interval '1 hour','endsAt',s+interval '2 hours')),
  'subtotalAmount',20,'serviceFeeAmount',fee,'totalAmount',20+fee,'currency','PHP','metadata','{"fullPaymentOnly":true}'::jsonb);
 sessions:=jsonb_build_array(one,two,pg_temp.group_session(f.court_id,s+interval '3 hours'));
 r:=public.create_picklestreet_group_hold('picklestreet.pages.dev',key,hash,hash,sessions);
 select setting.* into strict policy from public.settings setting where setting.tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a' and setting.key='refund_reschedule_policy';
 r:=public.complete_picklestreet_provisional_hold('picklestreet.pages.dev',r->>'reference',hash,'TEST ONLY group reschedule','reschedule@example.invalid','09000000000',true,
  policy.value->>'version',public.refund_reschedule_policy_sha256(policy.value),1,null,null);
 j:=pg_temp.ps_group_payment_begin((r->>'bookingId')::uuid,n+20);
 perform public.finish_picklestreet_receipt_attempt((j->>'attemptId')::uuid,(j->>'leaseToken')::uuid,p_error_code=>'verifier_unavailable');
 select user_id into actor from public.platform_profiles where is_platform_owner order by user_id limit 1;
 perform public.review_picklestreet_pending_receipt((j->>'verificationId')::uuid,(j->>'attemptId')::uuid,extensions.gen_random_uuid(),'approve','Synthetic group reschedule fixture payment',actor);
 return(r->>'bookingId')::uuid;
end;$$;

create function pg_temp.gr_changes(sessions jsonb,days integer,only_id text default null) returns jsonb language sql as $$
 select jsonb_agg(jsonb_build_object('sessionId',s->>'sessionId','newDate',to_char((s->>'bookingDate')::date+days,'YYYY-MM-DD'),'newStartTime',s->>'startTime'))
 from jsonb_array_elements(sessions) s where only_id is null or s->>'sessionId'=only_id;
$$;
create function pg_temp.gr_apply(b uuid,actor uuid,changes jsonb,reason text,quote jsonb,key uuid default extensions.gen_random_uuid()) returns jsonb language sql as $$
 select public.apply_picklestreet_group_reschedule(b,actor,changes,reason,quote->>'version',quote->>'quoteHash','Synthetic rollback reschedule',null,true,key,
  extensions.gen_random_uuid(),repeat('a',64));
$$;

do $$
declare b uuid;b2 uuid;actor uuid;snap jsonb;q jsonb;r jsonb;changes jsonb;again jsonb;key uuid;denied boolean;old jsonb;session jsonb;
 court uuid;version text;options jsonb;amount numeric;request uuid;j jsonb;d jsonb;receiver jsonb;two jsonb;
begin
 select user_id into actor from public.platform_profiles where is_platform_owner order by user_id limit 1;
 b:=pg_temp.gr_fixture(1);snap:=public.get_picklestreet_group_reschedule(b,actor);old:=snap;
 if jsonb_array_length(snap->'sessions')<>3 or not exists(select 1 from jsonb_array_elements(snap->'sessions') s where s->>'durationHours'='2') then raise exception 'Fixture missing varied session durations';end if;
 changes:=pg_temp.gr_changes(snap->'sessions',1);q:=public.preview_picklestreet_group_reschedule(b,actor,changes,'customer_request',snap->>'version');
 key:=extensions.gen_random_uuid();r:=pg_temp.gr_apply(b,actor,changes,'customer_request',q,key);
 if r->>'paymentRequired'<>'false' or r->>'rescheduleEventId' is null or(select count(*) from public.booking_slots where booking_id=b and status='confirmed')<>4
  or exists(select 1 from public.booking_slots where booking_id=b and balance_request_id is not null) or r#>>'{booking,reference}'<>old#>>'{booking,reference}' then raise exception 'Atomic move lost reference or hours: %',r;end if;
 if(select count(*) from public.payment_sessions where booking_id=b)<>1 or(select count(*) from public.receipt_verifications where booking_id=b)<>1 then raise exception 'Reschedule changed original payment evidence';end if;
 again:=pg_temp.gr_apply(b,actor,changes,'customer_request',q,key);
 if again->>'rescheduleEventId'<>r->>'rescheduleEventId' or(select count(*) from public.booking_reschedule_events where booking_id=b)<>1 then raise exception 'Idempotency failed';end if;
 insert into ps_group_reschedule_results values('All sessions preserve durations, one reference and payment evidence; retry creates one event',true);
 denied:=false;begin perform pg_temp.gr_apply(b,actor,pg_temp.gr_changes(old->'sessions',2),'customer_request',q,key);exception when sqlstate '22023' then denied:=true;end;
 if not denied then raise exception 'Changed idempotency payload accepted';end if;
 denied:=false;begin perform public.preview_picklestreet_group_reschedule(b,actor,changes,'customer_request',old->>'version');exception when sqlstate '22023' then denied:=true;end;
 if not denied then raise exception 'Stale schedule accepted';end if;
 insert into ps_group_reschedule_results values('Stale schedule and changed idempotency payload are rejected',true);

 snap:=public.get_picklestreet_group_reschedule(b,actor);select value into session from jsonb_array_elements(snap->'sessions') where value->>'durationHours'='1' order by value->>'startsAt' limit 1;
 changes:=pg_temp.gr_changes(snap->'sessions',1,session->>'sessionId');q:=public.preview_picklestreet_group_reschedule(b,actor,changes,'customer_request',snap->>'version');
 r:=pg_temp.gr_apply(b,actor,changes,'customer_request',q);
 if exists(select 1 from jsonb_array_elements(snap->'sessions') original join jsonb_array_elements(r->'sessions') proposed on original->>'sessionId'=proposed->>'sessionId' where original->>'sessionId'<>session->>'sessionId' and original<>proposed) then raise exception 'Unselected sessions changed';end if;
 if (r->'sessions'->0->>'sessionId')<>(snap->'sessions'->0->>'sessionId') then raise exception 'Session identity changed';end if;
 insert into ps_group_reschedule_results values('Partial reschedule keeps unselected sessions and stable session identities',true);
 if not exists(select 1 from public.list_due_picklestreet_group_reschedule_emails() due where due.event_id=(r->>'rescheduleEventId')::uuid)
  or exists(select 1 from public.list_due_picklestreet_group_reschedule_emails() due where due.event_id=(again->>'rescheduleEventId')::uuid) then
  raise exception 'Grouped email queue included a superseded schedule or omitted the current one';end if;
 options:=public.claim_booking_reschedule_email((r->>'rescheduleEventId')::uuid,false);
 if options->>'shouldSend'<>'true' then raise exception 'Grouped email did not acquire one delivery lease';end if;
 options:=public.claim_booking_reschedule_email((r->>'rescheduleEventId')::uuid,false);
 if options->>'shouldSend'<>'false' then raise exception 'Grouped email duplicated its active delivery lease';end if;
 insert into ps_group_reschedule_results values('One email lease for current grouped schedule; older superseded events do not enter the queue',true);

 snap:=public.get_picklestreet_group_reschedule(b,actor);changes:=pg_temp.gr_changes(snap->'sessions',0);denied:=false;
 begin perform public.preview_picklestreet_group_reschedule(b,actor,changes,'weather',snap->>'version');exception when sqlstate '22023' then denied:=true;end;
 if not denied then raise exception 'No-op change accepted';end if;
 denied:=false;begin perform public.get_picklestreet_group_reschedule(b,extensions.gen_random_uuid());exception when sqlstate '42501' then denied:=true;end;
 if not denied then raise exception 'Unknown actor accepted';end if;
 perform set_config('request.jwt.claims','{"role":"authenticated"}',true);perform set_config('request.jwt.claim.role','authenticated',true);denied:=false;
 begin perform public.get_picklestreet_group_reschedule(b,actor);exception when sqlstate '42501' then denied:=true;end;
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);perform set_config('request.jwt.claim.role','service_role',true);
 if not denied then raise exception 'Non-service direct RPC accepted';end if;
 denied:=false;begin perform public.get_picklestreet_group_reschedule(extensions.gen_random_uuid(),actor);exception when sqlstate '42501' then denied:=true;end;
 if not denied then raise exception 'Unknown or foreign booking revealed';end if;
 insert into ps_group_reschedule_results values('No-op, unauthenticated, unauthorized actor and out-of-tenant booking rejected',true);
 denied:=false;begin update public.bookings set starts_at=starts_at+interval '1 hour' where id=b;exception when sqlstate '22023' then denied:=true;end;
 if not denied then raise exception 'Direct grouped schedule mutation bypassed protected request';end if;
 if has_function_privilege('anon','public.get_picklestreet_group_reschedule(uuid,uuid)','execute')
  or has_function_privilege('authenticated','public.apply_picklestreet_group_reschedule(uuid,uuid,jsonb,text,text,text,text,text,boolean,uuid,uuid,text)','execute')
  or has_function_privilege('service_role','public.commit_picklestreet_group_reschedule(uuid)','execute')
  or has_table_privilege('service_role','public.picklestreet_group_reschedule_requests','update') then raise exception 'Grouped reschedule privilege boundary invalid';end if;
 insert into ps_group_reschedule_results values('Direct edits and internal settlement RPC cannot bypass the protected group request',true);

 -- A one-hour session is swapped with its same-court sibling, keeping the two-hour court untouched.
 b2:=pg_temp.gr_fixture(2);snap:=public.get_picklestreet_group_reschedule(b2,actor);
 select s into session from jsonb_array_elements(snap->'sessions') s where s->>'durationHours'='1' order by s->>'startsAt' limit 1;
 select s into two from jsonb_array_elements(snap->'sessions') s where s->>'courtId'=session->>'courtId' and s->>'sessionId'<>session->>'sessionId';
 options:=public.options_picklestreet_group_reschedule(b2,actor,session->>'sessionId',(two->>'bookingDate')::date,snap->>'version');
 if not exists(select 1 from jsonb_array_elements(options->'options') o where o->>'startTime'=two->>'startTime' and o->>'available'='true') then raise exception 'Own sibling slot should be selectable for a swap';end if;
 changes:=jsonb_build_array(jsonb_build_object('sessionId',session->>'sessionId','newDate',two->>'bookingDate','newStartTime',two->>'startTime'),
  jsonb_build_object('sessionId',two->>'sessionId','newDate',session->>'bookingDate','newStartTime',session->>'startTime'));
 q:=public.preview_picklestreet_group_reschedule(b2,actor,changes,'customer_request',snap->>'version');r:=pg_temp.gr_apply(b2,actor,changes,'customer_request',q);
 insert into ps_group_reschedule_results values('Same-court session swap reuses existing occupancies atomically',true);
 snap:=public.get_picklestreet_group_reschedule(b2,actor);denied:=false;
 changes:=jsonb_build_array(jsonb_build_object('sessionId',session->>'sessionId','newDate',session->>'bookingDate','newStartTime',session->>'startTime'));
 begin perform public.preview_picklestreet_group_reschedule(b2,actor,changes,'customer_request',snap->>'version');exception when sqlstate '22023' then denied:=true;end;
 if not denied then raise exception 'Overlapping sibling sessions accepted';end if;
 insert into ps_group_reschedule_results values('Final preview rejects overlaps between proposed sessions',true);

 -- Changed settings invalidate a quote; current promo pricing drives the new quote.
 b:=pg_temp.gr_fixture(3);snap:=public.get_picklestreet_group_reschedule(b,actor);select value into session from jsonb_array_elements(snap->'sessions') where value->>'durationHours'='1' order by value->>'startsAt' limit 1;court:=(session->>'courtId')::uuid;
 changes:=pg_temp.gr_changes(snap->'sessions',2,session->>'sessionId');q:=public.preview_picklestreet_group_reschedule(b,actor,changes,'customer_request',snap->>'version');
 update public.courts set pricing_config=jsonb_set(pricing_config,'{regular,bands}',
  '[{"start":"05:00","end":"24:00","hourlyRate":15,"standardHourlyRate":20,"promoHourlyRate":15,"promoEnabled":true}]') where id=court;
 denied:=false;begin perform pg_temp.gr_apply(b,actor,changes,'customer_request',q);exception when sqlstate '22023' then denied:=true;end;
 if not denied then raise exception 'Stale price quote accepted';end if;
 q:=public.preview_picklestreet_group_reschedule(b,actor,changes,'weather',snap->>'version');
 if q#>>'{price,additionalAmount}'<>'0.00' and(q#>>'{price,additionalAmount}')::numeric<>0 then raise exception 'Rain change repriced paid hours';end if;
 q:=public.preview_picklestreet_group_reschedule(b,actor,changes,'customer_request',snap->>'version');
 if(q#>>'{price,additionalAmount}')::numeric<>5 then raise exception 'Promo or unchanged session pricing incorrect: %',q->'price';end if;
 old:=snap;r:=pg_temp.gr_apply(b,actor,changes,'customer_request',q);request:=(r#>>'{balanceRequest,id}')::uuid;
 if r->>'paymentRequired'<>'true' or extract(epoch from((r#>>'{balanceRequest,deadlineAt}')::timestamptz-clock_timestamp())) not between 890 and 901
  or(public.picklestreet_group_schedule_snapshot(b)->'sessions')<>old->'sessions'
  or(select count(*) from public.booking_slots where booking_id=b and balance_request_id is null and status='confirmed')<>4
  or(select count(*) from public.booking_slots where booking_id=b and balance_request_id=request and status='held')<>1 then raise exception 'Payment adjustment did not preserve original schedules: %',r;end if;
 insert into ps_group_reschedule_results values('Stale pricing blocked; promo-aware extra amount; rain preserves paid hours; 15-minute new-slot hold retains all originals',true);
 key:=extensions.gen_random_uuid();j:=public.begin_picklestreet_balance_receipt_attempt(b,request,'upload',key,
  'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a/receipts/'||b||'/'||key||'.png',encode(extensions.digest(key::text,'sha256'),'hex'),'gcash','9750000000001',actor);
 r:=public.finish_picklestreet_balance_receipt_attempt((j->>'attemptId')::uuid,(j->>'leaseToken')::uuid,p_error_code=>'verifier_unavailable');
 if r->>'status'<>'manual_review' or public.picklestreet_group_schedule_snapshot(b)->'sessions'<>old->'sessions' then raise exception 'Uncertain parser changed originals';end if;
 r:=public.review_picklestreet_pending_receipt((j->>'verificationId')::uuid,(j->>'attemptId')::uuid,extensions.gen_random_uuid(),'approve','Synthetic verified balance payment',actor);
 if r->>'balanceStatus'<>'settled' or r->>'rescheduleEventId' is null or public.picklestreet_group_schedule_snapshot(b)->'sessions'<>q->'sessions'
  or exists(select 1 from public.booking_slots where booking_id=b and(status<>'confirmed' or balance_request_id is not null)) then raise exception 'Grouped staff balance settlement failed: %',r;end if;
 insert into ps_group_reschedule_results values('Uncertain additional receipt stays pending; staff confirmation atomically applies all sessions',true);

 -- An abandoned extra payment releases new targets while original confirmed hours remain.
 b:=pg_temp.gr_fixture(4);snap:=public.get_picklestreet_group_reschedule(b,actor);select value into session from jsonb_array_elements(snap->'sessions') where value->>'durationHours'='1' order by value->>'startsAt' limit 1;
 changes:=pg_temp.gr_changes(snap->'sessions',2,session->>'sessionId');
 q:=public.preview_picklestreet_group_reschedule(b,actor,changes,'customer_request',snap->>'version');
 -- The fixture initial rates now follow the modified shared synthetic court; raise only the selected target court.
 update public.courts set pricing_config=jsonb_set(pricing_config,'{regular,bands}',
  '[{"start":"05:00","end":"24:00","hourlyRate":25,"standardHourlyRate":25,"promoHourlyRate":null,"promoEnabled":false}]') where id=(session->>'courtId')::uuid;
 q:=public.preview_picklestreet_group_reschedule(b,actor,changes,'customer_request',snap->>'version');r:=pg_temp.gr_apply(b,actor,changes,'customer_request',q);
 request:=(r#>>'{balanceRequest,id}')::uuid;
 update public.booking_balance_requests set deadline_at=clock_timestamp()-interval '1 minute' where id=request;
 perform public.expire_picklestreet_group_unsubmitted_reschedules();
 if public.picklestreet_group_schedule_snapshot(b)->'sessions'<>snap->'sessions' or exists(select 1 from public.booking_slots where booking_id=b and balance_request_id=request and status='held') then
  raise exception 'Expiry changed original booking or retained target hold';end if;
 insert into ps_group_reschedule_results values('Unpaid adjustment expiry releases only new holds and preserves original booking',true);

 -- The automatic verifier reaches the same grouped atomic commit path.
 b:=pg_temp.gr_fixture(5);snap:=public.get_picklestreet_group_reschedule(b,actor);select value into session from jsonb_array_elements(snap->'sessions') where value->>'durationHours'='1' order by value->>'startsAt' limit 1;
 update public.courts set pricing_config=jsonb_set(pricing_config,'{regular,bands}','[{"start":"05:00","end":"24:00","hourlyRate":20,"standardHourlyRate":20,"promoHourlyRate":null,"promoEnabled":false}]') where id=(session->>'courtId')::uuid;
 changes:=pg_temp.gr_changes(snap->'sessions',2,session->>'sessionId');q:=public.preview_picklestreet_group_reschedule(b,actor,changes,'customer_request',snap->>'version');
 r:=pg_temp.gr_apply(b,actor,changes,'customer_request',q);request:=(r#>>'{balanceRequest,id}')::uuid;key:=extensions.gen_random_uuid();
 j:=public.begin_picklestreet_balance_receipt_attempt(b,request,'upload',key,'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a/receipts/'||b||'/'||key||'.png',
  encode(extensions.digest(key::text,'sha256'),'hex'),'gcash','9750000000002',actor);
 d:=jsonb_build_object('schemaVersion',2,'provider','google_vision','feature','DOCUMENT_TEXT_DETECTION','ocrCharacterCount',180,
  'file',jsonb_build_object('mimeType','image/png','sizeBytes',300),
  'detected',jsonb_build_object('paymentReference',j->>'submittedReference','route',jsonb_build_object('schemaVersion',1,'routeId','gcash_to_gcash',
    'sourceProvider','gcash','destinationProvider','gcash','destinationMethodCode','gcash','parserVersion','gcash_v1','sourceMatched',true,'destinationMatched',true,
    'recipientMatched',true,'referenceMatched',true,'successMatched',true,'secondaryReferences','[]'::jsonb)),
  'comparison',jsonb_build_object('currency','PHP','expectedAmount',(j->>'expectedAmount')::numeric,'amountMatched',true),
  'timing',jsonb_build_object('bookingStartedAt',j->>'bookingStartedAt','tenantTimezone','Asia/Manila',
    'receiptDate',to_char((j->>'bookingStartedAt')::timestamptz at time zone 'Asia/Manila','YYYY-MM-DD'),
    'receiptTime',to_char((j->>'bookingStartedAt')::timestamptz at time zone 'Asia/Manila','HH24:MI'),
    'receiptDateTime',date_trunc('minute',(j->>'bookingStartedAt')::timestamptz),'withinWindow',true,'allowedWindowMinutes',15,'earlyToleranceMinutes',2),
  'confidence',jsonb_build_object('vision',0.99,'effective',0.99,'evidence',1,'source','google_vision_plus_evidence'));
 select jsonb_build_object('method','gcash','name',m.account_name,'account',m.account_reference,'destinationMethod','gcash',
  'verificationSettingsRevision',coalesce((select revision from public.picklestreet_receipt_route_settings where tenant_id=m.tenant_id),0)) into receiver
 from public.tenant_payment_methods m where m.tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a' and m.method_code='gcash' and m.is_active;
 r:=public.finish_picklestreet_balance_receipt_attempt((j->>'attemptId')::uuid,(j->>'leaseToken')::uuid,d,array['auto_approval_eligible'],j->>'submittedReference',0.99,true,null,receiver);
 if r->>'status'<>'auto_approved' or r->>'balanceStatus'<>'settled' or r->>'rescheduleEventId' is null
  or public.picklestreet_group_schedule_snapshot(b)->'sessions'<>q->'sessions' then raise exception 'Automatic grouped balance settlement failed: %',r;end if;
 insert into ps_group_reschedule_results values('Automatic verified additional payment commits every grouped session and preserves original payment evidence',true);

 b:=pg_temp.gr_fixture(6);snap:=public.get_picklestreet_group_reschedule(b,actor);select value into session from jsonb_array_elements(snap->'sessions') where value->>'durationHours'='1' order by value->>'startsAt' limit 1;
 update public.courts set pricing_config=jsonb_set(pricing_config,'{regular,bands}','[{"start":"05:00","end":"24:00","hourlyRate":5,"standardHourlyRate":5,"promoHourlyRate":null,"promoEnabled":false}]') where id=(session->>'courtId')::uuid;
 changes:=pg_temp.gr_changes(snap->'sessions',2,session->>'sessionId');q:=public.preview_picklestreet_group_reschedule(b,actor,changes,'customer_request',snap->>'version');
 if(q#>>'{price,additionalAmount}')::numeric<>0 or(q#>>'{price,retainedAmount}')::numeric<>5 or q#>'{price,newTotalAmount}'<>snap#>'{booking,totalAmount}' then
  raise exception 'Lower rate must retain paid amount without an automatic refund: %',q->'price';end if;
 r:=pg_temp.gr_apply(b,actor,changes,'customer_request',q);
 if r#>'{booking,totalAmount}'<>snap#>'{booking,totalAmount}' then raise exception 'Cheaper reschedule changed paid financial total';end if;
 insert into ps_group_reschedule_results values('Cheaper replacement retains original paid amount and clearly quotes no refund',true);

 b:=pg_temp.gr_fixture(7);snap:=public.get_picklestreet_group_reschedule(b,actor);changes:=pg_temp.gr_changes(snap->'sessions',2);
 q:=public.preview_picklestreet_group_reschedule(b,actor,changes,'customer_request',snap->>'version');session:=q->'sessions'->0;
 -- A separate booking claims one target after the preview. Applying must leave every original untouched.
 insert into public.booking_slots(tenant_id,booking_id,court_id,starts_at,ends_at,status)
 values('f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a',b2,(session->>'courtId')::uuid,(session->>'startsAt')::timestamptz,(session->>'startsAt')::timestamptz+interval '1 hour','confirmed');
 denied:=false;begin perform pg_temp.gr_apply(b,actor,changes,'customer_request',q);exception when sqlstate '23P01' then denied:=true;end;
 if not denied or public.picklestreet_group_schedule_snapshot(b)->'sessions'<>snap->'sessions' or exists(select 1 from public.booking_reschedule_events where booking_id=b) then
  raise exception 'Target conflict partially moved the original group';end if;
 insert into ps_group_reschedule_results values('A target claimed after preview rolls back the whole move without releasing original sessions',true);

 -- A weather claim arriving during additional payment must block a middle-session
 -- move even when the original aggregate min/max dates do not change.
 b:=pg_temp.gr_fixture(8);snap:=public.get_picklestreet_group_reschedule(b,actor);
 select value into session from jsonb_array_elements(snap->'sessions') where value->>'durationHours'='2';
 update public.courts set pricing_config=jsonb_set(pricing_config,'{regular,bands}',
  '[{"start":"05:00","end":"24:00","hourlyRate":20,"standardHourlyRate":20,"promoHourlyRate":null,"promoEnabled":false}]') where id=(session->>'courtId')::uuid;
 changes:=jsonb_build_array(jsonb_build_object('sessionId',session->>'sessionId','newDate',session->>'bookingDate','newStartTime','09:00'));
 q:=public.preview_picklestreet_group_reschedule(b,actor,changes,'customer_request',snap->>'version');r:=pg_temp.gr_apply(b,actor,changes,'customer_request',q);
 request:=(r#>>'{balanceRequest,id}')::uuid;key:=extensions.gen_random_uuid();
 if (select min((s->>'startsAt')::timestamptz) from jsonb_array_elements(q->'sessions') s)<>(snap#>>'{booking,startsAt}')::timestamptz
  or(select max((s->>'endsAt')::timestamptz) from jsonb_array_elements(q->'sessions') s)<>(snap#>>'{booking,endsAt}')::timestamptz then raise exception 'Weather fixture must leave outer range unchanged';end if;
 j:=public.begin_picklestreet_balance_receipt_attempt(b,request,'upload',key,'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a/receipts/'||b||'/'||key||'.png',
  encode(extensions.digest(key::text,'sha256'),'hex'),'gcash','9750000000003',actor);
 insert into public.player_rain_claims(tenant_id,booking_id,court_id,booking_reference,court_name,booking_starts_at,booking_ends_at,local_booking_date,
  client_request_id,claim_token_hash,access_method,rain_reported_at,proof_due_at,elapsed_seconds,refund_percent,paid_amount,estimated_refund_amount,currency,
  court_rental_amount,equipment_rental_amount,platform_booking_fee_amount,refundable_basis_amount)
 select booking.tenant_id,booking.id,booking.court_id,booking.reference,c.name,booking.starts_at,booking.ends_at,booking.local_booking_date,
  extensions.gen_random_uuid(),encode(extensions.digest(key::text||'-rain','sha256'),'hex'),'booking_token',booking.starts_at+interval '1 minute',booking.starts_at+interval '11 minutes',60,75,
  booking.total_amount,round(booking.subtotal_amount*0.75,2),booking.currency,booking.subtotal_amount,0,booking.service_fee_amount,booking.subtotal_amount
 from public.bookings booking join public.courts c on c.tenant_id=booking.tenant_id and c.id=booking.court_id where booking.id=b;
 d:=jsonb_set(d,'{detected,paymentReference}',to_jsonb(j->>'submittedReference'));
 d:=jsonb_set(d,'{comparison,expectedAmount}',to_jsonb((j->>'expectedAmount')::numeric));
 d:=jsonb_set(d,'{timing}',jsonb_build_object('bookingStartedAt',j->>'bookingStartedAt','tenantTimezone','Asia/Manila',
  'receiptDate',to_char((j->>'bookingStartedAt')::timestamptz at time zone 'Asia/Manila','YYYY-MM-DD'),
  'receiptTime',to_char((j->>'bookingStartedAt')::timestamptz at time zone 'Asia/Manila','HH24:MI'),
  'receiptDateTime',date_trunc('minute',(j->>'bookingStartedAt')::timestamptz),'withinWindow',true,'allowedWindowMinutes',15,'earlyToleranceMinutes',2));
 r:=public.finish_picklestreet_balance_receipt_attempt((j->>'attemptId')::uuid,(j->>'leaseToken')::uuid,d,array['auto_approval_eligible'],j->>'submittedReference',0.99,true,null,receiver);
 if r->>'status'<>'manual_review' or r->>'balanceStatus'<>'payment_review' or public.picklestreet_group_schedule_snapshot(b)->'sessions'<>snap->'sessions'
  or exists(select 1 from public.booking_reschedule_events where booking_id=b) then raise exception 'Late weather claim failed to block automatic middle-session move: %',r;end if;
 denied:=false;begin perform public.review_picklestreet_pending_receipt((j->>'verificationId')::uuid,(j->>'attemptId')::uuid,extensions.gen_random_uuid(),'approve','Synthetic review after weather claim',actor);
 exception when sqlstate '22023' then denied:=true;end;
 if not denied or public.picklestreet_group_schedule_snapshot(b)->'sessions'<>snap->'sessions' then raise exception 'Manual review bypassed late weather claim';end if;
 insert into ps_group_reschedule_results values('Weather claim during payment blocks automatic and staff middle-session changes despite unchanged outer dates',true);
end;$$;
select * from ps_group_reschedule_results order by name;
