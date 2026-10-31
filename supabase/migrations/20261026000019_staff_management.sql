-- 019 Staff management: who works at the hotel, what they may do, and how that changes.
--
-- Identity tables stay closed to clients (002). These functions are the only door, and each one runs as the
-- signed-in person and checks, in the database, that:
--   * they hold staff.manage across the whole hotel group (a role with property_id null);
--   * they cannot grant, remove or suspend anything above their own authority: to give or take a role they
--     must hold every permission in it, at a scope that covers the property it is given for (ROLE_ESCALATION);
--   * they cannot change their own access (SELF_CHANGE), so nobody locks themselves out or promotes themselves;
--   * the last active owner of a hotel can never be removed or suspended (LAST_OWNER).
-- Of the system roles only the owner has staff.manage, so in practice only owners reach these functions.
--
-- Inviting a person who has no login yet needs Supabase's admin API, which the app calls with the service key
-- after `staff_check_grant` has said yes; `add_staff_member` then adds the membership under the same checks.
-- Revoking deletes the person's role rows, so a later re-invite starts clean instead of quietly restoring old access.

-- ---- internal helpers (not callable by clients) ------------------------------------------

create function staff_actor_manages(p_actor uuid, p_tenant uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
      from tenant_memberships m
      join membership_roles mr on mr.membership_id = m.id
      join role_permissions rp on rp.role_id = mr.role_id
      join permissions p on p.id = rp.permission_id
     where m.user_id = p_actor and m.tenant_id = p_tenant and m.status = 'active'
       and p.key = 'staff.manage' and mr.property_id is null)
$$;

