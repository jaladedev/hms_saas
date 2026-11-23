-- Staff note on a booking (migration 188). Reuses t_as / t_sys / t_expect (05).
-- Hotel A (property a2): aa01 owner, aa02 housekeeping, aa05 accountant. Hotel B: bb01 owner.
\set ON_ERROR_STOP on

create function t188_res() returns uuid language plpgsql as $$
declare v uuid := gen_random_uuid();
begin
  insert into reservations (id, tenant_id, property_id, booking_reference, primary_guest_id, source, reservation_status, arrival_date, departure_date)
  values (v, '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', upper(substr(replace(gen_random_uuid()::text,'-',''),1,10)),
          '00000000-0000-0000-0000-0000000000a5', 'staff_entry', 'cancelled', current_date + 5, current_date + 7);
  return v;
end $$;

-- 1. API: authenticated only, and clients cannot write the table
do $$ begin
  perform t_sys();
  if not has_function_privilege('authenticated', 'set_reservation_note(uuid, text)', 'execute')
     or has_function_privilege('anon', 'set_reservation_note(uuid, text)', 'execute')
     or has_function_privilege('public', 'set_reservation_note(uuid, text)', 'execute') then
    raise exception 'FAIL set_reservation_note privileges are wrong';
  end if;
  if has_table_privilege('authenticated', 'reservations', 'update') then raise exception 'FAIL clients can update reservations directly'; end if;
  raise notice 'PASS 188 api: authenticated only, no direct writes';
end $$;

-- 2. Owner sets, changes and clears a note, in any status (the booking is cancelled); the audit row holds the length, not the text
do $$ declare v uuid; r jsonb; n text;
begin
  perform t_sys(); v := t188_res();
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  r := set_reservation_note(v, E'  Arrives late\r\nwill call from the airport  ');
  if (r ->> 'changed') <> 'true' then raise exception 'FAIL first save not changed'; end if;
  select staff_note into n from reservations where id = v;
  if n <> E'Arrives late\nwill call from the airport' then raise exception 'FAIL note not trimmed and normalised: %', n; end if;
  r := set_reservation_note(v, E'Arrives late\nwill call from the airport');
  if (r ->> 'changed') <> 'false' then raise exception 'FAIL same text reported as changed'; end if;
  perform t_sys();
  if (select count(*) from audit_logs where entity_id = v and action = 'reservation.note_set') <> 1 then raise exception 'FAIL audit count after set'; end if;
  if exists (select 1 from audit_logs where entity_id = v and metadata::text ilike '%airport%') then raise exception 'FAIL note text in audit'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform set_reservation_note(v, '   ');
  perform t_sys();
  select staff_note into n from reservations where id = v;
  if n is not null then raise exception 'FAIL blank did not clear'; end if;
  if (select count(*) from audit_logs where entity_id = v and action = 'reservation.note_cleared') <> 1 then raise exception 'FAIL audit after clear'; end if;
  raise notice 'PASS 188 owner: set, normalise, no-op when unchanged, clear, audit has length only';
end $$;

-- 3. Limits and who may not
do $$ declare v uuid;
begin
  perform t_sys(); v := t188_res();
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform set_reservation_note(v, repeat('x', 1000));
  perform t_expect(format('select set_reservation_note(%L, repeat(%L, 1001))', v, 'x'), 'POLICY_VIOLATION: staff note');
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform t_expect(format('select set_reservation_note(%L, %L)', v, 'hi'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  perform t_expect(format('select set_reservation_note(%L, %L)', v, 'hi'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select set_reservation_note(%L, %L)', v, 'hi'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select set_reservation_note(%L, %L)', gen_random_uuid(), 'hi'), 'NOT_FOUND');
  perform t_sys();
  perform t_expect(format('select set_reservation_note(%L, %L)', v, 'hi'), 'NOT_FOUND');
  if (select staff_note from reservations where id = v) <> repeat('x', 1000) then raise exception 'FAIL a refused call changed the note'; end if;
  raise notice 'PASS 188 limits: 1000 ok, 1001 refused; housekeeping, accountant, other hotel, unknown id and system all refused';
end $$;
