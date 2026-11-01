-- 029 Names for the people in the audit trail.
--
-- The setup history screen (/app/settings/history) lists who changed what. audit_logs holds only a user id, and
-- user_profiles and auth.users are not readable by a general manager, who holds audit.view but not staff.manage
-- (staff_directory() is for owners only). This returns a display name for the ids on a page of the trail, and only
-- for people who belong to a hotel group in which the caller holds audit.view at some property, so it is no way to
-- look up an email address by user id. Revoked and suspended members still resolve: history outlives access.
--
--   audit_actor_names(user_ids) -> (user_id, name)
--     name is the profile's full name, else the sign-in email, else null (the screen then says "A staff member").
--     Ids the caller may not see are simply absent. Each id comes back once. At most 200 ids are read; the rest are ignored.
--
-- Executable by signed-in users only; the permission check is inside, so a front desk login gets no rows.

create function audit_actor_names(p_user_ids uuid[]) returns table (user_id uuid, name text)
language sql stable security definer set search_path = public as $$
  select u.id,
         coalesce(nullif(trim(up.full_name), ''), nullif(trim(u.email), ''))
    from (select distinct x as id from unnest((coalesce(p_user_ids, '{}'::uuid[]))[1:200]) as x) as ids
    join auth.users u on u.id = ids.id
    left join user_profiles up on up.id = u.id
   where exists (
     select 1
       from tenant_memberships m
       join properties p on p.tenant_id = m.tenant_id
      where m.user_id = u.id
        and has_permission(p.id, 'audit.view'))
$$;

revoke all on function audit_actor_names(uuid[]) from public, anon;
grant execute on function audit_actor_names(uuid[]) to authenticated;
