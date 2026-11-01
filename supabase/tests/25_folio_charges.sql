-- Folio charges and folio payments (migration 027). Reuses t_as / t_sys / t_expect / t_book / t_rr (05) and t21_free_room (21).
-- Users: aa01 owner A, aa02 housekeeping A, aa03 owner A but revoked, aa04 front desk A, aa05 accountant A,
-- aa08 maintenance A, bb01 owner of Hotel B. This file adds aa14 front desk A (deleted near the end).
-- Ids: a2 property A, a3 the STD room type.
\set ON_ERROR_STOP on

insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000aa14', 'fd2@example.test');
insert into tenant_memberships (id, tenant_id, user_id, status)
values ('00000000-0000-0000-0000-0000000aaa14', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000aa14', 'active');
insert into membership_roles (membership_id, role_id) select '00000000-0000-0000-0000-0000000aaa14', id from roles where key = 'front_desk';

create table t25_ctx (label text primary key, val text not null);

-- The reservation's own money, as one string, so "nothing changed" is a single comparison.
create function t25_money(p_res uuid) returns text language sql stable as $$
  select concat_ws('|', r.total_minor, r.payment_status, r.currency,
    (select count(*) from invoices where reservation_id = r.id), (select count(*) from invoice_lines l join invoices i on i.id = l.invoice_id where i.reservation_id = r.id),
    (select count(*) from payments where reservation_id = r.id), (select count(*) from payment_allocations a join payments p on p.id = a.payment_id where p.reservation_id = r.id),
    (select count(*) from refunds f where f.reservation_id = r.id), reservation_money_held(r.id))
  from reservations r where r.id = p_res
$$;
create function t25_audits(p_action text, p_entity uuid) returns bigint language sql stable as $$
  select count(*) from audit_logs where action = p_action and entity_id = p_entity
$$;
create function t25_res() returns uuid language sql stable as $$ select val::uuid from t25_ctx where label = 'res' $$;

-- 1. The grants, the tax-rule flag, and the in-house reservation the rest of the file uses
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); v_room text; v_book jsonb; v_rr uuid; v_n integer;
begin
  perform t_sys();
  select count(*) into v_n from role_permissions rp join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id
   where p.key = 'folio.charge' and r.is_system and r.key in ('owner', 'general_manager', 'front_desk');
  if v_n <> 3 then raise exception 'FAIL folio.charge grants (%)', v_n; end if;
  if exists (select 1 from role_permissions rp join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id
              where p.key = 'folio.charge' and r.is_system and r.key not in ('owner', 'general_manager', 'front_desk')) then raise exception 'FAIL folio.charge granted too widely'; end if;
  begin
    insert into tax_rules (tenant_id, property_id, name, basis, rate_value, effective_from, applies_to_charges)
    values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', 'bad', 'fixed_per_night', 1000, '2026-01-01', true);
    raise exception 'FAIL a fixed-per-night rule was allowed to apply to extras';
  exception when check_violation then null; end;
  if exists (select 1 from tax_rules where applies_to_charges) then raise exception 'FAIL existing rules must not start taxing extras'; end if;

  v_room := t21_free_room();
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  v_book := t_book('00000000-0000-0000-0000-0000000000a3', t, t + 2, 'fol-res-0001', t21_room(v_room));
  v_rr := t_rr(v_book);
  perform check_in(v_rr, 'test');
  perform t_sys();
  insert into t25_ctx values ('res', v_book ->> 'reservation_id'), ('rr', v_rr::text), ('money', t25_money((v_book ->> 'reservation_id')::uuid));
  -- a second reservation that has not arrived: no charges on it
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  v_book := t_book('00000000-0000-0000-0000-0000000000a3', t + 300, t + 301, 'fol-res-0002');
  perform t_sys();
  insert into t25_ctx values ('future', v_book ->> 'reservation_id');
  if (select reservation_status from reservations where id = t25_res()) <> 'checked_in' then raise exception 'FAIL fixture: not in house'; end if;
  raise notice 'PASS grants and fixtures: folio.charge for owner, general manager and front desk only; no existing tax rule starts taxing extras';
end $$;

