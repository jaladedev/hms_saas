-- 044 Channel and guest reports.
--
-- channel_report(property, from, to): where bookings came from, one row for each source
-- (website, walk_in, phone, staff_entry, partner, always all five, in that order).
--   bookings        bookings that are confirmed, checked in or checked out and have a night in the range
--   room_nights     their nights inside the range
--   room_revenue_minor  what those nights are worth before tax (the same rule as the occupancy and daily reports)
--   cancelled       cancelled bookings whose ARRIVAL date is in the range (so the cancellation share is cancelled / (cancelled + due))
--   no_shows        no-show bookings whose arrival date is in the range
-- Needs report.view.
--
-- guest_report(property, from, to): who stayed.
--   guests_total    different primary guests with a night in the range (same booking rule as above)
--   guests_new      of those, guests with no confirmed, checked-in or checked-out booking at this property arriving before the range
--   guests_returning  the rest
--   countries       up to 10 countries by guests, with their nights; guests with no country are grouped as 'unknown'
--   top_guests      up to 10 guests by room revenue in the range (name, stays, nights, revenue). Names are personal data, so
--                   this list is empty, and `names_hidden` is true, unless the caller also has guest.view.
-- Needs report.view.
--
-- Both: one currency per property, hotel-local days, a range of at most 92 days. Anyone without report.view, and another hotel's
-- people, get NOT_FOUND. Errors: NOT_FOUND, POLICY_VIOLATION: range.

create function channel_report(p_property_id uuid, p_from date, p_to date) returns jsonb
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
           count(*) filter (where reservation_status = 'cancelled') as cancelled,
           count(*) filter (where reservation_status = 'no_show') as no_shows
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

create function guest_report(p_property_id uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_names boolean; v_out jsonb;
begin
  if p_property_id is null or not has_permission(p_property_id, 'report.view') then
    raise exception 'NOT_FOUND' using errcode = 'P0001';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 91 then
    raise exception 'POLICY_VIOLATION: range' using errcode = 'P0001';
  end if;
  v_names := has_permission(p_property_id, 'guest.view');

  with stays as (
    select r.primary_guest_id as guest_id, count(distinct r.id)::int as stays, count(*)::int as nights, coalesce(sum(n.rate_minor), 0) as revenue
      from reservation_nights n
      join reservation_rooms rr on rr.id = n.reservation_room_id and rr.room_status <> 'cancelled'
      join reservations r on r.id = rr.reservation_id
     where r.property_id = p_property_id and r.reservation_status in ('confirmed', 'checked_in', 'checked_out')
       and n.night_date between p_from and p_to
     group by r.primary_guest_id
  ),
  flagged as (
    select s.*, not exists (
             select 1 from reservations e
              where e.property_id = p_property_id and e.primary_guest_id = s.guest_id
                and e.reservation_status in ('confirmed', 'checked_in', 'checked_out') and e.arrival_date < p_from) as is_new
      from stays s
  ),
  countries as (
    select coalesce(g.country_code, 'unknown') as country, count(*) as guests, sum(f.nights) as nights
      from flagged f join guests g on g.id = f.guest_id
     group by 1 order by 2 desc, 3 desc, 1 limit 10
  ),
  top as (
    select g.id, g.full_name, f.stays, f.nights, f.revenue
      from flagged f join guests g on g.id = f.guest_id
     order by f.revenue desc, g.full_name, g.id limit 10
  )
  select jsonb_build_object(
           'guests_total', (select count(*) from flagged),
           'guests_new', (select count(*) from flagged where is_new),
           'guests_returning', (select count(*) from flagged where not is_new),
           'countries', coalesce((select jsonb_agg(jsonb_build_object('country', country, 'guests', guests, 'room_nights', nights) order by guests desc, nights desc, country) from countries), '[]'::jsonb),
           'top_guests', case when v_names then coalesce((select jsonb_agg(jsonb_build_object('guest_id', id, 'name', full_name, 'stays', stays, 'room_nights', nights, 'room_revenue_minor', revenue)
                                                        order by revenue desc, full_name, id) from top), '[]'::jsonb) else '[]'::jsonb end)
    into v_out;

  return v_out || jsonb_build_object('property_id', p_property_id, 'currency', (select currency from properties where id = p_property_id),
                                     'from', p_from, 'to', p_to, 'names_hidden', not v_names);
end $$;

revoke all on function channel_report(uuid, date, date), guest_report(uuid, date, date) from public, anon;
grant execute on function channel_report(uuid, date, date), guest_report(uuid, date, date) to authenticated;
