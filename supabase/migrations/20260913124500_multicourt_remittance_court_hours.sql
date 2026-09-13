-- Multi-court reservations store the total fee for every selected court on one
-- booking row.  Use the immutable courtHours snapshot when deriving the ledger
-- rate and units; elapsed wall-clock hours alone undercount multi-court usage.

begin;

create or replace function public.booking_fee_unclaimed_rows(p_tenant_id uuid)
returns table (
  booking_id uuid,
  booking_reference text,
  booking_created_at timestamptz,
  fee_earned_at timestamptz,
  court_id uuid,
  court_name text,
  booking_date date,
  fee_amount numeric,
  fee_rate numeric,
  fee_type text,
  fee_units numeric
)
language sql
stable
security definer
set search_path = ''
set row_security = 'off'
as $function$
  with regular_booking_rows as (
    select
      booking.*,
      court.name as resolved_court_name,
      billing.fee_mode as billing_fee_mode,
      case
        when billing.fee_mode = 'fixed_per_hour'
         and jsonb_typeof(booking.metadata -> 'courtHours') = 'number'
         and (booking.metadata ->> 'courtHours')::numeric > 0
          then round((booking.metadata ->> 'courtHours')::numeric, 2)
        when billing.fee_mode = 'fixed_per_hour'
          then round(
            extract(epoch from (booking.ends_at - booking.starts_at)) / 3600.0,
            2
          )
        else 1::numeric
      end as resolved_fee_units
    from public.bookings booking
    join public.courts court
      on court.tenant_id = booking.tenant_id
     and court.id = booking.court_id
    join public.tenant_platform_billing billing
      on billing.tenant_id = booking.tenant_id
    where booking.tenant_id = p_tenant_id
      and booking.status in ('confirmed', 'completed')
      and booking.payment_status = 'paid'
      and booking.service_fee_amount > 0
      and not exists (
        select 1
        from public.remittance_items item
        where item.tenant_id = booking.tenant_id
          and item.booking_id = booking.id
          and item.released_at is null
      )
  )
  select
    booking.id,
    booking.reference,
    booking.created_at,
    coalesce(booking.confirmed_at, booking.updated_at, booking.created_at),
    booking.court_id,
    booking.resolved_court_name,
    booking.local_booking_date,
    round(booking.service_fee_amount, 2),
    case
      when booking.billing_fee_mode = 'fixed_per_hour' then
        round(
          booking.service_fee_amount / greatest(booking.resolved_fee_units, 1),
          2
        )
      else round(booking.service_fee_amount, 2)
    end,
    case
      when booking.billing_fee_mode = 'fixed_per_hour' then 'per_hour'
      else 'flat'
    end,
    booking.resolved_fee_units
  from regular_booking_rows booking

  union all

  select
    registration.id,
    registration.reference,
    registration.created_at,
    registration.confirmed_at,
    court_summary.first_court_id,
    court_summary.court_names,
    session.local_date,
    round(registration.service_fee, 2),
    registration.service_fee_rate,
    case
      when registration.service_fee_mode = 'fixed_per_hour' then 'per_hour'
      when registration.service_fee_mode = 'percentage' then 'percentage'
      else 'flat'
    end,
    registration.service_fee_units
  from public.open_play_registrations registration
  join public.open_play_sessions session
    on session.tenant_id = registration.tenant_id
   and session.id = registration.session_id
  join lateral (
    select
      (array_agg(court.id order by court.sort_order, court.name, court.id))[1]
        as first_court_id,
      string_agg(
        court.name,
        ' / ' order by court.sort_order, court.name, court.id
      ) as court_names
    from public.open_play_session_courts session_court
    join public.courts court
      on court.tenant_id = session_court.tenant_id
     and court.id = session_court.court_id
    where session_court.tenant_id = registration.tenant_id
      and session_court.session_id = registration.session_id
  ) court_summary on court_summary.first_court_id is not null
  where registration.tenant_id = p_tenant_id
    and registration.confirmed_at is not null
    and registration.status in ('confirmed', 'checked_in', 'completed')
    and session.status in ('published', 'completed')
    and registration.payment_status = 'paid'
    and registration.currency = 'PHP'
    and registration.service_fee > 0
    and exists (
      select 1
      from public.open_play_payments payment
      where payment.tenant_id = registration.tenant_id
        and payment.registration_id = registration.id
        and payment.status = 'paid'
        and payment.amount = registration.total
        and payment.currency = registration.currency
    )
    and not exists (
      select 1
      from public.remittance_items item
      where item.tenant_id = registration.tenant_id
        and item.open_play_registration_id = registration.id
        and item.released_at is null
    );
$function$;

comment on function public.booking_fee_unclaimed_rows(uuid) is
  'Returns unclaimed immutable booking-fee rows. Multi-court regular bookings use metadata.courtHours so fee rates and billable units reflect every selected court.';

commit;
