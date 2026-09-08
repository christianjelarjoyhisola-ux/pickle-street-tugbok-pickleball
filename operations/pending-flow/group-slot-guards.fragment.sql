create function public.assert_picklestreet_group_slots(p_booking_id uuid)
returns void language plpgsql security definer set search_path='' set row_security=off as $$
declare b public.bookings%rowtype;zone text;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'BOOKING_ACCESS_DENIED' using errcode='42501';end if;
 select * into strict b from public.bookings where tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a' and id=p_booking_id;
 select timezone into strict zone from public.tenants where id=b.tenant_id;
 if b.metadata->'atomicMultiSessionBookingV1' is distinct from 'true'::jsonb then raise exception 'reservation_slots_changed' using errcode='22023';end if;
 if exists(
  with expected as (select (s->>'courtId')::uuid court_id,g starts_at,g+interval '1 hour' ends_at from jsonb_array_elements(b.metadata->'sessions') s,
   lateral generate_series((s->>'startsAt')::timestamptz,(s->>'endsAt')::timestamptz-interval '1 hour',interval '1 hour') g),
  actual as (select court_id,starts_at,ends_at from public.booking_slots where tenant_id=b.tenant_id and booking_id=b.id and balance_request_id is null)
  select * from ((select * from expected except all select * from actual) union all (select * from actual except all select * from expected)) difference
 ) or exists(select 1 from public.booking_slots where tenant_id=b.tenant_id and booking_id=b.id and (status not in('held','expired') or balance_request_id is not null)) then
  raise exception 'reservation_slots_changed' using errcode='22023';end if;
 perform 1 from public.courts c where c.tenant_id=b.tenant_id and exists(select 1 from public.booking_slots s where s.booking_id=b.id and s.tenant_id=b.tenant_id and s.court_id=c.id) for share;
 if exists(select 1 from public.booking_slots s left join public.courts c on c.id=s.court_id and c.tenant_id=s.tenant_id
  where s.tenant_id=b.tenant_id and s.booking_id=b.id and (c.id is null or c.status<>'active')) then
  raise exception 'reservation_court_unavailable' using errcode='22023';end if;
 if exists(select 1 from public.booking_slots s join public.blocked_dates d on d.tenant_id=s.tenant_id and(d.court_id is null or d.court_id=s.court_id)
  where s.tenant_id=b.tenant_id and s.booking_id=b.id and tsrange(s.starts_at at time zone zone,s.ends_at at time zone zone,'[)') &&
  case when d.starts_at is null then tsrange(d.blocked_on::timestamp,(d.blocked_on+1)::timestamp,'[)') else
   tsrange(d.blocked_on+d.starts_at,case when d.ends_at=time '23:59:59' then(d.blocked_on+1)::timestamp else d.blocked_on+d.ends_at end,'[)') end) then
  raise exception 'reservation_court_blocked' using errcode='22023';end if;
 if exists(select 1 from public.booking_slots s join public.court_occupancies o on o.tenant_id=s.tenant_id and o.court_id=s.court_id and o.starts_at<s.ends_at and o.ends_at>s.starts_at
  where s.tenant_id=b.tenant_id and s.booking_id=b.id and(o.status='confirmed' or(o.status='held' and o.hold_expires_at>clock_timestamp()))
  and not(o.source_kind='booking_slot' and exists(select 1 from public.booking_slots own where own.tenant_id=b.tenant_id and own.booking_id=b.id and own.id=o.source_id))) then
  raise exception 'reservation_time_unavailable' using errcode='22023';end if;
end;$$;
revoke all on function public.assert_picklestreet_group_slots(uuid) from public,anon,authenticated;

create function public.guard_picklestreet_group_schedule()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if old.tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a' and old.metadata->'atomicMultiSessionBookingV1'='true'::jsonb
  and(new.court_id is distinct from old.court_id or new.starts_at is distinct from old.starts_at or new.ends_at is distinct from old.ends_at
   or new.metadata->'sessions' is distinct from old.metadata->'sessions') then
  raise exception 'Multi-session bookings require a grouped reschedule; a single-court change is not allowed.' using errcode='22023';end if;
 return new;
end;$$;
revoke all on function public.guard_picklestreet_group_schedule() from public,anon,authenticated;
create trigger zzzz_picklestreet_group_schedule before update on public.bookings for each row execute function public.guard_picklestreet_group_schedule();
