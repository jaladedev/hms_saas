-- The early_checkin plan flag (migration 076). Reuses t_as / t_sys / t_expect / t_book / t_rr (05). Hotel group A (a1) is switched off and on.
-- Own room T76-1; the policy in force is edited with triggers off and put back at the end, like test 62.
\set ON_ERROR_STOP on

create function t76_days(d integer) returns void language plpgsql as $$
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
  prop uuid := '00000000-0000-0000-0000-0000000000a2'; v_t uuid := '00000000-0000-0000-0000-0000000000a1'; t date; room uuid; b jsonb; res uuid; rr uuid; q jsonb;
  owner text := '00000000-0000-0000-0000-00000000aa01';
begin
  perform t_sys();
  t := property_today(prop);
  insert into rooms (tenant_id, property_id, room_type_id, room_number, floor)
    select tenant_id, id, '00000000-0000-0000-0000-0000000000a3', 'T76-1', 9 from properties where id = prop;
  select id into room from rooms where property_id = prop and room_number = 'T76-1';
  update rooms set housekeeping_status = 'clean' where id = room;
  perform t76_days(3);
  perform t_as(owner);
  b := t_book('00000000-0000-0000-0000-0000000000a3', t + 2, t + 4, 't76-a', room); res := (b ->> 'reservation_id')::uuid; rr := t_rr(b);

  -- policy on, no flag row: offered
  q := early_checkin_quote(rr);
  if not (q ->> 'allowed')::boolean then raise exception 'FAIL default: %', q; end if;

  -- an unrelated flag off changes nothing
  perform t_as('00000000-0000-0000-0000-00000000f050');
  perform platform_set_entitlement(v_t, 'online_payments', false);
  perform t_as(owner);
  if not (early_checkin_quote(rr) ->> 'allowed')::boolean then raise exception 'FAIL an unrelated flag switched early check-in off'; end if;

  -- flag off: the quote says off, the call is refused and changes nothing
  perform t_as('00000000-0000-0000-0000-00000000f050');
  perform platform_set_entitlement(v_t, 'early_checkin', false);
  perform t_as(owner);
  q := early_checkin_quote(rr);
  if (q ->> 'allowed')::boolean or q ->> 'why_not' <> 'off' then raise exception 'FAIL quote with the flag off: %', q; end if;
  perform t_expect(format('select early_check_in(%L, %L)', rr, 'guest arrived'), 'POLICY_VIOLATION: EARLY_CHECKIN_NOT_SUPPORTED');
  perform t_expect(format('select early_check_in(%L, %L, true)', rr, 'guest arrived'), 'POLICY_VIOLATION: EARLY_CHECKIN_NOT_SUPPORTED');
  perform t_sys();
  if (select reservation_status from reservations where id = res) <> 'confirmed' or (select arrival_date from reservations where id = res) <> t + 2 then raise exception 'FAIL a refused early check-in changed the booking'; end if;

  -- on again: it works
  perform t_as('00000000-0000-0000-0000-00000000f050');
  perform platform_set_entitlement(v_t, 'early_checkin', true);
  perform platform_set_entitlement(v_t, 'online_payments', true);
  perform t_as(owner);
  perform early_check_in(rr, 'guest arrived, flag back on');
  perform t_sys();
  if (select reservation_status from reservations where id = res) <> 'checked_in' then raise exception 'FAIL early check-in did not return'; end if;

  perform t76_days(0);
  update rooms set operational_status = 'retired' where id = room;
  raise notice 'PASS early_checkin off: quote says off and early check-in (with or without the waiver) is refused; on or absent keeps it';
end $$;

drop function t76_days(integer);
