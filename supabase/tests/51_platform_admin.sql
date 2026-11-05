-- Platform administration (migration 050). Reuses t_as / t_sys / t_expect (05).
--   f050 platform admin (level admin), f051 platform support, f052 an ordinary hotel owner of Hotel A (aa01), f053 the owner of the new group.
-- Everything a platform person does goes through functions as themselves; the table of admins is never readable by logins.
\set ON_ERROR_STOP on

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000f050', 'admin@platform.test'), ('00000000-0000-0000-0000-00000000f051', 'support@platform.test'),
  ('00000000-0000-0000-0000-00000000f053', 'owner@newhotel.test');
insert into platform_admins (user_id, level) values ('00000000-0000-0000-0000-00000000f050', 'admin'), ('00000000-0000-0000-0000-00000000f051', 'support');

create function t50_create(p_slug text default 't50-hotel', p_code text default 'T50', p_host text default 'book.t50-hotel.test', p_owner uuid default '00000000-0000-0000-0000-00000000f053',
                           p_tz text default 'Africa/Lagos', p_ref text default 'env:PAYSTACK_SECRET_T50', p_mode text default 'test', p_cur text default 'NGN') returns jsonb
language sql as $$
  select platform_create_tenant('T50 Hotels', p_slug, 'T50 Hotel Ibadan', p_code, 'Ibadan', 'Oyo', p_tz, p_cur, p_host, p_owner, p_ref, p_mode)
$$;

-- 1. Who may call: nobody but a platform admin; support reads only; anonymous cannot even execute
do $$ begin
  -- an ordinary hotel owner, however senior
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  if platform_level() is not null then raise exception 'FAIL an owner has a platform level'; end if;
  perform t_expect('select platform_list_tenants()', 'NOT_FOUND');
  perform t_expect($q$select platform_tenant_detail('00000000-0000-0000-0000-0000000000a1')$q$, 'NOT_FOUND');
  perform t_expect('select t50_create()', 'NOT_FOUND');
  perform t_expect($q$select platform_set_tenant_status('00000000-0000-0000-0000-0000000000a1', 'suspended', 'no reason at all')$q$, 'NOT_FOUND');
  perform t_expect($q$select platform_add_domain('00000000-0000-0000-0000-0000000000a1', null, 'x.example.com')$q$, 'NOT_FOUND');
  perform t_expect($q$select platform_set_domain_verified(gen_random_uuid(), true)$q$, 'NOT_FOUND');
  perform t_expect($q$select platform_set_provider_status(gen_random_uuid(), 'active')$q$, 'NOT_FOUND');
  -- the table of admins itself
  begin perform count(*) from platform_admins; raise exception 'FAIL an owner read platform_admins';
  exception when insufficient_privilege then null; end;

  -- support: read, never write
  perform t_as('00000000-0000-0000-0000-00000000f051');
  if platform_level() <> 'support' then raise exception 'FAIL support level'; end if;
  if jsonb_array_length(platform_list_tenants()) < 2 then raise exception 'FAIL support cannot list'; end if;
  if platform_tenant_detail('00000000-0000-0000-0000-0000000000a1') -> 'tenant' ->> 'slug' is null then raise exception 'FAIL support cannot read detail'; end if;
  perform t_expect('select t50_create()', 'NOT_FOUND');
  perform t_expect($q$select platform_set_tenant_status('00000000-0000-0000-0000-0000000000a1', 'suspended', 'no reason at all')$q$, 'NOT_FOUND');
  perform t_expect($q$select platform_add_domain('00000000-0000-0000-0000-0000000000a1', null, 'x.example.com')$q$, 'NOT_FOUND');
  perform t_sys();
  if (select status from tenants where id = '00000000-0000-0000-0000-0000000000a1') <> 'active' then raise exception 'FAIL support changed a tenant'; end if;
  raise notice 'PASS only a platform admin can write; support can read; a hotel owner is told NOT_FOUND by every function';
