-- 191 Overlapping RLS policies on six setup tables, and indexes for the foreign keys the busy tables look up by.
--
-- Found on 2026-11-24 by running Supabase's performance advisor on the hms project (the first run against a real Supabase project).
--
-- 1. Lint 0006 (multiple_permissive_policies), 6 tables: daily_rates, rate_plans, room_type_photos, room_types, rooms, tax_rules.
--    Each had a `<table>_select` policy for SELECT and a `<table>_write` policy FOR ALL, so for a signed-in reader both were evaluated
--    on every row of every read. The write policy is now three (insert, update, delete) so SELECT has exactly one policy.
--    Nothing a person may do changes. FOR ALL also let a person who may write read the rows (a permission such as rate.manage does not
--    have to include rate.view), and an update or delete needs the rows to be visible to it. To keep that, the old write rule is added
--    to the select rule with `or`, so the set of rows a person can read, insert, update and delete is the same as before. Policy
--    names: `<table>_select` keeps its name; `<table>_write` becomes `<table>_insert`, `<table>_update` and `<table>_delete`.
-- 2. Lint 0001 (unindexed_foreign_keys): 169 foreign keys without a covering index. This migration adds indexes for the ones on the
--    tables that grow with use and are read or cascaded through all day: reservation_rooms, reservations, folio_charges,
--    folio_payments, folio_invoices, payments, invoices, refunds, pos_orders, pos_order_lines, housekeeping_tasks,
--    maintenance_requests and service_bookings. Without an index, deleting or re-keying a parent row, and every join that goes from a
--    reservation or room down to its children, scans the child table. An index on (tenant_id, property_id, x_id) also covers the
--    table's own (tenant_id, property_id) foreign key, so the 23 indexes below clear 28 findings (checked by running this file in a rolled-back transaction on the hms project: 28 before, 0 after, and no table left with overlapping permissive policies). Not indexed on purpose: the
--    `created_by`, `voided_by` and other `*_by` columns that point at auth.users (nothing joins or deletes through them), the outbox
--    tables, and the rest of the long tail; add them when a query plan asks for it. 93 unused-index findings are left alone: this
--    database has had almost no traffic, so "never used" says nothing yet.
--    Plain CREATE INDEX (a concurrent build cannot run in a migration's transaction). These tables are small now; build large ones
--    out of band with CREATE INDEX CONCURRENTLY before applying this file on a database that already holds data.

drop policy daily_rates_select on daily_rates;
drop policy daily_rates_write on daily_rates;
create policy daily_rates_select on daily_rates for select to authenticated
  using ((has_permission(property_id, 'rate.view') or has_permission(property_id, 'reservation.view')) or has_permission(property_id, 'rate.manage'));
create policy daily_rates_insert on daily_rates for insert to authenticated
  with check (has_permission(property_id, 'rate.manage'));
create policy daily_rates_update on daily_rates for update to authenticated
  using (has_permission(property_id, 'rate.manage')) with check (has_permission(property_id, 'rate.manage'));
create policy daily_rates_delete on daily_rates for delete to authenticated
  using (has_permission(property_id, 'rate.manage'));

drop policy rate_plans_select on rate_plans;
drop policy rate_plans_write on rate_plans;
create policy rate_plans_select on rate_plans for select to authenticated
  using ((has_permission(property_id, 'rate.view') or has_permission(property_id, 'reservation.view') or has_permission(property_id, 'property.configure')) or has_permission(property_id, 'rate.manage'));
create policy rate_plans_insert on rate_plans for insert to authenticated
  with check (has_permission(property_id, 'rate.manage'));
create policy rate_plans_update on rate_plans for update to authenticated
  using (has_permission(property_id, 'rate.manage')) with check (has_permission(property_id, 'rate.manage'));
create policy rate_plans_delete on rate_plans for delete to authenticated
  using (has_permission(property_id, 'rate.manage'));

drop policy room_type_photos_select on room_type_photos;
drop policy room_type_photos_write on room_type_photos;
create policy room_type_photos_select on room_type_photos for select to authenticated
  using ((has_permission(property_id, 'reservation.view') or has_permission(property_id, 'rate.view') or has_permission(property_id, 'property.configure')) or has_permission(property_id, 'property.configure'));
create policy room_type_photos_insert on room_type_photos for insert to authenticated
  with check (has_permission(property_id, 'property.configure'));
create policy room_type_photos_update on room_type_photos for update to authenticated
  using (has_permission(property_id, 'property.configure')) with check (has_permission(property_id, 'property.configure'));
create policy room_type_photos_delete on room_type_photos for delete to authenticated
  using (has_permission(property_id, 'property.configure'));

drop policy room_types_select on room_types;
drop policy room_types_write on room_types;
create policy room_types_select on room_types for select to authenticated
  using ((has_permission(property_id, 'reservation.view') or has_permission(property_id, 'rate.view') or has_permission(property_id, 'property.configure')) or has_permission(property_id, 'property.configure'));
create policy room_types_insert on room_types for insert to authenticated
  with check (has_permission(property_id, 'property.configure'));
create policy room_types_update on room_types for update to authenticated
  using (has_permission(property_id, 'property.configure')) with check (has_permission(property_id, 'property.configure'));
create policy room_types_delete on room_types for delete to authenticated
  using (has_permission(property_id, 'property.configure'));

drop policy rooms_select on rooms;
drop policy rooms_write on rooms;
create policy rooms_select on rooms for select to authenticated
  using (has_permission(property_id, 'room.view') or has_permission(property_id, 'property.configure'));
create policy rooms_insert on rooms for insert to authenticated
  with check (has_permission(property_id, 'property.configure'));
create policy rooms_update on rooms for update to authenticated
  using (has_permission(property_id, 'property.configure')) with check (has_permission(property_id, 'property.configure'));
create policy rooms_delete on rooms for delete to authenticated
  using (has_permission(property_id, 'property.configure'));

drop policy tax_rules_select on tax_rules;
drop policy tax_rules_write on tax_rules;
create policy tax_rules_select on tax_rules for select to authenticated
  using ((has_permission(property_id, 'rate.view') or has_permission(property_id, 'reservation.view') or has_permission(property_id, 'property.configure')) or has_permission(property_id, 'property.configure'));
create policy tax_rules_insert on tax_rules for insert to authenticated
  with check (has_permission(property_id, 'property.configure'));
create policy tax_rules_update on tax_rules for update to authenticated
  using (has_permission(property_id, 'property.configure')) with check (has_permission(property_id, 'property.configure'));
create policy tax_rules_delete on tax_rules for delete to authenticated
  using (has_permission(property_id, 'property.configure'));


create index if not exists folio_charges_fk_reservation_idx on folio_charges (tenant_id, property_id, reservation_id);
create index if not exists folio_charges_fk_reservation_room_idx on folio_charges (reservation_room_id);
create index if not exists folio_invoices_fk_reservation_idx on folio_invoices (tenant_id, property_id, reservation_id);
create index if not exists folio_payments_fk_reservation_idx on folio_payments (tenant_id, property_id, reservation_id);
create index if not exists housekeeping_tasks_fk_room_idx on housekeeping_tasks (tenant_id, property_id, room_id);
create index if not exists invoices_fk_reservation_idx on invoices (tenant_id, property_id, reservation_id);
create index if not exists maintenance_requests_fk_room_idx on maintenance_requests (tenant_id, property_id, room_id);
create index if not exists payments_fk_reservation_idx on payments (tenant_id, property_id, reservation_id);
create index if not exists payments_fk_attempt_idx on payments (attempt_id);
create index if not exists pos_order_lines_fk_order_idx on pos_order_lines (tenant_id, property_id, order_id);
create index if not exists pos_order_lines_fk_item_idx on pos_order_lines (tenant_id, property_id, item_id);
create index if not exists pos_orders_fk_folio_charge_idx on pos_orders (folio_charge_id);
create index if not exists pos_orders_fk_place_idx on pos_orders (tenant_id, property_id, place_id);
create index if not exists pos_orders_fk_reservation_idx on pos_orders (tenant_id, property_id, reservation_id);
create index if not exists refunds_fk_payment_idx on refunds (tenant_id, payment_id);
create index if not exists refunds_fk_reservation_idx on refunds (tenant_id, property_id, reservation_id);
create index if not exists reservation_rooms_fk_rate_plan_idx on reservation_rooms (tenant_id, property_id, rate_plan_id);
create index if not exists reservation_rooms_fk_requested_room_idx on reservation_rooms (tenant_id, property_id, requested_room_id);
create index if not exists reservation_rooms_fk_reservation_idx on reservation_rooms (tenant_id, property_id, reservation_id);
create index if not exists reservation_rooms_fk_room_type_idx on reservation_rooms (tenant_id, property_id, room_type_id);
create index if not exists reservations_fk_primary_guest_idx on reservations (tenant_id, primary_guest_id);
create index if not exists service_bookings_fk_reservation_idx on service_bookings (tenant_id, property_id, reservation_id);
create index if not exists service_bookings_fk_service_idx on service_bookings (tenant_id, property_id, service_id);
