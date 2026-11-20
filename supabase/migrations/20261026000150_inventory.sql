-- 149 Stock and purchasing, first cut (TODO 8.3).
--
-- Items counted in a unit (bottles, kg, rolls), suppliers, purchases that add stock, usage and wastage that take it away, stock counts that
-- put right any difference, and a link from a menu item (POS, 148) to the stock it uses so a settled bill deducts it.
--   stock_items       what the hotel keeps: name, unit, kind, the level at which it counts as low, and the quantity on hand.
--   stock_movements   the ledger. One row per change, never edited or deleted (kinds: purchase, sale, usage, waste, count). It carries the
--                     balance after the change. stock_items.quantity changes only inside stock_move(), which a trigger enforces.
--   stock_purchases   a delivery from a supplier with lines (item, quantity, unit cost); recording one adds the stock at once. Costs are money:
--                     the purchase tables are readable only with can_view_money.
--   pos_item_stock    "one Jollof rice uses 0.3 kg rice and 0.1 l oil": the recipe. Set by inventory.manage.
-- Sales. When a POS bill is settled (paid at the table or posted to a room) every non-cancelled line with a recipe takes its stock off
-- (stock_deduct_for_order, called from pos_pay_order and pos_post_to_room, both re-created below with that one added line). A sale may take a
-- balance below zero: refusing to sell a plate because a count was out of date is worse than a negative number that the next count corrects
-- (and the stock list shows it). Usage and wastage cannot take stock below zero. One sale movement per order and item (unique index).
-- Not deducted: a bill that is voided (it never settled) or a cancelled line. There is no reversal of a settled bill in this cut (POS has none).
-- Usage by housekeeping (minibar, linen, toiletries) is recorded by hand with stock_record_out; there is no automatic link to a room clean.
-- Permissions (new): inventory.view (read), inventory.use (record usage, wastage and counts), inventory.manage (items, suppliers, purchases,
-- recipes; also everything inventory.use can do). The report needs inventory.view and report.view.
-- Flag: inventory (enforced, on the Pro plan; no row = on). With it off, everything can still be read and bills still settle (no stock moves).
-- Quantities are numeric(12,3). Money is bigint kobo; a purchase line's total is round(quantity x unit cost).

-- ---- permissions and flag --------------------------------------------------------------------
insert into permissions (key) values ('inventory.view'), ('inventory.use'), ('inventory.manage');
insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r, permissions p
 where p.key = 'inventory.view' and r.is_system and r.key in ('owner', 'general_manager', 'front_desk', 'accountant', 'housekeeping');
insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r, permissions p
 where p.key = 'inventory.use' and r.is_system and r.key in ('owner', 'general_manager', 'front_desk', 'housekeeping');
insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r, permissions p
 where p.key = 'inventory.manage' and r.is_system and r.key in ('owner', 'general_manager');

create or replace function plan_enforced_flags() returns text[]
language sql immutable set search_path = public as $$
  select array['reports.export', 'online_payments', 'discounts', 'online_booking', 'guest_cancel', 'guest_changes', 'early_checkin',
               'housekeeping', 'maintenance', 'audit_log', 'branding', 'dynamic_pricing', 'sms_notifications', 'restaurant_pos', 'group_bookings', 'inventory']
$$;
revoke all on function plan_enforced_flags() from public, anon;
update plans set features = (select array_agg(distinct k order by k) from unnest(features || array['inventory']) k) where code = 'pro';

-- ---- tables ------------------------------------------------------------------------------------
create table stock_items (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  property_id uuid not null,
  name        text not null check (char_length(name) between 1 and 80),
  unit        text not null check (char_length(unit) between 1 and 20),
  kind        text not null default 'other' check (kind in ('food', 'drink', 'minibar', 'linen', 'toiletries', 'cleaning', 'other')),
  low_level   numeric(12, 3) not null default 0 check (low_level >= 0),
  quantity    numeric(12, 3) not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  foreign key (tenant_id, property_id) references properties (tenant_id, id),
  unique (tenant_id, property_id, id)
);
create unique index stock_items_name_idx on stock_items (property_id, lower(name));

create table stock_suppliers (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  property_id uuid not null,
  name        text not null check (char_length(name) between 1 and 80),
  phone       text check (phone is null or char_length(phone) <= 40),
  note        text check (note is null or char_length(note) <= 200),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  foreign key (tenant_id, property_id) references properties (tenant_id, id),
  unique (tenant_id, property_id, id)
);
create unique index stock_suppliers_name_idx on stock_suppliers (property_id, lower(name));

