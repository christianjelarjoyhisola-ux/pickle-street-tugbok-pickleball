-- Root-owned validation only: concatenate after proposal migration without its COMMIT,
-- append ROLLBACK. This subagent has not executed these statements against any database.
create temporary table ps_promo_results(check_name text, passed boolean) on commit drop;
create temporary table ps_promo_courts_before as select * from public.courts;
create temporary table ps_promo_booking_amounts_before as
select id, subtotal_amount, service_fee_amount, total_amount from public.bookings
where tenant_id = 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid;

create function pg_temp.ps_promo_revisions() returns jsonb language sql as $$
  select coalesce(jsonb_object_agg(c.id::text, to_jsonb(c.updated_at)), '{}'::jsonb)
  from public.courts c where c.tenant_id = 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid
$$;

do $$
declare
  tenant_key constant uuid := 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';
  actor uuid;
  bands jsonb := '[{"start":"05:00","end":"24:00","hourlyRate":1,"standardHourlyRate":200,"promoHourlyRate":150,"promoEnabled":true}]';
  off_bands jsonb;
  value jsonb;
  result jsonb;
  stale_revision jsonb;
  denied boolean;
  fixture_id uuid;
  court_key uuid;
  price jsonb;
  invalid_bands jsonb;
begin
  select user_id into actor from public.platform_profiles where is_platform_owner order by user_id limit 1;
  if actor is null then raise exception 'Fixture requires an existing manager/platform owner'; end if;
  if has_function_privilege('anon', 'public.apply_shared_picklestreet_court_schedule(text,text,text,text,jsonb,jsonb)', 'EXECUTE')
     or has_function_privilege('anon', 'public.manage_picklestreet_court(text,text,text,uuid,jsonb,jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.lock_picklestreet_court_revisions(text,text,jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.picklestreet_normalize_court_promo_bands(text,text,jsonb)', 'EXECUTE') then
    raise exception 'Unexpected function privileges';
  end if;
  insert into ps_promo_results values ('Only authenticated manager adapters are exposed', true);

  -- Verified live initial rate is one for every target band. Do not seed example 200/150 during installation.
  if exists (select 1 from public.courts c cross join lateral jsonb_array_elements(c.pricing_config #> '{regular,bands}') as band(value)
      where c.tenant_id = tenant_key and (band.value->>'hourlyRate')::numeric <> 1) then
    raise exception 'Migration did not preserve the current one-peso test rates';
  end if;
  insert into ps_promo_results values ('Migration leaves current court prices unchanged', true);

  value := public.picklestreet_normalize_court_promo_bands('05:00','00:00',bands);
  if (value #>> '{0,hourlyRate}')::numeric <> 150 or (value #>> '{0,standardHourlyRate}')::numeric <> 200 then
    raise exception 'Effective rate trusted client or lost regular price';
  end if;
  off_bands := jsonb_set(value, '{0,promoEnabled}', 'false'::jsonb);
  off_bands := public.picklestreet_normalize_court_promo_bands('05:00','00:00',off_bands);
  if (off_bands #>> '{0,hourlyRate}')::numeric <> 200 or (off_bands #>> '{0,promoHourlyRate}')::numeric <> 150 then
    raise exception 'Turning promo off did not preserve both prices';
  end if;
  insert into ps_promo_results values ('Server derives enabled and disabled rates despite forged hourlyRate', true);
  value := public.picklestreet_normalize_court_promo_bands('05:00','00:00',
    '[{"start":"05:00","end":"24:00","standardHourlyRate":100,"promoHourlyRate":150,"promoEnabled":false}]');
  if (value #>> '{0,hourlyRate}')::numeric <> 100 or (value #>> '{0,promoHourlyRate}')::numeric <> 150 then
    raise exception 'Disabled promo amount was not remembered independently of standard rate';
  end if;
  insert into ps_promo_results values ('Disabled promo may retain its previous amount above current standard', true);

  value := public.picklestreet_normalize_court_promo_bands('05:00','00:00','[{"start":"05:00","end":"24:00","hourlyRate":1}]');
  if (value #>> '{0,hourlyRate}')::numeric <> 1 or (value #>> '{0,standardHourlyRate}')::numeric <> 1
     or value #> '{0,promoEnabled}' <> 'false'::jsonb or value #> '{0,promoHourlyRate}' <> 'null'::jsonb then
    raise exception 'Legacy test price was not retained';
  end if;
  insert into ps_promo_results values ('Legacy rate one remains one with promo disabled', true);

  foreach invalid_bands in array array[
    jsonb_set(bands, '{0,promoHourlyRate}', 'null'),
    jsonb_set(bands, '{0,promoHourlyRate}', '201'),
    jsonb_set(bands, '{0,promoHourlyRate}', '0'),
    jsonb_set(bands, '{0,promoHourlyRate}', '150.001'),
    jsonb_set(jsonb_set(bands, '{0,promoEnabled}', 'false'), '{0,promoHourlyRate}', '10000000000'),
    jsonb_set(bands, '{0,promoEnabled}', '"true"'),
    jsonb_set(bands, '{0,standardHourlyRate}', '0'),
    jsonb_set(bands, '{0,start}', '"06:00"'),
    bands || bands,
    jsonb_build_array((bands->0) - 'promoHourlyRate')
  ] loop
    denied := false;
    begin perform public.picklestreet_normalize_court_promo_bands('05:00','00:00',invalid_bands);
    exception when sqlstate '22023' then denied := true; end;
    if not denied then raise exception 'Invalid promo or schedule accepted'; end if;
  end loop;
  insert into ps_promo_results values ('Invalid prices, partial metadata, flags, gaps and overlaps rejected', true);

  value := public.picklestreet_normalize_court_promo_bands('20:00','02:00',
    '[{"start":"00:00","end":"02:00","standardHourlyRate":200,"promoHourlyRate":150,"promoEnabled":true},
      {"start":"20:00","end":"24:00","standardHourlyRate":100,"promoHourlyRate":null,"promoEnabled":false}]');
  if value #>> '{0,start}' <> '20:00'
     or public.regular_reschedule_court_subtotal(jsonb_build_object('regular',jsonb_build_object('bands',value)), '23:00', 3) <> 400 then
    raise exception 'Overnight ordering or effective server quote failed';
  end if;
  insert into ps_promo_results values ('Mixed promo tiers and overnight server quotes calculate correctly', true);

  perform set_config('request.jwt.claim.sub','',true);
  perform set_config('request.jwt.claims','{"role":"anon"}',true);
  denied := false;
  begin perform public.apply_shared_picklestreet_court_schedule('pickle-street-tugbok','picklestreet.pages.dev','05:00','00:00',bands,pg_temp.ps_promo_revisions());
  exception when sqlstate '42501' then denied := true; end;
  if not denied then raise exception 'Anonymous manager mutation accepted'; end if;
  perform set_config('request.jwt.claim.sub',actor::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',actor)::text,true);
  -- Management API SQL does not carry the browser's PostgREST request context.
  -- Authenticated resolve_tenant_id intentionally rejects a missing/mismatched Origin.
  perform set_config('request.headers','{}',true);
  denied := false;
  begin perform public.apply_shared_picklestreet_court_schedule('pickle-street-tugbok','picklestreet.pages.dev','05:00','00:00',bands,pg_temp.ps_promo_revisions());
  exception when sqlstate '42501' then denied := true; end;
  if not denied then raise exception 'Authenticated save without Origin accepted'; end if;
  perform set_config('request.headers','{"origin":"https://invalid.example"}',true);
  denied := false;
  begin perform public.apply_shared_picklestreet_court_schedule('pickle-street-tugbok','picklestreet.pages.dev','05:00','00:00',bands,pg_temp.ps_promo_revisions());
  exception when sqlstate '42501' then denied := true; end;
  if not denied then raise exception 'Authenticated save with mismatched Origin accepted'; end if;
  perform set_config('request.headers','{"origin":"https://picklestreet.pages.dev"}',true);
  if public.resolve_tenant_id('pickle-street-tugbok','picklestreet.pages.dev') is distinct from tenant_key then
    raise exception 'Fixture authenticated Origin did not resolve Pickle Street';
  end if;
  insert into ps_promo_results values ('Authenticated writes require the matching browser Origin',true);
  denied := false;
  begin perform public.apply_shared_picklestreet_court_schedule('dinktopia','invalid.example','05:00','00:00',bands,pg_temp.ps_promo_revisions());
  exception when sqlstate '42501' then denied := true; end;
  if not denied then raise exception 'Foreign tenant origin accepted'; end if;
  insert into ps_promo_results values ('Authentication and exact target tenant origin required', true);

  stale_revision := pg_temp.ps_promo_revisions();
  result := public.apply_shared_picklestreet_court_schedule('pickle-street-tugbok','picklestreet.pages.dev','05:00','00:00',bands,stale_revision);
  if not result ? 'revisions' or not result ? 'readiness' then raise exception 'Schedule response contract missing'; end if;
  if exists (select 1 from public.courts c where c.tenant_id = tenant_key
      and ((c.pricing_config #>> '{regular,bands,0,hourlyRate}')::numeric <> 150
        or (c.pricing_config #>> '{regular,bands,0,standardHourlyRate}')::numeric <> 200)) then
    raise exception 'Atomic shared schedule failed';
  end if;
  if exists (select 1 from public.courts c join ps_promo_courts_before b using(id) where c.tenant_id = tenant_key
      and ((c.pricing_config - 'regular') <> (b.pricing_config - 'regular')
        or ((c.pricing_config->'regular') - 'bands') <> ((b.pricing_config->'regular') - 'bands'))) then
    raise exception 'Unrelated pricing policy changed';
  end if;
  insert into ps_promo_results values ('Shared save applies derived prices atomically and preserves unrelated policy', true);

  denied := false;
  begin perform public.apply_shared_picklestreet_court_schedule('pickle-street-tugbok','picklestreet.pages.dev','05:00','00:00',off_bands,stale_revision);
  exception when sqlstate '40001' then denied := true; end;
  if not denied then raise exception 'Stale schedule save accepted'; end if;
  denied := false;
  begin perform public.apply_shared_picklestreet_court_schedule('pickle-street-tugbok','picklestreet.pages.dev','05:00','00:00',off_bands,'{}');
  exception when sqlstate '40001' then denied := true; end;
  if not denied then raise exception 'Missing court revision accepted'; end if;
  insert into ps_promo_results values ('Stale and incomplete revision sets rejected', true);

  result := public.get_public_tenant_bootstrap('pickle-street-tugbok','picklestreet.pages.dev');
  if exists (select 1 from jsonb_array_elements(result->'courts') c
    where (c #>> '{pricingConfig,regular,bands,0,hourlyRate}')::numeric <> 150
       or (c #>> '{pricingConfig,regular,bands,0,standardHourlyRate}')::numeric <> 200
       or c #> '{pricingConfig,regular,bands,0,promoEnabled}' <> 'true'::jsonb) then
    raise exception 'Bootstrap dropped promo projection';
  end if;
  insert into ps_promo_results values ('Public bootstrap projects both prices and effective promo', true);

  select id,pricing_config into court_key,price from public.courts where tenant_id=tenant_key order by id limit 1;
  denied := false;
  begin perform public.manage_tenant_court('pickle-street-tugbok','picklestreet.pages.dev','save',court_key,
    jsonb_build_object('pricingConfig',jsonb_set(price,'{regular,bands}','[{"start":"05:00","end":"24:00","hourlyRate":150}]')));
  exception when sqlstate '22023' then denied := true; end;
  if not denied then raise exception 'Legacy shared manager dropped regular price metadata'; end if;
  price := jsonb_set(price,'{regular,bands,0,hourlyRate}','0.01');
  perform public.manage_tenant_court('pickle-street-tugbok','picklestreet.pages.dev','save',court_key,jsonb_build_object('pricingConfig',price));
  if (select (pricing_config #>> '{regular,bands,0,hourlyRate}')::numeric from public.courts where id=court_key) <> 150 then
    raise exception 'Shared manager bypassed effective price derivation';
  end if;
  insert into ps_promo_results values ('Existing shared manager cannot strip or forge promo pricing', true);

  result := public.manage_picklestreet_court('pickle-street-tugbok','picklestreet.pages.dev','save',null,
    jsonb_build_object('slug','promo-rollback-'||replace(gen_random_uuid()::text,'-',''), 'name','TEST promo rollback court',
      'status','inactive','sortOrder',9999,'opensAt','05:00','closesAt','00:00','currency','PHP',
      'pricingConfig',price,'publicConfig','{}'::jsonb),pg_temp.ps_promo_revisions());
  fixture_id := (result->>'id')::uuid;
  if (result #>> '{pricing_config,regular,bands,0,hourlyRate}')::numeric <> 150
     or not result ? 'updated_at' or not result ? 'revisions' then
    raise exception 'Individual manager save or revision DTO failed';
  end if;
  perform public.manage_picklestreet_court('pickle-street-tugbok','picklestreet.pages.dev','delete',fixture_id,'{}',pg_temp.ps_promo_revisions());
  insert into ps_promo_results values ('Individual court save and delete preserve existing contract', true);

  perform public.apply_shared_picklestreet_court_schedule('pickle-street-tugbok','picklestreet.pages.dev','05:00','00:00',off_bands,pg_temp.ps_promo_revisions());
  if exists (select 1 from public.courts c where c.tenant_id=tenant_key and
    public.regular_reschedule_court_subtotal(c.pricing_config,'05:00',2) <> 400) then
    raise exception 'Turning promo off did not restore server quote';
  end if;
  insert into ps_promo_results values ('Turning promo off restores regular server quote', true);
  if exists (select 1 from public.bookings b join ps_promo_booking_amounts_before old_amount using(id)
      where b.subtotal_amount <> old_amount.subtotal_amount or b.service_fee_amount <> old_amount.service_fee_amount
      or b.total_amount <> old_amount.total_amount) then raise exception 'Existing booking amounts changed'; end if;
  if exists (select 1 from public.courts c join ps_promo_courts_before b using(id)
    where c.tenant_id <> tenant_key and to_jsonb(c) <> to_jsonb(b)) then raise exception 'Other tenant courts changed'; end if;
  insert into ps_promo_results values ('Existing booking amounts and other tenant court rows untouched', true);
end;
$$;
select check_name,passed from ps_promo_results order by check_name;
