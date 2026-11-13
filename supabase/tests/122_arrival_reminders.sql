-- Arrival reminders (migration 122). Hotel A: tenant a1, property a2; owner aa01, front desk aa04; another hotel's owner bb01. Host book.hotel-a.test.
\set ON_ERROR_STOP on

create function t122_booking(p_email text, p_key text, p_arrive_in integer, p_status text default 'confirmed', p_age interval default '3 days') returns uuid
language plpgsql as $$
declare v_res uuid; v_t date := property_today('00000000-0000-0000-0000-0000000000a2'); v_arr date := current_date + 30 + (random() * 300)::int;
begin
  -- held far ahead (where rooms are free), then moved into the window and confirmed, with triggers off like tests 62 and 74
  v_res := (create_hold('book.hotel-a.test', v_arr, v_arr + 2,
                        '[{"room_type_id":"00000000-0000-0000-0000-0000000000a3","adults":1}]'::jsonb,
                        jsonb_build_object('full_name', 'Reminder Guest', 'email', p_email), p_key) ->> 'reservation_id')::uuid;
  set local session_replication_role = replica;
  delete from room_inventory_claims where reservation_room_id in (select id from reservation_rooms where reservation_id = v_res);   -- these test bookings only need dates, not rooms held
  update reservations set arrival_date = v_t + p_arrive_in, departure_date = v_t + p_arrive_in + 2, reservation_status = p_status, created_at = now() - p_age where id = v_res;
  set local session_replication_role = origin;
  return v_res;
end $$;

-- 1. only property.configure sets it; 1 to 7 or off; audited
do $$ declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_state text; begin
  perform t_sys();
  if (select arrival_reminder_days from properties where id = v_p) is not null then raise exception 'FAIL reminders should start off'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select set_arrival_reminder_days(%L, 2)', v_p), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select set_arrival_reminder_days(%L, 2)', v_p), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select set_arrival_reminder_days(%L, 8)', v_p), 'INVALID_DAYS');
  perform t_expect(format('select set_arrival_reminder_days(%L, -1)', v_p), 'INVALID_DAYS');
  perform set_arrival_reminder_days(v_p, 3);
  perform t_sys();
  if (select arrival_reminder_days from properties where id = v_p) <> 3 then raise exception 'FAIL not saved'; end if;
  if not exists (select 1 from audit_logs where entity_id = v_p and action = 'property.updated' and metadata -> 'changed' ? 'arrival_reminder_days') then raise exception 'FAIL not audited'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform set_arrival_reminder_days(v_p, 0);
  perform t_sys();
  if (select arrival_reminder_days from properties where id = v_p) is not null then raise exception 'FAIL 0 did not turn it off'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform set_arrival_reminder_days(v_p, 3);
  perform set_arrival_reminder_days(v_p, null);
  perform t_sys();
  if (select arrival_reminder_days from properties where id = v_p) is not null then raise exception 'FAIL null did not turn it off'; end if;
  begin
    set local role anon;
    perform set_arrival_reminder_days(v_p, 2);
    v_state := 'allowed';
  exception when insufficient_privilege then v_state := 'refused';
  end;
  reset role;
  if v_state <> 'refused' then raise exception 'FAIL anon could call set_arrival_reminder_days'; end if;
  raise notice 'PASS arrival reminders: set by property.configure only, 1 to 7 or off, audited, anon refused';
end $$;

-- 2. off means nothing queued; on queues exactly the confirmed bookings arriving tomorrow up to N days ahead
do $$ declare
  v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; a uuid; b uuid; c uuid; d uuid; e uuid; f uuid; g uuid; n integer;
begin
  perform t_sys();
  a := t122_booking('r-a@example.test', 't119-a', 2);                         -- in the window
  b := t122_booking('r-b@example.test', 't119-b', 5);                         -- beyond 3 days
  c := t122_booking('r-c@example.test', 't119-c', 1, 'confirmed', '1 hour');  -- made an hour ago
  d := t122_booking('r-d@example.test', 't119-d', 0);                         -- arrives today
  e := t122_booking('r-e@example.test', 't119-e', 2, 'cancelled');
  f := t122_booking('r-f@example.test', 't119-f', 2, 'pending');
  g := t122_booking('r-g@example.test', 't119-g', 3);                         -- in the window, no email
  update guests set email = '' where id = (select primary_guest_id from reservations where id = g);

  if queue_arrival_reminders() <> 0 then raise exception 'FAIL queued while the setting is off'; end if;

  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform set_arrival_reminder_days(v_p, 3);
  perform t_sys();
  n := queue_arrival_reminders();
  if n <> 1 then raise exception 'FAIL expected 1 queued, got %', n; end if;
  if not exists (select 1 from email_outbox where reservation_id = a and kind = 'arrival_reminder' and to_email = 'r-a@example.test') then raise exception 'FAIL booking A not queued'; end if;
  if exists (select 1 from email_outbox where kind = 'arrival_reminder' and reservation_id in (b, c, d, e, f, g)) then raise exception 'FAIL a booking outside the rules was queued'; end if;
  raise notice 'PASS arrival reminders: off sends nothing; on queues only a confirmed, older booking in the window with an email';
end $$;

-- 3. once per booking; a wider window picks up the next one only; the limit holds
do $$ declare
  v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; b uuid := (select id from reservations where arrival_date = property_today(v_p) + 5 and reservation_status = 'confirmed' and created_at < now() - interval '2 days' limit 1);
  n integer;
begin
  if queue_arrival_reminders() <> 0 then raise exception 'FAIL a repeat queued again'; end if;
  if (select count(*) from email_outbox where kind = 'arrival_reminder') <> 1 then raise exception 'FAIL more than one reminder for the booking'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform set_arrival_reminder_days(v_p, 7);
  perform t_sys();
  n := queue_arrival_reminders();
  if n <> 1 or not exists (select 1 from email_outbox where reservation_id = b and kind = 'arrival_reminder') then raise exception 'FAIL widening to 7 days queued % (expected booking B only)', n; end if;
  if queue_arrival_reminders() <> 0 then raise exception 'FAIL second repeat'; end if;

  perform t122_booking('r-h@example.test', 't119-h', 4);
  perform t122_booking('r-i@example.test', 't119-i', 6);
  n := queue_arrival_reminders(1);
  if n <> 1 then raise exception 'FAIL limit 1 queued %', n; end if;
  n := queue_arrival_reminders(1);
  if n <> 1 then raise exception 'FAIL the next run did not take the other one (%)', n; end if;
  if queue_arrival_reminders() <> 0 then raise exception 'FAIL left over'; end if;
  raise notice 'PASS arrival reminders: once per booking, wider window adds only new bookings, limit respected';
end $$;

-- 4. the queue function is for the system only
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000aa01';
do $$ begin
  begin perform queue_arrival_reminders(); raise exception 'FAIL authenticated queue_arrival_reminders';
  exception when insufficient_privilege then null; end;
end $$;
rollback;
begin;
set local role anon;
do $$ begin
  begin perform queue_arrival_reminders(); raise exception 'FAIL anon queue_arrival_reminders';
  exception when insufficient_privilege then null; end;
end $$;
rollback;
do $$ begin raise notice 'PASS arrival reminders: queue function closed to authenticated and anonymous callers'; end $$;

-- put the hotel back as it was
do $$ begin
  perform t_sys();
  update properties set arrival_reminder_days = null where id = '00000000-0000-0000-0000-0000000000a2';
end $$;
drop function t122_booking(text, text, integer, text, interval);
