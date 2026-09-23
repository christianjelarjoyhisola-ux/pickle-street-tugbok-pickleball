-- Pickle Street rain checks preserve unused court time and its booking fee.
-- Based on PickPoint's voucher/ledger lifecycle, isolated to this tenant.
begin;
create table public.picklestreet_weather_credits (
 id uuid primary key default extensions.gen_random_uuid(),
 tenant_id uuid not null default 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a' check(tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'),
 booking_id uuid not null unique references public.bookings(id),
 code text not null unique default ('PS-RAIN-'||upper(encode(extensions.gen_random_bytes(12),'hex'))),
 email text not null, court_ids uuid[] not null,
 minutes integer not null check(minutes>0), balance_minutes integer not null check(balance_minutes>=0 and balance_minutes<=minutes),
 reason text not null check(reason in ('rain','wet_court','unsafe_weather')),
 issued_by uuid not null references auth.users(id),created_at timestamptz not null default now(),
 email_sent_at timestamptz,email_attempt_at timestamptz
);
create table public.picklestreet_weather_credit_uses (
 booking_id uuid primary key references public.bookings(id),
 credit_id uuid not null references public.picklestreet_weather_credits(id),
 minutes integer not null check(minutes>0),court_amount numeric(12,2) not null check(court_amount>=0),
 fee_amount numeric(12,2) not null check(fee_amount>=0),created_at timestamptz not null default now(),released_at timestamptz
);
alter table public.picklestreet_weather_credits enable row level security;
alter table public.picklestreet_weather_credit_uses enable row level security;
revoke all on public.picklestreet_weather_credits,public.picklestreet_weather_credit_uses from public,anon,authenticated;
grant select,update on public.picklestreet_weather_credits to service_role;
grant select on public.picklestreet_weather_credit_uses to service_role;

create function public.manage_picklestreet_weather_credit(p_reference text,p_actor uuid,p_minutes integer default null,p_reason text default 'rain')
returns jsonb language plpgsql security definer set search_path='' set row_security=off as $$
declare
 t constant uuid:='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';b public.bookings%rowtype;c public.picklestreet_weather_credits%rowtype;
 total_minutes integer;courts uuid[];eligible boolean;
begin
 if auth.role() is distinct from 'service_role' or p_actor is null or not (
   exists(select 1 from public.platform_profiles where user_id=p_actor and is_platform_owner) or
   exists(select 1 from public.tenant_memberships where tenant_id=t and user_id=p_actor and status='active' and role in('owner','admin'))
 ) then raise exception 'Owner or admin access is required.' using errcode='42501';end if;
 select * into b from public.bookings where tenant_id=t and reference=upper(btrim(p_reference)) for update;
 if not found then raise exception 'Booking not found.';end if;
 select * into c from public.picklestreet_weather_credits where booking_id=b.id;
 select floor(sum(extract(epoch from(ends_at-starts_at)))/60)::integer,array_agg(distinct court_id)
   into total_minutes,courts from public.booking_slots where tenant_id=t and booking_id=b.id and status='confirmed' and balance_request_id is null;
 eligible:=b.payment_status='paid' and b.status in('confirmed','completed') and b.archived_at is null and b.booking_type='regular' and coalesce(total_minutes,0)>0
   and coalesce(b.customer_email,'') ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$';
 if p_minutes is not null and c.id is null then
   if not eligible then raise exception 'A paid booking with confirmed court time and a guest email is required.';end if;
   if p_minutes<=0 or p_minutes>total_minutes then raise exception 'Unused minutes must be between 1 and %.',total_minutes;end if;
   if exists(select 1 from public.weather_refund_incidents where booking_id=b.id and status<>'rejected')
     or exists(select 1 from public.booking_balance_requests where booking_id=b.id and status in('awaiting_payment','payment_review'))
     or b.metadata->'lastReschedule'->>'reasonCode' in('weather','rain')
     or exists(select 1 from public.booking_reschedule_events where booking_id=b.id and reason_code in('weather','rain'))
     or exists(select 1 from public.picklestreet_group_reschedule_events where booking_id=b.id and event_id in
       (select id from public.booking_reschedule_events where booking_id=b.id and reason_code in('weather','rain')))
   then raise exception 'Resolve the existing rain compensation or pending reschedule before issuing credit.';end if;
   insert into public.picklestreet_weather_credits(booking_id,email,court_ids,minutes,balance_minutes,reason,issued_by)
     values(b.id,lower(btrim(b.customer_email)),courts,p_minutes,p_minutes,p_reason,p_actor) returning * into c;
 elsif p_minutes is not null and c.id is not null and (p_minutes<>c.minutes or p_reason<>c.reason) then
   raise exception 'Credit was already issued. Its original amount and reason cannot be changed.';
 end if;
 return jsonb_build_object('ok',true,'eligible',eligible,'maximumMinutes',total_minutes,'email',b.customer_email,
   'credit',case when c.id is null then null else jsonb_build_object('id',c.id,'code',c.code,'minutes',c.minutes,'balanceMinutes',c.balance_minutes,'reason',c.reason,'emailSent',c.email_sent_at is not null) end,
   'usedCredit',(select jsonb_build_object('minutes',u.minutes,'courtAmount',u.court_amount,'feeAmount',u.fee_amount,'released',u.released_at is not null) from public.picklestreet_weather_credit_uses u where u.booking_id=b.id));
