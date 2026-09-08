begin;

-- A duplicate is an accepted transaction in the same reference namespace,
-- never merely the same digits from a different payment provider. Reuse the
-- reference claims and lock order installed by 005 without changing them.
create or replace function public.reject_picklestreet_duplicate(p_attempt_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 t constant uuid:='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';
 a public.picklestreet_receipt_attempts%rowtype;
 b public.bookings%rowtype;
 r public.receipt_verifications%rowtype;
 ref text; source text; route jsonb; item jsonb; refs jsonb:='[]'; claim record;
 duplicate_found boolean:=false; expected_kind text; evidence jsonb;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED' using errcode='42501';end if;
 select * into a from public.picklestreet_receipt_attempts where tenant_id=t and id=p_attempt_id;
 if not found then return jsonb_build_object('rejected',false);end if;
 select * into b from public.bookings where tenant_id=t and id=a.booking_id for update;
 if not found then return jsonb_build_object('rejected',false);end if;
 if b.metadata->>'duplicateReferenceRejected'='true' then
   return jsonb_build_object('rejected',true,'bookingReference',b.reference,'bookingId',b.id,'status','rejected','bookingStatus','cancelled','paymentStatus','rejected');
 end if;
 if b.status not in ('payment_review','pending_payment','expired') or b.payment_status<>'pending'
   or a.completed_at is null or a.outcome<>'pending' then return jsonb_build_object('rejected',false);end if;
 perform 1 from public.picklestreet_receipt_jobs where tenant_id=t and booking_id=b.id and current_attempt_id=a.id for update;
 if not found then return jsonb_build_object('rejected',false);end if;
 select * into r from public.receipt_verifications where tenant_id=t and booking_id=b.id and id=a.receipt_id for update;
 if not found or r.balance_request_id is not null or r.status not in ('pending','manual_review') then return jsonb_build_object('rejected',false);end if;

 -- A parsed value is not reliable when its dedicated parser explicitly says
 -- the reference/invoice is unreadable or ambiguous (notably Maya InstaPay).
 if (a.error_code is not null and a.error_code not in('duplicate_payment_route_reference','duplicate_payment_reference'))
   or exists(select 1 from unnest(coalesce(a.flags,'{}'::text[])) flag
     where (upper(flag) ~ '(REF|REFERENCE|INVOICE)' and upper(flag) ~ '(AMBIGUOUS|UNREADABLE|UNVERIFIED|MISMATCH|INVALID|MISSING|UNAVAILABLE)')
       or lower(flag) in('receipt_parser_unavailable','verification_unavailable','tenant_context_invalid','native_ocr_confidence_missing'))
 then return jsonb_build_object('rejected',false);end if;

 source:=public.picklestreet_source_provider(a.payment_method);
 ref:=regexp_replace(upper(coalesce(a.payment_reference,'')),'[^A-Z0-9]','','g');
 evidence:=a.extracted_data;
 route:=evidence#>'{detected,route}';
 -- An OCR error, source mismatch or unknown receiver is not proof of reuse.
 -- Amount/timing failures do not change the identity of a proven transaction.
 if source is null or source not in('gcash','bdopay','maya','bpi','gotyme','maribank')
   or length(ref) not between 6 and 64
   or ref is distinct from regexp_replace(upper(coalesce(a.submitted_reference,'')),'[^A-Z0-9]','','g')
   or ref is distinct from regexp_replace(upper(coalesce(evidence#>>'{detected,paymentReference}','')),'[^A-Z0-9]','','g')
   or evidence->>'provider' is distinct from 'google_vision'
   or jsonb_typeof(evidence#>'{confidence,vision}') is distinct from 'number'
   or (case when jsonb_typeof(evidence#>'{confidence,vision}')='number' then (evidence#>>'{confidence,vision}')::numeric not between 0.9 and 1 else true end)
   or jsonb_typeof(route) is distinct from 'object'
   or route->>'schemaVersion' is distinct from '1'
   or route->>'sourceProvider' is distinct from source
   or route->>'routeId' is distinct from source||'_to_gcash'
   or route->>'destinationProvider' is distinct from 'gcash'
   or route->>'destinationMethodCode' is distinct from 'gcash'
   or route->>'parserVersion' is distinct from (case when source='gcash' then 'gcash_v1' else source||'_to_gcash_v1' end)
   or route->'sourceMatched' is distinct from 'true'::jsonb
   or route->'destinationMatched' is distinct from 'true'::jsonb
   or route->'recipientMatched' is distinct from 'true'::jsonb
   or route->'referenceMatched' is distinct from 'true'::jsonb
   or route->'successMatched' is distinct from 'true'::jsonb
 then return jsonb_build_object('rejected',false);end if;
 if not exists(select 1 from public.payment_sessions ps where ps.tenant_id=t and ps.booking_id=b.id and ps.id=r.payment_session_id
   and public.picklestreet_source_provider(ps.provider_payload->>'paymentMethod')=source
   and regexp_replace(upper(coalesce(ps.provider_payload->>'submittedReference','')),'[^A-Z0-9]','','g')=ref)
 then return jsonb_build_object('rejected',false);end if;
 if jsonb_typeof(route->'secondaryReferences') is distinct from 'array' then return jsonb_build_object('rejected',false);end if;
 if jsonb_array_length(route->'secondaryReferences')<>(case when source='gcash' then 0 else 1 end)
 then return jsonb_build_object('rejected',false);end if;
 expected_kind:=case source when 'bdopay' then 'bdopay_invoice' when 'bpi' then 'bpi_transaction'
   when 'maya' then 'maya_instapay' else 'instapay' end;
 for item in select value from jsonb_array_elements(route->'secondaryReferences') loop
   if jsonb_typeof(item) is distinct from 'object' or item->>'kind' is distinct from expected_kind
     or jsonb_typeof(item->'value') is distinct from 'string' or item->>'value' !~ '^[A-Z0-9]{3,64}$'
     or exists(select 1 from jsonb_object_keys(item) k where k not in('kind','value'))
   then return jsonb_build_object('rejected',false);end if;
   refs:=refs||jsonb_build_array(jsonb_build_object('namespace',case when expected_kind='maya_instapay' then 'instapay' else expected_kind end,'value',item->>'value'));
 end loop;
 refs:=refs||jsonb_build_array(jsonb_build_object('namespace',source||'.primary','value',ref));
 -- The same deterministic namespace/hash locks as accepted-reference claims.
 for claim in select distinct value->>'namespace' as namespace,encode(extensions.digest(value->>'value','sha256'),'hex') as hash
   from jsonb_array_elements(refs) order by 1,2 loop
   perform pg_advisory_xact_lock(hashtextextended('picklestreet-route-reference:'||claim.namespace||':'||claim.hash,0));
   if exists(select 1 from public.picklestreet_receipt_reference_claims c
     join public.receipt_verifications prior on prior.tenant_id=t and prior.id=c.verification_id and prior.booking_id=c.booking_id
     join public.payment_sessions ps on ps.tenant_id=t and ps.id=prior.payment_session_id and ps.booking_id=prior.booking_id
     where c.tenant_id=t and c.namespace=claim.namespace and c.reference_hash=claim.hash
       and c.booking_id<>b.id and prior.status in('approved','auto_approved') and ps.status='paid')
   then duplicate_found:=true;end if;
 end loop;
 if not duplicate_found then return jsonb_build_object('rejected',false);end if;

 perform set_config('app.picklestreet_duplicate_reject',r.id::text,true);
 update public.receipt_verifications set status='rejected',flags=array['duplicate_payment_reference'],reviewed_at=now(),
   extracted_data=extracted_data||jsonb_build_object('automaticRejection','duplicate_payment_reference') where tenant_id=t and id=r.id;
 update public.payment_sessions set status='failed' where tenant_id=t and id=r.payment_session_id and status<>'paid';
 update public.booking_slots set status='cancelled',hold_expires_at=null where tenant_id=t and booking_id=b.id and status in ('held','expired');
 update public.bookings set status='cancelled',payment_status='rejected',cancelled_at=now(),expires_at=null,
   metadata=metadata||jsonb_build_object('duplicateReferenceRejected',true,'paymentRejectionReason','This payment reference has already been used for another booking.') where tenant_id=t and id=b.id;
 update public.picklestreet_receipt_jobs set lease_token=null,lease_until=null where tenant_id=t and booking_id=b.id;
 insert into public.picklestreet_rejection_emails(tenant_id,booking_id,receipt_id) values(t,b.id,r.id) on conflict do nothing;
 return jsonb_build_object('rejected',true,'bookingReference',b.reference,'bookingId',b.id,'status','rejected','bookingStatus','cancelled','paymentStatus','rejected','flags',jsonb_build_array('duplicate_payment_reference'));
end;$$;
revoke all on function public.reject_picklestreet_duplicate(uuid) from public,anon,authenticated;
grant execute on function public.reject_picklestreet_duplicate(uuid) to service_role;
commit;
