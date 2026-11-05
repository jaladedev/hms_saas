-- 050 Platform administration and tenant onboarding.
--
-- Until now a hotel group was created by hand in SQL (docs/STAGING.md) and platform_admins could only be read by the service
-- role. These functions let a platform admin, signed in as themselves, onboard and look after hotel groups, so every change
-- carries their own login as the audit actor (047 audits the tables; this adds one summary row per action).
--
-- Who may do what. A platform admin is a row in platform_admins, a separate identity from hotel staff:
--   support: read the list and one group's configuration;
--   admin:   also create a group, suspend or restore it, add or verify a domain, switch a payment account on or off.
-- Anyone else, and anyone signed out, gets NOT_FOUND (anon cannot execute the functions at all).
-- A platform admin gets NO hotel data through this: no guests, reservations, payments, invoices or audit rows. The functions
-- return configuration only, and a platform admin has no membership, so row level security shows them nothing in a hotel's tables.
--
-- Choices made here that the business may want to change:
--   * a new domain is NOT verified. A domain decides which hotel a visitor reaches (and where their payment goes), so a person
--     marks it verified only after checking that it really points at this app; until then the guest site does not answer on it.
--   * a new payment account is created inactive. It goes active when its secret exists in the app's environment.
--   * no subscription or entitlement is created: plans and prices are not decided.
--   * a group needs an owner at creation (an existing login; the app invites by email first), so it can always be administered.

create function platform_level() returns text
language sql stable security definer set search_path = public as $$
  select level from platform_admins where user_id = auth.uid()
$$;

-- Internal: raises NOT_FOUND unless the caller has at least the level asked for ('support' or 'admin').
create function platform_require(p_min text) returns uuid
language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_level text;
begin
  select level into v_level from platform_admins where user_id = v_uid;
  if v_uid is null or v_level is null or (p_min = 'admin' and v_level <> 'admin') then
    raise exception 'NOT_FOUND' using errcode = 'P0001';
  end if;
  return v_uid;
end $$;

create function platform_list_tenants() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform platform_require('support');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', t.id, 'name', t.name, 'slug', t.slug, 'status', t.status, 'created_at', t.created_at,
      'properties', (select count(*) from properties p where p.tenant_id = t.id),
      'domains', (select count(*) from tenant_domains d where d.tenant_id = t.id),
      'domains_verified', (select count(*) from tenant_domains d where d.tenant_id = t.id and d.verified_at is not null),
      'active_owners', (select count(distinct m.user_id) from tenant_memberships m
                          join membership_roles mr on mr.membership_id = m.id join roles r on r.id = mr.role_id
                         where m.tenant_id = t.id and m.status = 'active' and r.key = 'owner'),
      'plan_code', (select s.plan_code from tenant_subscriptions s where s.tenant_id = t.id order by s.created_at desc limit 1),
      'subscription_status', (select s.status from tenant_subscriptions s where s.tenant_id = t.id order by s.created_at desc limit 1)
    ) order by t.created_at desc, t.name)
    from tenants t), '[]'::jsonb);
end $$;

create function platform_tenant_detail(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare t tenants%rowtype;
begin
  perform platform_require('support');
  select * into t from tenants where id = p_tenant;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  return jsonb_build_object(
    'tenant', jsonb_build_object('id', t.id, 'name', t.name, 'slug', t.slug, 'status', t.status, 'currency', t.default_currency, 'created_at', t.created_at),
    'properties', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'code', p.code, 'city', p.city, 'state', p.state,
                     'timezone', p.timezone, 'currency', p.currency, 'status', p.status) order by p.name) from properties p where p.tenant_id = t.id), '[]'::jsonb),
    'domains', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'host', d.host, 'property_id', d.property_id, 'is_primary', d.is_primary,
                     'verified_at', d.verified_at) order by d.host) from tenant_domains d where d.tenant_id = t.id), '[]'::jsonb),
    'payment_accounts', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'provider', a.provider, 'mode', a.mode, 'label', a.account_label,
                     'secret_reference', a.secret_reference, 'status', a.status) order by a.mode, a.account_label)
                     from payment_provider_accounts a where a.tenant_id = t.id), '[]'::jsonb),
    'owners', coalesce((select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'email', u.email, 'status', m.status) order by u.email)
                     from tenant_memberships m join auth.users u on u.id = m.user_id
                    where m.tenant_id = t.id and exists (select 1 from membership_roles mr join roles r on r.id = mr.role_id
                                                          where mr.membership_id = m.id and r.key = 'owner')), '[]'::jsonb),
    'subscription', (select jsonb_build_object('plan_code', s.plan_code, 'status', s.status, 'trial_ends_at', s.trial_ends_at,
                     'current_period_end', s.current_period_end) from tenant_subscriptions s where s.tenant_id = t.id order by s.created_at desc limit 1));
