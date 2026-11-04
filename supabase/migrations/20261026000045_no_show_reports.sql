-- 045 No-shows in the reports.
--
-- 037 records a no-show as a cancellation told apart by reservations.no_show_at (status 'cancelled', never 'no_show').
-- 040 (occupancy_report) and 044 (channel_report) counted reservation_status = 'no_show', which nothing sets any more, so
-- both reports showed no no-shows at all, and channel_report counted every no-show under "cancelled" as well.
--
-- From here a no-show is a booking with no_show_at set (the old status value is still counted, in case an old row has it):
--   occupancy_report   no_shows on the arrival day: unchanged shape, now counts real no-shows
--   channel_report     no_shows by source, and `cancelled` is cancellations that are not no-shows, so the two never overlap
-- Same signatures, same grants (create or replace keeps them), same errors. Nothing else changes: sold nights still come
-- from confirmed, checked-in and checked-out bookings, so a no-show still sells nothing.

create or replace function occupancy_report(p_property_id uuid, p_from date, p_to date) returns jsonb
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
      from reservations where property_id = p_property_id and (no_show_at is not null or reservation_status = 'no_show') and arrival_date between p_from and p_to
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

create or replace function channel_report(p_property_id uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_rows jsonb; v_totals jsonb;
begin
  if p_property_id is null or not has_permission(p_property_id, 'report.view') then
    raise exception 'NOT_FOUND' using errcode = 'P0001';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 91 then
    raise exception 'POLICY_VIOLATION: range' using errcode = 'P0001';
  end if;

  with src(source, ord) as (values ('website', 1), ('walk_in', 2), ('phone', 3), ('staff_entry', 4), ('partner', 5)),
  sold as (
    select r.source, count(distinct r.id) as bookings, count(*) as nights, coalesce(sum(n.rate_minor), 0) as revenue
      from reservation_nights n
      join reservation_rooms rr on rr.id = n.reservation_room_id and rr.room_status <> 'cancelled'
      join reservations r on r.id = rr.reservation_id
     where r.property_id = p_property_id and r.reservation_status in ('confirmed', 'checked_in', 'checked_out')
       and n.night_date between p_from and p_to
     group by r.source
  ),
  gone as (
    select source,
           count(*) filter (where reservation_status = 'cancelled' and no_show_at is null) as cancelled,
           count(*) filter (where no_show_at is not null or reservation_status = 'no_show') as no_shows
      from reservations
     where property_id = p_property_id and reservation_status in ('cancelled', 'no_show') and arrival_date between p_from and p_to
     group by source
  ),
  rows_ as (
    select s.source, s.ord, coalesce(a.bookings, 0) as bookings, coalesce(a.nights, 0) as nights, coalesce(a.revenue, 0) as revenue,
           coalesce(g.cancelled, 0) as cancelled, coalesce(g.no_shows, 0) as no_shows
      from src s left join sold a on a.source = s.source left join gone g on g.source = s.source
  )
  select jsonb_agg(jsonb_build_object('source', source, 'bookings', bookings, 'room_nights', nights, 'room_revenue_minor', revenue,
                                      'cancelled', cancelled, 'no_shows', no_shows) order by ord),
         jsonb_build_object('bookings', sum(bookings), 'room_nights', sum(nights), 'room_revenue_minor', sum(revenue),
                            'cancelled', sum(cancelled), 'no_shows', sum(no_shows))
    into v_rows, v_totals
    from rows_;

  return jsonb_build_object('property_id', p_property_id, 'currency', (select currency from properties where id = p_property_id),
                            'from', p_from, 'to', p_to, 'rows', v_rows, 'totals', v_totals);
end $$;
