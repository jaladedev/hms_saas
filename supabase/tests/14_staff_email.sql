-- Staff failed-email list and resend (migration 017).
-- Reuses t_as / t_sys / t_expect (05), t06_hold (06), t07_res (07), t08_online / t08_conf (08).
-- Users: aa01 owner A, aa04 front desk A (can modify reservations), aa05 accountant A (view only, no modify),
-- aa02 housekeeping A (no reservation access), bb01 owner of Hotel B. Offsets 280 to 285.
\set ON_ERROR_STOP on

update email_outbox set status = 'sent', sent_at = now() where status <> 'sent';

create function t14_fail(p_email text) returns uuid language plpgsql as $$
declare v_id uuid;
begin
  select id into v_id from email_outbox where to_email = lower(p_email) and kind = 'booking_held';
  update email_outbox set status = 'failed', attempts = 5, last_error = 'provider said no', updated_at = now() where id = v_id;
  return v_id;
end $$;

-- 1. The list shows failed and still-retrying emails, only to people who may view reservations at that property
do $$ declare a uuid; b uuid; c uuid; l jsonb; begin
  perform t06_hold(p_off => 280, p_guest => '{"full_name":"Fail One","email":"f1@example.com"}'::jsonb);
  perform t06_hold(p_off => 280, p_guest => '{"full_name":"Fail Two","email":"f2@example.com"}'::jsonb);
  perform t06_hold(p_off => 280, p_guest => '{"full_name":"Fine Three","email":"f3@example.com"}'::jsonb);
  a := t14_fail('f1@example.com');
  b := (select id from email_outbox where to_email = 'f2@example.com');
  update email_outbox set status = 'pending', attempts = 2, last_error = 'timeout', next_attempt_at = now() + interval '5 minutes' where id = b;

  perform t_as('00000000-0000-0000-0000-00000000aa04');
  l := staff_failed_emails();
  if jsonb_array_length(l) <> 2 then raise exception 'FAIL list size %', l; end if;
  if (l -> 0 ->> 'id')::uuid <> a or l -> 0 ->> 'state' <> 'failed' or l -> 0 ->> 'to_email' <> 'f1@example.com'
     or l -> 0 ->> 'last_error' <> 'provider said no' or l -> 0 ->> 'booking_reference' not like 'BK-%' then
    raise exception 'FAIL failed row first with its details %', l -> 0;
  end if;
  if (l -> 1 ->> 'id')::uuid <> b or l -> 1 ->> 'state' <> 'retrying' then raise exception 'FAIL retrying row %', l -> 1; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  if jsonb_array_length(staff_failed_emails()) <> 2 then raise exception 'FAIL accountant can view'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  if jsonb_array_length(staff_failed_emails()) <> 0 then raise exception 'FAIL housekeeping sees emails'; end if;
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  if jsonb_array_length(staff_failed_emails()) <> 0 then raise exception 'FAIL other hotel sees emails'; end if;
  perform t_expect('select staff_failed_emails(0)', 'POLICY_VIOLATION');
  perform t_sys();
  perform t_expect('select staff_failed_emails()', 'NOT_FOUND');
  raise notice 'PASS failed-email list: failed first, retrying after, scoped to people who can view the reservation';
end $$;

-- 2. Resend: permission, state, idempotent double click, attempts reset, audit, and the worker picks it up
do $$ declare a uuid; e email_outbox%rowtype; c jsonb; r jsonb; begin
  select id into a from email_outbox where to_email = 'f1@example.com';
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  perform t_expect(format('select resend_email(%L)', a), 'NOT_FOUND');          -- can view, cannot modify
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select resend_email(%L)', a), 'NOT_FOUND');          -- another hotel
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect('select resend_email(gen_random_uuid())', 'NOT_FOUND');

  r := resend_email(a);
  if r ->> 'status' <> 'pending' or (r ->> 'already_queued')::boolean then raise exception 'FAIL resend result %', r; end if;
  r := resend_email(a);                                                         -- double click
  if not (r ->> 'already_queued')::boolean then raise exception 'FAIL double click %', r; end if;
  perform t_sys();                                                              -- the outbox and audit log are server-only tables
  select * into e from email_outbox where id = a;
  if e.status <> 'pending' or e.attempts <> 0 or e.next_attempt_at > now() then raise exception 'FAIL reset %', e; end if;
  if (select count(*) from audit_logs where action = 'email.resend_requested' and entity_id = a) <> 1 then
    raise exception 'FAIL audit rows';
  end if;
  if (select metadata ->> 'previous_attempts' from audit_logs where action = 'email.resend_requested' and entity_id = a) <> '5' then
    raise exception 'FAIL audit metadata';
  end if;

  c := claim_emails(10);
  if (select count(*) from jsonb_array_elements(c) x where (x ->> 'id')::uuid = a and (x ->> 'attempt')::int = 1) <> 1 then
    raise exception 'FAIL worker did not pick the resent email %', c;
  end if;
  perform mark_email_result(a, true);
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select resend_email(%L)', a), 'INVALID_STATE');      -- already sent
  perform t_sys();
  raise notice 'PASS resend: needs reservation.modify at that hotel, resets attempts, idempotent, audited, picked up by the worker';
end $$;

-- 3. A held-room email is not resent once the hold is no longer active; other kinds still can be
do $$ declare h uuid; v_res uuid; k uuid; begin
  perform t06_hold(p_off => 282, p_guest => '{"full_name":"Late Four","email":"f4@example.com"}'::jsonb);
  h := t14_fail('f4@example.com');
  select reservation_id into v_res from email_outbox where id = h;
  update reservations set reservation_status = 'expired' where id = v_res;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select resend_email(%L)', h), 'POLICY_VIOLATION');
  perform t_sys();
  insert into email_outbox (tenant_id, reservation_id, kind, to_email, status, attempts, last_error)
  select tenant_id, reservation_id, 'booking_link', to_email, 'failed', 5, 'x' from email_outbox where id = h returning id into k;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  if resend_email(k) ->> 'status' <> 'pending' then raise exception 'FAIL other kinds resendable'; end if;
  perform t_sys();
  raise notice 'PASS stale held-room emails are refused; other kinds can be resent';
end $$;
