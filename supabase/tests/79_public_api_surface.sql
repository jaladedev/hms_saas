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

  -- 4h. No table has two permissive policies for the same role and action (advisor lint 0006, migration 191). A FOR ALL policy counts
  -- for all four actions, so a `_select` policy next to a FOR ALL `_write` policy is an overlap: both run on every read.
  select string_agg(t || ' ' || a || ' ' || r, ', ' order by t, a, r) into v from (
    select p.tablename t, c.a, r, count(*) n
      from pg_policies p, unnest(p.roles) r,
           unnest(case when p.cmd = 'ALL' then array['SELECT','INSERT','UPDATE','DELETE'] else array[p.cmd] end) c(a)
     where p.schemaname = 'public' and p.permissive = 'PERMISSIVE'
     group by 1, 2, 3 having count(*) > 1) x;
  if v is not null then raise exception 'FAIL 4h tables with overlapping permissive policies (split the FOR ALL policy into insert, update and delete, and fold its rule into the select policy with or): %', v; end if;

  -- 4i. Every foreign key on the tables that grow with use and are read through all day has a covering index (advisor lint 0001,
  -- migration 191). Foreign keys to auth.users (created_by, voided_by and so on) are left out on purpose.
  select string_agg(c.conrelid::regclass::text || '.' || c.conname, ', ' order by c.conrelid::regclass::text, c.conname) into v
    from pg_constraint c
   where c.contype = 'f' and c.connamespace = 'public'::regnamespace
     and c.conrelid::regclass::text in ('reservation_rooms','reservations','folio_charges','folio_payments','folio_invoices','payments','invoices','refunds','pos_orders','pos_order_lines','housekeeping_tasks','maintenance_requests','service_bookings')
     and c.confrelid::regclass::text <> 'auth.users'
     and not exists (select 1 from pg_index i where i.indrelid = c.conrelid and (i.indkey::int2[])[0:(array_length(c.conkey,1)-1)] @> c.conkey);
  if v is not null then raise exception 'FAIL 4i foreign keys without a covering index on the busy tables (create index ... on table (the foreign key columns)): %', v; end if;

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
  raise notice 'PASS the STAGING.md security checks hold: RLS everywhere, no anon policies, three anon functions, server functions closed, no anon views, trigger functions closed with a fixed search_path, no overlapping policies, busy-table foreign keys indexed';
end $$;
