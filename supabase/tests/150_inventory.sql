-- Stock and purchasing (migration 150). Reuses t_as / t_sys / t_expect / t_book / t_rr (05) and t21_free_room / t21_room (21).
-- Users: aa01 owner A (all inventory permissions), aa02 housekeeping A (inventory.view and inventory.use), aa04 front desk A (view and use, not manage),
-- aa05 accountant A (view, report.view), bb01 owner of Hotel B. Ids: a1 tenant A, a2 property A, a3 the STD room type.
\set ON_ERROR_STOP on

create table t149_ctx (label text primary key, val text not null);
create function t149(p_label text) returns uuid language sql stable as $$ select val::uuid from t149_ctx where label = p_label $$;
create function t149_audits(p_action text, p_entity uuid) returns bigint language sql stable as $$ select count(*) from audit_logs where action = p_action and entity_id = p_entity $$;
create function t149_qty(p_name text) returns numeric language sql stable as $$ select quantity from stock_items where name = p_name and property_id = '00000000-0000-0000-0000-0000000000a2' $$;

-- 1. Grants and flag
do $$ declare v_n integer; begin
  perform t_sys();
  select count(*) into v_n from role_permissions rp join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id
   where p.key = 'inventory.view' and r.is_system and r.key in ('owner', 'general_manager', 'front_desk', 'accountant', 'housekeeping');
  if v_n <> 5 then raise exception 'FAIL inventory.view grants (%)', v_n; end if;
  select count(*) into v_n from role_permissions rp join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id
   where p.key = 'inventory.use' and r.is_system and r.key in ('owner', 'general_manager', 'front_desk', 'housekeeping');
  if v_n <> 4 then raise exception 'FAIL inventory.use grants (%)', v_n; end if;
  select count(*) into v_n from role_permissions rp join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id
   where p.key = 'inventory.manage' and r.is_system and r.key in ('owner', 'general_manager');
  if v_n <> 2 then raise exception 'FAIL inventory.manage grants (%)', v_n; end if;
  if exists (select 1 from role_permissions rp join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id
              where p.key in ('inventory.use', 'inventory.manage') and r.is_system and r.key = 'accountant') then raise exception 'FAIL the accountant can change stock'; end if;
  if not ('inventory' = any (plan_enforced_flags())) then raise exception 'FAIL inventory is not an enforced flag'; end if;
  if not (select 'inventory' = any (features) from plans where code = 'pro') or (select 'inventory' = any (features) from plans where code = 'starter') then raise exception 'FAIL plan features'; end if;
  raise notice 'PASS grants: view for five roles, use for four, manage for two; inventory is enforced and on the pro plan only';
end $$;

