-- 040 Occupancy report.
--
-- occupancy_report(property, from, to) gives, for each day of a property (the hotel's own days):
--   rooms_total       rooms in service that day: operational_status 'active' now, and already created by that day
--   rooms_blocked     of those, rooms under an active block (maintenance, owner hold) that night
--   rooms_available   rooms_total minus rooms_blocked, and never less than rooms_sold (a room taken out of service later
--                     may still have had a guest on a past night, and occupancy must not pass 100 percent)
--   rooms_sold        room nights of bookings that are confirmed, checked in or checked out (the same bookings the daily
--                     report counts as earned). Pending holds, cancelled, expired and no_show bookings are not sold.
--   room_revenue_minor  what those nights are worth before tax
--   arrivals, departures  rooms of those bookings arriving or leaving that day
--   no_shows          bookings marked no_show whose arrival date is that day
-- Occupancy, ADR (room revenue per sold night) and RevPAR (room revenue per available night) are worked out by the page from
-- these counts, so the totals row divides the range totals instead of averaging daily percentages.
--
-- Limit: the room list has no history. A room retired or put out of service later is not counted for earlier days, and a
-- room's type or number at the time is not kept. Reading needs report.view (owner and accountant); anyone else, and another
-- hotel's people, get NOT_FOUND. A range is at most 92 days.
--
-- Errors: NOT_FOUND, POLICY_VIOLATION: range.

create function occupancy_report(p_property_id uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_tz text; v_days jsonb; v_totals jsonb;
begin
  if p_property_id is null or not has_permission(p_property_id, 'report.view') then
    raise exception 'NOT_FOUND' using errcode = 'P0001';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 91 then
    raise exception 'POLICY_VIOLATION: range' using errcode = 'P0001';
  end if;
  select timezone into v_tz from properties where id = p_property_id;

  with d as (select g::date as day from generate_series(p_from, p_to, interval '1 day') g),
  tot as (
    select d.day, count(r.id) as total
      from d left join rooms r on r.property_id = p_property_id and r.operational_status = 'active'
                              and (r.created_at at time zone v_tz)::date <= d.day
     group by d.day
  ),
  blk as (
    select d.day, count(distinct c.room_id) as blocked
      from d join room_inventory_claims c on c.property_id = p_property_id and c.claim_type = 'block' and c.status = 'active'
                                         and c.start_date <= d.day and c.end_date > d.day
             join rooms r on r.id = c.room_id and r.operational_status = 'active' and (r.created_at at time zone v_tz)::date <= d.day
     group by d.day
  ),
  sold as (
    select n.night_date as day, count(*) as sold, sum(n.rate_minor) as revenue
      from reservation_nights n
      join reservation_rooms rr on rr.id = n.reservation_room_id and rr.room_status <> 'cancelled'
      join reservations r on r.id = rr.reservation_id
     where r.property_id = p_property_id and r.reservation_status in ('confirmed', 'checked_in', 'checked_out')
       and n.night_date between p_from and p_to
     group by 1
  ),
  arr as (
    select r.arrival_date as day, count(*) as arrivals
      from reservation_rooms rr join reservations r on r.id = rr.reservation_id
     where r.property_id = p_property_id and r.reservation_status in ('confirmed', 'checked_in', 'checked_out')
       and rr.room_status <> 'cancelled' and r.arrival_date between p_from and p_to
     group by 1
  ),
  dep as (
    select r.departure_date as day, count(*) as departures
      from reservation_rooms rr join reservations r on r.id = rr.reservation_id
     where r.property_id = p_property_id and r.reservation_status in ('confirmed', 'checked_in', 'checked_out')
       and rr.room_status <> 'cancelled' and r.departure_date between p_from and p_to
     group by 1
  ),
  ns as (
    select arrival_date as day, count(*) as no_shows
      from reservations where property_id = p_property_id and reservation_status = 'no_show' and arrival_date between p_from and p_to
     group by 1
  ),
  rows_ as (
    select d.day, t.total as rooms_total, coalesce(b.blocked, 0) as rooms_blocked,
           greatest(t.total - coalesce(b.blocked, 0), coalesce(s.sold, 0)) as rooms_available,
           coalesce(s.sold, 0) as rooms_sold, coalesce(s.revenue, 0) as revenue,
           coalesce(a.arrivals, 0) as arrivals, coalesce(p.departures, 0) as departures, coalesce(x.no_shows, 0) as no_shows
      from d join tot t on t.day = d.day
      left join blk b on b.day = d.day left join sold s on s.day = d.day
      left join arr a on a.day = d.day left join dep p on p.day = d.day left join ns x on x.day = d.day
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'date', day, 'rooms_total', rooms_total, 'rooms_blocked', rooms_blocked, 'rooms_available', rooms_available,
           'rooms_sold', rooms_sold, 'room_revenue_minor', revenue, 'arrivals', arrivals, 'departures', departures,
           'no_shows', no_shows) order by day), '[]'::jsonb),
         jsonb_build_object(
           'rooms_total', coalesce(sum(rooms_total), 0), 'rooms_blocked', coalesce(sum(rooms_blocked), 0),
           'rooms_available', coalesce(sum(rooms_available), 0), 'rooms_sold', coalesce(sum(rooms_sold), 0),
           'room_revenue_minor', coalesce(sum(revenue), 0), 'arrivals', coalesce(sum(arrivals), 0),
           'departures', coalesce(sum(departures), 0), 'no_shows', coalesce(sum(no_shows), 0))
    into v_days, v_totals
    from rows_;

  return jsonb_build_object('property_id', p_property_id, 'currency', (select currency from properties where id = p_property_id),
                            'timezone', v_tz, 'from', p_from, 'to', p_to, 'days', v_days, 'totals', v_totals);
end $$;

revoke all on function occupancy_report(uuid, date, date) from public, anon;
grant execute on function occupancy_report(uuid, date, date) to authenticated;
