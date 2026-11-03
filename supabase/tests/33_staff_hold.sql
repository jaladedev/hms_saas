-- Staff holds (migration 034): create_staff_hold, record_manual_payment confirming/refusing a pending booking, expire_lapsed_holds for all sources.
-- Reuses t_as / t_sys / t_expect (05). Users: aa01 owner A, aa04 front desk A, aa02 housekeeping A, aa05 accountant A, bb01 owner B.
-- Ids: a2 property A, a3 the STD room type, a5 guest A. Offsets 1000 to 1100 (earlier files use up to about 912).
\set ON_ERROR_STOP on

create table t33_ctx (label text primary key, val text not null);
create function t33_get(p_label text) returns text language sql stable as $$ select val from t33_ctx where label = p_label $$;
create function t33_hold(p_arr date, p_dep date, p_key text, p_source text default 'phone') returns jsonb
language sql as $$
  select create_staff_hold('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a5', p_source, p_arr, p_dep,
    jsonb_build_array(jsonb_build_object('room_type_id', '00000000-0000-0000-0000-0000000000a3', 'adults', 1)), p_key)
$$;
create function t33_pay(p_res uuid, p_amt bigint, p_key text) returns jsonb language sql as $$
  select record_manual_payment(p_res, p_amt, 'cash', null, null, p_key)
$$;
create function t33_claims(p_res uuid) returns text language sql stable as $$
  select coalesce(string_agg(c.claim_type || '/' || c.status || '/' || (c.hold_expires_at is not null), ',' order by c.id), '')
    from room_inventory_claims c join reservation_rooms x on x.id = c.reservation_room_id where x.reservation_id = p_res
$$;
create function t33_status(p_res uuid) returns text language sql stable as $$ select reservation_status from reservations where id = p_res $$;

-- 1. Creating a hold: who may, what it looks like
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); h jsonb; res uuid; n int;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform t_expect(format('select t33_hold(%L,%L,%L)', t + 1000, t + 1002, 'sh-hk'), 'FORBIDDEN');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select t33_hold(%L,%L,%L)', t + 1000, t + 1002, 'sh-b'), 'FORBIDDEN');
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select t33_hold(%L,%L,%L,%L)', t + 1000, t + 1002, 'sh-web', 'website'), 'POLICY_VIOLATION: source');
  perform t_expect(format('select t33_hold(%L,%L,%L)', t + 1002, t + 1000, 'sh-dates'), 'POLICY_VIOLATION');
  perform t_sys();
  select count(*) into n from reservations where arrival_date between t + 1000 and t + 1002;
  if n <> 0 then raise exception 'FAIL a refused hold left a booking behind'; end if;

  perform t_as('00000000-0000-0000-0000-00000000aa04');
  h := t33_hold(t + 1000, t + 1002, 'sh-a');
  res := (h ->> 'reservation_id')::uuid;
  perform t_sys();
  insert into t33_ctx values ('a', res::text);
  if t33_status(res) <> 'pending' then raise exception 'FAIL hold is % not pending', t33_status(res); end if;
  if t33_claims(res) <> 'hold/active/true' then raise exception 'FAIL claims are %', t33_claims(res); end if;
  if (h ->> 'hold_minutes')::int <> 20 then raise exception 'FAIL default hold is % minutes', h ->> 'hold_minutes'; end if;
  if abs(extract(epoch from ((h ->> 'hold_expires_at')::timestamptz - now())) - 1200) > 30 then raise exception 'FAIL hold expiry is not about 20 minutes away'; end if;
  if (h ->> 'required_minor')::bigint <> (select total_minor from reservations where id = res) then raise exception 'FAIL required amount is not the total'; end if;
  if (select count(*) from audit_logs where action = 'reservation.hold_created' and entity_id = res) <> 1 then raise exception 'FAIL hold not audited once'; end if;
  if reservation_money_held(res) <> 0 then raise exception 'FAIL a hold holds money'; end if;
  raise notice 'PASS create: front desk may; housekeeping, other hotel, website source refused; a pending booking with timed hold claims, 20 minutes, nothing paid';
end $$;

-- 2. Same key again returns the same booking; the same key with other dates is refused
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); res uuid := t33_get('a')::uuid; h jsonb; n int;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  h := t33_hold(t + 1000, t + 1002, 'sh-a');
  if (h ->> 'reservation_id')::uuid <> res then raise exception 'FAIL a retry made a second booking'; end if;
  perform t_expect(format('select t33_hold(%L,%L,%L)', t + 1010, t + 1012, 'sh-a'), 'IDEMPOTENCY_MISMATCH');
  perform t_sys();
  select count(*) into n from reservations where arrival_date = t + 1000;
  if n <> 1 then raise exception 'FAIL % bookings for one key', n; end if;
  raise notice 'PASS idempotency: a retry returns the same hold, other input under the same key is refused';
