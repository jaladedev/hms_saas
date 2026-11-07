-- Staff notifications (migration 048). Reuses t_as / t_sys / t_expect (05) and t07_res (07).
-- Users: aa01 owner A, aa02 housekeeping A, aa04 front desk A, aa05 accountant A, aa08 maintenance A, aa03 revoked owner A, bb01 owner B.
-- Every booking sits 1800 to 1830 days ahead (nothing else uses it) except the one for "today", which needs a free room today.
\set ON_ERROR_STOP on

-- The rows of one kind about one thing, read as the superuser
create function t50_rows(p_kind text, p_entity uuid) returns setof notifications language sql as $$
  select * from notifications where kind = p_kind and entity_id = p_entity order by created_at, id
$$;
-- Does this person's inbox hold this notification?
create function t50_sees(p_user uuid, p_id uuid) returns boolean language plpgsql as $$
declare v boolean;
begin
  perform t_as(p_user::text);
  select exists (select 1 from jsonb_array_elements(notification_inbox(200) -> 'items') i where (i ->> 'id')::uuid = p_id) into v;
  perform t_sys();
  return v;
end $$;
create function t50_unread(p_user uuid) returns integer language plpgsql as $$
declare v integer;
begin
  perform t_as(p_user::text);
  v := notification_unread_count();
  perform t_sys();
  return v;
end $$;

-- 1. Money: a reservation that needs a person
do $$ declare
  res uuid; ref text; a uuid; b uuid; n int;
  owner uuid := '00000000-0000-0000-0000-00000000aa01'; hk uuid := '00000000-0000-0000-0000-00000000aa02'; fd uuid := '00000000-0000-0000-0000-00000000aa04';
  acc uuid := '00000000-0000-0000-0000-00000000aa05'; ob uuid := '00000000-0000-0000-0000-00000000bb01'; rev uuid := '00000000-0000-0000-0000-00000000aa03';
begin
  perform t_sys();
  res := t07_res(1800, 2, 't50-b1');
  select booking_reference into ref from reservations where id = res;
  update reservations set attention_reason = 'paid_inventory_lost' where id = res;
  select id into a from t50_rows('reservation_attention', res);
  if a is null then raise exception 'FAIL no notification for paid_inventory_lost'; end if;
  if (select severity || '|' || category || '|' || permission || '|' || link from notifications where id = a) <> 'urgent|money|payment.verify|/app/reservations/' || res then raise exception 'FAIL notification fields'; end if;
  if (select title from notifications where id = a) <> 'Paid, but the room is gone: ' || ref then raise exception 'FAIL title'; end if;
  if not t50_sees(acc, a) or not t50_sees(owner, a) then raise exception 'FAIL accountant and owner must see it'; end if;
  if t50_sees(fd, a) or t50_sees(hk, a) or t50_sees(ob, a) or t50_sees(rev, a) then raise exception 'FAIL front desk, housekeeping, another hotel and a revoked login must not see it'; end if;

  -- setting the same reason again changes nothing; a different reason is a new notification; clearing is silent
  update reservations set attention_reason = 'paid_inventory_lost' where id = res;
  update reservations set attention_reason = 'payment_amount_mismatch' where id = res;
  update reservations set attention_reason = null where id = res;
  select count(*) into n from t50_rows('reservation_attention', res);
  if n <> 2 then raise exception 'FAIL expected 2 notifications, got %', n; end if;
  if not exists (select 1 from t50_rows('reservation_attention', res) where title = 'A payment needs a look: ' || ref and body = 'Reason: amount mismatch.' and severity = 'attention') then raise exception 'FAIL payment_ reason wording'; end if;

  -- per-person read state
  select id into b from t50_rows('reservation_attention', res) where id <> a;
  perform t_as(acc::text); n := notification_unread_count(); perform t_sys();
  perform t_as(acc::text); perform mark_notification_read(a); perform mark_notification_read(a); perform t_sys();
  if t50_unread(acc) <> n - 1 then raise exception 'FAIL reading one lowers the accountant''s count by one (% -> %)', n, t50_unread(acc); end if;
  if (select count(*) from notification_reads where notification_id = a) <> 1 then raise exception 'FAIL double read stored twice'; end if;
  perform t_as(owner::text);
  if exists (select 1 from jsonb_array_elements(notification_inbox(200, null, true) -> 'items') i where (i ->> 'id')::uuid = a) is not true then raise exception 'FAIL the owner still has it unread'; end if;
  perform t_as(acc::text);
  if exists (select 1 from jsonb_array_elements(notification_inbox(200, null, true) -> 'items') i where (i ->> 'id')::uuid = a) then raise exception 'FAIL it must not be in the accountant''s unread list'; end if;
  if not exists (select 1 from jsonb_array_elements(notification_inbox(200) -> 'items') i where (i ->> 'id')::uuid = a and (i ->> 'read')::boolean) then raise exception 'FAIL read flag'; end if;
  perform t_as(fd::text); perform t_expect(format('select mark_notification_read(%L)', a), 'NOT_FOUND');
  perform t_as(ob::text); perform t_expect(format('select mark_notification_read(%L)', a), 'NOT_FOUND');
  perform t_as(acc::text);
  if mark_notifications_read('money') < 1 then raise exception 'FAIL mark all money read'; end if;
  if mark_notifications_read('money') <> 0 then raise exception 'FAIL marking again must change nothing'; end if;
  perform t_expect('select mark_notifications_read(''bogus'')', 'POLICY_VIOLATION: arguments');
  perform t_sys();
  raise notice 'PASS money: a reservation flagged for attention notifies the people who may verify payments, once per new reason; read state is per person';