-- 2. Items and suppliers: who may write, what is accepted
do $$ declare
  v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; r jsonb;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select stock_save_item(%L, null, ''Rice'', ''kg'', ''food'', 5, true)', v_p), 'NOT_FOUND');        -- use is not manage
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform t_expect(format('select stock_save_supplier(%L, null, ''Mama Put'', null, null, true)', v_p), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select stock_save_item(%L, null, ''Rice'', ''kg'', ''food'', 5, true)', v_p), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select stock_save_item(%L, null, '''', ''kg'', ''food'', 5, true)', v_p), 'POLICY_VIOLATION: name');
  perform t_expect(format('select stock_save_item(%L, null, ''Rice'', '''', ''food'', 5, true)', v_p), 'POLICY_VIOLATION: unit');
  perform t_expect(format('select stock_save_item(%L, null, ''Rice'', ''kg'', ''gold'', 5, true)', v_p), 'POLICY_VIOLATION: kind');
  perform t_expect(format('select stock_save_item(%L, null, ''Rice'', ''kg'', ''food'', -1, true)', v_p), 'POLICY_VIOLATION: low level');
  r := stock_save_item(v_p, null, 'Rice', 'kg', 'food', 5, true);
  insert into t149_ctx values ('rice', r ->> 'item_id');
  insert into t149_ctx values ('oil', stock_save_item(v_p, null, 'Palm oil', 'l', 'food', 2, true) ->> 'item_id');
  insert into t149_ctx values ('soap', stock_save_item(v_p, null, 'Soap bar', 'piece', 'toiletries', 10, true) ->> 'item_id');
  perform t_expect(format('select stock_save_item(%L, null, ''rice'', ''kg'', ''food'', 5, true)', v_p), 'POLICY_VIOLATION: name taken');
  perform stock_save_item(v_p, t149('rice'), 'Rice', 'kg', 'food', 5.5, true);
  if (select low_level from stock_items where id = t149('rice')) <> 5.5 then raise exception 'FAIL edit'; end if;
  perform stock_save_item(v_p, t149('rice'), 'Rice', 'kg', 'food', 5, true);
  perform t_expect(format('select stock_save_item(%L, %L, ''X'', ''kg'', ''food'', 5, true)', v_p, gen_random_uuid()), 'NOT_FOUND');
  insert into t149_ctx values ('sup', stock_save_supplier(v_p, null, 'Mama Put', '0803', 'rice and oil', true) ->> 'supplier_id');
  insert into t149_ctx values ('sup_off', stock_save_supplier(v_p, null, 'Closed Ltd', null, null, false) ->> 'supplier_id');
  perform t_expect(format('select stock_save_supplier(%L, null, ''mama put'', null, null, true)', v_p), 'POLICY_VIOLATION: name taken');
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  if (select count(*) from stock_items) <> 3 or (select count(*) from stock_suppliers) <> 2 then raise exception 'FAIL housekeeping should read items and suppliers'; end if;
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  if (select count(*) from stock_items) <> 0 then raise exception 'FAIL hotel B reads hotel A stock'; end if;
  perform t_sys();
  if t149_audits('stock_item.saved', t149('rice')) <> 3 then raise exception 'FAIL item audits %', t149_audits('stock_item.saved', t149('rice')); end if;
  raise notice 'PASS setup: manage only, names unique ignoring case, bad values refused, hotels apart, every save audited';
end $$;

-- 3. Purchases
do $$ declare
  v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; r jsonb; r2 jsonb; v_lines jsonb;
