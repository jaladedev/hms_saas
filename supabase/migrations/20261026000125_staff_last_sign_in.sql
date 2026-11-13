-- Staff directory: when each person last signed in (migration 125).
-- The prototype's Staff Management screen has a "Last Active" column. Supabase records auth.users.last_sign_in_at when someone signs in
-- with a password or a link; a refreshed session does not change it, so the app calls it "Last sign-in", not "last active".
-- Same function as migration 019 with one more field per person. Still owners and managers of the group only (staff_actor_manages),
-- still closed to anon, still the signed-in caller's own hotel group. Nothing else about it changes.
create or replace function staff_directory() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_actor uuid := auth.uid();
begin
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  return coalesce((
    select jsonb_agg(to_jsonb(x) order by (x.status = 'revoked'), x.email)
      from (
        select m.id as membership_id, m.tenant_id, m.user_id, m.status, u.email, up.full_name,
               (m.user_id = v_actor) as is_self,
               u.last_sign_in_at,
               coalesce((select jsonb_agg(jsonb_build_object('id', mr.id, 'role_key', r.key, 'role_name', r.name,
                                                             'property_id', mr.property_id) order by r.name, mr.created_at)
                           from membership_roles mr join roles r on r.id = mr.role_id
                          where mr.membership_id = m.id), '[]'::jsonb) as roles
          from tenant_memberships m
          join auth.users u on u.id = m.user_id
          left join user_profiles up on up.id = m.user_id
         where staff_actor_manages(v_actor, m.tenant_id)) x), '[]'::jsonb);
end $$;
