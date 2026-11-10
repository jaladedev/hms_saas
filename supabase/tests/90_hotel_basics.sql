-- Hotel basics (migration 089): who may change them, what is refused, the audit row, and what guest_hotel returns afterwards.
-- Hotel A: property a2. Owner aa01, front desk aa04, another hotel's owner bb01. Reuses t_as / t_sys (05).
\set ON_ERROR_STOP on

create table t90_was (name text, address text, city text, state text, cin time, cout time);
insert into t90_was select name, address, city, state, check_in_time, check_out_time from properties where id = '00000000-0000-0000-0000-0000000000a2';

-- 1. the owner changes everything; values are trimmed, a blank address becomes null, guest_hotel and the audit row follow
do $$
declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; r jsonb;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform update_hotel_basics(v_p, '  Hotel A Renamed ', '  5 River Road ', ' Lagos ', ' Lagos State ', '15:00', '11:30');
  perform t_sys();
  r := guest_hotel('book.hotel-a.test');
  if r ->> 'name' <> 'Hotel A Renamed' or r ->> 'address' <> '5 River Road' or r ->> 'city' <> 'Lagos' or r ->> 'state' <> 'Lagos State'
     or (r ->> 'check_in_time')::time <> '15:00' or (r ->> 'check_out_time')::time <> '11:30' then raise exception 'FAIL basics %', r; end if;
  if not exists (select 1 from audit_logs where entity_id = v_p and action = 'property.updated' and metadata -> 'changed' ?& array['name','address','city','state','check_in_time','check_out_time']) then
    raise exception 'FAIL basics change not audited';
  end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform update_hotel_basics(v_p, 'Hotel A Renamed', '   ', 'Lagos', 'Lagos State', '15:00', '11:30');
  perform t_sys();
  if (select address from properties where id = v_p) is not null then raise exception 'FAIL a blank address should clear it'; end if;
  raise notice 'PASS hotel basics: saved trimmed, a blank address clears it, guest_hotel shows it, the change is audited';
end $$;

-- 2. refused values change nothing
do $$
declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_try text; v_refused integer := 0; v_name text;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  for v_try in select unnest(array['no name', 'name long', 'address long', 'no city', 'city long', 'no state', 'no check in', 'no check out'])
  loop
    begin
      case v_try
        when 'no name' then perform update_hotel_basics(v_p, '  ', null, 'Lagos', 'Lagos State', '15:00', '11:30');
        when 'name long' then perform update_hotel_basics(v_p, repeat('n', 121), null, 'Lagos', 'Lagos State', '15:00', '11:30');
        when 'address long' then perform update_hotel_basics(v_p, 'X', repeat('a', 201), 'Lagos', 'Lagos State', '15:00', '11:30');
        when 'no city' then perform update_hotel_basics(v_p, 'X', null, ' ', 'Lagos State', '15:00', '11:30');
        when 'city long' then perform update_hotel_basics(v_p, 'X', null, repeat('c', 81), 'Lagos State', '15:00', '11:30');
        when 'no state' then perform update_hotel_basics(v_p, 'X', null, 'Lagos', null, '15:00', '11:30');
        when 'no check in' then perform update_hotel_basics(v_p, 'X', null, 'Lagos', 'Lagos State', null, '11:30');
        when 'no check out' then perform update_hotel_basics(v_p, 'X', null, 'Lagos', 'Lagos State', '15:00', null);
      end case;
      raise exception 'FAIL % was accepted', v_try;
    exception when check_violation or invalid_parameter_value then v_refused := v_refused + 1;
    end;
  end loop;
  if v_refused <> 8 then raise exception 'FAIL only % refused', v_refused; end if;
  perform t_sys();
  select name into v_name from properties where id = v_p;
  if v_name <> 'Hotel A Renamed' then raise exception 'FAIL a refused change was stored %', v_name; end if;
  raise notice 'PASS hotel basics: 8 bad values refused and nothing stored';
end $$;

-- 3. only property.configure at this hotel; anon cannot call it
do $$
declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_state text;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select update_hotel_basics(%L, %L, null, %L, %L, %L, %L)', v_p, 'Hijacked', 'Lagos', 'Lagos State', '15:00', '11:30'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select update_hotel_basics(%L, %L, null, %L, %L, %L, %L)', v_p, 'Hijacked', 'Lagos', 'Lagos State', '15:00', '11:30'), 'NOT_FOUND');
  perform t_sys();
  if (select name from properties where id = v_p) = 'Hijacked' then raise exception 'FAIL a refused caller changed the hotel'; end if;
  begin
    set local role anon;
    perform update_hotel_basics(v_p, 'X', null, 'Lagos', 'Lagos State', '15:00', '11:30');
    v_state := 'allowed';
  exception when insufficient_privilege then v_state := 'refused';
  end;
  reset role;
  if v_state <> 'refused' then raise exception 'FAIL anon could call update_hotel_basics'; end if;
  raise notice 'PASS hotel basics: front desk and another hotel are refused, anon cannot call it';
end $$;

-- 4. put the hotel back as it was for the tests that follow
do $$ begin
  perform t_sys();
  update properties p set name = w.name, address = w.address, city = w.city, state = w.state, check_in_time = w.cin, check_out_time = w.cout
  from t90_was w where p.id = '00000000-0000-0000-0000-0000000000a2';
  raise notice 'PASS hotel basics: restored';
end $$;
