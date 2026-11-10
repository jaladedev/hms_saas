-- 084 Custom roles: a hotel group's owner defines its own roles, beyond the seven system ones.
--
-- A custom role belongs to ONE hotel group (roles.tenant_id; system roles keep tenant_id null) and is granted exactly like a system
-- role: add_staff_member and remove_staff_role (019) work on it by key, at one property or all of them.
--   * Only a person who holds staff.manage across the whole group (in practice the owner) may create, change or delete one.
--   * A custom role may hold any permission EXCEPT staff.manage (that stays with the owner), and not both refund.request and
--     refund.approve together, so the role itself can never both ask for and approve a refund. (The database still refuses one
--     person approving their own request, whatever roles they hold.)
--   * It needs at least one permission, a name of 2 to 60 characters that is unique in the group and is not a system role's name,
--     and a group may hold at most 20 of them.
--   * A role in use cannot be deleted; its permissions can be changed and apply at once to everyone who holds it.
--   * Granting a custom role needs the same cover as any grant (the granter holds every permission in it), and a role of another
--     group is NOT_FOUND. Roles of another group are not even readable: roles_read and role_permissions_read are now scoped.
-- Keys are 'custom.<slug>.<first 8 of the group id>' so they stay unique across groups and never collide with a system key.

alter table roles add column tenant_id uuid references tenants(id);
alter table roles add constraint roles_custom_key check (
  (tenant_id is null and key not like 'custom.%') or (tenant_id is not null and key like 'custom.%' and not is_system));
create unique index roles_custom_name on roles (tenant_id, lower(name)) where tenant_id is not null;
create index roles_tenant on roles (tenant_id) where tenant_id is not null;

drop policy roles_read on roles;
drop policy role_permissions_read on role_permissions;
create policy roles_read on roles for select to authenticated using (tenant_id is null or tenant_id in (select my_tenant_ids()));
create policy role_permissions_read on role_permissions for select to authenticated
  using (role_id in (select id from roles where tenant_id is null or tenant_id in (select my_tenant_ids())));

-- Granting a role: a custom role of another group is NOT_FOUND (everything else as in 019).
create or replace function staff_assert_can_grant(p_actor uuid, p_tenant uuid, p_role_key text, p_property uuid) returns uuid
language plpgsql stable security definer set search_path = public as $$
declare v_role uuid;
begin
  if p_actor is null or not staff_actor_manages(p_actor, p_tenant) then
    raise exception 'NOT_FOUND' using errcode = 'P0001';
  end if;
  select id into v_role from roles where key = p_role_key and (tenant_id is null or tenant_id = p_tenant);
  if v_role is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if p_property is not null and not exists (select 1 from properties where id = p_property and tenant_id = p_tenant) then
    raise exception 'POLICY_VIOLATION: property' using errcode = 'P0001';
  end if;
  if not staff_actor_covers(p_actor, p_tenant, v_role, p_property) then
    raise exception 'POLICY_VIOLATION: ROLE_ESCALATION' using errcode = 'P0001';
  end if;
  return v_role;
end $$;

-- Checks a permission list and returns its permission ids. Raises POLICY_VIOLATION: permissions.
create function custom_role_permission_ids(p_permissions text[]) returns uuid[]
language plpgsql stable security definer set search_path = public as $$
declare v_keys text[]; v_ids uuid[];
begin
  select array_agg(distinct k) into v_keys from unnest(coalesce(p_permissions, '{}')) k where k is not null;
  if v_keys is null or array_length(v_keys, 1) = 0 or 'staff.manage' = any (v_keys)
     or ('refund.request' = any (v_keys) and 'refund.approve' = any (v_keys)) then
    raise exception 'POLICY_VIOLATION: permissions' using errcode = 'P0001';
  end if;
  select array_agg(id) into v_ids from permissions where key = any (v_keys);
  if coalesce(array_length(v_ids, 1), 0) <> array_length(v_keys, 1) then raise exception 'POLICY_VIOLATION: permissions' using errcode = 'P0001'; end if;
  return v_ids;
end $$;
revoke all on function custom_role_permission_ids(text[]) from public, anon, authenticated;

create function custom_role_name_ok(p_tenant uuid, p_name text, p_except uuid) returns text
language plpgsql stable security definer set search_path = public as $$
declare v text := btrim(coalesce(p_name, ''));
begin
  if length(v) < 2 or length(v) > 60 or v ~ '[<>]' then raise exception 'POLICY_VIOLATION: name' using errcode = 'P0001'; end if;
  if exists (select 1 from roles where tenant_id is null and lower(name) = lower(v))
     or exists (select 1 from roles where tenant_id = p_tenant and lower(name) = lower(v) and id is distinct from p_except) then
    raise exception 'POLICY_VIOLATION: name taken' using errcode = 'P0001';
  end if;
  return v;
