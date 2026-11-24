-- A staff note saved offline is applied only if the note is unchanged (migration 190). Reuses t_as / t_sys / t_expect (05).
-- Hotel A (property a2): aa01 owner, aa02 housekeeping, aa05 accountant. Hotel B: bb01 owner.
-- A block is one transaction, so now() is the same everywhere inside it: times are compared exactly.
\set ON_ERROR_STOP on

create function t190_res() returns uuid language plpgsql as $$
declare v uuid := gen_random_uuid();
begin
  insert into reservations (id, tenant_id, property_id, booking_reference, primary_guest_id, source, reservation_status, arrival_date, departure_date, created_at)
  values (v, '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', upper(substr(replace(gen_random_uuid()::text,'-',''),1,10)),
          '00000000-0000-0000-0000-0000000000a5', 'staff_entry', 'cancelled', current_date + 5, current_date + 7, now() - interval '5 hours');
  return v;
end $$;
create function t190_note(p uuid) returns text language sql stable as $$ select staff_note from reservations where id = p $$;
create function t190_audits(p uuid) returns bigint language sql stable as $$
  select count(*) from audit_logs where entity_id = p and action in ('reservation.note_set', 'reservation.note_cleared')
$$;

-- 1. API: authenticated only; the old function is still there
do $$ begin
  perform t_sys();
  if not has_function_privilege('authenticated', 'set_reservation_note_if_unchanged(uuid, text, text, timestamptz)', 'execute')
     or has_function_privilege('anon', 'set_reservation_note_if_unchanged(uuid, text, text, timestamptz)', 'execute')
     or has_function_privilege('public', 'set_reservation_note_if_unchanged(uuid, text, text, timestamptz)', 'execute') then
    raise exception 'FAIL set_reservation_note_if_unchanged privileges are wrong';
  end if;
  if to_regprocedure('set_reservation_note(uuid, text)') is null then raise exception 'FAIL set_reservation_note is gone'; end if;
  raise notice 'PASS 190 api: authenticated only, set_reservation_note unchanged';
end $$;

-- 2. Applied when the note is still what the person replaced (including no note: null and an empty or blank expected match)
do $$ declare v uuid; r jsonb;
begin
  perform t_sys(); v := t190_res();
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  r := set_reservation_note_if_unchanged(v, E'  Arrives late\r\nwill call  ', '');
  if (r ->> 'changed') <> 'true' then raise exception 'FAIL first save not changed: %', r; end if;
  perform t_sys();
  if t190_note(v) <> E'Arrives late\nwill call' then raise exception 'FAIL note not trimmed and normalised: %', t190_note(v); end if;

  perform t_as('00000000-0000-0000-0000-00000000aa01');
  r := set_reservation_note_if_unchanged(v, 'Paying by transfer', E'Arrives late\r\nwill call');   -- expected cleaned like a note
  if (r ->> 'changed') <> 'true' then raise exception 'FAIL second save not changed'; end if;
  r := set_reservation_note_if_unchanged(v, '   ', 'Paying by transfer');                          -- a blank clears it
  perform t_sys();
  if t190_note(v) is not null then raise exception 'FAIL blank did not clear'; end if;
  if t190_audits(v) <> 3 then raise exception 'FAIL audit count %', t190_audits(v); end if;
  if exists (select 1 from audit_logs where entity_id = v and metadata::text ilike '%transfer%') then raise exception 'FAIL note text in audit'; end if;
  raise notice 'PASS 190 applied: expected matched (cleaned, null equals blank), set, change and clear all audited with length only';
end $$;

-- 3. Someone else changed the note meanwhile: refused, nothing written, nothing audited
do $$ declare v uuid;
begin
  perform t_sys(); v := t190_res();
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform set_reservation_note(v, 'Original');
  perform set_reservation_note(v, 'Changed by someone else');
  perform t_sys();
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select set_reservation_note_if_unchanged(%L, %L, %L)', v, 'My offline note', 'Original'), 'CONFLICT: staff note changed');
  perform t_expect(format('select set_reservation_note_if_unchanged(%L, %L, %L)', v, 'My offline note', ''), 'CONFLICT: staff note changed');
  perform t_sys();
  if t190_note(v) <> 'Changed by someone else' then raise exception 'FAIL a refused save changed the note'; end if;
  if t190_audits(v) <> 2 then raise exception 'FAIL a refused save was audited'; end if;
  raise notice 'PASS 190 conflict: a note changed meanwhile is refused with CONFLICT, nothing written or audited';
