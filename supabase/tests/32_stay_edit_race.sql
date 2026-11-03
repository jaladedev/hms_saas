-- Helpers for the stay-edit concurrency test at the end of run.sh (migration 033). Loaded once; the race itself is a pgbench script.
-- Hotel A, property a2, type STD (a3) has five rooms. Four real bookings of three nights are made from today + p_off, one per room,
-- by front desk (aa04), and then clients edit, move and compete with them at the same time.
\set ON_ERROR_STOP on

create table t32_res (label text not null, n integer not null, res uuid not null, rr uuid not null, primary key (label, n));

create function t32_setup(p_label text, p_off integer, p_count integer) returns void language plpgsql as $$
declare
  prop constant uuid := '00000000-0000-0000-0000-0000000000a2'; typ constant uuid := '00000000-0000-0000-0000-0000000000a3';
  t date := property_today(prop); b jsonb; r record; i integer := 0;
begin
  for r in select id from rooms where property_id = prop and room_type_id = typ and operational_status = 'active' order by room_number limit p_count loop
    perform t_as('00000000-0000-0000-0000-00000000aa04');
    b := t_book(typ, t + p_off, t + p_off + 3, 'race-' || p_label || '-' || i, r.id);
    perform t_sys();
    insert into t32_res values (p_label, i, (b ->> 'reservation_id')::uuid, t_rr(b));
    i := i + 1;
  end loop;
end $$;

-- One client action on "its" booking (client number modulo the fixture size). what 0 to 7: change the departure to between two and
-- eight nights after the arrival (and sometimes the guest numbers); 8 to 10: a stranger books one night inside the same window;
-- 11: move the guest to another room from the second night (after which that booking's dates can no longer be edited). Deadlocks are retried, as a caller should; a refusal is counted, not an error.
create function t32_act(p_label text, p_client integer, p_what integer, p_rand integer) returns boolean language plpgsql as $$
declare
  prop constant uuid := '00000000-0000-0000-0000-0000000000a2'; typ constant uuid := '00000000-0000-0000-0000-0000000000a3';
  v_res uuid; v_rr uuid; v_cnt integer; v_arr date; attempt integer := 0; v_guests jsonb := null;
begin
  select count(*) into v_cnt from t32_res where label = p_label;
  select res, rr into v_res, v_rr from t32_res where label = p_label and n = p_client % v_cnt;
  select arrival_date into v_arr from reservations where id = v_res;
  if p_rand % 3 = 0 then v_guests := jsonb_build_array(jsonb_build_object('reservation_room_id', v_rr, 'adults', 1 + p_rand % 2, 'children', 0)); end if;
  loop
    attempt := attempt + 1;
    begin
      perform t_as('00000000-0000-0000-0000-00000000aa04');
      if p_what <= 7 then
        perform update_reservation_stay(v_res, v_arr, v_arr + 2 + p_rand % 7, v_guests, 'race', gen_random_uuid()::text);
      elsif p_what = 11 then
        perform transfer_room(v_rr, null, v_arr + 1, 'race', gen_random_uuid()::text);
      else
        perform create_reservation(prop, '00000000-0000-0000-0000-0000000000a5', 'staff_entry', v_arr + 1 + p_rand % 3, v_arr + 2 + p_rand % 3,
          jsonb_build_array(jsonb_build_object('room_type_id', typ, 'adults', 1)), gen_random_uuid()::text);
      end if;
      perform t_sys();
      insert into test_results (label, ok) values (p_label, true);
      return true;
    exception
      when deadlock_detected or serialization_failure then
        perform t_sys();
        if attempt >= 3 then insert into test_results (label, ok) values (p_label || '_gave_up', false); raise; end if;
      when sqlstate 'P0001' then
        perform t_sys();
        -- a clean refusal: no room free, a room change already planned, an unchanged answer, a stale move
        insert into test_results (label, ok) values (p_label, false);
        if sqlerrm not like 'ROOM_UNAVAILABLE%' and sqlerrm not like 'INVALID_STATE: split stay%'
           and sqlerrm not like 'POLICY_VIOLATION: effective date is outside the stay%' and sqlerrm not like 'INVALID_STATE: room%' then
          insert into test_results (label, ok) values (p_label || '_unexpected: ' || sqlerrm, false);
        end if;
        return false;
    end;
  end loop;
end $$;
