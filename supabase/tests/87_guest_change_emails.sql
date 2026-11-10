-- Emails to the guest about a changed stay and an answered change request (migration 086). Rooms T87-1..5 of type a3, retired at the end.
-- Reuses t_as / t_sys / t_book / t_rr (05). The policy in force is edited with triggers off, like test 72.
\set ON_ERROR_STOP on

create function t87_policy(p_on boolean) returns void language plpgsql as $$
declare prop uuid := '00000000-0000-0000-0000-0000000000a2'; cfg jsonb; pid uuid;
begin
  set local session_replication_role = replica;
  select id, config into pid, cfg from property_policies where property_id = prop and effective_from <= property_today(prop) order by effective_from desc limit 1;
  cfg := cfg - 'guest_changes' - 'guest_change_hours';
  if p_on then cfg := cfg || jsonb_build_object('guest_changes', 'on'); end if;
  update property_policies set config = cfg where id = pid;
  set local session_replication_role = origin;
end $$;

create function t87_count(p_res uuid, p_kind text) returns integer language sql as $$
  select count(*)::integer from email_outbox where reservation_id = p_res and kind = p_kind $$;

do $$ declare
  prop uuid := '00000000-0000-0000-0000-0000000000a2'; t date; ty uuid := '00000000-0000-0000-0000-0000000000a3';
  owner text := '00000000-0000-0000-0000-00000000aa01';
  rooms_ uuid[]; r jsonb; q jsonb; res uuid; rr uuid; e record; req uuid; adults_now integer;
