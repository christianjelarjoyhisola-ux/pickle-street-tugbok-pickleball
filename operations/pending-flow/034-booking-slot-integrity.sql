-- An active Pickle Street booking must always own at least one slot row.
--
-- booking_slots already has a GiST exclusion constraint that atomically rejects
-- overlapping held/confirmed intervals. This deferred companion guard closes
-- the remaining hole: a booking inserted or left active without any slot rows
-- would otherwise be invisible to both that constraint and public availability.
begin;

create or replace function public.enforce_picklestreet_booking_slot_integrity()
returns trigger
language plpgsql
security definer
set search_path = ''
set row_security = 'off'
as $$
declare
  picklestreet_tenant constant uuid := 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';
  booking_key uuid;
  booking_keys uuid[];
  parent public.bookings%rowtype;
begin
  if tg_table_name = 'bookings' then
    booking_keys := array[coalesce(new.id, old.id)];
  elsif tg_op = 'UPDATE' and new.booking_id is distinct from old.booking_id then
    booking_keys := array[old.booking_id, new.booking_id];
  else
    booking_keys := array[coalesce(new.booking_id, old.booking_id)];
  end if;

  foreach booking_key in array booking_keys loop
    select booking.*
      into parent
      from public.bookings booking
     where booking.tenant_id = picklestreet_tenant
       and booking.id = booking_key;

    -- Cascading deletes legitimately leave no parent to validate.
    if not found then
      continue;
    end if;

    if parent.status in ('pending_payment', 'payment_review', 'confirmed', 'completed')
       and not exists (
         select 1
           from public.booking_slots slot
          where slot.tenant_id = parent.tenant_id
            and slot.booking_id = parent.id
            and slot.status in ('held', 'confirmed')
       ) then
      raise exception 'PICKLESTREET_ACTIVE_BOOKING_REQUIRES_SLOT'
        using errcode = '23514';
    end if;
  end loop;

  return coalesce(new, old);
end;
$$;

revoke all on function public.enforce_picklestreet_booking_slot_integrity()
  from public, anon, authenticated;
grant execute on function public.enforce_picklestreet_booking_slot_integrity()
  to service_role;

drop trigger if exists bookings_require_active_slot on public.bookings;
create constraint trigger bookings_require_active_slot
after insert or update on public.bookings
deferrable initially deferred
for each row execute function public.enforce_picklestreet_booking_slot_integrity();

drop trigger if exists booking_slots_preserve_active_booking on public.booking_slots;
create constraint trigger booking_slots_preserve_active_booking
after insert or update or delete on public.booking_slots
deferrable initially deferred
for each row execute function public.enforce_picklestreet_booking_slot_integrity();

comment on function public.enforce_picklestreet_booking_slot_integrity() is
  'Deferred Pickle Street invariant: every active booking owns a held or confirmed slot, whose exclusion constraint prevents double booking.';

commit;
