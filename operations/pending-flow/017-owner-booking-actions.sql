begin;

-- Only Pickle Street uses this endpoint; shared tenant actions remain unchanged.
create or replace function public.manage_picklestreet_booking(
 p_tenant_slug text, p_hostname text, p_reference text, p_action text
) returns jsonb language plpgsql security definer set search_path='' set row_security=off as $$
declare
 t uuid; b public.bookings%rowtype; system_owner boolean; actor_role text;
begin
 if auth.uid() is null or auth.role() is distinct from 'authenticated' then
  raise exception 'Please sign in to manage bookings.' using errcode='42501';
 end if;
 t:=public.resolve_tenant_id(p_tenant_slug,p_hostname);
 if t is distinct from 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid or not public.request_origin_matches_tenant(t) then
  raise exception 'Booking venue access denied.' using errcode='42501';
 end if;
 system_owner:=public.is_platform_owner();
 select role into actor_role from public.tenant_memberships where tenant_id=t and user_id=auth.uid() and status='active';
 if not coalesce(system_owner,false) and (p_action is distinct from 'cancel' or coalesce(actor_role,'') not in ('owner','admin')) then
  raise exception 'Only the System Owner can delete or archive. Court Owners may cancel bookings.' using errcode='42501';
 end if;
 if p_action is null or p_action not in ('cancel','archive','delete','restore') then
  raise exception 'Unknown booking action.' using errcode='22023';
 end if;
 select * into b from public.bookings where tenant_id=t and reference=p_reference for update;
 if not found then raise exception 'Booking not found.' using errcode='P0002'; end if;
 if coalesce(b.archive_reason,'') like '[deleted]%' then
  if p_action='delete' then return jsonb_build_object('ok',true); end if;
  raise exception 'This booking has been deleted from the dashboard.' using errcode='55000';
 end if;
 if p_action='restore' then
  update public.bookings set archived_at=null,archived_by=null,archive_reason=null where tenant_id=t and id=b.id;
 else
  -- Lock the parent first, then release every original and reschedule slot together.
  -- Paid evidence is retained; cancellation never means a refund was issued.
  if b.status::text in ('pending_payment','payment_review','confirmed') then
   update public.bookings set status='cancelled',cancelled_at=now(),expires_at=null,
    metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('cancellation',jsonb_build_object(
     'reason','Owner requested '||p_action,'cancelledBy',auth.uid(),'cancelledAt',now()))
    where tenant_id=t and id=b.id;
  end if;
  update public.booking_slots set status='cancelled',hold_expires_at=null
   where tenant_id=t and booking_id=b.id and status in ('held','confirmed');
  update public.payment_sessions set status='failed'
   where tenant_id=t and booking_id=b.id and status in ('created','pending');
  update public.booking_balance_requests set status='cancelled'
   where tenant_id=t and booking_id=b.id and status in ('awaiting_payment','payment_review');
  if p_action in ('archive','delete') then
   update public.bookings set archived_at=now(),archived_by=auth.uid(),
    archive_reason=case when p_action='delete' then '[deleted] Removed by System Owner; payment evidence retained.' else 'Archived by System Owner.' end
    where tenant_id=t and id=b.id;
  end if;
 end if;
 insert into public.audit_events(tenant_id,actor_user_id,actor_role,action,entity_table,entity_id,new_data,metadata)
 values(t,auth.uid(),case when system_owner then 'owner' else 'court_owner' end,
  'booking.owner_'||p_action,'bookings',b.id::text,jsonb_build_object('action',p_action),
  jsonb_build_object('paymentEvidenceRetained',true));
 return jsonb_build_object('ok',true,'bookingReference',b.reference,'action',p_action);
end;$$;
revoke all on function public.manage_picklestreet_booking(text,text,text,text) from public,anon;
grant execute on function public.manage_picklestreet_booking(text,text,text,text) to authenticated;
commit;