begin
  v_lines := jsonb_build_array(jsonb_build_object('item', t149('rice'), 'quantity', 20, 'unit_cost_minor', 120000), jsonb_build_object('item', t149('oil'), 'quantity', 10, 'unit_cost_minor', 250000));
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select stock_record_purchase(%L, null, ''INV-1'', null, %L::jsonb, ''pu-0'')', v_p, v_lines), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select stock_record_purchase(%L, null, ''INV-1'', null, %L::jsonb, ''pu-0'')', v_p, v_lines), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select stock_record_purchase(%L, null, null, null, ''[]''::jsonb, ''pu-1'')', v_p), 'POLICY_VIOLATION: lines');
  perform t_expect(format('select stock_record_purchase(%L, null, null, null, ''{}''::jsonb, ''pu-1'')', v_p), 'POLICY_VIOLATION: lines');
  perform t_expect(format('select stock_record_purchase(%L, %L, null, null, %L::jsonb, ''pu-1'')', v_p, t149('sup_off'), v_lines), 'POLICY_VIOLATION: supplier');
  perform t_expect(format('select stock_record_purchase(%L, %L, null, null, %L::jsonb, ''pu-1'')', v_p, gen_random_uuid(), v_lines), 'POLICY_VIOLATION: supplier');
  perform t_expect(format('select stock_record_purchase(%L, null, null, null, %L::jsonb, ''pu-1'')', v_p,
    jsonb_build_array(jsonb_build_object('item', t149('rice'), 'quantity', 0, 'unit_cost_minor', 1))), 'POLICY_VIOLATION: line');
  perform t_expect(format('select stock_record_purchase(%L, null, null, null, %L::jsonb, ''pu-1'')', v_p,
    jsonb_build_array(jsonb_build_object('item', t149('rice'), 'quantity', 1, 'unit_cost_minor', -5))), 'POLICY_VIOLATION: line');
  perform t_expect(format('select stock_record_purchase(%L, null, null, null, %L::jsonb, ''pu-1'')', v_p,
    jsonb_build_array(jsonb_build_object('item', t149('rice'), 'quantity', 1, 'unit_cost_minor', 1), jsonb_build_object('item', t149('rice'), 'quantity', 2, 'unit_cost_minor', 1))), 'POLICY_VIOLATION: line');
  perform t_expect(format('select stock_record_purchase(%L, null, null, null, %L::jsonb, ''pu-1'')', v_p,
    jsonb_build_array(jsonb_build_object('item', gen_random_uuid(), 'quantity', 1, 'unit_cost_minor', 1))), 'POLICY_VIOLATION: item');
  perform t_expect(format('select stock_record_purchase(%L, null, null, null, %L::jsonb, ''pu-1'')', v_p, '[{"quantity": 1}]'), 'POLICY_VIOLATION: line');
  if t149_qty('Rice') <> 0 then raise exception 'FAIL a refused purchase moved stock'; end if;

  r := stock_record_purchase(v_p, t149('sup'), 'INV-1', 'first delivery', v_lines, 'pu-1');
  r2 := stock_record_purchase(v_p, t149('sup'), 'INV-1', 'first delivery', v_lines, 'pu-1');
  if r <> r2 then raise exception 'FAIL a repeated purchase answered differently'; end if;
  if (r ->> 'total_minor')::bigint <> 4900000 or (r ->> 'lines')::int <> 2 then raise exception 'FAIL purchase %', r; end if;
  insert into t149_ctx values ('purchase1', r ->> 'purchase_id');
  if t149_qty('Rice') <> 20 or t149_qty('Palm oil') <> 10 then raise exception 'FAIL stock after a purchase'; end if;
  if (select count(*) from stock_purchases) <> 1 or (select count(*) from stock_movements where kind = 'purchase') <> 2 then raise exception 'FAIL a repeat wrote twice'; end if;
  if (select balance_after from stock_movements where item_id = t149('rice') and kind = 'purchase') <> 20 then raise exception 'FAIL balance_after'; end if;
  -- fractional quantity: 2.5 x 12,000 = 30,000
  r := stock_record_purchase(v_p, null, null, null, jsonb_build_array(jsonb_build_object('item', t149('soap'), 'quantity', 50, 'unit_cost_minor', 30000)), 'pu-2');
  if (r ->> 'total_minor')::bigint <> 1500000 or t149_qty('Soap bar') <> 50 then raise exception 'FAIL second purchase'; end if;
  r := stock_record_purchase(v_p, null, null, null, jsonb_build_array(jsonb_build_object('item', t149('oil'), 'quantity', 2.5, 'unit_cost_minor', 12000)), 'pu-3');
  if (r ->> 'total_minor')::bigint <> 30000 or t149_qty('Palm oil') <> 12.5 then raise exception 'FAIL fractional purchase %', r; end if;
  -- oil back to 10 for later arithmetic: a count (checked in block 5)
  perform t_sys();
  if t149_audits('stock_purchase.recorded', t149('purchase1')) <> 1 then raise exception 'FAIL purchase audit'; end if;
  raise notice 'PASS purchases: manage only, every line checked before any is written, replay-safe, totals rounded, stock and ledger agree';
end $$;