-- 2. Posting a charge (no rule marked yet, so no tax)
do $$ declare
  res uuid := t25_res(); fut uuid := (select val::uuid from t25_ctx where label = 'future'); rr uuid := (select val::uuid from t25_ctx where label = 'rr');
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); r jsonb; r2 jsonb; v_id uuid;
begin
  perform t_sys();
  -- who may post
    perform t_as('00000000-0000-0000-0000-00000000aa02');
    perform t_expect(format('select post_folio_charge(%L, %L, %L, 1, 5000, %L)', res, 'minibar', 'Water', 'k-hk'), 'NOT_FOUND');
    perform t_as('00000000-0000-0000-0000-00000000aa05');   -- accountant: reads money, does not post
    perform t_expect(format('select post_folio_charge(%L, %L, %L, 1, 5000, %L)', res, 'minibar', 'Water', 'k-ac'), 'NOT_FOUND');
    perform t_as('00000000-0000-0000-0000-00000000bb01');
    perform t_expect(format('select post_folio_charge(%L, %L, %L, 1, 5000, %L)', res, 'minibar', 'Water', 'k-b'), 'NOT_FOUND');
    perform t_as('00000000-0000-0000-0000-00000000aa03');
    perform t_expect(format('select post_folio_charge(%L, %L, %L, 1, 5000, %L)', res, 'minibar', 'Water', 'k-rv'), 'NOT_FOUND');
    perform t_as('00000000-0000-0000-0000-00000000aa04');
    perform t_expect(format('select post_folio_charge(%L, %L, %L, 1, 5000, %L)', gen_random_uuid(), 'minibar', 'Water', 'k-un'), 'NOT_FOUND');
    -- input
    perform t_expect(format('select post_folio_charge(%L, %L, %L, 1, 5000, %L)', res, 'snacks', 'Water', 'k-1'), 'POLICY_VIOLATION: category');
    perform t_expect(format('select post_folio_charge(%L, null, %L, 1, 5000, %L)', res, 'Water', 'k-1'), 'POLICY_VIOLATION: category');
    perform t_expect(format('select post_folio_charge(%L, %L, %L, 1, 5000, %L)', res, 'minibar', '   ', 'k-1'), 'POLICY_VIOLATION: description');
    perform t_expect(format('select post_folio_charge(%L, %L, %L, 1, 5000, %L)', res, 'minibar', repeat('x', 201), 'k-1'), 'POLICY_VIOLATION: description');
    perform t_expect(format('select post_folio_charge(%L, %L, %L, 0, 5000, %L)', res, 'minibar', 'Water', 'k-1'), 'POLICY_VIOLATION: quantity');
    perform t_expect(format('select post_folio_charge(%L, %L, %L, 1001, 5000, %L)', res, 'minibar', 'Water', 'k-1'), 'POLICY_VIOLATION: quantity');
    perform t_expect(format('select post_folio_charge(%L, %L, %L, null, 5000, %L)', res, 'minibar', 'Water', 'k-1'), 'POLICY_VIOLATION: quantity');
    perform t_expect(format('select post_folio_charge(%L, %L, %L, 1, 0, %L)', res, 'minibar', 'Water', 'k-1'), 'POLICY_VIOLATION: amount');
    perform t_expect(format('select post_folio_charge(%L, %L, %L, 1, -5, %L)', res, 'minibar', 'Water', 'k-1'), 'POLICY_VIOLATION: amount');
    perform t_expect(format('select post_folio_charge(%L, %L, %L, 1, 1000000001, %L)', res, 'minibar', 'Water', 'k-1'), 'POLICY_VIOLATION: amount');
    perform t_expect(format('select post_folio_charge(%L, %L, %L, 1, 5000, %L, %L)', res, 'minibar', 'Water', 'k-1', t + 1), 'POLICY_VIOLATION: date');       -- not in the future
    perform t_expect(format('select post_folio_charge(%L, %L, %L, 1, 5000, %L, %L)', res, 'minibar', 'Water', 'k-1', t - 30), 'POLICY_VIOLATION: date');      -- not before arrival
    perform t_expect(format('select post_folio_charge(%L, %L, %L, 1, 5000, %L, null, %L)', res, 'minibar', 'Water', 'k-1', gen_random_uuid()), 'POLICY_VIOLATION: room');
    perform t_expect(format('select post_folio_charge(%L, %L, %L, 1, 5000, %L, null, %L)', res, 'minibar', 'Water', 'k-1',
                            (select id from reservation_rooms where reservation_id = fut limit 1)), 'POLICY_VIOLATION: room');                                 -- another reservation's room
    -- a guest who has not arrived has no folio
  perform t_expect(format('select post_folio_charge(%L, %L, %L, 1, 5000, %L)', fut, 'minibar', 'Water', 'k-fut'), 'INVALID_STATE: confirmed');
  perform t_sys();
  if exists (select 1 from folio_charges) then raise exception 'FAIL a refused call left a charge'; end if;
  if exists (select 1 from idempotency_keys where operation = 'post_folio_charge') then raise exception 'FAIL a refused call left an idempotency key'; end if;

  -- a charge
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r := post_folio_charge(res, 'minibar', '  Two waters and a juice ', 3, 2500, 'fol-key-1', null, rr);
  perform t_sys();
  v_id := (r ->> 'charge_id')::uuid;
  if (r ->> 'total_minor')::bigint <> 7500 or (r ->> 'tax_minor')::bigint <> 0 or (r ->> 'balance_minor')::bigint <> 7500 then raise exception 'FAIL charge result %', r; end if;
  if not exists (select 1 from folio_charges where id = v_id and description = 'Two waters and a juice' and quantity = 3 and unit_amount_minor = 2500 and total_minor = 7500
                    and status = 'posted' and charge_date = t and reservation_room_id = rr and posted_by = '00000000-0000-0000-0000-00000000aa04' and currency = 'NGN') then raise exception 'FAIL charge row'; end if;
  if t25_audits('folio.charge_posted', v_id) <> 1 then raise exception 'FAIL posted audit'; end if;

  -- the same key and words again: the first answer, nothing new; the same key with other words is refused
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r2 := post_folio_charge(res, 'minibar', '  Two waters and a juice ', 3, 2500, 'fol-key-1', null, rr);
  perform t_expect(format('select post_folio_charge(%L, %L, %L, 1, 100, %L)', res, 'laundry', 'Shirt', 'fol-key-1'), 'IDEMPOTENCY_MISMATCH');
  perform t_sys();
  if r2 is distinct from r or (select count(*) from folio_charges) <> 1 or t25_audits('folio.charge_posted', v_id) <> 1 then raise exception 'FAIL repeat post'; end if;

  -- a different charge, backdated to the arrival date, and by the owner
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  r := post_folio_charge(res, 'laundry', 'Two shirts', 2, 1500, 'fol-key-2', t);
  perform t_sys();
  if (r ->> 'charges_minor')::bigint <> 10500 or (r ->> 'balance_minor')::bigint <> 10500 then raise exception 'FAIL running balance %', r; end if;
  insert into t25_ctx values ('charge1', v_id::text), ('charge2', r ->> 'charge_id');
  raise notice 'PASS post: permissions, input checks, state, date and room rules, idempotent by key, balance runs on';