end $$;
begin;
set local role anon;
do $$ begin
  begin perform platform_list_tenants(); raise exception 'FAIL anon executed a platform function';
  exception when insufficient_privilege then null; end;
  begin perform platform_level(); raise exception 'FAIL anon executed platform_level';
  exception when insufficient_privilege then null; end;
end $$;
rollback;
do $$ begin raise notice 'PASS anonymous callers cannot execute the platform functions'; end $$;

-- 2. Creating a hotel group, all of it, as the admin
do $$ declare r jsonb; v_t uuid; v_p uuid; n integer; a audit_logs%rowtype; begin
  perform t_as('00000000-0000-0000-0000-00000000f050');
  r := t50_create();
  v_t := (r ->> 'tenant_id')::uuid; v_p := (r ->> 'property_id')::uuid;
  perform t_sys();
  if (select name || '|' || slug || '|' || status || '|' || default_currency from tenants where id = v_t) is distinct from 'T50 Hotels|t50-hotel|active|NGN' then raise exception 'FAIL tenant row'; end if;
  if not exists (select 1 from properties where id = v_p and tenant_id = v_t and code = 'T50' and timezone = 'Africa/Lagos') then raise exception 'FAIL property row'; end if;
  if not exists (select 1 from tenant_domains where tenant_id = v_t and property_id = v_p and host = 'book.t50-hotel.test' and verified_at is null and is_primary) then raise exception 'FAIL domain should exist and be unverified'; end if;
  if not exists (select 1 from tenant_memberships m join membership_roles mr on mr.membership_id = m.id join roles ro on ro.id = mr.role_id
                  where m.tenant_id = v_t and m.user_id = '00000000-0000-0000-0000-00000000f053' and m.status = 'active' and ro.key = 'owner' and mr.property_id is null) then raise exception 'FAIL owner membership'; end if;
  if not exists (select 1 from payment_provider_accounts where tenant_id = v_t and provider = 'paystack' and mode = 'test' and status = 'inactive' and secret_reference = 'env:PAYSTACK_SECRET_T50') then raise exception 'FAIL payment account (inactive)'; end if;
  if exists (select 1 from tenant_subscriptions where tenant_id = v_t) then raise exception 'FAIL a subscription was invented'; end if;
  -- an unverified domain: the guest site does not answer on it
  begin perform resolve_host('book.t50-hotel.test'); raise exception 'FAIL an unverified domain resolved';
  exception when sqlstate 'P0001' then if sqlerrm not like 'NOT_FOUND%' then raise; end if; end;

  -- the actor on every row is the admin, not null
  select * into a from audit_logs where action = 'platform.tenant_created' and entity_id = v_t;
  if a.actor_user_id is distinct from '00000000-0000-0000-0000-00000000f050'::uuid or a.metadata ->> 'host' <> 'book.t50-hotel.test' then raise exception 'FAIL summary audit %', a; end if;
  select count(*) into n from audit_logs where tenant_id = v_t and actor_user_id = '00000000-0000-0000-0000-00000000f050'
     and action in ('tenant.created','property.created','tenant_domain.created','payment_provider_account.created');
  if n <> 4 then raise exception 'FAIL expected the four table audit rows with the admin as actor, got %', n; end if;
  raise notice 'PASS creating a group makes its property, unverified domain, owner and inactive payment account, audited with the admin as actor';
end $$;

