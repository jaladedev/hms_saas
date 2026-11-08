-- The guest_changes plan flag (migration 075). Reuses t_as / t_sys / t_expect / t_book (05). Hotel group A (a1) is switched off and on.
-- The hotel's own policy is edited with triggers off and put back at the end, like test 70.
\set ON_ERROR_STOP on

create function t75_policy(p_on boolean) returns void language plpgsql as $$
declare prop uuid := '00000000-0000-0000-0000-0000000000a2'; cfg jsonb; pid uuid;
begin
  set local session_replication_role = replica;
  select id, config into pid, cfg from property_policies where property_id = prop and effective_from <= property_today(prop) order by effective_from desc limit 1;
  cfg := cfg - 'guest_changes';
  if p_on then cfg := cfg || jsonb_build_object('guest_changes', 'on'); end if;
  update property_policies set config = cfg where id = pid;
  set local session_replication_role = origin;
end $$;

do $$ declare
  prop uuid := '00000000-0000-0000-0000-0000000000a2'; v_t uuid := '00000000-0000-0000-0000-0000000000a1'; t date; res uuid; o jsonb;
begin
  perform t_sys();
  t := property_today(prop);
  perform t75_policy(true);
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  res := (t_book('00000000-0000-0000-0000-0000000000a3', t + 25, t + 27, 't75-a') ->> 'reservation_id')::uuid;
  perform t_sys();

  -- policy on, no flag row: allowed
  o := guest_change_options(res);
  if not (o ->> 'allowed')::boolean then raise exception 'FAIL default: %', o; end if;
  perform guest_update_contact(res, '+234 801 000 0075', 't75-ok-1');

  -- an unrelated flag off changes nothing
  perform t_as('00000000-0000-0000-0000-00000000f050');
  perform platform_set_entitlement(v_t, 'online_payments', false);
  perform t_sys();
  if not (guest_change_options(res) ->> 'allowed')::boolean then raise exception 'FAIL an unrelated flag disabled guest changes'; end if;

  -- flag off: options say disabled and every self-service call is refused with nothing changed
  perform t_as('00000000-0000-0000-0000-00000000f050');
  perform platform_set_entitlement(v_t, 'guest_changes', false);
  perform t_sys();
  o := guest_change_options(res);
  if (o ->> 'allowed')::boolean or o ->> 'why_not' <> 'disabled' or (o ->> 'dates_open')::boolean then raise exception 'FAIL options with the flag off: %', o; end if;
  perform t_expect(format('select guest_update_contact(%L, %L, %L)', res, '+234 801 000 9999', 't75-off-1'), 'INVALID_STATE: change disabled');
  perform t_expect(format('select guest_request_change(%L, %L, null, null, %L, %L)', res, 'other', 'hello', 't75-off-2'), 'INVALID_STATE: change disabled');
  perform t_expect(format('select guest_change_dates(%L, %L, %L, 0, %L)', res, t + 26, t + 28, 't75-off-3'), 'INVALID_STATE');
  if (select phone from guests where id = (select primary_guest_id from reservations where id = res)) <> '+234 801 000 0075' then raise exception 'FAIL a refused call changed the phone'; end if;

  -- on again
  perform t_as('00000000-0000-0000-0000-00000000f050');
  perform platform_set_entitlement(v_t, 'guest_changes', true);
  perform platform_set_entitlement(v_t, 'online_payments', true);
  perform t_sys();
  if not (guest_change_options(res) ->> 'allowed')::boolean then raise exception 'FAIL guest changes did not return'; end if;

  perform t75_policy(false);
  raise notice 'PASS guest_changes off disables guest contact edits, requests and date changes; on or absent keeps them; the hotel policy still has to be on';
end $$;

drop function t75_policy(boolean);