end $$;

-- 2. Money: refunds and failed emails
do $$ declare
  res uuid; f refunds%rowtype; a uuid; b uuid; e uuid;
  owner uuid := '00000000-0000-0000-0000-00000000aa01'; fd uuid := '00000000-0000-0000-0000-00000000aa04'; acc uuid := '00000000-0000-0000-0000-00000000aa05';
  hk uuid := '00000000-0000-0000-0000-00000000aa02'; ob uuid := '00000000-0000-0000-0000-00000000bb01';
begin
  perform t_sys();
  update guests set email = 't50@example.com' where id = '00000000-0000-0000-0000-0000000000a5';
  res := t07_res(1810, 2, 't50-b2');
  perform record_manual_payment(res, (select total_minor from reservations where id = res), 'cash', 'c50', null, 't50-pay');
  perform t_as(owner::text); perform cancel_reservation(res, 'test', 't50-cancel'); perform t_sys();
  select * into f from refunds where reservation_id = res;
  if f.id is null then raise exception 'FAIL fixture: no refund'; end if;
  perform write_audit(f.tenant_id, f.property_id, null, 'refund.needs_bank_details', 'refund', f.id, null, '{}'::jsonb);
  perform write_audit(f.tenant_id, f.property_id, null, 'refund.needs_attention', 'refund', f.id, null, '{}'::jsonb);
  select id into a from t50_rows('refund_needs_bank_details', f.id);
  select id into b from t50_rows('refund_needs_attention', f.id);
  if a is null or b is null then raise exception 'FAIL refund notifications missing'; end if;
  if (select severity from notifications where id = a) <> 'attention' or (select severity from notifications where id = b) <> 'urgent' then raise exception 'FAIL refund severities'; end if;
  if not t50_sees(acc, a) or not t50_sees(owner, b) then raise exception 'FAIL refund.approve holders must see them'; end if;
  if t50_sees(fd, a) or t50_sees(hk, b) or t50_sees(ob, a) then raise exception 'FAIL others must not see refund notices'; end if;
  -- a staff cancellation is not a "guest cancelled" notice
  if exists (select 1 from t50_rows('guest_cancelled', res)) then raise exception 'FAIL a staff cancellation produced a guest notice'; end if;

  -- a guest email that gives up
  perform enqueue_booking_email(res, 'booking_cancelled', 't50-mail', '{}'::jsonb);
  select id into e from email_outbox where reservation_id = res and dedupe_key = 't50-mail';
  update email_outbox set status = 'pending', attempts = 2, last_error = 'x' where id = e;
  if exists (select 1 from notifications where dedupe_key = 'email:' || e) then raise exception 'FAIL a retry is not a failure'; end if;
  update email_outbox set status = 'failed', attempts = 5, last_error = 'bounced' where id = e;
  select id into a from notifications where dedupe_key = 'email:' || e;
  if a is null then raise exception 'FAIL failed email not notified'; end if;
  update email_outbox set status = 'pending' where id = e;
  update email_outbox set status = 'failed' where id = e;
  if (select count(*) from notifications where dedupe_key = 'email:' || e) <> 1 then raise exception 'FAIL a second failure of the same email duplicated the notice'; end if;
  if not t50_sees(fd, a) or not t50_sees(owner, a) then raise exception 'FAIL reservation.modify holders must see failed emails'; end if;
  if t50_sees(acc, a) or t50_sees(hk, a) then raise exception 'FAIL accountant and housekeeping must not see failed emails'; end if;
  raise notice 'PASS refunds and emails: needs-bank-details, needs-attention and a failed guest email reach only the roles that can act on them, once each';