-- 4. Usage and wastage
do $$ declare r jsonb; r2 jsonb; begin
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  perform t_expect(format('select stock_record_out(%L, ''usage'', 1, ''minibar'', null, ''u-0'')', t149('soap')), 'NOT_FOUND');        -- view only
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select stock_record_out(%L, ''usage'', 1, ''minibar'', null, ''u-0'')', t149('soap')), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform t_expect(format('select stock_record_out(%L, ''usage'', 1, ''party'', null, ''u-1'')', t149('soap')), 'POLICY_VIOLATION: reason');
  perform t_expect(format('select stock_record_out(%L, ''waste'', 1, ''toiletries'', null, ''u-1'')', t149('soap')), 'POLICY_VIOLATION: reason');
  perform t_expect(format('select stock_record_out(%L, ''sale'', 1, ''other'', null, ''u-1'')', t149('soap')), 'POLICY_VIOLATION: kind');
  perform t_expect(format('select stock_record_out(%L, ''usage'', 0, ''other'', null, ''u-1'')', t149('soap')), 'POLICY_VIOLATION: quantity');
  perform t_expect(format('select stock_record_out(%L, ''usage'', -2, ''other'', null, ''u-1'')', t149('soap')), 'POLICY_VIOLATION: quantity');
  perform t_expect(format('select stock_record_out(%L, ''usage'', 51, ''toiletries'', null, ''u-1'')', t149('soap')), 'POLICY_VIOLATION: not enough stock');
  perform t_expect(format('select stock_record_out(%L, ''usage'', 1, ''other'', null, ''u-1'')', gen_random_uuid()), 'NOT_FOUND');
  if t149_qty('Soap bar') <> 50 then raise exception 'FAIL a refused use moved stock'; end if;
  r := stock_record_out(t149('soap'), 'usage', 8, 'toiletries', 'floor 2', 'u-2');
  r2 := stock_record_out(t149('soap'), 'usage', 8, 'toiletries', 'floor 2', 'u-2');
  if r <> r2 or (r ->> 'balance')::numeric <> 42 or t149_qty('Soap bar') <> 42 then raise exception 'FAIL usage % %', r, r2; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform stock_record_out(t149('rice'), 'waste', 1.5, 'spoiled', null, 'w-1');
  if t149_qty('Rice') <> 18.5 then raise exception 'FAIL waste'; end if;
  perform t_sys();
  if (select count(*) from stock_movements where kind = 'usage') <> 1 or (select count(*) from stock_movements where kind = 'waste' and reason = 'spoiled') <> 1 then raise exception 'FAIL ledger kinds'; end if;
  if (select count(*) from audit_logs where action in ('stock.usage', 'stock.waste')) <> 2 then raise exception 'FAIL use audits'; end if;
  raise notice 'PASS usage and waste: use or manage, a reason from the list, never below zero, replay-safe, ledger and audit written';
end $$;

