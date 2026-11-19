-- 148 Restaurant, bar and point of sale, first cut (TODO 8.2).
--
-- A menu (categories and items), places an order belongs to (a table, the bar, room service), orders with lines, a kitchen status per
-- line, and one bill per order that is settled one of two ways:
--   pos_pay_order       paid at the table: one payment (cash, pos, bank_transfer, other) for the whole bill. Kept in pos_payments.
--   pos_post_to_room    posted to a checked-in guest's folio through post_folio_charge (027), so the tax rules marked for extras apply
--                       and the guest's own invoice, payments and refunds are untouched. It needs folio.charge as well as pos.sell,
--                       because post_folio_charge checks it for the signed-in person (the same rule as experiences, 134).
-- Tax. A bill's tax is calc_charge_tax (027) on the sum of its lines, the same function the folio uses, so a bill costs the same whichever
-- way it is settled. It is worked out when the bill is settled and frozen on the order; a rule changed later never alters a settled bill.
-- Money is bigint kobo. A line copies the item's name and price when it is added; a later menu change never alters an order.
-- Order status: open -> paid | posted, or open -> void. A paid or posted order is final: this cut has no refund of a table payment and no
-- reopening (a room-posted bill is corrected by voiding its folio charge, void_folio_charge, as for any extra). Menu rows are never deleted,
-- only switched off, so an old order can always name its items.
-- Kitchen status is per line: new -> preparing -> ready -> served. A line can be cancelled while its order is open and it has not been
-- served; a cancelled line is left out of the bill. Status can keep moving after the bill is paid (the table pays, the food is still coming).
--
-- Permissions (new): pos.view (read), pos.sell (open orders, add lines, kitchen status, settle, void an untouched order),
-- pos.manage (menu and places, and voiding an order whose food has been started). A hotel can give a waiter or kitchen role pos.sell
-- through a custom role. The report needs pos.view and report.view. Writes go through the functions only.
-- Flag: restaurant_pos (enforced, on the Pro plan; no row = on). With it off, the menu, orders and report can still be read; nothing is written.
--
-- Money rule kept (test 48): daily_report is untouched. A room-posted bill is an extra on the folio, so daily_report already counts it as
-- extras. A bill paid at the table is NOT in daily_report; pos_sales_report is the place for it. Test 148 pins both.

-- ---- permissions and flag --------------------------------------------------------------------
insert into permissions (key) values ('pos.view'), ('pos.sell'), ('pos.manage');
insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r, permissions p
 where p.key = 'pos.view' and r.is_system and r.key in ('owner', 'general_manager', 'front_desk', 'accountant');
insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r, permissions p
 where p.key = 'pos.sell' and r.is_system and r.key in ('owner', 'general_manager', 'front_desk');
insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r, permissions p
 where p.key = 'pos.manage' and r.is_system and r.key in ('owner', 'general_manager');

create or replace function plan_enforced_flags() returns text[]
language sql immutable set search_path = public as $$
  select array['reports.export', 'online_payments', 'discounts', 'online_booking', 'guest_cancel', 'guest_changes', 'early_checkin',
               'housekeeping', 'maintenance', 'audit_log', 'branding', 'dynamic_pricing', 'sms_notifications', 'restaurant_pos']
$$;
revoke all on function plan_enforced_flags() from public, anon;
update plans set features = (select array_agg(distinct k order by k) from unnest(features || array['restaurant_pos']) k) where code = 'pro';

-- ---- menu and places -------------------------------------------------------------------------
create table pos_categories (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  property_id uuid not null,
  name        text not null check (char_length(name) between 1 and 60),
  sort_order  smallint not null default 0 check (sort_order between 0 and 1000),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  foreign key (tenant_id, property_id) references properties (tenant_id, id),
  unique (tenant_id, property_id, id)
);
create unique index pos_categories_name_idx on pos_categories (property_id, lower(name));

create table pos_items (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  property_id uuid not null,
  category_id uuid not null,
  name        text not null check (char_length(name) between 1 and 80),
  price_minor bigint not null check (price_minor between 1 and 1000000000),
  sort_order  smallint not null default 0 check (sort_order between 0 and 1000),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  foreign key (tenant_id, property_id, category_id) references pos_categories (tenant_id, property_id, id),
  unique (tenant_id, property_id, id)
);
create unique index pos_items_name_idx on pos_items (category_id, lower(name));

create table pos_places (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  property_id uuid not null,
  name        text not null check (char_length(name) between 1 and 40),
  kind        text not null check (kind in ('table', 'bar', 'room_service')),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  foreign key (tenant_id, property_id) references properties (tenant_id, id),
  unique (tenant_id, property_id, id)
);
create unique index pos_places_name_idx on pos_places (property_id, lower(name));

-- ---- orders ----------------------------------------------------------------------------------
create sequence pos_order_no_seq;

