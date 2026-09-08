-- Run only before any grouped reschedule request has been used. Preserve financial audit history.
begin;

do $$begin if exists(select 1 from public.picklestreet_group_reschedule_requests) then raise exception 'Cannot remove grouped reschedule after use; deploy a forward fix.';end if;end;$$;
CREATE OR REPLACE FUNCTION public.finish_picklestreet_balance_receipt_attempt(p_attempt_id uuid, p_lease_token uuid, p_extracted_data jsonb DEFAULT NULL::jsonb, p_flags text[] DEFAULT '{}'::text[], p_payment_reference text DEFAULT NULL::text, p_confidence numeric DEFAULT NULL::numeric, p_auto_approve boolean DEFAULT false, p_error_code text DEFAULT NULL::text, p_receiver_snapshot jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET row_security TO 'off'
AS $function$
declare
 t constant uuid:='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';a public.picklestreet_balance_receipt_attempts%rowtype;
 j public.picklestreet_balance_receipt_jobs%rowtype;q public.booking_balance_requests%rowtype;b public.bookings%rowtype;
 r public.receipt_verifications%rowtype;s public.payment_sessions%rowtype;e public.booking_reschedule_events%rowtype;
 v_flags text[]:=coalesce(p_flags,'{}');data jsonb:=coalesce(p_extracted_data,'{}');ref text:=nullif(p_payment_reference,'');hash text;
 candidate boolean:=coalesce(p_auto_approve,false);reason text;zone text;cfg jsonb;method text;normref text;
 target_start timestamptz;target_end timestamptz;target_count integer;target_duration numeric;old_count integer;
 active_count integer;restored boolean:=false;new_total numeric;new_subtotal numeric;reschedule_id uuid;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'PICKLESTREET_SERVICE_REQUIRED' using errcode='42501';end if;
 select * into a from public.picklestreet_balance_receipt_attempts where tenant_id=t and id=p_attempt_id;
 if not found then raise exception 'ATTEMPT_NOT_FOUND' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended('picklestreet-balance:'||a.balance_request_id::text,0));
 select * into r from public.receipt_verifications where tenant_id=t and id=a.receipt_id for update;
 select * into q from public.booking_balance_requests where tenant_id=t and id=a.balance_request_id for update;
 select * into b from public.bookings where tenant_id=t and id=a.booking_id for update;
 select * into s from public.payment_sessions where tenant_id=t and id=a.payment_session_id for update;
 select * into j from public.picklestreet_balance_receipt_jobs where tenant_id=t and balance_request_id=a.balance_request_id for update;
 select * into a from public.picklestreet_balance_receipt_attempts where tenant_id=t and id=p_attempt_id for update;
 if j.current_attempt_id is distinct from a.id or j.lease_token is distinct from p_lease_token or a.outcome<>'processing' then
   return jsonb_build_object('ok',true,'stale',j.current_attempt_id is distinct from a.id,'existing',true,
     'status',r.status,'flags',to_jsonb(r.flags),'verificationId',r.id,'balanceRequestId',q.id,'requestType',q.request_type,
     'balanceStatus',q.status,'bookingReference',b.reference,'bookingStatus',b.status,'paymentStatus',b.payment_status,'rescheduleEventId',j.reschedule_event_id);
 end if;
 if r.status not in ('pending','manual_review') or q.status<>'payment_review' or j.settled_at is not null
   or q.remaining_amount<>j.expected_amount or q.currency<>j.currency or s.amount<>q.remaining_amount or s.currency<>q.currency
   or s.provider<>'manual_balance_receipt' or s.status not in ('created','pending')
   or s.provider_payload->>'balanceRequestId' is distinct from q.id::text then raise exception 'BALANCE_CONTEXT_CHANGED' using errcode='22023';end if;
 if cardinality(v_flags)>20 or exists(select 1 from unnest(v_flags) f where f is null or f !~'^[a-z0-9_]{1,40}$')
   or(ref is not null and ref !~'^[A-Z0-9][A-Z0-9-]{5,63}$') or(p_confidence is not null and(p_confidence<0 or p_confidence>1)) then
   raise exception 'EVIDENCE_INVALID' using errcode='22023';end if;
 select timezone,public_config into zone,cfg from public.tenants where id=t;
 method:=lower(s.provider_payload->>'paymentMethod');
 if method is distinct from a.payment_method or nullif(btrim(s.provider_payload->>'submittedReference'),'') is distinct from a.submitted_reference then
   candidate:=false;v_flags:=array['payment_context_changed'];end if;
 if p_error_code is not null then
   if p_error_code !~'^[a-z0-9_]{1,40}$' then raise exception 'ERROR_CODE_INVALID' using errcode='22023';end if;
   candidate:=false;v_flags:=array[p_error_code];data:='{}';
 else
   if jsonb_typeof(data) is distinct from 'object' or data->>'schemaVersion' is distinct from '2'
     or data->>'provider' is distinct from 'google_vision' or data->>'feature' is distinct from 'DOCUMENT_TEXT_DETECTION'
     or(select count(*) from jsonb_object_keys(data))<>9 or exists(select 1 from jsonb_object_keys(data) k where k<>all(array[
       'schemaVersion','provider','feature','ocrCharacterCount','file','detected','comparison','timing','confidence']))
     or jsonb_typeof(data->'file') is distinct from 'object' or jsonb_typeof(data->'detected') is distinct from 'object'
     or jsonb_typeof(data->'comparison') is distinct from 'object' or jsonb_typeof(data->'timing') is distinct from 'object'
     or jsonb_typeof(data->'confidence') is distinct from 'object'
     or data#>>'{comparison,currency}' is distinct from q.currency
     or(data#>>'{comparison,expectedAmount}')::numeric is distinct from q.remaining_amount
     or(data#>>'{timing,bookingStartedAt}')::timestamptz is distinct from s.created_at
     or data#>>'{timing,tenantTimezone}' is distinct from zone
     or(data#>>'{confidence,effective}')::numeric is distinct from p_confidence
     or coalesce(data#>>'{detected,paymentReference}','')<>coalesce(ref,'') then raise exception 'EVIDENCE_INVALID' using errcode='22023';end if;
   if(data#>>'{timing,withinWindow}')::boolean is true and(
     data#>>'{timing,receiptDateTime}' is null
     or to_char((data#>>'{timing,receiptDateTime}')::timestamptz at time zone zone,'YYYY-MM-DD') is distinct from data#>>'{timing,receiptDate}'
     or to_char((data#>>'{timing,receiptDateTime}')::timestamptz at time zone zone,'HH24:MI') is distinct from data#>>'{timing,receiptTime}'
     or(data#>>'{timing,allowedWindowMinutes}')::numeric not between 1 and 60
     or(data#>>'{timing,earlyToleranceMinutes}')::numeric not between 0 and 10
     or extract(epoch from((data#>>'{timing,receiptDateTime}')::timestamptz-s.created_at))/60
       not between -(data#>>'{timing,earlyToleranceMinutes}')::numeric and(data#>>'{timing,allowedWindowMinutes}')::numeric
   ) then raise exception 'RECEIPT_TIMING_INVALID' using errcode='22023';end if;
 end if;
 hash:=a.file_sha256;
 if hash is null then candidate:=false;v_flags:=array_append(array_remove(v_flags,'auto_approval_eligible'),'receipt_fingerprint_unavailable');end if;
 if hash is not null then
   -- Same lock namespace as the initial flow; one payment purpose owns evidence.
   perform pg_advisory_xact_lock(hashtextextended('picklestreet-file:'||hash,0));
   if exists(select 1 from public.receipt_verifications where tenant_id=t and balance_request_id is distinct from q.id and lower(file_sha256)=hash)
     or exists(select 1 from public.picklestreet_receipt_attempts where tenant_id=t and file_sha256=hash)
     or exists(select 1 from public.picklestreet_balance_receipt_attempts where tenant_id=t and balance_request_id<>q.id and file_sha256=hash) then
     candidate:=false;hash:=null;v_flags:=array_append(array_remove(v_flags,'auto_approval_eligible'),'duplicate_receipt_file');end if;
 end if;
 if ref is not null then
   normref:=regexp_replace(upper(ref),'[^A-Z0-9]','','g');
   perform pg_advisory_xact_lock(hashtextextended('picklestreet-reference:'||normref,0));
   if exists(select 1 from public.receipt_verifications where tenant_id=t and balance_request_id is distinct from q.id
       and regexp_replace(upper(payment_reference),'[^A-Z0-9]','','g')=normref)
     or exists(select 1 from public.picklestreet_receipt_attempts where tenant_id=t and regexp_replace(upper(payment_reference),'[^A-Z0-9]','','g')=normref)
     or exists(select 1 from public.picklestreet_balance_receipt_attempts where tenant_id=t and balance_request_id<>q.id
       and regexp_replace(upper(payment_reference),'[^A-Z0-9]','','g')=normref) then
     candidate:=false;ref:=null;v_flags:=array_append(array_remove(v_flags,'auto_approval_eligible'),'duplicate_payment_reference');end if;
 end if;
 -- Lock and compare exactly the account inspected by the Edge parser.
 if data#>'{detected,route}' is not null then
   if not public.picklestreet_receipt_route_config_current(method,p_receiver_snapshot) and p_error_code is null then
     candidate:=false;v_flags:=array['payment_receiver_settings_changed'];end if;
 else
 perform 1 from public.tenant_payment_methods m where m.tenant_id=t and m.method_code=method and m.is_active
   and p_receiver_snapshot=jsonb_build_object('method',m.method_code,'name',m.account_name,'account',m.account_reference) for share;
 if not found and p_error_code is null then candidate:=false;v_flags:=array['payment_receiver_settings_changed'];end if;
 end if;
 if candidate and(coalesce(p_confidence,0)<0.9 or coalesce((data#>>'{confidence,effective}')::numeric,0)<0.9
   or coalesce((data#>>'{comparison,amountMatched}')::boolean,false) is not true
   or coalesce((data#>>'{timing,withinWindow}')::boolean,false) is not true
   or nullif(data#>>'{timing,receiptDate}','') is null or nullif(data#>>'{timing,receiptTime}','') is null
   or ref is null or char_length(regexp_replace(coalesce(a.submitted_reference,''),'[^A-Za-z0-9]','','g'))<6
   or regexp_replace(upper(a.submitted_reference),'[^A-Z0-9]','','g')<>regexp_replace(upper(ref),'[^A-Z0-9]','','g')
   or cfg->>'bookingApprovalMode'='manual' or not(case when data#>'{detected,route}' is not null
     then public.picklestreet_receipt_route_ready(method,data,p_receiver_snapshot)
     else method='gcash' or(method='gotyme' and coalesce(cfg->'receiptAutoApprovalMethods','[]') @> '["gotyme"]') end)
 ) then candidate:=false;v_flags:=array_append(array_remove(v_flags,'auto_approval_eligible'),'automatic_evidence_incomplete');end if;
 if not candidate then v_flags:=array_remove(v_flags,'auto_approval_eligible');end if;
 if cardinality(v_flags)=0 then v_flags:=array['verification_pending'];end if;
 begin
   update public.receipt_verifications set status='manual_review',file_sha256=hash,payment_reference=ref,confidence=p_confidence,flags=v_flags,extracted_data=data where tenant_id=t and id=r.id;
 exception when unique_violation then
   candidate:=false;v_flags:=array_append(array_remove(v_flags,'auto_approval_eligible'),'duplicate_receipt_evidence');
   update public.receipt_verifications set status='manual_review',file_sha256=null,payment_reference=null,confidence=p_confidence,flags=v_flags,extracted_data=data where tenant_id=t and id=r.id;
 end;
 if candidate and v_flags=array['auto_approval_eligible']::text[] then
   begin
     if b.checked_in_at is not null then raise exception 'booking_checked_in' using errcode='P0001';end if;
     if q.request_type='reschedule_adjustment' then
       if b.status<>'confirmed' or b.payment_status<>'paid' or b.starts_at is distinct from j.original_starts_at
         or b.ends_at is distinct from j.original_ends_at or b.total_amount<>q.accepted_amount
         or(q.request_details->>'oldStartsAt')::timestamptz is distinct from b.starts_at
         or(q.request_details->>'oldEndsAt')::timestamptz is distinct from b.ends_at then raise exception 'original_booking_changed' using errcode='P0001';end if;
       target_start:=(q.request_details->>'newStartsAt')::timestamptz;target_end:=(q.request_details->>'newEndsAt')::timestamptz;
       new_subtotal:=(q.request_details->>'newSubtotalAmount')::numeric;new_total:=(q.request_details->>'newTotalAmount')::numeric;
       if new_total<>q.accepted_amount+q.remaining_amount or new_total<>new_subtotal+b.service_fee_amount then raise exception 'reschedule_price_changed' using errcode='P0001';end if;
       if(q.request_details->>'newLocalDate')::date is distinct from(target_start at time zone zone)::date then
         raise exception 'reservation_slots_changed' using errcode='P0001';end if;
     else
       if b.status not in ('payment_review','expired') or b.payment_status not in ('partial','pending')
         or q.accepted_amount+q.remaining_amount<>b.total_amount then raise exception 'balance_booking_changed' using errcode='P0001';end if;
       target_start:=b.starts_at;target_end:=b.ends_at;
       if not exists(select 1 from public.receipt_verifications original join public.payment_sessions payment
         on payment.tenant_id=original.tenant_id and payment.id=original.payment_session_id
         where original.tenant_id=t and original.id=q.original_verification_id and original.status='short_payment' and payment.status='paid') then
         raise exception 'original_payment_unverified' using errcode='P0001';end if;
     end if;
     if not isfinite(target_start) or not isfinite(target_end) or target_start is null or target_end is null or target_end<=target_start
       or target_end-target_start<>j.original_ends_at-j.original_starts_at then raise exception 'reservation_slots_changed' using errcode='P0001';end if;
     if target_start<=clock_timestamp() or b.starts_at<=clock_timestamp() then raise exception 'booking_started' using errcode='P0001';end if;
     perform set_config('lock_timeout','1000ms',true);
     lock table public.blocked_dates in share mode;
     perform c.id from public.courts c where c.tenant_id=t and c.id=b.court_id for share;
     if not exists(select 1 from public.courts where tenant_id=t and id=b.court_id and status='active') then raise exception 'reservation_court_unavailable' using errcode='P0001';end if;
     perform slot.id from public.booking_slots slot where slot.tenant_id=t and slot.booking_id=b.id order by slot.starts_at,slot.id for update;
     select count(*),coalesce(sum(extract(epoch from(ends_at-starts_at))),0),count(*) filter(where status='held' and hold_expires_at>clock_timestamp())
       into target_count,target_duration,active_count from public.booking_slots where tenant_id=t and booking_id=b.id
       and(case when q.request_type='reschedule_adjustment' then balance_request_id=q.id else balance_request_id is null end);
     if target_count<1 or target_duration<>extract(epoch from(target_end-target_start)) or exists(select 1 from public.booking_slots
       where tenant_id=t and booking_id=b.id and(case when q.request_type='reschedule_adjustment' then balance_request_id=q.id else balance_request_id is null end)
       and(status not in ('held','expired') or court_id<>b.court_id or starts_at<target_start or ends_at>target_end)) then raise exception 'reservation_slots_changed' using errcode='P0001';end if;
     if exists(select 1 from public.blocked_dates blocked where blocked.tenant_id=t and(blocked.court_id is null or blocked.court_id=b.court_id)
       and blocked.blocked_on between(target_start at time zone zone)::date and((target_end-interval '1 microsecond') at time zone zone)::date
       and tsrange(target_start at time zone zone,target_end at time zone zone,'[)') && case when blocked.starts_at is null then
         tsrange(blocked.blocked_on::timestamp,(blocked.blocked_on+1)::timestamp,'[)') else tsrange(blocked.blocked_on+blocked.starts_at,
         case when blocked.ends_at=time '23:59:59' then(blocked.blocked_on+1)::timestamp else blocked.blocked_on+blocked.ends_at end,'[)') end) then
       raise exception 'reservation_court_blocked' using errcode='P0001';end if;
     -- Explicit occupancy check includes open play. Database exclusion remains
     -- authoritative for any concurrent writer after this check.
     if exists(select 1 from public.court_occupancies occupancy where occupancy.tenant_id=t and occupancy.court_id=b.court_id
       and occupancy.starts_at<target_end and occupancy.ends_at>target_start
       and(occupancy.status='confirmed' or(occupancy.status='held' and occupancy.hold_expires_at>clock_timestamp()))
       and not(occupancy.source_kind='booking_slot' and exists(select 1 from public.booking_slots own where own.tenant_id=t
         and own.booking_id=b.id and own.id=occupancy.source_id
         and(case when q.request_type='reschedule_adjustment' then own.balance_request_id=q.id else own.balance_request_id is null end)))) then
       raise exception 'reservation_time_unavailable' using errcode='P0001';end if;
     if target_start<=clock_timestamp() or b.starts_at<=clock_timestamp() then raise exception 'booking_started' using errcode='P0001';end if;
     restored:=active_count<>target_count;
     perform set_config('app.picklestreet_balance_auto',r.id::text,true);
     if q.request_type='reschedule_adjustment' then
       select count(*) into old_count from public.booking_slots where tenant_id=t and booking_id=b.id and balance_request_id is null and status='confirmed';
       if old_count<1 or(select coalesce(sum(extract(epoch from(ends_at-starts_at))),0) from public.booking_slots
         where tenant_id=t and booking_id=b.id and balance_request_id is null)<>extract(epoch from(b.ends_at-b.starts_at))
         or exists(select 1 from public.booking_slots where tenant_id=t and booking_id=b.id and balance_request_id is null
         and(status<>'confirmed' or court_id<>b.court_id or starts_at<b.starts_at or ends_at>b.ends_at)) then raise exception 'original_booking_changed' using errcode='P0001';end if;
       insert into public.booking_reschedule_events(tenant_id,booking_id,court_id,rescheduled_by,reason_code,public_reason,internal_note,notify_customer,
         customer_email_snapshot,old_starts_at,old_ends_at,new_starts_at,new_ends_at,subtotal_amount,service_fee_amount,total_amount,currency,idempotency_key,email_status)
         values(t,b.id,b.court_id,null,q.request_details->>'reasonCode',q.request_details->>'publicReason',nullif(q.request_details->>'internalNote',''),
           coalesce((q.request_details->>'notifyCustomer')::boolean,false),nullif(lower(btrim(b.customer_email)),''),b.starts_at,b.ends_at,target_start,target_end,
           new_subtotal,b.service_fee_amount,new_total,b.currency,(q.request_details->>'idempotencyKey')::uuid,'not_requested') returning * into e;
       reschedule_id:=e.id;
       delete from public.booking_slots where tenant_id=t and booking_id=b.id and balance_request_id is null;
       update public.booking_slots set status='confirmed',hold_expires_at=null,balance_request_id=null where tenant_id=t and booking_id=b.id and balance_request_id=q.id;
       update public.bookings set starts_at=target_start,ends_at=target_end,local_booking_date=(q.request_details->>'newLocalDate')::date,
         subtotal_amount=new_subtotal,total_amount=new_total,metadata=metadata||jsonb_build_object('lastReschedule',jsonb_build_object(
           'eventId',e.id,'reasonCode',e.reason_code,'publicReason',e.public_reason,'rescheduledBy',null,'rescheduledAt',e.created_at,
           'oldStartsAt',e.old_starts_at,'oldEndsAt',e.old_ends_at,'newStartsAt',e.new_starts_at,'newEndsAt',e.new_ends_at,
           'priceAdjustmentAmount',q.remaining_amount,'automaticReceiptAttemptId',a.id)) where tenant_id=t and id=b.id;
     else
       update public.booking_slots set status='confirmed',hold_expires_at=null where tenant_id=t and booking_id=b.id and balance_request_id is null;
       update public.bookings set status='confirmed',payment_status='paid',confirmed_at=now(),expires_at=null where tenant_id=t and id=b.id;
     end if;
     update public.receipt_verifications set status='auto_approved',reviewed_at=now(),reviewed_by=null,
       extracted_data=extracted_data||jsonb_build_object('automation',jsonb_build_object('decision','approved','ruleVersion','picklestreet_balance_v1','attemptId',a.id)) where tenant_id=t and id=r.id;
     update public.payment_sessions set status='paid' where tenant_id=t and id=s.id;
     update public.booking_balance_requests set status='settled',settled_at=now() where tenant_id=t and id=q.id;
     update public.picklestreet_balance_receipt_jobs set settled_at=now(),reschedule_event_id=reschedule_id where tenant_id=t and balance_request_id=q.id;
   exception when others then
     restored:=false;reschedule_id:=null;
     reason:=case when sqlerrm in('booking_checked_in','original_booking_changed','reschedule_price_changed','balance_booking_changed','original_payment_unverified',
       'booking_started','reservation_court_unavailable','reservation_slots_changed','reservation_court_blocked','reservation_time_unavailable') then sqlerrm
       when sqlerrm='duplicate_payment_route_reference' then 'duplicate_payment_route_reference'
       when sqlstate='23P01' then 'reservation_time_unavailable' when sqlstate in('55P03','40P01','57014') then 'reservation_check_unavailable'
       else 'automatic_approval_unavailable' end;
     update public.receipt_verifications set status='manual_review',flags=array[reason] where tenant_id=t and id=r.id;
   end;
 end if;
 select * into r from public.receipt_verifications where tenant_id=t and id=r.id;
 select * into q from public.booking_balance_requests where tenant_id=t and id=q.id;
 select * into b from public.bookings where tenant_id=t and id=b.id;
 update public.picklestreet_balance_receipt_attempts set extracted_data=data,payment_reference=p_payment_reference,confidence=p_confidence,receiver_snapshot=p_receiver_snapshot,
   flags=r.flags,error_code=coalesce(p_error_code,reason),outcome=case when r.status='auto_approved' then 'auto_approved' else 'pending' end,completed_at=now()
   where tenant_id=t and id=a.id;
 update public.picklestreet_balance_receipt_jobs set lease_until=null,updated_at=now() where tenant_id=t and balance_request_id=q.id;
 return jsonb_build_object('ok',true,'status',r.status,'flags',to_jsonb(r.flags),'confidence',r.confidence,'verificationId',r.id,'attemptId',a.id,
   'balanceRequestId',q.id,'requestType',q.request_type,'balanceStatus',q.status,'bookingReference',b.reference,'bookingStatus',b.status,'paymentStatus',b.payment_status,
   'reservationRestored',restored,'reservationHeld',case when q.status='settled' then true else j.hold_deadline_at>clock_timestamp()
     and exists(select 1 from public.booking_slots where tenant_id=t and booking_id=b.id
       and(case when q.request_type='reschedule_adjustment' then balance_request_id=q.id else balance_request_id is null end))
     and not exists(select 1 from public.booking_slots where tenant_id=t and booking_id=b.id
       and(case when q.request_type='reschedule_adjustment' then balance_request_id=q.id else balance_request_id is null end)
       and(status<>'held' or hold_expires_at is null or hold_expires_at<=clock_timestamp())) end,
   'holdExpiresAt',j.hold_deadline_at,'originalStartsAt',j.original_starts_at,'originalEndsAt',j.original_ends_at,'rescheduleEventId',reschedule_id);
end;$function$
;
CREATE OR REPLACE FUNCTION public.review_picklestreet_pending_receipt(p_verification_id uuid, p_expected_attempt_id uuid, p_idempotency_key uuid, p_decision text, p_review_note text, p_actor_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET row_security TO 'off'
AS $function$
declare
 t constant uuid:='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';
 r public.receipt_verifications%rowtype;b public.bookings%rowtype;s public.payment_sessions%rowtype;
 q public.booking_balance_requests%rowtype;j public.picklestreet_receipt_jobs%rowtype;
 bj public.picklestreet_balance_receipt_jobs%rowtype;d public.picklestreet_receipt_staff_reviews%rowtype;
 e public.booking_reschedule_events%rowtype;
 authorized boolean:=false;zone text;v_note text:=btrim(p_review_note);
 target_start timestamptz;target_end timestamptz;target_count integer;target_duration numeric;
 target_min timestamptz;target_max timestamptz;active_count integer;
 new_total numeric;new_subtotal numeric;reschedule_id uuid;restored boolean:=false;
 v_result jsonb;prior_claims text;prior_sub text;prior_marker text;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'PICKLESTREET_SERVICE_REQUIRED' using errcode='42501';end if;
 if p_verification_id is null or p_expected_attempt_id is null or p_idempotency_key is null or p_actor_user_id is null
   or p_decision is null or p_decision not in('approve','reject') or v_note is null or char_length(v_note) not between 3 and 1000 then
   raise exception 'STAFF_REVIEW_INVALID' using errcode='22023';end if;
 perform 1 from public.tenant_memberships where tenant_id=t and user_id=p_actor_user_id and status='active'
   and role in('owner','admin','staff') for share;
 authorized:=found;
 perform 1 from public.platform_profiles where user_id=p_actor_user_id and is_platform_owner for share;
 authorized:=authorized or found;
 if not authorized then raise exception 'TENANT_ACCESS_DENIED' using errcode='42501';end if;
 select timezone into zone from public.tenants where id=t and slug='pickle-street-tugbok' and status='active' for share;
 if not found then raise exception 'TENANT_UNAVAILABLE' using errcode='22023';end if;
 -- Serializes a key even if a caller tries to reuse it on a different payment.
 perform pg_advisory_xact_lock(hashtextextended('picklestreet-staff-review:'||p_idempotency_key::text,0));
 select * into d from public.picklestreet_receipt_staff_reviews where tenant_id=t and idempotency_key=p_idempotency_key;
 if found then
   if d.verification_id<>p_verification_id or d.expected_attempt_id<>p_expected_attempt_id or d.decision<>p_decision
     or d.review_note<>v_note or d.actor_user_id<>p_actor_user_id then raise exception 'IDEMPOTENCY_CONFLICT' using errcode='22023';end if;
   if d.completed_at is null then raise exception 'STAFF_REVIEW_IN_PROGRESS' using errcode='22023';end if;
   return d.result||jsonb_build_object('idempotent',true);
 end if;
 select * into r from public.receipt_verifications where tenant_id=t and id=p_verification_id;
 if not found then raise exception 'RECEIPT_NOT_FOUND' using errcode='22023';end if;
 -- Use the same lock and row order as automatic finalization.
 if r.balance_request_id is null then
   perform pg_advisory_xact_lock(hashtextextended('picklestreet-receipt:'||r.booking_id::text,0));
 else
   perform pg_advisory_xact_lock(hashtextextended('picklestreet-balance:'||r.balance_request_id::text,0));
 end if;
 select * into r from public.receipt_verifications where tenant_id=t and id=p_verification_id for update;
 if r.balance_request_id is not null then
   select * into q from public.booking_balance_requests where tenant_id=t and id=r.balance_request_id and booking_id=r.booking_id for update;
   if not found then raise exception 'BALANCE_CONTEXT_CHANGED' using errcode='22023';end if;
 end if;
 select * into b from public.bookings where tenant_id=t and id=r.booking_id for update;
 if not found or b.archived_at is not null then raise exception 'BOOKING_NOT_REVIEWABLE' using errcode='22023';end if;
 select * into s from public.payment_sessions where tenant_id=t and id=r.payment_session_id and booking_id=b.id for update;
 if not found or s.status not in('created','pending') or s.currency<>b.currency or s.amount<>r.expected_amount
   or r.status not in('pending','manual_review') or nullif(btrim(r.storage_path),'') is null then
   raise exception 'RECEIPT_NOT_PENDING' using errcode='22023';end if;
 if exists(select 1 from public.picklestreet_receipt_staff_reviews where tenant_id=t and verification_id=r.id) then
   raise exception 'STAFF_REVIEW_ALREADY_DECIDED' using errcode='22023';end if;
 if q.id is null then
   select * into j from public.picklestreet_receipt_jobs where tenant_id=t and booking_id=b.id for update;
   if not found or j.receipt_id is distinct from r.id or j.current_attempt_id is distinct from p_expected_attempt_id then
     raise exception 'RECEIPT_CHANGED' using errcode='22023';end if;
   if b.status not in('pending_payment','payment_review','expired') or b.payment_status<>'pending'
     or s.provider<>'manual_receipt' or s.amount<>b.total_amount
     or exists(select 1 from public.booking_balance_requests where tenant_id=t and booking_id=b.id and status in('awaiting_payment','payment_review')) then
     raise exception 'BOOKING_PAYMENT_CONTEXT_CHANGED' using errcode='22023';end if;
   if not exists(select 1 from public.picklestreet_receipt_attempts where tenant_id=t and id=p_expected_attempt_id
     and booking_id=b.id and receipt_id=r.id and version=j.version and storage_path=r.storage_path) then
     raise exception 'RECEIPT_CHANGED' using errcode='22023';end if;
 else
   select * into bj from public.picklestreet_balance_receipt_jobs where tenant_id=t and booking_id=b.id and balance_request_id=q.id for update;
   if not found or bj.receipt_id is distinct from r.id or bj.current_attempt_id is distinct from p_expected_attempt_id
     or bj.closed_at is not null or bj.settled_at is not null then raise exception 'RECEIPT_CHANGED' using errcode='22023';end if;
   if q.status not in('awaiting_payment','payment_review','expired') or q.remaining_amount<>bj.expected_amount
     or q.currency<>bj.currency or s.amount<>q.remaining_amount or s.currency<>q.currency
     or s.provider<>'manual_balance_receipt' or s.provider_payload->>'balanceRequestId' is distinct from q.id::text then
     raise exception 'BALANCE_CONTEXT_CHANGED' using errcode='22023';end if;
   if not exists(select 1 from public.picklestreet_balance_receipt_attempts where tenant_id=t and id=p_expected_attempt_id
     and booking_id=b.id and balance_request_id=q.id and receipt_id=r.id and version=bj.version and storage_path=r.storage_path) then
     raise exception 'RECEIPT_CHANGED' using errcode='22023';end if;
   if q.request_type='reschedule_adjustment' then
     if b.status not in('confirmed','completed') or b.payment_status<>'paid' or b.starts_at is distinct from bj.original_starts_at
       or b.ends_at is distinct from bj.original_ends_at or b.total_amount<>q.accepted_amount then
       raise exception 'ORIGINAL_BOOKING_CHANGED' using errcode='22023';end if;
   elsif q.request_type='short_payment' then
     if b.status not in('payment_review','expired') or b.payment_status not in('partial','pending')
       or q.accepted_amount+q.remaining_amount<>b.total_amount then raise exception 'BALANCE_BOOKING_CHANGED' using errcode='22023';end if;
   else raise exception 'BALANCE_CONTEXT_CHANGED' using errcode='22023';end if;
 end if;
 insert into public.picklestreet_receipt_staff_reviews(tenant_id,booking_id,verification_id,payment_session_id,balance_request_id,
   expected_attempt_id,idempotency_key,decision,review_note,actor_user_id,before_state)
 values(t,b.id,r.id,s.id,q.id,p_expected_attempt_id,p_idempotency_key,p_decision,v_note,p_actor_user_id,
   jsonb_build_object('receipt',to_jsonb(r),'booking',to_jsonb(b),'payment',to_jsonb(s),'balance',case when q.id is null then null else to_jsonb(q) end)) returning * into d;
 prior_marker:=current_setting('app.picklestreet_staff_review',true);
 perform set_config('app.picklestreet_staff_review',d.authorization_token::text,true);
 -- Set the already-authorized actor for existing audit/past-booking checks.
 prior_claims:=current_setting('request.jwt.claims',true);prior_sub:=current_setting('request.jwt.claim.sub',true);
 perform set_config('request.jwt.claims',(coalesce(nullif(prior_claims,''),'{}')::jsonb||jsonb_build_object('role','service_role','sub',p_actor_user_id))::text,true);
 perform set_config('request.jwt.claim.sub',p_actor_user_id::text,true);
 if p_decision='approve' then
   if b.checked_in_at is not null then raise exception 'booking_checked_in' using errcode='22023';end if;
   if q.request_type='reschedule_adjustment' then
     if b.status<>'confirmed' or(q.request_details->>'oldStartsAt')::timestamptz is distinct from b.starts_at
       or(q.request_details->>'oldEndsAt')::timestamptz is distinct from b.ends_at then raise exception 'original_booking_changed' using errcode='22023';end if;
     target_start:=(q.request_details->>'newStartsAt')::timestamptz;target_end:=(q.request_details->>'newEndsAt')::timestamptz;
     new_subtotal:=(q.request_details->>'newSubtotalAmount')::numeric;new_total:=(q.request_details->>'newTotalAmount')::numeric;
     if new_total is null or new_subtotal is null or new_total<>q.accepted_amount+q.remaining_amount or new_total<>new_subtotal+b.service_fee_amount
       or(q.request_details->>'newLocalDate')::date is distinct from(target_start at time zone zone)::date then
       raise exception 'reschedule_price_changed' using errcode='22023';end if;
   else
     target_start:=b.starts_at;target_end:=b.ends_at;
     if q.request_type='short_payment' and not exists(select 1 from public.receipt_verifications original join public.payment_sessions payment
       on payment.tenant_id=original.tenant_id and payment.id=original.payment_session_id
       where original.tenant_id=t and original.id=q.original_verification_id and original.status='short_payment' and payment.status='paid') then
       raise exception 'original_payment_unverified' using errcode='22023';end if;
   end if;
   if target_start is null or target_end is null or not isfinite(target_start) or not isfinite(target_end) or target_end<=target_start
     or target_end-target_start<>b.ends_at-b.starts_at then raise exception 'reservation_slots_changed' using errcode='22023';end if;
   if target_start<=clock_timestamp() or b.starts_at<=clock_timestamp() then raise exception 'booking_started' using errcode='22023';end if;
   perform set_config('lock_timeout','1000ms',true);
   lock table public.blocked_dates in share mode;
   perform 1 from public.courts where tenant_id=t and id=b.court_id and status='active' for share;
   if not found then raise exception 'reservation_court_unavailable' using errcode='22023';end if;
   perform slot.id from public.booking_slots slot where slot.tenant_id=t and slot.booking_id=b.id order by slot.starts_at,slot.id for update;
   select count(*),coalesce(sum(extract(epoch from(ends_at-starts_at))),0),min(starts_at),max(ends_at),
     count(*) filter(where status='held' and hold_expires_at>clock_timestamp())
   into target_count,target_duration,target_min,target_max,active_count from public.booking_slots where tenant_id=t and booking_id=b.id
     and(case when q.request_type='reschedule_adjustment' then balance_request_id=q.id else balance_request_id is null end);
   if b.metadata->'atomicMultiSessionBookingV1'='true'::jsonb and q.id is null then
     perform public.assert_picklestreet_group_slots(b.id);
   else
   if target_count<1 or target_duration<>extract(epoch from(target_end-target_start)) or target_min<>target_start or target_max<>target_end
     or exists(select 1 from public.booking_slots where tenant_id=t and booking_id=b.id
       and(case when q.request_type='reschedule_adjustment' then balance_request_id=q.id else balance_request_id is null end)
       and(status not in('held','expired') or court_id<>b.court_id or starts_at<target_start or ends_at>target_end))
     or exists(select 1 from public.booking_slots one join public.booking_slots two on two.tenant_id=one.tenant_id
       and two.booking_id=one.booking_id and two.id<>one.id and two.starts_at<one.ends_at and two.ends_at>one.starts_at
       where one.tenant_id=t and one.booking_id=b.id
       and(case when q.request_type='reschedule_adjustment' then one.balance_request_id=q.id and two.balance_request_id=q.id
         else one.balance_request_id is null and two.balance_request_id is null end)) then
     raise exception 'reservation_slots_changed' using errcode='22023';end if;
   if exists(select 1 from public.blocked_dates blocked where blocked.tenant_id=t and(blocked.court_id is null or blocked.court_id=b.court_id)
     and blocked.blocked_on between(target_start at time zone zone)::date and((target_end-interval '1 microsecond') at time zone zone)::date
     and tsrange(target_start at time zone zone,target_end at time zone zone,'[)') && case when blocked.starts_at is null then
       tsrange(blocked.blocked_on::timestamp,(blocked.blocked_on+1)::timestamp,'[)') else tsrange(blocked.blocked_on+blocked.starts_at,
       case when blocked.ends_at=time '23:59:59' then(blocked.blocked_on+1)::timestamp else blocked.blocked_on+blocked.ends_at end,'[)') end) then
     raise exception 'reservation_court_blocked' using errcode='22023';end if;
   if exists(select 1 from public.court_occupancies occupancy where occupancy.tenant_id=t and occupancy.court_id=b.court_id
     and occupancy.starts_at<target_end and occupancy.ends_at>target_start
     and(occupancy.status='confirmed' or(occupancy.status='held' and occupancy.hold_expires_at>clock_timestamp()))
     and not(occupancy.source_kind='booking_slot' and exists(select 1 from public.booking_slots own where own.tenant_id=t
       and own.booking_id=b.id and own.id=occupancy.source_id
       and(case when q.request_type='reschedule_adjustment' then own.balance_request_id=q.id else own.balance_request_id is null end)))) then
     raise exception 'reservation_time_unavailable' using errcode='22023';end if;
   end if;
   if target_start<=clock_timestamp() or b.starts_at<=clock_timestamp() then raise exception 'booking_started' using errcode='22023';end if;
   restored:=active_count<>target_count;
   if q.request_type='reschedule_adjustment' then
     if not exists(select 1 from public.booking_slots where tenant_id=t and booking_id=b.id and balance_request_id is null)
       or(select coalesce(sum(extract(epoch from(ends_at-starts_at))),0) from public.booking_slots where tenant_id=t and booking_id=b.id and balance_request_id is null)<>extract(epoch from(b.ends_at-b.starts_at))
       or exists(select 1 from public.booking_slots where tenant_id=t and booking_id=b.id and balance_request_id is null
         and(status<>'confirmed' or court_id<>b.court_id or starts_at<b.starts_at or ends_at>b.ends_at)) then
       raise exception 'original_booking_changed' using errcode='22023';end if;
     insert into public.booking_reschedule_events(tenant_id,booking_id,court_id,rescheduled_by,reason_code,public_reason,internal_note,notify_customer,
       customer_email_snapshot,old_starts_at,old_ends_at,new_starts_at,new_ends_at,subtotal_amount,service_fee_amount,total_amount,currency,idempotency_key,email_status)
     values(t,b.id,b.court_id,p_actor_user_id,q.request_details->>'reasonCode',q.request_details->>'publicReason',nullif(q.request_details->>'internalNote',''),
       coalesce((q.request_details->>'notifyCustomer')::boolean,false),nullif(lower(btrim(b.customer_email)),''),b.starts_at,b.ends_at,target_start,target_end,
       new_subtotal,b.service_fee_amount,new_total,b.currency,(q.request_details->>'idempotencyKey')::uuid,'not_requested') returning * into e;
     reschedule_id:=e.id;
     delete from public.booking_slots where tenant_id=t and booking_id=b.id and balance_request_id is null;
     update public.booking_slots set status='confirmed',hold_expires_at=null,balance_request_id=null where tenant_id=t and booking_id=b.id and balance_request_id=q.id;
     update public.bookings set starts_at=target_start,ends_at=target_end,local_booking_date=(q.request_details->>'newLocalDate')::date,
       subtotal_amount=new_subtotal,total_amount=new_total,metadata=metadata||jsonb_build_object('lastReschedule',jsonb_build_object(
         'eventId',e.id,'reasonCode',e.reason_code,'publicReason',e.public_reason,'rescheduledBy',p_actor_user_id,'rescheduledAt',e.created_at,
         'oldStartsAt',e.old_starts_at,'oldEndsAt',e.old_ends_at,'newStartsAt',e.new_starts_at,'newEndsAt',e.new_ends_at,
         'priceAdjustmentAmount',q.remaining_amount,'staffReceiptReviewId',d.id)) where tenant_id=t and id=b.id;
   else
     update public.booking_slots set status='confirmed',hold_expires_at=null where tenant_id=t and booking_id=b.id and balance_request_id is null;
     update public.bookings set status='confirmed',payment_status='paid',confirmed_at=now(),expires_at=null where tenant_id=t and id=b.id;
   end if;
   update public.receipt_verifications set status='approved',reviewed_at=now(),reviewed_by=p_actor_user_id,
     extracted_data=extracted_data||jsonb_build_object('review',jsonb_build_object('decision','approved','note',v_note),
       'staffReview',jsonb_build_object('reviewId',d.id,'decision','approve','note',v_note,'actorUserId',p_actor_user_id)) where tenant_id=t and id=r.id;
   update public.payment_sessions set status='paid',provider_payload=provider_payload||jsonb_build_object('staffReceiptReviewId',d.id) where tenant_id=t and id=s.id;
   if q.id is not null then
     update public.booking_balance_requests set status='settled',settled_at=now() where tenant_id=t and id=q.id;
     update public.picklestreet_balance_receipt_jobs set settled_at=now(),closed_at=now(),reschedule_event_id=reschedule_id where tenant_id=t and balance_request_id=q.id;
   end if;
 else
   -- Reject only this proof/payment case. Accepted funds are never reversed.
   update public.receipt_verifications set status='rejected',reviewed_at=now(),reviewed_by=p_actor_user_id,
     extracted_data=extracted_data||jsonb_build_object('review',jsonb_build_object('decision','rejected','note',v_note),
       'staffReview',jsonb_build_object('reviewId',d.id,'decision','reject','note',v_note,'actorUserId',p_actor_user_id)) where tenant_id=t and id=r.id;
   update public.payment_sessions set status='failed',provider_payload=provider_payload||jsonb_build_object('staffReceiptReviewId',d.id,'staffRejectionNote',v_note) where tenant_id=t and id=s.id;
   if q.id is null then
     update public.booking_slots set status='cancelled',hold_expires_at=null where tenant_id=t and booking_id=b.id and balance_request_id is null and status in('held','expired');
     update public.bookings set status='cancelled',payment_status='rejected',cancelled_at=now(),expires_at=null,
       metadata=metadata||jsonb_build_object('staffReceiptReviewId',d.id,'paymentRejectionReason',v_note) where tenant_id=t and id=b.id;
   else
     update public.booking_balance_requests set status='cancelled',settled_at=null where tenant_id=t and id=q.id;
     update public.booking_slots set status='cancelled',hold_expires_at=null where tenant_id=t and booking_id=b.id
       and(case when q.request_type='reschedule_adjustment' then balance_request_id=q.id else balance_request_id is null end) and status in('held','expired');
     update public.picklestreet_balance_receipt_jobs set closed_at=now(),hold_released_at=coalesce(hold_released_at,now()) where tenant_id=t and balance_request_id=q.id;
     if q.request_type='short_payment' then
       update public.bookings set status='expired',expires_at=now(),metadata=metadata||jsonb_build_object('staffReceiptReviewId',d.id,'balanceRejectionReason',v_note)
       where tenant_id=t and id=b.id;
     end if;
   end if;
 end if;
 -- Invalidate OCR leases without rewriting immutable receipt-attempt history.
 if q.id is null then
   update public.picklestreet_receipt_jobs set lease_token=null,lease_until=null,updated_at=now() where tenant_id=t and booking_id=b.id;
 else
   update public.picklestreet_balance_receipt_jobs set lease_token=null,lease_until=null,updated_at=now() where tenant_id=t and balance_request_id=q.id;
 end if;
 select * into r from public.receipt_verifications where tenant_id=t and id=r.id;
 select * into b from public.bookings where tenant_id=t and id=b.id;
 if q.id is not null then select * into q from public.booking_balance_requests where tenant_id=t and id=q.id;end if;
 v_result:=jsonb_build_object('ok',true,'status',r.status,'receiptStatus',r.status,'verificationId',r.id,'reviewId',d.id,'decision',p_decision,
   'bookingReference',b.reference,'bookingStatus',b.status,'paymentStatus',b.payment_status,'balanceRequestId',q.id,
   'requestType',q.request_type,'balanceStatus',q.status,'rescheduleEventId',reschedule_id,'reservationRestored',restored,
   'reviewedBy',p_actor_user_id,'reviewedAt',r.reviewed_at,'reviewNote',v_note);
 update public.picklestreet_receipt_staff_reviews set result=v_result,completed_at=clock_timestamp() where tenant_id=t and id=d.id;
 perform set_config('app.picklestreet_staff_review',coalesce(prior_marker,''),true);
 perform set_config('request.jwt.claims',coalesce(prior_claims,''),true);perform set_config('request.jwt.claim.sub',coalesce(prior_sub,''),true);
 return v_result;
end;$function$
;
CREATE OR REPLACE FUNCTION public.guard_picklestreet_group_schedule()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
 if old.tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a' and old.metadata->'atomicMultiSessionBookingV1'='true'::jsonb
  and(new.court_id is distinct from old.court_id or new.starts_at is distinct from old.starts_at or new.ends_at is distinct from old.ends_at
   or new.metadata->'sessions' is distinct from old.metadata->'sessions') then
  raise exception 'Multi-session bookings require a grouped reschedule; a single-court change is not allowed.' using errcode='22023';end if;
 return new;
end;$function$
;
CREATE OR REPLACE FUNCTION public.dispatch_picklestreet_rejection_emails()
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare dispatch_secret text; request_id bigint;
begin
  if not exists(select 1 from public.picklestreet_rejection_emails
    where tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a' and status<>'sent'
      and (lease_until is null or lease_until<now())) then return null;end if;
  select decrypted_secret into strict dispatch_secret from vault.decrypted_secrets
    where name='picklestreet_email_dispatch_secret';
  select net.http_post(
    url:='https://neqvrwtofiolcuxewdze.supabase.co/functions/v1/picklestreet-email-dispatch',
    headers:=jsonb_build_object('Content-Type','application/json','x-dispatch-secret',dispatch_secret),
    body:='{}'::jsonb,timeout_milliseconds:=30000
  ) into request_id;
  return request_id;
end;$function$
;
drop function public.list_due_picklestreet_group_reschedule_emails();
create or replace function public.run_picklestreet_balance_hold_cleanup() returns integer
language plpgsql security definer set search_path='' set row_security=off set lock_timeout='1000ms' as $$
begin return public.expire_picklestreet_balance_receipt_holds(null);end;$$;
drop function public.expire_picklestreet_group_unsubmitted_reschedules();
alter table public.booking_reschedule_events drop constraint booking_reschedule_events_intervals_valid;
alter table public.booking_reschedule_events add constraint booking_reschedule_events_intervals_valid check(old_ends_at>old_starts_at and new_ends_at>new_starts_at and old_ends_at-old_starts_at=new_ends_at-new_starts_at);
drop function public.picklestreet_group_event_intervals_valid(uuid,uuid,uuid,timestamptz,timestamptz,timestamptz,timestamptz);
drop function public.apply_picklestreet_group_reschedule(uuid,uuid,jsonb,text,text,text,text,text,boolean,uuid,uuid,text);
drop function public.preview_picklestreet_group_reschedule(uuid,uuid,jsonb,text,text);
drop function public.options_picklestreet_group_reschedule(uuid,uuid,text,date,text);
drop function public.get_picklestreet_group_reschedule(uuid,uuid);
drop function public.commit_picklestreet_group_reschedule(uuid);
drop function public.assert_picklestreet_group_target(uuid,jsonb,jsonb,boolean);
drop function public.picklestreet_group_schedule_snapshot(uuid);
drop function public.assert_picklestreet_group_reschedule_actor(uuid);
drop table public.picklestreet_group_reschedule_events;
drop table public.picklestreet_group_reschedule_requests;
commit;