end $$;

-- 3. Maintenance: urgent repairs on raise, and overdue ones from the sweep
do $$ declare
  q1 uuid := gen_random_uuid(); q2 uuid := gen_random_uuid(); q3 uuid := gen_random_uuid(); a uuid; s jsonb; old_id uuid;
  tenant uuid; prop uuid := '00000000-0000-0000-0000-0000000000a2';
  mt uuid := '00000000-0000-0000-0000-00000000aa08'; hk uuid := '00000000-0000-0000-0000-00000000aa02'; fd uuid := '00000000-0000-0000-0000-00000000aa04'; ob uuid := '00000000-0000-0000-0000-00000000bb01';
begin
  perform t_sys();
  select tenant_id into tenant from properties where id = prop;
  insert into maintenance_requests (id, tenant_id, property_id, location, title, priority) values (q1, tenant, prop, 'Lobby', 'T50 lift stuck', 'normal');
  if exists (select 1 from t50_rows('repair_urgent', q1)) then raise exception 'FAIL a normal repair notified'; end if;
  update maintenance_requests set priority = 'urgent' where id = q1;
  select id into a from t50_rows('repair_urgent', q1);
  if a is null or (select title from notifications where id = a) <> 'Urgent repair: T50 lift stuck' or (select body from notifications where id = a) <> 'At Lobby.' then raise exception 'FAIL urgent repair notice'; end if;
  update maintenance_requests set priority = 'urgent' where id = q1;
  update maintenance_requests set priority = 'high' where id = q1;
  update maintenance_requests set priority = 'urgent' where id = q1;
  if (select count(*) from t50_rows('repair_urgent', q1)) <> 2 then raise exception 'FAIL expected the urgent notice once and the high notice once, got %', (select count(*) from t50_rows('repair_urgent', q1)); end if;
  insert into maintenance_requests (id, tenant_id, property_id, room_id, title, priority) values (q2, tenant, prop, (select id from rooms where property_id = prop order by room_number limit 1), 'T50 AC leak', 'high');
  if (select title from t50_rows('repair_urgent', q2)) <> 'High priority repair: T50 AC leak' or (select body from t50_rows('repair_urgent', q2)) !~ '^At room ' then raise exception 'FAIL high repair on insert'; end if;
  if not t50_sees(mt, a) or t50_sees(hk, a) or t50_sees(fd, a) or t50_sees(ob, a) then raise exception 'FAIL maintenance notice visibility'; end if;

  -- overdue, once, and the 90 day purge
  insert into maintenance_requests (id, tenant_id, property_id, location, title, priority, due_at) values (q3, tenant, prop, 'Garden', 'T50 gate', 'normal', now() - interval '1 hour');
  s := notifications_sweep();
  if (s ->> 'overdue_raised')::int < 1 or (select count(*) from t50_rows('repair_overdue', q3)) <> 1 then raise exception 'FAIL overdue not raised %', s; end if;
  s := notifications_sweep();
  if (select count(*) from t50_rows('repair_overdue', q3)) <> 1 then raise exception 'FAIL overdue duplicated'; end if;
  update maintenance_requests set status = 'resolved', started_at = now(), resolved_at = now() where id = q1;
  perform enqueue_notification(prop, 'no_show', 'booking', 'info', 'T50 old', null, null, 'reservation.view', null, null, null);
  update notifications set created_at = now() - interval '100 days' where title = 'T50 old' returning id into old_id;
  s := notifications_sweep();
  if (s ->> 'purged')::int < 1 or exists (select 1 from notifications where id = old_id) then raise exception 'FAIL old notification not purged %', s; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  begin perform notifications_sweep(); raise exception 'FAIL an owner ran the sweep'; exception when insufficient_privilege then null; end;
  perform t_sys();
  raise notice 'PASS maintenance: high and urgent repairs notify maintenance managers once per level; overdue ones once from the sweep (service role only); old notices are purged';
end $$;

-- 4. Booking updates
do $$ declare
  res uuid; web jsonb; wres uuid; a uuid; t date := property_today('00000000-0000-0000-0000-0000000000a2'); prop uuid := '00000000-0000-0000-0000-0000000000a2'; tenant uuid;
  owner uuid := '00000000-0000-0000-0000-00000000aa01'; fd uuid := '00000000-0000-0000-0000-00000000aa04'; acc uuid := '00000000-0000-0000-0000-00000000aa05';
  hk uuid := '00000000-0000-0000-0000-00000000aa02'; ob uuid := '00000000-0000-0000-0000-00000000bb01';