create table pos_orders (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null,
  property_id     uuid not null,
  order_no        text not null unique,
  place_id        uuid not null,
  guest_label     text check (guest_label is null or char_length(guest_label) between 1 and 60),
  status          text not null default 'open' check (status in ('open', 'paid', 'posted', 'void')),
  currency        char(3) not null,
  subtotal_minor  bigint check (subtotal_minor is null or subtotal_minor >= 0),
  tax_minor       bigint check (tax_minor is null or tax_minor >= 0),
  total_minor     bigint check (total_minor is null or total_minor >= 0),
  reservation_id  uuid,
  folio_charge_id uuid,
  void_reason     text check (void_reason is null or char_length(void_reason) between 1 and 200),
  opened_by       uuid references auth.users (id) on delete set null,
  opened_at       timestamptz not null default now(),
  closed_by       uuid references auth.users (id) on delete set null,
  closed_at       timestamptz,
  updated_at      timestamptz not null default now(),
  foreign key (tenant_id, property_id) references properties (tenant_id, id),
  foreign key (tenant_id, property_id, place_id) references pos_places (tenant_id, property_id, id),
  foreign key (tenant_id, property_id, reservation_id) references reservations (tenant_id, property_id, id),
  foreign key (folio_charge_id) references folio_charges (id),
  unique (tenant_id, property_id, id),
  check ((status = 'open') = (closed_at is null)),
  check (status in ('open', 'void') or total_minor is not null),
  check ((status = 'posted') = (reservation_id is not null and folio_charge_id is not null)),
  check ((status = 'void') = (void_reason is not null))
);
create index pos_orders_open_idx on pos_orders (property_id, opened_at) where status = 'open';
create index pos_orders_closed_idx on pos_orders (property_id, closed_at) where status in ('paid', 'posted');

create table pos_order_lines (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null,
  property_id     uuid not null,
  order_id        uuid not null,
  item_id         uuid not null,
  name_at_order   text not null,
  unit_price_minor bigint not null check (unit_price_minor between 1 and 1000000000),
  quantity        integer not null check (quantity between 1 and 100),
  note            text check (note is null or char_length(note) <= 100),
  kitchen_status  text not null default 'new' check (kitchen_status in ('new', 'preparing', 'ready', 'served', 'cancelled')),
  created_by      uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default clock_timestamp(),   -- not now(): lines added in one transaction must keep their order (see 123)
  updated_at      timestamptz not null default now(),
  foreign key (tenant_id, property_id, order_id) references pos_orders (tenant_id, property_id, id),
  foreign key (tenant_id, property_id, item_id) references pos_items (tenant_id, property_id, id)
);
create index pos_order_lines_order_idx on pos_order_lines (order_id);
create index pos_order_lines_kitchen_idx on pos_order_lines (property_id, created_at) where kitchen_status in ('new', 'preparing', 'ready');

-- The one payment a bill paid at the table has. Never edited or deleted.
create table pos_payments (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null,
  property_id    uuid not null,
  order_id       uuid not null unique,
  method         text not null check (method in ('cash', 'pos', 'bank_transfer', 'other')),
  reference      text check (reference is null or char_length(reference) <= 100),
  amount_minor   bigint not null check (amount_minor > 0),
  currency       char(3) not null,
  received_by    uuid references auth.users (id) on delete set null,
  received_at    timestamptz not null default now(),
  foreign key (tenant_id, property_id, order_id) references pos_orders (tenant_id, property_id, id)
);

-- A settled order and its lines are frozen. Only a deleted login may be cleared from the people columns (on delete set null).
create function pos_guard_orders() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'POS orders are never deleted' using errcode = 'P0001'; end if;
  if old.status <> 'open' and (to_jsonb(new) - 'opened_by' - 'closed_by' - 'updated_at') is distinct from (to_jsonb(old) - 'opened_by' - 'closed_by' - 'updated_at') then
    raise exception 'POS order is final' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger pos_orders_guard before update or delete on pos_orders for each row execute function pos_guard_orders();

create function pos_guard_lines() returns trigger language plpgsql as $$
declare v_status text;
begin
  if tg_op = 'DELETE' then raise exception 'POS lines are never deleted' using errcode = 'P0001'; end if;
  select status into v_status from pos_orders where id = old.order_id;
  -- after the bill is settled only the kitchen status may still move (and never to cancelled)
  if v_status <> 'open' and ((to_jsonb(new) - 'kitchen_status' - 'created_by' - 'updated_at') is distinct from (to_jsonb(old) - 'kitchen_status' - 'created_by' - 'updated_at')
                             or new.kitchen_status = 'cancelled' and old.kitchen_status <> 'cancelled') then
    raise exception 'POS order is final' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger pos_order_lines_guard before update or delete on pos_order_lines for each row execute function pos_guard_lines();

create function pos_guard_payments() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' or (to_jsonb(new) - 'received_by') is distinct from (to_jsonb(old) - 'received_by') then
    raise exception 'POS payments are never edited or deleted' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger pos_payments_guard before update or delete on pos_payments for each row execute function pos_guard_payments();

create trigger pos_categories_updated before update on pos_categories for each row execute function set_updated_at();
create trigger pos_items_updated before update on pos_items for each row execute function set_updated_at();
create trigger pos_places_updated before update on pos_places for each row execute function set_updated_at();
create trigger pos_orders_updated before update on pos_orders for each row execute function set_updated_at();
create trigger pos_order_lines_updated before update on pos_order_lines for each row execute function set_updated_at();