end $$;

-- 3. Tax comes from the rules marked for extras, is stored on the charge, and never changes afterwards
do $$ declare
  res uuid := t25_res(); t date := property_today('00000000-0000-0000-0000-0000000000a2'); r jsonb; v_old uuid := (select val::uuid from t25_ctx where label = 'charge1');
begin
  perform t_sys();
  insert into tax_rules (tenant_id, property_id, name, basis, rate_value, sequence, compounds, effective_from, effective_to, status, applies_to_charges) values
    ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', 't25 VAT',            'percent',         7.5, 91, false, '2026-01-01', null,         'active',   true),
    ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', 't25 service',        'percent',        10,   92, true,  '2026-01-01', null,         'active',   true),
    ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', 't25 nights only',    'percent',         5,   93, false, '2026-01-01', null,         'active',   false),
    ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', 't25 fixed',          'fixed_per_night', 1000, 94, false, '2026-01-01', null,         'active',   false),
    ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', 't25 inactive',       'percent',        20,   95, false, '2026-01-01', null,         'inactive', true),
    ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', 't25 starts later',   'percent',        50,   96, false, t + 10,       null,         'active',   true),
    ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', 't25 ended',          'percent',        40,   97, false, '2026-01-01', t - 1,        'active',   true);

  -- 100000 x 1: VAT 7500 on the amount, service 10% of the running 107500 = 10750; the rest are not marked, inactive, future or ended
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r := post_folio_charge(res, 'food_beverage', 'Dinner for two', 1, 100000, 'fol-key-3');
  if (r ->> 'tax_minor')::bigint <> 18250 or (r ->> 'total_minor')::bigint <> 118250 then raise exception 'FAIL tax on 100000: %', r; end if;
  -- rounding is per charge, on the whole line: 3 x 333 = 999; VAT 74.925 -> 75; service of 1074 -> 107
  r := post_folio_charge(res, 'phone', 'Calls', 3, 333, 'fol-key-4');
  if (r ->> 'tax_minor')::bigint <> 182 or (r ->> 'total_minor')::bigint <> 1181 then raise exception 'FAIL tax on 3 x 333: %', r; end if;
  perform t_sys();

  -- the charge posted before the rules still has no tax, and changing a rule now changes nothing already posted
  if (select tax_minor from folio_charges where id = v_old) <> 0 then raise exception 'FAIL an old charge was taxed'; end if;
  update tax_rules set rate_value = 99 where name = 't25 VAT';
  if (select tax_minor from folio_charges where description = 'Dinner for two') <> 18250 then raise exception 'FAIL a rule change altered a posted charge'; end if;
  update tax_rules set rate_value = 7.5 where name = 't25 VAT';

  -- the totals add up: 7500 + 3000 + 118250 + 1181
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  r := folio_balance(res);
  perform t_sys();
  if r <> jsonb_build_object('currency', 'NGN', 'charge_count', 4, 'charges_minor', 129931, 'tax_minor', 18432, 'paid_minor', 0, 'balance_minor', 129931) then
    raise exception 'FAIL folio balance %', r;
  end if;
  update tax_rules set status = 'inactive' where name like 't25 %';     -- the rest of the file, and later files, run without them
  raise notice 'PASS tax: only marked percent rules in force that day, compounding in sequence, stored on the charge, rounded per line';
