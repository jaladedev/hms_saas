-- The online_booking flag (migration 064). Reuses t06_hold (06), t_as, t_sys, t_expect. Hotel group A (a1) is switched off and back on.
\set ON_ERROR_STOP on

do $$
declare
  v_t uuid := '00000000-0000-0000-0000-0000000000a1'; r jsonb; n integer;
begin
  perform t_sys();
  -- no row: bookings work, as before
  r := t06_hold(p_off => 200);
  if r ->> 'reservation_id' is null then raise exception 'FAIL no flag row refused a hold: %', r; end if;

  -- an unrelated flag off changes nothing
  perform t_as('00000000-0000-0000-0000-00000000f050');
  perform platform_set_entitlement(v_t, 'online_payments', false);
  perform t_sys();
  r := t06_hold(p_off => 210);
  if r ->> 'reservation_id' is null then raise exception 'FAIL an unrelated flag refused a hold'; end if;

  -- off: refused, and nothing is created
  perform t_as('00000000-0000-0000-0000-00000000f050');
  perform platform_set_entitlement(v_t, 'online_booking', false);
  perform t_sys();
  select count(*) into n from reservations;
  perform t_expect('select t06_hold(p_off => 220)', 'INVALID_STATE: online booking off');
  if (select count(*) from reservations) <> n then raise exception 'FAIL a refused hold created a reservation'; end if;

  -- staff booking by hand is not gated
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_book('00000000-0000-0000-0000-0000000000a3', current_date + 1330, current_date + 1332, 'ob-staff');

  -- on again: bookings return; restore the unrelated flag
  perform t_as('00000000-0000-0000-0000-00000000f050');
  perform platform_set_entitlement(v_t, 'online_booking', true);
  perform platform_set_entitlement(v_t, 'online_payments', true);
  perform t_sys();
  r := t06_hold(p_off => 230);
  if r ->> 'reservation_id' is null then raise exception 'FAIL booking did not return'; end if;
  raise notice 'PASS online_booking off refuses guest holds and creates nothing; staff booking, unrelated flags and on or absent are unaffected';
end $$;
