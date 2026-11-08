-- Guest contact edits and change requests (migration 069). Reuses t_as / t_sys / t_expect / t_book / t_rr (05) and t50_rows (56).
-- Policy rows are immutable, so the test edits the one in force with triggers off and puts it back at the end.
\set ON_ERROR_STOP on

create function t70_policy(p_on boolean, p_hours integer) returns void language plpgsql as $$
declare prop uuid := '00000000-0000-0000-0000-0000000000a2'; cfg jsonb; pid uuid;
begin
  set local session_replication_role = replica;
  select id, config into pid, cfg from property_policies where property_id = prop and effective_from <= property_today(prop) order by effective_from desc limit 1;
  if pid is null then raise exception 'FAIL test needs a policy row in force'; end if;
  cfg := cfg - 'guest_changes' - 'guest_change_hours';
  if p_on then cfg := cfg || jsonb_build_object('guest_changes', 'on'); end if;
  if p_hours is not null then cfg := cfg || jsonb_build_object('guest_change_hours', p_hours); end if;
  update property_policies set config = cfg where id = pid;
  set local session_replication_role = origin;
end $$;

create function t70_denied(p_sql text) returns void language plpgsql as $$
begin
  execute p_sql;
  raise exception 'FAIL expected permission denied: %', p_sql;
exception when insufficient_privilege then null;
end $$;

do $$ declare
  prop uuid := '00000000-0000-0000-0000-0000000000a2'; t date;
  owner text := '00000000-0000-0000-0000-00000000aa01'; hk text := '00000000-0000-0000-0000-00000000aa02';
  fd text := '00000000-0000-0000-0000-00000000aa04'; ob text := '00000000-0000-0000-0000-00000000bb01';
  r jsonb; res uuid; res2 uuid; q uuid; o jsonb; guest uuid;