end $$;

-- 4. Sending the same change twice is harmless; sending it after a later edit by the same text is still a no-op
do $$ declare v uuid; r jsonb; n bigint;
begin
  perform t_sys(); v := t190_res();
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform set_reservation_note_if_unchanged(v, 'Late arrival', '');
  perform t_sys(); n := t190_audits(v);
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  r := set_reservation_note_if_unchanged(v, 'Late arrival', '');                 -- the answer was lost and it was sent again
  if (r ->> 'changed') <> 'false' then raise exception 'FAIL a repeat reported a change: %', r; end if;
  perform t_sys();
  if t190_note(v) <> 'Late arrival' or t190_audits(v) <> n then raise exception 'FAIL a repeat changed something'; end if;
  raise notice 'PASS 190 repeat: the same change sent twice is applied once, with no second audit row';
end $$;

-- 5. Limits and who may not, as for set_reservation_note
do $$ declare v uuid;
begin
  perform t_sys(); v := t190_res();
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform set_reservation_note_if_unchanged(v, repeat('x', 1000), '');
  perform t_expect(format('select set_reservation_note_if_unchanged(%L, repeat(%L, 1001), %L)', v, 'x', repeat('x', 1000)), 'POLICY_VIOLATION: staff note');
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform t_expect(format('select set_reservation_note_if_unchanged(%L, %L, %L)', v, 'hi', repeat('x', 1000)), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  perform t_expect(format('select set_reservation_note_if_unchanged(%L, %L, %L)', v, 'hi', repeat('x', 1000)), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select set_reservation_note_if_unchanged(%L, %L, %L)', v, 'hi', repeat('x', 1000)), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select set_reservation_note_if_unchanged(%L, %L, %L)', gen_random_uuid(), 'hi', ''), 'NOT_FOUND');
  perform t_sys();
  perform t_expect(format('select set_reservation_note_if_unchanged(%L, %L, %L)', v, 'hi', repeat('x', 1000)), 'NOT_FOUND');
  if t190_note(v) <> repeat('x', 1000) then raise exception 'FAIL a refused call changed the note'; end if;
  raise notice 'PASS 190 limits: 1000 ok, 1001 refused; housekeeping, accountant, other hotel, unknown id and system all refused';
end $$;

-- 6. The time it was made: kept inside the bounds, recorded beside the arrival time; none given means no made_at.
-- The rows of one transaction share a created_at, so each note has its own length and its audit row is found by that length.
do $$ declare v uuid; a jsonb;
begin
  perform t_sys(); v := t190_res();
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform set_reservation_note_if_unchanged(v, 'One', '', now() - interval '2 hours');
  perform t_sys();
  select metadata into a from audit_logs where entity_id = v and action = 'reservation.note_set' and metadata ->> 'length' = '3';
  if (a ->> 'made_at')::timestamptz <> now() - interval '2 hours' or (a ->> 'received_at')::timestamptz <> now() then raise exception 'FAIL audit times %', a; end if;

  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform set_reservation_note_if_unchanged(v, 'Twooo', 'One', now() + interval '1 day');        -- future: now
  perform t_sys();
  select metadata into a from audit_logs where entity_id = v and action = 'reservation.note_set' and metadata ->> 'length' = '5';
  if (a ->> 'made_at')::timestamptz <> now() then raise exception 'FAIL a future time was kept %', a; end if;

  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform set_reservation_note_if_unchanged(v, 'Three333', 'Twooo', now() - interval '9 hours');  -- before the booking existed: when it was made
  perform t_sys();
  select metadata into a from audit_logs where entity_id = v and action = 'reservation.note_set' and metadata ->> 'length' = '8';
  if (a ->> 'made_at')::timestamptz <> (select created_at from reservations where id = v) then raise exception 'FAIL a time before the booking was kept %', a; end if;

  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform set_reservation_note_if_unchanged(v, 'Four', 'Three333');                              -- no time: no made_at
  perform t_sys();
  select metadata into a from audit_logs where entity_id = v and action = 'reservation.note_set' and metadata ->> 'length' = '4';
  if a is null or a ? 'made_at' then raise exception 'FAIL an online save wrote made_at %', a; end if;
  raise notice 'PASS 190 time: made_at kept inside the bounds, with received_at; none given means none recorded';
end $$;
