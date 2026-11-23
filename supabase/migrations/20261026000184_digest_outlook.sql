-- 184 The morning summary email looks a week ahead (TODO 8.14, the occupancy summary, second part; plain counting, no AI).
--
-- Migration 180 added `rooms`, `occupied_tonight` and `occupied_tomorrow` to the summary. This adds one more key to the same payload:
-- `outlook`, the hotel's own today and the six nights after it, as [{date, occupied}], counted exactly as 180 counts: the rooms with an
-- active stay on that night (holds waiting for payment and blocks do not count), out of the `rooms` already in the payload. So
-- outlook[0].occupied is `occupied_tonight` and outlook[1].occupied is `occupied_tomorrow` by construction (the test checks it), and the
-- email can show the whole week without a second definition of "occupied". Counts only: each night carries a date and one number. A summary
-- queued before this migration has no `outlook`; the email then keeps its older shape. Everything else in queue_daily_digests is as in 180.

create or replace function queue_daily_digests() returns integer
language plpgsql security definer set search_path = public as $$
declare p record; v_today date; v_n integer; v_queued integer := 0;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  for p in
    select id, tenant_id, name, digest_email, timezone from properties
     where digest_email is not null and status = 'active'
       and extract(hour from now() at time zone timezone) >= 6
  loop
    v_today := property_today(p.id);
    insert into digest_outbox (tenant_id, property_id, report_date, to_email, payload)
    select p.tenant_id, p.id, v_today, p.digest_email,
           jsonb_build_object(
             'hotel', p.name, 'date', v_today,
             'arrivals', count(*) filter (where reservation_status = 'confirmed' and arrival_date = v_today),
             'departures', count(*) filter (where reservation_status = 'checked_in' and departure_date = v_today),
             'in_house', count(*) filter (where reservation_status = 'checked_in'),
             'tomorrow', count(*) filter (where reservation_status = 'confirmed' and arrival_date = v_today + 1),
             'holds', count(*) filter (where reservation_status = 'pending'),
             'messages', (select count(*) from contact_messages cm where cm.property_id = p.id and cm.status = 'new'),
             'waiting', (select count(*) from waitlist_requests w where w.property_id = p.id and w.status = 'waiting' and w.arrival_date >= v_today),
             'rooms', (select count(*) from rooms r where r.property_id = p.id and r.operational_status = 'active'),
             'occupied_tonight', (select count(distinct k.room_id) from room_inventory_claims k where k.property_id = p.id and k.claim_type = 'stay' and k.status = 'active'
                                     and k.start_date <= v_today and k.end_date > v_today),
             'occupied_tomorrow', (select count(distinct k.room_id) from room_inventory_claims k where k.property_id = p.id and k.claim_type = 'stay' and k.status = 'active'
                                     and k.start_date <= v_today + 1 and k.end_date > v_today + 1),
             'outlook', (select coalesce(jsonb_agg(jsonb_build_object('date', n.night::date,
                                  'occupied', (select count(distinct k.room_id) from room_inventory_claims k
                                                where k.property_id = p.id and k.claim_type = 'stay' and k.status = 'active'
                                                  and k.start_date <= n.night::date and k.end_date > n.night::date)) order by n.night), '[]'::jsonb)
                           from generate_series(v_today::timestamp, (v_today + 6)::timestamp, interval '1 day') as n(night)))
      from reservations where property_id = p.id
    on conflict (property_id, report_date) do nothing;
    get diagnostics v_n = row_count;
    v_queued := v_queued + v_n;
  end loop;
  return v_queued;
end $$;
revoke all on function queue_daily_digests() from public, anon, authenticated;
grant execute on function queue_daily_digests() to service_role;