begin
  perform t_sys();
  t := property_today(prop);

  -- A. off by default: nothing is allowed, and the options say why
  perform t70_policy(false, null);
  perform t_as(owner);
  r := t_book('00000000-0000-0000-0000-0000000000a3', t + 20, t + 22, 't70-a'); res := (r ->> 'reservation_id')::uuid;
  perform t_sys();
  o := guest_change_options(res);
  if (o ->> 'allowed')::boolean or o ->> 'why_not' <> 'disabled' then raise exception 'FAIL options with the policy off: %', o; end if;
  perform t_expect(format('select guest_update_contact(%L, %L, %L)', res, '+234 801 000 0000', 't70-a1'), 'INVALID_STATE: change disabled');
  perform t_expect(format('select guest_request_change(%L, %L, null, null, %L, %L)', res, 'other', 'hello', 't70-a2'), 'INVALID_STATE: change disabled');

  -- B. logins cannot call the guest functions at all
  perform t_as(owner);
  perform t70_denied(format('select guest_change_options(%L)', res));
  perform t70_denied(format('select guest_request_change(%L, %L, null, null, %L, %L)', res, 'other', 'hello', 't70-b'));
  perform t70_denied(format('select guest_update_contact(%L, %L, %L)', res, '+234 801 000 0000', 't70-b2'));
  perform t70_denied(format('select guest_withdraw_change_request(%L)', res));

  -- C. on: the phone changes, once, audited; bad numbers are refused
  perform t_sys();
  perform t70_policy(true, 48);
  o := guest_change_options(res);
  if not (o ->> 'allowed')::boolean or not (o ->> 'dates_open')::boolean or (o ->> 'window_hours')::int <> 48 then raise exception 'FAIL options on: %', o; end if;
  perform t_expect(format('select guest_update_contact(%L, %L, %L)', res, 'call me', 't70-c1'), 'POLICY_VIOLATION: phone');
  perform t_expect(format('select guest_update_contact(%L, %L, %L)', res, '   ', 't70-c2'), 'POLICY_VIOLATION: phone');
  perform guest_update_contact(res, '+234 801 111 2222', 't70-c3');
  perform guest_update_contact(res, '+234 801 111 2222', 't70-c3');
  select primary_guest_id into guest from reservations where id = res;
  if (select phone from guests where id = guest) <> '+234 801 111 2222' then raise exception 'FAIL phone not saved'; end if;
  if (select count(*) from audit_logs where action = 'guest.contact_updated' and entity_id = res) <> 1 then raise exception 'FAIL contact audit'; end if;

  -- D. requests: validation, one open at a time, replay-safe, notice once
  perform t_expect(format('select guest_request_change(%L, %L, %L, %L, null, %L)', res, 'dates', t + 25, t + 25, 't70-d1'), 'POLICY_VIOLATION: dates');
  perform t_expect(format('select guest_request_change(%L, %L, %L, %L, null, %L)', res, 'dates', t - 1, t + 2, 't70-d2'), 'POLICY_VIOLATION: dates');
  perform t_expect(format('select guest_request_change(%L, %L, %L, %L, null, %L)', res, 'dates', t + 20, t + 22, 't70-d3'), 'POLICY_VIOLATION: dates');
  perform t_expect(format('select guest_request_change(%L, %L, null, null, null, %L)', res, 'room', 't70-d4'), 'POLICY_VIOLATION: request');
  perform t_expect(format('select guest_request_change(%L, %L, null, null, %L, %L)', res, 'move', 'x', 't70-d5'), 'POLICY_VIOLATION: request');
  r := guest_request_change(res, 'dates', t + 21, t + 24, 'a day later please', 't70-d6');
  q := (r ->> 'request_id')::uuid;
  r := guest_request_change(res, 'dates', t + 21, t + 24, 'a day later please', 't70-d6');
  if (r ->> 'request_id')::uuid <> q then raise exception 'FAIL replay made another request'; end if;
  perform t_expect(format('select guest_request_change(%L, %L, null, null, %L, %L)', res, 'other', 'and a cot', 't70-d7'), 'INVALID_STATE: change open request');
  if (select count(*) from t50_rows('guest_change_request', q)) <> 1 then raise exception 'FAIL expected one notice'; end if;
  if (select permission || '|' || link from notifications where kind = 'guest_change_request' and entity_id = q) <> 'reservation.modify|/app/requests' then raise exception 'FAIL notice shape'; end if;
  o := guest_change_options(res);
  if o #>> '{open_request,kind}' <> 'dates' or o #>> '{open_request,arrival}' <> (t + 21)::text then raise exception 'FAIL open request in options: %', o; end if;
  -- the booking itself did not move
  if (select arrival_date from reservations where id = res) <> t + 20 then raise exception 'FAIL a request changed the booking'; end if;

  -- E. staff: who sees the queue, who may answer, what an answer needs
  perform t_as(hk);
  if exists (select 1 from guest_change_requests) then raise exception 'FAIL housekeeping sees requests'; end if;
  perform t_expect(format('select resolve_change_request(%L, %L, %L)', q, 'done', null), 'NOT_FOUND');
  perform t_as(ob);
  if exists (select 1 from guest_change_requests) then raise exception 'FAIL another hotel sees requests'; end if;
  perform t_expect(format('select resolve_change_request(%L, %L, %L)', q, 'done', null), 'NOT_FOUND');
  perform t_as(fd);
  if (select count(*) from guest_change_requests) <> 1 then raise exception 'FAIL front desk should see the queue'; end if;
  perform t_expect(format('select resolve_change_request(%L, %L, %L)', q, 'declined', '  '), 'POLICY_VIOLATION: outcome');
  perform t_expect(format('select resolve_change_request(%L, %L, %L)', q, 'maybe', 'x'), 'POLICY_VIOLATION: outcome');
  perform t70_denied('insert into guest_change_requests (tenant_id, property_id, reservation_id, kind, message) select tenant_id, property_id, id, ''other'', ''x'' from reservations limit 1');
  r := resolve_change_request(q, 'declined', 'We are full that night.');
  perform t_expect(format('select resolve_change_request(%L, %L, %L)', q, 'done', null), 'INVALID_STATE: declined');
  perform t_sys();
  o := guest_change_options(res);
  if o #>> '{last_answer,status}' <> 'declined' or o #>> '{last_answer,note}' <> 'We are full that night.' or o -> 'open_request' <> 'null'::jsonb then raise exception 'FAIL answer in options: %', o; end if;
  if (select count(*) from audit_logs where action = 'reservation.change_resolved' and entity_id = res) <> 1 then raise exception 'FAIL resolve audit'; end if;

  -- F. after an answer a new request is possible; the guest may withdraw; done needs no note
  r := guest_request_change(res, 'room', null, null, 'a quieter room', 't70-f1'); q := (r ->> 'request_id')::uuid;
  if not (guest_withdraw_change_request(res) ->> 'withdrawn')::boolean then raise exception 'FAIL withdraw'; end if;
  if (guest_withdraw_change_request(res) ->> 'withdrawn')::boolean then raise exception 'FAIL second withdraw'; end if;
  r := guest_request_change(res, 'other', null, null, 'late arrival, around midnight', 't70-f2'); q := (r ->> 'request_id')::uuid;
  perform t_as(owner);
  perform resolve_change_request(q, 'done', null);
  perform t_sys();
  if (select status from guest_change_requests where id = q) <> 'done' then raise exception 'FAIL done'; end if;

  -- G. the notice window: inside it dates and room requests close, a plain request stays open
  perform t_as(owner);
  r := t_book('00000000-0000-0000-0000-0000000000a3', t + 1, t + 3, 't70-g'); res2 := (r ->> 'reservation_id')::uuid;
  perform t_sys();
  o := guest_change_options(res2);
  if not (o ->> 'allowed')::boolean or (o ->> 'dates_open')::boolean then raise exception 'FAIL window: %', o; end if;
  perform t_expect(format('select guest_request_change(%L, %L, %L, %L, null, %L)', res2, 'dates', t + 2, t + 4, 't70-g1'), 'INVALID_STATE: change window');
  perform t_expect(format('select guest_request_change(%L, %L, null, null, %L, %L)', res2, 'room', 'quiet', 't70-g2'), 'INVALID_STATE: change window');
  perform guest_request_change(res2, 'other', null, null, 'we land at 11pm', 't70-g3');
  perform t70_policy(true, 0);
  if not (guest_change_options(res2) ->> 'dates_open')::boolean then raise exception 'FAIL a zero-hour window should leave dates open'; end if;

  -- H. a cancelled booking and one with a guest in the house cannot use any of it
  perform t_as(owner);
  perform cancel_reservation(res2, 'test', 't70-h1');
  perform t_sys();
  o := guest_change_options(res2);
  if o ->> 'why_not' <> 'status' then raise exception 'FAIL cancelled booking: %', o; end if;
  perform t_expect(format('select guest_update_contact(%L, %L, %L)', res2, '+234 801 333 4444', 't70-h2'), 'INVALID_STATE: change status');

  perform t70_policy(false, null);
  raise notice 'PASS guest change requests: off by default; phone edits, one open request, window, answers and notices behave; staff queue is permission-scoped; guests only through the service role';
end $$;

drop function t70_policy(boolean, integer), t70_denied(text);
