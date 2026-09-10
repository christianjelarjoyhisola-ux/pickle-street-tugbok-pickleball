begin;
create or replace function public.cancel_picklestreet_hold_with_reason(
 p_hostname text,p_booking_reference text,p_access_token_hash text,p_reason text default 'unknown'
) returns jsonb language plpgsql security definer set search_path='' set row_security='off' as $$
declare
 result jsonb;
 booking public.bookings%rowtype;
begin
 if p_reason is null or p_reason not in ('unknown','customer_cancel','checkout_back','browser_timer_elapsed','recovery_cancel') then
  raise exception 'CANCELLATION_REASON_INVALID' using errcode='22023';
 end if;
 -- The existing capability-checked operation authenticates, locks and releases the hold.
 result:=public.cancel_picklestreet_provisional_hold(p_hostname,p_booking_reference,p_access_token_hash);
 if coalesce((result->>'idempotent')::boolean,false)=false and (result->>'cancelled')::boolean=true then
  select * into strict booking from public.bookings where id=(result->>'bookingId')::uuid
   and tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';
  insert into public.audit_events(tenant_id,actor_role,action,entity_table,entity_id,metadata)
  values(booking.tenant_id,'booking_capability','checkout_cancelled','bookings',booking.id::text,
   jsonb_build_object('reason',p_reason,'reasonSource','client_reported','detailsSubmitted',false,
    'serverDeadlinePassed',booking.expires_at<=clock_timestamp(),'holdExpiresAt',booking.expires_at));
 end if;
 return result;
end;$$;
revoke all on function public.cancel_picklestreet_hold_with_reason(text,text,text,text) from public,anon,authenticated;
grant execute on function public.cancel_picklestreet_hold_with_reason(text,text,text,text) to service_role;
commit;
