-- Platform people see no hotel data (the platform half of the role sweep; the office roles are in 42_role_sweep.sql).
-- Runs after 51. f050 platform admin, f051 platform support. Neither belongs to any hotel.
-- Four checks: (1) every table: no row readable, except reference data every login may read; (2) no hotel permission anywhere;
-- (3) every platform function refuses a hotel owner and any login that is not a platform person; (4) anon can run none of them.
-- A control (a Hotel A owner reading the same tables) proves the sweep would notice a leak.
\set ON_ERROR_STOP on

do $$
declare
  u text; tb text; n bigint; pid uuid; perm text; ctl_tables int := 0; v_props uuid[];
  allowed text[] := array['roles', 'permissions', 'role_permissions'];   -- reference data, readable by every login on purpose
  a_owner text := '00000000-0000-0000-0000-00000000aa01';
  fn record; args text; callers text[]; c text; msg text; calls int := 0;
begin
  select array_agg(id) into v_props from properties;   -- read as the system, before switching to a platform login
  if coalesce(array_length(v_props, 1), 0) < 3 then raise exception 'FAIL setup: expected several properties, got %', v_props; end if;

  -- 1 and 2. each platform login: no rows in any table, no permission at any property
  foreach u in array array['00000000-0000-0000-0000-00000000f050', '00000000-0000-0000-0000-00000000f051'] loop
    perform t_as(u);
    for tb in select c.relname from pg_class c join pg_namespace s on s.oid = c.relnamespace
               where s.nspname = 'public' and c.relkind in ('r', 'v', 'p') order by 1 loop
      continue when tb = any (allowed);
      continue when tb ~ '^t[0-9]+_';   -- scratch tables the other test files leave behind, not part of the product
      begin
        execute format('select count(*) from public.%I', tb) into n;
        if n <> 0 then raise exception 'FAIL platform login % reads % rows of %', u, n, tb; end if;
      exception when insufficient_privilege then null;
      end;
    end loop;
    foreach pid in array v_props loop
      for perm in select key from permissions loop
        if has_permission(pid, perm) then raise exception 'FAIL platform login % holds % at %', u, perm, pid; end if;
      end loop;
    end loop;
    perform t_sys();
  end loop;

  -- control: a Hotel A owner sees rows in the same kind of tables, so "0 rows" above means something
  perform t_as(a_owner);
  foreach tb in array array['properties', 'guests', 'reservations', 'audit_logs', 'rooms', 'room_types'] loop
    execute format('select count(*) from public.%I', tb) into n;
    if n > 0 then ctl_tables := ctl_tables + 1; end if;
  end loop;
  perform t_sys();
  if ctl_tables < 4 then raise exception 'FAIL control: the Hotel A owner sees rows in only % of 6 tables, the sweep proves nothing', ctl_tables; end if;

  -- 3. every platform function (but the two internal helpers) refuses people who are not platform admins
  callers := array[a_owner, '00000000-0000-0000-0000-00000000f053', gen_random_uuid()::text];
  for fn in select p.oid, p.proname, p.proargtypes::oid[] as argtypes from pg_proc p join pg_namespace s on s.oid = p.pronamespace
             where s.nspname = 'public' and p.proname like 'platform\_%' and p.proname not in ('platform_require', 'platform_level') order by 2 loop
    select coalesce(string_agg(case t::regtype::text when 'uuid' then 'gen_random_uuid()' when 'text' then quote_literal('x')
                                      when 'boolean' then 'true' else 'null' end || '::' || t::regtype::text, ', ' order by ord), '') into args
      from unnest(fn.argtypes) with ordinality as x(t, ord);
    foreach c in array callers loop
      perform t_as(c);
      begin
        execute format('select public.%I(%s)', fn.proname, args);
        raise exception 'FAIL % ran for a login that is not a platform person (%)', fn.proname, c;
      exception when sqlstate 'P0001' then
        get stacked diagnostics msg = message_text;
        if msg not like 'NOT_FOUND%' then raise exception 'FAIL % answered "%" to a non-platform login, expected NOT_FOUND', fn.proname, msg; end if;
        calls := calls + 1;
      end;
    end loop;
    perform t_sys();
    -- 4. anon cannot execute it at all
    if has_function_privilege('anon', fn.oid, 'execute') then raise exception 'FAIL anon can execute %', fn.proname; end if;
  end loop;
  if calls < 30 then raise exception 'FAIL expected the sweep to try many functions, it made % calls', calls; end if;

  -- platform_level tells a non-platform login nothing
  perform t_as(a_owner);
  if platform_level() is not null then raise exception 'FAIL a hotel owner has a platform level'; end if;
  perform t_sys();
  raise notice 'PASS platform admin and support read no hotel row and hold no hotel permission; every platform function refuses non-platform logins (% calls); anon runs none; control sees rows in % tables', calls, ctl_tables;
end $$;