end $$;

-- Creates a hotel group, its first property, an unverified domain, its owner and (optionally) an inactive Paystack account,
-- all or nothing. Returns the ids.
create function platform_create_tenant(
  p_name text, p_slug text, p_property_name text, p_property_code text, p_city text, p_state text, p_timezone text, p_currency text,
  p_host text, p_owner_user_id uuid, p_paystack_secret_reference text, p_paystack_mode text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid; v_tenant uuid; v_prop uuid; v_dom uuid; v_member uuid; v_acct uuid;
  v_name text := regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g');
  v_pname text := regexp_replace(trim(coalesce(p_property_name, '')), '\s+', ' ', 'g');
  v_host text := lower(trim(coalesce(p_host, '')));
  v_ref text := nullif(trim(coalesce(p_paystack_secret_reference, '')), '');
begin
  v_uid := platform_require('admin');
  if v_name = '' or length(v_name) > 120 or v_pname = '' or length(v_pname) > 120 then raise exception 'POLICY_VIOLATION: name' using errcode = 'P0001'; end if;
  if p_slug is null or p_slug !~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$' then raise exception 'POLICY_VIOLATION: slug' using errcode = 'P0001'; end if;
  if p_property_code is null or p_property_code !~ '^[A-Z0-9-]{2,12}$' then raise exception 'POLICY_VIOLATION: code' using errcode = 'P0001'; end if;
  if p_currency is null or p_currency !~ '^[A-Z]{3}$' then raise exception 'POLICY_VIOLATION: currency' using errcode = 'P0001'; end if;
  if length(v_host) > 253 or v_host !~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$' then raise exception 'POLICY_VIOLATION: host' using errcode = 'P0001'; end if;
  if p_timezone is null or not exists (select 1 from pg_timezone_names where name = p_timezone) then raise exception 'POLICY_VIOLATION: timezone' using errcode = 'P0001'; end if;
  if p_owner_user_id is null or not exists (select 1 from auth.users where id = p_owner_user_id) then raise exception 'NOT_FOUND: owner' using errcode = 'P0001'; end if;
  if v_ref is not null then
    if v_ref !~ '^env:[A-Z][A-Z0-9_]{2,60}$' then raise exception 'POLICY_VIOLATION: secret reference' using errcode = 'P0001'; end if;
    if p_paystack_mode is null or p_paystack_mode not in ('test', 'live') then raise exception 'POLICY_VIOLATION: payment mode' using errcode = 'P0001'; end if;
  end if;
  if exists (select 1 from tenants where slug = p_slug) then raise exception 'CONFLICT: slug' using errcode = 'P0001'; end if;
  if exists (select 1 from tenant_domains where host = v_host) then raise exception 'CONFLICT: host' using errcode = 'P0001'; end if;

  insert into tenants (name, slug, default_currency) values (v_name, p_slug, p_currency) returning id into v_tenant;
  insert into properties (tenant_id, name, code, city, state, timezone, currency)
    values (v_tenant, v_pname, p_property_code, coalesce(nullif(trim(p_city), ''), 'Ibadan'), coalesce(nullif(trim(p_state), ''), 'Oyo'), p_timezone, p_currency)
    returning id into v_prop;
  insert into tenant_domains (tenant_id, property_id, host, is_primary, verified_at) values (v_tenant, v_prop, v_host, true, null) returning id into v_dom;
  insert into tenant_memberships (tenant_id, user_id, status) values (v_tenant, p_owner_user_id, 'active') returning id into v_member;
  insert into membership_roles (membership_id, role_id) select v_member, id from roles where key = 'owner';
  if v_ref is not null then
    insert into payment_provider_accounts (tenant_id, provider, mode, account_label, secret_reference, status)
      values (v_tenant, 'paystack', p_paystack_mode, 'Paystack', v_ref, 'inactive') returning id into v_acct;
  end if;
  perform write_audit(v_tenant, v_prop, v_uid, 'platform.tenant_created', 'tenant', v_tenant, null,
    jsonb_build_object('name', v_name, 'slug', p_slug, 'property_code', p_property_code, 'host', v_host, 'owner_user_id', p_owner_user_id, 'payment_account', v_acct is not null));
  return jsonb_build_object('tenant_id', v_tenant, 'property_id', v_prop, 'domain_id', v_dom, 'payment_account_id', v_acct);
end $$;

create function platform_set_tenant_status(p_tenant uuid, p_status text, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid; t tenants%rowtype; v_reason text := trim(coalesce(p_reason, ''));
begin
  v_uid := platform_require('admin');
  if p_status is null or p_status not in ('active', 'suspended', 'closed') then raise exception 'POLICY_VIOLATION: status' using errcode = 'P0001'; end if;
  if length(v_reason) < 3 or length(v_reason) > 500 then raise exception 'POLICY_VIOLATION: reason' using errcode = 'P0001'; end if;
  select * into t from tenants where id = p_tenant for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if t.status = p_status then return jsonb_build_object('changed', false, 'status', t.status); end if;
  update tenants set status = p_status where id = p_tenant;
  perform write_audit(p_tenant, null, v_uid, 'platform.tenant_status_changed', 'tenant', p_tenant, null,
    jsonb_build_object('from', t.status, 'to', p_status, 'reason', v_reason));
  return jsonb_build_object('changed', true, 'status', p_status);
end $$;

create function platform_add_domain(p_tenant uuid, p_property uuid, p_host text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid; v_host text := lower(trim(coalesce(p_host, ''))); v_id uuid;
begin
  v_uid := platform_require('admin');
  if length(v_host) > 253 or v_host !~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$' then raise exception 'POLICY_VIOLATION: host' using errcode = 'P0001'; end if;
  if not exists (select 1 from tenants where id = p_tenant) then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if p_property is not null and not exists (select 1 from properties where id = p_property and tenant_id = p_tenant) then raise exception 'NOT_FOUND: property' using errcode = 'P0001'; end if;
  if exists (select 1 from tenant_domains where host = v_host) then raise exception 'CONFLICT: host' using errcode = 'P0001'; end if;
  insert into tenant_domains (tenant_id, property_id, host, is_primary, verified_at) values (p_tenant, p_property, v_host, false, null) returning id into v_id;
  perform write_audit(p_tenant, p_property, v_uid, 'platform.domain_added', 'tenant_domain', v_id, null, jsonb_build_object('host', v_host));
  return jsonb_build_object('domain_id', v_id);
end $$;

create function platform_set_domain_verified(p_domain uuid, p_verified boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid; d tenant_domains%rowtype; v_now boolean;
begin
  v_uid := platform_require('admin');
  if p_verified is null then raise exception 'POLICY_VIOLATION: verified' using errcode = 'P0001'; end if;
  select * into d from tenant_domains where id = p_domain for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_now := d.verified_at is not null;
  if v_now = p_verified then return jsonb_build_object('changed', false, 'verified', v_now); end if;
  update tenant_domains set verified_at = case when p_verified then now() end where id = p_domain;
  perform write_audit(d.tenant_id, d.property_id, v_uid, case when p_verified then 'platform.domain_verified' else 'platform.domain_unverified' end,
    'tenant_domain', d.id, null, jsonb_build_object('host', d.host));
  return jsonb_build_object('changed', true, 'verified', p_verified);
end $$;

create function platform_set_provider_status(p_account uuid, p_status text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid; a payment_provider_accounts%rowtype;
begin
  v_uid := platform_require('admin');
  if p_status is null or p_status not in ('inactive', 'active', 'disabled') then raise exception 'POLICY_VIOLATION: status' using errcode = 'P0001'; end if;
  select * into a from payment_provider_accounts where id = p_account for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if a.status = p_status then return jsonb_build_object('changed', false, 'status', a.status); end if;
  update payment_provider_accounts set status = p_status where id = p_account;
  perform write_audit(a.tenant_id, null, v_uid, 'platform.payment_account_status_changed', 'payment_provider_account', a.id, null,
    jsonb_build_object('from', a.status, 'to', p_status, 'mode', a.mode));
  return jsonb_build_object('changed', true, 'status', p_status);
end $$;

-- platform_require is internal. The rest are open to signed-in logins and answer NOT_FOUND to anyone who is not a platform admin.
revoke all on function platform_require(text) from public, anon, authenticated;
revoke all on function platform_level(), platform_list_tenants(), platform_tenant_detail(uuid),
  platform_create_tenant(text, text, text, text, text, text, text, text, text, uuid, text, text),
  platform_set_tenant_status(uuid, text, text), platform_add_domain(uuid, uuid, text),
  platform_set_domain_verified(uuid, boolean), platform_set_provider_status(uuid, text) from public, anon;
grant execute on function platform_level(), platform_list_tenants(), platform_tenant_detail(uuid),
  platform_create_tenant(text, text, text, text, text, text, text, text, text, uuid, text, text),
  platform_set_tenant_status(uuid, text, text), platform_add_domain(uuid, uuid, text),
  platform_set_domain_verified(uuid, boolean), platform_set_provider_status(uuid, text) to authenticated;