end;$$;
revoke all on function public.manage_picklestreet_weather_credit(text,uuid,integer,text) from public,anon,authenticated;
grant execute on function public.manage_picklestreet_weather_credit(text,uuid,integer,text) to service_role;

create function public.apply_picklestreet_weather_credit(p_reference text,p_token text,p_code text)
returns jsonb language plpgsql security definer set search_path='' set row_security=off as $$
declare
 t constant uuid:='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';b public.bookings%rowtype;c public.picklestreet_weather_credits%rowtype;u public.picklestreet_weather_credit_uses%rowtype;
 total_minutes integer;used_minutes integer;court_credit numeric;fee_credit numeric;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'Private booking access required.' using errcode='42501';end if;
 select * into b from public.bookings where tenant_id=t and reference=upper(btrim(p_reference)) for update;
 if not found or not exists(select 1 from public.booking_access_tokens where tenant_id=t and booking_id=b.id and expires_at>now()
   and token_hash=encode(extensions.digest(p_token,'sha256'),'hex')) then raise exception 'Private booking access is invalid or expired.' using errcode='42501';end if;
 select * into c from public.picklestreet_weather_credits where tenant_id=t and code=upper(btrim(p_code)) and email=lower(btrim(b.customer_email)) for update;
 if not found then raise exception 'Check the code and use the email that received your weather credit.';end if;
 select * into u from public.picklestreet_weather_credit_uses where booking_id=b.id;
 if found then
   if u.credit_id<>c.id or u.released_at is not null then raise exception 'This booking cannot use that credit. Start a new booking if the hold expired.';end if;
 else
   if b.status<>'pending_payment' or b.payment_status<>'unpaid' or b.archived_at is not null or b.starts_at<=clock_timestamp()
     or b.expires_at is null or b.expires_at<=clock_timestamp()
     or exists(select 1 from public.picklestreet_provisional_holds where booking_id=b.id and completed_at is null)
     or exists(select 1 from public.receipt_verifications where booking_id=b.id)
     or exists(select 1 from public.payment_sessions where booking_id=b.id)
   then raise exception 'Apply credit after saving your details and before submitting payment, while the hold is active.';end if;
   if b.booking_type<>'regular' or coalesce((b.metadata->>'equipmentRentalFeeAmount')::numeric,0)>0 then raise exception 'Weather credit covers regular court time. Contact staff for bookings with equipment or events.';end if;
   perform slot.id from public.booking_slots slot where tenant_id=t and booking_id=b.id order by id for update;
   select floor(sum(extract(epoch from(ends_at-starts_at)))/60)::integer into total_minutes from public.booking_slots where tenant_id=t and booking_id=b.id and balance_request_id is null;
   if coalesce(total_minutes,0)<=0 or exists(select 1 from public.booking_slots where tenant_id=t and booking_id=b.id and
     (balance_request_id is not null or status<>'held' or hold_expires_at is null or hold_expires_at<=clock_timestamp() or not(court_id=any(c.court_ids))))
   then raise exception 'Choose available time on the original court(s). Credit cannot upgrade or restore an expired reservation.';end if;
   lock table public.blocked_dates in share mode;
   perform 1 from public.courts court where court.tenant_id=t and court.id in(select court_id from public.booking_slots where booking_id=b.id) for share;
   if exists(select 1 from public.booking_slots slot join public.courts court on court.id=slot.court_id and court.tenant_id=slot.tenant_id
     where slot.booking_id=b.id and court.status<>'active') then raise exception 'The original court is currently unavailable.';end if;
   if b.metadata->'atomicMultiSessionBookingV1'='true'::jsonb then perform public.assert_picklestreet_group_slots(b.id);
   else
     if total_minutes<>floor(extract(epoch from(b.ends_at-b.starts_at))/60) or exists(select 1 from public.booking_slots where booking_id=b.id and
       (court_id<>b.court_id or starts_at<b.starts_at or ends_at>b.ends_at)) then raise exception 'The held court schedule has changed.';end if;
     if exists(select 1 from public.booking_slots slot join public.blocked_dates blocked on blocked.tenant_id=slot.tenant_id and(blocked.court_id is null or blocked.court_id=slot.court_id)
       where slot.booking_id=b.id and tsrange(slot.starts_at at time zone 'Asia/Manila',slot.ends_at at time zone 'Asia/Manila','[)') &&
       case when blocked.starts_at is null then tsrange(blocked.blocked_on::timestamp,(blocked.blocked_on+1)::timestamp,'[)') else
       tsrange(blocked.blocked_on+blocked.starts_at,case when blocked.ends_at=time '23:59:59' then(blocked.blocked_on+1)::timestamp else blocked.blocked_on+blocked.ends_at end,'[)') end)
     then raise exception 'The held court is now blocked. Choose another available time.';end if;
   end if;
   if b.expires_at<=clock_timestamp() or b.starts_at<=clock_timestamp() then raise exception 'The booking hold has ended. Choose another available time.';end if;
   used_minutes:=least(total_minutes,c.balance_minutes);
   if used_minutes<=0 then raise exception 'This weather credit has no remaining time.';end if;
   court_credit:=round(b.subtotal_amount*used_minutes/total_minutes,2);
   fee_credit:=round(b.service_fee_amount*used_minutes/total_minutes,2);
   insert into public.picklestreet_weather_credit_uses(booking_id,credit_id,minutes,court_amount,fee_amount)
     values(b.id,c.id,used_minutes,court_credit,fee_credit) returning * into u;
   update public.picklestreet_weather_credits set balance_minutes=balance_minutes-used_minutes where id=c.id returning * into c;
   update public.bookings set subtotal_amount=subtotal_amount-court_credit,service_fee_amount=service_fee_amount-fee_credit,total_amount=total_amount-court_credit-fee_credit,
     metadata=(case when metadata ? 'courtSubtotalAmount' then jsonb_set(metadata,'{courtSubtotalAmount}',to_jsonb(subtotal_amount-court_credit)) else metadata end)||jsonb_build_object('weatherCreditMinutes',used_minutes,'weatherCreditAmount',court_credit,'weatherCreditFeeAmount',fee_credit,
       'weatherCreditOriginalTotal',total_amount,'weatherCreditOriginalSubtotal',subtotal_amount,'weatherCreditOriginalFee',service_fee_amount),
     status=case when total_amount=court_credit+fee_credit then 'confirmed' else status end,
     payment_status=case when total_amount=court_credit+fee_credit then 'paid' else payment_status end,
     confirmed_at=case when total_amount=court_credit+fee_credit then now() else confirmed_at end,
     expires_at=case when total_amount=court_credit+fee_credit then null else expires_at end
     where id=b.id returning * into b;
   if b.status='confirmed' then update public.booking_slots set status='confirmed',hold_expires_at=null where tenant_id=t and booking_id=b.id and status='held';end if;
 end if;
 return jsonb_build_object('ok',true,'reference',b.reference,'status',b.status,'paymentStatus',b.payment_status,'totalAmount',b.total_amount,
   'subtotalAmount',b.subtotal_amount,'serviceFeeAmount',b.service_fee_amount,'minutesUsed',u.minutes,'courtCredit',u.court_amount,'feeCredit',u.fee_amount,
   'remainingMinutes',c.balance_minutes,'expiresAt',b.expires_at);
