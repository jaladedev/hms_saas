-- 005 Pricing and policy: rate plans, daily rates, tax rules, versioned property policies,
-- resolve_rate() and calc_night_tax(). Rates and taxes are data, never constants.

create table rate_plans (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null,
  property_id         uuid not null,
  name                text not null,
  code                text not null,
  is_default          boolean not null default false,
  cancellation_policy jsonb not null default '{}'::jsonb,
  payment_policy      jsonb not null default '{}'::jsonb,
  currency            char(3) not null default 'NGN',
  status              text not null default 'active' check (status in ('active','inactive')),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  foreign key (tenant_id, property_id) references properties (tenant_id, id),
  unique (tenant_id, property_id, id),
  unique (property_id, code)
);
create unique index rate_plans_one_default on rate_plans (property_id) where is_default;

create table daily_rates (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null,
  property_id   uuid not null,
  room_type_id  uuid not null,
  rate_plan_id  uuid not null,
  business_date date not null,
  amount_minor  bigint not null check (amount_minor > 0),
  currency      char(3) not null default 'NGN',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  foreign key (tenant_id, property_id, room_type_id) references room_types (tenant_id, property_id, id),
  foreign key (tenant_id, property_id, rate_plan_id) references rate_plans (tenant_id, property_id, id),
  unique (property_id, room_type_id, rate_plan_id, business_date)
);

-- Stay-level fixed charges and folio-only taxes are deferred; only per-night rules for now.
create table tax_rules (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null,
  property_id    uuid not null,
  name           text not null,
  basis          text not null check (basis in ('percent','fixed_per_night')),
  rate_value     numeric not null check (rate_value >= 0),
  sequence       integer not null default 1,
  compounds      boolean not null default false,   -- percent applies to running total incl. earlier rules
  effective_from date not null,
  effective_to   date,
  status         text not null default 'active' check (status in ('active','inactive')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  foreign key (tenant_id, property_id) references properties (tenant_id, id),
  check (effective_to is null or effective_to >= effective_from)
);

create table property_policies (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null,
  property_id    uuid not null,
  version        integer not null,
  effective_from date not null,
  config         jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object'),
  created_by     uuid,
  created_at     timestamptz not null default now(),
  foreign key (tenant_id, property_id) references properties (tenant_id, id),
  unique (property_id, version),
  unique (property_id, effective_from)
);

create trigger rate_plans_updated before update on rate_plans for each row execute function set_updated_at();
create trigger daily_rates_updated before update on daily_rates for each row execute function set_updated_at();
create trigger tax_rules_updated before update on tax_rules for each row execute function set_updated_at();

-- Policy rows are versioned: insert a new version, never edit in place.
create function property_policies_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'property_policies rows are immutable; insert a new version' using errcode = '23514';
end $$;
create trigger property_policies_no_update before update or delete on property_policies
  for each row execute function property_policies_immutable();

create index on daily_rates (property_id, business_date);
create index on tax_rules (property_id, effective_from) where status = 'active';

alter table rate_plans        enable row level security;
alter table daily_rates       enable row level security;
alter table tax_rules         enable row level security;
alter table property_policies enable row level security;

create policy rate_plans_select on rate_plans for select to authenticated
  using (has_permission(property_id,'rate.view') or has_permission(property_id,'reservation.view')
         or has_permission(property_id,'property.configure'));
create policy rate_plans_write on rate_plans for all to authenticated
  using (has_permission(property_id,'rate.manage')) with check (has_permission(property_id,'rate.manage'));

create policy daily_rates_select on daily_rates for select to authenticated
  using (has_permission(property_id,'rate.view') or has_permission(property_id,'reservation.view'));
create policy daily_rates_write on daily_rates for all to authenticated
  using (has_permission(property_id,'rate.manage')) with check (has_permission(property_id,'rate.manage'));

create policy tax_rules_select on tax_rules for select to authenticated
  using (has_permission(property_id,'rate.view') or has_permission(property_id,'reservation.view')
         or has_permission(property_id,'property.configure'));
create policy tax_rules_write on tax_rules for all to authenticated
  using (has_permission(property_id,'property.configure')) with check (has_permission(property_id,'property.configure'));

create policy property_policies_select on property_policies for select to authenticated
  using (has_permission(property_id,'reservation.view') or has_permission(property_id,'property.configure'));
create policy property_policies_insert on property_policies for insert to authenticated
  with check (has_permission(property_id,'property.configure'));

revoke delete on rate_plans, daily_rates, tax_rules from authenticated, anon;
revoke update, delete on property_policies from authenticated, anon;

-- Policy in force on a date, or an empty object when none exists yet.
create function current_policy(p_property uuid, p_on date) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select config from property_policies
      where property_id = p_property and effective_from <= p_on
      order by effective_from desc limit 1),
    '{}'::jsonb)
$$;

-- Rate for one night: booked plan, then the default plan, then the room type base rate.
-- Never defaults to zero: raises RATE_MISSING.
create function resolve_rate(p_property uuid, p_room_type uuid, p_rate_plan uuid, p_night date)
returns table (amount_minor bigint, source text)
language plpgsql stable security definer set search_path = public as $$
declare v bigint;
begin
  select d.amount_minor into v from daily_rates d
   where d.property_id = p_property and d.room_type_id = p_room_type
     and d.rate_plan_id = p_rate_plan and d.business_date = p_night;
  if v is not null then return query select v, 'daily_rate'::text; return; end if;

  select d.amount_minor into v from daily_rates d
    join rate_plans rp on rp.id = d.rate_plan_id and rp.is_default
   where d.property_id = p_property and d.room_type_id = p_room_type and d.business_date = p_night;
  if v is not null then return query select v, 'default_plan_daily_rate'::text; return; end if;

  select rt.base_rate_minor into v from room_types rt
   where rt.id = p_room_type and rt.property_id = p_property;
  if v is not null and v > 0 then return query select v, 'base_rate'::text; return; end if;

  raise exception 'RATE_MISSING' using errcode = 'P0001';
end $$;

-- Tax for one night in kobo, rules applied in sequence; each night's tax is rounded half up.
create function calc_night_tax(p_property uuid, p_night date, p_rate bigint) returns bigint
language plpgsql stable security definer set search_path = public as $$
declare r record; running numeric := p_rate; total bigint := 0; t bigint;
begin
  for r in
    select * from tax_rules
     where property_id = p_property and status = 'active'
       and effective_from <= p_night and (effective_to is null or effective_to >= p_night)
     order by sequence, id
  loop
    if r.basis = 'percent' then
      t := round((case when r.compounds then running else p_rate end) * r.rate_value / 100)::bigint;
    else
      t := round(r.rate_value)::bigint;
    end if;
    running := running + t;
    total := total + t;
  end loop;
  return total;
end $$;

revoke all on function current_policy(uuid, date), resolve_rate(uuid, uuid, uuid, date),
  calc_night_tax(uuid, date, bigint) from public, anon, authenticated;
