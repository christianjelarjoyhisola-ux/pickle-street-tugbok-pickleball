-- Additive staff workflow. Checkout and original booking records are untouched.
begin;
create table public.picklestreet_weather_batches (
 id uuid primary key, actor uuid not null references auth.users(id),
 request jsonb not null, result jsonb not null, created_at timestamptz not null default now()
);
alter table public.picklestreet_weather_batches enable row level security;
revoke all on public.picklestreet_weather_batches from public,anon,authenticated;

create function public.preview_picklestreet_weather_interruption(p_actor uuid,p_windows jsonb)
returns jsonb language plpgsql security definer set search_path='' set row_security=off as $$
declare t constant uuid:='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';rows jsonb;
begin
 if auth.role() is distinct from 'service_role' or p_actor is null or not (
 exists(select 1 from public.platform_profiles where user_id=p_actor and is_platform_owner) or
 exists(select 1 from public.tenant_memberships where tenant_id=t and user_id=p_actor and status='active' and role in('owner','admin'))
 ) then raise exception 'Owner or admin access is required.' using errcode='42501';end if;
 if jsonb_typeof(p_windows) is distinct from 'array' then raise exception 'Select affected court times.';end if;
 if jsonb_array_length(p_windows) not between 1 and 48 then raise exception 'Select between 1 and 48 court time ranges.';end if;
 if exists(select 1 from jsonb_to_recordset(p_windows) as w("courtId" uuid,"start" timestamptz,"end" timestamptz)
 where w."start" is null or w."end" is null or not isfinite(w."start") or not isfinite(w."end") or w."end"<=w."start" or w."end">w."start"+interval '24 hours'
 or date_trunc('minute',w."start")<>w."start" or date_trunc('minute',w."end")<>w."end"
 or not exists(select 1 from public.courts where id=w."courtId" and tenant_id=t)) then raise exception 'Check the court and time ranges (up to 24 hours each).';end if;
 if (select max(w."end")-min(w."start") from jsonb_to_recordset(p_windows) as w("start" timestamptz,"end" timestamptz))>interval '48 hours'
 then raise exception 'Select times within one two-day interruption.';end if;
 if exists(select 1 from jsonb_array_elements(p_windows) with ordinality a(v,n),jsonb_array_elements(p_windows) with ordinality b(v,n)
 where a.n<b.n and a.v->>'courtId'=b.v->>'courtId' and tstzrange((a.v->>'start')::timestamptz,(a.v->>'end')::timestamptz,'[)') && tstzrange((b.v->>'start')::timestamptz,(b.v->>'end')::timestamptz,'[)'))
 then raise exception 'Time ranges on the same court overlap. Combine them before previewing.';end if;
 with affected as (
 select s.booking_id, floor(sum(extract(epoch from(least(s.ends_at,w."end")-greatest(s.starts_at,w."start"))))/60)::integer minutes,
 jsonb_agg(jsonb_build_object('court',c.name,'start',greatest(s.starts_at,w."start"),'end',least(s.ends_at,w."end")) order by s.starts_at,s.court_id) sessions
 from public.booking_slots s join public.courts c on c.id=s.court_id
 join jsonb_to_recordset(p_windows) as w("courtId" uuid,"start" timestamptz,"end" timestamptz)
 on w."courtId"=s.court_id and s.starts_at<w."end" and s.ends_at>w."start"
 where s.tenant_id=t and s.balance_request_id is null and s.status in('held','confirmed') group by s.booking_id
 ), candidates as (
 select b.reference,b.customer_name,b.customer_email,a.minutes,a.sessions,
 case when exists(select 1 from public.picklestreet_weather_credits where booking_id=b.id) then 'Credit already issued'
 when b.payment_status<>'paid' then 'Payment not confirmed'
 when b.status not in('confirmed','completed') or b.archived_at is not null then 'Booking not eligible'
 when b.booking_type<>'regular' or coalesce((b.metadata->>'equipmentRentalFeeAmount')::numeric,0)>0 then 'Requires staff handling'
 when coalesce(b.customer_email,'') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then 'Guest email missing'
 when exists(select 1 from public.weather_refund_incidents where booking_id=b.id and status<>'rejected') then 'Existing rain claim or refund'
 when exists(select 1 from public.booking_balance_requests where booking_id=b.id and status in('awaiting_payment','payment_review')) then 'Pending booking adjustment'
 when b.metadata->'lastReschedule'->>'reasonCode' in('weather','rain') or exists(select 1 from public.booking_reschedule_events where booking_id=b.id and reason_code in('weather','rain')) then 'Already replaced for weather'
 else null end exclusion
 from affected a join public.bookings b on b.id=a.booking_id where a.minutes>0
 ) select coalesce(jsonb_agg(jsonb_build_object('reference',reference,'name',customer_name,'email',customer_email,'minutes',minutes,'sessions',sessions,'eligible',exclusion is null,'exclusion',exclusion) order by reference),'[]'::jsonb) into rows from candidates;
 if jsonb_array_length(rows)>200 then raise exception 'Too many bookings. Select fewer affected courts or times.';end if;
 return jsonb_build_object('ok',true,'bookings',rows,'snapshot',md5(rows::text));
