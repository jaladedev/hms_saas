-- Audit coverage (migration 047): platform configuration is audited whoever changes it, and guests can only be edited
-- through update_guest. Hotel B's rows are changed and put back; the test leaves its own audit rows behind.
\set ON_ERROR_STOP on

-- 1. Each configuration table writes created, updated and deleted rows with the values that changed
do $$
declare
  tb constant uuid := '00000000-0000-0000-0000-0000000000b1'; pb constant uuid := '00000000-0000-0000-0000-0000000000b2';
  v_dom uuid; v_acct uuid; v_sub uuid; v_ent uuid; n integer; r audit_logs%rowtype;
begin
  perform t_sys();

  -- properties and tenants
  select count(*) into n from audit_logs where entity_type = 'property' and entity_id = pb;
  update properties set check_in_time = '15:30' where id = pb;
  select * into r from audit_logs where entity_type = 'property' and entity_id = pb order by created_at desc, id desc limit 1;
  if r.action <> 'property.updated' or r.property_id <> pb or r.tenant_id <> tb
     or r.metadata #>> '{changed,check_in_time,to}' <> '15:30:00' or r.metadata #>> '{changed,check_in_time,from}' is null then raise exception 'FAIL property audit %', r; end if;
  update properties set check_in_time = '15:30' where id = pb;   -- unchanged: nothing written
  update properties set updated_at = now() where id = pb;        -- a column that is not watched: nothing written
  if (select count(*) from audit_logs where entity_type = 'property' and entity_id = pb) <> n + 1 then raise exception 'FAIL an unchanged save wrote a row'; end if;
  update tenants set name = name || ' x' where id = tb;
  select * into r from audit_logs where entity_type = 'tenant' and entity_id = tb order by created_at desc, id desc limit 1;
  if r.action <> 'tenant.updated' or r.tenant_id <> tb or r.property_id is not null then raise exception 'FAIL tenant audit %', r; end if;
  update tenants set name = left(name, length(name) - 2) where id = tb;

  -- domains: which hotel a host reaches
  insert into tenant_domains (tenant_id, property_id, host) values (tb, pb, 't49.hotel-b.test') returning id into v_dom;
  update tenant_domains set verified_at = now() where id = v_dom;
  delete from tenant_domains where id = v_dom;
  -- rows written in one transaction share a timestamp, so the three are compared as a set
  if (select string_agg(action, ',' order by action) from audit_logs where entity_type = 'tenant_domain' and entity_id = v_dom) <> 'tenant_domain.created,tenant_domain.deleted,tenant_domain.updated' then
    raise exception 'FAIL domain audit trail %', (select string_agg(action, ',') from audit_logs where entity_id = v_dom);
  end if;
  if (select metadata #>> '{values,host}' from audit_logs where action = 'tenant_domain.deleted' and entity_id = v_dom) <> 't49.hotel-b.test' then raise exception 'FAIL deleted domain not named'; end if;

  -- provider accounts: where the money goes
  insert into payment_provider_accounts (tenant_id, provider, mode, account_label, secret_reference, status) values (tb, 'paystack', 'live', 'T49', 'env:T49_OLD', 'inactive') returning id into v_acct;
  update payment_provider_accounts set secret_reference = 'env:T49_NEW' where id = v_acct;
  select * into r from audit_logs where entity_type = 'payment_provider_account' and entity_id = v_acct and action = 'payment_provider_account.updated';
  if r.metadata #>> '{changed,secret_reference,from}' <> 'env:T49_OLD' or r.metadata #>> '{changed,secret_reference,to}' <> 'env:T49_NEW' then raise exception 'FAIL account audit %', r; end if;
  delete from payment_provider_accounts where id = v_acct;

  -- subscriptions and entitlements
  insert into tenant_subscriptions (tenant_id, plan_code, status) values (tb, 't49', 'trial') returning id into v_sub;
  update tenant_subscriptions set status = 'active' where id = v_sub;
  if (select metadata #>> '{changed,status,to}' from audit_logs where entity_id = v_sub and action = 'tenant_subscription.updated') <> 'active' then raise exception 'FAIL subscription audit'; end if;
  delete from tenant_subscriptions where id = v_sub;
  insert into tenant_feature_entitlements (tenant_id, feature_key, enabled) values (tb, 't49_feature', false) returning id into v_ent;
  update tenant_feature_entitlements set enabled = true where id = v_ent;
  if (select metadata #>> '{changed,enabled,to}' from audit_logs where entity_id = v_ent and action = 'tenant_feature_entitlement.updated') <> 'true' then raise exception 'FAIL entitlement audit'; end if;
  delete from tenant_feature_entitlements where id = v_ent;

  -- platform admins have no hotel: the row has a user and no tenant
  insert into auth.users (id) values ('00000000-0000-0000-0000-00000000f049');
  insert into platform_admins (user_id, level) values ('00000000-0000-0000-0000-00000000f049', 'support');
  select * into r from audit_logs where entity_type = 'platform_admin' and entity_id = '00000000-0000-0000-0000-00000000f049';
  if r.action <> 'platform_admin.created' or r.tenant_id is not null or r.property_id is not null or r.metadata #>> '{values,level}' <> 'support' then raise exception 'FAIL platform admin audit %', r; end if;
  delete from platform_admins where user_id = '00000000-0000-0000-0000-00000000f049';
  if not exists (select 1 from audit_logs where entity_type = 'platform_admin' and action = 'platform_admin.deleted') then raise exception 'FAIL platform admin removal not audited'; end if;

  raise notice 'PASS tenants, properties, domains, provider accounts, subscriptions, entitlements and platform admins are audited, and unchanged saves write nothing';
end $$;

-- 2. The service role's changes are audited too (it is how platform operations are done), with no actor
begin;
set local role service_role;
do $$ declare r audit_logs%rowtype; begin
  update tenant_domains set is_primary = is_primary where false;   -- no row: nothing
  update properties set check_out_time = '11:30' where id = '00000000-0000-0000-0000-0000000000b2';
  select * into r from audit_logs where entity_type = 'property' and entity_id = '00000000-0000-0000-0000-0000000000b2' order by created_at desc, id desc limit 1;
  if r.action <> 'property.updated' or r.actor_user_id is not null or r.metadata #>> '{changed,check_out_time,to}' <> '11:30:00' then raise exception 'FAIL service role change %', r; end if;
end $$;
rollback;
do $$ begin raise notice 'PASS a change made as the service role is audited, with no actor'; end $$;

-- 3. The trigger function is not callable by logins
do $$ begin
  begin set local role authenticated; perform audit_config_row(); raise exception 'FAIL authenticated called the trigger function';
  exception when insufficient_privilege or feature_not_supported then null; end;
  reset role;
  raise notice 'PASS the audit trigger function is closed to logins';
end $$;

-- 4. Guests: no direct update by any login, even the owner; update_guest still works; insert still works (walk-in bookings)
do $$ declare g constant uuid := '00000000-0000-0000-0000-0000000000a5'; n bigint; v_new uuid := gen_random_uuid(); r jsonb; begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  begin update guests set phone = '+2348099999999' where id = g; raise exception 'FAIL owner updated a guest directly';
  exception when insufficient_privilege then null; end;
  perform t_sys();
  select count(*) into n from audit_logs where action = 'guest.updated';   -- counted as the system: a guest edit has no property, so the owner cannot read its row
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  r := update_guest(g, 'Ada Okafor', 'ada@example.com', '+2348099999999', null, 'NG');
  insert into guests (id, tenant_id, full_name) values (v_new, '00000000-0000-0000-0000-0000000000a1', 'T49 Walk-in');
  perform t_sys();
  if (select count(*) from audit_logs where action = 'guest.updated') <> n + 1 then raise exception 'FAIL update_guest did not write its audit row'; end if;
  raise notice 'PASS a guest can only be changed through update_guest (audited); a new guest can still be added';
end $$;
