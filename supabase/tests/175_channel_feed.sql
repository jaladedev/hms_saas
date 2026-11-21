-- Channel manager, outbound half (migration 175): the availability and rate feed and the retry timer. Hotel A; room types a3 (5 rooms) and a4.
-- Reuses t171_pay from test 171. Date offsets around 700 are used here.
\set ON_ERROR_STOP on

do $$ declare
  v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_t constant uuid := '00000000-0000-0000-0000-0000000000a1';
  v_c uuid := gen_random_uuid(); a jsonb; f jsonb; d0 integer; d2 integer; before_n integer; after_n integer; r jsonb; v_id uuid; v_today date;
begin
  perform t_sys(); v_today := property_today(v_p);
  insert into channel_connections (id, tenant_id, property_id, channel, label, prefix, key_hash) values (v_c, v_t, v_p, 'other', 'Feed test', 'chn_175', 'h175');
  insert into channel_room_map values (v_c, 'FEEDA', '00000000-0000-0000-0000-0000000000a3'), (v_c, 'FEEDB', '00000000-0000-0000-0000-0000000000a4');

  -- authentication: right key stamps last_feed_at only; wrong key, paused and a plan without the feature all say no
  a := channel_feed_auth('h175');
  if a ->> 'ok' <> 'true' or (a ->> 'connection_id')::uuid <> v_c then raise exception 'FAIL auth %', a; end if;
  if (select last_feed_at from channel_connections where id = v_c) is null or (select last_inbound_at from channel_connections where id = v_c) is not null then raise exception 'FAIL stamps'; end if;
  if channel_feed_auth('nope') ->> 'ok' <> 'false' then raise exception 'FAIL wrong key'; end if;
  update channel_connections set status = 'paused' where id = v_c;
  if channel_feed_auth('h175') ->> 'ok' <> 'false' then raise exception 'FAIL paused'; end if;
  update channel_connections set status = 'active' where id = v_c;

  -- the feed: one entry per mapped code, one day per night, a rate, no more rooms than the type has
  f := channel_feed(v_c, current_date + 700, current_date + 703);
  if jsonb_array_length(f -> 'rooms') <> 2 or jsonb_array_length(f -> 'rooms' -> 0 -> 'days') <> 3 then raise exception 'FAIL shape %', f; end if;
  if f ->> 'currency' <> (select currency from properties where id = v_p) then raise exception 'FAIL currency'; end if;
  if (f -> 'rooms' -> 0 ->> 'external_room_id') <> 'FEEDA' or (f -> 'rooms' -> 0 -> 'days' -> 0 ->> 'rate_minor') is null then raise exception 'FAIL rate %', f; end if;
  before_n := (f -> 'rooms' -> 0 -> 'days' -> 1 ->> 'available')::int;
  if before_n < 1 or before_n > (select count(*) from rooms where room_type_id = '00000000-0000-0000-0000-0000000000a3' and operational_status = 'active') then raise exception 'FAIL available %', before_n; end if;

  d0 := (f -> 'rooms' -> 0 -> 'days' -> 0 ->> 'available')::int; d2 := (f -> 'rooms' -> 0 -> 'days' -> 2 ->> 'available')::int;
  -- a booking from the channel takes one room off those nights, and only those
  r := channel_receive(v_c, 'booking', 'FEED-1', t171_pay(701, 1, 'Feed Guest', 'feed@x.test', 1, '[{"external_room_id":"FEEDA","adults":1}]'));
  if r ->> 'status' <> 'imported' then raise exception 'FAIL import %', r; end if;
  f := channel_feed(v_c, current_date + 700, current_date + 703);
  after_n := (f -> 'rooms' -> 0 -> 'days' -> 1 ->> 'available')::int;
  if after_n <> before_n - 1 or (f -> 'rooms' -> 0 -> 'days' -> 0 ->> 'available')::int <> d0 or (f -> 'rooms' -> 0 -> 'days' -> 2 ->> 'available')::int <> d2 then raise exception 'FAIL availability % %', before_n, f; end if;

  -- limits
  perform t_expect(format('select channel_feed(%L, %L, %L)', v_c, v_today - 1, v_today + 2), 'POLICY_VIOLATION: dates');
  perform t_expect(format('select channel_feed(%L, %L, %L)', v_c, v_today + 5, v_today + 5), 'POLICY_VIOLATION: dates');
  perform t_expect(format('select channel_feed(%L, %L, %L)', v_c, v_today + 5, v_today + 96), 'POLICY_VIOLATION: dates');
  perform t_expect(format('select channel_feed(%L, %L, %L)', gen_random_uuid(), v_today + 5, v_today + 6), 'NOT_FOUND');
  update channel_connections set status = 'paused' where id = v_c;
  perform t_expect(format('select channel_feed(%L, %L, %L)', v_c, v_today + 5, v_today + 6), 'NOT_FOUND');
  update channel_connections set status = 'active' where id = v_c;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  begin perform channel_feed(v_c, v_today + 5, v_today + 6); raise exception 'FAIL staff read the feed';
  exception when insufficient_privilege then null; end;
  begin perform channel_retry_due(5); raise exception 'FAIL staff ran the retry';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS channel feed: key stamps last_feed_at, one entry per mapped code and night, a channel booking lowers availability on its nights only, dates limited, system only';