create table stock_purchases (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  property_id  uuid not null,
  supplier_id  uuid,
  reference    text check (reference is null or char_length(reference) <= 60),
  note         text check (note is null or char_length(note) <= 200),
  purchased_on date not null,
  total_minor  bigint not null check (total_minor between 0 and 1000000000000),
  currency     char(3) not null,
  created_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  foreign key (tenant_id, property_id) references properties (tenant_id, id),
  foreign key (tenant_id, property_id, supplier_id) references stock_suppliers (tenant_id, property_id, id),
  unique (tenant_id, property_id, id)
);
create index stock_purchases_day_idx on stock_purchases (property_id, purchased_on desc);

create table stock_purchase_lines (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null,
  property_id     uuid not null,
  purchase_id     uuid not null,
  item_id         uuid not null,
  quantity        numeric(12, 3) not null check (quantity > 0),
  unit_cost_minor bigint not null check (unit_cost_minor between 0 and 1000000000),
  line_total_minor bigint not null check (line_total_minor >= 0),
  foreign key (tenant_id, property_id, purchase_id) references stock_purchases (tenant_id, property_id, id),
  foreign key (tenant_id, property_id, item_id) references stock_items (tenant_id, property_id, id),
  unique (purchase_id, item_id)
);

create table stock_movements (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null,
  property_id   uuid not null,
  item_id       uuid not null,
  kind          text not null check (kind in ('purchase', 'sale', 'usage', 'waste', 'count')),
  change        numeric(12, 3) not null check (change <> 0),
  balance_after numeric(12, 3) not null,
  reason        text check (reason is null or char_length(reason) <= 40),
  note          text check (note is null or char_length(note) <= 200),
  purchase_id   uuid references stock_purchases (id),
  order_id      uuid references pos_orders (id),
  created_by    uuid references auth.users (id) on delete set null,
  created_at    timestamptz not null default clock_timestamp(),
  foreign key (tenant_id, property_id, item_id) references stock_items (tenant_id, property_id, id)
);
create index stock_movements_item_idx on stock_movements (item_id, created_at desc);
create unique index stock_movements_one_sale on stock_movements (order_id, item_id) where kind = 'sale';

create table pos_item_stock (
  tenant_id     uuid not null,
  property_id   uuid not null,
  pos_item_id   uuid not null,
  stock_item_id uuid not null,
  quantity      numeric(12, 3) not null check (quantity > 0 and quantity <= 100000),
  primary key (pos_item_id, stock_item_id),
  foreign key (tenant_id, property_id, pos_item_id) references pos_items (tenant_id, property_id, id),
  foreign key (tenant_id, property_id, stock_item_id) references stock_items (tenant_id, property_id, id)
);

-- Guards. The ledger and purchases are never edited or deleted (only a deleted login is cleared from created_by). The quantity on hand moves only
-- inside stock_move().
create function stock_guard_ledger() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'stock records are never deleted' using errcode = 'P0001'; end if;
  if (to_jsonb(new) - 'created_by') is distinct from (to_jsonb(old) - 'created_by') then raise exception 'stock records are never edited' using errcode = 'P0001'; end if;
  return new;
end $$;
create trigger stock_movements_guard before update or delete on stock_movements for each row execute function stock_guard_ledger();
create trigger stock_purchases_guard before update or delete on stock_purchases for each row execute function stock_guard_ledger();
create trigger stock_purchase_lines_guard before update or delete on stock_purchase_lines for each row execute function stock_guard_ledger();

create function stock_guard_items() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'stock items are never deleted' using errcode = 'P0001'; end if;
  if new.quantity is distinct from old.quantity and coalesce(current_setting('app.stock_move', true), '') <> 'on' then
    raise exception 'stock quantity changes only through a stock movement' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger stock_items_guard before update or delete on stock_items for each row execute function stock_guard_items();
create trigger stock_items_updated before update on stock_items for each row execute function set_updated_at();
create trigger stock_suppliers_updated before update on stock_suppliers for each row execute function set_updated_at();

-- ---- row level security: read with an inventory permission, write only through the functions --------
alter table stock_items enable row level security;
alter table stock_suppliers enable row level security;
alter table stock_purchases enable row level security;
alter table stock_purchase_lines enable row level security;
alter table stock_movements enable row level security;
alter table pos_item_stock enable row level security;

