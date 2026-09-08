-- Temporary fixture rows are confined to Pickle Street and rolled back with the migration.
set local request.jwt.claims='{"role":"service_role"}';
set local request.jwt.claim.role='service_role';
create temporary table ps_test_results (name text primary key, passed boolean);
create function pg_temp.ps_receiver() returns jsonb language sql as $$
 select jsonb_build_object('method',method_code,'name',account_name,'account',account_reference) from public.tenant_payment_methods
 where tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a' and method_code='gcash' and is_active
$$;
create function pg_temp.ps_booking(n integer) returns uuid language plpgsql as $$
declare b uuid:=extensions.gen_random_uuid();c uuid;start_time timestamptz;
begin
 select id into c from public.courts where tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a' and status='active' order by id limit 1;
 start_time:=(current_date+400)::timestamp at time zone 'Asia/Manila'+n*interval '1 hour';
 insert into public.bookings(id,tenant_id,court_id,reference,customer_name,customer_phone,starts_at,ends_at,local_booking_date,subtotal_amount,service_fee_amount,total_amount,expires_at,metadata)
 values(b,'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a',c,'PS-ROLLBACK-'||n,'Rollback fixture','00000000000',start_time,start_time+interval '1 hour',(start_time at time zone 'Asia/Manila')::date,200,15,215,now()+interval '15 minutes','{"fullPaymentOnly":true}');
 insert into public.booking_slots(tenant_id,booking_id,court_id,starts_at,ends_at,status,hold_expires_at)
 values('f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a',b,c,start_time,start_time+interval '1 hour','held',now()+interval '15 minutes');
 return b;
end;$$;
create temporary table owner_action_results(name text,passed boolean);
create function pg_temp.assert_ok(n text,ok boolean) returns void language plpgsql as $$ begin
 if ok is distinct from true then raise exception 'FAILED: %',n; end if;
 insert into owner_action_results values(n,true);
end;$$;
create function pg_temp.ps2_fixture(n integer) returns jsonb language plpgsql as $$
declare t constant uuid:='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';b uuid:=extensions.gen_random_uuid();q uuid:=extensions.gen_random_uuid();c uuid;start_time timestamptz;
begin
 select id into c from public.courts where tenant_id=t and status='active' order by id limit 1;
 start_time:=((current_date+401)::timestamp+n*interval '4 hours') at time zone 'Asia/Manila';
 insert into public.bookings(id,tenant_id,court_id,reference,customer_name,customer_phone,status,payment_status,starts_at,ends_at,local_booking_date,subtotal_amount,service_fee_amount,total_amount,expires_at,metadata)
 values(b,t,c,'PS-BALANCE-ROLLBACK-'||n,'Rollback fixture','00000000000','confirmed','paid',start_time,start_time+interval '1 hour',(start_time at time zone 'Asia/Manila')::date,200,15,215,null,'{"fullPaymentOnly":true}');
 insert into public.booking_slots(tenant_id,booking_id,court_id,starts_at,ends_at,status,hold_expires_at)
 values(t,b,c,start_time,start_time+interval '1 hour','confirmed',null);
 insert into public.booking_balance_requests(id,tenant_id,booking_id,issued_by,accepted_amount,remaining_amount,currency,status,deadline_at,token_hash,request_type,request_details)
 values(q,t,b,(select user_id from public.platform_profiles where is_platform_owner order by user_id limit 1),215,40,'PHP','awaiting_payment',now()+interval '5 minutes',repeat('a',64),'reschedule_adjustment',jsonb_build_object(
 'idempotencyKey',extensions.gen_random_uuid(),'oldStartsAt',start_time,'oldEndsAt',start_time+interval '1 hour','newStartsAt',start_time+interval '2 hours','newEndsAt',start_time+interval '3 hours',
 'newLocalDate',((start_time+interval '2 hours') at time zone 'Asia/Manila')::date,'newStartTime',((start_time+interval '2 hours') at time zone 'Asia/Manila')::time,
 'newSubtotalAmount',240,'newTotalAmount',255,'reasonCode','customer_request','publicReason','Requested later time','notifyCustomer',false));
 insert into public.booking_slots(tenant_id,booking_id,court_id,starts_at,ends_at,status,hold_expires_at,balance_request_id)
 values(t,b,c,start_time+interval '2 hours',start_time+interval '3 hours','held',now()+interval '5 minutes',q);
 return jsonb_build_object('b',b,'q',q,'c',c);
end;$$;

do $$
declare
 t constant uuid:='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';
 u uuid:=extensions.gen_random_uuid(); root_user uuid; b uuid; q uuid; c uuid;
 r text; denied boolean; fixture jsonb;