begin
  perform t_sys();
  t := property_today(prop);
  insert into rooms (tenant_id, property_id, room_type_id, room_number, floor)
    select tenant_id, id, ty, 'T87-' || g, 9 from properties, generate_series(1, 5) g where id = prop;
  select array_agg(id order by room_number) into rooms_ from rooms where property_id = prop and room_number like 'T87-%';
  update rooms set housekeeping_status = 'clean' where id = any (rooms_);
  perform t87_policy(true);

  -- A. a staff-made booking: a date change sends nothing
  perform t_as(owner);
  r := t_book(ty, t + 20, t + 23, 't87-a', rooms_[1]); res := (r ->> 'reservation_id')::uuid;
  perform update_reservation_stay(res, t + 21, t + 24, '[]'::jsonb, 'guest asked', 't87-a1');
  perform t_sys();
  if (select count(*) from email_outbox where reservation_id = res) <> 0 then raise exception 'FAIL a staff booking was emailed'; end if;

  -- B. a website booking with an email: a staff date change sends one stay_changed, a retry sends no second, a guests-only edit sends none
  perform t_as(owner);
  r := t_book(ty, t + 30, t + 33, 't87-b', rooms_[2]); res := (r ->> 'reservation_id')::uuid; rr := t_rr(r);
  perform t_sys();
  update reservations set source = 'website' where id = res;
  update guests set email = 'guest87@example.test' where id = (select primary_guest_id from reservations where id = res);
  perform t_as(owner);
  perform update_reservation_stay(res, t + 31, t + 34, '[]'::jsonb, 'internal reason only', 't87-b1');
  perform update_reservation_stay(res, t + 31, t + 34, '[]'::jsonb, 'internal reason only', 't87-b1');
  perform t_sys();
  if t87_count(res, 'stay_changed') <> 1 then raise exception 'FAIL staff date change emailed % times', t87_count(res, 'stay_changed'); end if;
  select * into e from email_outbox where reservation_id = res and kind = 'stay_changed';
  if e.to_email <> 'guest87@example.test' or e.payload ->> 'change' <> 'dates' or (e.payload ->> 'from_arrival')::date <> t + 30 or (e.payload ->> 'to_arrival')::date <> t + 31
     or (e.payload ->> 'to_departure')::date <> t + 34 or e.payload ->> 'by' <> 'staff' or e.payload::text like '%internal reason%' then raise exception 'FAIL stay email %', e.payload; end if;
  select adults into adults_now from reservation_rooms where id = rr;
  perform t_as(owner);
  perform update_reservation_stay(res, t + 31, t + 34, jsonb_build_array(jsonb_build_object('reservation_room_id', rr, 'adults', case when adults_now = 1 then 2 else 1 end, 'children', 0)), 'headcount', 't87-b2');
  perform t_sys();
  if t87_count(res, 'stay_changed') <> 1 then raise exception 'FAIL a guests-only edit was emailed'; end if;

  -- C. the guest changes the dates from their link: one email, by the guest
  q := guest_change_dates_quote(res, t + 31, t + 33);   -- shorter, so never dearer whatever the date's prices
  if not (q ->> 'allowed')::boolean then raise exception 'FAIL guest quote: %', q; end if;
  perform guest_change_dates(res, t + 31, t + 33, (q ->> 'new_total_minor')::bigint, 't87-c1');
  perform guest_change_dates(res, t + 31, t + 33, (q ->> 'new_total_minor')::bigint, 't87-c1');
  if t87_count(res, 'stay_changed') <> 2 then raise exception 'FAIL guest change email count %', t87_count(res, 'stay_changed'); end if;
  if not exists (select 1 from email_outbox where reservation_id = res and kind = 'stay_changed' and payload ->> 'by' = 'guest') then raise exception 'FAIL guest change email missing'; end if;

  -- D. a room type change audit row is turned into an email naming the type (the audit row is written here by hand: test 85 drives the function)
  perform write_audit((select tenant_id from reservations where id = res), prop, null, 'reservation.room_type_changed', 'reservation', res, null,
                      jsonb_build_object('to_room_type_id', ty, 'effective', t + 31, 'old_total_minor', 100, 'new_total_minor', 150, 'surplus_minor', 0));
  select * into e from email_outbox where reservation_id = res and kind = 'stay_changed' and payload ->> 'change' = 'room_type';
  if e.id is null or e.payload ->> 'room_type' <> (select name from room_types where id = ty) or (e.payload ->> 'to_total_minor')::bigint <> 150 then raise exception 'FAIL room type email %', e.payload; end if;

  -- E. no guest email: nothing is queued
  perform t_as(owner);
  r := t_book(ty, t + 40, t + 43, 't87-e', rooms_[3]); res := (r ->> 'reservation_id')::uuid;
  perform t_sys();
  update reservations set source = 'website' where id = res;
  update guests set email = null where id = (select primary_guest_id from reservations where id = res);
  perform t_as(owner);
  perform update_reservation_stay(res, t + 41, t + 44, '[]'::jsonb, 'no email', 't87-e1');
  perform t_sys();
  if (select count(*) from email_outbox where reservation_id = res) <> 0 then raise exception 'FAIL emailed a guest with no address'; end if;

  -- F. requests: done and declined by staff each send one email with the note; one closed by the guest's own date change sends none
  perform t_as(owner);
  r := t_book(ty, t + 50, t + 53, 't87-f', rooms_[4]); res := (r ->> 'reservation_id')::uuid;
  perform t_sys();
  update reservations set source = 'website' where id = res;
  update guests set email = 'guest87f@example.test' where id = (select primary_guest_id from reservations where id = res);
  r := guest_request_change(res, 'other', null, null, 'Quiet room please', 't87-f1');
  req := (select id from guest_change_requests where reservation_id = res and status = 'open');
  perform t_as(owner);
  perform resolve_change_request(req, 'done', 'Moved you to the back.');
  perform t_sys();
  select * into e from email_outbox where reservation_id = res and kind = 'change_request_answered';
  if e.id is null or e.payload ->> 'outcome' <> 'done' or e.payload ->> 'note' <> 'Moved you to the back.' or e.to_email <> 'guest87f@example.test' then raise exception 'FAIL done email %', e.payload; end if;
  r := guest_request_change(res, 'dates', t + 52, t + 55, null, 't87-f2');
  req := (select id from guest_change_requests where reservation_id = res and status = 'open');
  perform t_as(owner);
  perform resolve_change_request(req, 'declined', 'We are full that week.');
  perform t_sys();
  if t87_count(res, 'change_request_answered') <> 2 or not exists (select 1 from email_outbox where reservation_id = res and kind = 'change_request_answered' and payload ->> 'outcome' = 'declined' and payload ->> 'note' = 'We are full that week.') then raise exception 'FAIL declined email'; end if;
  r := guest_request_change(res, 'dates', t + 50, t + 52, null, 't87-f3');
  q := guest_change_dates_quote(res, t + 50, t + 52);   -- drops the last night: never dearer
  perform guest_change_dates(res, t + 50, t + 52, (q ->> 'new_total_minor')::bigint, 't87-f4');
  if (select status from guest_change_requests where reservation_id = res and kind = 'dates' and requested_arrival = t + 50) <> 'done' then raise exception 'FAIL request not closed'; end if;
  if t87_count(res, 'change_request_answered') <> 2 then raise exception 'FAIL a self-closed request was emailed as answered'; end if;

  perform t87_policy(false);
  update rooms set operational_status = 'retired' where id = any (rooms_);
  raise notice 'PASS guest change emails: stay changes by staff and by the guest, a room type change, requests answered; none for staff bookings, guests-only edits, no address or a request the guest closed themselves';
end $$;

drop function t87_count(uuid, text);
drop function t87_policy(boolean);
