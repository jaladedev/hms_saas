-- Channel manager: record the money a channel collected (migration 176). Hotel A; reuses t171_pay from test 171. Date offsets around 740.
\set ON_ERROR_STOP on

do $$ declare
  v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_t constant uuid := '00000000-0000-0000-0000-0000000000a1';
  v_c uuid := gen_random_uuid(); v_h uuid := gen_random_uuid(); r jsonb; v_b uuid; v_res uuid; v_owed bigint; rep jsonb;
begin
  perform t_sys();
  insert into channel_connections (id, tenant_id, property_id, channel, label, collects, prefix, key_hash) values
    (v_c, v_t, v_p, 'other', 'Pay Channel', 'channel', 'chn_176a', 'h176a'), (v_h, v_t, v_p, 'other', 'Hotel Collects', 'hotel', 'chn_176b', 'h176b');
  insert into channel_room_map values (v_c, 'PAYA', '00000000-0000-0000-0000-0000000000a3'), (v_h, 'PAYA', '00000000-0000-0000-0000-0000000000a3');

  r := channel_receive(v_c, 'booking', 'PAY-1', t171_pay(740, 2, 'Pay Guest', 'pay@x.test', 1, '[{"external_room_id":"PAYA","adults":1}]'));
  if r ->> 'status' <> 'imported' then raise exception 'FAIL import %', r; end if;
  select id, reservation_id into v_b, v_res from channel_bookings where connection_id = v_c and external_id = 'PAY-1';
  v_owed := (select total_minor from reservations where id = v_res);
  if v_owed <= 0 then raise exception 'FAIL no total'; end if;

  perform t_as('00000000-0000-0000-0000-00000000aa01');
  rep := channel_sync_report(v_p);
  if not exists (select 1 from jsonb_array_elements(rep -> 'awaiting_payment') x where (x ->> 'id')::uuid = v_b and (x ->> 'owed_minor')::bigint = v_owed) then raise exception 'FAIL not listed %', rep; end if;

  -- who may: front desk (payment.record but no channels.manage) and another hotel's owner may not
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select channel_record_payment(%L)', v_b), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select channel_record_payment(%L)', v_b), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select channel_record_payment(%L)', gen_random_uuid()), 'NOT_FOUND');

  -- records what the hotel's own price still owes, as an ordinary payment
  r := channel_record_payment(v_b);
  if (r ->> 'amount_minor')::bigint <> v_owed then raise exception 'FAIL amount %', r; end if;
  perform t_sys();
  if (select count(*) from payments where reservation_id = v_res and payment_method = 'other' and provider_reference = 'Channel booking PAY-1' and amount_minor = v_owed) <> 1 then raise exception 'FAIL payment row'; end if;
  if (select payment_status from reservations where id = v_res) <> 'paid' then raise exception 'FAIL status %', (select payment_status from reservations where id = v_res); end if;
  if (select count(*) from audit_logs where entity_id = v_b and action = 'channel_booking.payment_recorded') <> 1 then raise exception 'FAIL audit'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select channel_record_payment(%L)', v_b), 'INVALID_STATE: nothing owed');
  if exists (select 1 from jsonb_array_elements(channel_sync_report(v_p) -> 'awaiting_payment') x where (x ->> 'id')::uuid = v_b) then raise exception 'FAIL still listed'; end if;

  -- a channel where the hotel collects, a failed import and a cancelled booking are all refused
  perform t_sys();
  r := channel_receive(v_h, 'booking', 'PAY-2', t171_pay(750, 1, 'Hotel Pays', 'hp@x.test', 1, '[{"external_room_id":"PAYA","adults":1}]'));
  select id into v_b from channel_bookings where connection_id = v_h and external_id = 'PAY-2';
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select channel_record_payment(%L)', v_b), 'INVALID_STATE: not collected by the channel');
  perform t_sys();
  r := channel_receive(v_c, 'booking', 'PAY-3', t171_pay(760, 1, 'No Room', 'nr@x.test', 1, '[{"external_room_id":"NOPE","adults":1}]'));
  select id into v_b from channel_bookings where connection_id = v_c and external_id = 'PAY-3';
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select channel_record_payment(%L)', v_b), 'INVALID_STATE: not collected by the channel');
  perform t_sys();
  r := channel_receive(v_c, 'booking', 'PAY-4', t171_pay(770, 1, 'Will Cancel', 'wc@x.test', 1, '[{"external_room_id":"PAYA","adults":1}]'));
  perform channel_receive(v_c, 'cancel', 'PAY-4', '{}'::jsonb);
  select id into v_b from channel_bookings where connection_id = v_c and external_id = 'PAY-4';
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select channel_record_payment(%L)', v_b), 'INVALID_STATE');
  raise notice 'PASS channel payment: only owner or manager with payment.record, hotel price owed recorded as an ordinary payment once, hotel-collected, failed and cancelled bookings refused';
end $$;
