-- Night audit and day close (migration 145). Hotel A: tenant a1, property a2. Owner aa01, front desk aa04 and ab02, general manager ab01,
-- accountant ab04 (made in 42), another hotel's owner bb01. Room type a3, guest a5. Reuses t_as / t_sys / t_expect / t_book (05).
-- The audit works on days up to today, so stays that "should be in house" are made by booking far ahead and then moving the dates with
-- triggers off, the way 129 does. Counts are compared as changes against what was open before, so leftovers from other tests do not matter.
\set ON_ERROR_STOP on

-- A stay for the audit: booked through create_reservation, then given the dates, stay status and room status asked for.
create function t145_stay(p_key text, p_arr_off integer, p_dep_off integer, p_status text, p_room_status text) returns uuid
language plpgsql as $$
declare
  v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_t date := property_today(v_p);
  v_far date := current_date + 500 + (random() * 300)::int; v_res uuid;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  v_res := (t_book('00000000-0000-0000-0000-0000000000a3', v_far, v_far + 2, p_key) ->> 'reservation_id')::uuid;
  perform t_sys();
  set local session_replication_role = replica;
  delete from room_inventory_claims where reservation_room_id in (select id from reservation_rooms where reservation_id = v_res);
  update reservations set arrival_date = v_t + p_arr_off, departure_date = v_t + p_dep_off, reservation_status = p_status where id = v_res;
  update reservation_rooms set room_status = p_room_status where reservation_id = v_res;
  set local session_replication_role = origin;
  return v_res;
end $$;

create temp table t145_ctx (k text primary key, v text);

-- 1. who holds the permission: owner, general manager and accountant; nobody else
do $$ declare r text; begin
  perform t_sys();
  for r in select unnest(array['owner', 'general_manager', 'accountant']) loop
    if not exists (select 1 from role_permissions rp join roles ro on ro.id = rp.role_id join permissions p on p.id = rp.permission_id
                    where ro.key = r and p.key = 'day.close') then raise exception 'FAIL % lacks day.close', r; end if;
  end loop;
  for r in select unnest(array['front_desk', 'reservations_officer', 'housekeeping', 'maintenance']) loop
    if exists (select 1 from role_permissions rp join roles ro on ro.id = rp.role_id join permissions p on p.id = rp.permission_id
                where ro.key = r and p.key = 'day.close') then raise exception 'FAIL % holds day.close', r; end if;
  end loop;
  raise notice 'PASS day.close belongs to the owner, general manager and accountant only';
end $$;

-- 2. daily_report still answers exactly what the shared query answers, and the shared functions are not open to staff or anon
do $$ declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_t date := property_today('00000000-0000-0000-0000-0000000000a2'); v_a jsonb; v_b jsonb; begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  select jsonb_agg(to_jsonb(x) order by x.day) into v_a from daily_report(v_p, v_t - 3, v_t + 3) x;
  perform t_sys();
  select jsonb_agg(to_jsonb(x) order by x.day) into v_b from daily_report_figures(v_p, v_t - 3, v_t + 3) x;
  if v_a is null or jsonb_array_length(v_a) <> 7 or v_a <> v_b then raise exception 'FAIL daily_report and daily_report_figures differ: % vs %', v_a, v_b; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  begin perform * from daily_report_figures(v_p, v_t, v_t); raise exception 'FAIL staff ran the unchecked report query';
  exception when insufficient_privilege then null; end;
  begin perform night_audit_items(v_p, v_t); raise exception 'FAIL staff ran night_audit_items';
  exception when insufficient_privilege then null; end;
  perform t_sys();
  set local role anon;
  begin perform night_audit_preview(v_p, v_t); raise exception 'FAIL anon ran the preview';
  exception when insufficient_privilege then null; end;
  begin perform close_day(v_p, v_t, null, 'anon-key'); raise exception 'FAIL anon closed a day';
  exception when insufficient_privilege then null; end;
  perform t_sys();
  raise notice 'PASS daily_report is unchanged; the unchecked query and the items are for the functions only; anon runs nothing';
end $$;

