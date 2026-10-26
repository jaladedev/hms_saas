-- 001 Tenancy: tenants, properties, domains, subscriptions, entitlements.
-- RLS is enabled on every table; policies arrive in 002 once identity exists.
-- Until then, no policy means no access for client roles.

create extension if not exists btree_gist;

create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create table tenants (
  id               uuid primary key default gen_random_uuid(),
  name             text not null check (length(trim(name)) > 0),
  slug             text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$'),
  status           text not null default 'active' check (status in ('active','suspended','closed')),
  default_currency char(3) not null default 'NGN',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table properties (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id),
  name           text not null check (length(trim(name)) > 0),
  code           text not null check (code ~ '^[A-Z0-9-]{2,12}$'),
  address        text,
  city           text not null default 'Ibadan',
  state          text not null default 'Oyo',
  country_code   char(2) not null default 'NG',
  timezone       text not null default 'Africa/Lagos',
  currency       char(3) not null default 'NGN',
  check_in_time  time not null default '14:00',
  check_out_time time not null default '12:00',
  status         text not null default 'active' check (status in ('active','inactive')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, code)
);

create function properties_validate() returns trigger
language plpgsql as $$
begin
  if not exists (select 1 from pg_timezone_names where name = new.timezone) then
    raise exception 'INVALID_TIMEZONE: %', new.timezone using errcode = '22023';
  end if;
  if tg_op = 'UPDATE' then
    if new.code <> old.code then
      raise exception 'Property code is immutable' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

create trigger properties_validate_trg before insert or update on properties
  for each row execute function properties_validate();

create table tenant_domains (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  property_id uuid,
  host        text not null unique check (host = lower(host)),
  is_primary  boolean not null default false,
  verified_at timestamptz,
  created_at  timestamptz not null default now(),
  foreign key (tenant_id, property_id) references properties (tenant_id, id)
);

create table tenant_subscriptions (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenants(id),
  plan_code            text not null,
  status               text not null default 'trial'
                       check (status in ('trial','active','past_due','cancelled')),
  trial_ends_at        timestamptz,
  current_period_start timestamptz,
  current_period_end   timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create table tenant_feature_entitlements (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id),
  feature_key   text not null,
  enabled       boolean not null default false,
  configuration jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, feature_key)
);

create trigger tenants_updated before update on tenants for each row execute function set_updated_at();
create trigger properties_updated before update on properties for each row execute function set_updated_at();
create trigger tenant_subscriptions_updated before update on tenant_subscriptions for each row execute function set_updated_at();
create trigger tenant_entitlements_updated before update on tenant_feature_entitlements for each row execute function set_updated_at();

create index on properties (tenant_id, status);
create index on tenant_domains (tenant_id);

alter table tenants                      enable row level security;
alter table properties                   enable row level security;
alter table tenant_domains               enable row level security;
alter table tenant_subscriptions         enable row level security;
alter table tenant_feature_entitlements  enable row level security;
