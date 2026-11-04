-- What each report counts as money (TODO, Phase 2: "Reports must add folio_payments ... and folio_charges ...").
-- Rule under test: the occupancy, channel and guest reports total ROOM revenue only (nights, before tax) and say so in their
-- column names; only daily_report adds extras (folio_charges) and counts folio_payments as cash received. All four must agree
-- on room revenue for the same days, and posting a folio charge or a folio payment must not move the three room-only reports.
-- Reuses t_as / t_sys (05) and t07_res (07). Users: aa01 owner A (report.view and guest.view). Offset 2700: nothing else uses it.
\set ON_ERROR_STOP on

create function t48_cash(p_day date) returns bigint language sql stable as $$
  select cash_in_minor from daily_report('00000000-0000-0000-0000-0000000000a2', p_day, p_day)
$$;
-- The four reports' room revenue for one window, as an array: daily, occupancy, channel, guests
create function t48_room_rev(p_from date, p_to date) returns bigint[] language sql stable as $$
  select array[
    (select coalesce(sum(room_revenue_minor), 0) from daily_report('00000000-0000-0000-0000-0000000000a2', p_from, p_to))::bigint,
    (occupancy_report('00000000-0000-0000-0000-0000000000a2', p_from, p_to) #>> '{totals,room_revenue_minor}')::bigint,
    (channel_report('00000000-0000-0000-0000-0000000000a2', p_from, p_to) #>> '{totals,room_revenue_minor}')::bigint,
    (select coalesce(sum((e ->> 'room_revenue_minor')::bigint), 0)
       from jsonb_array_elements(guest_report('00000000-0000-0000-0000-0000000000a2', p_from, p_to) -> 'top_guests') e)
  ]
$$;

do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); res uuid; rate bigint;
  before bigint[]; after bigint[]; cash0 bigint; x record;
begin
  perform t_sys();
  res := t07_res(2700, 2, 'rm-book');
  if (select reservation_status from reservations where id = res) <> 'confirmed' then raise exception 'FAIL the stay is not confirmed'; end if;
  select sum(n.rate_minor) into rate
    from reservation_nights n join reservation_rooms rr on rr.id = n.reservation_room_id where rr.reservation_id = res;
  if coalesce(rate, 0) <= 0 then raise exception 'FAIL the stay has no room revenue to compare'; end if;

  -- 1. The four reports agree on room revenue for the same two nights
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  before := t48_room_rev(t + 2700, t + 2701);
  if before <> array[rate, rate, rate, rate] then
    raise exception 'FAIL the reports disagree on room revenue: daily % occupancy % channel % guests % (stay is %)', before[1], before[2], before[3], before[4], rate;
  end if;
  perform t_sys();
  raise notice 'PASS the daily, occupancy, channel and guest reports agree on room revenue';

  -- 2. A posted folio charge and a folio payment change daily_report (extras, cash) and nothing in the room-only reports
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  cash0 := t48_cash(t);
  perform t_sys();
  insert into folio_charges (tenant_id, property_id, reservation_id, category, description, quantity, unit_amount_minor, tax_minor, total_minor, currency, charge_date)
    select tenant_id, property_id, id, 'minibar', 'Water', 1, 50000, 7500, 57500, 'NGN', t + 2700 from reservations where id = res;
  insert into folio_payments (tenant_id, property_id, reservation_id, payment_method, internal_reference, amount_minor, currency)
    select tenant_id, property_id, id, 'cash', 'RM-FP-1', 57500, 'NGN' from reservations where id = res;

  perform t_as('00000000-0000-0000-0000-00000000aa01');
  after := t48_room_rev(t + 2700, t + 2701);
  if after <> before then
    raise exception 'FAIL extras leaked into a room revenue figure: % became % (daily, occupancy, channel, guests)', before, after;
  end if;
  select sum(extras_minor) as extras, sum(extras_tax_minor) as extras_tax into x
    from daily_report('00000000-0000-0000-0000-0000000000a2', t + 2700, t + 2701);
  if x.extras <> 50000 or x.extras_tax <> 7500 then raise exception 'FAIL daily_report extras % / %', x.extras, x.extras_tax; end if;
  if t48_cash(t) - cash0 <> 57500 then raise exception 'FAIL daily_report cash moved by %, expected 57500 (the folio payment)', t48_cash(t) - cash0; end if;
  perform t_sys();
  raise notice 'PASS extras and folio payments appear only in daily_report; the room-only reports do not move';
end $$;
