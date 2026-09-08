begin;
CREATE OR REPLACE FUNCTION public.guard_picklestreet_receipt_state()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET row_security TO 'off'
AS $function$
begin

  if new.tenant_id<>'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid then return new;end if;
  if auth.role()='service_role' and new.status='rejected' and current_setting('app.picklestreet_duplicate_reject',true)=new.id::text then return new;end if;
  if public.picklestreet_staff_review_authorized('receipt',new.id) then return new;end if;
  if tg_op='UPDATE' and new.tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid
    and old.status in('approved','rejected') and exists(select 1 from public.picklestreet_receipt_staff_reviews d
      where d.tenant_id=new.tenant_id and d.verification_id=new.id and d.completed_at is not null) then
    if new.status is distinct from old.status then raise exception 'PICKLESTREET_STAFF_DECISION_IMMUTABLE' using errcode='22023';end if;
    return new;
  end if;
  if new.balance_request_id is not null then return new; end if;
  if new.tenant_id = 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid and new.balance_request_id is null and tg_op='INSERT'
     and not exists(select 1 from public.picklestreet_receipt_jobs j where j.tenant_id=new.tenant_id and j.booking_id=new.booking_id) then
    raise exception 'PICKLESTREET_PENDING_FLOW_REQUIRED' using errcode='22023';
  end if;
  if new.tenant_id <> 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid
     or not exists (select 1 from public.picklestreet_receipt_jobs j
       where j.tenant_id=new.tenant_id and j.booking_id=new.booking_id) then
    return new;
  end if;
  if new.status not in ('pending','manual_review','auto_approved') then
    raise exception 'PICKLESTREET_RECEIPT_REMAINS_PENDING' using errcode='22023';
  end if;
  if new.status='auto_approved' and (tg_op='INSERT' or old.status is distinct from new.status)
     and (auth.role() is distinct from 'service_role'
       or coalesce(current_setting('app.picklestreet_auto_approval',true),'') <> new.id::text) then
    raise exception 'PICKLESTREET_AUTOMATIC_VERIFICATION_REQUIRED' using errcode='42501';
  end if;
  return new;
end;
$function$
;
create table public.picklestreet_rejection_emails (
 booking_id uuid primary key references public.bookings(id),
 tenant_id uuid not null check(tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid),
 receipt_id uuid not null references public.receipt_verifications(id),
 delivery_id uuid not null default extensions.gen_random_uuid(),
 status text not null default 'pending' check(status in ('pending','sending','sent')),
 lease_until timestamptz, sent_at timestamptz, created_at timestamptz not null default now()
);
alter table public.picklestreet_rejection_emails enable row level security;
revoke all on public.picklestreet_rejection_emails from public,anon,authenticated;
grant all on public.picklestreet_rejection_emails to service_role;
create function public.reject_picklestreet_duplicate(p_attempt_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t constant uuid:='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';a public.picklestreet_receipt_attempts%rowtype;
b public.bookings%rowtype;r public.receipt_verifications%rowtype;ref text;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED' using errcode='42501';end if;
 select * into a from public.picklestreet_receipt_attempts where tenant_id=t and id=p_attempt_id;
 if not found then return jsonb_build_object('rejected',false);end if;
 select * into b from public.bookings where tenant_id=t and id=a.booking_id for update;
 if b.metadata->>'duplicateReferenceRejected'='true' then
   return jsonb_build_object('rejected',true,'bookingReference',b.reference,'bookingId',b.id,'status','rejected','bookingStatus','cancelled','paymentStatus','rejected');
 end if;
 -- OCR must agree with the supplied reference, and a different accepted payment
 -- must already own it. An uncertain OCR match or a retry of this booking stays pending.
 if b.status not in ('payment_review','pending_payment','expired') or b.payment_status<>'pending'
 or a.completed_at is null or a.outcome<>'pending' then return jsonb_build_object('rejected',false);end if;
 perform 1 from public.picklestreet_receipt_jobs where tenant_id=t and booking_id=b.id and current_attempt_id=a.id for update;
 if not found then return jsonb_build_object('rejected',false);end if;
 select * into r from public.receipt_verifications where tenant_id=t and id=a.receipt_id for update;
 if r.balance_request_id is not null or r.status not in ('pending','manual_review') then return jsonb_build_object('rejected',false);end if;
 ref:=regexp_replace(upper(a.payment_reference),'[^A-Z0-9]','','g');
 if coalesce(length(ref),0)<6 or ref<>regexp_replace(upper(a.submitted_reference),'[^A-Z0-9]','','g') then return jsonb_build_object('rejected',false);end if;
 perform pg_advisory_xact_lock(hashtextextended('picklestreet-reference:'||ref,0));
 if not exists(select 1 from public.receipt_verifications prior join public.payment_sessions ps on ps.id=prior.payment_session_id and ps.tenant_id=t
   where prior.tenant_id=t and prior.booking_id<>b.id and prior.status in ('approved','auto_approved') and ps.status='paid'
   and regexp_replace(upper(prior.payment_reference),'[^A-Z0-9]','','g')=ref) then return jsonb_build_object('rejected',false);end if;
 perform set_config('app.picklestreet_duplicate_reject',r.id::text,true);
 update public.receipt_verifications set status='rejected',flags=array['duplicate_payment_reference'],reviewed_at=now(),
 extracted_data=extracted_data||jsonb_build_object('automaticRejection','duplicate_payment_reference') where tenant_id=t and id=r.id;
 update public.payment_sessions set status='failed' where tenant_id=t and id=r.payment_session_id and status<>'paid';
 update public.booking_slots set status='cancelled',hold_expires_at=null where tenant_id=t and booking_id=b.id and status in ('held','expired');
 update public.bookings set status='cancelled',payment_status='rejected',cancelled_at=now(),expires_at=null,
 metadata=metadata||jsonb_build_object('duplicateReferenceRejected',true,'paymentRejectionReason','This payment reference has already been used for another booking.') where tenant_id=t and id=b.id;
 update public.picklestreet_receipt_jobs set lease_token=null,lease_until=null where tenant_id=t and booking_id=b.id;
 insert into public.picklestreet_rejection_emails(tenant_id,booking_id,receipt_id) values(t,b.id,r.id) on conflict do nothing;
 return jsonb_build_object('rejected',true,'bookingReference',b.reference,'bookingId',b.id,'status','rejected','bookingStatus','cancelled','paymentStatus','rejected','flags',jsonb_build_array('duplicate_payment_reference'));
end;$$;
revoke all on function public.reject_picklestreet_duplicate(uuid) from public,anon,authenticated;
grant execute on function public.reject_picklestreet_duplicate(uuid) to service_role;
commit;
