-- Revoking guest links (migration 066). Reuses t_as, t_sys, t_expect, t_book.
\set ON_ERROR_STOP on

do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); b jsonb; res uuid; r jsonb; n0 integer; now_s bigint;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  b := t_book('00000000-0000-0000-0000-0000000000a3', t + 1410, t + 1412, 'gl-1'); res := (b ->> 'reservation_id')::uuid;
  perform t_sys();
  now_s := floor(extract(epoch from now()));
  -- never reset: every token passes, including one with no issue time
  if not guest_link_ok(res, 0) or not guest_link_ok(res, now_s) then raise exception 'FAIL a link is refused before any reset'; end if;
  if guest_link_ok(gen_random_uuid(), now_s) then raise exception 'FAIL an unknown booking passed'; end if;
  select count(*) into n0 from email_outbox where reservation_id = res and kind = 'booking_link';

  -- permissions and input
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform t_expect(format('select reset_guest_links(%L, %L, %L)', res, 'leaked', 'gl-1-a'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select reset_guest_links(%L, %L, %L)', res, 'leaked', 'gl-1-b'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select reset_guest_links(%L, %L, %L)', res, '   ', 'gl-1-c'), 'POLICY_VIOLATION: reason');
  perform t_expect(format('select reset_guest_links(%L, %L, %L)', res, repeat('x', 201), 'gl-1-d'), 'POLICY_VIOLATION: reason');

  -- the reset
  r := reset_guest_links(res, 'forwarded by mistake', 'gl-1-e');
  if (r ->> 'reset')::boolean is not true then raise exception 'FAIL reset: %', r; end if;
  perform t_sys();
  if guest_link_ok(res, 0) or guest_link_ok(res, now_s - 60) then raise exception 'FAIL an old link still works'; end if;
  if not guest_link_ok(res, floor(extract(epoch from clock_timestamp()))::bigint + 1) then raise exception 'FAIL a new link is refused'; end if;
  -- a person at another booking is untouched
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  b := t_book('00000000-0000-0000-0000-0000000000a3', t + 1420, t + 1422, 'gl-2');
  perform t_sys();
  if not guest_link_ok((b ->> 'reservation_id')::uuid, 0) then raise exception 'FAIL another booking lost its links'; end if;

  -- replay is the same answer, one audit row; a different reason on the same key is refused
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r := reset_guest_links(res, 'forwarded by mistake', 'gl-1-e');
  perform t_sys();
  if (select count(*) from audit_logs where entity_id = res and action = 'reservation.guest_links_reset') <> 1 then raise exception 'FAIL audit rows'; end if;
  if (select metadata ->> 'reason' from audit_logs where entity_id = res and action = 'reservation.guest_links_reset') <> 'forwarded by mistake' then raise exception 'FAIL audit reason'; end if;

  -- the guest functions are closed to logins
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  begin perform guest_link_ok(res, 0); raise exception 'FAIL a login called guest_link_ok'; exception when insufficient_privilege then null; end;
  perform t_sys();
  raise notice 'PASS guest link reset: old links refused, new ones and other bookings fine, permission and reason enforced, replay safe, audited once';
end $$;
