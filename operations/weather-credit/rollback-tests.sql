create temp table wc_results(name text primary key,passed boolean);
delete from public.blocked_dates where tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';
create function pg_temp.wc_token(ref text) returns text language sql as $$ select lpad(ref,43,'x'); $$;
create function pg_temp.wc_target(n integer,c uuid,minutes integer default 60) returns uuid language plpgsql as $$
declare b uuid:=pg_temp.ps_booking(n);
begin
 update public.bookings set court_id=c,customer_email='weather-test@example.invalid',starts_at=starts_at+(n-9800)*interval '3 hours',ends_at=starts_at+(n-9800)*interval '3 hours'+make_interval(mins=>minutes) where id=b;
 update public.booking_slots set court_id=c,starts_at=starts_at+(n-9800)*interval '3 hours',ends_at=starts_at+(n-9800)*interval '3 hours'+make_interval(mins=>minutes) where booking_id=b;
 update public.bookings set metadata=metadata||jsonb_build_object('policyAcceptance',jsonb_build_object('accepted',true,'version',policy.value->>'version','sha256',public.refund_reschedule_policy_sha256(policy.value)))
 from public.settings policy where bookings.id=b and policy.tenant_id=bookings.tenant_id and policy.key='refund_reschedule_policy';
 insert into public.booking_access_tokens(tenant_id,booking_id,token_hash,expires_at)
 values('f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a',b,encode(extensions.digest(pg_temp.wc_token('PS-ROLLBACK-'||n),'sha256'),'hex'),now()+interval '1 day');
 return b;
end;$$;
do $$
declare source jsonb;j jsonb;actor uuid;v jsonb;target jsonb;key uuid:=extensions.gen_random_uuid();token text;hash text;sessions jsonb;policy public.settings%rowtype;r jsonb;
begin
 select user_id into actor from public.platform_profiles where is_platform_owner order by user_id limit 1;
 source:=pg_temp.ps_group_payment_fixture(1);j:=pg_temp.ps_group_payment_begin((source->>'bookingId')::uuid,9900);
 perform public.finish_picklestreet_receipt_attempt((j->>'attemptId')::uuid,(j->>'leaseToken')::uuid,p_error_code=>'verifier_unavailable');
 perform pg_temp.ps_manual_call(j);
 v:=public.manage_picklestreet_weather_credit(source->>'reference',actor,180,'rain');
 select jsonb_agg(pg_temp.group_session((session->>'courtId')::uuid,(session->>'startsAt')::timestamptz+interval '20 days')) into sessions
 from public.bookings b,jsonb_array_elements(b.metadata->'sessions') session where b.id=(source->>'bookingId')::uuid;
 token:='xxxxxxx'||key::text;hash:=encode(extensions.digest(token,'sha256'),'hex');
 target:=public.create_picklestreet_group_hold('picklestreet.pages.dev',key,hash,hash,sessions);
 select setting.* into policy from public.settings setting where setting.tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a' and setting.key='refund_reschedule_policy';
 target:=public.complete_picklestreet_provisional_hold('picklestreet.pages.dev',target->>'reference',hash,
   'TEST ONLY weather replacement','group-payment@example.invalid','09000000000',true,policy.value->>'version',public.refund_reschedule_policy_sha256(policy.value),1,null,null);
 r:=public.apply_picklestreet_weather_credit(target->>'reference',token,v->'credit'->>'code');
 if r->>'status'<>'confirmed' or (r->>'totalAmount')::numeric<>0 or r->>'minutesUsed'<>'180' then raise exception 'Grouped credit failed %',r;end if;
 if (select count(*) from public.booking_slots where booking_id=(target->>'bookingId')::uuid and status='confirmed')<>3 then raise exception 'Grouped credit lost sessions';end if;
 insert into wc_results values('Real grouped hold and consent flow: credit confirms every original selected session atomically',true);