-- ---- row level security: read with a pos permission, write only through the functions --------
alter table pos_categories enable row level security;
alter table pos_items enable row level security;
alter table pos_places enable row level security;
alter table pos_orders enable row level security;
alter table pos_order_lines enable row level security;
alter table pos_payments enable row level security;

create function pos_can_read(p_property uuid) returns boolean language sql stable security definer set search_path = public as $$
  select has_permission(p_property, 'pos.view') or has_permission(p_property, 'pos.sell') or has_permission(p_property, 'pos.manage')
$$;
revoke all on function pos_can_read(uuid) from public, anon;
grant execute on function pos_can_read(uuid) to authenticated;

create policy pos_categories_select on pos_categories for select to authenticated using (pos_can_read(property_id));
create policy pos_items_select on pos_items for select to authenticated using (pos_can_read(property_id));
create policy pos_places_select on pos_places for select to authenticated using (pos_can_read(property_id));
create policy pos_orders_select on pos_orders for select to authenticated using (pos_can_read(property_id));
create policy pos_order_lines_select on pos_order_lines for select to authenticated using (pos_can_read(property_id));
-- what was taken at the table is money: the cashier's own permission is not enough to read the ledger
create policy pos_payments_select on pos_payments for select to authenticated using (pos_can_read(property_id) and can_view_money(property_id));

revoke all on pos_categories, pos_items, pos_places, pos_orders, pos_order_lines, pos_payments from anon, authenticated;
grant select on pos_categories, pos_items, pos_places, pos_orders, pos_order_lines, pos_payments to authenticated;

-- ---- internal helpers --------------------------------------------------------------------------
-- The permission and flag check every writing function starts with. Returns the signed-in person; a service caller or no permission is NOT_FOUND.
create function pos_require(p_property uuid, p_permission text) returns uuid
language plpgsql stable security definer set search_path = public as $$
declare v_prop properties%rowtype; v_actor uuid;
begin
  select * into v_prop from properties where id = p_property;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(p_property, p_permission, 'NOT_FOUND');
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if not tenant_feature_on(v_prop.tenant_id, 'restaurant_pos') then raise exception 'POLICY_VIOLATION: restaurant pos off' using errcode = 'P0001'; end if;
  return v_actor;
end $$;
revoke all on function pos_require(uuid, text) from public, anon, authenticated;

create function pos_live_subtotal(p_order uuid) returns bigint language sql stable security definer set search_path = public as $$
  select coalesce(sum(unit_price_minor * quantity), 0)::bigint from pos_order_lines where order_id = p_order and kitchen_status <> 'cancelled'
$$;
revoke all on function pos_live_subtotal(uuid) from public, anon, authenticated;

