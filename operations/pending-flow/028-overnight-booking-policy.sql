-- Require at least two hours' notice for Pickle Street bookings that start
-- from midnight through 4:59 AM. The edge function treats this value as a
-- stricter override of the court's normal lead time.
begin;
set local lock_timeout = '8s';
set local statement_timeout = '30s';

do $policy$
declare
  tenant_uuid uuid;
  court_count integer;
  updated_count integer;
begin
  select tenant.id
  into tenant_uuid
  from public.tenants tenant
  where tenant.slug = 'pickle-street-tugbok'
    and tenant.status = 'active'
  for update;

  if tenant_uuid is null then
    raise exception 'Pickle Street Tugbok tenant was not found.';
  end if;

  select count(*)
  into court_count
  from public.courts court
  where court.tenant_id = tenant_uuid;

  if court_count = 0 then
    raise exception 'No Pickle Street Tugbok courts were found.';
  end if;

  if exists (
    select 1
    from public.courts court
    where court.tenant_id = tenant_uuid
      and court.public_config ? 'overnightMinimumLeadMinutes'
      and court.public_config ->> 'overnightMinimumLeadMinutes' <> '120'
  ) then
    raise exception 'An overnight lead-time policy already exists with a different value.';
  end if;

  update public.courts court
  set public_config = pg_catalog.jsonb_set(
    coalesce(court.public_config, '{}'::jsonb),
    '{overnightMinimumLeadMinutes}',
    '120'::jsonb,
    true
  )
  where court.tenant_id = tenant_uuid;
  get diagnostics updated_count = row_count;

  if updated_count <> court_count then
    raise exception 'Expected to update % courts but updated %.', court_count, updated_count;
  end if;
end;
$policy$;

commit;