-- 3. Refusals, and nothing half-made
do $$ declare n_t bigint; n_p bigint; n_d bigint; n_m bigint; n_a bigint; begin
  perform t_sys();
  select count(*) into n_t from tenants; select count(*) into n_p from properties; select count(*) into n_d from tenant_domains;
  select count(*) into n_m from tenant_memberships; select count(*) into n_a from payment_provider_accounts;
  perform t_as('00000000-0000-0000-0000-00000000f050');
  perform t_expect($q$select t50_create('Bad Slug')$q$, 'POLICY_VIOLATION: slug');
  perform t_expect($q$select t50_create('t50-b', 'lower')$q$, 'POLICY_VIOLATION: code');
  perform t_expect($q$select t50_create('t50-b', 'T50B', 'not a host')$q$, 'POLICY_VIOLATION: host');
  perform t_expect($q$select t50_create('t50-b', 'T50B', 'localhost')$q$, 'POLICY_VIOLATION: host');
  perform t_expect($q$select t50_create('t50-b', 'T50B', 'book.t50-b.test', gen_random_uuid())$q$, 'NOT_FOUND: owner');
  perform t_expect($q$select t50_create('t50-b', 'T50B', 'book.t50-b.test', '00000000-0000-0000-0000-00000000f053', 'Mars/Base')$q$, 'POLICY_VIOLATION: timezone');
  perform t_expect($q$select t50_create('t50-b', 'T50B', 'book.t50-b.test', '00000000-0000-0000-0000-00000000f053', 'Africa/Lagos', 'PAYSTACK_SECRET')$q$, 'POLICY_VIOLATION: secret reference');
  perform t_expect($q$select t50_create('t50-b', 'T50B', 'book.t50-b.test', '00000000-0000-0000-0000-00000000f053', 'Africa/Lagos', 'env:PAYSTACK_SECRET_B', 'sandbox')$q$, 'POLICY_VIOLATION: payment mode');
  perform t_expect($q$select t50_create('t50-b', 'T50B', 'book.t50-b.test', '00000000-0000-0000-0000-00000000f053', 'Africa/Lagos', 'env:X', 'test', 'naira')$q$, 'POLICY_VIOLATION: currency');
  perform t_expect($q$select t50_create('t50-hotel', 'T50B', 'book.t50-b.test')$q$, 'CONFLICT: slug');
  perform t_expect($q$select t50_create('t50-b', 'T50B', 'BOOK.T50-HOTEL.TEST')$q$, 'CONFLICT: host');
  -- a property code already used inside the new tenant cannot clash, but a failure after the first inserts must undo them:
  -- the unique rule on (tenant, code) is satisfied, so force the late failure with a second owner-less path instead
  begin perform platform_create_tenant('  ', 't50-c', 'P', 'T50C', null, null, 'Africa/Lagos', 'NGN', 'book.t50-c.test', '00000000-0000-0000-0000-00000000f053', null, null);
        raise exception 'FAIL blank name accepted'; exception when sqlstate 'P0001' then if sqlerrm not like 'POLICY_VIOLATION: name%' then raise; end if; end;
  perform t_sys();
  if (select count(*) from tenants) <> n_t or (select count(*) from properties) <> n_p or (select count(*) from tenant_domains) <> n_d
     or (select count(*) from tenant_memberships) <> n_m or (select count(*) from payment_provider_accounts) <> n_a then raise exception 'FAIL a refused creation left rows behind'; end if;
  raise notice 'PASS every refusal says why and leaves nothing behind';
end $$;

-- 4. Optional parts: no payment account asked for means none is made; blank city and state take the defaults
do $$ declare r jsonb; v_t uuid; begin
  perform t_as('00000000-0000-0000-0000-00000000f050');
  r := platform_create_tenant('T50 Two', 't50-two', 'T50 Two Lodge', 'T502', '', null, 'Africa/Lagos', 'NGN', 'book.t50-two.test', '00000000-0000-0000-0000-00000000f053', null, null);
  v_t := (r ->> 'tenant_id')::uuid;
  perform t_sys();
  if r -> 'payment_account_id' <> 'null'::jsonb or exists (select 1 from payment_provider_accounts where tenant_id = v_t) then raise exception 'FAIL a payment account was made without being asked'; end if;
  if (select city || '|' || state from properties where tenant_id = v_t) is distinct from 'Ibadan|Oyo' then raise exception 'FAIL defaults'; end if;
  raise notice 'PASS no payment account unless asked for; blank city and state take the defaults';
end $$;