-- ---- setup (pos.manage) ------------------------------------------------------------------------
create function pos_save_category(p_property uuid, p_category uuid, p_name text, p_sort integer, p_active boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_actor uuid; v_prop properties%rowtype; v_name text := btrim(coalesce(p_name, '')); v_id uuid; v_sort integer := coalesce(p_sort, 0);
begin
  v_actor := pos_require(p_property, 'pos.manage');
  select * into v_prop from properties where id = p_property;
  if char_length(v_name) not between 1 and 60 then raise exception 'POLICY_VIOLATION: name' using errcode = 'P0001'; end if;
  if v_sort not between 0 and 1000 then raise exception 'POLICY_VIOLATION: sort' using errcode = 'P0001'; end if;
  if exists (select 1 from pos_categories where property_id = p_property and lower(name) = lower(v_name) and id is distinct from p_category) then
    raise exception 'POLICY_VIOLATION: name taken' using errcode = 'P0001';
  end if;
  if p_category is null then
    if (select count(*) from pos_categories where property_id = p_property) >= 40 then raise exception 'POLICY_VIOLATION: limit' using errcode = 'P0001'; end if;
    insert into pos_categories (tenant_id, property_id, name, sort_order, is_active) values (v_prop.tenant_id, p_property, v_name, v_sort, coalesce(p_active, true)) returning id into v_id;
  else
    update pos_categories set name = v_name, sort_order = v_sort, is_active = coalesce(p_active, true) where id = p_category and property_id = p_property returning id into v_id;
    if v_id is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  end if;
  perform write_audit(v_prop.tenant_id, p_property, v_actor, 'pos_category.saved', 'pos_category', v_id, null,
                      jsonb_build_object('name', v_name, 'active', coalesce(p_active, true), 'created', p_category is null));
  return jsonb_build_object('category_id', v_id);
end $$;

create function pos_save_item(p_property uuid, p_item uuid, p_category uuid, p_name text, p_price bigint, p_sort integer, p_active boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_actor uuid; v_prop properties%rowtype; v_name text := btrim(coalesce(p_name, '')); v_id uuid; v_sort integer := coalesce(p_sort, 0); v_old bigint;
begin
  v_actor := pos_require(p_property, 'pos.manage');
  select * into v_prop from properties where id = p_property;
  if char_length(v_name) not between 1 and 80 then raise exception 'POLICY_VIOLATION: name' using errcode = 'P0001'; end if;
  if p_price is null or p_price not between 1 and 1000000000 then raise exception 'POLICY_VIOLATION: price' using errcode = 'P0001'; end if;
  if v_sort not between 0 and 1000 then raise exception 'POLICY_VIOLATION: sort' using errcode = 'P0001'; end if;
  if not exists (select 1 from pos_categories where id = p_category and property_id = p_property) then raise exception 'POLICY_VIOLATION: category' using errcode = 'P0001'; end if;
  if exists (select 1 from pos_items where category_id = p_category and lower(name) = lower(v_name) and id is distinct from p_item) then
    raise exception 'POLICY_VIOLATION: name taken' using errcode = 'P0001';
  end if;
  if p_item is null then
    if (select count(*) from pos_items where property_id = p_property) >= 400 then raise exception 'POLICY_VIOLATION: limit' using errcode = 'P0001'; end if;
    insert into pos_items (tenant_id, property_id, category_id, name, price_minor, sort_order, is_active)
    values (v_prop.tenant_id, p_property, p_category, v_name, p_price, v_sort, coalesce(p_active, true)) returning id into v_id;
  else
    select price_minor into v_old from pos_items where id = p_item and property_id = p_property;
    if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
    update pos_items set category_id = p_category, name = v_name, price_minor = p_price, sort_order = v_sort, is_active = coalesce(p_active, true) where id = p_item returning id into v_id;
  end if;
  perform write_audit(v_prop.tenant_id, p_property, v_actor, 'pos_item.saved', 'pos_item', v_id, null,
                      jsonb_build_object('name', v_name, 'price_minor', p_price, 'previous_price_minor', v_old, 'active', coalesce(p_active, true), 'created', p_item is null));
  return jsonb_build_object('item_id', v_id);
end $$;

create function pos_save_place(p_property uuid, p_place uuid, p_name text, p_kind text, p_active boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_actor uuid; v_prop properties%rowtype; v_name text := btrim(coalesce(p_name, '')); v_id uuid;
begin
  v_actor := pos_require(p_property, 'pos.manage');
  select * into v_prop from properties where id = p_property;
  if char_length(v_name) not between 1 and 40 then raise exception 'POLICY_VIOLATION: name' using errcode = 'P0001'; end if;
  if p_kind is null or p_kind not in ('table', 'bar', 'room_service') then raise exception 'POLICY_VIOLATION: kind' using errcode = 'P0001'; end if;
  if exists (select 1 from pos_places where property_id = p_property and lower(name) = lower(v_name) and id is distinct from p_place) then
    raise exception 'POLICY_VIOLATION: name taken' using errcode = 'P0001';
  end if;
  if p_place is null then
    if (select count(*) from pos_places where property_id = p_property) >= 100 then raise exception 'POLICY_VIOLATION: limit' using errcode = 'P0001'; end if;
    insert into pos_places (tenant_id, property_id, name, kind, is_active) values (v_prop.tenant_id, p_property, v_name, p_kind, coalesce(p_active, true)) returning id into v_id;
  else
    update pos_places set name = v_name, kind = p_kind, is_active = coalesce(p_active, true) where id = p_place and property_id = p_property returning id into v_id;
    if v_id is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  end if;
  perform write_audit(v_prop.tenant_id, p_property, v_actor, 'pos_place.saved', 'pos_place', v_id, null,
                      jsonb_build_object('name', v_name, 'kind', p_kind, 'active', coalesce(p_active, true), 'created', p_place is null));
  return jsonb_build_object('place_id', v_id);
end $$;

-- ---- orders (pos.sell) -------------------------------------------------------------------------
create function pos_open_order(p_property uuid, p_place uuid, p_guest_label text, p_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid; v_prop properties%rowtype; v_idem record; v_hash text; v_label text := nullif(btrim(coalesce(p_guest_label, '')), '');
  v_place pos_places%rowtype; v_id uuid := gen_random_uuid(); v_no text; v_result jsonb;
begin
  v_actor := pos_require(p_property, 'pos.sell');
  select * into v_prop from properties where id = p_property;
  select * into v_place from pos_places where id = p_place and property_id = p_property;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if not v_place.is_active then raise exception 'POLICY_VIOLATION: place off' using errcode = 'P0001'; end if;
  if v_label is not null and char_length(v_label) > 60 then raise exception 'POLICY_VIOLATION: label' using errcode = 'P0001'; end if;
  if (select count(*) from pos_orders where property_id = p_property and status = 'open') >= 200 then raise exception 'POLICY_VIOLATION: too many open orders' using errcode = 'P0001'; end if;

  v_hash := md5(concat_ws('|', p_property, p_place, v_label));
  select * into v_idem from idem_begin(v_prop.tenant_id, 'pos_open_order', p_key, v_hash);
  if not v_idem.out_is_new then return v_idem.out_response; end if;

  v_no := 'POS-' || lpad(nextval('pos_order_no_seq')::text, 6, '0');
  insert into pos_orders (id, tenant_id, property_id, order_no, place_id, guest_label, currency, opened_by)
  values (v_id, v_prop.tenant_id, p_property, v_no, p_place, v_label, v_prop.currency, v_actor);
  v_result := jsonb_build_object('order_id', v_id, 'order_no', v_no);
  perform idem_finish(v_prop.tenant_id, 'pos_open_order', p_key, v_result);
  perform write_audit(v_prop.tenant_id, p_property, v_actor, 'pos_order.opened', 'pos_order', v_id, p_key, jsonb_build_object('order_no', v_no, 'place', v_place.name));
  return v_result;
end $$;

create function pos_add_line(p_order uuid, p_item uuid, p_quantity integer, p_note text, p_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  o pos_orders%rowtype; v_actor uuid; v_idem record; v_hash text; v_item pos_items%rowtype; v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_id uuid := gen_random_uuid(); v_result jsonb; v_sub bigint;
begin
  select * into o from pos_orders where id = p_order;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := pos_require(o.property_id, 'pos.sell');
  if p_quantity is null or p_quantity not between 1 and 100 then raise exception 'POLICY_VIOLATION: quantity' using errcode = 'P0001'; end if;
  if v_note is not null and char_length(v_note) > 100 then raise exception 'POLICY_VIOLATION: note' using errcode = 'P0001'; end if;
  select * into v_item from pos_items where id = p_item and property_id = o.property_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if not v_item.is_active then raise exception 'POLICY_VIOLATION: item off' using errcode = 'P0001'; end if;

  v_hash := md5(concat_ws('|', p_order, p_item, p_quantity, v_note));
  select * into v_idem from idem_begin(o.tenant_id, 'pos_add_line', p_key, v_hash);
  if not v_idem.out_is_new then return v_idem.out_response; end if;

  select * into o from pos_orders where id = p_order for update;
  if o.status <> 'open' then raise exception 'INVALID_STATE: %', o.status using errcode = 'P0001'; end if;
  v_sub := pos_live_subtotal(o.id) + v_item.price_minor * p_quantity;
  if v_sub > 1000000000 then raise exception 'POLICY_VIOLATION: order too large' using errcode = 'P0001'; end if;
  if (select count(*) from pos_order_lines where order_id = o.id) >= 100 then raise exception 'POLICY_VIOLATION: too many lines' using errcode = 'P0001'; end if;

  insert into pos_order_lines (id, tenant_id, property_id, order_id, item_id, name_at_order, unit_price_minor, quantity, note, created_by)
  values (v_id, o.tenant_id, o.property_id, o.id, v_item.id, v_item.name, v_item.price_minor, p_quantity, v_note, v_actor);
  v_result := jsonb_build_object('line_id', v_id, 'subtotal_minor', v_sub);
  perform idem_finish(o.tenant_id, 'pos_add_line', p_key, v_result);
  perform write_audit(o.tenant_id, o.property_id, v_actor, 'pos_order.line_added', 'pos_order', o.id, p_key,
                      jsonb_build_object('line_id', v_id, 'item', v_item.name, 'quantity', p_quantity, 'unit_price_minor', v_item.price_minor));
  return v_result;
end $$;

-- new -> preparing -> ready -> served, one step at a time (a repeat of the current status is a no-op), or cancelled from new or preparing
-- while the order is open. A cancelled line cannot come back.
create function pos_set_line_status(p_line uuid, p_status text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare l pos_order_lines%rowtype; o pos_orders%rowtype; v_actor uuid; v_ok boolean;
begin
  select * into l from pos_order_lines where id = p_line;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := pos_require(l.property_id, 'pos.sell');
  if p_status is null or p_status not in ('preparing', 'ready', 'served', 'cancelled', 'new') then raise exception 'POLICY_VIOLATION: status' using errcode = 'P0001'; end if;
  select * into o from pos_orders where id = l.order_id for update;
  select * into l from pos_order_lines where id = p_line for update;
  if l.kitchen_status = p_status then return jsonb_build_object('line_id', l.id, 'kitchen_status', l.kitchen_status); end if;
  if o.status = 'void' then raise exception 'INVALID_STATE: void' using errcode = 'P0001'; end if;
  v_ok := (l.kitchen_status = 'new' and p_status = 'preparing') or (l.kitchen_status = 'preparing' and p_status = 'ready')
          or (l.kitchen_status = 'ready' and p_status = 'served')
          or (p_status = 'cancelled' and l.kitchen_status in ('new', 'preparing') and o.status = 'open');
  if not v_ok then raise exception 'INVALID_STATE: % to %', l.kitchen_status, p_status using errcode = 'P0001'; end if;
  update pos_order_lines set kitchen_status = p_status where id = l.id;
  perform write_audit(l.tenant_id, l.property_id, v_actor, 'pos_order.line_' || p_status, 'pos_order', l.order_id, null,
                      jsonb_build_object('line_id', l.id, 'item', l.name_at_order, 'from', l.kitchen_status));
  return jsonb_build_object('line_id', l.id, 'kitchen_status', p_status);
end $$;

-- An order nobody has started cooking for can be voided by pos.sell; once any line is preparing, ready or served it needs pos.manage.
-- Only an open order can be voided. A repeat is a no-op.
create function pos_void_order(p_order uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o pos_orders%rowtype; v_actor uuid; v_reason text := nullif(btrim(coalesce(p_reason, '')), ''); v_started boolean;
begin
  select * into o from pos_orders where id = p_order;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := pos_require(o.property_id, 'pos.sell');
  if v_reason is null or char_length(v_reason) > 200 then raise exception 'POLICY_VIOLATION: reason' using errcode = 'P0001'; end if;
  select * into o from pos_orders where id = p_order for update;
  if o.status = 'void' then return jsonb_build_object('order_id', o.id, 'status', 'void'); end if;
  if o.status <> 'open' then raise exception 'INVALID_STATE: %', o.status using errcode = 'P0001'; end if;
  select exists (select 1 from pos_order_lines where order_id = o.id and kitchen_status in ('preparing', 'ready', 'served')) into v_started;
  if v_started then v_actor := pos_require(o.property_id, 'pos.manage'); end if;
  update pos_orders set status = 'void', void_reason = v_reason, closed_at = now(), closed_by = v_actor, subtotal_minor = 0, tax_minor = 0, total_minor = 0 where id = o.id;
  perform write_audit(o.tenant_id, o.property_id, v_actor, 'pos_order.voided', 'pos_order', o.id, null, jsonb_build_object('order_no', o.order_no, 'reason', v_reason, 'food_started', v_started));
  return jsonb_build_object('order_id', o.id, 'status', 'void');
end $$;

-- Paid at the table: one payment for the whole bill. The tax is worked out here and frozen on the order.
create function pos_pay_order(p_order uuid, p_method text, p_reference text, p_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  o pos_orders%rowtype; v_actor uuid; v_idem record; v_hash text; v_ref text := nullif(btrim(coalesce(p_reference, '')), '');
  v_sub bigint; v_tax bigint; v_total bigint; v_result jsonb;
begin
  select * into o from pos_orders where id = p_order;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := pos_require(o.property_id, 'pos.sell');
  if p_method is null or p_method not in ('cash', 'pos', 'bank_transfer', 'other') then raise exception 'POLICY_VIOLATION: payment method' using errcode = 'P0001'; end if;
  if v_ref is not null and char_length(v_ref) > 100 then raise exception 'POLICY_VIOLATION: reference' using errcode = 'P0001'; end if;

  v_hash := md5(concat_ws('|', p_order, p_method, v_ref));
  select * into v_idem from idem_begin(o.tenant_id, 'pos_pay_order', p_key, v_hash);
  if not v_idem.out_is_new then return v_idem.out_response; end if;

  select * into o from pos_orders where id = p_order for update;
  if o.status <> 'open' then raise exception 'INVALID_STATE: %', o.status using errcode = 'P0001'; end if;
  v_sub := pos_live_subtotal(o.id);
  if v_sub <= 0 then raise exception 'POLICY_VIOLATION: nothing to pay' using errcode = 'P0001'; end if;
  v_tax := calc_charge_tax(o.property_id, property_today(o.property_id), v_sub);
  v_total := v_sub + v_tax;

  insert into pos_payments (tenant_id, property_id, order_id, method, reference, amount_minor, currency, received_by)
  values (o.tenant_id, o.property_id, o.id, p_method, v_ref, v_total, o.currency, v_actor);
  update pos_orders set status = 'paid', subtotal_minor = v_sub, tax_minor = v_tax, total_minor = v_total, closed_at = now(), closed_by = v_actor where id = o.id;

  v_result := jsonb_build_object('order_id', o.id, 'status', 'paid', 'subtotal_minor', v_sub, 'tax_minor', v_tax, 'total_minor', v_total);
  perform idem_finish(o.tenant_id, 'pos_pay_order', p_key, v_result);
  perform write_audit(o.tenant_id, o.property_id, v_actor, 'pos_order.paid', 'pos_order', o.id, p_key,
                      jsonb_build_object('order_no', o.order_no, 'method', p_method, 'subtotal_minor', v_sub, 'tax_minor', v_tax, 'total_minor', v_total));
  return v_result;
end $$;

-- Posted to a checked-in guest's folio as one charge (category food_beverage). Needs folio.charge as well as pos.sell. The tax comes back
-- from post_folio_charge, so it is whatever the folio would charge for the same amount.
create function pos_post_to_room(p_order uuid, p_reservation uuid, p_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  o pos_orders%rowtype; r reservations%rowtype; v_actor uuid; v_idem record; v_hash text; v_sub bigint; v_place text; v_post jsonb; v_result jsonb;
begin
  select * into o from pos_orders where id = p_order;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := pos_require(o.property_id, 'pos.sell');
  if not has_permission(o.property_id, 'folio.charge') then raise exception 'FORBIDDEN: folio.charge' using errcode = 'P0001'; end if;
  select * into r from reservations where id = p_reservation and property_id = o.property_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;

  v_hash := md5(concat_ws('|', p_order, p_reservation));
  select * into v_idem from idem_begin(o.tenant_id, 'pos_post_to_room', p_key, v_hash);
  if not v_idem.out_is_new then return v_idem.out_response; end if;

  select * into o from pos_orders where id = p_order for update;
  if o.status <> 'open' then raise exception 'INVALID_STATE: %', o.status using errcode = 'P0001'; end if;
  if r.reservation_status <> 'checked_in' then raise exception 'INVALID_STATE: guest not in house' using errcode = 'P0001'; end if;
  v_sub := pos_live_subtotal(o.id);
  if v_sub <= 0 then raise exception 'POLICY_VIOLATION: nothing to post' using errcode = 'P0001'; end if;
  select name into v_place from pos_places where id = o.place_id;

  v_post := post_folio_charge(r.id, 'food_beverage', left('Restaurant ' || o.order_no || ' (' || v_place || ')', 200), 1, v_sub, 'pos:' || o.id::text);
  update pos_orders set status = 'posted', subtotal_minor = v_sub, tax_minor = (v_post ->> 'tax_minor')::bigint, total_minor = (v_post ->> 'total_minor')::bigint,
         reservation_id = r.id, folio_charge_id = (v_post ->> 'charge_id')::uuid, closed_at = now(), closed_by = v_actor where id = o.id;

  v_result := jsonb_build_object('order_id', o.id, 'status', 'posted', 'subtotal_minor', v_sub, 'tax_minor', (v_post ->> 'tax_minor')::bigint,
                                 'total_minor', (v_post ->> 'total_minor')::bigint, 'balance_minor', (v_post ->> 'balance_minor')::bigint);
  perform idem_finish(o.tenant_id, 'pos_post_to_room', p_key, v_result);
  perform write_audit(o.tenant_id, o.property_id, v_actor, 'pos_order.posted_to_room', 'pos_order', o.id, p_key,
                      jsonb_build_object('order_no', o.order_no, 'reservation_id', r.id, 'charge_id', v_post ->> 'charge_id', 'total_minor', (v_post ->> 'total_minor')::bigint));
  return v_result;
end $$;

-- ---- reads (pos.view, pos.sell or pos.manage; readable with the flag off) --------------------------
create function pos_menu(p_property uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not pos_can_read(p_property) then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  return jsonb_build_object(
    'categories', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'sort_order', c.sort_order, 'is_active', c.is_active) order by c.sort_order, c.name)
                              from pos_categories c where c.property_id = p_property), '[]'::jsonb),
    'items', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'category_id', i.category_id, 'name', i.name, 'price_minor', i.price_minor,
                                                           'sort_order', i.sort_order, 'is_active', i.is_active) order by i.sort_order, i.name)
                         from pos_items i where i.property_id = p_property), '[]'::jsonb),
    'places', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'kind', p.kind, 'is_active', p.is_active) order by p.kind, p.name)
                          from pos_places p where p.property_id = p_property), '[]'::jsonb));
