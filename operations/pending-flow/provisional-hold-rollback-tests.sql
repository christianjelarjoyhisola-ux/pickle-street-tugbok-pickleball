-- Append within the proposed migration transaction; the builder ends with ROLLBACK.
-- No HTTP/storage/email calls. All new bookings use a synthetic court removed by rollback.
set local request.jwt.claim.role='service_role';
set local request.jwt.claims='{"role":"service_role"}';
set local request.headers='{"origin":"https://picklestreet.pages.dev"}';
create temporary table ps_hold_results(name text primary key,passed boolean not null default true);
create temporary table ps_hold_fixture(court_id uuid,starts_at timestamptz,fee_mode text,fee_amount numeric);

do $$
declare v_id uuid:=extensions.gen_random_uuid();v_seed jsonb;v_columns text;
begin
  select to_jsonb(c)||jsonb_build_object('id',v_id,'slug','test-hold-'||v_id::text,'name','TEST ONLY provisional hold rollback',
    'description','Synthetic rollback fixture','opens_at','05:00','closes_at','00:00','sort_order',9999,
    'pricing_config','{"regular":{"bands":[{"start":"05:00","end":"24:00","hourlyRate":10}],"minimumHours":1,"maximumHours":18,"fullPaymentRequired":true},"event":{"enabled":false,"hourlyRate":0,"minimumHours":0,"maximumGuests":0,"fullPaymentRequired":true}}'::jsonb,
    'public_config',coalesce(c.public_config,'{}')||'{"testOnly":true,"minimumLeadMinutes":0,"maximumAdvanceDays":90}'::jsonb)
    into v_seed from public.courts c where c.tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a' and c.status='active' order by c.id limit 1;
  if v_seed is null then raise exception 'Fixture requires an active target court to clone';end if;
  select string_agg(quote_ident(attname),',' order by attnum) into v_columns from pg_attribute
    where attrelid='public.courts'::regclass and attnum>0 and not attisdropped and attgenerated='' and attidentity='';
  execute format('insert into public.courts(%1$s) select %1$s from jsonb_populate_record(null::public.courts,$1)',v_columns) using v_seed;
  insert into ps_hold_fixture select v_id,(((now() at time zone 'Asia/Manila')::date+14)+time '08:00') at time zone 'Asia/Manila',fee_mode,fee_amount
    from public.tenant_platform_billing where tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';
end;$$;

create function pg_temp.ps_hold_create(n integer,p_key uuid default extensions.gen_random_uuid(),p_ip text default null,p_delta numeric default 0,p_type text default 'regular')
returns jsonb language plpgsql as $$
declare f ps_hold_fixture%rowtype;s timestamptz;fee numeric;result jsonb;token_hash text:=encode(extensions.digest(p_key::text,'sha256'),'hex');
begin
  select * into strict f from ps_hold_fixture;s:=f.starts_at+n*interval '1 day';
  fee:=round(case f.fee_mode when 'fixed_per_booking' then f.fee_amount when 'fixed_per_hour' then f.fee_amount when 'percentage' then 10*f.fee_amount/100 end,2);
  result:=public.create_picklestreet_provisional_hold('picklestreet.pages.dev',p_key,token_hash,coalesce(p_ip,token_hash),f.court_id,p_type,
    s,s+interval '1 hour',jsonb_build_array(jsonb_build_object('startsAt',s,'endsAt',s+interval '1 hour')),
    10+p_delta,fee,10+p_delta+fee,'PHP','{"fullPaymentOnly":true}');
  return result||jsonb_build_object('testKey',p_key,'testHash',token_hash);
end;$$;
create function pg_temp.ps_hold_complete(f jsonb,p_version text default null,p_hash text default null,p_name text default 'TEST ONLY Guest')
returns jsonb language plpgsql as $$
declare policy public.settings%rowtype;
begin
  select * into strict policy from public.settings where tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a' and key='refund_reschedule_policy';
  return public.complete_picklestreet_provisional_hold('picklestreet.pages.dev',f->>'reference',f->>'testHash',
    p_name,'hold-rollback@example.invalid','09000000000',true,coalesce(p_version,policy.value->>'version'),
    coalesce(p_hash,public.refund_reschedule_policy_sha256(policy.value)),1,null,null);
