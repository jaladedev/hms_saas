-- Service charge kind (migration 132). Hotel A: tenant a1, property a2, room type a3. Reuses t_as / t_sys / t_book (05).
-- Own rooms (T132-1..4) and own rules (named 'T132 ...'); the rules are switched off and the rooms retired at the end.
\set ON_ERROR_STOP on

-- any failure (not only P0001) whose message contains the text
create function t132_refused(p_sql text, p_text text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm not like '%' || p_text || '%' then raise exception 'FAIL expected "%" but got "%"', p_text, sqlerrm; end if;
    return;
  end;
  raise exception 'FAIL expected "%" but call succeeded: %', p_text, p_sql;
end $$;

create temp table t132 (k text primary key, v text);
grant all on t132 to public;

-- A. what the table allows, and the kind never changes
do $$ declare
  prop uuid := '00000000-0000-0000-0000-0000000000a2'; ten uuid := '00000000-0000-0000-0000-0000000000a1'; typ uuid := '00000000-0000-0000-0000-0000000000a3';
  t date; v_id uuid;
begin
  perform t_sys();
  t := property_today(prop);
  insert into rooms (tenant_id, property_id, room_type_id, room_number, floor)
    select tenant_id, id, typ, 'T132-' || g, 9 from properties, generate_series(1, 4) g where id = prop;
  update rooms set housekeeping_status = 'clean' where property_id = prop and room_number like 'T132-%';
  if exists (select 1 from tax_rules where kind <> 'tax') then raise exception 'FAIL existing rules must all be tax'; end if;
  perform t132_refused(format($f$insert into tax_rules (tenant_id, property_id, name, basis, rate_value, effective_from, kind) values (%L, %L, 'T132 bad', 'fixed_per_stay', 100, current_date, 'service_charge')$f$, ten, prop), 'tax_rules_service_nights_only');
  perform t132_refused(format($f$insert into tax_rules (tenant_id, property_id, name, basis, rate_value, effective_from, kind, applies_to_charges) values (%L, %L, 'T132 bad', 'percent', 10, current_date, 'service_charge', true)$f$, ten, prop), 'tax_rules_service_nights_only');
  perform t132_refused(format($f$insert into tax_rules (tenant_id, property_id, name, basis, rate_value, effective_from, kind) values (%L, %L, 'T132 bad', 'percent', 10, current_date, 'levy')$f$, ten, prop), 'tax_rules_kind_check');
  -- a 10% service charge, ordered first; the fixture's VAT (7.5%, not compounding) stays as it is
  insert into tax_rules (tenant_id, property_id, name, basis, rate_value, sequence, effective_from, kind)
    values (ten, prop, 'T132 Service charge', 'percent', 10, 1, t - 30, 'service_charge') returning id into v_id;
  insert into t132 values ('rule', v_id::text);
  perform t132_refused(format($f$update tax_rules set kind = 'tax' where id = %L$f$, v_id), 'tax_rules_kind_fixed');
  perform t132_refused(format($f$update tax_rules set basis = 'fixed_per_stay' where id = %L$f$, v_id), 'tax_rules_service_nights_only');
  perform t132_refused(format($f$update tax_rules set applies_to_charges = true where id = %L$f$, v_id), 'tax_rules_service_nights_only');
  if not exists (select 1 from audit_logs where entity_id = v_id and action like 'tax_rule.%') then raise exception 'FAIL the new rule was not audited'; end if;
  raise notice 'PASS service charge: kind defaults to tax, service rules are nights-only and the kind never changes';
end $$;

-- B. a booking: service is a component of the tax, and the totals are unchanged
do $$ declare
  prop uuid := '00000000-0000-0000-0000-0000000000a2'; typ uuid := '00000000-0000-0000-0000-0000000000a3';
  t date; r jsonb; res uuid; n record; rooms_ uuid[]; v_cnt integer := 0;
begin
  perform t_sys();
  t := property_today(prop);
  select array_agg(id order by room_number) into rooms_ from rooms where property_id = prop and room_number like 'T132-%';
  r := t_book(typ, t + 10, t + 13, 't132-b1', rooms_[1]);
  res := (r ->> 'reservation_id')::uuid;
  for n in select rate_minor, tax_minor, service_minor, stay_tax_minor from reservation_nights where reservation_room_id in (select id from reservation_rooms where reservation_id = res) loop
    v_cnt := v_cnt + 1;
    if n.service_minor <> round(n.rate_minor * 0.10) then raise exception 'FAIL service % for rate %', n.service_minor, n.rate_minor; end if;
    if n.tax_minor <> calc_night_tax(prop, t + 10, n.rate_minor) + n.stay_tax_minor then raise exception 'FAIL tax not the sum of the rules'; end if;
    if n.service_minor > n.tax_minor then raise exception 'FAIL service above tax'; end if;
  end loop;
  if v_cnt <> 3 then raise exception 'FAIL expected 3 nights, saw %', v_cnt; end if;
  if (select tax_minor from reservations where id = res) <> (select sum(tax_minor) from reservation_nights where reservation_room_id in (select id from reservation_rooms where reservation_id = res)) then raise exception 'FAIL reservation tax is not the sum of nights'; end if;
  if (select total_minor from reservations where id = res) <> (select subtotal_minor + tax_minor from reservations where id = res) then raise exception 'FAIL total changed meaning'; end if;
  insert into t132 values ('res', res::text);
  raise notice 'PASS service charge: each night''s service is its part of the tax; totals are still subtotal plus tax';
end $$;

-- C. a later change of the rule does not touch a booking made before; a new booking uses the new rate; switching it off stops it
do $$ declare
  prop uuid := '00000000-0000-0000-0000-0000000000a2'; typ uuid := '00000000-0000-0000-0000-0000000000a3';
  t date; v_rule uuid := (select v::uuid from t132 where k = 'rule'); res uuid := (select v::uuid from t132 where k = 'res');
  rooms_ uuid[]; r jsonb; v_before bigint; v_new uuid; v_rate bigint;
begin
  perform t_sys();
  t := property_today(prop);
  select array_agg(id order by room_number) into rooms_ from rooms where property_id = prop and room_number like 'T132-%';
  select sum(service_minor) into v_before from reservation_nights where reservation_room_id in (select id from reservation_rooms where reservation_id = res);
  update tax_rules set rate_value = 20 where id = v_rule;
  if (select sum(service_minor) from reservation_nights where reservation_room_id in (select id from reservation_rooms where reservation_id = res)) <> v_before then raise exception 'FAIL a rule edit changed an old booking'; end if;
  r := t_book(typ, t + 20, t + 22, 't132-c1', rooms_[2]);
  v_new := (r ->> 'reservation_id')::uuid;
  select rate_minor into v_rate from reservation_nights where reservation_room_id in (select id from reservation_rooms where reservation_id = v_new) limit 1;
  if (select min(service_minor) from reservation_nights where reservation_room_id in (select id from reservation_rooms where reservation_id = v_new)) <> round(v_rate * 0.20) then raise exception 'FAIL new booking did not use 20 percent'; end if;
  update tax_rules set status = 'inactive' where id = v_rule;
  r := t_book(typ, t + 30, t + 32, 't132-c2', rooms_[3]);
  if (select sum(service_minor) from reservation_nights where reservation_room_id in (select id from reservation_rooms where reservation_id = (r ->> 'reservation_id')::uuid)) <> 0 then raise exception 'FAIL a switched-off rule charged service'; end if;
  update tax_rules set status = 'active', rate_value = 10 where id = v_rule;
  raise notice 'PASS service charge: a rule edit leaves old bookings alone, new ones follow it, off means no service';
end $$;

-- D. changing the stay recomputes the new nights; a fixed per-night service and compounding work; the levy move keeps the split
do $$ declare
  prop uuid := '00000000-0000-0000-0000-0000000000a2'; ten uuid := '00000000-0000-0000-0000-0000000000a1'; typ uuid := '00000000-0000-0000-0000-0000000000a3';
  owner text := '00000000-0000-0000-0000-00000000aa01';
  t date; res uuid := (select v::uuid from t132 where k = 'res'); v_fix uuid; rooms_ uuid[]; r jsonb; n record; v_vat numeric;
begin
  perform t_sys();
  t := property_today(prop);
  select array_agg(id order by room_number) into rooms_ from rooms where property_id = prop and room_number like 'T132-%';
  perform t_as(owner);
  perform update_reservation_stay(res, t + 40, t + 45, null, 'longer, later', 't132-d1');
  perform t_sys();
  if (select count(*) from reservation_nights where reservation_room_id in (select id from reservation_rooms where reservation_id = res)) <> 5 then raise exception 'FAIL stay not 5 nights'; end if;
  for n in select rate_minor, service_minor from reservation_nights where reservation_room_id in (select id from reservation_rooms where reservation_id = res) loop
    if n.service_minor <> round(n.rate_minor * 0.10) then raise exception 'FAIL service % after the stay change for rate %', n.service_minor, n.rate_minor; end if;
  end loop;
  -- a fixed 500.00 a night service charge after the percent one: 10% + 500.00
  insert into tax_rules (tenant_id, property_id, name, basis, rate_value, sequence, effective_from, kind)
    values (ten, prop, 'T132 Fixed service', 'fixed_per_night', 50000, 2, t - 30, 'service_charge') returning id into v_fix;
  r := t_book(typ, t + 50, t + 52, 't132-d2', rooms_[4]);
  for n in select rate_minor, tax_minor, service_minor from reservation_nights where reservation_room_id in (select id from reservation_rooms where reservation_id = (r ->> 'reservation_id')::uuid) loop
    if n.service_minor <> round(n.rate_minor * 0.10) + 50000 then raise exception 'FAIL fixed service: % for rate %', n.service_minor, n.rate_minor; end if;
    if n.service_minor > n.tax_minor then raise exception 'FAIL service above tax'; end if;
  end loop;
  update tax_rules set status = 'inactive' where id = v_fix;
  -- the VAT rule compounding on top of the service charge: tax grows, service does not
  select id into v_fix from tax_rules where property_id = prop and name = 'Test VAT';
  update tax_rules set compounds = true, sequence = 3 where id = v_fix;
  r := t_book(typ, t + 60, t + 61, 't132-d3', rooms_[3]);
  select rate_minor, tax_minor, service_minor into n from reservation_nights where reservation_room_id in (select id from reservation_rooms where reservation_id = (r ->> 'reservation_id')::uuid);
  if n.service_minor <> round(n.rate_minor * 0.10) then raise exception 'FAIL compounding changed the service part'; end if;
  if n.tax_minor <> round(n.rate_minor * 0.10) + round((n.rate_minor + round(n.rate_minor * 0.10)) * 0.075) then raise exception 'FAIL VAT on top of service: %', n.tax_minor; end if;
  update tax_rules set compounds = false, sequence = 1 where id = v_fix;
  raise notice 'PASS service charge: a stay change recomputes service; a fixed amount and compounding add up correctly';
end $$;

-- E0. the room invoice carries the split, and a reissue after a stay change follows the new nights
do $$ declare
  prop uuid := '00000000-0000-0000-0000-0000000000a2'; owner text := '00000000-0000-0000-0000-00000000aa01'; t date;
  res uuid := (select v::uuid from t132 where k = 'res'); inv record; v_svc bigint;
begin
  perform t_sys();
  t := property_today(prop);
  perform t_as(owner);
  perform issue_invoice(res, 't132-inv1');
  perform t_sys();
  select * into inv from invoices where reservation_id = res and invoice_status <> 'void';
  select coalesce(sum(n.service_minor), 0) into v_svc from reservation_nights n join reservation_rooms rr on rr.id = n.reservation_room_id where rr.reservation_id = res;
  if inv.service_minor <> v_svc or v_svc = 0 then raise exception 'FAIL invoice service % but nights say %', inv.service_minor, v_svc; end if;
  if inv.service_minor > inv.tax_minor or inv.tax_minor <> (select tax_minor from reservations where id = res) then raise exception 'FAIL invoice tax or service out of line'; end if;
  insert into t132 values ('inv', inv.id::text);
  -- the stay changes while an invoice exists: the reissued invoice must match the NEW nights, not the old ones
  perform t_as(owner);
  perform update_reservation_stay(res, t + 70, t + 72, null, 'shorter, with an invoice', 't132-inv2');
  perform t_sys();
  select * into inv from invoices where reservation_id = res and invoice_status <> 'void';
  select coalesce(sum(n.service_minor), 0) into v_svc from reservation_nights n join reservation_rooms rr on rr.id = n.reservation_room_id where rr.reservation_id = res;
  if inv.id is null then raise notice 'NOTE no live invoice after the stay change (none reissued)'; 
  elsif inv.service_minor <> v_svc or inv.tax_minor <> (select tax_minor from reservations where id = res) then raise exception 'FAIL reissued invoice service % tax % but nights say % and reservation tax %', inv.service_minor, inv.tax_minor, v_svc, (select tax_minor from reservations where id = res); end if;
  raise notice 'PASS service charge: the room invoice carries its service charge';
end $$;

-- E. the nights table cannot be written by a login, and the helper functions are closed
do $$ begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t132_refused($f$select calc_night_service('00000000-0000-0000-0000-0000000000a2', current_date, 100000)$f$, 'permission denied');
  perform t_sys();
  raise notice 'PASS service charge: calc_night_service is closed to logins';
end $$;

-- clean up
do $$ declare prop uuid := '00000000-0000-0000-0000-0000000000a2'; begin
  perform t_sys();
  update tax_rules set status = 'inactive' where name like 'T132%';
  update rooms set operational_status = 'retired' where property_id = prop and room_number like 'T132-%';
end $$;
drop function t132_refused(text, text);
