-- 046 No-show list.
--
-- no_show_list(property, from, to): the bookings marked as no-shows (reservations.no_show_at set, see 037) whose ARRIVAL date is in
-- the range, newest arrival first, at most 200 rows. `total` is the real count, so the page can say when the list is cut.
--   per row   arrival_date, nights, source, charge_minor (the charge the cancellation rules put on it; 0 when waived or free)
--             and, only where the caller may see them: reservation_id and booking_reference (reservation.view),
--             guest_name (guest.view). Without the permission the field is null and the flag `links_hidden` / `names_hidden` is true.
-- Needs report.view. Anyone without it, and another hotel's people, get NOT_FOUND. Range of 1 to 92 days.
-- Errors: NOT_FOUND, POLICY_VIOLATION: range.
-- Reads only; the counts match channel_report and occupancy_report (045) because all three key on no_show_at.

create function no_show_list(p_property_id uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_names boolean; v_links boolean; v_total int; v_rows jsonb;
begin
  if p_property_id is null or not has_permission(p_property_id, 'report.view') then
    raise exception 'NOT_FOUND' using errcode = 'P0001';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 91 then
    raise exception 'POLICY_VIOLATION: range' using errcode = 'P0001';
  end if;
  v_names := has_permission(p_property_id, 'guest.view');
  v_links := has_permission(p_property_id, 'reservation.view');

  select count(*) into v_total
    from reservations
   where property_id = p_property_id and no_show_at is not null and arrival_date between p_from and p_to;

  select coalesce(jsonb_agg(jsonb_build_object(
           'reservation_id', case when v_links then r.id end,
           'booking_reference', case when v_links then r.booking_reference end,
           'arrival_date', r.arrival_date,
           'nights', r.departure_date - r.arrival_date,
           'source', r.source,
           'guest_name', case when v_names then g.full_name end,
           'charge_minor', r.cancellation_charge_minor
         ) order by r.arrival_date desc, r.no_show_at desc, r.id), '[]'::jsonb)
    into v_rows
    from (select * from reservations
           where property_id = p_property_id and no_show_at is not null and arrival_date between p_from and p_to
           order by arrival_date desc, no_show_at desc, id limit 200) r
    left join guests g on g.id = r.primary_guest_id;

  return jsonb_build_object('property_id', p_property_id, 'currency', (select currency from properties where id = p_property_id),
                            'from', p_from, 'to', p_to, 'total', v_total, 'rows', v_rows,
                            'names_hidden', not v_names, 'links_hidden', not v_links);
end $$;

revoke all on function no_show_list(uuid, date, date) from public, anon;
grant execute on function no_show_list(uuid, date, date) to authenticated;
