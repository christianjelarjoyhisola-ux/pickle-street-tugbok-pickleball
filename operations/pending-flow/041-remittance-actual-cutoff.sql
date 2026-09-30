begin;
alter table public.remittances drop constraint remittances_preparation_source_valid;
alter table public.remittances add constraint remittances_preparation_source_valid check (preparation_source in ('court_owner','system_owner_external_receipt','system_owner_cutoff'));
alter table public.remittances drop constraint remittances_system_owner_exception_reason_valid;
alter table public.remittances add constraint remittances_system_owner_exception_reason_valid check ((preparation_source in ('court_owner','system_owner_cutoff') and system_owner_exception_reason is null) or (preparation_source='system_owner_external_receipt' and char_length(btrim(system_owner_exception_reason)) between 10 and 1000));
CREATE OR REPLACE FUNCTION public.cutoff_picklestreet_remittance(p_tenant_slug text, p_hostname text, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET row_security TO 'off'
AS $function$
declare
  v_tenant_id uuid;
  v_existing_id uuid;
  v_id uuid := extensions.gen_random_uuid();
  v_cutoff timestamptz;
  v_local_date date;
  v_due_on date;
  v_period_start date;
  v_total numeric;
  v_count integer;
  v_reference text;
begin
  v_tenant_id := public.resolve_tenant_id(p_tenant_slug, p_hostname);
  if v_tenant_id is distinct from 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid or auth.uid() is null or not public.is_platform_owner() then
    raise exception 'Only the System Owner may cut off this remittance.' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_idempotency_key, '')))
     not between 8 and 128 then
    raise exception 'A valid idempotency key is required.'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('booking-fee-remittance:' || v_tenant_id::text, 0));

  select remittance.id
  into v_existing_id
  from public.remittances remittance
  where remittance.tenant_id = v_tenant_id
    and remittance.prepared_by = auth.uid()
    and remittance.prepare_idempotency_key = btrim(p_idempotency_key)
  limit 1;
  if v_existing_id is not null then
    return public.get_booking_fee_remittance_detail(
      p_tenant_slug, p_hostname, v_existing_id
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'booking-fee-remittance:' || v_tenant_id::text, 0
    )
  );

  v_cutoff := clock_timestamp();
  v_local_date := timezone('Asia/Manila', v_cutoff)::date;
  v_due_on := v_local_date;

  select
    timezone('Asia/Manila', min(row.fee_earned_at))::date,
    coalesce(round(sum(row.fee_amount), 2), 0)
  into v_period_start, v_total
  from public.booking_fee_unclaimed_rows(v_tenant_id) row
  where row.fee_earned_at <= v_cutoff;

  if v_period_start is null or v_total <= 0 then
    raise exception 'There are no accumulated booking fees ready to remit.'
      using errcode = '22023';
  end if;

  v_reference := 'REM-' || to_char(v_due_on, 'YYYYMMDD') || '-'
    || upper(substr(replace(v_id::text, '-', ''), 1, 8));

  insert into public.remittances (
    id,
    tenant_id,
    reference,
    period_start,
    period_end,
    status,
    booking_fee_amount,
    paid_amount,
    currency,
    due_at,
    cutoff_at,
    cycle_due_on,
    prepared_at,
    prepared_by,
    prepare_idempotency_key,
    created_by, preparation_source, notes
  ) values (
    v_id,
    v_tenant_id,
    v_reference,
    v_period_start,
    v_local_date,
    'due',
    0,
    0,
    'PHP',
    v_due_on::timestamp at time zone 'Asia/Manila',
    v_cutoff,
    null,
    v_cutoff,
    auth.uid(),
    btrim(p_idempotency_key),
    auth.uid(), 'system_owner_cutoff', 'Booking fees frozen at cutoff; awaiting court-owner payment.'
  );

  insert into public.remittance_items (
    tenant_id,
    remittance_id,
    booking_id,
    open_play_registration_id,
    fee_amount,
    booking_reference,
    booking_created_at,
    fee_earned_at,
    court_name,
    fee_rate,
    fee_type,
    fee_units
  )
  select
    v_tenant_id,
    v_id,
    case when open_play.id is null then row.booking_id else null end,
    open_play.id,
    row.fee_amount,
    row.booking_reference,
    row.booking_created_at,
    row.fee_earned_at,
    row.court_name,
    row.fee_rate,
    row.fee_type,
    row.fee_units
  from public.booking_fee_unclaimed_rows(v_tenant_id) row
  left join public.open_play_registrations open_play
    on open_play.tenant_id = v_tenant_id
   and open_play.id = row.booking_id
   and open_play.reference = row.booking_reference
  where row.fee_earned_at <= v_cutoff
  order by row.fee_earned_at, row.booking_created_at, row.booking_reference
  on conflict do nothing;

  select
    count(*)::integer,
    coalesce(round(sum(item.fee_amount), 2), 0)
  into v_count, v_total
  from public.remittance_items item
  where item.tenant_id = v_tenant_id
    and item.remittance_id = v_id
    and item.released_at is null;

  if v_count = 0 or v_total <= 0 then
    raise exception
      'The eligible fees were already prepared by another request.'
      using errcode = '40001';
  end if;

  update public.remittances
  set booking_fee_amount = v_total
  where tenant_id = v_tenant_id
    and id = v_id;

  return public.get_booking_fee_remittance_detail(
    p_tenant_slug, p_hostname, v_id
  );
end;
$function$
;
revoke all on function public.cutoff_picklestreet_remittance(text,text,text) from public, anon;
grant execute on function public.cutoff_picklestreet_remittance(text,text,text) to authenticated;
commit;