end $$;
revoke all on function custom_role_name_ok(uuid, text, uuid) from public, anon, authenticated;

create function create_custom_role(p_tenant uuid, p_name text, p_permissions text[]) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_actor uuid := auth.uid(); v_name text; v_ids uuid[]; v_slug text; v_key text; v_id uuid;
begin
  if v_actor is null or not staff_actor_manages(v_actor, p_tenant) then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_name := custom_role_name_ok(p_tenant, p_name, null);
  v_ids := custom_role_permission_ids(p_permissions);
  if (select count(*) from roles where tenant_id = p_tenant) >= 20 then raise exception 'POLICY_VIOLATION: too many roles' using errcode = 'P0001'; end if;
  v_slug := trim(both '-' from regexp_replace(lower(v_name), '[^a-z0-9]+', '-', 'g'));
  if v_slug = '' then raise exception 'POLICY_VIOLATION: name' using errcode = 'P0001'; end if;
  v_key := 'custom.' || left(v_slug, 40) || '.' || left(p_tenant::text, 8);
  insert into roles (key, name, is_system, tenant_id) values (v_key, v_name, false, p_tenant) returning id into v_id;
  insert into role_permissions (role_id, permission_id) select v_id, unnest(v_ids);
  perform write_audit(p_tenant, null, v_actor, 'role.created', 'role', v_id, null,
                      jsonb_build_object('name', v_name, 'permissions', (select jsonb_agg(key order by key) from permissions where id = any (v_ids))));
  return jsonb_build_object('role_id', v_id, 'key', v_key);
exception when unique_violation then
  raise exception 'POLICY_VIOLATION: name taken' using errcode = 'P0001';
end $$;

create function update_custom_role(p_role uuid, p_name text, p_permissions text[]) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_actor uuid := auth.uid(); r roles%rowtype; v_name text; v_ids uuid[]; v_before jsonb;
begin
  select * into r from roles where id = p_role and tenant_id is not null;
  if not found or v_actor is null or not staff_actor_manages(v_actor, r.tenant_id) then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_name := custom_role_name_ok(r.tenant_id, p_name, r.id);
  v_ids := custom_role_permission_ids(p_permissions);
  select coalesce(jsonb_agg(p.key order by p.key), '[]') into v_before from role_permissions rp join permissions p on p.id = rp.permission_id where rp.role_id = r.id;
  delete from role_permissions where role_id = r.id;
  insert into role_permissions (role_id, permission_id) select r.id, unnest(v_ids);
  update roles set name = v_name where id = r.id;
  perform write_audit(r.tenant_id, null, v_actor, 'role.updated', 'role', r.id, null,
                      jsonb_build_object('name', v_name, 'was_name', r.name, 'was_permissions', v_before,
                                         'permissions', (select jsonb_agg(key order by key) from permissions where id = any (v_ids))));
  return jsonb_build_object('role_id', r.id);
exception when unique_violation then
  raise exception 'POLICY_VIOLATION: name taken' using errcode = 'P0001';
end $$;

create function delete_custom_role(p_role uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_actor uuid := auth.uid(); r roles%rowtype;
begin
  select * into r from roles where id = p_role and tenant_id is not null for update;
  if not found or v_actor is null or not staff_actor_manages(v_actor, r.tenant_id) then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if exists (select 1 from membership_roles where role_id = r.id) then raise exception 'INVALID_STATE: in use' using errcode = 'P0001'; end if;
  delete from roles where id = r.id;
  perform write_audit(r.tenant_id, null, v_actor, 'role.deleted', 'role', r.id, null, jsonb_build_object('name', r.name));
  return jsonb_build_object('deleted', true);
end $$;

-- The group's custom roles with their permissions and how many people hold each. Only for someone who manages the group.
create function custom_roles_list(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_actor uuid := auth.uid();
begin
  if v_actor is null or not staff_actor_manages(v_actor, p_tenant) then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'key', r.key, 'name', r.name,
           'permissions', (select coalesce(jsonb_agg(p.key order by p.key), '[]') from role_permissions rp join permissions p on p.id = rp.permission_id where rp.role_id = r.id),
           'holders', (select count(*) from membership_roles mr where mr.role_id = r.id)) order by r.name)
      from roles r where r.tenant_id = p_tenant), '[]'::jsonb);
end $$;

revoke all on function create_custom_role(uuid, text, text[]), update_custom_role(uuid, text, text[]), delete_custom_role(uuid), custom_roles_list(uuid) from public, anon;
grant execute on function create_custom_role(uuid, text, text[]), update_custom_role(uuid, text, text[]), delete_custom_role(uuid), custom_roles_list(uuid) to authenticated;