end;$$;
revoke all on function public.preview_picklestreet_weather_interruption(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.preview_picklestreet_weather_interruption(uuid,jsonb) to service_role;

create function public.issue_picklestreet_weather_interruption(p_actor uuid,p_id uuid,p_windows jsonb,p_references text[],p_snapshot text,p_reason text)
returns jsonb language plpgsql security definer set search_path='' set row_security=off as $$
declare preview jsonb;request jsonb;prior public.picklestreet_weather_batches%rowtype;r jsonb;issued jsonb:='[]';credit jsonb;
begin
 -- Reuse the tenant-scoped authorization and range validation on every call, including retries.
 preview:=public.preview_picklestreet_weather_interruption(p_actor,p_windows);
 if p_id is null or cardinality(p_references) is null or cardinality(p_references) not between 1 and 50
 or p_reason is null or p_reason not in('rain','wet_court','unsafe_weather') then raise exception 'Select 1 to 50 eligible bookings and a weather condition.';end if;
 if exists(select 1 from unnest(p_references) v where v is null) or (select count(distinct v) from unnest(p_references) v)<>cardinality(p_references) then raise exception 'Select each booking only once.';end if;
 request:=jsonb_build_object('windows',p_windows,'references',p_references,'snapshot',p_snapshot,'reason',p_reason);
 perform pg_advisory_xact_lock(hashtextextended(p_id::text,0));
 select * into prior from public.picklestreet_weather_batches where id=p_id;
 if found then
 if prior.actor<>p_actor or prior.request<>request then raise exception 'This request was already used. Preview again.';end if;
 return prior.result;
 end if;
 -- Serialize against individual issuance, payment review, refunds, and schedule changes.
 perform 1 from public.bookings where tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a' and reference=any(p_references) order by id for update;
 preview:=public.preview_picklestreet_weather_interruption(p_actor,p_windows);
 if p_snapshot is distinct from preview->>'snapshot' then raise exception 'Bookings changed since your preview. Refresh the preview before issuing credits.';end if;
 if (select count(*) from jsonb_array_elements(preview->'bookings') x where x->>'reference'=any(p_references) and (x->>'eligible')::boolean)<>cardinality(p_references)
 then raise exception 'One or more selected bookings are no longer eligible. Preview again.';end if;
 for r in select x from jsonb_array_elements(preview->'bookings') x where x->>'reference'=any(p_references) order by x->>'reference' loop
 credit:=public.manage_picklestreet_weather_credit(r->>'reference',p_actor,(r->>'minutes')::integer,p_reason);
 issued:=issued||jsonb_build_array(jsonb_build_object('reference',r->>'reference','name',r->>'name','email',r->>'email','minutes',(r->>'minutes')::integer,'credit',credit->'credit'));
 end loop;
 credit:=jsonb_build_object('ok',true,'batchId',p_id,'bookings',issued);
 insert into public.picklestreet_weather_batches(id,actor,request,result) values(p_id,p_actor,request,credit);
 return credit;
end;$$;
revoke all on function public.issue_picklestreet_weather_interruption(uuid,uuid,jsonb,text[],text,text) from public,anon,authenticated;
grant execute on function public.issue_picklestreet_weather_interruption(uuid,uuid,jsonb,text[],text,text) to service_role;
commit;