end $$;

create function pos_open_orders(p_property uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not pos_can_read(p_property) then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', o.id, 'order_no', o.order_no, 'place_id', o.place_id, 'place_name', p.name, 'place_kind', p.kind,
                                        'guest_label', o.guest_label, 'opened_at', o.opened_at,
                                        'lines', (select count(*) from pos_order_lines l where l.order_id = o.id and l.kitchen_status <> 'cancelled'),
                                        'subtotal_minor', pos_live_subtotal(o.id)) order by o.opened_at)
      from pos_orders o join pos_places p on p.id = o.place_id where o.property_id = p_property and o.status = 'open'), '[]'::jsonb);
end $$;

-- One order with its lines. For an open order the tax and total are an estimate from today's rules; a settled order shows what was frozen.
create function pos_order_detail(p_order uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare o pos_orders%rowtype; v_sub bigint; v_tax bigint;
begin
  select * into o from pos_orders where id = p_order;
  if not found or not pos_can_read(o.property_id) then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if o.status = 'open' then
    v_sub := pos_live_subtotal(o.id);
    v_tax := calc_charge_tax(o.property_id, property_today(o.property_id), v_sub);
  else
    v_sub := o.subtotal_minor; v_tax := o.tax_minor;
  end if;
  return jsonb_build_object(
    'id', o.id, 'property_id', o.property_id, 'order_no', o.order_no, 'status', o.status, 'place_id', o.place_id, 'place_name', (select name from pos_places where id = o.place_id),
    'guest_label', o.guest_label, 'currency', o.currency, 'opened_at', o.opened_at, 'closed_at', o.closed_at, 'void_reason', o.void_reason,
    'reservation_id', o.reservation_id, 'subtotal_minor', v_sub, 'tax_minor', v_tax, 'total_minor', v_sub + v_tax, 'estimate', o.status = 'open',
    'payment_method', (select method from pos_payments where order_id = o.id),
    'lines', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name_at_order, 'quantity', l.quantity, 'unit_price_minor', l.unit_price_minor,
                                                           'note', l.note, 'kitchen_status', l.kitchen_status) order by l.created_at, l.id)
                         from pos_order_lines l where l.order_id = o.id), '[]'::jsonb));
