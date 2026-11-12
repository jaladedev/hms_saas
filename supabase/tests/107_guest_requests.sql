-- Address and special requests on the guest booking form (migration 107). Host from 06: book.hotel-a.test; Standard type a3.
\set ON_ERROR_STOP on

create function t107_hold(p_guest jsonb, p_off integer default 200, p_key text default null) returns jsonb language plpgsql as $$
begin
  return create_hold('book.hotel-a.test', current_date + p_off, current_date + p_off + 2,
                     '[{"room_type_id":"00000000-0000-0000-0000-0000000000a3","adults":2}]'::jsonb, p_guest, coalesce(p_key, gen_random_uuid()::text));
end $$;

-- 1. the note and the address are kept, trimmed; blank means none
do $$ declare r jsonb; v_g uuid; begin
  r := t107_hold('{"full_name":"Request Guest","email":"req1@example.com","address":"  12 Oyo Road, Ibadan ","special_requests":"  High floor, extra pillows  "}');
  if (select guest_note from reservations where id = (r ->> 'reservation_id')::uuid) <> 'High floor, extra pillows' then raise exception 'FAIL note not kept or not trimmed'; end if;
  select primary_guest_id into v_g from reservations where id = (r ->> 'reservation_id')::uuid;
  if (select address from guests where id = v_g) <> '12 Oyo Road, Ibadan' then raise exception 'FAIL address not kept or not trimmed'; end if;
  r := t107_hold('{"full_name":"Plain Guest","email":"req2@example.com","address":"   ","special_requests":""}', 210);
  if (select guest_note from reservations where id = (r ->> 'reservation_id')::uuid) is not null then raise exception 'FAIL blank note kept'; end if;
  select primary_guest_id into v_g from reservations where id = (r ->> 'reservation_id')::uuid;
  if (select address from guests where id = v_g) is not null then raise exception 'FAIL blank address kept'; end if;
  r := t107_hold('{"full_name":"No Fields","email":"req3@example.com"}', 220);
  if (select guest_note from reservations where id = (r ->> 'reservation_id')::uuid) is not null then raise exception 'FAIL note appeared from nothing'; end if;
  raise notice 'PASS guest requests: note and address kept and trimmed, blank or absent means none';
end $$;

-- 2. a returning guest keeps the address on file; one with none gets the new address
do $$ declare r jsonb; v_g uuid; begin
  r := t107_hold('{"full_name":"Repeat Guest","email":"req4@example.com","address":"First Street"}', 230);
  select primary_guest_id into v_g from reservations where id = (r ->> 'reservation_id')::uuid;
  perform t107_hold('{"full_name":"Repeat Guest","email":"req4@example.com","address":"Second Street"}', 240);
  if (select address from guests where id = v_g) <> 'First Street' then raise exception 'FAIL address overwritten from the website'; end if;
  update guests set address = null where id = v_g;
  perform t107_hold('{"full_name":"Repeat Guest","email":"req4@example.com","address":"Third Street"}', 250);
  if (select address from guests where id = v_g) <> 'Third Street' then raise exception 'FAIL empty address not filled'; end if;
  raise notice 'PASS guest requests: an address on file is never overwritten, an empty one is filled';
end $$;

-- 3. too long is refused and nothing is written; the replay of one request returns the same reservation
do $$ declare v_n int; r1 jsonb; r2 jsonb; v_k text := gen_random_uuid()::text; begin
  select count(*) into v_n from reservations;
  begin perform t107_hold(jsonb_build_object('full_name', 'Long Guest', 'email', 'req5@example.com', 'special_requests', repeat('x', 501)), 260);
    raise exception 'FAIL 501 characters accepted';
  exception when sqlstate 'P0001' then if sqlerrm <> 'POLICY_VIOLATION: guest requests' then raise; end if; end;
  begin perform t107_hold(jsonb_build_object('full_name', 'Long Guest', 'email', 'req5@example.com', 'address', repeat('x', 201)), 260);
    raise exception 'FAIL 201 characters accepted';
  exception when sqlstate 'P0001' then if sqlerrm <> 'POLICY_VIOLATION: guest address' then raise; end if; end;
  if (select count(*) from reservations) <> v_n then raise exception 'FAIL a refused request wrote a reservation'; end if;
  perform t107_hold(jsonb_build_object('full_name', 'Max Guest', 'email', 'req6@example.com', 'special_requests', repeat('x', 500), 'address', repeat('y', 200)), 270);
  r1 := t107_hold('{"full_name":"Replay Guest","email":"req7@example.com","special_requests":"Quiet room"}', 280, v_k);
  r2 := t107_hold('{"full_name":"Replay Guest","email":"req7@example.com","special_requests":"Quiet room"}', 280, v_k);
  if r1 is distinct from r2 then raise exception 'FAIL replay returned something else'; end if;
  begin perform t107_hold('{"full_name":"Replay Guest","email":"req7@example.com","special_requests":"Different"}', 280, v_k);
    raise exception 'FAIL the same key was accepted with a different note';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  raise notice 'PASS guest requests: limits enforced (500 and 200), nothing written on refusal, replay safe, a changed note under the same key refused';
end $$;

-- 4. the staff of that hotel can read the note; another hotel's staff cannot
do $$ declare v_id uuid; begin
  select id into v_id from reservations where guest_note = 'Quiet room' limit 1;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  if (select guest_note from reservations where id = v_id) is distinct from 'Quiet room' then raise exception 'FAIL owner cannot read the note'; end if;
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  if exists (select 1 from reservations where id = v_id) then raise exception 'FAIL another hotel can read the reservation'; end if;
  perform t_sys();
  raise notice 'PASS guest requests: visible to the hotel''s own staff only';
end $$;
drop function t107_hold(jsonb, integer, text);
