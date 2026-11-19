-- Restaurant, bar and point of sale (migration 148). Reuses t_as / t_sys / t_expect / t_book / t_rr (05) and t21_free_room / t21_room (21).
-- Users: aa01 owner A, aa02 housekeeping A, aa04 front desk A (pos.view, pos.sell, folio.charge), aa05 accountant A (pos.view, report.view; no pos.sell),
-- bb01 owner of Hotel B. This file adds aa31, a waiter on a custom role with pos.sell and pos.view only (no folio.charge, no report.view).
-- Ids: a1 tenant A, a2 property A, a3 the STD room type. A 7.5 percent tax rule that applies to extras is added in block 5 and removed at the end.
\set ON_ERROR_STOP on

insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000aa31', 'waiter@example.test');
insert into tenant_memberships (id, tenant_id, user_id, status)
values ('00000000-0000-0000-0000-0000000aaa31', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000aa31', 'active');
insert into roles (key, name, is_system) values ('t148_waiter', 'Waiter', false);
insert into role_permissions (role_id, permission_id) select r.id, p.id from roles r, permissions p where r.key = 't148_waiter' and p.key in ('pos.sell', 'pos.view');
insert into membership_roles (membership_id, role_id) select '00000000-0000-0000-0000-0000000aaa31', id from roles where key = 't148_waiter';

create table t148_ctx (label text primary key, val text not null);
create function t148(p_label text) returns uuid language sql stable as $$ select val::uuid from t148_ctx where label = p_label $$;
create function t148_audits(p_action text, p_entity uuid) returns bigint language sql stable as $$ select count(*) from audit_logs where action = p_action and entity_id = p_entity $$;
create function t148_report_row(p_day date) returns text language sql stable as $$
  select to_jsonb(d)::text from daily_report('00000000-0000-0000-0000-0000000000a2', p_day, p_day) d
$$;
-- the current line of an order by name
create function t148_line(p_order uuid, p_name text) returns uuid language sql stable as $$
  select id from pos_order_lines where order_id = p_order and name_at_order = p_name order by created_at limit 1
$$;

-- 1. Grants: exactly who holds each permission, and the flag lists
do $$ declare v_n integer; begin
  perform t_sys();
  select count(*) into v_n from role_permissions rp join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id
   where p.key = 'pos.view' and r.is_system and r.key in ('owner', 'general_manager', 'front_desk', 'accountant');
  if v_n <> 4 then raise exception 'FAIL pos.view grants (%)', v_n; end if;
  select count(*) into v_n from role_permissions rp join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id
   where p.key = 'pos.sell' and r.is_system and r.key in ('owner', 'general_manager', 'front_desk');
  if v_n <> 3 then raise exception 'FAIL pos.sell grants (%)', v_n; end if;
  select count(*) into v_n from role_permissions rp join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id
   where p.key = 'pos.manage' and r.is_system and r.key in ('owner', 'general_manager');
  if v_n <> 2 then raise exception 'FAIL pos.manage grants (%)', v_n; end if;
  if exists (select 1 from role_permissions rp join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id
              where p.key like 'pos.%' and r.is_system and r.key not in ('owner', 'general_manager', 'front_desk', 'accountant')) then raise exception 'FAIL a pos permission is granted too widely'; end if;
  if exists (select 1 from role_permissions rp join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id
              where p.key in ('pos.sell', 'pos.manage') and r.is_system and r.key = 'accountant') then raise exception 'FAIL the accountant can sell'; end if;
  if not ('restaurant_pos' = any (plan_enforced_flags())) then raise exception 'FAIL restaurant_pos is not an enforced flag'; end if;
  if not ((select 'restaurant_pos' = any (features) from plans where code = 'pro')) then raise exception 'FAIL pro plan lacks restaurant_pos'; end if;
  if (select 'restaurant_pos' = any (features) from plans where code = 'starter') then raise exception 'FAIL starter plan has restaurant_pos'; end if;
  raise notice 'PASS grants: pos.view for four roles, pos.sell for three, pos.manage for two; restaurant_pos is enforced and on the pro plan only';
end $$;

-- 2. Menu and places: who may write, what is accepted
do $$ declare
  v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; r jsonb; v_cat uuid; v_cat2 uuid; v_item uuid; m jsonb;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select pos_save_category(%L, null, ''Mains'', 1, true)', v_p), 'NOT_FOUND');          -- front desk sells but does not manage the menu
  perform t_as('00000000-0000-0000-0000-00000000aa31');
  perform t_expect(format('select pos_save_place(%L, null, ''T1'', ''table'', true)', v_p), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select pos_save_category(%L, null, ''Mains'', 1, true)', v_p), 'NOT_FOUND');
  perform t_expect(format('select pos_menu(%L)', v_p), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform t_expect(format('select pos_menu(%L)', v_p), 'NOT_FOUND');                                          -- housekeeping has no pos permission

  perform t_as('00000000-0000-0000-0000-00000000aa01');
  r := pos_save_category(v_p, null, '  Mains  ', 1, true);
  v_cat := (r ->> 'category_id')::uuid;
  v_cat2 := (pos_save_category(v_p, null, 'Drinks', 2, true) ->> 'category_id')::uuid;
  perform t_expect(format('select pos_save_category(%L, null, ''mains'', 3, true)', v_p), 'POLICY_VIOLATION: name taken');
  perform t_expect(format('select pos_save_category(%L, null, '''', 3, true)', v_p), 'POLICY_VIOLATION: name');
  perform t_expect(format('select pos_save_category(%L, null, ''x'', 1001, true)', v_p), 'POLICY_VIOLATION: sort');
  perform t_expect(format('select pos_save_category(%L, %L, ''x'', 1, true)', v_p, gen_random_uuid()), 'NOT_FOUND');
  r := pos_save_item(v_p, null, v_cat, 'Jollof rice', 350000, 1, true);   -- NGN 3,500.00
  v_item := (r ->> 'item_id')::uuid;
  perform pos_save_item(v_p, null, v_cat, 'Grilled fish', 600000, 2, true);
  perform pos_save_item(v_p, null, v_cat2, 'Chapman', 150000, 1, true);
  perform pos_save_item(v_p, null, v_cat2, 'Old special', 100000, 9, false);
  perform t_expect(format('select pos_save_item(%L, null, %L, ''jollof RICE'', 100, 1, true)', v_p, v_cat), 'POLICY_VIOLATION: name taken');
  perform pos_save_item(v_p, null, v_cat2, 'Jollof rice', 100, 1, true);                                      -- the same name in another category is fine
  perform t_expect(format('select pos_save_item(%L, null, %L, ''Free'', 0, 1, true)', v_p, v_cat), 'POLICY_VIOLATION: price');
  perform t_expect(format('select pos_save_item(%L, null, %L, ''Huge'', 1000000001, 1, true)', v_p, v_cat), 'POLICY_VIOLATION: price');
  perform t_expect(format('select pos_save_item(%L, null, %L, ''Nowhere'', 100, 1, true)', v_p, gen_random_uuid()), 'POLICY_VIOLATION: category');
  perform t_expect(format('select pos_save_item(%L, %L, %L, ''x'', 100, 1, true)', v_p, gen_random_uuid(), v_cat), 'NOT_FOUND');
  perform pos_save_place(v_p, null, 'Table 1', 'table', true);
  perform pos_save_place(v_p, null, 'Bar', 'bar', true);
  perform pos_save_place(v_p, null, 'Room service', 'room_service', true);
  perform pos_save_place(v_p, null, 'Table 9', 'table', false);
  perform t_expect(format('select pos_save_place(%L, null, ''table 1'', ''table'', true)', v_p), 'POLICY_VIOLATION: name taken');
  perform t_expect(format('select pos_save_place(%L, null, ''Patio'', ''patio'', true)', v_p), 'POLICY_VIOLATION: kind');

  m := pos_menu(v_p);
  if jsonb_array_length(m -> 'categories') <> 2 or jsonb_array_length(m -> 'items') <> 5 or jsonb_array_length(m -> 'places') <> 4 then raise exception 'FAIL menu %', m; end if;
  if m -> 'categories' -> 0 ->> 'name' <> 'Mains' then raise exception 'FAIL name not trimmed or not sorted: %', m -> 'categories'; end if;
  -- reads: front desk, waiter and accountant see the menu; they write nothing
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  if jsonb_array_length(pos_menu(v_p) -> 'items') <> 5 then raise exception 'FAIL accountant cannot read the menu'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa31');
  if jsonb_array_length(pos_menu(v_p) -> 'items') <> 5 then raise exception 'FAIL waiter cannot read the menu'; end if;
  perform t_sys();
  if (select count(*) from audit_logs where action in ('pos_category.saved', 'pos_item.saved', 'pos_place.saved')) <> 11 then raise exception 'FAIL menu audit rows'; end if;
  insert into t148_ctx values ('cat', v_cat::text), ('item', v_item::text),
    ('place_t1', (select id::text from pos_places where name = 'Table 1')), ('place_bar', (select id::text from pos_places where name = 'Bar')),
    ('place_off', (select id::text from pos_places where name = 'Table 9')), ('off_item', (select id::text from pos_items where name = 'Old special'));
  raise notice 'PASS menu: only pos.manage writes, names and prices are checked, duplicates refused, reads for every pos role, other hotel and housekeeping refused, audited';
end $$;

-- 3. Orders and lines: open, add, replay, kitchen steps, cancel, bill
do $$ declare
  v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; r jsonb; r2 jsonb; v_o uuid; v_jollof uuid; v_fish uuid; v_chapman uuid; d jsonb; v_l uuid;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa31');
  perform t_expect(format('select pos_open_order(%L, %L, null, ''o-off'')', v_p, t148('place_off')), 'POLICY_VIOLATION: place off');
  perform t_expect(format('select pos_open_order(%L, %L, null, ''o-x'')', v_p, gen_random_uuid()), 'NOT_FOUND');
  r := pos_open_order(v_p, t148('place_t1'), 'Mr Ade', 'o-1');
  r2 := pos_open_order(v_p, t148('place_t1'), 'Mr Ade', 'o-1');
  if r <> r2 then raise exception 'FAIL a repeated open made another order: % vs %', r, r2; end if;
  v_o := (r ->> 'order_id')::uuid;
  if r ->> 'order_no' !~ '^POS-[0-9]{6}$' then raise exception 'FAIL order number %', r; end if;
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select pos_add_line(%L, %L, 1, null, ''x'')', v_o, t148('item')), 'NOT_FOUND');
  perform t_expect(format('select pos_order_detail(%L)', v_o), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform t_expect(format('select pos_add_line(%L, %L, 1, null, ''x'')', v_o, t148('item')), 'NOT_FOUND');

  perform t_as('00000000-0000-0000-0000-00000000aa31');
  r := pos_add_line(v_o, t148('item'), 2, 'no pepper', 'l-1');
  if (r ->> 'subtotal_minor')::bigint <> 700000 then raise exception 'FAIL subtotal %', r; end if;
  r2 := pos_add_line(v_o, t148('item'), 2, 'no pepper', 'l-1');
  if r <> r2 or (select count(*) from pos_order_lines where order_id = v_o) <> 1 then raise exception 'FAIL a double tap added a second line'; end if;
  perform pos_add_line(v_o, (select id from pos_items where name = 'Grilled fish'), 1, null, 'l-2');
  perform pos_add_line(v_o, (select id from pos_items where name = 'Chapman'), 3, null, 'l-3');
  perform t_expect(format('select pos_add_line(%L, %L, 1, null, ''l-4'')', v_o, t148('off_item')), 'POLICY_VIOLATION: item off');
  perform t_expect(format('select pos_add_line(%L, %L, 0, null, ''l-5'')', v_o, t148('item')), 'POLICY_VIOLATION: quantity');
  perform t_expect(format('select pos_add_line(%L, %L, 101, null, ''l-6'')', v_o, t148('item')), 'POLICY_VIOLATION: quantity');
  perform t_expect(format('select pos_add_line(%L, %L, 1, %L, ''l-7'')', v_o, t148('item'), repeat('x', 101)), 'POLICY_VIOLATION: note');
  perform t_expect(format('select pos_add_line(%L, %L, 1, null, ''l-1'')', v_o, t148('item')), 'IDEMPOTENCY_MISMATCH');   -- the same key with other contents is refused

  -- a menu price change never alters a line already taken
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform pos_save_item(v_p, t148('item'), t148('cat'), 'Jollof rice', 999900, 1, true);
  perform t_as('00000000-0000-0000-0000-00000000aa31');
  d := pos_order_detail(v_o);
  if (d ->> 'subtotal_minor')::bigint <> 700000 + 600000 + 450000 or d ->> 'estimate' <> 'true' or d ->> 'status' <> 'open' then raise exception 'FAIL detail %', d; end if;
  if (d -> 'lines' -> 0 ->> 'unit_price_minor')::bigint <> 350000 then raise exception 'FAIL a menu price change moved a taken line: %', d -> 'lines'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform pos_save_item(v_p, t148('item'), t148('cat'), 'Jollof rice', 350000, 1, true);

  -- the kitchen: one step at a time
  perform t_as('00000000-0000-0000-0000-00000000aa31');
  v_jollof := t148_line(v_o, 'Jollof rice'); v_fish := t148_line(v_o, 'Grilled fish'); v_chapman := t148_line(v_o, 'Chapman');
  perform t_expect(format('select pos_set_line_status(%L, ''ready'')', v_jollof), 'INVALID_STATE');            -- cannot skip a step
  perform t_expect(format('select pos_set_line_status(%L, ''served'')', v_jollof), 'INVALID_STATE');
  perform t_expect(format('select pos_set_line_status(%L, ''boiling'')', v_jollof), 'POLICY_VIOLATION: status');
  perform pos_set_line_status(v_jollof, 'preparing');
  if (pos_set_line_status(v_jollof, 'preparing') ->> 'kitchen_status') <> 'preparing' then raise exception 'FAIL a repeat of the same status'; end if;
  perform pos_set_line_status(v_jollof, 'ready');
  perform pos_set_line_status(v_jollof, 'served');
  perform t_expect(format('select pos_set_line_status(%L, ''cancelled'')', v_jollof), 'INVALID_STATE');         -- served food cannot be cancelled
  perform t_expect(format('select pos_set_line_status(%L, ''preparing'')', v_jollof), 'INVALID_STATE');         -- and cannot go back
  perform pos_set_line_status(v_chapman, 'cancelled');
  perform t_expect(format('select pos_set_line_status(%L, ''preparing'')', v_chapman), 'INVALID_STATE');        -- a cancelled line stays cancelled
  d := pos_order_detail(v_o);
  if (d ->> 'subtotal_minor')::bigint <> 700000 + 600000 then raise exception 'FAIL a cancelled line is still in the bill: %', d; end if;
  if (select count(*) from jsonb_array_elements(pos_kitchen_queue(v_p)) q where q ->> 'order_id' = v_o::text) <> 1 then raise exception 'FAIL kitchen queue %', pos_kitchen_queue(v_p); end if;
  if (select q ->> 'name' from jsonb_array_elements(pos_kitchen_queue(v_p)) q where q ->> 'order_id' = v_o::text) <> 'Grilled fish' then raise exception 'FAIL queue content'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  if jsonb_array_length(pos_open_orders(v_p)) <> 1 or (pos_open_orders(v_p) -> 0 ->> 'subtotal_minor')::bigint <> 1300000 then raise exception 'FAIL open orders %', pos_open_orders(v_p); end if;
  perform t_expect(format('select pos_set_line_status(%L, ''preparing'')', v_fish), 'NOT_FOUND');              -- the accountant reads, never writes
  perform t_expect(format('select pos_open_order(%L, %L, null, ''acc-1'')', v_p, t148('place_t1')), 'NOT_FOUND');
  perform t_sys();
  insert into t148_ctx values ('order1', v_o::text), ('fish_line', v_fish::text);
  if t148_audits('pos_order.opened', v_o) <> 1 or (select count(*) from audit_logs where action = 'pos_order.line_added' and entity_id = v_o) <> 3 then raise exception 'FAIL order audit'; end if;
  raise notice 'PASS orders: idempotent open and add, a menu price change leaves taken lines alone, kitchen steps in order, served food stays, cancelled lines leave the bill, accountant reads only';
end $$;

-- 4. Direct writes are closed and a table payment ledger is read only by people who may see money
do $$ declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  begin insert into pos_items (tenant_id, property_id, category_id, name, price_minor) values ('00000000-0000-0000-0000-0000000000a1', v_p, t148('cat'), 'Sneaky', 100);
    raise exception 'FAIL an owner inserted an item directly'; exception when insufficient_privilege then null; end;
  begin update pos_orders set status = 'paid' where id = t148('order1'); raise exception 'FAIL an owner updated an order directly'; exception when insufficient_privilege then null; end;
  begin delete from pos_order_lines where order_id = t148('order1'); raise exception 'FAIL an owner deleted a line directly'; exception when insufficient_privilege then null; end;
  if (select count(*) from pos_orders) <> 1 then raise exception 'FAIL the owner should see the order'; end if;
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  if (select count(*) from pos_orders) + (select count(*) from pos_order_lines) + (select count(*) from pos_items) + (select count(*) from pos_places) <> 0 then raise exception 'FAIL another hotel reads POS rows'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  if (select count(*) from pos_orders) + (select count(*) from pos_items) <> 0 then raise exception 'FAIL housekeeping reads POS rows'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa31');
  if (select count(*) from pos_orders) <> 1 or (select count(*) from pos_order_lines) = 0 then raise exception 'FAIL the waiter should read orders'; end if;
  raise notice 'PASS access: no direct writes for anyone logged in, another hotel and housekeeping read nothing, the waiter reads orders';
end $$;

-- 5. Paid at the table: tax from the extras rules, frozen totals, one payment, no change to daily_report
do $$ declare
  v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; t date := property_today('00000000-0000-0000-0000-0000000000a2');
  r jsonb; r2 jsonb; v_o uuid := t148('order1'); d jsonb; v_before text;
begin
  perform t_sys();
  insert into tax_rules (tenant_id, property_id, name, basis, rate_value, effective_from, applies_to_charges)
  values ('00000000-0000-0000-0000-0000000000a1', v_p, 'VAT test', 'percent', 7.5, '2020-01-01', true);
  v_before := t148_report_row(t);
  perform t_as('00000000-0000-0000-0000-00000000aa31');
  perform t_expect(format('select pos_pay_order(%L, ''crypto'', null, ''p-0'')', v_o), 'POLICY_VIOLATION: payment method');
  perform t_expect(format('select pos_pay_order(%L, ''cash'', %L, ''p-0'')', v_o, repeat('r', 101)), 'POLICY_VIOLATION: reference');
  d := pos_order_detail(v_o);
  if (d ->> 'tax_minor')::bigint <> 97500 or (d ->> 'total_minor')::bigint <> 1397500 then raise exception 'FAIL the estimate should show 7.5 percent of 1,300,000: %', d; end if;
  r := pos_pay_order(v_o, 'cash', 'tbl-1', 'p-1');
  r2 := pos_pay_order(v_o, 'cash', 'tbl-1', 'p-1');
  if r <> r2 then raise exception 'FAIL a repeated pay answered differently'; end if;
  if (r ->> 'subtotal_minor')::bigint <> 1300000 or (r ->> 'tax_minor')::bigint <> 97500 or (r ->> 'total_minor')::bigint <> 1397500 or r ->> 'status' <> 'paid' then raise exception 'FAIL paid %', r; end if;
  perform t_expect(format('select pos_pay_order(%L, ''cash'', null, ''p-2'')', v_o), 'INVALID_STATE: paid');                  -- a second payment with another key
  perform t_expect(format('select pos_add_line(%L, %L, 1, null, ''l-late'')', v_o, t148('item')), 'INVALID_STATE: paid');
  perform t_expect(format('select pos_void_order(%L, ''oops'')', v_o), 'INVALID_STATE: paid');
  perform t_expect(format('select pos_post_to_room(%L, %L, ''pr-x'')', v_o, gen_random_uuid()), 'FORBIDDEN');                  -- the waiter has no folio.charge
  perform t_expect(format('select pos_set_line_status(%L, ''cancelled'')', t148('fish_line')), 'INVALID_STATE');           -- a settled bill cannot lose a line
  perform pos_set_line_status(t148('fish_line'), 'preparing');                                                                 -- but the food still moves
  d := pos_order_detail(v_o);
  if d ->> 'estimate' <> 'false' or d ->> 'payment_method' is distinct from 'cash' or (d ->> 'total_minor')::bigint <> 1397500 then raise exception 'FAIL settled detail %', d; end if;

  perform t_sys();
  if (select count(*) from pos_payments where order_id = v_o) <> 1 or (select amount_minor from pos_payments where order_id = v_o) <> 1397500 then raise exception 'FAIL payment row'; end if;
  -- a rule changed later never moves a settled bill
  update tax_rules set rate_value = 20 where name = 'VAT test';
  if (select total_minor from pos_orders where id = v_o) <> 1397500 then raise exception 'FAIL a tax change moved a settled bill'; end if;
  update tax_rules set rate_value = 7.5 where name = 'VAT test';
  -- final rows
  begin update pos_orders set total_minor = 1 where id = v_o; raise exception 'FAIL a settled order was edited'; exception when sqlstate 'P0001' then if sqlerrm <> 'POS order is final' then raise; end if; end;
  begin update pos_order_lines set quantity = 9 where order_id = v_o; raise exception 'FAIL a settled line was edited'; exception when sqlstate 'P0001' then if sqlerrm <> 'POS order is final' then raise; end if; end;
  begin update pos_payments set amount_minor = 1 where order_id = v_o; raise exception 'FAIL a payment was edited'; exception when sqlstate 'P0001' then null; end;
  begin delete from pos_payments where order_id = v_o; raise exception 'FAIL a payment was deleted'; exception when sqlstate 'P0001' then null; end;
  begin delete from pos_orders where id = v_o; raise exception 'FAIL an order was deleted'; exception when sqlstate 'P0001' then null; end;
  -- the money rule: a bill paid at the table is not in daily_report
  if t148_report_row(t) <> v_before then raise exception 'FAIL daily_report moved for a table payment: % vs %', v_before, t148_report_row(t); end if;
  if t148_audits('pos_order.paid', v_o) <> 1 then raise exception 'FAIL paid audit'; end if;
  raise notice 'PASS paid at the table: tax from the extras rules, totals frozen, replay and second payment handled, order, lines and payment final, daily_report untouched';
end $$;

-- 6. Posted to a room: needs folio.charge, a guest in the house; lands as an extra; replay does not charge twice
do $$ declare
  v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; t date := property_today('00000000-0000-0000-0000-0000000000a2');
  v_room text; v_book jsonb; v_rr uuid; v_res uuid; v_future uuid; v_o uuid; r jsonb; r2 jsonb; v_fc folio_charges%rowtype; v_before text; v_after record;
begin
  perform t_sys();
  v_room := t21_free_room();
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  v_book := t_book('00000000-0000-0000-0000-0000000000a3', t, t + 2, 'pos-res-0001', t21_room(v_room));
  v_rr := t_rr(v_book);
  v_res := (v_book ->> 'reservation_id')::uuid;
  v_future := ((t_book('00000000-0000-0000-0000-0000000000a3', t + 300, t + 301, 'pos-res-0002') ->> 'reservation_id'))::uuid;
  perform t_sys();
  v_before := t148_report_row(t);
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform check_in(v_rr, 'test');

  v_o := (pos_open_order(v_p, t148('place_bar'), null, 'o-room') ->> 'order_id')::uuid;
  perform pos_add_line(v_o, (select id from pos_items where name = 'Chapman'), 4, null, 'rl-1');         -- 600,000
  perform t_expect(format('select pos_post_to_room(%L, %L, ''pr-1'')', v_o, v_future), 'INVALID_STATE: guest not in house');
  perform t_expect(format('select pos_post_to_room(%L, %L, ''pr-1'')', v_o, gen_random_uuid()), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa31');
  perform t_expect(format('select pos_post_to_room(%L, %L, ''pr-1'')', v_o, v_res), 'FORBIDDEN');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select pos_post_to_room(%L, %L, ''pr-1'')', v_o, v_res), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r := pos_post_to_room(v_o, v_res, 'pr-1');
  r2 := pos_post_to_room(v_o, v_res, 'pr-1');
  if r <> r2 then raise exception 'FAIL a repeated post answered differently'; end if;
  if (r ->> 'subtotal_minor')::bigint <> 600000 or (r ->> 'tax_minor')::bigint <> 45000 or (r ->> 'total_minor')::bigint <> 645000 or r ->> 'status' <> 'posted' then raise exception 'FAIL posted %', r; end if;
  perform t_expect(format('select pos_post_to_room(%L, %L, ''pr-2'')', v_o, v_res), 'INVALID_STATE: posted');
  perform t_expect(format('select pos_pay_order(%L, ''cash'', null, ''pp-1'')', v_o), 'INVALID_STATE: posted');
  perform t_sys();
  select * into v_fc from folio_charges where reservation_id = v_res;
  if (select count(*) from folio_charges where reservation_id = v_res) <> 1 then raise exception 'FAIL one post made % folio charges', (select count(*) from folio_charges where reservation_id = v_res); end if;
  if v_fc.category <> 'food_beverage' or v_fc.total_minor <> 645000 or v_fc.tax_minor <> 45000 or v_fc.description not like 'Restaurant POS-%(Bar)' or v_fc.status <> 'posted' then raise exception 'FAIL folio charge %', to_jsonb(v_fc); end if;
  if (select folio_charge_id from pos_orders where id = v_o) <> v_fc.id or (select reservation_id from pos_orders where id = v_o) <> v_res then raise exception 'FAIL order is not tied to the charge'; end if;
  -- it is an extra in daily_report and nothing else moved
  select extras_minor, extras_tax_minor, cash_in_minor into v_after from daily_report(v_p, t, t) limit 1;
  if (v_after.extras_minor - (v_before::jsonb ->> 'extras_minor')::bigint) <> 600000 or (v_after.extras_tax_minor - (v_before::jsonb ->> 'extras_tax_minor')::bigint) <> 45000
     or v_after.cash_in_minor <> (v_before::jsonb ->> 'cash_in_minor')::bigint then
    raise exception 'FAIL daily_report: extras should rise by 600,000 and tax by 45,000 and cash in not at all (% vs %)', to_jsonb(v_after), v_before;
  end if;
  -- the guest's own booking money is untouched
  if (select count(*) from invoices where reservation_id = v_res) <> 0 or (select count(*) from payments where reservation_id = v_res) <> 0 then raise exception 'FAIL booking invoices or payments moved'; end if;
  begin update pos_orders set total_minor = 1 where id = v_o; raise exception 'FAIL a posted order was edited'; exception when sqlstate 'P0001' then null; end;
  insert into t148_ctx values ('order2', v_o::text), ('res', v_res::text);
  if t148_audits('pos_order.posted_to_room', v_o) <> 1 then raise exception 'FAIL posted audit'; end if;
  raise notice 'PASS posted to a room: folio.charge needed, guest must be in the house, one extra with the folio tax, replay safe, daily_report moves only in extras, booking money untouched';
end $$;

-- 7. Void: an untouched order by pos.sell, a started one only by pos.manage, never a settled one
do $$ declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_a uuid; v_b uuid; v_l uuid; r jsonb; begin
  perform t_as('00000000-0000-0000-0000-00000000aa31');
  v_a := (pos_open_order(v_p, t148('place_t1'), null, 'v-1') ->> 'order_id')::uuid;
  perform pos_add_line(v_a, t148('item'), 1, null, 'v-l1');
  v_b := (pos_open_order(v_p, t148('place_t1'), null, 'v-2') ->> 'order_id')::uuid;
  v_l := (pos_add_line(v_b, t148('item'), 1, null, 'v-l2') ->> 'line_id')::uuid;
  perform pos_set_line_status(v_l, 'preparing');
  perform t_expect(format('select pos_void_order(%L, '''')', v_a), 'POLICY_VIOLATION: reason');
  perform t_expect(format('select pos_void_order(%L, %L)', v_a, repeat('x', 201)), 'POLICY_VIOLATION: reason');
  r := pos_void_order(v_a, 'wrong table');
  if r ->> 'status' <> 'void' then raise exception 'FAIL void %', r; end if;
  if (pos_void_order(v_a, 'wrong table') ->> 'status') <> 'void' then raise exception 'FAIL a repeated void'; end if;
  perform t_expect(format('select pos_add_line(%L, %L, 1, null, ''v-l3'')', v_a, t148('item')), 'INVALID_STATE: void');
  perform t_expect(format('select pos_void_order(%L, ''guest left'')', v_b), 'NOT_FOUND');                       -- food was started: needs pos.manage
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select pos_void_order(%L, ''guest left'')', v_b), 'NOT_FOUND');                       -- the front desk sells but does not manage
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform pos_void_order(v_b, 'guest left');
  if (select status from pos_orders where id = v_b) <> 'void' then raise exception 'FAIL manager void'; end if;
  if exists (select 1 from jsonb_array_elements(pos_kitchen_queue(v_p)) q where q ->> 'order_id' in (v_a::text, v_b::text)) then raise exception 'FAIL a void order is in the kitchen queue'; end if;
  perform t_expect(format('select pos_set_line_status(%L, ''ready'')', v_l), 'INVALID_STATE: void');
  perform t_sys();
  if (select total_minor from pos_orders where id = v_b) <> 0 then raise exception 'FAIL a void order should total 0'; end if;
  if t148_audits('pos_order.voided', v_b) <> 1 or (select (metadata ->> 'food_started')::boolean from audit_logs where action = 'pos_order.voided' and entity_id = v_b) is not true then raise exception 'FAIL void audit'; end if;
  raise notice 'PASS void: untouched orders by pos.sell, started ones by pos.manage only, settled ones never, void orders leave the kitchen queue';
end $$;

-- 8. Report: settled orders by hotel day, by method, top items, who may read it
do $$ declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; t date := property_today('00000000-0000-0000-0000-0000000000a2'); r jsonb; begin
  perform t_as('00000000-0000-0000-0000-00000000aa31');
  perform t_expect(format('select pos_sales_report(%L, %L, %L)', v_p, t, t), 'NOT_FOUND');                      -- the waiter has no report.view
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select pos_sales_report(%L, %L, %L)', v_p, t, t), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa05');                                                         -- the accountant: pos.view and report.view
  r := pos_sales_report(v_p, t, t);
  if (r #>> '{totals,table_orders}')::int <> 1 or (r #>> '{totals,table_total_minor}')::bigint <> 1397500 or (r #>> '{totals,table_tax_minor}')::bigint <> 97500
     or (r #>> '{totals,room_orders}')::int <> 1 or (r #>> '{totals,room_total_minor}')::bigint <> 645000 or (r #>> '{totals,room_subtotal_minor}')::bigint <> 600000 then
    raise exception 'FAIL totals %', r -> 'totals';
  end if;
  if r ->> 'voided_orders' <> '2' then raise exception 'FAIL voided count %', r ->> 'voided_orders'; end if;
  if jsonb_array_length(r -> 'by_day') <> 1 or (r #>> '{by_day,0,orders}')::int <> 2 then raise exception 'FAIL by day %', r -> 'by_day'; end if;
  if jsonb_array_length(r -> 'table_by_method') <> 1 or r #>> '{table_by_method,0,method}' <> 'cash' or (r #>> '{table_by_method,0,total_minor}')::bigint <> 1397500 then raise exception 'FAIL methods %', r -> 'table_by_method'; end if;
  -- Jollof 2 x 3,500 = 7,000; Chapman 4 x 1,500 = 6,000 (the 3 on the paid bill were cancelled); fish 6,000; ties sort by name
  if r #>> '{top_items,0,name}' <> 'Jollof rice' or (r #>> '{top_items,0,quantity}')::int <> 2 or r #>> '{top_items,1,name}' <> 'Chapman' or (r #>> '{top_items,1,quantity}')::int <> 4 then
    raise exception 'FAIL top items %', r -> 'top_items';
  end if;
  if (select sum((e ->> 'sales_minor')::bigint) from jsonb_array_elements(r -> 'top_items') e) <> 1300000 + 600000 then raise exception 'FAIL item sales do not add up to the bills'' subtotals'; end if;
  perform t_expect(format('select pos_sales_report(%L, %L, %L)', v_p, t, t - 1), 'POLICY_VIOLATION: dates');
  perform t_expect(format('select pos_sales_report(%L, %L, %L)', v_p, t - 400, t), 'POLICY_VIOLATION: dates');
  if (pos_sales_report(v_p, t - 10, t - 5) #>> '{totals,table_orders}')::int <> 0 then raise exception 'FAIL an empty window'; end if;
  -- the payment ledger rows are visible to the accountant but not to the waiter
  if (select count(*) from pos_payments) <> 1 then raise exception 'FAIL the accountant should read the payment'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa31');
  if (select count(*) from pos_payments) <> 0 then raise exception 'FAIL the waiter reads the payment ledger'; end if;
  raise notice 'PASS report: table and room sales apart, by day and method, top items add up, voids counted, report.view needed, ledger rows only for people who see money';
end $$;

-- 9. The flag: with restaurant_pos off nothing is written, everything can still be read
do $$ declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_t constant uuid := '00000000-0000-0000-0000-0000000000a1'; v_o uuid; begin
  perform t_sys();
  insert into tenant_feature_entitlements (tenant_id, feature_key, enabled) values (v_t, 'restaurant_pos', false);
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select pos_save_category(%L, null, ''Desserts'', 3, true)', v_p), 'POLICY_VIOLATION: restaurant pos off');
  perform t_as('00000000-0000-0000-0000-00000000aa31');
  perform t_expect(format('select pos_open_order(%L, %L, null, ''flag-1'')', v_p, t148('place_t1')), 'POLICY_VIOLATION: restaurant pos off');
  perform t_expect(format('select pos_pay_order(%L, ''cash'', null, ''flag-2'')', t148('order1')), 'POLICY_VIOLATION: restaurant pos off');
  if jsonb_array_length(pos_menu(v_p) -> 'items') <> 5 or pos_order_detail(t148('order1')) ->> 'status' <> 'paid' then raise exception 'FAIL reads with the flag off'; end if;
  perform t_sys();
  update tenant_feature_entitlements set enabled = true where tenant_id = v_t and feature_key = 'restaurant_pos';
  perform t_as('00000000-0000-0000-0000-00000000aa31');
  v_o := (pos_open_order(v_p, t148('place_t1'), null, 'flag-3') ->> 'order_id')::uuid;
  perform pos_void_order(v_o, 'flag test');
  perform t_sys();
  delete from tenant_feature_entitlements where tenant_id = v_t and feature_key = 'restaurant_pos';
  delete from tax_rules where name = 'VAT test';
  raise notice 'PASS flag: off refuses every write and still lets the menu and orders be read; on again, writes work';
end $$;

-- 10. A deleted login is cleared from the people columns without touching a settled order
do $$ begin
  perform t_sys();
  delete from auth.users where id = '00000000-0000-0000-0000-00000000aa31';
  if (select count(*) from pos_orders where status = 'paid' and opened_by is null) <> 1 then raise exception 'FAIL the people columns were not cleared for a deleted login'; end if;
  if (select total_minor from pos_orders where id = t148('order1')) <> 1397500 then raise exception 'FAIL deleting a login changed a settled order'; end if;
  raise notice 'PASS deleted login: its name leaves the order, the bill stays as it was';
end $$;
