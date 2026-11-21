-- Audit log client address (migration 170). Runs after 169: group 't50-hotel' has a test Paystack account, f050 is a platform
-- admin, f053 owns another group and has no audit access to this one.
-- The app passes the address as the request header x-client-ip; PostgREST shows request headers to the database as the setting
-- request.headers, and a trigger on audit_logs reads it. Here the setting is written by hand, the way PostgREST would.
\set ON_ERROR_STOP on

do $$
declare
  v_t uuid := (select id from tenants where slug = 't50-hotel');
  v_a uuid := (select id from payment_provider_accounts where tenant_id = (select id from tenants where slug = 't50-hotel') and mode = 'test');
  adm text := '00000000-0000-0000-0000-00000000f050';
  b text; got inet; n bigint;
begin
  if v_t is null or v_a is null then raise exception 'FAIL setup'; end if;

  -- 1. no header at all (system work, a guest, a test shell): the row is written, the address is null
  perform set_config('request.headers', '', true);
  insert into audit_logs (tenant_id, action, entity_type) values (v_t, 't170.none', 't170');
  if (select client_ip from audit_logs where action = 't170.none') is not null then raise exception 'FAIL no header gave an address'; end if;
  perform set_config('request.headers', '{"user-agent":"x","accept":"*/*"}', true);
  insert into audit_logs (tenant_id, action, entity_type) values (v_t, 't170.other', 't170');
  if (select client_ip from audit_logs where action = 't170.other') is not null then raise exception 'FAIL other headers gave an address'; end if;

  -- 2. a good address is stored: IPv4, IPv6, with spaces round it, and a /32 or /128 that names one host
  foreach b in array array['203.0.113.9', '2001:db8::1', '  198.51.100.4  ', '203.0.113.10/32', '2001:db8::2/128'] loop
    perform set_config('request.headers', jsonb_build_object('x-client-ip', b, 'user-agent', 'x')::text, true);
    insert into audit_logs (tenant_id, action, entity_type) values (v_t, 't170.good', 't170');
  end loop;
  if (select array_agg(host(client_ip) order by host(client_ip)) from audit_logs where action = 't170.good')
     is distinct from array['198.51.100.4', '2001:db8::1', '2001:db8::2', '203.0.113.10', '203.0.113.9']
     then raise exception 'FAIL good addresses: %', (select array_agg(host(client_ip)) from audit_logs where action = 't170.good'); end if;

  -- 3. anything else is recorded as no address, and the audit row is still written (an audit row must never be refused over this)
  foreach b in array array['garbage', '', '   ', '10.0.0.0/8', '203.0.113.9/24', '999.1.1.1', '1.2.3.4; drop table audit_logs', '2001:db8::/32', 'null'] loop
    perform set_config('request.headers', jsonb_build_object('x-client-ip', b)::text, true);
    insert into audit_logs (tenant_id, action, entity_type) values (v_t, 't170.bad', 't170');
  end loop;
  foreach b in array array['not json', '[]', '"just a string"', '{', '{"x-client-ip":'] loop
    perform set_config('request.headers', b, true);
    insert into audit_logs (tenant_id, action, entity_type) values (v_t, 't170.bad', 't170');
  end loop;
  if (select count(*) from audit_logs where action = 't170.bad') <> 14 then raise exception 'FAIL a bad header refused an audit row'; end if;
  if exists (select 1 from audit_logs where action = 't170.bad' and client_ip is not null) then raise exception 'FAIL a bad value was stored as an address'; end if;

  -- 4. a row that already names its address keeps it, whatever the header says
  perform set_config('request.headers', '{"x-client-ip":"203.0.113.77"}', true);
  insert into audit_logs (tenant_id, action, entity_type, client_ip) values (v_t, 't170.given', 't170', '192.0.2.1');
  if (select host(client_ip) from audit_logs where action = 't170.given') <> '192.0.2.1' then raise exception 'FAIL a given address was replaced'; end if;

  -- 5. a real audited function under a real login: the address reaches the row through security definer code and write_audit
  perform set_config('request.headers', '{"x-client-ip":"192.0.2.55"}', true);
  perform t_as(adm);
  perform platform_log_provider_check(v_t, v_a, 'ok', 'test');
  perform t_sys();
  select client_ip into got from audit_logs where action = 'platform.payment_account_checked' and client_ip = '192.0.2.55';
  if got is null then raise exception 'FAIL an audited function did not record the address'; end if;
  if (select count(*) from audit_logs where action = 'platform.payment_account_checked' and client_ip = '192.0.2.55' and actor_user_id = adm::uuid) <> 1
    then raise exception 'FAIL the address is not on the admin''s row'; end if;

  -- 6. history is still append-only, and the address cannot be edited or erased afterwards
  begin
    update audit_logs set client_ip = null where action = 't170.good';
    raise exception 'FAIL an address was erased';
  exception when check_violation then null; end;
  begin
    update audit_logs set client_ip = '192.0.2.200' where action = 't170.none';
    raise exception 'FAIL an address was added afterwards';
  exception when check_violation then null; end;
  begin
    delete from audit_logs where action like 't170.%';
    raise exception 'FAIL history was deleted';
  exception when check_violation then null; end;

  -- 7. nobody can call the trigger function, and a login with no audit access to this group reads none of these rows
  perform t_as(adm);
  begin
    perform audit_logs_set_client_ip();
    raise exception 'FAIL a login called the trigger function';
  exception when insufficient_privilege then null; end;
  perform t_as('00000000-0000-0000-0000-00000000f053');
  select count(*) into n from audit_logs where client_ip is not null;
  perform t_sys();
  if n <> 0 then raise exception 'FAIL a login without audit access read % addresses', n; end if;

  perform set_config('request.headers', '', true);
  raise notice 'PASS audit client address: stored from x-client-ip (v4, v6, host masks), anything else or nothing is null and never refuses the row, a given address wins, security definer functions record it, append-only holds, trigger not callable, not readable without audit access';
end $$;