end $$;

-- 4. Reading: row-level security; writing: no direct writes, rows are history
do $$ declare v_n integer; v_c uuid := (select val::uuid from t25_ctx where label = 'charge1'); begin
  perform t_sys();
  perform t_as('00000000-0000-0000-0000-00000000aa04'); select count(*) into v_n from folio_charges;
  if v_n <> 4 then raise exception 'FAIL front desk saw % charges', v_n; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01'); select count(*) into v_n from folio_charges;
  if v_n <> 4 then raise exception 'FAIL owner saw % charges', v_n; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa05'); select count(*) into v_n from folio_charges;   -- accountant reads money
  if v_n <> 4 then raise exception 'FAIL accountant saw % charges', v_n; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa02'); select count(*) into v_n from folio_charges;
  if v_n <> 0 then raise exception 'FAIL housekeeping read charges'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa08'); select count(*) into v_n from folio_charges;
  if v_n <> 0 then raise exception 'FAIL maintenance read charges'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa03'); select count(*) into v_n from folio_charges;
  if v_n <> 0 then raise exception 'FAIL revoked member read charges'; end if;
  perform t_as('00000000-0000-0000-0000-00000000bb01'); select count(*) into v_n from folio_charges;
  if v_n <> 0 then raise exception 'FAIL another hotel read charges'; end if;
  perform t_sys(); perform set_config('role', 'anon', true); select count(*) into v_n from folio_charges;
  if v_n <> 0 then raise exception 'FAIL anon read charges'; end if;

  perform t_as('00000000-0000-0000-0000-00000000aa01');   -- even the owner has no direct write
  begin insert into folio_charges (tenant_id, property_id, reservation_id, category, description, quantity, unit_amount_minor, total_minor, currency, charge_date)
        values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', t25_res(), 'other', 'x', 1, 5, 5, 'NGN', current_date);
        raise exception 'FAIL client insert succeeded'; exception when insufficient_privilege then null; end;
  begin update folio_charges set unit_amount_minor = 1 where id = v_c; raise exception 'FAIL client update succeeded'; exception when insufficient_privilege then null; end;
  begin delete from folio_charges where id = v_c; raise exception 'FAIL client delete succeeded'; exception when insufficient_privilege then null; end;
  begin insert into folio_payments (tenant_id, property_id, reservation_id, payment_method, internal_reference, amount_minor, currency)
        values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', t25_res(), 'cash', 'FOL-X', 5, 'NGN'); raise exception 'FAIL client payment insert succeeded';
  exception when insufficient_privilege then null; end;
  perform t_sys();

  -- the table owner cannot delete or edit history either, and the table's own rules hold
  begin delete from folio_charges where id = v_c; raise exception 'FAIL delete succeeded'; exception when check_violation then null; end;
  begin update folio_charges set unit_amount_minor = 1, total_minor = 3 where id = v_c; raise exception 'FAIL charge edited'; exception when check_violation then null; end;
  begin update folio_charges set description = 'changed' where id = v_c; raise exception 'FAIL description edited'; exception when check_violation then null; end;
  begin update folio_charges set status = 'voided' where id = v_c; raise exception 'FAIL voided without a time and reason'; exception when check_violation then null; end;
  begin insert into folio_charges (tenant_id, property_id, reservation_id, category, description, quantity, unit_amount_minor, tax_minor, total_minor, currency, charge_date)
        values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', t25_res(), 'other', 'x', 2, 5, 0, 99, 'NGN', current_date);
        raise exception 'FAIL a total that does not add up was accepted'; exception when check_violation then null; end;
  begin insert into folio_charges (tenant_id, property_id, reservation_id, category, description, quantity, unit_amount_minor, total_minor, currency, charge_date)
        values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a2', t25_res(), 'other', 'x', 1, 5, 5, 'NGN', current_date);
        raise exception 'FAIL tenant and property mismatch accepted'; exception when foreign_key_violation then null; end;
  raise notice 'PASS read and write: money roles and charge posters read, others and anon do not; no direct writes; history cannot be deleted or edited';