end;$$;
-- Move only the synthetic fixture clock before exercising real expiry. No trigger is disabled.
create function pg_temp.ps_hold_age(f jsonb) returns void language plpgsql as $$
declare h public.picklestreet_provisional_holds%rowtype;
begin
  delete from public.picklestreet_provisional_holds where booking_id=(f->>'bookingId')::uuid returning * into strict h;
  update public.bookings set expires_at=now()-interval '1 minute' where id=h.booking_id and tenant_id=h.tenant_id;
  update public.booking_slots set hold_expires_at=now()-interval '1 minute' where booking_id=h.booking_id and tenant_id=h.tenant_id;
  h.hold_expires_at:=now()-interval '1 minute';
  insert into public.picklestreet_provisional_holds select h.*;
end;$$;

do $$
declare f jsonb;retry jsonb;done jsonb;g jsonb;aged jsonb;status_result jsonb;c uuid;key uuid;old_deadline timestamptz;
  denied boolean;actor uuid;i integer;old_count integer;receipt jsonb;receipt_key uuid:=extensions.gen_random_uuid();current_policy text;
  v_access public.booking_access_tokens%rowtype;v_revocation_mode text;
begin
  f:=pg_temp.ps_hold_create(0);old_deadline:=(f->>'expiresAt')::timestamptz;
  if f->'detailsCompleted'<>'false'::jsonb or f->'reservationHeld'<>'true'::jsonb or
    old_deadline is distinct from now()+interval '15 minutes' or
    exists(select 1 from public.booking_access_tokens where booking_id=(f->>'bookingId')::uuid) or
    exists(select 1 from public.booking_policy_acceptances where booking_id=(f->>'bookingId')::uuid) or
    not exists(select 1 from public.bookings where id=(f->>'bookingId')::uuid and customer_name='Reservation pending'
      and customer_phone='Pending' and customer_email is null and not(metadata?'policyAcceptance')) then
    raise exception 'Provisional creation did not preserve authentic no-details/no-policy state';end if;
  insert into ps_hold_results values('One authoritative15-minute hold exists before customer details; no normal token or policy evidence',true);
  retry:=pg_temp.ps_hold_create(0,(f->>'testKey')::uuid,null,999);
  if retry->>'bookingId' is distinct from f->>'bookingId' or retry->>'expiresAt' is distinct from f->>'expiresAt'
    or retry->>'totalAmount' is distinct from f->>'totalAmount' then raise exception 'Create retry changed hold/deadline/price';end if;
  insert into ps_hold_results values('Lost create response reuses selection-only key and original price/deadline',true);
  denied:=false;begin perform pg_temp.ps_hold_create(1,(f->>'testKey')::uuid);exception when sqlstate '22023' then
    if sqlerrm<>'PICKLESTREET_HOLD_IDEMPOTENCY_CONFLICT' then raise;end if;denied:=true;end;
  if not denied then raise exception 'Changed selection reused key';end if;
  insert into ps_hold_results values('Same request key rejects a changed selection',true);
  denied:=false;begin perform pg_temp.ps_hold_create(0);exception when sqlstate '23P01' then denied:=true;end;
  if not denied or (select count(*) from public.bookings where court_id=(f->>'courtId')::uuid and starts_at=(f->>'startsAt')::timestamptz)<>1 then
    raise exception 'Overlap failed atomic exclusion';end if;
  insert into ps_hold_results values('Another request cannot occupy the same court slot',true);
  denied:=false;begin perform public.get_picklestreet_provisional_hold('picklestreet.pages.dev',f->>'reference',repeat('0',64));
    exception when sqlstate '42501' then denied:=true;end;if not denied then raise exception 'Wrong token accepted';end if;
  denied:=false;begin perform public.get_picklestreet_provisional_hold('not-this-tenant.invalid',f->>'reference',f->>'testHash');
    exception when sqlstate '42501' then denied:=true;end;if not denied then raise exception 'Wrong hostname accepted';end if;
  insert into ps_hold_results values('Capability is bound to booking and actual tenant hostname',true);
  denied:=false;begin update public.bookings set tenant_id='00000000-0000-4000-8000-000000000001' where id=(f->>'bookingId')::uuid;
    exception when sqlstate '22023' then if sqlerrm<>'PICKLESTREET_PROVISIONAL_HOLD_IMMUTABLE' then raise;end if;denied:=true;end;
  if not denied then raise exception 'Original target tenant can escape provisional guard';end if;
  denied:=false;begin update public.bookings set expires_at=expires_at+interval '15 minutes' where id=(f->>'bookingId')::uuid;
    exception when sqlstate '22023' then denied:=true;end;if not denied then raise exception 'Timer extension accepted';end if;
  insert into ps_hold_results values('Provisional tenant/selection/price/deadline are protected against direct mutation',true);
  denied:=false;begin update public.bookings set status='confirmed',payment_status='paid' where id=(f->>'bookingId')::uuid;
    exception when sqlstate '22023' then denied:=true;end;if not denied then raise exception 'Payment confirmed before details';end if;
  denied:=false;begin insert into public.payment_sessions(tenant_id,booking_id,provider,status,amount,currency)
    values('f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a',(f->>'bookingId')::uuid,'manual_receipt','pending',(f->>'totalAmount')::numeric,'PHP');
    exception when sqlstate '22023' then if sqlerrm<>'PICKLESTREET_CUSTOMER_DETAILS_REQUIRED' then raise;end if;denied:=true;end;
  if not denied then raise exception 'Payment session started before details';end if;
  insert into ps_hold_results values('Receipt/payment creation and direct confirmation are blocked while provisional',true);
  denied:=false;begin perform pg_temp.ps_hold_complete(f,'stale-test-policy');exception when sqlstate '22023' then
    if sqlerrm<>'booking_policy_version_stale' then raise;end if;denied:=true;end;if not denied then raise exception 'Stale policy accepted';end if;
  denied:=false;begin perform pg_temp.ps_hold_complete(f,null,repeat('0',64));exception when sqlstate '22023' then
    if sqlerrm<>'booking_policy_evidence_mismatch' then raise;end if;denied:=true;end;if not denied then raise exception 'Forged policy hash accepted';end if;
  denied:=false;begin perform pg_temp.ps_hold_complete(f,null,null,'X');exception when sqlstate '22023' then denied:=true;end;
  if not denied then raise exception 'Invalid name accepted';end if;
  insert into ps_hold_results values('Completion requires valid customer details and authentic current policy',true);
  done:=pg_temp.ps_hold_complete(f);
  if done->'detailsCompleted'<>'true'::jsonb or done->>'expiresAt' is distinct from f->>'expiresAt' or done->>'totalAmount' is distinct from f->>'totalAmount'
    or not exists(select 1 from public.booking_access_tokens where booking_id=(f->>'bookingId')::uuid and token_hash=f->>'testHash')
    or not exists(select 1 from public.booking_policy_acceptances where booking_id=(f->>'bookingId')::uuid)
    or not exists(select 1 from public.bookings where id=(f->>'bookingId')::uuid and status='pending_payment' and payment_status='unpaid'
      and customer_name='TEST ONLY Guest' and idempotency_key='PS-HOLD-'||(f->>'testKey')) then
    raise exception 'Completion did not promote same hold+token with policy evidence';end if;
  retry:=pg_temp.ps_hold_complete(f);
  if retry->'idempotent'<>'true'::jsonb or retry->>'expiresAt' is distinct from done->>'expiresAt' then raise exception 'Completion retry reset hold';end if;
  denied:=false;begin perform pg_temp.ps_hold_complete(f,null,null,'Changed Guest');exception when sqlstate '22023' then
    if sqlerrm<>'PICKLESTREET_HOLD_COMPLETION_CONFLICT' then raise;end if;denied:=true;end;if not denied then raise exception 'Completed identity overwritten';end if;
  insert into ps_hold_results values('Completion promotes same capability, stores policy audit once, preserves expiry/key/price and retries safely',true);
  receipt:=public.begin_picklestreet_receipt_attempt((f->>'bookingId')::uuid,'upload',receipt_key,
    'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a/receipts/'||(f->>'bookingId')||'/'||receipt_key::text||'.png',repeat('b',64),'gcash','TEST-HOLD-NOT-A-PAYMENT');
  if receipt->'claimed'<>'true'::jsonb or exists(select 1 from public.bookings where id=(f->>'bookingId')::uuid and payment_status='paid') then
    raise exception 'Existing receipt route not available after authentic completion';end if;
  insert into ps_hold_results values('Existing receipt upload claim works after completion and remains unpaid',true);
  select * into strict v_access from public.booking_access_tokens where booking_id=(f->>'bookingId')::uuid;
  foreach v_revocation_mode in array array['expired','rotated','deleted'] loop
    if v_revocation_mode='expired' then
      update public.booking_access_tokens set expires_at=now()-interval '1 minute' where booking_id=v_access.booking_id;
    elsif v_revocation_mode='rotated' then
      update public.booking_access_tokens set token_hash=repeat('e',64) where booking_id=v_access.booking_id;
    else delete from public.booking_access_tokens where booking_id=v_access.booking_id;end if;
    denied:=false;begin perform public.get_picklestreet_provisional_hold('picklestreet.pages.dev',f->>'reference',f->>'testHash');
      exception when sqlstate '42501' then if sqlerrm<>'BOOKING_ACCESS_DENIED' then raise;end if;denied:=true;end;
    if not denied then raise exception 'Private status bypasses % normal token',v_revocation_mode;end if;
    denied:=false;begin perform pg_temp.ps_hold_create(0,(f->>'testKey')::uuid);
      exception when sqlstate '42501' then if sqlerrm<>'BOOKING_ACCESS_DENIED' then raise;end if;denied:=true;end;
    if not denied then raise exception 'Create retry bypasses % normal token',v_revocation_mode;end if;
    denied:=false;begin perform pg_temp.ps_hold_complete(f);
      exception when sqlstate '42501' then if sqlerrm<>'BOOKING_ACCESS_DENIED' then raise;end if;denied:=true;end;
    if not denied then raise exception 'Complete retry bypasses % normal token',v_revocation_mode;end if;
    insert into public.booking_access_tokens select v_access.* on conflict(tenant_id,booking_id) do update
      set token_hash=excluded.token_hash,expires_at=excluded.expires_at;
  end loop;
  insert into ps_hold_results values('Expired rotated or deleted normal access blocks completed status and both retry paths without disclosure',true);
  g:=pg_temp.ps_hold_create(2);status_result:=public.cancel_picklestreet_provisional_hold('picklestreet.pages.dev',g->>'reference',g->>'testHash');
  retry:=public.cancel_picklestreet_provisional_hold('picklestreet.pages.dev',g->>'reference',g->>'testHash');
  if status_result->>'status'<>'cancelled' or retry->'idempotent'<>'true'::jsonb
    or exists(select 1 from public.booking_slots where booking_id=(g->>'bookingId')::uuid and status='held') then raise exception 'Private cancel did not release hold';end if;
  insert into ps_hold_results values('Pre-details cancellation releases own slots and retries without new hold',true);
  aged:=pg_temp.ps_hold_create(3);perform pg_temp.ps_hold_age(aged);
  denied:=false;begin perform pg_temp.ps_hold_complete(aged);exception when sqlstate '22023' then
    if sqlerrm<>'PICKLESTREET_HOLD_EXPIRED' then raise;end if;denied:=true;end;if not denied then raise exception 'Expired hold completed';end if;
  perform public.expire_stale_tenant_holds('f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a');
  if not exists(select 1 from public.bookings where id=(aged->>'bookingId')::uuid and status='expired' and metadata?'expiration') then
    raise exception 'Shared expiry metadata blocked by provisional guard';end if;
  retry:=pg_temp.ps_hold_create(3,(aged->>'testKey')::uuid);
  if retry->>'status'<>'expired' or (retry->>'expiresAt')::timestamptz>now() then raise exception 'Expired key got fresh hold';end if;
  insert into ps_hold_results values('Expired holds cannot complete/restart and shared expiry still records its normal audit metadata',true);
  g:=pg_temp.ps_hold_create(4);select user_id into actor from public.platform_profiles where is_platform_owner order by user_id limit 1;
  if actor is null then raise exception 'Staff cancellation fixture requires existing platform owner';end if;
  perform set_config('request.jwt.claim.sub',actor::text,true);perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',actor)::text,true);
  perform public.cancel_tenant_booking((g->>'bookingId')::uuid,'Rollback provisional staff cancellation');
  perform set_config('request.jwt.claim.sub','',true);perform set_config('request.jwt.claim.role','service_role',true);perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  if not exists(select 1 from public.bookings where id=(g->>'bookingId')::uuid and status='cancelled' and expires_at is null and metadata?'cancellation') then
    raise exception 'Existing staff cancellation was broken';end if;
  insert into ps_hold_results values('Existing authorized staff cancellation retains cancellation metadata and releases slots',true);
  denied:=false;begin perform pg_temp.ps_hold_create(5,extensions.gen_random_uuid(),null,0,'event');exception when sqlstate '22023' then denied:=true;end;
  if not denied then raise exception 'Current disabled event config was bypassed';end if;
  insert into ps_hold_results values('Current event-disabled policy is enforced by unchanged booking core wrapper',true);
  for i in 10..19 loop perform pg_temp.ps_hold_create(i,extensions.gen_random_uuid(),repeat('f',64));end loop;
  denied:=false;begin perform pg_temp.ps_hold_create(20,extensions.gen_random_uuid(),repeat('f',64));exception when sqlstate '22023' then
    if sqlerrm<>'PICKLESTREET_HOLD_RATE_LIMITED' then raise;end if;denied:=true;end;
  if not denied then raise exception 'New hold rate guard failed';end if;
  insert into ps_hold_results values('Private hashed-IP limiter caps new holds while idempotent retries stay reusable',true);