-- 5. Domains: added unverified, verified only by an admin, unverified again on request; a suspended group is unreachable
do $$ declare v_t uuid := (select id from tenants where slug = 't50-hotel'); v_p uuid := (select id from properties where tenant_id = (select id from tenants where slug = 't50-hotel'));
  v_d uuid; v_main uuid; r jsonb; begin
  perform t_sys();
  v_main := (select id from tenant_domains where host = 'book.t50-hotel.test');
  perform t_as('00000000-0000-0000-0000-00000000f050');
  r := platform_add_domain(v_t, v_p, 'Stay.T50-Hotel.test');
  v_d := (r ->> 'domain_id')::uuid;
  perform t_expect(format('select platform_add_domain(%L, %L, %L)', v_t, v_p, 'stay.t50-hotel.test'), 'CONFLICT: host');
  perform t_expect(format('select platform_add_domain(%L, %L, %L)', v_t, '00000000-0000-0000-0000-0000000000a2', 'other.t50-hotel.test'), 'NOT_FOUND: property');
  perform t_expect(format('select platform_add_domain(%L, null, %L)', v_t, 'bad host'), 'POLICY_VIOLATION: host');
  perform t_sys();
  if (select verified_at from tenant_domains where id = v_d) is not null or (select host from tenant_domains where id = v_d) <> 'stay.t50-hotel.test' then raise exception 'FAIL new domain'; end if;

  perform t_as('00000000-0000-0000-0000-00000000f050');
  if not (platform_set_domain_verified(v_main, true) ->> 'changed')::boolean then raise exception 'FAIL verify'; end if;
  if (platform_set_domain_verified(v_main, true) ->> 'changed')::boolean then raise exception 'FAIL a repeat verify said it changed'; end if;
  perform t_sys();
  if (select count(*) from resolve_host('book.t50-hotel.test')) <> 1 then raise exception 'FAIL a verified domain does not resolve'; end if;

  -- suspend: the guest site stops answering; restore: it answers again
  perform t_as('00000000-0000-0000-0000-00000000f050');
  perform t_expect(format('select platform_set_tenant_status(%L, %L, %L)', v_t, 'suspended', 'x'), 'POLICY_VIOLATION: reason');
  perform t_expect(format('select platform_set_tenant_status(%L, %L, %L)', v_t, 'paused', 'long enough'), 'POLICY_VIOLATION: status');
  perform t_expect(format('select platform_set_tenant_status(%L, %L, %L)', gen_random_uuid(), 'suspended', 'long enough'), 'NOT_FOUND');
  r := platform_set_tenant_status(v_t, 'suspended', 'Unpaid invoice, agreed with the owner');
  if not (r ->> 'changed')::boolean then raise exception 'FAIL suspend'; end if;
  if (platform_set_tenant_status(v_t, 'suspended', 'a second time') ->> 'changed')::boolean then raise exception 'FAIL a repeat suspend said it changed'; end if;
  perform t_sys();
  begin perform resolve_host('book.t50-hotel.test'); raise exception 'FAIL a suspended group still resolves';
  exception when sqlstate 'P0001' then if sqlerrm not like 'NOT_FOUND%' then raise; end if; end;
  if not exists (select 1 from audit_logs where action = 'platform.tenant_status_changed' and entity_id = v_t and actor_user_id = '00000000-0000-0000-0000-00000000f050'
                  and metadata ->> 'from' = 'active' and metadata ->> 'to' = 'suspended' and metadata ->> 'reason' = 'Unpaid invoice, agreed with the owner') then raise exception 'FAIL status audit'; end if;
  perform t_as('00000000-0000-0000-0000-00000000f050');
  perform platform_set_tenant_status(v_t, 'active', 'Paid');
  perform platform_set_domain_verified(v_main, false);
  perform t_sys();
  begin perform resolve_host('book.t50-hotel.test'); raise exception 'FAIL an unverified domain resolved again';
  exception when sqlstate 'P0001' then if sqlerrm not like 'NOT_FOUND%' then raise; end if; end;
  perform t_as('00000000-0000-0000-0000-00000000f050');
  perform platform_set_domain_verified(v_main, true);
  perform t_sys();
  if (select count(*) from resolve_host('book.t50-hotel.test')) <> 1 then raise exception 'FAIL restored group does not resolve'; end if;
  raise notice 'PASS domains start unverified; verifying, suspending and restoring a group switch the guest site on and off, each audited with its reason';