end $$;

-- 5. Money collected for the extras
do $$ declare
  res uuid := t25_res(); fut uuid := (select val::uuid from t25_ctx where label = 'future'); r jsonb; r2 jsonb; v_pay uuid;
begin
  perform t_sys();
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform t_expect(format('select record_folio_payment(%L, 1000, %L, null, null, %L)', res, 'cash', 'p-hk'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa08');
  perform t_expect(format('select record_folio_payment(%L, 1000, %L, null, null, %L)', res, 'cash', 'p-mt'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa03');
  perform t_expect(format('select record_folio_payment(%L, 1000, %L, null, null, %L)', res, 'cash', 'p-rv'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select record_folio_payment(%L, 1000, %L, null, null, %L)', res, 'cash', 'p-b'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select record_folio_payment(%L, 1000, %L, null, null, %L)', gen_random_uuid(), 'cash', 'p-un'), 'NOT_FOUND');
  perform t_expect(format('select record_folio_payment(%L, 0, %L, null, null, %L)', res, 'cash', 'p-0'), 'POLICY_VIOLATION: amount');
  perform t_expect(format('select record_folio_payment(%L, -5, %L, null, null, %L)', res, 'cash', 'p-n'), 'POLICY_VIOLATION: amount');
  perform t_expect(format('select record_folio_payment(%L, null, %L, null, null, %L)', res, 'cash', 'p-nl'), 'POLICY_VIOLATION: amount');
  perform t_expect(format('select record_folio_payment(%L, 1000, %L, null, null, %L)', res, 'card', 'p-m'), 'POLICY_VIOLATION: payment method');
  perform t_expect(format('select record_folio_payment(%L, 1000, %L, %L, null, %L)', res, 'pos', repeat('x', 101), 'p-l'), 'POLICY_VIOLATION: too long');
  perform t_expect(format('select record_folio_payment(%L, 1000, %L, null, null, %L)', fut, 'cash', 'p-f'), 'INVALID_STATE: confirmed');
  perform t_expect(format('select record_folio_payment(%L, 129932, %L, null, null, %L)', res, 'cash', 'p-over'), 'POLICY_VIOLATION: OVERPAYMENT outstanding 129931');
  perform t_sys();
  if exists (select 1 from folio_payments) then raise exception 'FAIL a refused call left a payment'; end if;

  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r := record_folio_payment(res, 50000, 'cash', null, '  paid at the desk ', 'fol-pay-1');
  r2 := record_folio_payment(res, 50000, 'cash', null, '  paid at the desk ', 'fol-pay-1');
  perform t_expect(format('select record_folio_payment(%L, 40000, %L, null, null, %L)', res, 'cash', 'fol-pay-1'), 'IDEMPOTENCY_MISMATCH');
  perform t_sys();
  v_pay := (r ->> 'payment_id')::uuid;
  if r2 is distinct from r or (select count(*) from folio_payments) <> 1 then raise exception 'FAIL repeat payment made a second row'; end if;
  if (r ->> 'balance_minor')::bigint <> 79931 or (r ->> 'paid_minor')::bigint <> 50000 or r ->> 'internal_reference' not like 'FOL-%' then raise exception 'FAIL payment result %', r; end if;
  if not exists (select 1 from folio_payments where id = v_pay and note = 'paid at the desk' and payment_status = 'succeeded' and recorded_by = '00000000-0000-0000-0000-00000000aa04') then raise exception 'FAIL payment row'; end if;
  if t25_audits('folio.payment_recorded', v_pay) <> 1 then raise exception 'FAIL payment audit'; end if;

  perform t_as('00000000-0000-0000-0000-00000000aa05');                      -- accountants hold payment.record too
  r := record_folio_payment(res, 29931, 'bank_transfer', 'TRF-4471', null, 'fol-pay-2');
  perform t_sys();
  if (r ->> 'balance_minor')::bigint <> 50000 then raise exception 'FAIL second payment %', r; end if;
  insert into t25_ctx values ('pay1', v_pay::text), ('pay2', r ->> 'payment_id');
  if t25_money(res) <> (select val from t25_ctx where label = 'money') then raise exception 'FAIL the reservation''s own money changed: % vs %', t25_money(res), (select val from t25_ctx where label = 'money'); end if;
  raise notice 'PASS payments: permissions, input checks, never above the balance, idempotent by key; the reservation''s money is untouched';
end $$;

-- 6. Voiding a charge
do $$ declare
  res uuid := t25_res(); v_dinner uuid := (select id from folio_charges where description = 'Dinner for two'); v_laundry uuid := (select val::uuid from t25_ctx where label = 'charge2');
  r jsonb;
begin
  perform t_sys();
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  perform t_expect(format('select void_folio_charge(%L, %L)', v_laundry, 'wrong room'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform t_expect(format('select void_folio_charge(%L, %L)', v_laundry, 'wrong room'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select void_folio_charge(%L, %L)', v_laundry, 'wrong room'), 'NOT_FOUND');
  perform t_expect(format('select void_folio_charge(%L, %L)', gen_random_uuid(), 'x'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select void_folio_charge(%L, null)', v_laundry), 'POLICY_VIOLATION: reason');
  perform t_expect(format('select void_folio_charge(%L, %L)', v_laundry, '   '), 'POLICY_VIOLATION: reason');
  perform t_expect(format('select void_folio_charge(%L, %L)', v_laundry, repeat('x', 201)), 'POLICY_VIOLATION: reason');
  -- 79931 has been paid; taking off the dinner (118250) would leave 11681 of charges, less than what was paid
  perform t_expect(format('select void_folio_charge(%L, %L)', v_dinner, 'guest disputes it'), 'INVALID_STATE: folio paid');
  perform t_sys();
  if (select status from folio_charges where id = v_dinner) <> 'posted' then raise exception 'FAIL a refused void changed the charge'; end if;

  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r := void_folio_charge(v_laundry, 'posted to the wrong guest');
  perform void_folio_charge(v_laundry, 'second tap, other words');
  perform t_sys();
  if r ->> 'status' <> 'voided' or (r ->> 'balance_minor')::bigint <> 47000 then raise exception 'FAIL void result %', r; end if;   -- 126931 charges - 79931 paid
  if not exists (select 1 from folio_charges where id = v_laundry and status = 'voided' and void_reason = 'posted to the wrong guest' and voided_by = '00000000-0000-0000-0000-00000000aa04' and voided_at is not null) then raise exception 'FAIL void fields'; end if;
  if t25_audits('folio.charge_voided', v_laundry) <> 1 then raise exception 'FAIL void audit rows'; end if;
  begin update folio_charges set void_reason = 'edited' where id = v_laundry; raise exception 'FAIL voided charge changed'; exception when check_violation then null; end;
  begin update folio_charges set status = 'posted', voided_at = null, void_reason = null where id = v_laundry; raise exception 'FAIL voided charge brought back'; exception when check_violation then null; end;
  raise notice 'PASS void: permissions, reason required, refused when it would leave the folio over-paid, repeat is a no-op, voided charges are frozen';
end $$;

-- 7. Reversing a folio payment (refund.approve: not the front desk), then the void that was blocked
do $$ declare
  res uuid := t25_res(); v_dinner uuid := (select id from folio_charges where description = 'Dinner for two');
  v_cash uuid := (select val::uuid from t25_ctx where label = 'pay1'); v_bank uuid := (select val::uuid from t25_ctx where label = 'pay2'); r jsonb;
begin
  perform t_sys();
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select reverse_folio_payment(%L, %L)', v_bank, 'entered twice'), 'NOT_FOUND');   -- takes money, cannot undo it
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform t_expect(format('select reverse_folio_payment(%L, %L)', v_bank, 'entered twice'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select reverse_folio_payment(%L, %L)', v_bank, 'entered twice'), 'NOT_FOUND');
  perform t_expect(format('select reverse_folio_payment(%L, %L)', gen_random_uuid(), 'x'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  perform t_expect(format('select reverse_folio_payment(%L, null)', v_bank), 'POLICY_VIOLATION: reason');
  perform t_expect(format('select reverse_folio_payment(%L, %L)', v_bank, repeat('x', 201)), 'POLICY_VIOLATION: reason');
  r := reverse_folio_payment(v_bank, 'transfer never arrived');
  perform reverse_folio_payment(v_bank, 'again');
  perform t_sys();
  if (r ->> 'balance_minor')::bigint <> 76931 then raise exception 'FAIL balance after reversal %', r; end if;    -- 126931 - 50000
  if t25_audits('folio.payment_reversed', v_bank) <> 1 or not exists (select 1 from folio_payments where id = v_bank and payment_status = 'reversed' and reverse_reason = 'transfer never arrived' and reversed_by = '00000000-0000-0000-0000-00000000aa05') then
    raise exception 'FAIL reversal fields or audit';
  end if;
  begin update folio_payments set payment_status = 'succeeded', reversed_at = null, reverse_reason = null where id = v_bank; raise exception 'FAIL reversed payment brought back'; exception when check_violation then null; end;
  begin update folio_payments set amount_minor = 1 where id = v_cash; raise exception 'FAIL payment amount edited'; exception when check_violation then null; end;
  begin delete from folio_payments where id = v_cash; raise exception 'FAIL payment deleted'; exception when check_violation then null; end;

  -- 50000 is still paid, so the dinner still cannot come off; reverse that payment (owner) and it can
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select void_folio_charge(%L, %L)', v_dinner, 'guest disputes it'), 'INVALID_STATE: folio paid');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform reverse_folio_payment(v_cash, 'recorded against the wrong guest');
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r := void_folio_charge(v_dinner, 'guest disputes it, agreed');
  perform t_sys();
  if (r ->> 'balance_minor')::bigint <> 8681 then raise exception 'FAIL balance after the dinner came off %', r; end if;    -- 7500 + 1181
  if t25_money(res) <> (select val from t25_ctx where label = 'money') then raise exception 'FAIL the reservation''s own money changed'; end if;
  raise notice 'PASS reversal: refund.approve only, reason required, repeat is a no-op, reversed payments frozen, the blocked void works after';
end $$;

-- 8. The balance, paying it off, and charging after check-out
do $$ declare
  res uuid := t25_res(); rr uuid := (select val::uuid from t25_ctx where label = 'rr'); r jsonb;
begin
  perform t_sys();
  perform t_as('00000000-0000-0000-0000-00000000aa02'); perform t_expect(format('select folio_balance(%L)', res), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa08'); perform t_expect(format('select folio_balance(%L)', res), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01'); perform t_expect(format('select folio_balance(%L)', res), 'NOT_FOUND');
  perform t_expect(format('select folio_balance(%L)', gen_random_uuid()), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa05'); r := folio_balance(res);
  if r <> jsonb_build_object('currency', 'NGN', 'charge_count', 2, 'charges_minor', 8681, 'tax_minor', 182, 'paid_minor', 0, 'balance_minor', 8681) then raise exception 'FAIL balance %', r; end if;

  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r := record_folio_payment(res, 8681, 'pos', 'POS-8812', null, 'fol-pay-3');
  if (r ->> 'balance_minor')::bigint <> 0 then raise exception 'FAIL paid off %', r; end if;
  perform t_expect(format('select record_folio_payment(%L, 1, %L, null, null, %L)', res, 'cash', 'fol-pay-4'), 'POLICY_VIOLATION: OVERPAYMENT outstanding 0');

  -- the guest leaves; the folio stays open for a late extra, and the reservation's money is still untouched
  perform check_out(rr);
  perform t_sys();
  if (select reservation_status from reservations where id = res) <> 'checked_out' then raise exception 'FAIL fixture: not checked out'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r := post_folio_charge(res, 'late_checkout', 'Late check-out', 1, 5000, 'fol-key-5');
  if (r ->> 'balance_minor')::bigint <> 5000 or (r ->> 'tax_minor')::bigint <> 0 then raise exception 'FAIL late charge %', r; end if;
  perform t_sys();
  if t25_money(res) <> (select val from t25_ctx where label = 'money') then raise exception 'FAIL check-out or a late charge changed the reservation''s money'; end if;
  raise notice 'PASS balance and check-out: money roles read the balance, a paid folio takes no more, late charges after check-out work, reservation money untouched';
end $$;

-- 9. A deleted login keeps the charges and payments it made, with the person cleared
do $$ declare res uuid := t25_res(); v_c uuid; v_p uuid; begin
  perform t_as('00000000-0000-0000-0000-00000000aa14');
  v_c := (post_folio_charge(res, 'other', 'Parcel postage', 1, 1000, 'fol-key-6') ->> 'charge_id')::uuid;
  v_p := (record_folio_payment(res, 1000, 'cash', null, null, 'fol-pay-5') ->> 'payment_id')::uuid;
  perform t_sys();
  if not exists (select 1 from folio_charges where id = v_c and posted_by = '00000000-0000-0000-0000-00000000aa14') then raise exception 'FAIL fixture'; end if;
  delete from auth.users where id = '00000000-0000-0000-0000-00000000aa14';
  if not exists (select 1 from folio_charges where id = v_c and posted_by is null and status = 'posted')
     or not exists (select 1 from folio_payments where id = v_p and recorded_by is null and payment_status = 'succeeded') then raise exception 'FAIL rows not kept after the person was deleted'; end if;
  raise notice 'PASS deleting a staff login keeps their charges and payments, with the person cleared';
end $$;

-- 10. The functions' own access (and a check the tax rules this file made are switched off again)
do $$ begin
  perform t_sys(); perform set_config('role', 'anon', true);
  begin perform post_folio_charge(gen_random_uuid(), 'other', 'x', 1, 5, 'k'); raise exception 'FAIL anon posted'; exception when insufficient_privilege then null; end;
  begin perform record_folio_payment(gen_random_uuid(), 5, 'cash', null, null, 'k'); raise exception 'FAIL anon recorded a payment'; exception when insufficient_privilege then null; end;
  begin perform folio_balance(gen_random_uuid()); raise exception 'FAIL anon read a balance'; exception when insufficient_privilege then null; end;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  begin perform calc_charge_tax('00000000-0000-0000-0000-0000000000a2', current_date, 100); raise exception 'FAIL client called the tax helper'; exception when insufficient_privilege then null; end;
  begin perform folio_totals(gen_random_uuid()); raise exception 'FAIL client called the totals helper'; exception when insufficient_privilege then null; end;
  perform t_sys();
  if exists (select 1 from tax_rules where name like 't25 %' and status = 'active') then raise exception 'FAIL test tax rules left active'; end if;
  raise notice 'PASS access: anon and clients cannot reach the functions or helpers they should not';
end $$;

-- ---- race helpers (the pgbench scripts at the end of run.sh call these) ----
create table t25_out (label text not null, val text);

-- A balance for clients to pay at once: 20 clients each try to pay all of it.
create function t25_race_setup() returns void language plpgsql as $$
declare v_tot record;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform post_folio_charge(t25_res(), 'other', 'Race base', 1, 10000, 'fol-race-base');
  perform t_sys();
  select * into v_tot from folio_totals(t25_res());
  insert into t25_ctx values ('race_balance', (v_tot.charges_minor - v_tot.paid_minor)::text);
end $$;

create function t25_try_pay(p_label text, p_n integer) returns boolean language plpgsql as $$
declare v_ok boolean;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  begin
    perform record_folio_payment(t25_res(), (select val::bigint from t25_ctx where label = 'race_balance'), 'cash', null, null, 'fol-race-pay-' || p_n);
    v_ok := true;
  exception when sqlstate 'P0001' then v_ok := false; end;
  perform t_sys();
  insert into test_results (label, ok) values (p_label, v_ok);
  return v_ok;
end $$;

-- The same charge, same key, sent by many clients at once: one charge, one answer.
create function t25_try_post(p_label text) returns boolean language plpgsql as $$
declare v_r jsonb;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  v_r := post_folio_charge(t25_res(), 'minibar', 'Race snack', 1, 777, 'fol-race-post');
  perform t_sys();
  insert into t25_out values (p_label, v_r ->> 'charge_id');
  return true;
end $$;

-- Posting, paying and voiding on one reservation at once: refusals are fine, a deadlock or an over-paid folio is not.
create function t25_mix(p_label text, p_what integer, p_n integer) returns boolean language plpgsql as $$
declare v_ok boolean := true; v_c uuid;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  begin
    if p_what = 0 then perform post_folio_charge(t25_res(), 'other', 'Mix charge', 1, 1000, 'fol-mix-c-' || p_n);
    elsif p_what = 1 then perform record_folio_payment(t25_res(), 2500, 'cash', null, null, 'fol-mix-p-' || p_n);
    else
      select id into v_c from folio_charges where reservation_id = t25_res() and status = 'posted' and description = 'Mix charge' order by created_at, id limit 1;
      perform void_folio_charge(v_c, 'mix void');
    end if;
  exception when sqlstate 'P0001' then v_ok := false; end;
  perform t_sys();
  insert into test_results (label, ok) values (p_label, v_ok);
  return v_ok;
end $$;