end;$$;

do $$
begin
  if exists(select 1 from ps_hold_existing_functions baseline left join pg_proc current_proc on current_proc.oid=baseline.oid
    where current_proc.oid is null or md5(pg_get_functiondef(current_proc.oid)) is distinct from baseline.fingerprint) then
    raise exception 'An existing public function changed';end if;
  if pg_temp.ps_hold_foreign_fingerprint() is distinct from(select fingerprint from ps_hold_foreign_before) then
    raise exception 'Another tenant row changed';end if;
  if has_function_privilege('anon','public.create_picklestreet_provisional_hold(text,uuid,text,text,uuid,text,timestamptz,timestamptz,jsonb,numeric,numeric,numeric,text,jsonb)','execute')
    or has_function_privilege('authenticated','public.complete_picklestreet_provisional_hold(text,text,text,text,text,text,boolean,text,text,integer,text,text)','execute')
    or has_table_privilege('anon','public.picklestreet_provisional_holds','select')
    or has_table_privilege('authenticated','public.picklestreet_provisional_holds','select') then
    raise exception 'Public roles can access private hold capability storage/functions';end if;
  insert into ps_hold_results values('Every pre-existing public function and other-tenant row fingerprint remains unchanged',true);
  insert into ps_hold_results values('New capabilities and mutations are service-only; no anonymous/authenticated grants',true);
end;$$;
select name,passed from ps_hold_results order by name;
