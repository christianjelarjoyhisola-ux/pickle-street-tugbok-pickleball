do $$
declare actor uuid; result jsonb; t uuid := 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';
begin
 select user_id into actor from public.platform_profiles where is_platform_owner limit 1;
 perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,true);
 perform set_config('request.headers','{"origin":"https://picklestreetcourt.com"}',true);
 result := public.set_blocked_date_access('pickle-street-tugbok','grant',0::smallint);
 if result->>'expiresAt' <> 'infinity' or result->>'status' <> 'active' then raise exception 'Unlimited grant failed'; end if;
 result := public.set_blocked_date_access('pickle-street-tugbok','revoke',null);
 if result->>'status' <> 'revoked' then raise exception 'Revoke failed'; end if;
 result := public.set_blocked_date_access('pickle-street-tugbok','grant',1::smallint);
 if result->>'expiresAt' = 'infinity' or result->>'durationDays' <> '1' then raise exception 'Timed replacement failed'; end if;
 select user_id into actor from public.tenant_memberships where tenant_id=t and status='active' and role in ('owner','admin') and user_id not in (select user_id from public.platform_profiles where is_platform_owner) limit 1;
 if actor is null then raise exception 'Court owner test actor unavailable'; end if;
 perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,true);
 begin
 perform public.set_blocked_date_access('pickle-street-tugbok','grant',0::smallint);
 raise exception 'Court owner incorrectly granted access';
 exception when insufficient_privilege then null; end;
 if not public.can_manage_blocked_dates(t) then raise exception 'Timed court owner grant failed'; end if;
 update public.blocked_date_access_grants set duration_days=0,expires_at='infinity' where tenant_id=t;
 if not public.can_manage_blocked_dates(t) then raise exception 'Unlimited court owner grant failed'; end if;
 update public.blocked_date_access_grants set revoked_at=now(),revoked_by=actor where tenant_id=t;
 if public.can_manage_blocked_dates(t) then raise exception 'Revoked access still active'; end if;
end $$;
select 'grant, revoke, replacement and role checks passed; changes rolled back' as result;
