-- 097 A catalog of plans: name, monthly price and the features a plan switches on.
--
-- 051 left plans as a free-text code on a hotel group, with no price and no meaning. This adds the list those codes can point to.
-- plans.code matches tenant_subscriptions.plan_code (no foreign key: existing groups may carry a code that is not listed, and
-- the subscription stays editable as before). A price is a whole number of kobo (minor units) per month in plans.currency.
-- price_is_placeholder stays true until an admin saves the plan, so a screen can say the price is not decided yet.
-- features is a list of feature keys the plan turns ON. Applying a plan to a group sets the seven enforced flags (the keys below)
-- on for the keys in the list and off for the rest; keys outside the seven are not touched.
--
-- Nothing here charges or invoices a hotel. It records what a plan is called, costs and includes.
--
-- platform_list_plans(): support or admin. platform_save_plan(...): admin; creates or updates by code, a repeat changes nothing.
-- platform_apply_plan(tenant, code): admin; sets the group's plan code and flags. A plan marked inactive cannot be applied, but
-- groups already on it keep working.
-- Audited by the 047 trigger (actor auth.uid()).

create table plans (
  id                   uuid primary key default gen_random_uuid(),
  code                 text not null unique check (code ~ '^[a-z0-9][a-z0-9_-]{1,39}$'),
  name                 text not null check (char_length(btrim(name)) between 2 and 60),
  description          text check (description is null or char_length(description) <= 300),
  monthly_price_minor  bigint not null default 0 check (monthly_price_minor >= 0 and monthly_price_minor <= 100000000000),
  currency             text not null default 'NGN' check (currency ~ '^[A-Z]{3}$'),
  features             text[] not null default '{}',
  price_is_placeholder boolean not null default true,
  active               boolean not null default true,
  sort_order           integer not null default 100,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create trigger plans_updated before update on plans for each row execute function set_updated_at();
alter table plans enable row level security;   -- no policy: only the functions below (security definer) and the service role touch it
revoke all on plans from public, anon, authenticated;
create trigger plans_audit after insert or update or delete on plans
  for each row execute function audit_config_row('plan', 'code,name,description,monthly_price_minor,currency,features,price_is_placeholder,active,sort_order');

-- Starting plans. The prices are placeholders to be edited on /platform/plans.
insert into plans (code, name, description, monthly_price_minor, features, sort_order) values
  ('starter',  'Starter',  'Placeholder plan: one property, bookings and front desk.', 1500000, array['online_booking', 'online_payments'], 10),
  ('standard', 'Standard', 'Placeholder plan: adds guest self-service and exports.',   3500000, array['online_booking', 'online_payments', 'guest_cancel', 'guest_changes', 'reports.export'], 20),
  ('pro',      'Pro',      'Placeholder plan: everything that is enforced today.',     7500000, array['online_booking', 'online_payments', 'guest_cancel', 'guest_changes', 'reports.export', 'discounts', 'early_checkin'], 30);

create function plan_enforced_flags() returns text[]
language sql immutable as $$
  select array['reports.export', 'online_payments', 'discounts', 'online_booking', 'guest_cancel', 'guest_changes', 'early_checkin']
$$;
revoke all on function plan_enforced_flags() from public, anon;

create function platform_list_plans() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform platform_require('support');
  return coalesce((select jsonb_agg(jsonb_build_object(
      'code', p.code, 'name', p.name, 'description', p.description, 'monthly_price_minor', p.monthly_price_minor, 'currency', p.currency,
      'features', to_jsonb(p.features), 'price_is_placeholder', p.price_is_placeholder, 'active', p.active,
      'groups', (select count(distinct s.tenant_id) from tenant_subscriptions s where s.plan_code = p.code)) order by p.sort_order, p.code)
    from plans p), '[]'::jsonb);
end $$;

create function platform_save_plan(p_code text, p_name text, p_description text, p_price_minor bigint, p_features text[], p_active boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_code text := lower(btrim(coalesce(p_code, '')));
  v_name text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
  v_desc text := nullif(btrim(coalesce(p_description, '')), '');
  v_features text[];
  p plans%rowtype;
begin
  perform platform_require('admin');
  if v_code !~ '^[a-z0-9][a-z0-9_-]{1,39}$' then raise exception 'POLICY_VIOLATION: plan code' using errcode = 'P0001'; end if;
  if char_length(v_name) not between 2 and 60 then raise exception 'POLICY_VIOLATION: plan name' using errcode = 'P0001'; end if;
  if v_desc is not null and char_length(v_desc) > 300 then raise exception 'POLICY_VIOLATION: plan description' using errcode = 'P0001'; end if;
  if p_price_minor is null or p_price_minor < 0 or p_price_minor > 100000000000 then raise exception 'POLICY_VIOLATION: plan price' using errcode = 'P0001'; end if;
  if p_active is null then raise exception 'POLICY_VIOLATION: plan active' using errcode = 'P0001'; end if;
  -- Features: trimmed, lower case, no blanks, no repeats, sorted; each one must look like a feature key (051 rule).
  select coalesce(array_agg(distinct k order by k), '{}') into v_features
    from (select lower(btrim(x)) as k from unnest(coalesce(p_features, '{}')) x) f where k <> '';
  if exists (select 1 from unnest(v_features) k where k !~ '^[a-z][a-z0-9_.]{1,59}$') or cardinality(v_features) > 40 then
    raise exception 'POLICY_VIOLATION: plan features' using errcode = 'P0001';
  end if;

  select * into p from plans where code = v_code for update;
  if not found then
    insert into plans (code, name, description, monthly_price_minor, features, active, price_is_placeholder)
    values (v_code, v_name, v_desc, p_price_minor, v_features, p_active, false);
    return jsonb_build_object('changed', true);
  end if;
  if p.name = v_name and p.description is not distinct from v_desc and p.monthly_price_minor = p_price_minor
     and p.features = v_features and p.active = p_active and not p.price_is_placeholder then
    return jsonb_build_object('changed', false);
  end if;
  update plans set name = v_name, description = v_desc, monthly_price_minor = p_price_minor, features = v_features,
                   active = p_active, price_is_placeholder = false
   where id = p.id;
  return jsonb_build_object('changed', true);
end $$;

create function platform_apply_plan(p_tenant uuid, p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_code text := lower(btrim(coalesce(p_code, '')));
  p plans%rowtype; s tenant_subscriptions%rowtype; k text; v_on boolean; v_changed int := 0;
begin
  perform platform_require('admin');
  perform 1 from tenants where id = p_tenant for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  select * into p from plans where code = v_code;
  if not found or not p.active then raise exception 'POLICY_VIOLATION: plan' using errcode = 'P0001'; end if;

  select * into s from tenant_subscriptions where tenant_id = p_tenant order by created_at desc limit 1;
  if not found then
    insert into tenant_subscriptions (tenant_id, plan_code, status, current_period_start) values (p_tenant, p.code, 'trial', now());
    v_changed := v_changed + 1;
  elsif s.plan_code <> p.code then
    update tenant_subscriptions set plan_code = p.code where id = s.id;
    v_changed := v_changed + 1;
  end if;

  foreach k in array plan_enforced_flags() loop
    v_on := k = any (p.features);
    insert into tenant_feature_entitlements (tenant_id, feature_key, enabled) values (p_tenant, k, v_on)
    on conflict (tenant_id, feature_key) do update set enabled = excluded.enabled where tenant_feature_entitlements.enabled <> excluded.enabled;
    if found then v_changed := v_changed + 1; end if;
  end loop;
  return jsonb_build_object('changed', v_changed > 0);
end $$;

revoke all on function platform_list_plans(), platform_save_plan(text, text, text, bigint, text[], boolean), platform_apply_plan(uuid, text) from public, anon;
grant execute on function platform_list_plans(), platform_save_plan(text, text, text, bigint, text[], boolean), platform_apply_plan(uuid, text) to authenticated;