-- True when, for every permission in the role, the actor holds it somewhere that covers p_property
-- (null means all properties, which only an all-properties holding covers).
create function staff_actor_covers(p_actor uuid, p_tenant uuid, p_role uuid, p_property uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select not exists (
    select 1 from role_permissions rp
     where rp.role_id = p_role
       and not exists (
         select 1
           from tenant_memberships m
           join membership_roles mr on mr.membership_id = m.id
           join role_permissions rp2 on rp2.role_id = mr.role_id
          where m.user_id = p_actor and m.tenant_id = p_tenant and m.status = 'active'
            and rp2.permission_id = rp.permission_id
            and (mr.property_id is null or mr.property_id = p_property)))
$$;

create function staff_other_active_owner(p_tenant uuid, p_membership uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
      from tenant_memberships m
      join membership_roles mr on mr.membership_id = m.id
      join roles r on r.id = mr.role_id
     where m.tenant_id = p_tenant and m.id <> p_membership and m.status = 'active'
       and r.key = 'owner' and mr.property_id is null)
$$;

create function staff_assert_can_grant(p_actor uuid, p_tenant uuid, p_role_key text, p_property uuid) returns uuid
language plpgsql stable security definer set search_path = public as $$
declare v_role uuid;
begin
  if p_actor is null or not staff_actor_manages(p_actor, p_tenant) then
    raise exception 'NOT_FOUND' using errcode = 'P0001';
  end if;
  select id into v_role from roles where key = p_role_key;
  if v_role is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if p_property is not null and not exists (select 1 from properties where id = p_property and tenant_id = p_tenant) then
    raise exception 'POLICY_VIOLATION: property' using errcode = 'P0001';
  end if;
  if not staff_actor_covers(p_actor, p_tenant, v_role, p_property) then
    raise exception 'POLICY_VIOLATION: ROLE_ESCALATION' using errcode = 'P0001';
  end if;
  return v_role;
end $$;

-- ---- what staff screens call -------------------------------------------------------------

-- Everyone in every hotel group the caller manages, with their roles. Includes revoked people (listed last).
create function staff_directory() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_actor uuid := auth.uid();
begin
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  return coalesce((
    select jsonb_agg(to_jsonb(x) order by (x.status = 'revoked'), x.email)
      from (
        select m.id as membership_id, m.tenant_id, m.user_id, m.status, u.email, up.full_name,
               (m.user_id = v_actor) as is_self,
               coalesce((select jsonb_agg(jsonb_build_object('id', mr.id, 'role_key', r.key, 'role_name', r.name,
                                                             'property_id', mr.property_id) order by r.name, mr.created_at)
                           from membership_roles mr join roles r on r.id = mr.role_id
                          where mr.membership_id = m.id), '[]'::jsonb) as roles
          from tenant_memberships m
          join auth.users u on u.id = m.user_id
          left join user_profiles up on up.id = m.user_id
         where staff_actor_manages(v_actor, m.tenant_id)) x), '[]'::jsonb);
end $$;

-- Dry run of a grant, so the app can refuse before it sends any invitation email.
create function staff_check_grant(p_tenant uuid, p_role_key text, p_property uuid) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  perform staff_assert_can_grant(auth.uid(), p_tenant, p_role_key, p_property);
end $$;

-- Adds a person to the hotel group (or adds a role to someone already in it). Repeating it changes nothing.
create function add_staff_member(p_tenant uuid, p_user uuid, p_role_key text, p_property uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := auth.uid(); v_role uuid; m tenant_memberships%rowtype; v_new boolean := false; v_n integer;
begin
  v_role := staff_assert_can_grant(v_actor, p_tenant, p_role_key, p_property);
  if p_user is null or not exists (select 1 from auth.users where id = p_user) then
    raise exception 'NOT_FOUND' using errcode = 'P0001';
  end if;

  select * into m from tenant_memberships where tenant_id = p_tenant and user_id = p_user for update;
  if not found then
    insert into tenant_memberships (tenant_id, user_id, status) values (p_tenant, p_user, 'active') returning * into m;
    v_new := true;
  elsif m.status = 'suspended' then
    raise exception 'INVALID_STATE: suspended' using errcode = 'P0001';
  elsif m.status = 'revoked' then
    delete from membership_roles where membership_id = m.id;
    update tenant_memberships set status = 'active' where id = m.id returning * into m;
    v_new := true;
  elsif m.status = 'invited' then
    update tenant_memberships set status = 'active' where id = m.id returning * into m;
  end if;

  insert into membership_roles (membership_id, role_id, property_id)
  select m.id, v_role, p_property
   where not exists (select 1 from membership_roles
                      where membership_id = m.id and role_id = v_role and property_id is not distinct from p_property);
  get diagnostics v_n = row_count;

  if v_n > 0 or v_new then
    perform write_audit(p_tenant, p_property, v_actor, 'staff.role_added', 'membership', m.id, null,
                        jsonb_build_object('user_id', p_user, 'role', p_role_key, 'property_id', p_property, 'new_member', v_new));
  end if;
  return jsonb_build_object('membership_id', m.id, 'new_member', v_new, 'role_added', v_n > 0);
end $$;

create function remove_staff_role(p_membership_role uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_actor uuid := auth.uid(); mr membership_roles%rowtype; m tenant_memberships%rowtype; r roles%rowtype;
begin
  select * into mr from membership_roles where id = p_membership_role;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  select * into m from tenant_memberships where id = mr.membership_id for update;
  if v_actor is null or not staff_actor_manages(v_actor, m.tenant_id) then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if m.user_id = v_actor then raise exception 'POLICY_VIOLATION: SELF_CHANGE' using errcode = 'P0001'; end if;
  select * into r from roles where id = mr.role_id;
  if not staff_actor_covers(v_actor, m.tenant_id, mr.role_id, mr.property_id) then
    raise exception 'POLICY_VIOLATION: ROLE_ESCALATION' using errcode = 'P0001';
  end if;
  if r.key = 'owner' and mr.property_id is null and m.status = 'active'
     and not staff_other_active_owner(m.tenant_id, m.id) then
    raise exception 'POLICY_VIOLATION: LAST_OWNER' using errcode = 'P0001';
  end if;

  delete from membership_roles where id = mr.id;
  perform write_audit(m.tenant_id, mr.property_id, v_actor, 'staff.role_removed', 'membership', m.id, null,
                      jsonb_build_object('user_id', m.user_id, 'role', r.key, 'property_id', mr.property_id));
  return jsonb_build_object('membership_id', m.id, 'removed', true);
end $$;

-- active <-> suspended, and either -> revoked (final: re-adding the person starts them with no old roles).
create function set_staff_status(p_membership uuid, p_status text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_actor uuid := auth.uid(); m tenant_memberships%rowtype; mr record; v_old text; v_owner boolean;
begin
  if p_status is null or p_status not in ('active', 'suspended', 'revoked') then
    raise exception 'POLICY_VIOLATION: status' using errcode = 'P0001';
  end if;
  select * into m from tenant_memberships where id = p_membership for update;
  if not found or v_actor is null or not staff_actor_manages(v_actor, m.tenant_id) then
    raise exception 'NOT_FOUND' using errcode = 'P0001';
  end if;
  if m.user_id = v_actor then raise exception 'POLICY_VIOLATION: SELF_CHANGE' using errcode = 'P0001'; end if;
  if m.status = p_status then return jsonb_build_object('membership_id', m.id, 'status', m.status, 'changed', false); end if;
  if m.status = 'revoked' then raise exception 'INVALID_STATE: revoked' using errcode = 'P0001'; end if;

  -- You may only act on people whose roles you could grant yourself.
  for mr in select role_id, property_id from membership_roles where membership_id = m.id loop
    if not staff_actor_covers(v_actor, m.tenant_id, mr.role_id, mr.property_id) then
      raise exception 'POLICY_VIOLATION: ROLE_ESCALATION' using errcode = 'P0001';
    end if;
  end loop;

  select exists (select 1 from membership_roles x join roles r on r.id = x.role_id
                  where x.membership_id = m.id and r.key = 'owner' and x.property_id is null) into v_owner;
  if v_owner and m.status = 'active' and p_status <> 'active' and not staff_other_active_owner(m.tenant_id, m.id) then
    raise exception 'POLICY_VIOLATION: LAST_OWNER' using errcode = 'P0001';
  end if;

  v_old := m.status;
  update tenant_memberships set status = p_status where id = m.id;
  if p_status = 'revoked' then delete from membership_roles where membership_id = m.id; end if;
  perform write_audit(m.tenant_id, null, v_actor, 'staff.status_changed', 'membership', m.id, null,
                      jsonb_build_object('user_id', m.user_id, 'from', v_old, 'to', p_status));
  return jsonb_build_object('membership_id', m.id, 'status', p_status, 'changed', true);
end $$;

-- Server only: the invitation step looks a person up by email to decide between "invite" and "just add".
create function find_user_id_by_email(p_email text) returns uuid
language sql stable security definer set search_path = public as $$
  select id from auth.users where lower(email) = lower(trim(p_email)) limit 1
$$;

revoke all on function staff_actor_manages(uuid, uuid), staff_actor_covers(uuid, uuid, uuid, uuid),
  staff_other_active_owner(uuid, uuid), staff_assert_can_grant(uuid, uuid, text, uuid)
  from public, anon, authenticated;
revoke all on function staff_directory(), staff_check_grant(uuid, text, uuid), add_staff_member(uuid, uuid, text, uuid),
  remove_staff_role(uuid), set_staff_status(uuid, text) from public, anon;
grant execute on function staff_directory(), staff_check_grant(uuid, text, uuid), add_staff_member(uuid, uuid, text, uuid),
  remove_staff_role(uuid), set_staff_status(uuid, text) to authenticated;
revoke all on function find_user_id_by_email(text) from public, anon, authenticated;
grant execute on function find_user_id_by_email(text) to service_role;