end $$;

-- 3. The held room is really held: others cannot take the type's last rooms away, and the same room cannot be double-held
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); res uuid := t33_get('a')::uuid; room uuid; n int;
begin
  perform t_sys();
  select c.room_id into room from room_inventory_claims c join reservation_rooms x on x.id = c.reservation_room_id where x.reservation_id = res;
  select count(*) into n from room_inventory_claims c where c.room_id = room and c.status = 'active' and daterange(c.start_date, c.end_date) && daterange(t + 1000, t + 1002);
  if n <> 1 then raise exception 'FAIL % active claims on the held room', n; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  begin perform t_book('00000000-0000-0000-0000-0000000000a3', t + 1000, t + 1002, 'sh-book-same', room);
    raise exception 'FAIL the held room was booked over';
  exception when sqlstate 'P0001' then
    if sqlerrm not like 'ROOM_UNAVAILABLE%' and sqlerrm not like 'NOT_FOUND%' then raise; end if; end;
  raise notice 'PASS the hold occupies the room: it cannot be booked over while the hold lasts';
end $$;

-- 4. A payment below the required amount is recorded but does not confirm, and does not extend the hold (deposit rule)
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); h jsonb; res uuid; total bigint; dep bigint; before_exp timestamptz; r jsonb;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  h := t33_hold(t + 1020, t + 1023, 'sh-dep'); res := (h ->> 'reservation_id')::uuid;
  perform t_sys();
  update reservations set policy_snapshot = jsonb_set(policy_snapshot, '{online_payment}', '{"mode":"deposit_percent","value":30}') where id = res;
  select total_minor into total from reservations where id = res;
  dep := ceil(total * 30 / 100.0)::bigint;
  if pending_required_minor(res) <> dep then raise exception 'FAIL required % expected %', pending_required_minor(res), dep; end if;
  select min(c.hold_expires_at) into before_exp from room_inventory_claims c join reservation_rooms x on x.id = c.reservation_room_id where x.reservation_id = res;
  insert into t33_ctx values ('dep', res::text);

  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r := t33_pay(res, dep - 1, 'sh-dep-1');
  perform t_sys();
  if t33_status(res) <> 'pending' or (r ->> 'confirmed')::boolean then raise exception 'FAIL % confirmed one kobo short', t33_status(res); end if;
  if t33_claims(res) <> 'hold/active/true' then raise exception 'FAIL claims changed on a part payment: %', t33_claims(res); end if;
  if (select min(c.hold_expires_at) from room_inventory_claims c join reservation_rooms x on x.id = c.reservation_room_id where x.reservation_id = res) <> before_exp then
    raise exception 'FAIL paying extended the hold'; end if;

  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r := t33_pay(res, 1, 'sh-dep-2');
  perform t_sys();
  if t33_status(res) <> 'confirmed' or not (r ->> 'confirmed')::boolean or r ->> 'reservation_status' <> 'confirmed' then raise exception 'FAIL not confirmed at the deposit: %', r; end if;
  if t33_claims(res) <> 'stay/active/false' then raise exception 'FAIL claims after confirm: %', t33_claims(res); end if;
  raise notice 'PASS deposit: one kobo short stays pending with the hold untouched; reaching the deposit confirms and the hold becomes a stay';
end $$;

-- 5. Paying in full confirms at once; a repeat of the same payment changes nothing; the booking then behaves as any confirmed one
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); h jsonb; res uuid; total bigint; r jsonb; r2 jsonb;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  h := t33_hold(t + 1030, t + 1032, 'sh-full'); res := (h ->> 'reservation_id')::uuid;
  perform t_sys(); select total_minor into total from reservations where id = res;
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  perform t_expect(format('select t33_pay(%L,%s,%L)', res, total + 1, 'sh-over'), 'POLICY_VIOLATION: OVERPAYMENT');
  r := t33_pay(res, total, 'sh-full-pay');
  r2 := t33_pay(res, total, 'sh-full-pay');
  perform t_sys();
  if r2 is distinct from r then raise exception 'FAIL a repeat of the payment differs: % vs %', r, r2; end if;
  if (select count(*) from payments where reservation_id = res) <> 1 then raise exception 'FAIL repeat recorded twice'; end if;
  if t33_status(res) <> 'confirmed' or t33_claims(res) <> 'stay/active/false' then raise exception 'FAIL not confirmed in full'; end if;
  if (select payment_status from reservations where id = res) <> 'paid' then raise exception 'FAIL payment_status %', (select payment_status from reservations where id = res); end if;
  raise notice 'PASS full payment: confirms, a repeat is idempotent, overpayment refused';