begin
  perform t_sys();
  select tenant_id into tenant from properties where id = prop;
  res := t07_res(1820, 1, 't50-b3');
  perform write_audit(tenant, prop, null, 'reservation.cancelled', 'reservation', res, null, jsonb_build_object('by', 'guest', 'reason', 'Cancelled by the guest'));
  select id into a from t50_rows('guest_cancelled', res);
  if a is null or (select category || severity || permission from notifications where id = a) <> 'bookinginforeservation.view' then raise exception 'FAIL guest cancel notice'; end if;
  if not t50_sees(fd, a) or not t50_sees(acc, a) or t50_sees(hk, a) or t50_sees(ob, a) then raise exception 'FAIL guest cancel visibility'; end if;
  perform write_audit(tenant, prop, null, 'reservation.cancelled', 'reservation', res, null, jsonb_build_object('reason', 'staff'));
  if (select count(*) from t50_rows('guest_cancelled', res)) <> 1 then raise exception 'FAIL a staff cancellation notified as a guest cancellation'; end if;
  perform write_audit(tenant, prop, null, 'reservation.no_show', 'reservation', res, null, '{}'::jsonb);
  if (select count(*) from t50_rows('no_show', res)) <> 1 then raise exception 'FAIL no-show notice'; end if;

  -- a website booking confirmed by payment
  web := create_reservation(prop, '00000000-0000-0000-0000-0000000000a5', 'website', t + 1830, t + 1832,
          jsonb_build_array(jsonb_build_object('room_type_id', '00000000-0000-0000-0000-0000000000a3', 'adults', 1)), 't50-web');
  wres := (web ->> 'reservation_id')::uuid;
  if exists (select 1 from t50_rows('website_booking', wres)) then raise exception 'FAIL an unpaid hold notified as a booking'; end if;
  perform record_manual_payment(wres, (select total_minor from reservations where id = wres), 'cash', 'w50', null, 't50-webpay');
  select id into a from t50_rows('website_booking', wres);
  if a is null or (select body from notifications where id = a) !~ '^2 nights, ' then raise exception 'FAIL website booking notice'; end if;
  if (select count(*) from t50_rows('website_booking', res)) <> 0 then raise exception 'FAIL a staff entry notified as a website booking'; end if;
  raise notice 'PASS booking: guest cancellations, no-shows and paid website bookings notify reservation.view holders; staff cancellations and unpaid holds do not';
end $$;

-- 5. Housekeeping: a room turns dirty while a guest is due in it today
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); prop uuid := '00000000-0000-0000-0000-0000000000a2'; room uuid; other uuid; res uuid; a uuid;
  hk uuid := '00000000-0000-0000-0000-00000000aa02'; fd uuid := '00000000-0000-0000-0000-00000000aa04'; acc uuid := '00000000-0000-0000-0000-00000000aa05'; ob uuid := '00000000-0000-0000-0000-00000000bb01';
begin
  perform t_sys();
  -- two rooms of our own, so nothing else has claimed them (they are retired again at the end)
  insert into rooms (tenant_id, property_id, room_type_id, room_number, floor)
    select tenant_id, id, '00000000-0000-0000-0000-0000000000a3', 'T50-' || g, 9 from properties, generate_series(1, 2) g where id = prop;
  select id into room from rooms where property_id = prop and room_number = 'T50-1';
  select id into other from rooms where property_id = prop and room_number = 'T50-2';
  res := (t_book('00000000-0000-0000-0000-0000000000a3', t, t + 1, 't50-today', room) ->> 'reservation_id')::uuid;
  update rooms set housekeeping_status = 'clean' where id in (room, other);
  update rooms set housekeeping_status = 'dirty' where id = other;
  if exists (select 1 from notifications where entity_id = other and kind = 'room_dirty_arrival') then raise exception 'FAIL a dirty room with nobody due notified'; end if;
  update rooms set housekeeping_status = 'dirty' where id = room;
  select id into a from t50_rows('room_dirty_arrival', room);
  if a is null or (select title from notifications where id = a) !~ 'is dirty and a guest arrives today$' then raise exception 'FAIL room dirty notice'; end if;
  update rooms set housekeeping_status = 'clean' where id = room;
  update rooms set housekeeping_status = 'dirty' where id = room;
  if (select count(*) from t50_rows('room_dirty_arrival', room)) <> 1 then raise exception 'FAIL same room, same day, duplicated'; end if;
  if not t50_sees(hk, a) or not t50_sees(fd, a) or t50_sees(acc, a) or t50_sees(ob, a) then raise exception 'FAIL housekeeping notice visibility'; end if;
  update rooms set operational_status = 'retired' where id in (room, other);
  raise notice 'PASS housekeeping: a room turning dirty with a guest due today notifies housekeeping.view holders once a day; a dirty room with nobody due does not';
