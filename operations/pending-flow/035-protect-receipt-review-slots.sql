-- A successfully stored receipt is durable payment evidence. Once that evidence
-- is pending verification or manual review, the original checkout deadline must
-- no longer release the court to another customer. Staff approval confirms the
-- slots; staff rejection/cancellation releases them through the existing flows.
begin;

create or replace function public.sync_payment_review_slot_hold()
returns trigger
language plpgsql
security definer
set search_path = ''
set row_security = 'off'
as $$
declare
  manual_approval boolean := false;
  durable_receipt boolean := false;
begin
  if new.status = 'payment_review'
     and old.status is distinct from 'payment_review' then
    select tenant.public_config ->> 'bookingApprovalMode' = 'manual'
      into manual_approval
      from public.tenants tenant
     where tenant.id = new.tenant_id;

    select exists (
      select 1
        from public.receipt_verifications verification
       where verification.tenant_id = new.tenant_id
         and verification.booking_id = new.id
         and verification.balance_request_id is null
         and verification.status in ('pending', 'manual_review')
         and nullif(btrim(verification.storage_path), '') is not null
    ) into durable_receipt;

    update public.booking_slots
       set hold_expires_at = case
         when coalesce(manual_approval, false) or durable_receipt
           then 'infinity'::timestamptz
         else new.expires_at
       end
     where tenant_id = new.tenant_id
       and booking_id = new.id
       and status = 'held';
  end if;
  return null;
end;
$$;

create or replace function public.protect_picklestreet_receipt_review_slots()
returns trigger
language plpgsql
security definer
set search_path = ''
set row_security = 'off'
as $$
declare
  picklestreet_tenant constant uuid := 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';
begin
  if new.tenant_id = picklestreet_tenant
     and new.balance_request_id is null
     and new.status in ('pending', 'manual_review')
     and nullif(btrim(new.storage_path), '') is not null
     and exists (
       select 1
         from public.bookings booking
        where booking.tenant_id = new.tenant_id
          and booking.id = new.booking_id
          and booking.status in ('pending_payment', 'payment_review')
          and booking.payment_status in ('unpaid', 'pending')
     ) then
    update public.booking_slots slot
       set hold_expires_at = 'infinity'::timestamptz
     where slot.tenant_id = new.tenant_id
       and slot.booking_id = new.booking_id
       and slot.balance_request_id is null
       and slot.status = 'held';
  end if;
  return null;
end;
$$;

revoke all on function public.protect_picklestreet_receipt_review_slots()
  from public, anon, authenticated;
grant execute on function public.protect_picklestreet_receipt_review_slots()
  to service_role;

drop trigger if exists receipt_verifications_protect_review_slots
  on public.receipt_verifications;
create constraint trigger receipt_verifications_protect_review_slots
after insert or update on public.receipt_verifications
deferrable initially deferred
for each row execute function public.protect_picklestreet_receipt_review_slots();

comment on function public.protect_picklestreet_receipt_review_slots() is
  'Prevents a stored Pickle Street receipt awaiting review from losing its court slots to the checkout timer.';

commit;