begin
 select user_id into root_user from public.platform_profiles where is_platform_owner limit 1;
 insert into auth.users(id,aud,role,email) values(u,'authenticated','authenticated','owner-action-rollback@example.invalid');
 insert into public.tenant_memberships(tenant_id,user_id,role,status) values(t,u,'owner','active');
 b:=pg_temp.ps_booking(700); r:='PS-ROLLBACK-700';
 -- Add a second court under the same reference to verify whole-group release.
 select id into c from public.courts where tenant_id=t and id<>(select court_id from public.bookings where id=b) limit 1;
 insert into public.booking_slots(tenant_id,booking_id,court_id,starts_at,ends_at,status,hold_expires_at)
 select t,b,c,starts_at,ends_at,'held',expires_at from public.bookings where id=b;
 perform set_config('request.headers','{"origin":"https://picklestreetcourt.com"}',true);
 perform set_config('request.jwt.claim.role','authenticated',true);
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',u)::text,true);
 perform public.manage_picklestreet_booking('pickle-street-tugbok','picklestreetcourt.com',r,'cancel');
 perform pg_temp.assert_ok('Court owner cancels entire multi-court booking',
  (select status='cancelled' from public.bookings where id=b) and not exists(select 1 from public.booking_slots where booking_id=b and status in('held','confirmed')));
 foreach r in array array['delete','archive','restore'] loop
  denied:=false;
  begin perform public.manage_picklestreet_booking('pickle-street-tugbok','picklestreetcourt.com','PS-ROLLBACK-700',r);
  exception when insufficient_privilege then denied:=true; end;
  perform pg_temp.assert_ok('Court owner denied '||r,denied);
 end loop;
 update public.tenant_memberships set role='admin' where tenant_id=t and user_id=u;
 perform public.manage_picklestreet_booking('pickle-street-tugbok','picklestreetcourt.com','PS-ROLLBACK-700','cancel');
 perform pg_temp.assert_ok('Admin mapped to Court Owner may cancel',true);
 update public.tenant_memberships set role='staff' where tenant_id=t and user_id=u;
 denied:=false;
 begin perform public.manage_picklestreet_booking('pickle-street-tugbok','picklestreetcourt.com','PS-ROLLBACK-700','cancel');
 exception when insufficient_privilege then denied:=true; end;
 perform pg_temp.assert_ok('Staff cannot cancel',denied);
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',root_user)::text,true);
 b:=pg_temp.ps_booking(701);r:='PS-ROLLBACK-701';
 update public.bookings set status='confirmed',payment_status='paid' where id=b;
 perform public.manage_picklestreet_booking('pickle-street-tugbok','picklestreetcourt.com',r,'archive');
 perform pg_temp.assert_ok('System owner archives active paid booking and retains payment',
  (select status='cancelled' and payment_status='paid' and archived_at is not null from public.bookings where id=b));
 perform public.manage_picklestreet_booking('pickle-street-tugbok','picklestreetcourt.com',r,'restore');
 perform pg_temp.assert_ok('Restore unarchives without reclaiming released times',
  (select status='cancelled' and archived_at is null from public.bookings where id=b) and not exists(select 1 from public.booking_slots where booking_id=b and status in('held','confirmed')));
 perform public.manage_picklestreet_booking('pickle-street-tugbok','picklestreetcourt.com',r,'delete');
 perform pg_temp.assert_ok('Delete hides record and retains paid evidence',
  (select payment_status='paid' and archived_at is not null and archive_reason like '[deleted]%' from public.bookings where id=b));
 denied:=false;
 begin perform public.manage_picklestreet_booking('pickle-street-tugbok','picklestreetcourt.com',r,'restore');
 exception when object_not_in_prerequisite_state then denied:=true; end;
 perform pg_temp.assert_ok('Deleted entry cannot be restored by this endpoint',denied);
 fixture:=pg_temp.ps2_fixture(702);
 perform public.manage_picklestreet_booking('pickle-street-tugbok','picklestreetcourt.com','PS-BALANCE-ROLLBACK-702','cancel');
 perform pg_temp.assert_ok('Cancellation closes extra-payment request and releases old and new slots',
  (select status='cancelled' from public.booking_balance_requests where id=(fixture->>'q')::uuid)
  and not exists(select 1 from public.booking_slots where booking_id=(fixture->>'b')::uuid and status in ('held','confirmed')));
 perform set_config('request.headers','{"origin":"https://wrong.example"}',true);
 denied:=false;
 begin perform public.manage_picklestreet_booking('pickle-street-tugbok','picklestreetcourt.com',r,'delete');
 exception when insufficient_privilege then denied:=true; end;
 perform pg_temp.assert_ok('Wrong actual origin denied',denied);
 perform set_config('request.headers','{"origin":"https://picklestreetcourt.com"}',true);
 perform set_config('request.jwt.claims','{"role":"anon"}',true);
 perform set_config('request.jwt.claim.role','anon',true);
 denied:=false;
 begin perform public.manage_picklestreet_booking('pickle-street-tugbok','picklestreetcourt.com',r,'delete');
 exception when insufficient_privilege then denied:=true; end;
 perform pg_temp.assert_ok('Anonymous action denied',denied);
end;$$;