-- 5. Counts
do $$ declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; r jsonb; v_c jsonb; begin
  v_c := jsonb_build_array(jsonb_build_object('item', t149('rice'), 'counted', 18), jsonb_build_object('item', t149('oil'), 'counted', 10), jsonb_build_object('item', t149('soap'), 'counted', 40));
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  perform t_expect(format('select stock_count(%L, %L::jsonb, null, ''c-0'')', v_p, v_c), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform t_expect(format('select stock_count(%L, ''[]''::jsonb, null, ''c-1'')', v_p), 'POLICY_VIOLATION: lines');
  perform t_expect(format('select stock_count(%L, %L::jsonb, null, ''c-1'')', v_p, jsonb_build_array(jsonb_build_object('item', t149('rice'), 'counted', -1))), 'POLICY_VIOLATION: line');
  perform t_expect(format('select stock_count(%L, %L::jsonb, null, ''c-1'')', v_p, jsonb_build_array(jsonb_build_object('item', gen_random_uuid(), 'counted', 1))), 'POLICY_VIOLATION: item');
  perform t_expect(format('select stock_count(%L, %L::jsonb, null, ''c-1'')', v_p, jsonb_build_array(jsonb_build_object('item', t149('rice'), 'counted', 1), jsonb_build_object('item', t149('rice'), 'counted', 2))), 'POLICY_VIOLATION: line');
  if t149_qty('Rice') <> 18.5 then raise exception 'FAIL a refused count moved stock'; end if;
  r := stock_count(v_p, v_c, 'month end', 'c-2');
  if r <> stock_count(v_p, v_c, 'month end', 'c-2') then raise exception 'FAIL a repeated count answered differently'; end if;
  if (r ->> 'counted')::int <> 3 or jsonb_array_length(r -> 'differences') <> 3 then raise exception 'FAIL count %', r; end if;   -- oil was 12.5, counted 10
  if t149_qty('Rice') <> 18 or t149_qty('Palm oil') <> 10 or t149_qty('Soap bar') <> 40 then raise exception 'FAIL counted quantities'; end if;
  if (select count(*) from stock_movements where kind = 'count') <> 3 or (select sum(change) from stock_movements where kind = 'count' and item_id = t149('oil')) <> -2.5 then raise exception 'FAIL count ledger'; end if;
  -- counting an item that is already right writes no movement
  r := stock_count(v_p, v_c, null, 'c-3');
  if jsonb_array_length(r -> 'differences') <> 0 or (select count(*) from stock_movements where kind = 'count') <> 3 then raise exception 'FAIL an unchanged count wrote movements'; end if;
  raise notice 'PASS counts: use or manage, set the quantity, only differences reach the ledger, bad lines refuse everything, replay-safe';
end $$;

-- 6. Guards and visibility of money
do $$ begin
  perform t_sys();
  begin update stock_items set quantity = 999 where id = t149('rice'); raise exception 'FAIL quantity edited directly'; exception when sqlstate 'P0001' then if sqlerrm not like 'stock quantity%' then raise; end if; end;
  begin update stock_movements set change = 1 where kind = 'usage'; raise exception 'FAIL ledger edited'; exception when sqlstate 'P0001' then null; end;
  begin delete from stock_movements where kind = 'usage'; raise exception 'FAIL ledger deleted'; exception when sqlstate 'P0001' then null; end;
  begin update stock_purchases set total_minor = 1; raise exception 'FAIL purchase edited'; exception when sqlstate 'P0001' then null; end;
  begin delete from stock_purchase_lines; raise exception 'FAIL purchase line deleted'; exception when sqlstate 'P0001' then null; end;
  begin delete from stock_items where id = t149('rice'); raise exception 'FAIL item deleted'; exception when sqlstate 'P0001' then null; end;
  -- the name and unit may still change
  update stock_items set unit = 'kg' where id = t149('rice');
  -- the quantity on hand equals the sum of the ledger for every item
  if exists (select 1 from stock_items i where i.quantity <> (select coalesce(sum(change), 0) from stock_movements m where m.item_id = i.id)) then raise exception 'FAIL quantity does not match the ledger'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  if (select count(*) from stock_purchases) <> 0 or (select count(*) from stock_purchase_lines) <> 0 then raise exception 'FAIL housekeeping reads what stock cost'; end if;
  if (select count(*) from stock_movements) = 0 then raise exception 'FAIL housekeeping should read movements'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  if (select count(*) from stock_purchases) <> 3 then raise exception 'FAIL the owner should read purchases'; end if;
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  if (select count(*) from stock_movements) <> 0 or (select count(*) from stock_purchases) <> 0 then raise exception 'FAIL hotel B reads hotel A'; end if;
  raise notice 'PASS guards: quantity moves only through movements, the ledger and purchases are final, ledger always sums to the quantity, costs hidden without money access';
end $$;

-- 7. POS link: recipes, deduction on pay and on posting to a room, negative allowed on sale, voids and cancelled lines excluded
do $$ declare
  v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; t date := property_today('00000000-0000-0000-0000-0000000000a2');
  v_cat uuid; v_item uuid; v_place uuid; v_o uuid; v_l uuid; r jsonb; v_room text; v_book jsonb; v_rr uuid; v_res uuid;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select stock_set_recipe(%L, ''[]''::jsonb)', gen_random_uuid()), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  v_cat := (pos_save_category(v_p, null, 'T149 mains', 1, true) ->> 'category_id')::uuid;
  v_item := (pos_save_item(v_p, null, v_cat, 'T149 plate', 500000, 1, true) ->> 'item_id')::uuid;
  v_place := (pos_save_place(v_p, null, 'T149 table', 'table', true) ->> 'place_id')::uuid;
  insert into t149_ctx values ('pos_item', v_item::text), ('place', v_place::text);
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select stock_set_recipe(%L, ''[]''::jsonb)', v_item), 'NOT_FOUND');                                    -- use is not manage
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select stock_set_recipe(%L, ''[{"item": "%s", "quantity": 0}]''::jsonb)', v_item, t149('rice')), 'POLICY_VIOLATION: line');
  perform t_expect(format('select stock_set_recipe(%L, ''[{"item": "%s", "quantity": 1}, {"item": "%s", "quantity": 1}]''::jsonb)', v_item, t149('rice'), t149('rice')), 'POLICY_VIOLATION: line');
  perform t_expect(format('select stock_set_recipe(%L, ''[{"item": "%s", "quantity": 1}]''::jsonb)', v_item, gen_random_uuid()), 'POLICY_VIOLATION: item');
  r := stock_set_recipe(v_item, format('[{"item": "%s", "quantity": 0.3}, {"item": "%s", "quantity": 0.1}]', t149('rice'), t149('oil'))::jsonb);
  if (r ->> 'lines')::int <> 2 or (select count(*) from pos_item_stock where pos_item_id = v_item) <> 2 then raise exception 'FAIL recipe %', r; end if;

  -- paid at the table: 3 plates and 1 that was cancelled
  v_o := (pos_open_order(v_p, v_place, null, 't149-o1') ->> 'order_id')::uuid;
  perform pos_add_line(v_o, v_item, 3, null, 't149-l1');
  v_l := (pos_add_line(v_o, v_item, 1, null, 't149-l2') ->> 'line_id')::uuid;
  perform pos_set_line_status(v_l, 'cancelled');
  perform pos_pay_order(v_o, 'cash', null, 't149-p1');
  if t149_qty('Rice') <> 17.1 or t149_qty('Palm oil') <> 9.7 then raise exception 'FAIL stock after a table sale: % %', t149_qty('Rice'), t149_qty('Palm oil'); end if;
  if (select count(*) from stock_movements where order_id = v_o and kind = 'sale') <> 2 then raise exception 'FAIL sale rows'; end if;
  perform pos_pay_order(v_o, 'cash', null, 't149-p1');                                         -- a replay settles nothing twice
  if t149_qty('Rice') <> 17.1 then raise exception 'FAIL a replayed payment deducted twice'; end if;

  -- posted to a room
  perform t_sys();
  v_room := t21_free_room();
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  v_book := t_book('00000000-0000-0000-0000-0000000000a3', t, t + 2, 't149-res-1', t21_room(v_room));
  v_rr := t_rr(v_book);
  v_res := (v_book ->> 'reservation_id')::uuid;
  perform check_in(v_rr, 'test');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  v_o := (pos_open_order(v_p, v_place, null, 't149-o2') ->> 'order_id')::uuid;
  perform pos_add_line(v_o, v_item, 2, null, 't149-l3');
  perform pos_post_to_room(v_o, v_res, 't149-pr1');
  if t149_qty('Rice') <> 16.5 or t149_qty('Palm oil') <> 9.5 then raise exception 'FAIL stock after a room sale'; end if;

  -- a void bill never settled, so nothing moves
  v_o := (pos_open_order(v_p, v_place, null, 't149-o3') ->> 'order_id')::uuid;
  perform pos_add_line(v_o, v_item, 5, null, 't149-l4');
  perform pos_void_order(v_o, 'guest left');
  if t149_qty('Rice') <> 16.5 then raise exception 'FAIL a void bill took stock'; end if;

  -- a sale may take the balance below zero, and the item then shows as low
  v_o := (pos_open_order(v_p, v_place, null, 't149-o4') ->> 'order_id')::uuid;
  perform pos_add_line(v_o, v_item, 100, null, 't149-l5');
  perform pos_pay_order(v_o, 'cash', null, 't149-p4');
  if t149_qty('Rice') <> -13.5 or t149_qty('Palm oil') <> -0.5 then raise exception 'FAIL negative sale balance: % %', t149_qty('Rice'), t149_qty('Palm oil'); end if;
  -- ... and usage still cannot go further below zero
  perform t_expect(format('select stock_record_out(%L, ''waste'', 1, ''spoiled'', null, ''t149-w'')', t149('rice')), 'POLICY_VIOLATION: not enough stock');
  -- an item with no recipe moves nothing
  perform t_sys();
  if exists (select 1 from stock_items i where i.quantity <> (select coalesce(sum(change), 0) from stock_movements m where m.item_id = i.id)) then raise exception 'FAIL quantity does not match the ledger after sales'; end if;
  begin insert into stock_movements (tenant_id, property_id, item_id, kind, change, balance_after, order_id)
        select tenant_id, property_id, item_id, 'sale', -1, 0, order_id from stock_movements where kind = 'sale' limit 1;
        raise exception 'FAIL a second sale row for one order and item'; exception when unique_violation then null; end;
  raise notice 'PASS pos link: recipes by manage, table and room bills deduct once, cancelled lines and voids never, sales may go negative, ledger still sums';
end $$;

-- 8. Report
do $$ declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; t date := property_today('00000000-0000-0000-0000-0000000000a2'); r jsonb; e jsonb; begin
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform t_expect(format('select stock_report(%L, %L, %L)', v_p, t, t), 'NOT_FOUND');                                           -- no report.view
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select stock_report(%L, %L, %L)', v_p, t, t), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  r := stock_report(v_p, t, t);
  select x into e from jsonb_array_elements(r -> 'items') x where x ->> 'name' = 'Rice';
  -- sold 0.9 + 0.6 + 30 = 31.5; wasted 1.5 at 120,000 = 180,000; count -0.5; bought 20
  if (e ->> 'bought')::numeric <> 20 or (e ->> 'sold')::numeric <> 31.5 or (e ->> 'wasted')::numeric <> 1.5 or (e ->> 'count_difference')::numeric <> -0.5
     or (e ->> 'on_hand')::numeric <> -13.5 or (e ->> 'low')::boolean is not true or (e ->> 'waste_value_minor')::bigint <> 180000 or (e ->> 'spent_minor')::bigint <> 2400000 then
    raise exception 'FAIL rice row %', e;
  end if;
  select x into e from jsonb_array_elements(r -> 'items') x where x ->> 'name' = 'Soap bar';
  if (e ->> 'used')::numeric <> 8 or (e ->> 'on_hand')::numeric <> 40 or (e ->> 'low')::boolean is not false then raise exception 'FAIL soap row %', e; end if;
  if (r ->> 'spent_minor')::bigint <> 4900000 + 1500000 + 30000 then raise exception 'FAIL total spent %', r ->> 'spent_minor'; end if;
  perform t_expect(format('select stock_report(%L, %L, %L)', v_p, t, t - 1), 'POLICY_VIOLATION: dates');
  perform t_expect(format('select stock_report(%L, %L, %L)', v_p, t - 400, t), 'POLICY_VIOLATION: dates');
  if (select sum((x ->> 'bought')::numeric) from jsonb_array_elements(stock_report(v_p, t - 10, t - 5) -> 'items') x) <> 0 then raise exception 'FAIL an empty window'; end if;
  raise notice 'PASS report: bought, sold, used, wasted and count differences by item, waste valued at the latest price, report.view needed';
end $$;

-- 9. The flag: with inventory off nothing is written, bills still settle without moving stock, everything can still be read
do $$ declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_t constant uuid := '00000000-0000-0000-0000-0000000000a1'; v_o uuid; v_before numeric; begin
  perform t_sys();
  insert into tenant_feature_entitlements (tenant_id, feature_key, enabled) values (v_t, 'inventory', false);
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select stock_save_item(%L, null, ''Salt'', ''kg'', ''food'', 1, true)', v_p), 'POLICY_VIOLATION: inventory off');
  perform t_expect(format('select stock_record_out(%L, ''usage'', 1, ''other'', null, ''f-1'')', t149('soap')), 'POLICY_VIOLATION: inventory off');
  perform t_expect(format('select stock_count(%L, %L::jsonb, null, ''f-2'')', v_p, jsonb_build_array(jsonb_build_object('item', t149('soap'), 'counted', 1))), 'POLICY_VIOLATION: inventory off');
  v_before := t149_qty('Rice');
  v_o := (pos_open_order(v_p, t149('place'), null, 't149-o5') ->> 'order_id')::uuid;
  perform pos_add_line(v_o, t149('pos_item'), 1, null, 't149-l6');
  perform pos_pay_order(v_o, 'cash', null, 't149-p5');
  if (select status from pos_orders where id = v_o) <> 'paid' then raise exception 'FAIL the bill should still settle'; end if;
  if t149_qty('Rice') <> v_before then raise exception 'FAIL stock moved with the flag off'; end if;
  if (select count(*) from stock_items) <> 3 or jsonb_array_length(stock_report(v_p, current_date - 1, current_date + 1) -> 'items') <> 3 then raise exception 'FAIL reads with the flag off'; end if;
  perform t_sys();
  delete from tenant_feature_entitlements where tenant_id = v_t and feature_key = 'inventory';
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform stock_record_out(t149('soap'), 'usage', 1, 'other', null, 'f-3');
  raise notice 'PASS flag: off refuses every write, bills still settle without moving stock, reads work; on again, writes work';
end $$;