-- 3. a clean day closes without a note; a note given for a clean day is not stored; one audit row; replay; second close refused
do $$ declare
  v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_t date := property_today('00000000-0000-0000-0000-0000000000a2');
  v_day date := v_t - 300; r jsonb; r2 jsonb; pv jsonb;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  pv := night_audit_preview(v_p, v_day);
  if (pv ->> 'closed')::boolean is not false or (pv #>> '{items,total}')::integer <> 0 then raise exception 'FAIL a day 300 days back should be clean and open: %', pv; end if;
  r := close_day(v_p, v_day, 'a note nobody needed', 't145-clean-1');
  if (r ->> 'open_items')::integer <> 0 or r ->> 'business_date' <> v_day::text then raise exception 'FAIL clean close %', r; end if;
  if close_day(v_p, v_day, 'a note nobody needed', 't145-clean-1') <> r then raise exception 'FAIL replay differs'; end if;
  perform t_expect(format('select close_day(%L, %L, null, ''t145-clean-2'')', v_p, v_day), 'INVALID_STATE: already closed');
  perform t_expect(format('select close_day(%L, %L, ''a different note'', ''t145-clean-1'')', v_p, v_day), 'IDEMPOTENCY_MISMATCH');
  if (night_audit_preview(v_p, v_day) ->> 'closed')::boolean is not true then raise exception 'FAIL preview does not show it closed'; end if;
  perform t_sys();
  if (select count(*) from day_closes where property_id = v_p and business_date = v_day) <> 1 then raise exception 'FAIL not exactly one row'; end if;
  if (select override_note from day_closes where property_id = v_p and business_date = v_day) is not null then raise exception 'FAIL a needless note was kept'; end if;
  if (select count(*) from audit_logs where action = 'day.closed' and entity_id = (r ->> 'close_id')::uuid) <> 1 then raise exception 'FAIL audit rows'; end if;
  if (select closed_by from day_closes where id = (r ->> 'close_id')::uuid) <> '00000000-0000-0000-0000-00000000aa01' then raise exception 'FAIL closed_by'; end if;
  raise notice 'PASS a clean day closes once, replays by key, refuses a second close, keeps no needless note, writes one audit row';
end $$;

-- 4. refusals: days after today, days too far back, missing day, short or long note
do $$ declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_t date := property_today('00000000-0000-0000-0000-0000000000a2'); begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select night_audit_preview(%L, %L)', v_p, v_t + 1), 'POLICY_VIOLATION: future day');
  perform t_expect(format('select close_day(%L, %L, ''a note'', ''t145-fut'')', v_p, v_t + 1), 'POLICY_VIOLATION: future day');
  perform t_expect(format('select night_audit_preview(%L, %L)', v_p, v_t - 400), 'POLICY_VIOLATION: day too old');
  perform t_expect(format('select close_day(%L, %L, ''a note'', ''t145-old'')', v_p, v_t - 400), 'POLICY_VIOLATION: day too old');
  perform t_expect(format('select close_day(%L, null, ''a note'', ''t145-null'')', v_p), 'POLICY_VIOLATION: day required');
  perform t_expect(format('select close_day(%L, %L, ''ok'', ''t145-short'')', v_p, v_t - 299), 'POLICY_VIOLATION: note length');
  perform t_expect(format('select close_day(%L, %L, repeat(''x'', 501), ''t145-long'')', v_p, v_t - 299), 'POLICY_VIOLATION: note length');
  perform t_expect(format('select close_day(%L, %L, null, '''')', v_p, v_t - 299), 'POLICY_VIOLATION: idempotency key required');
  perform t_expect(format('select night_audit_days(%L, 0)', v_p), 'POLICY_VIOLATION: days');
  perform t_expect(format('select night_audit_days(%L, 93)', v_p), 'POLICY_VIOLATION: days');
  perform t_sys();
  if exists (select 1 from day_closes where business_date in (v_t + 1, v_t - 400, v_t - 299)) then raise exception 'FAIL a refused close left a row'; end if;
  raise notice 'PASS future, too-old, missing-day, bad-note and missing-key closes are refused and leave nothing behind';
end $$;

-- 5. who may use it: front desk and a reservations officer are refused; manager, accountant and owner may; another hotel's owner is not found
do $$ declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_t date := property_today('00000000-0000-0000-0000-0000000000a2'); u text; begin
  foreach u in array array['00000000-0000-0000-0000-00000000aa04', '00000000-0000-0000-0000-00000000ab02', '00000000-0000-0000-0000-00000000ab03', '00000000-0000-0000-0000-00000000bb01'] loop
    perform t_as(u);
    perform t_expect(format('select night_audit_preview(%L, %L)', v_p, v_t), 'NOT_FOUND');
    perform t_expect(format('select close_day(%L, %L, ''a note'', %L)', v_p, v_t - 298, 't145-deny-' || u), 'NOT_FOUND');
    perform t_expect(format('select night_audit_days(%L, 7)', v_p), 'NOT_FOUND');
    if (select count(*) from day_closes) <> 0 then raise exception 'FAIL % reads day_closes rows', u; end if;
  end loop;
  foreach u in array array['00000000-0000-0000-0000-00000000ab01', '00000000-0000-0000-0000-00000000ab04', '00000000-0000-0000-0000-00000000aa01'] loop
    perform t_as(u);
    if night_audit_preview(v_p, v_t) is null then raise exception 'FAIL % got no preview', u; end if;
    if jsonb_array_length(night_audit_days(v_p, 7)) <> 7 then raise exception 'FAIL % got no day list', u; end if;
    if (select count(*) from day_closes) < 1 then raise exception 'FAIL % cannot read closes', u; end if;
  end loop;
  -- and the accountant can close a day, not only look
  perform t_as('00000000-0000-0000-0000-00000000ab04');
  if (close_day(v_p, v_t - 297, null, 't145-ac') ->> 'business_date') <> (v_t - 297)::text then raise exception 'FAIL the accountant could not close a day'; end if;
  perform t_sys();
  if (select closed_by from day_closes where property_id = v_p and business_date = v_t - 297) <> '00000000-0000-0000-0000-00000000ab04' then raise exception 'FAIL closed_by is not the accountant'; end if;
  raise notice 'PASS front desk, a reservations officer and another hotel are refused; manager, accountant and owner may use it';
end $$;

-- 6. open items: the audit counts arrivals not in, departures not out and unverified payments; closing needs a note, keeps the counts
do $$ declare
  v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_t date := property_today('00000000-0000-0000-0000-0000000000a2');
  b jsonb; a jsonb; arr uuid; dep uuid; r jsonb; c day_closes%rowtype; pay_ref text;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  b := night_audit_preview(v_p, v_t) -> 'items';
  perform t_sys();
  -- a confirmed stay whose room is still booked (arrived 2 days ago, leaves in 3), a checked-in room whose stay ended yesterday,
  -- a checked-in stay that has not ended, and a pending stay that is not confirmed (none of the last two may count)
  arr := t145_stay('t145-arr', -2, 3, 'confirmed', 'booked');
  dep := t145_stay('t145-dep', -3, -1, 'checked_in', 'checked_in');
  perform t145_stay('t145-inhouse', -1, 2, 'checked_in', 'checked_in');
  perform t145_stay('t145-pending', -1, 2, 'pending', 'booked');
  insert into t145_ctx values ('arr', arr::text), ('dep', dep::text);

  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform record_manual_payment(arr, 10000, 'bank_transfer', 'slip-145', null, 't145-pay-bank');
  perform record_manual_payment(arr, 5000, 'cash', null, null, 't145-pay-cash');
  a := night_audit_preview(v_p, v_t) -> 'items';
  if (a ->> 'arrivals_not_checked_in')::int <> (b ->> 'arrivals_not_checked_in')::int + 1 then raise exception 'FAIL arrivals % -> %', b, a; end if;
  if (a ->> 'departures_not_checked_out')::int <> (b ->> 'departures_not_checked_out')::int + 1 then raise exception 'FAIL departures % -> %', b, a; end if;
  if (a ->> 'unverified_payments')::int <> (b ->> 'unverified_payments')::int + 1 then raise exception 'FAIL unverified payments (cash must not count) % -> %', b, a; end if;
  if (a ->> 'unverified_payments_minor')::bigint <> (b ->> 'unverified_payments_minor')::bigint + 10000 then raise exception 'FAIL unverified amount % -> %', b, a; end if;
  if (a ->> 'total')::int <> (b ->> 'total')::int + 3 then raise exception 'FAIL total % -> %', b, a; end if;
  if not exists (select 1 from jsonb_array_elements(a -> 'arrivals') e where e ->> 'reservation_id' = arr::text) then raise exception 'FAIL the arrival is not listed'; end if;
  if not exists (select 1 from jsonb_array_elements(a -> 'departures') e where e ->> 'reservation_id' = dep::text) then raise exception 'FAIL the departure is not listed'; end if;
  if not exists (select 1 from jsonb_array_elements(a -> 'payments') e where e ->> 'reservation_id' = arr::text and (e ->> 'amount_minor')::bigint = 10000) then raise exception 'FAIL the payment is not listed'; end if;

  perform t_expect(format('select close_day(%L, %L, null, ''t145-open-1'')', v_p, v_t), 'POLICY_VIOLATION: open items need a note');
  perform t_expect(format('select close_day(%L, %L, ''   '', ''t145-open-2'')', v_p, v_t), 'POLICY_VIOLATION: open items need a note');
  r := close_day(v_p, v_t, 'Late arrival expected, transfer slip checked tomorrow', 't145-open-3');
  if (r ->> 'open_items')::int <> (a ->> 'total')::int then raise exception 'FAIL close reports % open, preview said %', r ->> 'open_items', a ->> 'total'; end if;
  perform t_sys();
  select * into c from day_closes where id = (r ->> 'close_id')::uuid;
  if c.override_note <> 'Late arrival expected, transfer slip checked tomorrow' then raise exception 'FAIL note %', c.override_note; end if;
  if (c.open_items ->> 'arrivals_not_checked_in')::int <> (a ->> 'arrivals_not_checked_in')::int
     or (c.open_items ->> 'unverified_payments_minor')::bigint <> (a ->> 'unverified_payments_minor')::bigint
     or (c.open_items ->> 'total')::int <> (a ->> 'total')::int then raise exception 'FAIL kept counts %', c.open_items; end if;
  if (select metadata ->> 'override_note' from audit_logs where action = 'day.closed' and entity_id = c.id) <> c.override_note then raise exception 'FAIL audit note'; end if;
  insert into t145_ctx values ('today_close', c.id::text);
  raise notice 'PASS open items are counted and listed, closing with them needs a note, and the counts and note are kept and audited';
end $$;

-- 7. the figures are frozen at close; a later change shows as changed_since_close, the kept figures do not move
do $$ declare
  v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_t date := property_today('00000000-0000-0000-0000-0000000000a2');
  arr uuid := (select v::uuid from t145_ctx where k = 'arr'); close_id uuid := (select v::uuid from t145_ctx where k = 'today_close')::uuid;
  kept jsonb; days jsonb; today_row jsonb; pv jsonb; clean_day date := v_t - 60; r jsonb; row0 jsonb;
begin
  perform t_sys();
  select figures into kept from day_closes where id = close_id;

  -- right after the close nothing has moved
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  days := night_audit_days(v_p, 7);
  today_row := days -> 0;
  if today_row ->> 'day' <> v_t::text or (today_row ->> 'closed')::boolean is not true or (today_row ->> 'changed_since_close')::boolean is not false then
    raise exception 'FAIL fresh close should be unchanged: %', today_row; end if;

  -- a day nobody closed has no changed flag; the days come newest first
  row0 := days -> 1;
  if (row0 ->> 'closed')::boolean is not false or row0 -> 'changed_since_close' <> 'null'::jsonb then raise exception 'FAIL an open day: %', row0; end if;
  if (select array_agg(e ->> 'day' order by ord) from jsonb_array_elements(days) with ordinality t(e, ord))
     <> (select array_agg((v_t - i)::text order by i) from generate_series(0, 6) i) then raise exception 'FAIL days are not newest first'; end if;

  -- a charge posted for the closed day after the close
  perform t_sys();
  insert into folio_charges (tenant_id, property_id, reservation_id, category, description, quantity, unit_amount_minor, tax_minor, total_minor, currency, charge_date)
    select tenant_id, property_id, id, 'minibar', 'Late water', 1, 20000, 1500, 21500, 'NGN', v_t from reservations where id = arr;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  today_row := night_audit_days(v_p, 7) -> 0;
  if (today_row ->> 'changed_since_close')::boolean is not true then raise exception 'FAIL late charge not flagged: %', today_row; end if;
  if today_row -> 'figures' <> kept then raise exception 'FAIL the kept figures moved: % vs %', today_row -> 'figures', kept; end if;
  pv := night_audit_preview(v_p, v_t);
  if (pv #>> '{figures,extras_minor}')::bigint <> (kept ->> 'extras_minor')::bigint + 20000 then raise exception 'FAIL live figures %', pv -> 'figures'; end if;
  if pv -> 'kept_figures' <> kept then raise exception 'FAIL preview kept figures'; end if;
  perform t_sys();
  if (select figures from day_closes where id = close_id) <> kept then raise exception 'FAIL the stored row moved'; end if;

  -- a day 60 back, closed clean, then changed
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  r := close_day(v_p, clean_day, null, 't145-d60');
  if (select e ->> 'changed_since_close' from jsonb_array_elements(night_audit_days(v_p, 61)) e where e ->> 'day' = clean_day::text) <> 'false' then raise exception 'FAIL d60 changed too early'; end if;
  perform t_sys();
  insert into folio_payments (tenant_id, property_id, reservation_id, payment_method, internal_reference, amount_minor, currency, received_at)
    select tenant_id, property_id, id, 'cash', 'T145-FP-1', 3000, 'NGN', (clean_day::timestamp + interval '10 hours') at time zone (select timezone from properties where id = v_p)
      from reservations where id = arr;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  if (select e ->> 'changed_since_close' from jsonb_array_elements(night_audit_days(v_p, 61)) e where e ->> 'day' = clean_day::text) <> 'true' then raise exception 'FAIL late payment not flagged'; end if;
  perform t_sys();
  raise notice 'PASS closed figures are kept as they were, and a late charge or payment shows as changed since close';
end $$;

-- 8. a closed day is a record: no direct writes, no edits, no deletes; only the database clearing closed_by when a login is removed
do $$ declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_t date := property_today('00000000-0000-0000-0000-0000000000a2'); id0 uuid; n integer; begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  begin
    insert into day_closes (tenant_id, property_id, business_date, figures, open_items) values ('00000000-0000-0000-0000-0000000000a1', v_p, v_t - 200, '{}', '{}');
    raise exception 'FAIL staff inserted a close';
  exception when insufficient_privilege then null; end;
  begin update day_closes set override_note = 'edited by staff'; raise exception 'FAIL staff edited a close';
  exception when insufficient_privilege then null; end;
  begin delete from day_closes; raise exception 'FAIL staff deleted a close';
  exception when insufficient_privilege then null; end;
  perform t_sys();
  begin update day_closes set override_note = 'edited by the owner of the database'; raise exception 'FAIL a close was edited';
  exception when sqlstate '23514' then null; end;
  begin update day_closes set figures = '{}'::jsonb; raise exception 'FAIL figures were edited';
  exception when sqlstate '23514' then null; end;
  begin delete from day_closes; raise exception 'FAIL a close was deleted';
  exception when sqlstate '23514' then null; end;
  -- clearing closed_by alone is what "on delete set null" does, and it must work; moving it to someone else must not
  select id into id0 from day_closes where closed_by = '00000000-0000-0000-0000-00000000aa01' limit 1;
  begin update day_closes set closed_by = '00000000-0000-0000-0000-00000000aa04' where id = id0; raise exception 'FAIL closed_by was reassigned';
  exception when sqlstate '23514' then null; end;
  update day_closes set closed_by = null where id = id0;
  select count(*) into n from day_closes where id = id0 and closed_by is null;
  if n <> 1 then raise exception 'FAIL closed_by was not cleared'; end if;
  raise notice 'PASS a closed day cannot be inserted, edited or deleted by staff or anyone; only closed_by may be cleared';
end $$;

-- 9. another hotel never sees this hotel's closes, and its owner cannot close this hotel's days
do $$ declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_t date := property_today('00000000-0000-0000-0000-0000000000a2'); begin
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  if (select count(*) from day_closes) <> 0 then raise exception 'FAIL another hotel reads closes'; end if;
  perform t_expect(format('select close_day(%L, %L, ''a note'', ''t145-other'')', v_p, v_t - 100), 'NOT_FOUND');
  perform t_expect('select night_audit_preview(gen_random_uuid(), current_date)', 'NOT_FOUND');
  perform t_sys();
  raise notice 'PASS another hotel sees no closes and cannot close this hotel''s days';
end $$;