create function inv_can_read(p_property uuid) returns boolean language sql stable security definer set search_path = public as $$
  select has_permission(p_property, 'inventory.view') or has_permission(p_property, 'inventory.use') or has_permission(p_property, 'inventory.manage')
$$;
revoke all on function inv_can_read(uuid) from public, anon;
grant execute on function inv_can_read(uuid) to authenticated;

create policy stock_items_select on stock_items for select to authenticated using (inv_can_read(property_id));
create policy stock_suppliers_select on stock_suppliers for select to authenticated using (inv_can_read(property_id));
create policy stock_movements_select on stock_movements for select to authenticated using (inv_can_read(property_id));
create policy pos_item_stock_select on pos_item_stock for select to authenticated using (inv_can_read(property_id));
-- what was paid for stock is money
create policy stock_purchases_select on stock_purchases for select to authenticated using (inv_can_read(property_id) and can_view_money(property_id));
create policy stock_purchase_lines_select on stock_purchase_lines for select to authenticated using (inv_can_read(property_id) and can_view_money(property_id));

revoke all on stock_items, stock_suppliers, stock_purchases, stock_purchase_lines, stock_movements, pos_item_stock from anon, authenticated;
grant select on stock_items, stock_suppliers, stock_purchases, stock_purchase_lines, stock_movements, pos_item_stock to authenticated;

-- ---- internal helpers --------------------------------------------------------------------------
-- p_level 'use' accepts inventory.use or inventory.manage; 'manage' needs inventory.manage. A service caller or no permission is NOT_FOUND.
create function inv_require(p_property uuid, p_level text) returns uuid
language plpgsql stable security definer set search_path = public as $$
declare v_prop properties%rowtype; v_actor uuid;
begin
  select * into v_prop from properties where id = p_property;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if p_level = 'use' and has_permission(p_property, 'inventory.use') then
    v_actor := require_permission(p_property, 'inventory.use', 'NOT_FOUND');
  else
    v_actor := require_permission(p_property, 'inventory.manage', 'NOT_FOUND');
  end if;
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if not tenant_feature_on(v_prop.tenant_id, 'inventory') then raise exception 'POLICY_VIOLATION: inventory off' using errcode = 'P0001'; end if;
  return v_actor;
end $$;
revoke all on function inv_require(uuid, text) from public, anon, authenticated;

-- The one place a quantity changes: lock the item, move it, write the ledger row. Returns the balance after.
create function stock_move(p_item uuid, p_kind text, p_change numeric, p_reason text, p_note text, p_actor uuid, p_purchase uuid, p_order uuid, p_floor_zero boolean)
returns numeric language plpgsql security definer set search_path = public as $$
declare s stock_items%rowtype; v_new numeric;
begin
  select * into s from stock_items where id = p_item for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_new := s.quantity + p_change;
  if p_floor_zero and v_new < 0 then raise exception 'POLICY_VIOLATION: not enough stock' using errcode = 'P0001'; end if;
  perform set_config('app.stock_move', 'on', true);
  update stock_items set quantity = v_new where id = p_item;
  perform set_config('app.stock_move', 'off', true);
  insert into stock_movements (tenant_id, property_id, item_id, kind, change, balance_after, reason, note, purchase_id, order_id, created_by)
  values (s.tenant_id, s.property_id, p_item, p_kind, p_change, v_new, p_reason, p_note, p_purchase, p_order, p_actor);
  return v_new;
end $$;
revoke all on function stock_move(uuid, text, numeric, text, text, uuid, uuid, uuid, boolean) from public, anon, authenticated;

-- Called when a POS bill settles (re-created pos_pay_order and pos_post_to_room below). Silent when the flag is off or nothing has a recipe.
create function stock_deduct_for_order(p_order uuid, p_actor uuid) returns void
language plpgsql security definer set search_path = public as $$
declare o pos_orders%rowtype; x record;
begin
  select * into o from pos_orders where id = p_order;
  if not found or not tenant_feature_on(o.tenant_id, 'inventory') then return; end if;
  for x in
    select r.stock_item_id, sum(l.quantity * r.quantity) as used
      from pos_order_lines l join pos_item_stock r on r.pos_item_id = l.item_id
     where l.order_id = p_order and l.kitchen_status <> 'cancelled'
     group by r.stock_item_id order by r.stock_item_id
  loop
    perform stock_move(x.stock_item_id, 'sale', -x.used, o.order_no, null, p_actor, null, p_order, false);
  end loop;
