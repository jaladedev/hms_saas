-- 187 Close trigger functions to client roles and pin the search_path of the 15 that migrations 148 to 168 left open.
--
-- Found on 2026-11-23 by running Supabase's security advisor on the hms project (the first run against a real Supabase project):
--   * lint 0028 (anon_security_definer_function_executable): 17 trigger functions were executable by `anon` (and `authenticated`)
--     through /rest/v1/rpc/<name>. A trigger function cannot be called that way (Postgres answers "trigger functions can only be
--     called as triggers"), so nothing could be done with them, but they are API surface that should not exist, and
--     `79_public_api_surface.sql` 4c left trigger functions out of its count, so the local suite never saw them.
--   * lint 0011 (function_search_path_mutable): 15 SECURITY INVOKER trigger functions had no fixed search_path. Migration 135 pinned
--     the earlier ones; these came later (POS, stock, services, groups, company credit, HR, day close, API calls, event payments).
--
-- 1. Every trigger function in `public` that does not belong to an extension loses EXECUTE for public, anon and authenticated.
--    Postgres checks EXECUTE on a trigger function when the trigger is created, not when it fires, so existing triggers keep working
--    for every writer; service_role keeps its grant and is not touched. Done in a loop over pg_proc, so a trigger function added by
--    an earlier migration is covered even if this file does not name it. A later migration that adds one must do the same, and
--    `79_public_api_surface.sql` 4f now fails if it does not.
-- 2. The 15 named functions get `set search_path = public`, the same setting the other 29 got in 135. Their bodies are 80 to 820
--    characters each and call no extension function (checked against the bodies on the hms project), so nothing resolves differently.
--    Only the setting changes: bodies, volatility, owners and triggers are untouched and no row is rewritten.
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prorettype = 'trigger'::regtype
       and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
  end loop;
end $$;

alter function api_calls_guard() set search_path = public;
alter function company_credit_history() set search_path = public;
alter function day_closes_guard() set search_path = public;
alter function event_payments_immutable() set search_path = public;
alter function group_invoice_lines_guard() set search_path = public;
alter function group_invoices_guard() set search_path = public;
alter function group_payments_history() set search_path = public;
alter function hr_guard_attendance() set search_path = public;
alter function pos_guard_lines() set search_path = public;
alter function pos_guard_orders() set search_path = public;
alter function pos_guard_payments() set search_path = public;
alter function stock_guard_items() set search_path = public;
alter function stock_guard_ledger() set search_path = public;
alter function svc_guard_bookings() set search_path = public;
alter function svc_guard_services() set search_path = public;
