-- Channel manager: apply a modification from a channel (migration 177). Hotel A; reuses t171_pay from test 171. Date offsets around 800.
\set ON_ERROR_STOP on

do $$ declare
  v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_t constant uuid := '00000000-0000-0000-0000-0000000000a1';
  v_c uuid := gen_random_uuid(); r jsonb; v_b uuid; v_res uuid; v_b2 uuid; v_res2 uuid; v_rooms constant jsonb := '[{"external_room_id":"MODA","adults":1}]';
begin
  perform t_sys();
  insert into channel_connections (id, tenant_id, property_id, channel, label, collects, prefix, key_hash) values (v_c, v_t, v_p, 'other', 'Mod Channel', 'hotel', 'chn_177a', 'h177a');
  insert into channel_room_map values (v_c, 'MODA', '00000000-0000-0000-0000-0000000000a3');

  r := channel_receive(v_c, 'booking', 'MOD-1', t171_pay(800, 2, 'Mod Guest', 'mod@x.test', 1, v_rooms));
  if r ->> 'status' <> 'imported' then raise exception 'FAIL import %', r; end if;
  select id, reservation_id into v_b, v_res from channel_bookings where connection_id = v_c and external_id = 'MOD-1';

  -- a modify with new dates: kept as a proposal, booking untouched, waiting
  r := channel_receive(v_c, 'modify', 'MOD-1', jsonb_build_object('arrival', (current_date + 801)::text, 'departure', (current_date + 804)::text, 'total_minor', 777));
  if r ->> 'status' <> 'attention' then raise exception 'FAIL modify %', r; end if;
  if (select (proposed ->> 'arrival')::date from channel_bookings where id = v_b) <> current_date + 801 then raise exception 'FAIL proposal not kept'; end if;
  if (select arrival_date from reservations where id = v_res) <> current_date + 800 then raise exception 'FAIL booking changed by itself'; end if;

  -- who may apply
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select channel_modify_apply(%L, ''modkey-0001'')', v_b), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select channel_modify_apply(%L, ''modkey-0001'')', v_b), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select channel_modify_apply(%L, ''x'')', v_b), 'POLICY_VIOLATION: key');

  -- apply: the ordinary stay change, the channel's total kept, back to imported
  r := channel_modify_apply(v_b, 'modkey-0001');
  if (select arrival_date from reservations where id = v_res) <> current_date + 801 or (select departure_date from reservations where id = v_res) <> current_date + 804 then raise exception 'FAIL dates not applied'; end if;
  if (select status from channel_bookings where id = v_b) <> 'imported' or (select proposed from channel_bookings where id = v_b) is not null
     or (select channel_total_minor from channel_bookings where id = v_b) <> 777 or (select departure_date from channel_bookings where id = v_b) <> current_date + 804 then raise exception 'FAIL channel row after apply'; end if;
  if (select count(*) from audit_logs where entity_id = v_b and action = 'channel_booking.modification_applied') <> 1 then raise exception 'FAIL audit'; end if;
  perform t_expect(format('select channel_modify_apply(%L, ''modkey-0001'')', v_b), 'INVALID_STATE: imported');

  -- a modify with nothing usable waits for hand work and offers nothing to apply
  perform t_sys();
  r := channel_receive(v_c, 'modify', 'MOD-1', '{"guest_name":"X"}'::jsonb);
  if r ->> 'status' <> 'attention' or (select proposed from channel_bookings where id = v_b) is not null then raise exception 'FAIL unusable modify %', r; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select channel_modify_apply(%L, ''modkey-0002'')', v_b), 'INVALID_STATE: attention');

  -- the latest change replaces a waiting one
  perform t_sys();
  r := channel_receive(v_c, 'booking', 'MOD-2', t171_pay(810, 2, 'Second', 'mod2@x.test', 1, v_rooms));
  select id, reservation_id into v_b2, v_res2 from channel_bookings where connection_id = v_c and external_id = 'MOD-2';
  perform channel_receive(v_c, 'modify', 'MOD-2', jsonb_build_object('arrival', (current_date + 811)::text, 'departure', (current_date + 812)::text));
  perform channel_receive(v_c, 'modify', 'MOD-2', jsonb_build_object('arrival', (current_date + 812)::text, 'departure', (current_date + 815)::text));
  if (select (proposed ->> 'arrival')::date from channel_bookings where id = v_b2) <> current_date + 812 then raise exception 'FAIL latest change should win'; end if;

  -- a refused change leaves everything as it was: the booking was cancelled here meanwhile
  update reservations set reservation_status = 'cancelled' where id = v_res2;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select channel_modify_apply(%L, ''modkey-0003'')', v_b2), 'INVALID_STATE: cancelled');
  if (select status from channel_bookings where id = v_b2) <> 'attention' or (select proposed from channel_bookings where id = v_b2) is null then raise exception 'FAIL refused change altered the row'; end if;
  raise notice 'PASS channel modify: proposal kept not applied, channels.manage only, applied through the stay change, latest wins, refusals change nothing, audited';
end $$;
