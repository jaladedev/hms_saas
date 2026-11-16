-- Pin the search_path of 29 helper and trigger functions (migration 135).
-- Supabase's security advisor (lint 0011, "function_search_path_mutable") flags every function that has no fixed search_path: a
-- caller who controls their own search_path could make an unqualified name inside such a function resolve to an object they
-- created. All 29 are SECURITY INVOKER, so the exposure was small, but the fix is free: the same `set search_path = public` that
-- every SECURITY DEFINER function in these migrations already carries. System catalogs (pg_catalog) are always searched first,
-- so built-in functions and operators resolve as before. None of the 29 calls an extension function, which was checked against
-- their bodies on the hms project (pgcrypto and similar live in the `extensions` schema on Supabase).
-- Only the setting changes. Bodies, volatility, owners and grants are untouched, so triggers and CHECK constraints that use
-- these functions keep working, and no row is rewritten.
alter function amenities_valid(text[]) set search_path = public;
alter function audit_logs_append_only() set search_path = public;
alter function folio_charges_guard() set search_path = public;
alter function folio_invoice_lines_guard() set search_path = public;
alter function folio_invoices_guard() set search_path = public;
alter function folio_payments_guard() set search_path = public;
alter function hk_task_json(housekeeping_tasks) set search_path = public;
alter function housekeeping_tasks_guard() set search_path = public;
alter function immutable_money_row() set search_path = public;
alter function invoices_guard() set search_path = public;
alter function is_system_caller() set search_path = public;
alter function maintenance_requests_guard() set search_path = public;
alter function membership_roles_check() set search_path = public;
alter function mt_request_json(maintenance_requests) set search_path = public;
alter function new_booking_reference() set search_path = public;
alter function payments_guard() set search_path = public;
alter function payments_set_verification() set search_path = public;
alter function payments_verification_guard() set search_path = public;
alter function permission_feature(text) set search_path = public;
alter function plan_enforced_flags() set search_path = public;
alter function policy_config_valid(jsonb) set search_path = public;
alter function properties_validate() set search_path = public;
alter function property_policies_immutable() set search_path = public;
alter function refunds_clear_details() set search_path = public;
alter function refunds_guard() set search_path = public;
alter function room_status_events_append_only() set search_path = public;
alter function room_type_photos_limit() set search_path = public;
alter function set_updated_at() set search_path = public;
alter function tax_rules_kind_fixed() set search_path = public;