end $$;

-- 6. Payment account: inactive until an admin switches it on
do $$ declare v_a uuid := (select a.id from payment_provider_accounts a join tenants t on t.id = a.tenant_id where t.slug = 't50-hotel'); r jsonb; begin
  perform t_as('00000000-0000-0000-0000-00000000f050');
  perform t_expect(format('select platform_set_provider_status(%L, %L)', v_a, 'on'), 'POLICY_VIOLATION: status');
  r := platform_set_provider_status(v_a, 'active');
  if not (r ->> 'changed')::boolean or (platform_set_provider_status(v_a, 'active') ->> 'changed')::boolean then raise exception 'FAIL provider status'; end if;
  perform t_sys();
  if not exists (select 1 from audit_logs where action = 'platform.payment_account_status_changed' and entity_id = v_a and metadata ->> 'to' = 'active' and actor_user_id = '00000000-0000-0000-0000-00000000f050') then raise exception 'FAIL provider audit'; end if;
  raise notice 'PASS a payment account goes active only when an admin switches it on, audited';
end $$;

-- 7. The new owner runs their own hotel and nobody else's; a platform admin reads none of a hotel's data
do $$ declare v_p uuid := (select p.id from properties p join tenants t on t.id = p.tenant_id where t.slug = 't50-hotel'); n bigint; tb text; begin
  perform t_as('00000000-0000-0000-0000-00000000f053');
  if not has_permission(v_p, 'property.configure') or not has_permission(v_p, 'staff.manage') then raise exception 'FAIL the new owner has no control of the new hotel'; end if;
  if has_permission('00000000-0000-0000-0000-0000000000a2', 'reservation.view') then raise exception 'FAIL the new owner reaches Hotel A'; end if;
  perform t_as('00000000-0000-0000-0000-00000000f050');
  foreach tb in array array['guests','reservations','reservation_rooms','invoices','payments','refunds','folio_charges','email_outbox','audit_logs','housekeeping_tasks','maintenance_requests','rooms','room_types','rate_plans','tax_rules','property_policies','tenant_memberships','membership_roles'] loop
    begin execute format('select count(*) from %I', tb) into n;
          if n <> 0 then raise exception 'FAIL a platform admin reads % rows of %', n, tb; end if;
    exception when insufficient_privilege then null; end;
  end loop;
  perform t_sys();
  raise notice 'PASS the new owner controls only the new hotel; a platform admin reads no guest, booking, money, audit or staff data';
end $$;

-- 8. What the detail and the list show (two domains by now: the first verified, the second added in section 5 and left unverified)
do $$ declare d jsonb; l jsonb; v_t uuid := (select id from tenants where slug = 't50-hotel'); e jsonb; begin
  perform t_as('00000000-0000-0000-0000-00000000f051');
  d := platform_tenant_detail(v_t);
  if jsonb_array_length(d -> 'properties') <> 1 or jsonb_array_length(d -> 'domains') <> 2 or jsonb_array_length(d -> 'payment_accounts') <> 1
     or d -> 'owners' -> 0 ->> 'email' <> 'owner@newhotel.test' or d -> 'owners' -> 0 ->> 'status' <> 'active' then raise exception 'FAIL detail %', d; end if;
  if d::text ~* 'secret_key|sk_(live|test)' then raise exception 'FAIL detail carries a secret'; end if;   -- only the env pointer, never a key
  select x into e from jsonb_array_elements(platform_list_tenants()) x where x ->> 'slug' = 't50-hotel';
  if (e ->> 'properties')::int <> 1 or (e ->> 'domains')::int <> 2 or (e ->> 'domains_verified')::int <> 1 or (e ->> 'active_owners')::int <> 1 or e ->> 'status' <> 'active' then raise exception 'FAIL list row %', e; end if;
  perform t_expect($q$select platform_tenant_detail(gen_random_uuid())$q$, 'NOT_FOUND');
  perform t_sys();
  raise notice 'PASS the list and detail show configuration and the owner''s email, and no secret';
end $$;
