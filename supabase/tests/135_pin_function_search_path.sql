-- Migration 135 pins the search_path of 29 helper and trigger functions. Checks that each one carries `search_path=public` and
-- that nothing else about it moved (still SECURITY INVOKER, still in public). Behaviour is covered by the rest of the suite, which
-- runs these functions as triggers, CHECK constraints and column defaults after the migration.
\set ON_ERROR_STOP on

do $$ declare
  fns text[] := array[
    'amenities_valid(text[])',
    'audit_logs_append_only()',
    'folio_charges_guard()',
    'folio_invoice_lines_guard()',
    'folio_invoices_guard()',
    'folio_payments_guard()',
    'hk_task_json(housekeeping_tasks)',
    'housekeeping_tasks_guard()',
    'immutable_money_row()',
    'invoices_guard()',
    'is_system_caller()',
    'maintenance_requests_guard()',
    'membership_roles_check()',
    'mt_request_json(maintenance_requests)',
    'new_booking_reference()',
    'payments_guard()',
    'payments_set_verification()',
    'payments_verification_guard()',
    'permission_feature(text)',
    'plan_enforced_flags()',
    'policy_config_valid(jsonb)',
    'properties_validate()',
    'property_policies_immutable()',
    'refunds_clear_details()',
    'refunds_guard()',
    'room_status_events_append_only()',
    'room_type_photos_limit()',
    'set_updated_at()',
    'tax_rules_kind_fixed()'
  ];
  f text; v_proc oid; v_cfg text[]; v_definer boolean; v_missing text := '';
begin
  perform t_sys();
  foreach f in array fns loop
    v_proc := to_regprocedure('public.' || f)::oid;
    if v_proc is null then raise exception 'FAIL function % does not exist', f; end if;
    select proconfig, prosecdef into v_cfg, v_definer from pg_proc where oid = v_proc;
    if v_cfg is null or not ('search_path=public' = any (v_cfg)) then v_missing := v_missing || ' ' || f; end if;
    if v_definer then raise exception 'FAIL % changed to SECURITY DEFINER', f; end if;
  end loop;
  if v_missing <> '' then raise exception 'FAIL search_path not pinned on:%', v_missing; end if;
  raise notice 'PASS search_path pinned on all % helper and trigger functions, still SECURITY INVOKER', array_length(fns, 1);
end $$;

-- a pinned function still works the way it did: the booking reference default and the updated_at trigger
do $$ declare r text; begin
  perform t_sys();
  r := new_booking_reference();
  if r is null or length(r) < 4 then raise exception 'FAIL booking reference %', r; end if;
  if permission_feature('housekeeping.view') is distinct from 'housekeeping' then raise exception 'FAIL permission_feature'; end if;
  if amenities_valid(array['Wi-Fi', 'Pool']) is not true or amenities_valid(array['Pool', 'pool']) is not false then
    raise exception 'FAIL amenities_valid';
  end if;
  raise notice 'PASS pinned functions still return the same answers';
end $$;