end;$$;
do $$
declare source uuid;b uuid;c uuid;actor uuid;j jsonb;r jsonb;v jsonb;again jsonb;ref text;original jsonb;denied boolean;
begin
 select user_id into actor from public.platform_profiles where is_platform_owner order by user_id limit 1;
 c:=pg_temp.ps_manual_isolated_court();source:=pg_temp.wc_target(9800,c,120);j:=pg_temp.ps_manual_begin(source,9800);perform pg_temp.ps_manual_call(j);
 select to_jsonb(booking) into original from public.bookings booking where id=source;
 v:=public.manage_picklestreet_weather_credit('PS-ROLLBACK-9800',actor,90,'rain');
 if v->'credit'->>'balanceMinutes'<>'90' then raise exception 'Issuance failed %',v;end if;
 again:=public.manage_picklestreet_weather_credit('PS-ROLLBACK-9800',actor,90,'rain');
 if again->'credit'->>'id'<>v->'credit'->>'id' then raise exception 'Duplicate voucher issued';end if;
 if original is distinct from (select to_jsonb(booking) from public.bookings booking where id=source) then raise exception 'Issuance changed source booking';end if;
 insert into wc_results values('Issue once; preserve source booking and original payment',true);
 b:=pg_temp.wc_target(9801,c);ref:='PS-ROLLBACK-9801';
 r:=public.apply_picklestreet_weather_credit(ref,pg_temp.wc_token(ref),v->'credit'->>'code');
 if r->>'status'<>'confirmed' or (r->>'totalAmount')::numeric<>0 or (r->>'feeCredit')::numeric<>15 or r->>'remainingMinutes'<>'30' then raise exception 'Full credit failed %',r;end if;
 again:=public.apply_picklestreet_weather_credit(ref,pg_temp.wc_token(ref),v->'credit'->>'code');
 if again<>r then raise exception 'Retry spent twice';end if;
 insert into wc_results values('Full replacement confirms original slots without another booking fee; retry spends once',true);
 b:=pg_temp.wc_target(9802,c);ref:='PS-ROLLBACK-9802';
 r:=public.apply_picklestreet_weather_credit(ref,pg_temp.wc_token(ref),v->'credit'->>'code');
 if r->>'status'<>'pending_payment' or (r->>'totalAmount')::numeric<>107.50 or r->>'remainingMinutes'<>'0' then raise exception 'Partial credit failed %',r;end if;
 update public.bookings set status='expired' where id=b;
 update public.booking_slots set status='expired' where booking_id=b;
 update public.bookings set status='expired' where id=b;
 if (select balance_minutes from public.picklestreet_weather_credits where booking_id=source)<>30 then raise exception 'Credit not restored exactly once';end if;
 denied:=false;begin update public.bookings set status='pending_payment' where id=b;exception when others then denied:=true;end;
 if not denied then raise exception 'Returned credit reused';end if;
 insert into wc_results values('Partial credit retains exact top-up; unpaid expiry returns time once and blocks revival',true);
 b:=pg_temp.wc_target(9803,c);ref:='PS-ROLLBACK-9803';r:=public.apply_picklestreet_weather_credit(ref,pg_temp.wc_token(ref),v->'credit'->>'code');
 j:=pg_temp.ps_manual_begin(b,9803);r:=pg_temp.ps_manual_call(j);
 if r->>'bookingStatus'<>'confirmed' or (select amount from public.payment_sessions where booking_id=b)<>107.50 then raise exception 'Remaining receipt failed %',r;end if;
 insert into wc_results values('Existing receipt review verifies only remaining payment and confirms credited booking',true);
 if (select fee_amount from public.booking_fee_unclaimed_rows('f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a') where booking_id=b)<>7.50 then raise exception 'Top-up remittance did not retain the net booking fee';end if;
 if exists(select 1 from public.booking_fee_unclaimed_rows('f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a') where booking_reference='PS-ROLLBACK-9801') then raise exception 'Replacement charged a second remittance fee';end if;
 insert into wc_results values('Remittance charges only net extra fee; fully covered replacement adds no fee',true);
 denied:=false;begin perform public.manage_picklestreet_weather_credit('PS-ROLLBACK-9800',extensions.gen_random_uuid(),10,'rain');exception when sqlstate '42501' then denied:=true;end;
 if not denied then raise exception 'Unauthorized issue';end if;
 denied:=false;begin perform public.apply_picklestreet_weather_credit('PS-ROLLBACK-9803','bad',v->'credit'->>'code');exception when sqlstate '42501' then denied:=true;end;
 if not denied then raise exception 'Invalid access accepted';end if;
 insert into wc_results values('Unauthorized issuance and invalid guest token denied',true);
 denied:=false;begin update public.bookings set starts_at=starts_at+interval '1 day',ends_at=ends_at+interval '1 day' where id=source;exception when others then denied:=true;end;
 if not denied then raise exception 'Duplicate rain reschedule allowed';end if;
 insert into wc_results values('Issued source cannot also be rescheduled',true);
 if has_function_privilege('anon','public.apply_picklestreet_weather_credit(text,text,text)','EXECUTE') or has_table_privilege('authenticated','public.picklestreet_weather_credits','SELECT') then raise exception 'Private credit ledger exposed';end if;
 insert into wc_results values('Credit ledger and transaction inaccessible directly to public callers',true);
 source:=pg_temp.wc_target(9820,c,120);j:=pg_temp.ps_manual_begin(source,9820);perform pg_temp.ps_manual_call(j);
 v:=public.manage_picklestreet_weather_credit('PS-ROLLBACK-9820',actor,60,'wet_court');
 b:=pg_temp.wc_target(9821,c);ref:='PS-ROLLBACK-9821';
 update public.bookings set customer_email='another@example.invalid' where id=b;
 denied:=false;begin perform public.apply_picklestreet_weather_credit(ref,pg_temp.wc_token(ref),v->'credit'->>'code');exception when others then denied:=true;end;
 if not denied then raise exception 'Another email spent credit';end if;
 update public.bookings set customer_email='weather-test@example.invalid' where id=b;
 update public.bookings set subtotal_amount=400,service_fee_amount=30,total_amount=430 where id=b;
 r:=public.apply_picklestreet_weather_credit(ref,pg_temp.wc_token(ref),v->'credit'->>'code');
 if (r->>'totalAmount')::numeric<>0 or r->>'minutesUsed'<>'60' then raise exception 'Equivalent time lost after price change';end if;
 insert into wc_results values('Voucher email enforced; equivalent time remains covered after a rate change',true);
 denied:=false;begin perform public.manage_picklestreet_weather_credit('PS-ROLLBACK-9820',actor,30,'rain');exception when others then denied:=true;end;
 if not denied then raise exception 'Issued credit was silently replaced';end if;
 insert into wc_results values('Changed issuance amount cannot overwrite an existing voucher',true);
end;$$;