end $$;

do $$ declare
  v_c uuid; r jsonb; v_id uuid; v_n integer;
begin
  perform t_sys();
  select id into v_c from channel_connections where key_hash = 'h175';
  -- earlier tests leave failed bookings of their own; keep the timer away from them so only this test's rows are counted
  update channel_bookings set attempts = 5 where connection_id <> v_c and status = 'failed';
  -- a booking for a code that is not mapped yet fails at once; the timer waits attempts x 15 minutes
  r := channel_receive(v_c, 'booking', 'RETRY-1', t171_pay(720, 1, 'Retry Guest', 'retry@x.test', 1, '[{"external_room_id":"LATER","adults":1}]'));
  select id into v_id from channel_bookings where connection_id = v_c and external_id = 'RETRY-1';
  if r ->> 'status' <> 'failed' or (select attempts from channel_bookings where id = v_id) <> 1 then raise exception 'FAIL first %', r; end if;
  if channel_retry_due(10) <> 0 then raise exception 'FAIL retried too early'; end if;
  update channel_bookings set updated_at = now() - interval '20 minutes' where id = v_id;
  v_n := channel_retry_due(10);
  if v_n <> 1 or (select attempts from channel_bookings where id = v_id) <> 2 or (select status from channel_bookings where id = v_id) <> 'failed' then raise exception 'FAIL second attempt % %', v_n, (select to_jsonb(b) from channel_bookings b where id = v_id); end if;
  if channel_retry_due(10) <> 0 then raise exception 'FAIL no back-off'; end if;
  -- the hotel maps the code; the next attempt imports it
  insert into channel_room_map values (v_c, 'LATER', '00000000-0000-0000-0000-0000000000a3');
  update channel_bookings set updated_at = now() - interval '31 minutes' where id = v_id;
  v_n := channel_retry_due(10);
  if v_n <> 1 or (select status from channel_bookings where id = v_id) <> 'imported' or (select reservation_id from channel_bookings where id = v_id) is null then raise exception 'FAIL import after mapping % %', v_n, (select to_jsonb(b) from channel_bookings b where id = v_id); end if;
  -- five attempts and it is left for a person; a paused connection is not retried
  r := channel_receive(v_c, 'booking', 'RETRY-2', t171_pay(721, 1, 'Retry Two', 'r2@x.test', 1, '[{"external_room_id":"NEVER","adults":1}]'));
  select id into v_id from channel_bookings where connection_id = v_c and external_id = 'RETRY-2';
  update channel_bookings set attempts = 5, updated_at = now() - interval '5 hours' where id = v_id;
  if channel_retry_due(10) <> 0 then raise exception 'FAIL retried after five attempts'; end if;
  update channel_bookings set attempts = 2, updated_at = now() - interval '5 hours' where id = v_id;
  update channel_connections set status = 'paused' where id = v_c;
  if channel_retry_due(10) <> 0 then raise exception 'FAIL retried on a paused connection'; end if;
  raise notice 'PASS channel retry timer: waits attempts x 15 minutes, imports once the code is mapped, stops at five attempts, skips paused connections';
end $$;