end;$$;
revoke all on function public.apply_picklestreet_weather_credit(text,text,text) from public,anon,authenticated;
grant execute on function public.apply_picklestreet_weather_credit(text,text,text) to service_role;

create function public.release_picklestreet_weather_credit() returns trigger
language plpgsql security definer set search_path='' as $$
declare u public.picklestreet_weather_credit_uses%rowtype;
begin
 if new.tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a' and new.status in('cancelled','expired') and new.payment_status<>'paid' then
   update public.picklestreet_weather_credit_uses set released_at=now() where booking_id=new.id and released_at is null returning * into u;
   if found then update public.picklestreet_weather_credits set balance_minutes=balance_minutes+u.minutes where id=u.credit_id;end if;
 end if;
 return new;
end;$$;
revoke all on function public.release_picklestreet_weather_credit() from public,anon,authenticated;
create trigger bookings_release_picklestreet_weather_credit after update of status on public.bookings for each row execute function public.release_picklestreet_weather_credit();

create function public.protect_picklestreet_weather_credit() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.tenant_id<>'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a' then return new;end if;
 if exists(select 1 from public.picklestreet_weather_credit_uses where booking_id=old.id) then
   if new.customer_email is distinct from old.customer_email then raise exception 'Keep the email that received this weather credit.';end if;
   if exists(select 1 from public.picklestreet_weather_credit_uses where booking_id=old.id and released_at is not null)
     and new.status not in('cancelled','expired') then raise exception 'Credit was returned. Create a new booking.';end if;
   if old.metadata ? 'weatherCreditMinutes' and (new.starts_at is distinct from old.starts_at or new.ends_at is distinct from old.ends_at or new.court_id is distinct from old.court_id
     or new.metadata->'sessions' is distinct from old.metadata->'sessions' or new.total_amount is distinct from old.total_amount) then
     raise exception 'This booking uses weather credit. Contact staff for a replacement credit instead of changing its schedule.';end if;
 end if;
 if exists(select 1 from public.picklestreet_weather_credits where booking_id=old.id) and
   (new.payment_status='refunded' or new.court_id is distinct from old.court_id or new.starts_at is distinct from old.starts_at or new.ends_at is distinct from old.ends_at
     or new.metadata->'sessions' is distinct from old.metadata->'sessions') then
   raise exception 'Weather credit was already issued; the original booking cannot also be refunded or rescheduled.';end if;
 return new;
end;$$;
revoke all on function public.protect_picklestreet_weather_credit() from public,anon,authenticated;
create trigger bookings_protect_picklestreet_weather_credit before update on public.bookings for each row execute function public.protect_picklestreet_weather_credit();
create function public.prevent_picklestreet_credit_refund() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.tenant_id<>'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a' then return new;end if;
 perform 1 from public.bookings where id=new.booking_id for update;
 if new.status<>'rejected' and exists(select 1 from public.picklestreet_weather_credits where booking_id=new.booking_id) then raise exception 'Weather credit was already issued for this booking.';end if;
 return new;
end;$$;
revoke all on function public.prevent_picklestreet_credit_refund() from public,anon,authenticated;
create trigger weather_refunds_protect_picklestreet_credit before insert or update on public.weather_refund_incidents for each row execute function public.prevent_picklestreet_credit_refund();
commit;