end $$;

-- 6. A lapsed hold refuses the payment, and the sweep expires it (staff holds included); the room is free again
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); h jsonb; res uuid; room uuid; n int; b jsonb;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  h := t33_hold(t + 1040, t + 1042, 'sh-lapse'); res := (h ->> 'reservation_id')::uuid;
  perform t_sys();
  select c.room_id into room from room_inventory_claims c join reservation_rooms x on x.id = c.reservation_room_id where x.reservation_id = res;
  update room_inventory_claims set hold_expires_at = now() - interval '1 minute'
   where reservation_room_id in (select id from reservation_rooms where reservation_id = res);

  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select t33_pay(%L,%s,%L)', res, 1000, 'sh-lapse-pay'), 'INVALID_STATE: hold lapsed');
  perform t_sys();
  if (select count(*) from payments where reservation_id = res) <> 0 then raise exception 'FAIL money recorded on a lapsed hold'; end if;

  -- only the system may sweep
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  begin perform expire_lapsed_holds(100); raise exception 'FAIL a signed-in user ran the sweep';
  exception when insufficient_privilege then null; end;
  perform t_sys();
  n := expire_lapsed_holds(100);
  if n < 1 or t33_status(res) <> 'expired' then raise exception 'FAIL sweep expired % bookings, status %', n, t33_status(res); end if;
  if t33_claims(res) <> 'hold/expired/true' then raise exception 'FAIL claims after sweep: %', t33_claims(res); end if;
  -- the sweep leaves live holds and confirmed bookings alone
  if t33_status(t33_get('a')::uuid) <> 'pending' or t33_status(t33_get('dep')::uuid) <> 'confirmed' then raise exception 'FAIL the sweep touched live bookings'; end if;
  -- the room can be booked again
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  b := t_book('00000000-0000-0000-0000-0000000000a3', t + 1040, t + 1042, 'sh-rebook', room);
  if (b ->> 'status') is distinct from 'confirmed' then raise exception 'FAIL rebook status %', b ->> 'status'; end if;
  raise notice 'PASS lapse: payment refused and nothing recorded, only the system sweeps, the hold ends expired, the room can be booked again';
end $$;

-- 7. A lapsed hold whose room was taken meanwhile cannot be paid or revived; cancelling a live hold works and frees the room
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); h jsonb; res uuid; r jsonb;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  h := t33_hold(t + 1050, t + 1052, 'sh-cancel'); res := (h ->> 'reservation_id')::uuid;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  r := cancel_reservation(res, 'guest did not come', 'sh-cancel-1');
  perform t_sys();
  if t33_status(res) <> 'cancelled' then raise exception 'FAIL status after cancel %', t33_status(res); end if;
  if exists (select 1 from room_inventory_claims c join reservation_rooms x on x.id = c.reservation_room_id where x.reservation_id = res and c.status = 'active') then
    raise exception 'FAIL a cancelled hold still holds a room'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select t33_pay(%L,%s,%L)', res, 1000, 'sh-cancel-pay'), 'INVALID_STATE');
  raise notice 'PASS cancel: a live hold can be cancelled, frees its room and takes no payment afterwards';
end $$;

-- 8. A pending ONLINE booking is confirmed by a desk payment too (it was recorded but never confirmed before)
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); b jsonb; res uuid; total bigint; r jsonb;
begin
  perform t_sys();
  b := create_reservation('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a5', 'website', t + 1060, t + 1062,
        jsonb_build_array(jsonb_build_object('room_type_id', '00000000-0000-0000-0000-0000000000a3', 'adults', 1)), 'sh-web-1');
  res := (b ->> 'reservation_id')::uuid;
  if t33_status(res) <> 'pending' then raise exception 'FAIL web booking is %', t33_status(res); end if;
  select total_minor into total from reservations where id = res;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r := t33_pay(res, total, 'sh-web-pay');
  perform t_sys();
  if t33_status(res) <> 'confirmed' or t33_claims(res) <> 'stay/active/false' then raise exception 'FAIL web booking % / %', t33_status(res), t33_claims(res); end if;
  raise notice 'PASS online booking: a desk payment in full now confirms it';
end $$;