end $$;
revoke all on function stock_deduct_for_order(uuid, uuid) from public, anon, authenticated;

-- ---- POS settle functions, re-created with one added line each: perform stock_deduct_for_order(o.id, v_actor) ------------------
create or replace function pos_pay_order(p_order uuid, p_method text, p_reference text, p_key text) returns jsonb
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
  perform stock_deduct_for_order(o.id, v_actor);

  v_result := jsonb_build_object('order_id', o.id, 'status', 'paid', 'subtotal_minor', v_sub, 'tax_minor', v_tax, 'total_minor', v_total);
  perform idem_finish(o.tenant_id, 'pos_pay_order', p_key, v_result);
  perform write_audit(o.tenant_id, o.property_id, v_actor, 'pos_order.paid', 'pos_order', o.id, p_key,
                      jsonb_build_object('order_no', o.order_no, 'method', p_method, 'subtotal_minor', v_sub, 'tax_minor', v_tax, 'total_minor', v_total));
  return v_result;
end $$;

create or replace function pos_post_to_room(p_order uuid, p_reservation uuid, p_key text) returns jsonb
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

  perform stock_deduct_for_order(o.id, v_actor);
  v_result := jsonb_build_object('order_id', o.id, 'status', 'posted', 'subtotal_minor', v_sub, 'tax_minor', (v_post ->> 'tax_minor')::bigint,
                                 'total_minor', (v_post ->> 'total_minor')::bigint, 'balance_minor', (v_post ->> 'balance_minor')::bigint);
  perform idem_finish(o.tenant_id, 'pos_post_to_room', p_key, v_result);
  perform write_audit(o.tenant_id, o.property_id, v_actor, 'pos_order.posted_to_room', 'pos_order', o.id, p_key,
                      jsonb_build_object('order_no', o.order_no, 'reservation_id', r.id, 'charge_id', v_post ->> 'charge_id', 'total_minor', (v_post ->> 'total_minor')::bigint));
  return v_result;
end $$;

