-- 180 The morning summary email also says how full the hotel is (TODO 8.14, the occupancy summary; plain counts, no AI involved).
-- queue_daily_digests (138) is redefined with three more keys: `rooms` (rooms in service), `occupied_tonight` (rooms with a stay on the hotel's
-- today) and `occupied_tomorrow` (rooms with a stay the night after). Only stays count: holds waiting for payment and blocks do not. Counts only,
-- as before: no names, no money.

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
                                     and k.start_date <= v_today + 1 and k.end_date > v_today + 1))
      from reservations where property_id = p.id
    on conflict (property_id, report_date) do nothing;
    get diagnostics v_n = row_count;
    v_queued := v_queued + v_n;
  end loop;
  return v_queued;
end $$;
revoke all on function queue_daily_digests() from public, anon, authenticated;
grant execute on function queue_daily_digests() to service_role;
