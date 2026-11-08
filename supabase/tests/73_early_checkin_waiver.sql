-- Early check-in waiver (migration 073). Reuses t_as / t_sys / t_expect / t_book / t_rr (05) and t59_disc (59).
-- Rooms of our own (T73-1..3). The policy in force is edited with triggers off and put back at the end, like test 62.
\set ON_ERROR_STOP on

create function t73_days(d integer) returns void language plpgsql as $$
declare prop uuid := '00000000-0000-0000-0000-0000000000a2'; cfg jsonb; pid uuid;
begin
  set local session_replication_role = replica;
  select id, config into pid, cfg from property_policies where property_id = prop and effective_from <= property_today(prop) order by effective_from desc limit 1;
  cfg := cfg - 'early_checkin_days';
  if d > 0 then cfg := cfg || jsonb_build_object('early_checkin_days', d); end if;
  update property_policies set config = cfg where id = pid;
  set local session_replication_role = origin;
end $$;

do $$ declare
  prop uuid := '00000000-0000-0000-0000-0000000000a2'; t date;
  owner text := '00000000-0000-0000-0000-00000000aa01'; desk text := '00000000-0000-0000-0000-00000000aa04';
  rooms_ uuid[]; b jsonb; res uuid; rr uuid; r jsonb; old_total bigint; added bigint; inv uuid; n integer;
begin
  perform t_sys();
  t := property_today(prop);
  insert into rooms (tenant_id, property_id, room_type_id, room_number, floor)
    select tenant_id, id, '00000000-0000-0000-0000-0000000000a3', 'T73-' || g, 9 from properties, generate_series(1, 3) g where id = prop;
  select array_agg(id order by room_number) into rooms_ from rooms where property_id = prop and room_number like 'T73-%';
  update rooms set housekeeping_status = 'clean' where id = any (rooms_);
  perform t73_days(3);

  -- A. a role whose limit is below the added share is refused, and nothing changes
  perform t_as(desk);
  b := t_book('00000000-0000-0000-0000-0000000000a3', t + 2, t + 4, 't73-a', rooms_[1]); res := (b ->> 'reservation_id')::uuid; rr := t_rr(b);
  perform t_sys(); select total_minor into old_total from reservations where id = res;
  perform t_as(desk);
  perform t_expect(format('select early_check_in(%L, %L, true)', rr, 'goodwill'), 'POLICY_VIOLATION: discount limit');
  perform t_sys();
  if (select reservation_status from reservations where id = res) <> 'confirmed' or (select total_minor from reservations where id = res) <> old_total
     or (select count(*) from reservation_nights where reservation_room_id = rr) <> 2 then raise exception 'FAIL a refused waiver changed the booking'; end if;

  -- B. the owner waives: the nights are added, the total is unchanged, the discount carries the difference, audit says so
  perform t_as(owner);
  r := early_check_in(rr, 'guest landed early, hotel is waiving', true);
  perform t_sys();
  select total_minor into added from reservations where id = res;
  if r ->> 'status' <> 'checked_in' or (r ->> 'waived_minor')::bigint <= 0 or (r ->> 'added_minor')::bigint <> 0 then raise exception 'FAIL waiver result: %', r; end if;
  if (select total_minor from reservations where id = res) <> old_total
     or (select discount_minor from reservations where id = res) <> (r ->> 'waived_minor')::bigint
     or (select discount_amount_minor from reservations where id = res) <> (r ->> 'waived_minor')::bigint
     or (select discount_percent from reservations where id = res) is not null
     or (select discount_reason from reservations where id = res) <> 'Early check-in waiver: guest landed early, hotel is waiving'
     or (select count(*) from reservation_nights where reservation_room_id = rr) <> 4 then raise exception 'FAIL waiver state'; end if;
  if (select (metadata ->> 'waived_minor')::bigint from audit_logs where entity_id = res and action = 'reservation.early_checked_in') <> (r ->> 'waived_minor')::bigint then raise exception 'FAIL waiver audit'; end if;

  -- C. a booking that already has a discount cannot take the waiver on top
  perform t_as(owner);
  b := t_book('00000000-0000-0000-0000-0000000000a3', t + 2, t + 4, 't73-c', rooms_[2]); res := (b ->> 'reservation_id')::uuid; rr := t_rr(b);
  perform t59_disc(res, 5, 'promo', 't73-c-d');
  perform t_expect(format('select early_check_in(%L, %L, true)', rr, 'x'), 'POLICY_VIOLATION: discount');
  -- ... but it can still be checked in early without the waiver (061, unchanged)
  r := early_check_in(rr, 'early, no waiver');
  if (r ->> 'status') <> 'checked_in' or (r ->> 'waived_minor') is not null and (r ->> 'waived_minor')::bigint <> 0 then raise exception 'FAIL plain early check-in: %', r; end if;

  -- D. a live invoice is replaced by one that carries the waiver
  b := t_book('00000000-0000-0000-0000-0000000000a3', t + 2, t + 4, 't73-d', rooms_[3]); res := (b ->> 'reservation_id')::uuid; rr := t_rr(b);
  perform issue_invoice(res, 't73-d-i');
  perform t_sys(); select total_minor into old_total from reservations where id = res; perform t_as(owner);
  r := early_check_in(rr, 'waived with an invoice', true);
  perform t_sys();
  select count(*) into n from invoices where reservation_id = res and invoice_status <> 'void';
  select id into inv from invoices where reservation_id = res and invoice_status <> 'void';
  if n <> 1 or (select discount_minor from invoices where id = inv) <> (r ->> 'waived_minor')::bigint or (select total_minor from invoices where id = inv) <> old_total then raise exception 'FAIL waiver invoice'; end if;

  perform t73_days(0);
  update rooms set operational_status = 'retired' where id = any (rooms_);
  raise notice 'PASS early check-in waiver: refused above the role limit or on top of a discount, the owner can waive, the total stays, the discount and audit carry it, the invoice is replaced with it';
end $$;

drop function t73_days(integer);
