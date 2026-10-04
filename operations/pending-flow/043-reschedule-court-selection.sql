begin;
-- Dedicated Pickle Street court selection; existing tenant APIs retain their contracts.
CREATE OR REPLACE FUNCTION public.preview_picklestreet_court_availability(p_booking_id uuid, p_local_date date, p_court_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET row_security TO 'off'
AS $function$
declare
  v_booking public.bookings%rowtype;
  v_tenant public.tenants%rowtype;
  v_court public.courts%rowtype;
  v_is_platform_owner boolean;
  v_is_tenant_owner boolean;
  v_duration_hours integer;
  v_minimum_lead_minutes integer := 30;
  v_max_advance_days integer := 180;
  v_policy_value text;
  v_hour integer;
  v_local_start timestamp;
  v_local_end timestamp;
  v_new_start timestamptz;
  v_new_end timestamptz;
  v_operating_date date;
  v_operating_start timestamp;
  v_operating_end timestamp;
  v_available boolean;
  v_unavailable_reason text;
  v_options jsonb := '[]'::jsonb;
begin
  if not exists(select 1 from public.bookings b join public.courts c on c.tenant_id=b.tenant_id and c.id=p_court_id and c.status='active' where b.id=p_booking_id and b.tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a') then
    raise exception 'The booking court is not available for rescheduling.' using errcode='22023';end if;
  if auth.uid() is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;
  if p_local_date is null then
    raise exception 'Choose a reschedule date.' using errcode = '22023';
  end if;

  select booking.* into v_booking
  from public.bookings booking
  where booking.id = p_booking_id;
  if not found then
    raise exception 'Booking was not found.' using errcode = 'P0002';
  end if;

  v_is_platform_owner := public.is_platform_owner();
  v_is_tenant_owner := public.has_tenant_role(
    v_booking.tenant_id, array['owner']
  );
  if not public.request_origin_matches_tenant(v_booking.tenant_id)
     or not (v_is_platform_owner or v_is_tenant_owner) then
    raise exception 'Tenant booking access denied.' using errcode = '42501';
  end if;

  perform public.expire_stale_tenant_holds(v_booking.tenant_id);
  select booking.* into v_booking
  from public.bookings booking
  where booking.tenant_id = v_booking.tenant_id
    and booking.id = p_booking_id;
  if v_booking.archived_at is not null
     or v_booking.status not in (
       'pending_payment', 'payment_review', 'confirmed', 'completed'
     ) then
    raise exception 'Booking cannot be rescheduled from its current status.'
      using errcode = '22023';
  end if;
  if v_booking.status = 'completed'
     and v_booking.ends_at > statement_timestamp() then
    raise exception 'Booking cannot be rescheduled from its current status.'
      using errcode = '22023';
  end if;
  if (v_booking.status = 'completed' or v_booking.ends_at <= now())
     and not (v_is_platform_owner or v_is_tenant_owner) then
    raise exception 'Only the System Owner or Court Owner can reschedule an ended booking.'
      using errcode = '42501';
  end if;

  select tenant.* into v_tenant
  from public.tenants tenant
  where tenant.id = v_booking.tenant_id
    and tenant.status = 'active';
  select court.* into v_court
  from public.courts court
  where court.tenant_id = v_booking.tenant_id
    and court.id = p_court_id
    and court.status = 'active';
  if v_tenant.id is null or v_court.id is null then
    raise exception 'The booking court is not available for rescheduling.'
      using errcode = '22023';
  end if;

  v_duration_hours :=
    extract(epoch from (v_booking.ends_at - v_booking.starts_at))::integer
    / 3600;
  if v_duration_hours < 1
     or v_duration_hours > 18
     or v_booking.ends_at - v_booking.starts_at
       <> make_interval(hours => v_duration_hours) then
    raise exception 'The stored booking duration cannot be rescheduled.'
      using errcode = '22023';
  end if;

  if jsonb_typeof(v_court.public_config -> 'minimumLeadMinutes') = 'number' then
    v_policy_value := v_court.public_config ->> 'minimumLeadMinutes';
    if v_policy_value ~ '^[0-9]+$'
       and v_policy_value::numeric between 0 and 10080 then
      v_minimum_lead_minutes := v_policy_value::integer;
    end if;
  end if;
  if jsonb_typeof(v_court.public_config -> 'maximumAdvanceDays') = 'number' then
    v_policy_value := v_court.public_config ->> 'maximumAdvanceDays';
    if v_policy_value ~ '^[0-9]+$'
       and v_policy_value::numeric between 0 and 730 then
      v_max_advance_days := v_policy_value::integer;
    end if;
  end if;
  if p_local_date >
      (now() at time zone v_tenant.timezone)::date + v_max_advance_days then
    raise exception 'The reschedule date exceeds the configured maximum advance date.'
      using errcode = '22023';
  end if;

  for v_hour in 0..23 loop
    v_local_start := p_local_date + make_time(v_hour, 0, 0);
    v_local_end := v_local_start + make_interval(hours => v_duration_hours);
    v_new_start := v_local_start at time zone v_tenant.timezone;
    v_new_end := v_local_end at time zone v_tenant.timezone;

    v_operating_date := v_local_start::date;
    if v_court.closes_at <= v_court.opens_at
       and v_local_start::time < v_court.closes_at then
      v_operating_date := v_operating_date - 1;
    end if;
    v_operating_start := v_operating_date + v_court.opens_at;
    if v_court.closes_at <= v_court.opens_at
       or v_court.closes_at = time '23:59:59' then
      v_operating_end := v_operating_date + 1
        + case
          when v_court.closes_at = time '23:59:59' then time '00:00'
          else v_court.closes_at
        end;
    else
      v_operating_end := v_operating_date + v_court.closes_at;
    end if;

    if v_local_start >= v_operating_start
       and v_local_end <= v_operating_end then
      v_available := true;
      v_unavailable_reason := null;
      if v_new_start <
          now() + (v_minimum_lead_minutes * interval '1 minute') then
        v_available := false;
        v_unavailable_reason := 'lead_time';
      elsif p_court_id = v_booking.court_id and v_new_start = v_booking.starts_at
         and v_new_end = v_booking.ends_at then
        v_available := false;
        v_unavailable_reason := 'current_schedule';
      elsif exists (
        select 1
        from public.blocked_dates blocked
        where blocked.tenant_id = v_booking.tenant_id
          and (
            blocked.court_id is null
            or blocked.court_id = p_court_id
          )
          and blocked.blocked_on between
            v_local_start::date
            and (v_local_end - interval '1 microsecond')::date
          and tsrange(v_local_start, v_local_end, '[)') &&
            case
              when blocked.starts_at is null then
                tsrange(
                  blocked.blocked_on::timestamp,
                  (blocked.blocked_on + 1)::timestamp,
                  '[)'
                )
              else
                tsrange(
                  blocked.blocked_on + blocked.starts_at,
                  case
                    when blocked.ends_at = time '23:59:59'
                      then (blocked.blocked_on + 1)::timestamp
                    else blocked.blocked_on + blocked.ends_at
                  end,
                  '[)'
                )
            end
      ) then
        v_available := false;
        v_unavailable_reason := 'blocked';
      elsif exists (
        select 1
        from public.booking_slots slot
        where slot.tenant_id = v_booking.tenant_id
          and slot.court_id = p_court_id
          and slot.booking_id <> v_booking.id
          and (
            slot.status = 'confirmed'
            or (
              slot.status = 'held'
              and slot.hold_expires_at > now()
            )
          )
          and tstzrange(slot.starts_at, slot.ends_at, '[)')
            && tstzrange(v_new_start, v_new_end, '[)')
      ) then
        v_available := false;
        v_unavailable_reason := 'booked';
      end if;

      if v_available and exists(select 1 from public.court_occupancies o where o.tenant_id=v_booking.tenant_id and o.court_id=p_court_id and o.starts_at<v_new_end and o.ends_at>v_new_start and (o.status='confirmed' or(o.status='held' and o.hold_expires_at>now())) and not(o.source_kind='booking_slot' and exists(select 1 from public.booking_slots own where own.id=o.source_id and own.booking_id=v_booking.id))) then v_available:=false;v_unavailable_reason:='booked';end if;
      v_options := v_options || jsonb_build_array(jsonb_build_object(
        'courtId', p_court_id, 'courtName', v_court.name,
        'startsAt', v_new_start,
        'endsAt', v_new_end,
        'startTime', to_char(v_local_start, 'HH24:MI'),
        'endTime', to_char(v_local_end, 'HH24:MI'),
        'label',
          to_char(v_local_start, 'FMHH12:MI AM')
          || ' – '
          || to_char(v_local_end, 'FMHH12:MI AM'),
        'available', v_available,
        'unavailableReason', v_unavailable_reason
      ));
    end if;
  end loop;

  return jsonb_build_object(
    'booking', jsonb_build_object(
      'id', v_booking.id,
      'reference', v_booking.reference,
      'courtId', v_booking.court_id,
      'courtName', (select name from public.courts where id=v_booking.court_id),
      'startsAt', v_booking.starts_at,
      'endsAt', v_booking.ends_at,
      'localBookingDate', v_booking.local_booking_date,
      'durationHours', v_duration_hours,
      'status', v_booking.status,
      'paymentStatus', v_booking.payment_status,
      'customerName', v_booking.customer_name,
      'customerEmail', v_booking.customer_email,
      'subtotalAmount', v_booking.subtotal_amount,
      'serviceFeeAmount', v_booking.service_fee_amount,
      'totalAmount', v_booking.total_amount,
      'currency', v_booking.currency,
      'settledFinancialsPreserved',
        v_booking.status = 'completed'
        or v_booking.ends_at <= statement_timestamp()
    ),
    'options', v_options,
    'emailEnabled', case
      when jsonb_typeof(v_tenant.public_config -> 'emailEnabled') = 'boolean'
        then (v_tenant.public_config ->> 'emailEnabled')::boolean
      else false
    end
  );
end;
$function$
;
CREATE OR REPLACE FUNCTION public.preview_picklestreet_court_priced(p_booking_id uuid, p_local_date date, p_court_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET row_security TO 'off'
AS $function$
declare
  v_result jsonb;
  v_booking public.bookings%rowtype;
  v_court public.courts%rowtype;
  v_option jsonb;
  v_options jsonb := '[]'::jsonb;
  v_start_time time;
  v_duration integer;
  v_equipment_fee numeric(12,2);
  v_court_subtotal numeric(12,2);
  v_new_subtotal numeric(12,2);
  v_new_total numeric(12,2);
  v_additional numeric(12,2);
begin
  if not exists(select 1 from public.bookings b join public.courts c on c.tenant_id=b.tenant_id and c.id=p_court_id and c.status='active' where b.id=p_booking_id and b.tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a') then
    raise exception 'The booking court is not available for rescheduling.' using errcode='22023';end if;
  perform public.expire_stale_reschedule_adjustments(
    (select tenant_id from public.bookings where id = p_booking_id)
  );
  v_result := public.preview_picklestreet_court_availability(
    p_booking_id, p_local_date, p_court_id
  );
  select booking.* into v_booking
  from public.bookings booking
  where booking.id = p_booking_id;
  if v_booking.id is null then
    raise exception 'Booking was not found.' using errcode = 'P0002';
  end if;
  select court.* into v_court
  from public.courts court
  where court.tenant_id = v_booking.tenant_id
    and court.id = p_court_id;
  v_duration :=
    extract(epoch from (v_booking.ends_at - v_booking.starts_at))::integer
    / 3600;
  v_equipment_fee := case
    when coalesce(v_booking.metadata ->> 'equipmentRentalFeeAmount', '')
      ~ '^[0-9]+([.][0-9]{1,2})?$'
      then (v_booking.metadata ->> 'equipmentRentalFeeAmount')::numeric
    else 0
  end;

  for v_option in select value from jsonb_array_elements(v_result -> 'options')
  loop
    v_start_time := (v_option ->> 'startTime')::time;
    if v_booking.status = 'completed'
       or v_booking.ends_at <= statement_timestamp() then
      v_court_subtotal := greatest(0, v_booking.subtotal_amount - v_equipment_fee);
      v_new_subtotal := v_booking.subtotal_amount;
      v_new_total := v_booking.total_amount;
      v_additional := 0;
    else
      v_court_subtotal := public.regular_reschedule_court_subtotal(
        v_court.pricing_config, v_start_time, v_duration
      );
      v_new_subtotal := round(v_court_subtotal + v_equipment_fee, 2);
      v_new_total := round(v_new_subtotal + v_booking.service_fee_amount, 2);
      v_additional := greatest(
        0, round(v_new_total - v_booking.total_amount, 2)
      );
    end if;
    v_options := v_options || jsonb_build_array(
      v_option || jsonb_build_object(
        'courtSubtotalAmount', v_court_subtotal,
        'newSubtotalAmount', v_new_subtotal,
        'newTotalAmount', v_new_total,
        'originalTotalAmount', v_booking.total_amount,
        'amountPaid', case
          when v_booking.status in ('confirmed', 'completed')
            and v_booking.payment_status = 'paid'
            then v_booking.total_amount
          else 0
        end,
        'additionalAmount', v_additional,
        'paymentRequired', v_additional > 0
      )
    );
  end loop;
  return jsonb_set(v_result, '{options}', v_options, true);
end;
$function$
;
CREATE OR REPLACE FUNCTION public.commit_picklestreet_court_reschedule(p_booking_id uuid, p_local_date date, p_start_time time without time zone, p_reason_code text, p_public_reason text, p_internal_note text, p_notify_customer boolean, p_idempotency_key uuid, p_court_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET row_security TO 'off'
AS $function$
declare
  v_booking public.bookings%rowtype;
  v_tenant public.tenants%rowtype;
  v_court public.courts%rowtype;
  v_existing_event public.booking_reschedule_events%rowtype;
  v_event public.booking_reschedule_events%rowtype;
  v_reason_code text;
  v_public_reason text;
  v_internal_note text;
  v_duration_hours integer;
  v_minimum_lead_minutes integer := 30;
  v_max_advance_days integer := 180;
  v_policy_value text;
  v_local_start timestamp;
  v_local_end timestamp;
  v_new_start timestamptz;
  v_new_end timestamptz;
  v_operating_date date;
  v_operating_start timestamp;
  v_operating_end timestamp;
  v_slot_status text;
  v_slot_start timestamptz;
  v_index integer;
  v_email_status text;
  v_metadata_event jsonb;
begin
  if not exists(select 1 from public.bookings b join public.courts c on c.tenant_id=b.tenant_id and c.id=p_court_id and c.status='active' where b.id=p_booking_id and b.tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a') then
    raise exception 'The booking court is not available for rescheduling.' using errcode='22023';end if;
  if auth.uid() is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;
  if p_local_date is null or p_start_time is null then
    raise exception 'A new date and start time are required.' using errcode = '22023';
  end if;
  if extract(minute from p_start_time) <> 0
     or extract(second from p_start_time) <> 0 then
    raise exception 'The new start time must be on an exact hour.'
      using errcode = '22023';
  end if;
  if p_idempotency_key is null then
    raise exception 'A valid idempotency key is required.' using errcode = '22023';
  end if;

  v_reason_code := lower(btrim(coalesce(p_reason_code, '')));
  if v_reason_code not in (
    'customer_request',
    'weather',
    'court_maintenance',
    'schedule_conflict',
    'admin_correction',
    'other'
  ) then
    raise exception 'Choose a supported reschedule reason.'
      using errcode = '22023';
  end if;
  v_public_reason := btrim(coalesce(p_public_reason, ''));
  if char_length(v_public_reason) < 3
     or char_length(v_public_reason) > 500 then
    raise exception 'A customer-visible reason between 3 and 500 characters is required.'
      using errcode = '22023';
  end if;
  v_internal_note := nullif(btrim(coalesce(p_internal_note, '')), '');
  if v_internal_note is not null
     and char_length(v_internal_note) not between 3 and 1000 then
    raise exception 'The internal note must contain 3 to 1000 characters.'
      using errcode = '22023';
  end if;
  if p_notify_customer is null then
    raise exception 'Choose whether to notify the customer.'
      using errcode = '22023';
  end if;

  select booking.* into v_booking
  from public.bookings booking
  where booking.id = p_booking_id
  for update;
  if not found then
    raise exception 'Booking was not found.' using errcode = 'P0002';
  end if;
  if not public.request_origin_matches_tenant(v_booking.tenant_id)
     or not (
       public.is_platform_owner()
       or public.has_tenant_role(
         v_booking.tenant_id, array['owner', 'admin']
       )
     ) then
    raise exception 'Tenant booking access denied.' using errcode = '42501';
  end if;

  select event.* into v_existing_event
  from public.booking_reschedule_events event
  where event.tenant_id = v_booking.tenant_id
    and event.idempotency_key = p_idempotency_key;
  if found then
    if v_existing_event.court_id is distinct from p_court_id or v_existing_event.booking_id <> v_booking.id
       or v_existing_event.reason_code <> v_reason_code
       or v_existing_event.public_reason <> v_public_reason
       or v_existing_event.internal_note is distinct from v_internal_note
       or v_existing_event.notify_customer <> p_notify_customer
       or (v_existing_event.new_starts_at at time zone (
         select tenant.timezone
         from public.tenants tenant
         where tenant.id = v_booking.tenant_id
       ))::date <> p_local_date
       or (v_existing_event.new_starts_at at time zone (
         select tenant.timezone
         from public.tenants tenant
         where tenant.id = v_booking.tenant_id
       ))::time <> p_start_time then
      raise exception 'The idempotency key was already used for a different reschedule request.'
        using errcode = '22023';
    end if;
    return jsonb_build_object(
      'booking', jsonb_build_object(
        'id', v_booking.id,
        'reference', v_booking.reference,
        'courtId', v_booking.court_id,
        'startsAt', v_booking.starts_at,
        'endsAt', v_booking.ends_at,
        'localBookingDate', v_booking.local_booking_date,
        'status', v_booking.status,
        'paymentStatus', v_booking.payment_status,
        'subtotalAmount', v_booking.subtotal_amount,
        'serviceFeeAmount', v_booking.service_fee_amount,
        'totalAmount', v_booking.total_amount,
        'currency', v_booking.currency
      ),
      'event', jsonb_build_object(
        'id', v_existing_event.id,
        'reasonCode', v_existing_event.reason_code,
        'publicReason', v_existing_event.public_reason,
        'internalNote', v_existing_event.internal_note,
        'notifyCustomer', v_existing_event.notify_customer,
        'oldStartsAt', v_existing_event.old_starts_at,
        'oldEndsAt', v_existing_event.old_ends_at,
        'newStartsAt', v_existing_event.new_starts_at,
        'newEndsAt', v_existing_event.new_ends_at,
        'rescheduledAt', v_existing_event.created_at,
        'rescheduledBy', v_existing_event.rescheduled_by,
        'emailStatus', v_existing_event.email_status,
        'emailSentAt', v_existing_event.email_sent_at,
        'emailErrorCode', v_existing_event.email_last_error_code
      ),
      'idempotent', true
    );
  end if;

  perform public.expire_stale_tenant_holds(v_booking.tenant_id);
  select booking.* into v_booking
  from public.bookings booking
  where booking.tenant_id = v_booking.tenant_id
    and booking.id = p_booking_id
  for update;
  if v_booking.archived_at is not null
     or v_booking.status not in (
       'pending_payment', 'payment_review', 'confirmed'
     ) then
    raise exception 'Booking cannot be rescheduled from its current status.'
      using errcode = '22023';
  end if;

  select tenant.* into v_tenant
  from public.tenants tenant
  where tenant.id = v_booking.tenant_id
    and tenant.status = 'active';
  select court.* into v_court
  from public.courts court
  where court.tenant_id = v_booking.tenant_id
    and court.id = p_court_id
    and court.status = 'active';
  if v_tenant.id is null or v_court.id is null then
    raise exception 'The booking court is not available for rescheduling.'
      using errcode = '22023';
  end if;

  v_duration_hours :=
    extract(epoch from (v_booking.ends_at - v_booking.starts_at))::integer
    / 3600;
  if v_duration_hours < 1
     or v_duration_hours > 18
     or v_booking.ends_at - v_booking.starts_at
       <> make_interval(hours => v_duration_hours) then
    raise exception 'The stored booking duration cannot be rescheduled.'
      using errcode = '22023';
  end if;

  v_local_start := p_local_date + p_start_time;
  v_local_end := v_local_start + make_interval(hours => v_duration_hours);
  v_new_start := v_local_start at time zone v_tenant.timezone;
  v_new_end := v_local_end at time zone v_tenant.timezone;
  if p_court_id = v_booking.court_id and v_new_start = v_booking.starts_at
     and v_new_end = v_booking.ends_at then
    raise exception 'Choose a different date or start time.'
      using errcode = '22023';
  end if;

  if jsonb_typeof(v_court.public_config -> 'minimumLeadMinutes') = 'number' then
    v_policy_value := v_court.public_config ->> 'minimumLeadMinutes';
    if v_policy_value ~ '^[0-9]+$'
       and v_policy_value::numeric between 0 and 10080 then
      v_minimum_lead_minutes := v_policy_value::integer;
    end if;
  end if;
  if v_new_start <
      now() + (v_minimum_lead_minutes * interval '1 minute') then
    raise exception 'The new time does not meet the configured minimum lead time.'
      using errcode = '22023';
  end if;
  if jsonb_typeof(v_court.public_config -> 'maximumAdvanceDays') = 'number' then
    v_policy_value := v_court.public_config ->> 'maximumAdvanceDays';
    if v_policy_value ~ '^[0-9]+$'
       and v_policy_value::numeric between 0 and 730 then
      v_max_advance_days := v_policy_value::integer;
    end if;
  end if;
  if p_local_date >
      (now() at time zone v_tenant.timezone)::date + v_max_advance_days then
    raise exception 'The reschedule date exceeds the configured maximum advance date.'
      using errcode = '22023';
  end if;

  v_operating_date := v_local_start::date;
  if v_court.closes_at <= v_court.opens_at
     and v_local_start::time < v_court.closes_at then
    v_operating_date := v_operating_date - 1;
  end if;
  v_operating_start := v_operating_date + v_court.opens_at;
  if v_court.closes_at <= v_court.opens_at
     or v_court.closes_at = time '23:59:59' then
    v_operating_end := v_operating_date + 1
      + case
        when v_court.closes_at = time '23:59:59' then time '00:00'
        else v_court.closes_at
      end;
  else
    v_operating_end := v_operating_date + v_court.closes_at;
  end if;
  if v_local_start < v_operating_start
     or v_local_end > v_operating_end then
    raise exception 'The new time is outside the court operating hours.'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.blocked_dates blocked
    where blocked.tenant_id = v_booking.tenant_id
      and (
        blocked.court_id is null
        or blocked.court_id = p_court_id
      )
      and blocked.blocked_on between
        v_local_start::date
        and (v_local_end - interval '1 microsecond')::date
      and tsrange(v_local_start, v_local_end, '[)') &&
        case
          when blocked.starts_at is null then
            tsrange(
              blocked.blocked_on::timestamp,
              (blocked.blocked_on + 1)::timestamp,
              '[)'
            )
          else
            tsrange(
              blocked.blocked_on + blocked.starts_at,
              case
                when blocked.ends_at = time '23:59:59'
                  then (blocked.blocked_on + 1)::timestamp
                else blocked.blocked_on + blocked.ends_at
              end,
              '[)'
            )
        end
  ) then
    raise exception 'The court is blocked during the new booking time.'
      using errcode = '23P01';
  end if;

  if exists (
    select 1
    from public.booking_slots slot
    where slot.tenant_id = v_booking.tenant_id
      and slot.court_id = p_court_id
      and slot.booking_id <> v_booking.id
      and (
        slot.status = 'confirmed'
        or (
          slot.status = 'held'
          and slot.hold_expires_at > now()
        )
      )
      and tstzrange(slot.starts_at, slot.ends_at, '[)')
        && tstzrange(v_new_start, v_new_end, '[)')
  ) then
    raise exception 'The new booking time is no longer available.'
      using errcode = '23P01';
  end if;

  v_slot_status := case
    when v_booking.status = 'confirmed'
      or exists (
        select 1
        from public.booking_slots slot
        where slot.tenant_id = v_booking.tenant_id
          and slot.booking_id = v_booking.id
          and slot.status = 'confirmed'
      ) then 'confirmed'
    else 'held'
  end;
  if v_slot_status = 'held'
     and (
       v_booking.expires_at is null
       or v_booking.expires_at <= now()
     ) then
    raise exception 'This booking hold has expired and cannot be rescheduled.'
      using errcode = '22023';
  end if;

  v_email_status := case
    when not p_notify_customer then 'not_requested'
    when nullif(btrim(coalesce(v_booking.customer_email, '')), '') is null
      then 'skipped_no_email'
    else 'pending'
  end;

  insert into public.booking_reschedule_events (
    tenant_id,
    booking_id,
    court_id, old_court_id,
    rescheduled_by,
    reason_code,
    public_reason,
    internal_note,
    notify_customer,
    customer_email_snapshot,
    old_starts_at,
    old_ends_at,
    new_starts_at,
    new_ends_at,
    subtotal_amount,
    service_fee_amount,
    total_amount,
    currency,
    idempotency_key,
    email_status
  ) values (
    v_booking.tenant_id,
    v_booking.id,
    p_court_id, v_booking.court_id,
    auth.uid(),
    v_reason_code,
    v_public_reason,
    v_internal_note,
    p_notify_customer,
    nullif(lower(btrim(coalesce(v_booking.customer_email, ''))), ''),
    v_booking.starts_at,
    v_booking.ends_at,
    v_new_start,
    v_new_end,
    v_booking.subtotal_amount,
    v_booking.service_fee_amount,
    v_booking.total_amount,
    v_booking.currency,
    p_idempotency_key,
    v_email_status
  )
  returning * into v_event;

  delete from public.booking_slots
  where tenant_id = v_booking.tenant_id
    and booking_id = v_booking.id;

  for v_index in 0..(v_duration_hours - 1) loop
    v_slot_start := v_new_start + make_interval(hours => v_index);
    insert into public.booking_slots (
      tenant_id,
      booking_id,
      court_id,
      starts_at,
      ends_at,
      status,
      hold_expires_at
    ) values (
      v_booking.tenant_id,
      v_booking.id,
      p_court_id,
      v_slot_start,
      v_slot_start + interval '1 hour',
      v_slot_status,
      case
        when v_slot_status = 'held' then v_booking.expires_at
        else null
      end
    );
  end loop;

  v_metadata_event := jsonb_build_object(
    'oldCourtId', v_booking.court_id, 'newCourtId', p_court_id,
    'eventId', v_event.id,
    'reasonCode', v_reason_code,
    'publicReason', v_public_reason,
    'rescheduledBy', auth.uid(),
    'rescheduledAt', v_event.created_at,
    'oldStartsAt', v_booking.starts_at,
    'oldEndsAt', v_booking.ends_at,
    'newStartsAt', v_new_start,
    'newEndsAt', v_new_end
  );
  update public.bookings
  set court_id = p_court_id, starts_at = v_new_start,
      ends_at = v_new_end,
      local_booking_date = p_local_date,
      metadata = metadata || jsonb_build_object(
        'lastReschedule',
        v_metadata_event
      )
  where tenant_id = v_booking.tenant_id
    and id = v_booking.id;

  return jsonb_build_object(
    'booking', jsonb_build_object(
      'id', v_booking.id,
      'reference', v_booking.reference,
      'courtId', p_court_id,
      'courtName', v_court.name,
      'startsAt', v_new_start,
      'endsAt', v_new_end,
      'localBookingDate', p_local_date,
      'status', v_booking.status,
      'paymentStatus', v_booking.payment_status,
      'subtotalAmount', v_booking.subtotal_amount,
      'serviceFeeAmount', v_booking.service_fee_amount,
      'totalAmount', v_booking.total_amount,
      'currency', v_booking.currency
    ),
    'event', jsonb_build_object(
      'id', v_event.id,
      'reasonCode', v_event.reason_code,
      'publicReason', v_event.public_reason,
      'internalNote', v_event.internal_note,
      'notifyCustomer', v_event.notify_customer,
      'oldStartsAt', v_event.old_starts_at,
      'oldEndsAt', v_event.old_ends_at,
      'newStartsAt', v_event.new_starts_at,
      'newEndsAt', v_event.new_ends_at,
      'rescheduledAt', v_event.created_at,
      'rescheduledBy', v_event.rescheduled_by,
      'emailStatus', v_event.email_status,
      'emailSentAt', v_event.email_sent_at,
      'emailErrorCode', v_event.email_last_error_code
    ),
    'idempotent', false
  );
end;
$function$
;
CREATE OR REPLACE FUNCTION public.prepare_picklestreet_court_change(p_booking_id uuid, p_local_date date, p_start_time time without time zone, p_reason_code text, p_public_reason text, p_internal_note text, p_notify_customer boolean, p_idempotency_key uuid, p_balance_request_id uuid, p_access_token_hash text, p_deadline_at timestamp with time zone, p_court_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET row_security TO 'off'
AS $function$
declare
  v_preview jsonb;
  v_option jsonb;
  v_booking public.bookings%rowtype;
  v_tenant public.tenants%rowtype;
  v_existing public.booking_balance_requests%rowtype;
  v_new_start timestamptz;
  v_new_end timestamptz;
  v_additional numeric(12,2);
  v_new_subtotal numeric(12,2);
  v_new_total numeric(12,2);
  v_duration integer;
  v_index integer;
  v_slot_start timestamptz;
  v_details jsonb;
begin
  if not exists(select 1 from public.bookings b join public.courts c on c.tenant_id=b.tenant_id and c.id=p_court_id and c.status='active' where b.id=p_booking_id and b.tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a') then
    raise exception 'The booking court is not available for rescheduling.' using errcode='22023';end if;
  if lower(btrim(coalesce(p_reason_code, ''))) not in (
    'customer_request',
    'weather',
    'court_maintenance',
    'schedule_conflict',
    'admin_correction',
    'other'
  ) then
    raise exception 'Choose a supported reschedule reason.'
      using errcode = '22023';
  end if;
  if char_length(btrim(coalesce(p_public_reason, ''))) not between 3 and 500 then
    raise exception 'Customer-facing reason must be between 3 and 500 characters';
  end if;
  if char_length(coalesce(p_internal_note, '')) > 1000 then
    raise exception 'Internal note must be 1000 characters or fewer';
  end if;
  if p_notify_customer is null then
    raise exception 'Customer notification preference is required';
  end if;

  v_preview := public.preview_picklestreet_court_priced(
    p_booking_id, p_local_date, p_court_id
  );

  -- Lock only after the origin/role-bound preview has authorized the caller.
  -- This prevents peer-tenant callers from using arbitrary UUIDs to lock rows.
  select booking.* into v_booking
  from public.bookings booking
  where booking.id = p_booking_id
  for update;
  if not found then
    raise exception 'Booking was not found.' using errcode = 'P0002';
  end if;
  if v_booking.checked_in_at is not null then
    raise exception 'CHECKED_IN_BOOKING_MUTATION_DENIED'
      using errcode = '22023';
  end if;

  select option into v_option
  from jsonb_array_elements(v_preview -> 'options') option
  where option ->> 'startTime' = to_char(p_start_time, 'HH24:MI')
  limit 1;
  if v_option is null or coalesce((v_option ->> 'available')::boolean, false)
    is not true then
    raise exception 'The new booking time is no longer available.'
      using errcode = '23P01';
  end if;
  v_additional := (v_option ->> 'additionalAmount')::numeric(12,2);
  if v_additional <= 0 then
    return public.commit_picklestreet_court_reschedule(
      p_booking_id, p_local_date, p_start_time, p_reason_code,
      p_public_reason, p_internal_note, p_notify_customer, p_idempotency_key, p_court_id
  ) || jsonb_build_object(
      'paymentRequired', false,
      'price', jsonb_build_object(
        'newTotalAmount', (v_option ->> 'newTotalAmount')::numeric,
        'additionalAmount', 0
      )
    );
  end if;

  select tenant.* into v_tenant
  from public.tenants tenant where tenant.id = v_booking.tenant_id;
  if v_booking.status <> 'confirmed'
     or v_booking.payment_status <> 'paid' then
    raise exception 'A price-changing reschedule requires a fully paid confirmed booking.'
      using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(v_booking.customer_email, '')), '') is null then
    raise exception 'A customer email is required for an additional payment link.'
      using errcode = '22023';
  end if;
  if p_balance_request_id is null
     or p_access_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'Reschedule balance request credential is invalid.'
      using errcode = '22023';
  end if;
  if p_deadline_at is null
     or p_deadline_at <= now()
     or p_deadline_at >= (v_option ->> 'startsAt')::timestamptz
     or (p_deadline_at at time zone v_tenant.timezone)::date
       <> (now() at time zone v_tenant.timezone)::date then
    raise exception 'Additional payment deadline must be later today and before play.'
      using errcode = '22023';
  end if;

  select request.* into v_existing
  from public.booking_balance_requests request
  where request.tenant_id = v_booking.tenant_id
    and request.request_type = 'reschedule_adjustment'
    and request.request_details ->> 'idempotencyKey' = p_idempotency_key::text;
  if found then
    return jsonb_build_object(
      'booking', v_preview -> 'booking',
      'paymentRequired', true,
      'balanceRequest', jsonb_build_object(
        'id', v_existing.id,
        'status', v_existing.status,
        'remainingAmount', v_existing.remaining_amount,
        'deadlineAt', v_existing.deadline_at
      ),
      'price', jsonb_build_object(
        'newTotalAmount',
          (v_existing.request_details ->> 'newTotalAmount')::numeric,
        'additionalAmount', v_existing.remaining_amount
      ),
      'idempotent', true
    );
  end if;
  if exists (
    select 1 from public.booking_balance_requests request
    where request.tenant_id = v_booking.tenant_id
      and request.booking_id = v_booking.id
      and request.status in ('awaiting_payment', 'payment_review')
  ) then
    raise exception 'This booking already has an active payment request.'
      using errcode = '22023';
  end if;

  v_new_start := (v_option ->> 'startsAt')::timestamptz;
  v_new_end := (v_option ->> 'endsAt')::timestamptz;
  if p_court_id=v_booking.court_id and tstzrange(v_booking.starts_at, v_booking.ends_at, '[)')
      && tstzrange(v_new_start, v_new_end, '[)') then
    raise exception 'A paid reschedule hold must not overlap the current schedule.'
      using errcode = '22023';
  end if;
  v_new_subtotal := (v_option ->> 'newSubtotalAmount')::numeric(12,2);
  v_new_total := (v_option ->> 'newTotalAmount')::numeric(12,2);
  v_duration :=
    extract(epoch from (v_new_end - v_new_start))::integer / 3600;
  v_details := jsonb_build_object(
    'idempotencyKey', p_idempotency_key,
    'oldCourtId', v_booking.court_id, 'newCourtId', p_court_id,
    'oldStartsAt', v_booking.starts_at,
    'oldEndsAt', v_booking.ends_at,
    'newStartsAt', v_new_start,
    'newEndsAt', v_new_end,
    'newLocalDate', p_local_date,
    'newStartTime', to_char(p_start_time, 'HH24:MI'),
    'newSubtotalAmount', v_new_subtotal,
    'newTotalAmount', v_new_total,
    'reasonCode', lower(btrim(p_reason_code)),
    'publicReason', btrim(p_public_reason),
    'internalNote', nullif(btrim(coalesce(p_internal_note, '')), ''),
    'notifyCustomer', p_notify_customer
  );

  insert into public.booking_balance_requests (
    id, tenant_id, booking_id, original_verification_id, token_hash,
    accepted_amount, remaining_amount, currency, status, deadline_at,
    issued_by, request_type, request_details
  ) values (
    p_balance_request_id, v_booking.tenant_id, v_booking.id, null,
    p_access_token_hash, v_booking.total_amount, v_additional,
    v_booking.currency, 'awaiting_payment', p_deadline_at, auth.uid(),
    'reschedule_adjustment', v_details
  );

  for v_index in 0..(v_duration - 1) loop
    v_slot_start := v_new_start + make_interval(hours => v_index);
    insert into public.booking_slots (
      tenant_id, booking_id, court_id, starts_at, ends_at, status,
      hold_expires_at, balance_request_id
    ) values (
      v_booking.tenant_id, v_booking.id, p_court_id,
      v_slot_start, v_slot_start + interval '1 hour', 'held',
      p_deadline_at, p_balance_request_id
    );
  end loop;

  return jsonb_build_object(
    'booking', v_preview -> 'booking',
    'paymentRequired', true,
    'balanceRequest', jsonb_build_object(
      'id', p_balance_request_id,
      'status', 'awaiting_payment',
      'remainingAmount', v_additional,
      'deadlineAt', p_deadline_at
    ),
    'price', jsonb_build_object(
      'newSubtotalAmount', v_new_subtotal,
      'newTotalAmount', v_new_total,
      'additionalAmount', v_additional
    ),
    'idempotent', false
  );
end;
$function$
;
CREATE OR REPLACE FUNCTION public.prepare_picklestreet_court_reschedule(p_booking_id uuid, p_local_date date, p_start_time time without time zone, p_reason_code text, p_public_reason text, p_internal_note text, p_notify_customer boolean, p_idempotency_key uuid, p_balance_request_id uuid, p_access_token_hash text, p_deadline_at timestamp with time zone, p_court_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET row_security TO 'off'
AS $function$
declare
  v_booking public.bookings%rowtype;
  v_tenant_id uuid;
  v_result jsonb;
  v_reactivation jsonb;
  v_adjustment_action jsonb;
  v_idempotency_request public.booking_balance_requests%rowtype;
  v_balance_notice_required boolean := false;
begin
  if not exists(select 1 from public.bookings b join public.courts c on c.tenant_id=b.tenant_id and c.id=p_court_id and c.status='active' where b.id=p_booking_id and b.tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a') then
    raise exception 'The booking court is not available for rescheduling.' using errcode='22023';end if;
  if auth.uid() is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;
  if p_idempotency_key is null then
    raise exception 'A valid idempotency key is required.' using errcode = '22023';
  end if;

  select booking.* into v_booking
  from public.bookings booking
  where booking.id = p_booking_id;
  if not found then
    raise exception 'Booking was not found.' using errcode = 'P0002';
  end if;
  v_tenant_id := v_booking.tenant_id;
  if not public.request_origin_matches_tenant(v_booking.tenant_id)
     or not (
       public.is_platform_owner()
       or public.has_tenant_role(v_booking.tenant_id, array['owner'])
     ) then
    raise exception 'Only the System Owner or Court Owner can reschedule this booking.'
      using errcode = '42501';
  end if;

  if exists(select 1 from public.booking_reschedule_events where tenant_id=v_tenant_id and idempotency_key=p_idempotency_key and court_id<>p_court_id)
    or exists(select 1 from public.booking_balance_requests where tenant_id=v_tenant_id and request_details->>'idempotencyKey'=p_idempotency_key::text and coalesce((request_details->>'newCourtId')::uuid,v_booking.court_id)<>p_court_id) then
    raise exception 'The idempotency key was already used for a different reschedule request.' using errcode='22023';end if;
  -- A successfully applied reschedule event is the authoritative idempotent
  -- result. Check it before historical balance requests so a retry after its
  -- adjustment was settled does not fail merely because that request is no
  -- longer active. The core RPC validates that the protected payload matches.
  if exists (
    select 1
    from public.booking_reschedule_events event
    where event.tenant_id = v_booking.tenant_id
      and event.idempotency_key = p_idempotency_key
  ) then
    v_result := public.commit_picklestreet_court_reschedule(
      p_booking_id, p_local_date, p_start_time, p_reason_code,
      p_public_reason, p_internal_note, p_notify_customer, p_idempotency_key, p_court_id
  );
    return v_result || jsonb_build_object(
      'paymentRequired', false,
      'balanceNoticeRequired', false,
      'price', jsonb_build_object(
        'newTotalAmount', (v_result #>> '{booking,totalAmount}')::numeric,
        'additionalAmount', 0
      )
    );
  end if;

  -- Resolve every historical adjustment key before touching the current active
  -- request. Otherwise a delayed K1 retry could cancel newer K2 and then be
  -- replayed by the legacy tenant-wide key lookup.
  select request.* into v_idempotency_request
  from public.booking_balance_requests request
  where request.tenant_id = v_booking.tenant_id
    and request.request_type = 'reschedule_adjustment'
    and request.request_details ->> 'idempotencyKey' = p_idempotency_key::text
  for update;
  if found then
    if v_idempotency_request.booking_id is distinct from v_booking.id
       or v_idempotency_request.request_details ->> 'newLocalDate'
         is distinct from p_local_date::text
       or v_idempotency_request.request_details ->> 'newStartTime'
         is distinct from to_char(p_start_time, 'HH24:MI')
       or v_idempotency_request.request_details ->> 'reasonCode'
         is distinct from lower(btrim(coalesce(p_reason_code, '')))
       or v_idempotency_request.request_details ->> 'publicReason'
         is distinct from btrim(coalesce(p_public_reason, ''))
       or nullif(v_idempotency_request.request_details ->> 'internalNote', '')
         is distinct from nullif(btrim(coalesce(p_internal_note, '')), '')
       or (v_idempotency_request.request_details ->> 'notifyCustomer')::boolean
         is distinct from p_notify_customer then
      raise exception 'The idempotency key was already used for a different reschedule request.'
        using errcode = '22023';
    end if;
    if v_idempotency_request.status not in (
      'awaiting_payment', 'payment_review'
    ) then
      raise exception 'The idempotency key was already used by an inactive reschedule payment request.'
        using errcode = '22023';
    end if;
    return jsonb_build_object(
      'booking', jsonb_build_object(
        'id', v_booking.id,
        'reference', v_booking.reference,
        'courtId', v_booking.court_id,
        'startsAt', v_booking.starts_at,
        'endsAt', v_booking.ends_at,
        'localBookingDate', v_booking.local_booking_date,
        'status', v_booking.status,
        'paymentStatus', v_booking.payment_status,
        'subtotalAmount', v_booking.subtotal_amount,
        'serviceFeeAmount', v_booking.service_fee_amount,
        'totalAmount', v_booking.total_amount,
        'currency', v_booking.currency
      ),
      'paymentRequired', true,
      'balanceNoticeRequired', public.owner_balance_notice_required(
        v_booking.tenant_id, v_booking.id, v_idempotency_request.id
      ),
      'balanceRequest', jsonb_build_object(
        'id', v_idempotency_request.id,
        'status', v_idempotency_request.status,
        'remainingAmount', v_idempotency_request.remaining_amount,
        'deadlineAt', v_idempotency_request.deadline_at
      ),
      'price', jsonb_build_object(
        'newTotalAmount',
          (v_idempotency_request.request_details ->> 'newTotalAmount')::numeric,
        'additionalAmount', v_idempotency_request.remaining_amount
      ),
      'idempotent', true
    );
  end if;

  if exists (
    select 1
    from public.booking_balance_requests request
    where request.tenant_id = v_booking.tenant_id
      and request.booking_id = v_booking.id
      and request.request_type = 'reschedule_adjustment'
      and request.status in ('expired', 'cancelled')
      and (
        exists (
          select 1 from public.receipt_verifications verification
          where verification.tenant_id = request.tenant_id
            and verification.balance_request_id = request.id
            and verification.status in (
              'pending', 'manual_review', 'auto_approved', 'approved',
              'short_payment'
            )
        )
        or exists (
          select 1 from public.payment_sessions payment
          where payment.tenant_id = request.tenant_id
            and payment.booking_id = request.booking_id
            and payment.provider_payload ->> 'balanceRequestId' = request.id::text
            and payment.status not in ('failed', 'expired', 'refunded')
        )
        or exists (
          select 1 from public.payment_receipt_uploads upload
          where upload.tenant_id = request.tenant_id
            and upload.booking_id = request.booking_id
            and upload.balance_request_id = request.id
            and upload.status in ('uploaded', 'finalizing')
        )
      )
  ) then
    raise exception 'This reschedule payment request has unresolved receipt evidence and cannot be replaced.'
      using errcode = '22023';
  end if;

  v_adjustment_action :=
    public.owner_supersede_unsubmitted_reschedule_adjustment(
      p_booking_id, p_local_date, p_start_time, p_reason_code,
      p_public_reason, p_internal_note, p_notify_customer, p_idempotency_key
    );

  -- Protected receipt activity returns before any booking lock, avoiding the
  -- opposite booking -> request order used by receipt recording.
  if coalesce(v_adjustment_action ->> 'action', '') = 'protected' then
    raise exception 'This reschedule payment request has receipt activity or payment review and cannot be replaced.'
      using errcode = '22023';
  end if;

  -- Two concurrent first attempts can both miss the initial key lookup. The
  -- loser waits on the booking in the helper while the winner creates the
  -- request, so re-read without a request lock and replay that exact request
  -- instead of reporting a false active-request conflict. Avoiding a request
  -- lock here also avoids a booking -> request cycle with receipt submission.
  if v_adjustment_action is null then
    if exists (
      select 1
      from public.booking_reschedule_events event
      where event.tenant_id = v_booking.tenant_id
        and event.idempotency_key = p_idempotency_key
    ) then
      v_result := public.commit_picklestreet_court_reschedule(
        p_booking_id, p_local_date, p_start_time, p_reason_code,
        p_public_reason, p_internal_note, p_notify_customer, p_idempotency_key, p_court_id
  );
      return v_result || jsonb_build_object(
        'paymentRequired', false,
        'balanceNoticeRequired', false,
        'price', jsonb_build_object(
          'newTotalAmount', (v_result #>> '{booking,totalAmount}')::numeric,
          'additionalAmount', 0
        )
      );
    end if;
    v_idempotency_request := null;
    select request.* into v_idempotency_request
    from public.booking_balance_requests request
    where request.tenant_id = v_booking.tenant_id
      and request.request_type = 'reschedule_adjustment'
      and request.request_details ->> 'idempotencyKey' = p_idempotency_key::text
    order by request.created_at desc, request.id desc
    limit 1;
    if found then
      if v_idempotency_request.booking_id is distinct from v_booking.id
         or v_idempotency_request.request_details ->> 'newLocalDate'
           is distinct from p_local_date::text
         or v_idempotency_request.request_details ->> 'newStartTime'
           is distinct from to_char(p_start_time, 'HH24:MI')
         or v_idempotency_request.request_details ->> 'reasonCode'
           is distinct from lower(btrim(coalesce(p_reason_code, '')))
         or v_idempotency_request.request_details ->> 'publicReason'
           is distinct from btrim(coalesce(p_public_reason, ''))
         or nullif(v_idempotency_request.request_details ->> 'internalNote', '')
           is distinct from nullif(btrim(coalesce(p_internal_note, '')), '')
         or (v_idempotency_request.request_details ->> 'notifyCustomer')::boolean
           is distinct from p_notify_customer then
        raise exception 'The idempotency key was already used for a different reschedule request.'
          using errcode = '22023';
      end if;
      if v_idempotency_request.status not in (
        'awaiting_payment', 'payment_review'
      ) then
        raise exception 'The idempotency key was already used by an inactive reschedule payment request.'
          using errcode = '22023';
      end if;
      return jsonb_build_object(
        'booking', jsonb_build_object(
          'id', v_booking.id,
          'reference', v_booking.reference,
          'courtId', v_booking.court_id,
          'startsAt', v_booking.starts_at,
          'endsAt', v_booking.ends_at,
          'localBookingDate', v_booking.local_booking_date,
          'status', v_booking.status,
          'paymentStatus', v_booking.payment_status,
          'subtotalAmount', v_booking.subtotal_amount,
          'serviceFeeAmount', v_booking.service_fee_amount,
          'totalAmount', v_booking.total_amount,
          'currency', v_booking.currency
        ),
        'paymentRequired', true,
        'balanceNoticeRequired', public.owner_balance_notice_required(
          v_booking.tenant_id, v_booking.id, v_idempotency_request.id
        ),
        'balanceRequest', jsonb_build_object(
          'id', v_idempotency_request.id,
          'status', v_idempotency_request.status,
          'remainingAmount', v_idempotency_request.remaining_amount,
          'deadlineAt', v_idempotency_request.deadline_at
        ),
        'price', jsonb_build_object(
          'newTotalAmount',
            (v_idempotency_request.request_details ->> 'newTotalAmount')::numeric,
          'additionalAmount', v_idempotency_request.remaining_amount
        ),
        'idempotent', true
      );
    end if;
  end if;
  if v_adjustment_action is null
     and exists (
       select 1
       from public.booking_balance_requests request
       where request.tenant_id = v_booking.tenant_id
         and request.booking_id = v_booking.id
         and request.status in ('awaiting_payment', 'payment_review')
     ) then
    raise exception 'This booking already has an active payment request.'
      using errcode = '22023';
  end if;
  if coalesce(v_adjustment_action ->> 'action', '') = 'replay' then
    return jsonb_build_object(
      'booking', jsonb_build_object(
        'id', v_booking.id,
        'reference', v_booking.reference,
        'courtId', v_booking.court_id,
        'startsAt', v_booking.starts_at,
        'endsAt', v_booking.ends_at,
        'localBookingDate', v_booking.local_booking_date,
        'status', v_booking.status,
        'paymentStatus', v_booking.payment_status,
        'subtotalAmount', v_booking.subtotal_amount,
        'serviceFeeAmount', v_booking.service_fee_amount,
        'totalAmount', v_booking.total_amount,
        'currency', v_booking.currency
      ),
      'paymentRequired', true,
      'balanceNoticeRequired', public.owner_balance_notice_required(
        v_booking.tenant_id,
        v_booking.id,
        (v_adjustment_action ->> 'id')::uuid
      ),
      'balanceRequest', jsonb_build_object(
        'id', (v_adjustment_action ->> 'id')::uuid,
        'status', v_adjustment_action ->> 'status',
        'remainingAmount',
          (v_adjustment_action ->> 'remainingAmount')::numeric,
        'deadlineAt',
          (v_adjustment_action ->> 'deadlineAt')::timestamptz
      ),
      'price', jsonb_build_object(
        'newTotalAmount',
          (v_adjustment_action ->> 'newTotalAmount')::numeric,
        'additionalAmount',
          (v_adjustment_action ->> 'remainingAmount')::numeric
      ),
      'idempotent', true
    );
  end if;

  -- The pristine path has acquired advisory -> request -> booking, or just the
  -- booking when no reschedule adjustment exists. Reload its protected current
  -- snapshot without changing that lock order.
  select booking.* into v_booking
  from public.bookings booking
  where booking.tenant_id = v_tenant_id
    and booking.id = p_booking_id
  for update;
  if not found then
    raise exception 'Booking was not found.' using errcode = 'P0002';
  end if;
  if not public.request_origin_matches_tenant(v_booking.tenant_id)
     or not (
       public.is_platform_owner()
       or public.has_tenant_role(v_booking.tenant_id, array['owner'])
     ) then
    raise exception 'Only the System Owner or Court Owner can reschedule this booking.'
      using errcode = '42501';
  end if;

  if not (
    v_booking.status = 'completed'
    or (
      v_booking.status = 'confirmed'
      and v_booking.ends_at <= statement_timestamp()
    )
  ) then
    v_result := public.prepare_picklestreet_court_change(
      p_booking_id, p_local_date, p_start_time, p_reason_code,
      p_public_reason, p_internal_note, p_notify_customer, p_idempotency_key,
      p_balance_request_id, p_access_token_hash, p_deadline_at, p_court_id
  );
    v_balance_notice_required :=
      coalesce((v_result ->> 'paymentRequired')::boolean, false)
      and public.owner_balance_notice_required(
        v_booking.tenant_id,
        v_booking.id,
        (v_result #>> '{balanceRequest,id}')::uuid
      );
    v_result := v_result || jsonb_build_object(
      'balanceNoticeRequired', v_balance_notice_required
    );
    if coalesce(v_adjustment_action ->> 'action', '') = 'superseded' then
      v_result := v_result || jsonb_build_object(
        'supersededBalanceRequest', v_adjustment_action - 'action'
      );
    end if;
    return v_result;
  end if;

  if v_booking.archived_at is not null
     or v_booking.status not in ('confirmed', 'completed')
     or v_booking.ends_at > statement_timestamp() then
    raise exception 'Booking cannot be rescheduled from its current status.'
      using errcode = '22023';
  end if;
  if exists (
    select 1
    from public.booking_balance_requests request
    where request.tenant_id = v_booking.tenant_id
      and request.booking_id = v_booking.id
      and request.status in ('awaiting_payment', 'payment_review')
  ) then
    raise exception 'This booking already has an active payment request.'
      using errcode = '22023';
  end if;

  v_reactivation := jsonb_build_object(
    'reactivatedAt', statement_timestamp(),
    'reactivatedBy', auth.uid(),
    'previousStatus', v_booking.status,
    'previousCheckedInAt', v_booking.checked_in_at,
    'previousCheckedInBy', v_booking.checked_in_by,
    'reason', 'owner_ended_booking_reschedule'
  );
  perform set_config('app.owner_completed_reschedule', 'on', true);
  update public.bookings booking
  set status = 'confirmed',
      checked_in_at = null,
      checked_in_by = null,
      metadata = jsonb_set(
        coalesce(booking.metadata, '{}'::jsonb)
          || jsonb_build_object(
            'lastCompletedRescheduleReactivation', v_reactivation
          ),
        '{completedRescheduleReactivationHistory}',
        case
          when jsonb_typeof(
            booking.metadata -> 'completedRescheduleReactivationHistory'
          ) = 'array'
            then booking.metadata -> 'completedRescheduleReactivationHistory'
          else '[]'::jsonb
        end || jsonb_build_array(v_reactivation),
        true
      )
  where booking.tenant_id = v_booking.tenant_id
    and booking.id = v_booking.id;
  perform set_config('app.owner_completed_reschedule', 'off', true);

  v_result := public.commit_picklestreet_court_reschedule(
    p_booking_id, p_local_date, p_start_time, p_reason_code,
    p_public_reason, p_internal_note, p_notify_customer, p_idempotency_key, p_court_id
  );
  v_result := v_result || jsonb_build_object(
    'paymentRequired', false,
    'balanceNoticeRequired', false,
    'price', jsonb_build_object(
      'newTotalAmount', (v_result #>> '{booking,totalAmount}')::numeric,
      'additionalAmount', 0,
      'settledFinancialsPreserved', true
    ),
    'reactivatedFromCompleted', v_booking.status = 'completed',
    'reactivatedFromEnded', true
  );
  if coalesce(v_adjustment_action ->> 'action', '') = 'superseded' then
    v_result := v_result || jsonb_build_object(
      'supersededBalanceRequest', v_adjustment_action - 'action'
    );
  end if;
  return v_result;
end;
$function$
;
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
 target_court uuid;target_start timestamptz;target_end timestamptz;target_count integer;target_duration numeric;old_count integer;
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
   or (
     not (
       data#>>'{detected,route,sourceProvider}'='maya'
       and data#>>'{detected,route,destinationProvider}'='gcash'
       and coalesce((data#>>'{detected,route,mayaReferenceOnlyPolicy}')::boolean,false) is true
       and data#>>'{detected,route,mayaStatus}' in('completed','processing')
       and coalesce((data#>>'{timing,withinWindow}')::boolean,false) is false
       and nullif(data#>>'{timing,receiptDate}','') is null
       and nullif(data#>>'{timing,receiptTime}','') is null
       and nullif(data#>>'{timing,receiptDateTime}','') is null
     )
     and (
       coalesce((data#>>'{timing,withinWindow}')::boolean,false) is not true
       or nullif(data#>>'{timing,receiptDate}','') is null
       or nullif(data#>>'{timing,receiptTime}','') is null
     )
   )
   or ref is null or (nullif(btrim(a.submitted_reference),'') is not null and (char_length(regexp_replace(a.submitted_reference,'[^A-Za-z0-9]','','g'))<6
   or regexp_replace(upper(a.submitted_reference),'[^A-Z0-9]','','g')<>regexp_replace(upper(ref),'[^A-Z0-9]','','g')))
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
     if q.request_details->'groupRescheduleV1'='true'::jsonb then
       perform set_config('app.picklestreet_balance_auto',r.id::text,true);
       reschedule_id:=public.commit_picklestreet_group_reschedule((q.request_details->>'groupRequestId')::uuid);
     else
     if b.checked_in_at is not null then raise exception 'booking_checked_in' using errcode='P0001';end if;
     if q.request_type='reschedule_adjustment' then
       if b.status<>'confirmed' or b.payment_status<>'paid' or b.starts_at is distinct from j.original_starts_at
         or b.ends_at is distinct from j.original_ends_at or b.total_amount<>q.accepted_amount
         or(q.request_details->>'oldStartsAt')::timestamptz is distinct from b.starts_at
         or(q.request_details->>'oldEndsAt')::timestamptz is distinct from b.ends_at then raise exception 'original_booking_changed' using errcode='P0001';end if;
       target_court:=coalesce((q.request_details->>'newCourtId')::uuid,b.court_id);target_start:=(q.request_details->>'newStartsAt')::timestamptz;target_end:=(q.request_details->>'newEndsAt')::timestamptz;
       new_subtotal:=(q.request_details->>'newSubtotalAmount')::numeric;new_total:=(q.request_details->>'newTotalAmount')::numeric;
       if new_total<>q.accepted_amount+q.remaining_amount or new_total<>new_subtotal+b.service_fee_amount then raise exception 'reschedule_price_changed' using errcode='P0001';end if;
       if(q.request_details->>'newLocalDate')::date is distinct from(target_start at time zone zone)::date then
         raise exception 'reservation_slots_changed' using errcode='P0001';end if;
     else
       if b.status not in ('payment_review','expired') or b.payment_status not in ('partial','pending')
         or q.accepted_amount+q.remaining_amount<>b.total_amount then raise exception 'balance_booking_changed' using errcode='P0001';end if;
       target_court:=b.court_id;target_start:=b.starts_at;target_end:=b.ends_at;
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
     perform c.id from public.courts c where c.tenant_id=t and c.id=target_court for share;
     if not exists(select 1 from public.courts where tenant_id=t and id=target_court and status='active') then raise exception 'reservation_court_unavailable' using errcode='P0001';end if;
     perform slot.id from public.booking_slots slot where slot.tenant_id=t and slot.booking_id=b.id order by slot.starts_at,slot.id for update;
     select count(*),coalesce(sum(extract(epoch from(ends_at-starts_at))),0),count(*) filter(where status='held' and hold_expires_at>clock_timestamp())
       into target_count,target_duration,active_count from public.booking_slots where tenant_id=t and booking_id=b.id
       and(case when q.request_type='reschedule_adjustment' then balance_request_id=q.id else balance_request_id is null end);
     if target_count<1 or target_duration<>extract(epoch from(target_end-target_start)) or exists(select 1 from public.booking_slots
       where tenant_id=t and booking_id=b.id and(case when q.request_type='reschedule_adjustment' then balance_request_id=q.id else balance_request_id is null end)
       and(status not in ('held','expired') or court_id<>target_court or starts_at<target_start or ends_at>target_end)) then raise exception 'reservation_slots_changed' using errcode='P0001';end if;
     if exists(select 1 from public.blocked_dates blocked where blocked.tenant_id=t and(blocked.court_id is null or blocked.court_id=target_court)
       and blocked.blocked_on between(target_start at time zone zone)::date and((target_end-interval '1 microsecond') at time zone zone)::date
       and tsrange(target_start at time zone zone,target_end at time zone zone,'[)') && case when blocked.starts_at is null then
         tsrange(blocked.blocked_on::timestamp,(blocked.blocked_on+1)::timestamp,'[)') else tsrange(blocked.blocked_on+blocked.starts_at,
         case when blocked.ends_at=time '23:59:59' then(blocked.blocked_on+1)::timestamp else blocked.blocked_on+blocked.ends_at end,'[)') end) then
       raise exception 'reservation_court_blocked' using errcode='P0001';end if;
     -- Explicit occupancy check includes open play. Database exclusion remains
     -- authoritative for any concurrent writer after this check.
     if exists(select 1 from public.court_occupancies occupancy where occupancy.tenant_id=t and occupancy.court_id=target_court
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
       insert into public.booking_reschedule_events(tenant_id,booking_id,court_id,old_court_id,rescheduled_by,reason_code,public_reason,internal_note,notify_customer,
         customer_email_snapshot,old_starts_at,old_ends_at,new_starts_at,new_ends_at,subtotal_amount,service_fee_amount,total_amount,currency,idempotency_key,email_status)
         values(t,b.id,target_court,b.court_id,null,q.request_details->>'reasonCode',q.request_details->>'publicReason',nullif(q.request_details->>'internalNote',''),
           coalesce((q.request_details->>'notifyCustomer')::boolean,false),nullif(lower(btrim(b.customer_email)),''),b.starts_at,b.ends_at,target_start,target_end,
           new_subtotal,b.service_fee_amount,new_total,b.currency,(q.request_details->>'idempotencyKey')::uuid,'not_requested') returning * into e;
       reschedule_id:=e.id;
       delete from public.booking_slots where tenant_id=t and booking_id=b.id and balance_request_id is null;
       update public.booking_slots set status='confirmed',hold_expires_at=null,balance_request_id=null where tenant_id=t and booking_id=b.id and balance_request_id=q.id;
       update public.bookings set court_id=target_court,starts_at=target_start,ends_at=target_end,local_booking_date=(q.request_details->>'newLocalDate')::date,
         subtotal_amount=new_subtotal,total_amount=new_total,metadata=metadata||jsonb_build_object('lastReschedule',jsonb_build_object(
           'eventId',e.id,'reasonCode',e.reason_code,'publicReason',e.public_reason,'rescheduledBy',null,'rescheduledAt',e.created_at,
           'oldStartsAt',e.old_starts_at,'oldEndsAt',e.old_ends_at,'newStartsAt',e.new_starts_at,'newEndsAt',e.new_ends_at,
           'priceAdjustmentAmount',q.remaining_amount,'automaticReceiptAttemptId',a.id)) where tenant_id=t and id=b.id;
     else
       update public.booking_slots set status='confirmed',hold_expires_at=null where tenant_id=t and booking_id=b.id and balance_request_id is null;
       update public.bookings set status='confirmed',payment_status='paid',confirmed_at=now(),expires_at=null where tenant_id=t and id=b.id;
     end if;

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
 authorized boolean:=false;system_owner boolean:=false;zone text;v_note text:=case when p_decision='approve' then coalesce(nullif(btrim(p_review_note),''),'Payment receipt reviewed; payment confirmed as received by staff.') else btrim(p_review_note) end;
 target_court uuid;target_start timestamptz;target_end timestamptz;target_count integer;target_duration numeric;
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
 system_owner:=found;
 authorized:=authorized or system_owner;
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
   if q.request_details->'groupRescheduleV1'='true'::jsonb then
     reschedule_id:=public.commit_picklestreet_group_reschedule((q.request_details->>'groupRequestId')::uuid);
   else
   if b.checked_in_at is not null then raise exception 'booking_checked_in' using errcode='22023';end if;
   if q.request_type='reschedule_adjustment' then
     if b.status<>'confirmed' or(q.request_details->>'oldStartsAt')::timestamptz is distinct from b.starts_at
       or(q.request_details->>'oldEndsAt')::timestamptz is distinct from b.ends_at then raise exception 'original_booking_changed' using errcode='22023';end if;
     target_court:=coalesce((q.request_details->>'newCourtId')::uuid,b.court_id);target_start:=(q.request_details->>'newStartsAt')::timestamptz;target_end:=(q.request_details->>'newEndsAt')::timestamptz;
     new_subtotal:=(q.request_details->>'newSubtotalAmount')::numeric;new_total:=(q.request_details->>'newTotalAmount')::numeric;
     if new_total is null or new_subtotal is null or new_total<>q.accepted_amount+q.remaining_amount or new_total<>new_subtotal+b.service_fee_amount
       or(q.request_details->>'newLocalDate')::date is distinct from(target_start at time zone zone)::date then
       raise exception 'reschedule_price_changed' using errcode='22023';end if;
   else
     target_court:=b.court_id;target_start:=b.starts_at;target_end:=b.ends_at;
     if q.request_type='short_payment' and not exists(select 1 from public.receipt_verifications original join public.payment_sessions payment
       on payment.tenant_id=original.tenant_id and payment.id=original.payment_session_id
       where original.tenant_id=t and original.id=q.original_verification_id and original.status='short_payment' and payment.status='paid') then
       raise exception 'original_payment_unverified' using errcode='22023';end if;
   end if;
   if target_start is null or target_end is null or not isfinite(target_start) or not isfinite(target_end) or target_end<=target_start
     or target_end-target_start<>b.ends_at-b.starts_at then raise exception 'reservation_slots_changed' using errcode='22023';end if;
   if q.request_type='reschedule_adjustment' and (target_start<=clock_timestamp() or b.starts_at<=clock_timestamp()) then raise exception 'booking_started' using errcode='22023';end if;
   perform set_config('lock_timeout','1000ms',true);
   lock table public.blocked_dates in share mode;
   perform 1 from public.courts where tenant_id=t and id=target_court and status='active' for share;
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
       and(status not in('held','expired') or court_id<>target_court or starts_at<target_start or ends_at>target_end))
     or exists(select 1 from public.booking_slots one join public.booking_slots two on two.tenant_id=one.tenant_id
       and two.booking_id=one.booking_id and two.id<>one.id and two.starts_at<one.ends_at and two.ends_at>one.starts_at
       where one.tenant_id=t and one.booking_id=b.id
       and(case when q.request_type='reschedule_adjustment' then one.balance_request_id=q.id and two.balance_request_id=q.id
         else one.balance_request_id is null and two.balance_request_id is null end)) then
     raise exception 'reservation_slots_changed' using errcode='22023';end if;
   if exists(select 1 from public.blocked_dates blocked where blocked.tenant_id=t and(blocked.court_id is null or blocked.court_id=target_court)
     and blocked.blocked_on between(target_start at time zone zone)::date and((target_end-interval '1 microsecond') at time zone zone)::date
     and tsrange(target_start at time zone zone,target_end at time zone zone,'[)') && case when blocked.starts_at is null then
       tsrange(blocked.blocked_on::timestamp,(blocked.blocked_on+1)::timestamp,'[)') else tsrange(blocked.blocked_on+blocked.starts_at,
       case when blocked.ends_at=time '23:59:59' then(blocked.blocked_on+1)::timestamp else blocked.blocked_on+blocked.ends_at end,'[)') end) then
     raise exception 'reservation_court_blocked' using errcode='22023';end if;
   if exists(select 1 from public.court_occupancies occupancy where occupancy.tenant_id=t and occupancy.court_id=target_court
     and occupancy.starts_at<target_end and occupancy.ends_at>target_start
     and(occupancy.status='confirmed' or(occupancy.status='held' and occupancy.hold_expires_at>clock_timestamp()))
     and not(occupancy.source_kind='booking_slot' and exists(select 1 from public.booking_slots own where own.tenant_id=t
       and own.booking_id=b.id and own.id=occupancy.source_id
       and(case when q.request_type='reschedule_adjustment' then own.balance_request_id=q.id else own.balance_request_id is null end)))) then
     raise exception 'reservation_time_unavailable' using errcode='22023';end if;
   end if;
   if q.request_type='reschedule_adjustment' and (target_start<=clock_timestamp() or b.starts_at<=clock_timestamp()) then raise exception 'booking_started' using errcode='22023';end if;
   restored:=active_count<>target_count;
   if q.request_type='reschedule_adjustment' then
     if not exists(select 1 from public.booking_slots where tenant_id=t and booking_id=b.id and balance_request_id is null)
       or(select coalesce(sum(extract(epoch from(ends_at-starts_at))),0) from public.booking_slots where tenant_id=t and booking_id=b.id and balance_request_id is null)<>extract(epoch from(b.ends_at-b.starts_at))
       or exists(select 1 from public.booking_slots where tenant_id=t and booking_id=b.id and balance_request_id is null
         and(status<>'confirmed' or court_id<>b.court_id or starts_at<b.starts_at or ends_at>b.ends_at)) then
       raise exception 'original_booking_changed' using errcode='22023';end if;
     insert into public.booking_reschedule_events(tenant_id,booking_id,court_id,old_court_id,rescheduled_by,reason_code,public_reason,internal_note,notify_customer,
       customer_email_snapshot,old_starts_at,old_ends_at,new_starts_at,new_ends_at,subtotal_amount,service_fee_amount,total_amount,currency,idempotency_key,email_status)
     values(t,b.id,target_court,b.court_id,p_actor_user_id,q.request_details->>'reasonCode',q.request_details->>'publicReason',nullif(q.request_details->>'internalNote',''),
       coalesce((q.request_details->>'notifyCustomer')::boolean,false),nullif(lower(btrim(b.customer_email)),''),b.starts_at,b.ends_at,target_start,target_end,
       new_subtotal,b.service_fee_amount,new_total,b.currency,(q.request_details->>'idempotencyKey')::uuid,'not_requested') returning * into e;
     reschedule_id:=e.id;
     delete from public.booking_slots where tenant_id=t and booking_id=b.id and balance_request_id is null;
     update public.booking_slots set status='confirmed',hold_expires_at=null,balance_request_id=null where tenant_id=t and booking_id=b.id and balance_request_id=q.id;
     update public.bookings set court_id=target_court,starts_at=target_start,ends_at=target_end,local_booking_date=(q.request_details->>'newLocalDate')::date,
       subtotal_amount=new_subtotal,total_amount=new_total,metadata=metadata||jsonb_build_object('lastReschedule',jsonb_build_object(
         'eventId',e.id,'reasonCode',e.reason_code,'publicReason',e.public_reason,'rescheduledBy',p_actor_user_id,'rescheduledAt',e.created_at,
         'oldStartsAt',e.old_starts_at,'oldEndsAt',e.old_ends_at,'newStartsAt',e.new_starts_at,'newEndsAt',e.new_ends_at,
         'priceAdjustmentAmount',q.remaining_amount,'staffReceiptReviewId',d.id)) where tenant_id=t and id=b.id;
   else
     update public.booking_slots set status='confirmed',hold_expires_at=null where tenant_id=t and booking_id=b.id and balance_request_id is null;
     update public.bookings set status='confirmed',payment_status='paid',confirmed_at=now(),expires_at=null where tenant_id=t and id=b.id;
   end if;

     end if;
   update public.receipt_verifications set status=case when system_owner then 'auto_approved' else 'approved' end,reviewed_at=now(),reviewed_by=p_actor_user_id,
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
 v_result:=jsonb_build_object('ok',true,'status',r.status,'receiptStatus',case when system_owner and p_decision='approve' then 'approved' else r.status end,'storedReceiptStatus',r.status,'verificationId',r.id,'reviewId',d.id,'decision',p_decision,
   'bookingReference',b.reference,'bookingStatus',b.status,'paymentStatus',b.payment_status,'balanceRequestId',q.id,
   'requestType',q.request_type,'balanceStatus',q.status,'rescheduleEventId',reschedule_id,'reservationRestored',restored,
   'reviewedBy',p_actor_user_id,'reviewedAt',r.reviewed_at,'reviewNote',v_note);
 update public.picklestreet_receipt_staff_reviews set result=v_result,completed_at=clock_timestamp() where tenant_id=t and id=d.id;
 perform set_config('app.picklestreet_staff_review',coalesce(prior_marker,''),true);
 perform set_config('request.jwt.claims',coalesce(prior_claims,''),true);perform set_config('request.jwt.claim.sub',coalesce(prior_sub,''),true);
 return v_result;
end;$function$
;
CREATE OR REPLACE FUNCTION public.preview_picklestreet_court_reschedule(p_booking_id uuid,p_local_date date) returns jsonb language plpgsql security definer set search_path='' set row_security=off as $$
declare b public.bookings%rowtype;c record;r jsonb;result jsonb;options jsonb:='[]';courts jsonb:='[]';begin
select * into b from public.bookings where id=p_booking_id and tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';
if b.id is null or auth.uid() is null or not public.request_origin_matches_tenant(b.tenant_id) or not(public.is_platform_owner() or public.has_tenant_role(b.tenant_id,array['owner'])) then raise exception 'Tenant booking access denied.' using errcode='42501';end if;
for c in select id,name from public.courts where tenant_id=b.tenant_id and status='active' order by name,id loop
 r:=public.preview_picklestreet_court_priced(p_booking_id,p_local_date,c.id);result:=r;options:=options||(r->'options');courts:=courts||jsonb_build_array(jsonb_build_object('id',c.id,'name',c.name));end loop;
return result||jsonb_build_object('options',options,'courts',courts);end;$$;
revoke all on function public.preview_picklestreet_court_availability(uuid,date,uuid) from public,anon,authenticated;
revoke all on function public.preview_picklestreet_court_priced(uuid,date,uuid) from public,anon,authenticated;
revoke all on function public.commit_picklestreet_court_reschedule(uuid,date,time without time zone,text,text,text,boolean,uuid,uuid) from public,anon,authenticated;
revoke all on function public.prepare_picklestreet_court_change(uuid,date,time without time zone,text,text,text,boolean,uuid,uuid,text,timestamp with time zone,uuid) from public,anon,authenticated;
revoke all on function public.prepare_picklestreet_court_reschedule(uuid,date,time without time zone,text,text,text,boolean,uuid,uuid,text,timestamp with time zone,uuid) from public,anon,authenticated;
grant execute on function public.prepare_picklestreet_court_reschedule(uuid,date,time without time zone,text,text,text,boolean,uuid,uuid,text,timestamp with time zone,uuid) to authenticated;
revoke all on function public.preview_picklestreet_court_reschedule(uuid,date) from public,anon,authenticated;
grant execute on function public.preview_picklestreet_court_reschedule(uuid,date) to authenticated;
notify pgrst,'reload schema';
commit;
