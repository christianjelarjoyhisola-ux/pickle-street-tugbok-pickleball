-- Scheduled release for 002. One named Pickle Street-only job.
-- Only our new cleanup function gains a database-owner entry path.
begin;
create extension if not exists pg_cron with schema pg_catalog;

create or replace function public.expire_picklestreet_balance_receipt_holds(p_booking_id uuid default null) returns integer
language plpgsql security definer set search_path='' set row_security=off as $$
declare j public.picklestreet_balance_receipt_jobs%rowtype;n integer:=0;c integer;
begin
  -- session_user remains the actual database login under SECURITY DEFINER.
  -- PostgREST guests cannot acquire the postgres scheduler identity.
  if auth.role() is distinct from 'service_role' and session_user is distinct from 'postgres' then
    raise exception 'PICKLESTREET_SERVICE_REQUIRED' using errcode='42501';end if;
  for j in select * from public.picklestreet_balance_receipt_jobs where settled_at is null and hold_released_at is null and hold_deadline_at<=clock_timestamp()
    and(p_booking_id is null or booking_id=p_booking_id) order by booking_id,balance_request_id loop
    perform pg_advisory_xact_lock(hashtextextended('picklestreet-balance:'||j.balance_request_id::text,0));
    perform 1 from public.receipt_verifications where tenant_id=j.tenant_id and id=j.receipt_id for update;
    perform 1 from public.booking_balance_requests where tenant_id=j.tenant_id and id=j.balance_request_id for update;
    perform 1 from public.bookings where tenant_id=j.tenant_id and id=j.booking_id for update;
    if not exists(select 1 from public.picklestreet_balance_receipt_jobs where tenant_id=j.tenant_id and balance_request_id=j.balance_request_id
      and settled_at is null and hold_released_at is null) then continue;end if;
    update public.booking_slots set status='expired',hold_expires_at=j.hold_deadline_at
      where tenant_id=j.tenant_id and booking_id=j.booking_id and status='held'
        and(case when j.request_type='reschedule_adjustment' then balance_request_id=j.balance_request_id else balance_request_id is null end);
    get diagnostics c=row_count;n:=n+c;
    if j.request_type='short_payment' then
      update public.bookings set status='expired',expires_at=j.hold_deadline_at
        where tenant_id=j.tenant_id and id=j.booking_id and status in ('pending_payment','payment_review');
    end if;
    update public.picklestreet_balance_receipt_jobs set hold_released_at=clock_timestamp(),updated_at=now()
      where tenant_id=j.tenant_id and balance_request_id=j.balance_request_id;
  end loop;
  return n;
end;$$;

-- Only the database scheduler/owner can enter this wrapper.
create function public.run_picklestreet_balance_hold_cleanup() returns integer
language plpgsql security definer
set search_path='' set row_security=off
set lock_timeout='1000ms'
as $$
begin
  return public.expire_picklestreet_balance_receipt_holds(null);
end;
$$;
revoke all on function public.run_picklestreet_balance_hold_cleanup() from public,anon,authenticated,service_role;
grant execute on function public.run_picklestreet_balance_hold_cleanup() to postgres;

select cron.schedule(
  'picklestreet-balance-holds-f19f457a',
  '* * * * *',
  'select public.run_picklestreet_balance_hold_cleanup();'
);
commit;
