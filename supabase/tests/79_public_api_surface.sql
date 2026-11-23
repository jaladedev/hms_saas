-- The five security checks of docs/STAGING.md step 4, run on every `npm run db:test` so the checklist cannot drift from the schema.
-- Runs right after the migrations, before the tests create helper tables and functions in public (those would show up here).
-- When a check fails, the message names what it found. A new function that anon may run is a decision: add it to the list below
-- and to STAGING.md 4c on purpose, or revoke it (revoke all on function ... from public, anon).
\set ON_ERROR_STOP on

do $$ declare v text; begin
  -- 4a. Tables in public without row-level security
  select string_agg(c.relname, ', ' order by c.relname) into v
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
  if v is not null then raise exception 'FAIL 4a tables without row-level security: %', v; end if;

  -- 4b. Policies that name anon or public
  select string_agg(tablename || '.' || policyname, ', ' order by tablename, policyname) into v
    from pg_policies where schemaname = 'public' and (roles::text like '%anon%' or roles::text like '%public%');
  if v is not null then raise exception 'FAIL 4b policies that name anon or public: %', v; end if;

  -- 4c. Exactly three functions anon can run (leaving out extension and trigger functions)
  select string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ', ' order by p.proname) into v
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prorettype <> 'trigger'::regtype
     and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
     and has_function_privilege('anon', p.oid, 'execute');
  if v is distinct from 'has_permission(p_property uuid, p_permission text), has_tenant_permission(p_tenant uuid, p_permission text), my_tenant_ids()'
    then raise exception 'FAIL 4c functions anon can run: %', v; end if;

  -- 4f. Trigger functions are closed to client roles (migration 187). They cannot be called over RPC, but they should not be in the API
  -- surface at all, and the advisor (lint 0028) lists every one that anon can execute.
  select string_agg(p.proname, ', ' order by p.proname) into v
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prorettype = 'trigger'::regtype
     and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
     and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'));
  if v is not null then raise exception 'FAIL 4f trigger functions client roles can execute (revoke all on function ... from public, anon, authenticated): %', v; end if;

  -- 4g. Every trigger function has a fixed search_path (advisor lint 0011), as migrations 135 and 187 set.
  select string_agg(p.proname, ', ' order by p.proname) into v
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prorettype = 'trigger'::regtype
     and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
     and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%');
  if v is not null then raise exception 'FAIL 4g trigger functions without a fixed search_path (alter function ... set search_path = public): %', v; end if;

  -- 4d. The server-only functions are closed to both client roles
  select string_agg(p.proname, ', ' order by p.proname) into v
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('claim_room', 'create_hold', 'confirm_payment', 'search_availability', 'expire_lapsed_holds', 'is_system_caller')
     and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'));
  if v is not null then raise exception 'FAIL 4d server-only functions open to client roles: %', v; end if;

  -- 4e. Views anon can read
  select string_agg(c.relname, ', ' order by c.relname) into v
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('v', 'm')
     and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('public', c.oid, 'select'));
  if v is not null then raise exception 'FAIL 4e views anon can read: %', v; end if;

  -- a CHECK helper must stay usable by signed-in staff, or editing a room type would fail with "permission denied"
  if not has_function_privilege('authenticated', 'amenities_valid(text[])', 'execute')
    then raise exception 'FAIL authenticated lost EXECUTE on amenities_valid, which the room_types CHECK needs'; end if;
  raise notice 'PASS the STAGING.md security checks hold: RLS everywhere, no anon policies, three anon functions, server functions closed, no anon views, trigger functions closed with a fixed search_path';
end $$;