end $$;

-- Lines the kitchen still has to make or hand over (new, preparing, ready), oldest first. Settled orders are included: the table may have paid
-- while the food is still coming. Void orders and cancelled lines are not.
create function pos_kitchen_queue(p_property uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not pos_can_read(p_property) then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('line_id', l.id, 'order_id', o.id, 'order_no', o.order_no, 'place_name', p.name, 'name', l.name_at_order,
                                        'quantity', l.quantity, 'note', l.note, 'kitchen_status', l.kitchen_status, 'created_at', l.created_at) order by l.created_at, l.id)
      from pos_order_lines l join pos_orders o on o.id = l.order_id join pos_places p on p.id = o.place_id
     where l.property_id = p_property and l.kitchen_status in ('new', 'preparing', 'ready') and o.status <> 'void'), '[]'::jsonb);
end $$;

-- Sales over hotel-local days (closed_at in the property's time zone), 1 to 366 days. Settled orders only. Two money sources, never added into
-- daily_report: table = paid at the table (pos_payments), room = posted to a folio (these are already extras in daily_report).
-- Needs pos.view and report.view.
create function pos_sales_report(p_property uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_tz text; v_result jsonb;
begin
  if not (pos_can_read(p_property) and has_permission(p_property, 'report.view')) then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 365 then raise exception 'POLICY_VIOLATION: dates' using errcode = 'P0001'; end if;
  select timezone into v_tz from properties where id = p_property;

  with ro as materialized (
    select o.id, o.status, (o.closed_at at time zone v_tz)::date as day, o.subtotal_minor as subtotal, o.tax_minor as tax, o.total_minor as total
      from pos_orders o
     where o.property_id = p_property and o.status in ('paid', 'posted') and (o.closed_at at time zone v_tz)::date between p_from and p_to),
  tot as (
    select jsonb_build_object(
             'table_orders', count(*) filter (where status = 'paid'), 'table_subtotal_minor', coalesce(sum(subtotal) filter (where status = 'paid'), 0),
             'table_tax_minor', coalesce(sum(tax) filter (where status = 'paid'), 0), 'table_total_minor', coalesce(sum(total) filter (where status = 'paid'), 0),
             'room_orders', count(*) filter (where status = 'posted'), 'room_subtotal_minor', coalesce(sum(subtotal) filter (where status = 'posted'), 0),
             'room_tax_minor', coalesce(sum(tax) filter (where status = 'posted'), 0), 'room_total_minor', coalesce(sum(total) filter (where status = 'posted'), 0)) as j
      from ro),
  byday as (
    select coalesce(jsonb_agg(jsonb_build_object('day', d.day, 'table_total_minor', d.t, 'room_total_minor', d.r, 'orders', d.n) order by d.day), '[]'::jsonb) as j
      from (select day, coalesce(sum(total) filter (where status = 'paid'), 0) as t, coalesce(sum(total) filter (where status = 'posted'), 0) as r, count(*) as n
              from ro group by day) d),
  meth as (
    select coalesce(jsonb_agg(jsonb_build_object('method', m.method, 'orders', m.n, 'total_minor', m.t) order by m.method), '[]'::jsonb) as j
      from (select pay.method, count(*) as n, sum(pay.amount_minor) as t from pos_payments pay join ro on ro.id = pay.order_id group by pay.method) m),
  itm as (
    select coalesce(jsonb_agg(jsonb_build_object('name', i.name, 'quantity', i.q, 'sales_minor', i.s) order by i.s desc, i.name), '[]'::jsonb) as j
      from (select l.name_at_order as name, sum(l.quantity) as q, sum(l.quantity * l.unit_price_minor) as s
              from pos_order_lines l join ro on ro.id = l.order_id where l.kitchen_status <> 'cancelled'
             group by l.name_at_order order by sum(l.quantity * l.unit_price_minor) desc, l.name_at_order limit 10) i)
  select jsonb_build_object('from', p_from, 'to', p_to, 'totals', (select j from tot), 'by_day', (select j from byday),
                            'table_by_method', (select j from meth), 'top_items', (select j from itm),
                            'voided_orders', (select count(*) from pos_orders o where o.property_id = p_property and o.status = 'void'
                                                and (o.closed_at at time zone v_tz)::date between p_from and p_to))
    into v_result;
  return v_result;
end $$;

-- ---- grants --------------------------------------------------------------------------------------
revoke all on function pos_save_category(uuid, uuid, text, integer, boolean), pos_save_item(uuid, uuid, uuid, text, bigint, integer, boolean),
  pos_save_place(uuid, uuid, text, text, boolean), pos_open_order(uuid, uuid, text, text), pos_add_line(uuid, uuid, integer, text, text),
  pos_set_line_status(uuid, text), pos_void_order(uuid, text), pos_pay_order(uuid, text, text, text), pos_post_to_room(uuid, uuid, text),
  pos_menu(uuid), pos_open_orders(uuid), pos_order_detail(uuid), pos_kitchen_queue(uuid), pos_sales_report(uuid, date, date) from public, anon;
grant execute on function pos_save_category(uuid, uuid, text, integer, boolean), pos_save_item(uuid, uuid, uuid, text, bigint, integer, boolean),
  pos_save_place(uuid, uuid, text, text, boolean), pos_open_order(uuid, uuid, text, text), pos_add_line(uuid, uuid, integer, text, text),
  pos_set_line_status(uuid, text), pos_void_order(uuid, text), pos_pay_order(uuid, text, text, text), pos_post_to_room(uuid, uuid, text),
  pos_menu(uuid), pos_open_orders(uuid), pos_order_detail(uuid), pos_kitchen_queue(uuid), pos_sales_report(uuid, date, date) to authenticated;