end $$;

-- 6. Isolation, doors and failure containment
do $$ declare prop uuid := '00000000-0000-0000-0000-0000000000a2'; r jsonb; ok boolean; page1 jsonb; page2 jsonb;
  owner uuid := '00000000-0000-0000-0000-00000000aa01'; ob uuid := '00000000-0000-0000-0000-00000000bb01'; rev uuid := '00000000-0000-0000-0000-00000000aa03';
begin
  perform t_sys();
  -- hotel B and a revoked login see none of hotel A's notices; every item they do see belongs to their own hotel
  perform t_as(ob::text); r := notification_inbox(200);
  if exists (select 1 from jsonb_array_elements(r -> 'items') i where (i ->> 'property_id')::uuid = prop) then raise exception 'FAIL hotel B sees hotel A notices'; end if;
  perform t_as(rev::text); r := notification_inbox(200);
  if jsonb_array_length(r -> 'items') <> 0 or (r #>> '{unread,total}')::int <> 0 or notification_unread_count() <> 0 then raise exception 'FAIL a revoked login sees notices'; end if;

  -- paging: newest first, and `before` continues where the page ended
  perform t_as(owner::text);
  page1 := notification_inbox(3);
  if jsonb_array_length(page1 -> 'items') <> 3 then raise exception 'FAIL page size'; end if;
  page2 := notification_inbox(3, (page1 #>> '{items,2,created_at}')::timestamptz);
  if (page2 #>> '{items,0,id}') = (page1 #>> '{items,2,id}') and (page2 #>> '{items,0,created_at}') = (page1 #>> '{items,2,created_at}') then raise exception 'FAIL paging repeats the last row'; end if;
  if (page1 #>> '{items,0,created_at}')::timestamptz < (page1 #>> '{items,1,created_at}')::timestamptz then raise exception 'FAIL not newest first'; end if;
  perform t_expect('select notification_inbox(0)', 'POLICY_VIOLATION: arguments');
  perform t_expect('select notification_inbox(201)', 'POLICY_VIOLATION: arguments');
  perform t_expect('select notification_inbox(10, null, false, ''bogus'')', 'POLICY_VIOLATION: arguments');
  if (select count(*) from jsonb_array_elements(notification_inbox(200, null, false, 'maintenance') -> 'items') i where i ->> 'category' <> 'maintenance') <> 0 then raise exception 'FAIL category filter'; end if;

  -- the tables are closed to the client roles
  begin perform 1 from notifications limit 1; raise exception 'FAIL an owner read the table'; exception when insufficient_privilege then null; end;
  begin insert into notification_reads (notification_id, user_id) select id, owner from notifications limit 1; raise exception 'FAIL an owner wrote reads'; exception when insufficient_privilege then null; end;
  begin perform enqueue_notification(prop, 'no_show', 'booking', 'info', 'x', null, null, 'reservation.view', null, null, null); raise exception 'FAIL an owner enqueued'; exception when insufficient_privilege then null; end;
  perform t_sys();
  -- anon is shut out of every door
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('role', 'anon', true);
  begin perform notification_inbox(); raise exception 'FAIL anon read the inbox'; exception when insufficient_privilege then null; end;
  begin perform notification_unread_count(); raise exception 'FAIL anon counted'; exception when insufficient_privilege then null; end;
  begin perform mark_notifications_read(); raise exception 'FAIL anon marked'; exception when insufficient_privilege then null; end;
  perform set_config('role', 'postgres', true);

  -- a notice that cannot be written never fails the caller, and links stay inside the app
  perform t_sys();
  ok := enqueue_notification(prop, 'bogus_kind', 'booking', 'info', 'x', null, null, 'reservation.view', null, null, null);
  if ok then raise exception 'FAIL an invalid notice was stored'; end if;
  ok := enqueue_notification(prop, 'no_show', 'booking', 'info', 'x', null, 'https://evil.example/x', 'reservation.view', null, null, null);
  if ok then raise exception 'FAIL an outside link was stored'; end if;
  ok := enqueue_notification(gen_random_uuid(), 'no_show', 'booking', 'info', 'x', null, null, 'reservation.view', null, null, null);
  if ok then raise exception 'FAIL a notice for no hotel was stored'; end if;
  raise notice 'PASS access: hotel B and a revoked login see nothing of hotel A; paging, filters and arguments behave; the tables and enqueue are closed to clients; anon is shut out; a failing notice never raises, and links stay in the app';
end $$;
