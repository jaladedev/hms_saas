-- 002 Identity, memberships, roles, permissions, has_permission(), first RLS policies.
-- Requires Supabase's auth schema (auth.users, auth.uid()).

create table user_profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  full_name  text,
  phone      text,
  avatar_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Platform staff are a separate identity from hotel staff. Writable by service role only.
create table platform_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  level      text not null default 'support' check (level in ('support','admin')),
  created_at timestamptz not null default now()
);

create table tenant_memberships (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id),
  user_id    uuid not null references auth.users(id) on delete cascade,
  status     text not null default 'invited' check (status in ('invited','active','suspended','revoked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, user_id)
);

create table roles (
  id        uuid primary key default gen_random_uuid(),
  key       text not null unique,
  name      text not null,
  is_system boolean not null default true
);

create table permissions (
  id  uuid primary key default gen_random_uuid(),
  key text not null unique
);

create table role_permissions (
  role_id       uuid not null references roles(id) on delete cascade,
  permission_id uuid not null references permissions(id) on delete cascade,
  primary key (role_id, permission_id)
);

create table membership_roles (
  id            uuid primary key default gen_random_uuid(),
  membership_id uuid not null references tenant_memberships(id) on delete cascade,
  role_id       uuid not null references roles(id),
  property_id   uuid references properties(id),  -- null = all properties of the tenant
  created_at    timestamptz not null default now(),
  unique (membership_id, role_id, property_id)
);

create trigger user_profiles_updated before update on user_profiles for each row execute function set_updated_at();
create trigger tenant_memberships_updated before update on tenant_memberships for each row execute function set_updated_at();

create index on tenant_memberships (user_id, status);
create index on membership_roles (membership_id);
create index on role_permissions (role_id);

-- Keep a role's property scope inside the membership's tenant.
create function membership_roles_check() returns trigger
language plpgsql as $$
begin
  if new.property_id is not null and not exists (
    select 1 from tenant_memberships m
      join properties p on p.tenant_id = m.tenant_id
     where m.id = new.membership_id and p.id = new.property_id
  ) then
    raise exception 'Property does not belong to the membership tenant' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger membership_roles_check_trg before insert or update on membership_roles
  for each row execute function membership_roles_check();

-- ---- Seed permissions and system roles --------------------------------------------
insert into permissions (key) values
  ('room.view'),('room.assign'),('room.block'),
  ('reservation.view'),('reservation.create'),('reservation.modify'),('reservation.cancel'),
  ('reservation.checkin'),('reservation.checkout'),
  ('guest.view'),('guest.manage'),
  ('payment.record'),('payment.verify'),('refund.request'),('refund.approve'),
  ('invoice.issue'),('invoice.void'),
  ('rate.view'),('rate.manage'),('discount.apply'),
  ('report.view'),('report.export'),
  ('housekeeping.view'),('housekeeping.update'),('maintenance.manage'),
  ('staff.manage'),('property.configure'),('audit.view');

insert into roles (key, name) values
  ('owner','Hotel owner'),
  ('general_manager','General manager'),
  ('front_desk','Front desk'),
  ('reservations_officer','Reservations officer'),
  ('accountant','Accountant'),
  ('housekeeping','Housekeeping'),
  ('maintenance','Maintenance');

with grants(role_key, perm_key) as (
  select 'owner', key from permissions
  union all select 'general_manager', key from permissions where key <> 'staff.manage'
  union all select 'front_desk', unnest(array[
    'room.view','room.assign','reservation.view','reservation.create','reservation.modify',
    'reservation.checkin','reservation.checkout','guest.view','guest.manage','payment.record',
    'invoice.issue','housekeeping.view','housekeeping.update'])
  union all select 'reservations_officer', unnest(array[
    'room.view','room.assign','reservation.view','reservation.create','reservation.modify',
    'reservation.cancel','guest.view','guest.manage','rate.view'])
  union all select 'accountant', unnest(array[
    'reservation.view','guest.view','payment.record','payment.verify','refund.request',
    'refund.approve','invoice.issue','invoice.void','report.view','report.export'])
  union all select 'housekeeping', unnest(array['room.view','housekeeping.view','housekeeping.update'])
  union all select 'maintenance', unnest(array['room.view','maintenance.manage'])
)
insert into role_permissions (role_id, permission_id)
select r.id, p.id from grants g
  join roles r on r.key = g.role_key
  join permissions p on p.key = g.perm_key;

-- ---- Authorization helpers ---------------------------------------------------------
create function has_permission(p_property uuid, p_permission text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
      from tenant_memberships m
      join membership_roles mr on mr.membership_id = m.id
      join role_permissions rp on rp.role_id = mr.role_id
      join permissions p on p.id = rp.permission_id
      join properties pr on pr.id = p_property and pr.tenant_id = m.tenant_id
     where m.user_id = (select auth.uid())
       and m.status = 'active'
       and p.key = p_permission
       and (mr.property_id is null or mr.property_id = p_property)
  )
$$;

-- Tenants the caller actively belongs to (for tenant-level reads).
create function my_tenant_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select tenant_id from tenant_memberships
   where user_id = (select auth.uid()) and status = 'active'
$$;

revoke all on function has_permission(uuid, text) from public;
revoke all on function my_tenant_ids() from public;
grant execute on function has_permission(uuid, text) to authenticated;
grant execute on function my_tenant_ids() to authenticated;

-- ---- RLS ----------------------------------------------------------------------------
alter table user_profiles      enable row level security;
alter table platform_admins    enable row level security;   -- no policy: service role only
alter table tenant_memberships enable row level security;
alter table roles              enable row level security;
alter table permissions        enable row level security;
alter table role_permissions   enable row level security;
alter table membership_roles   enable row level security;

create policy profiles_self_select on user_profiles for select to authenticated
  using (id = (select auth.uid()));
create policy profiles_self_update on user_profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy memberships_self_select on tenant_memberships for select to authenticated
  using (user_id = (select auth.uid()));

create policy membership_roles_self_select on membership_roles for select to authenticated
  using (membership_id in (select id from tenant_memberships where user_id = (select auth.uid())));

create policy roles_read on roles for select to authenticated using (true);
create policy permissions_read on permissions for select to authenticated using (true);
create policy role_permissions_read on role_permissions for select to authenticated using (true);

-- Tenancy reads for members. Writes happen through service-role onboarding or later functions.
create policy tenants_member_select on tenants for select to authenticated
  using (id in (select my_tenant_ids()));
create policy properties_member_select on properties for select to authenticated
  using (has_permission(id, 'room.view') or has_permission(id, 'reservation.view')
         or has_permission(id, 'property.configure'));

-- Client roles never write identity or tenancy tables directly.
revoke insert, update, delete on tenants, properties, tenant_domains, tenant_subscriptions,
  tenant_feature_entitlements, tenant_memberships, roles, permissions, role_permissions,
  membership_roles, platform_admins from authenticated, anon;
revoke all on platform_admins from authenticated, anon;