-- ---- setup (inventory.manage) -----------------------------------------------------------------
create function stock_save_item(p_property uuid, p_item uuid, p_name text, p_unit text, p_kind text, p_low numeric, p_active boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_actor uuid; v_prop properties%rowtype; v_name text := btrim(coalesce(p_name, '')); v_unit text := btrim(coalesce(p_unit, '')); v_id uuid; v_low numeric := coalesce(p_low, 0);
begin
  v_actor := inv_require(p_property, 'manage');
  select * into v_prop from properties where id = p_property;
  if char_length(v_name) not between 1 and 80 then raise exception 'POLICY_VIOLATION: name' using errcode = 'P0001'; end if;
  if char_length(v_unit) not between 1 and 20 then raise exception 'POLICY_VIOLATION: unit' using errcode = 'P0001'; end if;
  if p_kind is null or p_kind not in ('food', 'drink', 'minibar', 'linen', 'toiletries', 'cleaning', 'other') then raise exception 'POLICY_VIOLATION: kind' using errcode = 'P0001'; end if;
  if v_low < 0 or v_low > 1000000 then raise exception 'POLICY_VIOLATION: low level' using errcode = 'P0001'; end if;
  if exists (select 1 from stock_items where property_id = p_property and lower(name) = lower(v_name) and id is distinct from p_item) then
    raise exception 'POLICY_VIOLATION: name taken' using errcode = 'P0001';
  end if;
  if p_item is null then
    if (select count(*) from stock_items where property_id = p_property) >= 400 then raise exception 'POLICY_VIOLATION: limit' using errcode = 'P0001'; end if;
    insert into stock_items (tenant_id, property_id, name, unit, kind, low_level, is_active)
    values (v_prop.tenant_id, p_property, v_name, v_unit, p_kind, round(v_low, 3), coalesce(p_active, true)) returning id into v_id;
  else
    update stock_items set name = v_name, unit = v_unit, kind = p_kind, low_level = round(v_low, 3), is_active = coalesce(p_active, true)
     where id = p_item and property_id = p_property returning id into v_id;
    if v_id is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  end if;
  perform write_audit(v_prop.tenant_id, p_property, v_actor, 'stock_item.saved', 'stock_item', v_id, null,
                      jsonb_build_object('name', v_name, 'unit', v_unit, 'kind', p_kind, 'low_level', round(v_low, 3), 'active', coalesce(p_active, true), 'created', p_item is null));
  return jsonb_build_object('item_id', v_id);
end $$;

create function stock_save_supplier(p_property uuid, p_supplier uuid, p_name text, p_phone text, p_note text, p_active boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_actor uuid; v_prop properties%rowtype; v_name text := btrim(coalesce(p_name, '')); v_phone text := nullif(btrim(coalesce(p_phone, '')), ''); v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_id uuid;
begin
  v_actor := inv_require(p_property, 'manage');
  select * into v_prop from properties where id = p_property;
  if char_length(v_name) not between 1 and 80 then raise exception 'POLICY_VIOLATION: name' using errcode = 'P0001'; end if;
  if char_length(coalesce(v_phone, '')) > 40 or char_length(coalesce(v_note, '')) > 200 then raise exception 'POLICY_VIOLATION: text' using errcode = 'P0001'; end if;
  if exists (select 1 from stock_suppliers where property_id = p_property and lower(name) = lower(v_name) and id is distinct from p_supplier) then
    raise exception 'POLICY_VIOLATION: name taken' using errcode = 'P0001';
  end if;
  if p_supplier is null then
    if (select count(*) from stock_suppliers where property_id = p_property) >= 100 then raise exception 'POLICY_VIOLATION: limit' using errcode = 'P0001'; end if;
    insert into stock_suppliers (tenant_id, property_id, name, phone, note, is_active) values (v_prop.tenant_id, p_property, v_name, v_phone, v_note, coalesce(p_active, true)) returning id into v_id;
  else
    update stock_suppliers set name = v_name, phone = v_phone, note = v_note, is_active = coalesce(p_active, true) where id = p_supplier and property_id = p_property returning id into v_id;
    if v_id is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  end if;
  perform write_audit(v_prop.tenant_id, p_property, v_actor, 'stock_supplier.saved', 'stock_supplier', v_id, null,
                      jsonb_build_object('name', v_name, 'active', coalesce(p_active, true), 'created', p_supplier is null));
  return jsonb_build_object('supplier_id', v_id);
end $$;

-- The recipe of a menu item: [{"item": <stock item id>, "quantity": 0.3}, ...], at most 10 lines; an empty list clears it.
create function stock_set_recipe(p_pos_item uuid, p_lines jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_actor uuid; pi pos_items%rowtype; e jsonb; v_item uuid; v_qty numeric; v_seen uuid[] := '{}'; v_n integer;
begin
  select * into pi from pos_items where id = p_pos_item;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := inv_require(pi.property_id, 'manage');
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) > 10 then raise exception 'POLICY_VIOLATION: lines' using errcode = 'P0001'; end if;
  delete from pos_item_stock where pos_item_id = p_pos_item;
  for e in select * from jsonb_array_elements(p_lines) loop
    begin
      v_item := (e ->> 'item')::uuid; v_qty := (e ->> 'quantity')::numeric;
    exception when others then raise exception 'POLICY_VIOLATION: line' using errcode = 'P0001';
    end;
    if v_qty is null or v_qty <= 0 or v_qty > 100000 or v_item = any (v_seen) then raise exception 'POLICY_VIOLATION: line' using errcode = 'P0001'; end if;
    if not exists (select 1 from stock_items where id = v_item and property_id = pi.property_id) then raise exception 'POLICY_VIOLATION: item' using errcode = 'P0001'; end if;
    v_seen := v_seen || v_item;
    insert into pos_item_stock (tenant_id, property_id, pos_item_id, stock_item_id, quantity) values (pi.tenant_id, pi.property_id, p_pos_item, v_item, round(v_qty, 3));
  end loop;
  v_n := coalesce(array_length(v_seen, 1), 0);
  perform write_audit(pi.tenant_id, pi.property_id, v_actor, 'pos_item_stock.saved', 'pos_item', p_pos_item, null, jsonb_build_object('name', pi.name, 'lines', v_n));
  return jsonb_build_object('pos_item_id', p_pos_item, 'lines', v_n);
end $$;

-- ---- purchases (inventory.manage) ----------------------------------------------------------------
-- p_lines: [{"item": id, "quantity": 12, "unit_cost_minor": 85000}, ...], 1 to 30 lines, one line per item. Adds the stock at once.
create function stock_record_purchase(p_property uuid, p_supplier uuid, p_reference text, p_note text, p_lines jsonb, p_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid; v_prop properties%rowtype; v_idem record; v_hash text; e jsonb; v_item uuid; v_qty numeric; v_cost bigint; v_line bigint; v_total bigint := 0;
  v_seen uuid[] := '{}'; v_id uuid; v_ref text := nullif(btrim(coalesce(p_reference, '')), ''); v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_result jsonb;
begin
  v_actor := inv_require(p_property, 'manage');
  select * into v_prop from properties where id = p_property;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) not between 1 and 30 then raise exception 'POLICY_VIOLATION: lines' using errcode = 'P0001'; end if;
  if char_length(coalesce(v_ref, '')) > 60 or char_length(coalesce(v_note, '')) > 200 then raise exception 'POLICY_VIOLATION: text' using errcode = 'P0001'; end if;
  if p_supplier is not null and not exists (select 1 from stock_suppliers where id = p_supplier and property_id = p_property and is_active) then raise exception 'POLICY_VIOLATION: supplier' using errcode = 'P0001'; end if;

  v_hash := md5(concat_ws('|', p_property, p_supplier, v_ref, v_note, p_lines::text));
  select * into v_idem from idem_begin(v_prop.tenant_id, 'stock_record_purchase', p_key, v_hash);
  if not v_idem.out_is_new then return v_idem.out_response; end if;

  -- check every line before writing any
  for e in select * from jsonb_array_elements(p_lines) loop
    begin
      v_item := (e ->> 'item')::uuid; v_qty := (e ->> 'quantity')::numeric; v_cost := (e ->> 'unit_cost_minor')::bigint;
    exception when others then raise exception 'POLICY_VIOLATION: line' using errcode = 'P0001';
    end;
    if v_qty is null or v_qty < 0.001 or v_qty > 1000000 or v_cost is null or v_cost < 0 or v_cost > 1000000000 or v_item = any (v_seen) then raise exception 'POLICY_VIOLATION: line' using errcode = 'P0001'; end if;
    if not exists (select 1 from stock_items where id = v_item and property_id = p_property and is_active) then raise exception 'POLICY_VIOLATION: item' using errcode = 'P0001'; end if;
    v_seen := v_seen || v_item;
    v_total := v_total + round(round(v_qty, 3) * v_cost)::bigint;
  end loop;
  if v_total > 1000000000000 then raise exception 'POLICY_VIOLATION: total' using errcode = 'P0001'; end if;

  insert into stock_purchases (tenant_id, property_id, supplier_id, reference, note, purchased_on, total_minor, currency, created_by)
  values (v_prop.tenant_id, p_property, p_supplier, v_ref, v_note, property_today(p_property), v_total, v_prop.currency, v_actor) returning id into v_id;
  for v_item in select (x ->> 'item')::uuid from jsonb_array_elements(p_lines) x order by (x ->> 'item')::uuid loop
    select * into e from jsonb_array_elements(p_lines) x where (x ->> 'item')::uuid = v_item limit 1;
    v_qty := round((e ->> 'quantity')::numeric, 3); v_cost := (e ->> 'unit_cost_minor')::bigint; v_line := round(v_qty * v_cost)::bigint;
    insert into stock_purchase_lines (tenant_id, property_id, purchase_id, item_id, quantity, unit_cost_minor, line_total_minor)
    values (v_prop.tenant_id, p_property, v_id, v_item, v_qty, v_cost, v_line);
    perform stock_move(v_item, 'purchase', v_qty, null, v_ref, v_actor, v_id, null, false);
  end loop;

  v_result := jsonb_build_object('purchase_id', v_id, 'total_minor', v_total, 'lines', jsonb_array_length(p_lines));
  perform idem_finish(v_prop.tenant_id, 'stock_record_purchase', p_key, v_result);
  perform write_audit(v_prop.tenant_id, p_property, v_actor, 'stock_purchase.recorded', 'stock_purchase', v_id, p_key,
                      jsonb_build_object('supplier_id', p_supplier, 'reference', v_ref, 'lines', jsonb_array_length(p_lines), 'total_minor', v_total));
  return v_result;
end $$;

-- ---- usage, wastage and counts (inventory.use or inventory.manage) -----------------------------------
create function stock_record_out(p_item uuid, p_kind text, p_quantity numeric, p_reason text, p_note text, p_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s stock_items%rowtype; v_actor uuid; v_idem record; v_hash text; v_qty numeric := round(coalesce(p_quantity, 0), 3); v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_bal numeric; v_result jsonb;
begin
  select * into s from stock_items where id = p_item;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := inv_require(s.property_id, 'use');
  if p_kind is null or p_kind not in ('usage', 'waste') then raise exception 'POLICY_VIOLATION: kind' using errcode = 'P0001'; end if;
  if v_qty <= 0 or v_qty > 1000000 then raise exception 'POLICY_VIOLATION: quantity' using errcode = 'P0001'; end if;
  if p_kind = 'usage' and (p_reason is null or p_reason not in ('minibar', 'housekeeping', 'linen', 'toiletries', 'kitchen', 'maintenance', 'other')) then raise exception 'POLICY_VIOLATION: reason' using errcode = 'P0001'; end if;
  if p_kind = 'waste' and (p_reason is null or p_reason not in ('expired', 'damaged', 'spillage', 'spoiled', 'theft', 'other')) then raise exception 'POLICY_VIOLATION: reason' using errcode = 'P0001'; end if;
  if char_length(coalesce(v_note, '')) > 200 then raise exception 'POLICY_VIOLATION: text' using errcode = 'P0001'; end if;

  v_hash := md5(concat_ws('|', p_item, p_kind, v_qty, p_reason, v_note));
  select * into v_idem from idem_begin(s.tenant_id, 'stock_record_out', p_key, v_hash);
  if not v_idem.out_is_new then return v_idem.out_response; end if;

  v_bal := stock_move(p_item, p_kind, -v_qty, p_reason, v_note, v_actor, null, null, true);
  v_result := jsonb_build_object('item_id', p_item, 'balance', v_bal);
  perform idem_finish(s.tenant_id, 'stock_record_out', p_key, v_result);
  perform write_audit(s.tenant_id, s.property_id, v_actor, 'stock.' || p_kind, 'stock_item', p_item, p_key,
                      jsonb_build_object('name', s.name, 'quantity', v_qty, 'reason', p_reason, 'balance', v_bal));
  return v_result;
end $$;

-- A stock count: [{"item": id, "counted": 12.5}, ...]. Each item's quantity is set to what was counted; the difference goes to the ledger as a
-- 'count' movement (an item already right leaves no movement). Returns the differences.
create function stock_count(p_property uuid, p_counts jsonb, p_note text, p_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid; v_prop properties%rowtype; v_idem record; v_hash text; e jsonb; v_item uuid; v_counted numeric; v_seen uuid[] := '{}'; v_old numeric;
  v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_diffs jsonb := '[]'::jsonb; v_result jsonb;
begin
  v_actor := inv_require(p_property, 'use');
  select * into v_prop from properties where id = p_property;
  if p_counts is null or jsonb_typeof(p_counts) <> 'array' or jsonb_array_length(p_counts) not between 1 and 400 then raise exception 'POLICY_VIOLATION: lines' using errcode = 'P0001'; end if;
  if char_length(coalesce(v_note, '')) > 200 then raise exception 'POLICY_VIOLATION: text' using errcode = 'P0001'; end if;

  v_hash := md5(concat_ws('|', p_property, v_note, p_counts::text));
  select * into v_idem from idem_begin(v_prop.tenant_id, 'stock_count', p_key, v_hash);
  if not v_idem.out_is_new then return v_idem.out_response; end if;

  for e in select * from jsonb_array_elements(p_counts) loop
    begin
      v_item := (e ->> 'item')::uuid; v_counted := round((e ->> 'counted')::numeric, 3);
    exception when others then raise exception 'POLICY_VIOLATION: line' using errcode = 'P0001';
    end;
    if v_counted is null or v_counted < 0 or v_counted > 1000000 or v_item = any (v_seen) then raise exception 'POLICY_VIOLATION: line' using errcode = 'P0001'; end if;
    if not exists (select 1 from stock_items where id = v_item and property_id = p_property) then raise exception 'POLICY_VIOLATION: item' using errcode = 'P0001'; end if;
    v_seen := v_seen || v_item;
  end loop;
  for v_item in select (x ->> 'item')::uuid from jsonb_array_elements(p_counts) x order by (x ->> 'item')::uuid loop
    select round((x ->> 'counted')::numeric, 3) into v_counted from jsonb_array_elements(p_counts) x where (x ->> 'item')::uuid = v_item limit 1;
    select quantity into v_old from stock_items where id = v_item for update;
    if v_counted <> v_old then
      perform stock_move(v_item, 'count', v_counted - v_old, 'stocktake', v_note, v_actor, null, null, false);
      v_diffs := v_diffs || jsonb_build_object('item_id', v_item, 'before', v_old, 'counted', v_counted, 'difference', v_counted - v_old);
    end if;
  end loop;

  v_result := jsonb_build_object('counted', jsonb_array_length(p_counts), 'differences', v_diffs);
  perform idem_finish(v_prop.tenant_id, 'stock_count', p_key, v_result);
  perform write_audit(v_prop.tenant_id, p_property, v_actor, 'stock.counted', 'property', p_property, p_key,
                      jsonb_build_object('items', jsonb_array_length(p_counts), 'differences', jsonb_array_length(v_diffs)));
  return v_result;
end $$;

-- ---- report (inventory.view and report.view) ---------------------------------------------------------
-- Per item for the hotel days in the range: bought (quantity and cost), sold through POS, used, wasted (and what the waste cost at the item's latest
-- purchase price up to the end of the range), count differences, plus the quantity on hand now and whether it is low. Purchases are money: the cost
-- columns are null without can_view_money.
create function stock_report(p_property uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_tz text; v_money boolean; v_result jsonb;
begin
  if not (inv_can_read(p_property) and has_permission(p_property, 'report.view')) then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 365 then raise exception 'POLICY_VIOLATION: dates' using errcode = 'P0001'; end if;
  select timezone into v_tz from properties where id = p_property;
  v_money := can_view_money(p_property);
  with mv as (
    select m.item_id, m.kind, m.change from stock_movements m
     where m.property_id = p_property and (m.created_at at time zone v_tz)::date between p_from and p_to),
  agg as (
    select item_id,
           coalesce(sum(change) filter (where kind = 'purchase'), 0) as bought,
           coalesce(-sum(change) filter (where kind = 'sale'), 0) as sold,
           coalesce(-sum(change) filter (where kind = 'usage'), 0) as used,
           coalesce(-sum(change) filter (where kind = 'waste'), 0) as wasted,
           coalesce(sum(change) filter (where kind = 'count'), 0) as count_diff
      from mv group by item_id),
  cost as (
    select l.item_id, sum(l.line_total_minor) as spent
      from stock_purchase_lines l join stock_purchases p on p.id = l.purchase_id
     where p.property_id = p_property and p.purchased_on between p_from and p_to group by l.item_id),
  lastcost as (
    select distinct on (l.item_id) l.item_id, l.unit_cost_minor
      from stock_purchase_lines l join stock_purchases p on p.id = l.purchase_id
     where p.property_id = p_property and p.purchased_on <= p_to
     order by l.item_id, p.purchased_on desc, p.created_at desc)
  select jsonb_build_object('from', p_from, 'to', p_to, 'items', coalesce(jsonb_agg(jsonb_build_object(
           'item_id', i.id, 'name', i.name, 'unit', i.unit, 'kind', i.kind, 'on_hand', i.quantity, 'low', (i.low_level > 0 and i.quantity <= i.low_level),
           'bought', coalesce(a.bought, 0), 'sold', coalesce(a.sold, 0), 'used', coalesce(a.used, 0), 'wasted', coalesce(a.wasted, 0), 'count_difference', coalesce(a.count_diff, 0),
           'spent_minor', case when v_money then coalesce(c.spent, 0) end,
           'waste_value_minor', case when v_money then round(coalesce(a.wasted, 0) * coalesce(lc.unit_cost_minor, 0))::bigint end) order by i.name), '[]'::jsonb),
         'spent_minor', case when v_money then (select coalesce(sum(spent), 0) from cost) end)
    into v_result
    from stock_items i left join agg a on a.item_id = i.id left join cost c on c.item_id = i.id left join lastcost lc on lc.item_id = i.id
   where i.property_id = p_property;
  return v_result;
end $$;

-- ---- grants --------------------------------------------------------------------------------------
revoke all on function stock_save_item(uuid, uuid, text, text, text, numeric, boolean), stock_save_supplier(uuid, uuid, text, text, text, boolean),
  stock_set_recipe(uuid, jsonb), stock_record_purchase(uuid, uuid, text, text, jsonb, text), stock_record_out(uuid, text, numeric, text, text, text),
  stock_count(uuid, jsonb, text, text), stock_report(uuid, date, date) from public, anon;
grant execute on function stock_save_item(uuid, uuid, text, text, text, numeric, boolean), stock_save_supplier(uuid, uuid, text, text, text, boolean),
  stock_set_recipe(uuid, jsonb), stock_record_purchase(uuid, uuid, text, text, jsonb, text), stock_record_out(uuid, text, numeric, text, text, text),
  stock_count(uuid, jsonb, text, text), stock_report(uuid, date, date) to authenticated;
