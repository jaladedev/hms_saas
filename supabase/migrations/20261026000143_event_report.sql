-- 143 Events, part 4: the events report. One function, event_report(property, from, to), for people with report.view and event.view
-- (anyone else, or another hotel, gets NOT_FOUND). 1 to 366 days. Dates are the hotel's local dates.
--
-- Venue hire counts the bookings that START in the range (ticketed-event slots are left out; they show under tickets):
--   by_status          how many bookings are in each status
--   booked             confirmed and completed bookings: subtotal, service charge, tax, total, what has been received (payments less refunds), and
--                      what is still owed (total less received, never below 0)
--   venues             the same per venue, with the hours booked
-- Tickets count the events that START in the range (not drafts):
--   events             per event: status, tickets on sale, tickets sold (not void), checked in, revenue (payments less refunds on its orders) and
--                      refund_due (for a cancelled event, what its orders have taken and not given back)
-- Money is kobo. Revenue here is cash-style (what was received), so a ticket sale counts when paid, and a venue booking shows both its value
-- (booked.total) and what has come in.

create function event_report(p_property uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_by_status jsonb; v_booked jsonb; v_venues jsonb; v_events jsonb;
begin
  perform require_permission(p_property, 'report.view', 'NOT_FOUND');
  perform require_permission(p_property, 'event.view', 'NOT_FOUND');
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 365 then raise exception 'POLICY_VIOLATION: dates' using errcode = 'P0001'; end if;

  select coalesce(jsonb_object_agg(s.status, s.n), '{}'::jsonb) into v_by_status
    from (select status, count(*) n from venue_bookings
           where property_id = p_property and source <> 'ticketed_event' and starts_at >= p_from::timestamp and starts_at < (p_to + 1)::timestamp
           group by status) s;

  with b as (
    select vb.*, venue_booking_paid(vb.id) as paid
      from venue_bookings vb
     where vb.property_id = p_property and vb.source <> 'ticketed_event' and vb.status in ('confirmed', 'completed')
       and vb.starts_at >= p_from::timestamp and vb.starts_at < (p_to + 1)::timestamp)
  select jsonb_build_object('bookings', count(*), 'subtotal_minor', coalesce(sum(subtotal_minor), 0), 'service_minor', coalesce(sum(service_minor), 0),
                            'tax_minor', coalesce(sum(tax_minor), 0), 'total_minor', coalesce(sum(total_minor), 0),
                            'received_minor', coalesce(sum(paid), 0), 'outstanding_minor', coalesce(sum(greatest(total_minor - paid, 0)), 0))
    into v_booked from b;

  select coalesce(jsonb_agg(jsonb_build_object('venue_id', x.id, 'name', x.name, 'bookings', x.bookings, 'hours', x.hours, 'total_minor', x.total_minor,
                                               'received_minor', x.received_minor) order by x.name), '[]'::jsonb) into v_venues
    from (select v.id, v.name, count(b.id) as bookings,
                 coalesce(sum(ceil(extract(epoch from (b.ends_at - b.starts_at)) / 3600.0)), 0)::integer as hours,
                 coalesce(sum(b.total_minor), 0) as total_minor, coalesce(sum(venue_booking_paid(b.id)), 0) as received_minor
            from hotel_venues v
            left join venue_bookings b on b.venue_id = v.id and b.source <> 'ticketed_event' and b.status in ('confirmed', 'completed')
                                      and b.starts_at >= p_from::timestamp and b.starts_at < (p_to + 1)::timestamp
           where v.property_id = p_property group by v.id, v.name) x;

  select coalesce(jsonb_agg(jsonb_build_object(
           'event_id', e.id, 'title', e.title, 'status', e.status, 'starts_at', e.starts_at,
           'capacity', (select coalesce(sum(quantity_total), 0) from event_ticket_types where event_id = e.id and is_active),
           'sold', (select count(*) from tickets where event_id = e.id and status <> 'void'),
           'checked_in', (select count(*) from tickets where event_id = e.id and status = 'used'),
           'revenue_minor', (select coalesce(sum(ticket_order_paid(o.id)), 0) from ticket_orders o where o.event_id = e.id),
           'refund_due_minor', case when e.status = 'cancelled'
                                    then (select coalesce(sum(greatest(ticket_order_paid(o.id), 0)), 0) from ticket_orders o where o.event_id = e.id) else 0 end)
         order by e.starts_at), '[]'::jsonb) into v_events
    from hotel_events e
   where e.property_id = p_property and e.status <> 'draft' and e.starts_at >= p_from::timestamp and e.starts_at < (p_to + 1)::timestamp;

  return jsonb_build_object('from', p_from, 'to', p_to, 'by_status', v_by_status, 'booked', v_booked, 'venues', v_venues, 'events', v_events);
end $$;
revoke all on function event_report(uuid, date, date) from public, anon;
grant execute on function event_report(uuid, date, date) to authenticated;
