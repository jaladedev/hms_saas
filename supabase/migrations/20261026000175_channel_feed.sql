-- 175 Channel manager, outbound half (TODO 8.6, second cut). Still vendor-neutral and still nothing that talks to an OTA: the channel (or its
-- manager) PULLS what the hotel can sell, with the same per-connection key it uses to send bookings, from GET /api/channels/feed.
--   channel_feed(connection, from, to)  for each room code mapped on the connection, one row per night from `from` up to but not including `to`:
--     available    rooms of that type that are active and have no live claim on the night (a booking, a block or an unexpired hold)
--     rate_minor   the hotel's own nightly rate on the default rate plan (resolve_rate, so automatic pricing and company rates of 152 are included
--                  in the same way as for a guest on the website); null when no rate resolves, and then available is reported as 0
--   Limits: `from` is not in the past (the hotel's day), at most 90 nights, and the answer is read only. A room type that is not active is left out.
--   Taxes are not added: the channel gets the rate, the hotel's tax rules still apply when the booking is imported.
-- channel_feed_auth is channel_authenticate (171) for this endpoint: the same checks, but it stamps last_feed_at, not last_inbound_at.
-- channel_retry_due: a retry timer for imports that failed (171 left retry to a person). The maintenance job calls it; a failed booking whose
-- connection is still active and whose plan still has the channel manager is tried again after attempts x 15 minutes, up to 5 attempts in all
-- (the first import counts as one). After that it stays 'failed' on the reconciliation screen for a person, as before. Every attempt is
-- audited by channel_import. Service role only.

alter table channel_connections add column last_feed_at timestamptz;
grant select (last_feed_at) on channel_connections to authenticated;

create function channel_feed_auth(p_hash text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c channel_connections%rowtype;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select * into c from channel_connections where key_hash = p_hash and status = 'active';
  if not found then return jsonb_build_object('ok', false); end if;
  if not tenant_feature_on(c.tenant_id, 'channel_manager') then return jsonb_build_object('ok', false); end if;
  update channel_connections set last_feed_at = now() where id = c.id;
  return jsonb_build_object('ok', true, 'connection_id', c.id, 'property_id', c.property_id);
end $$;
revoke all on function channel_feed_auth(text) from public, anon, authenticated;
grant execute on function channel_feed_auth(text) to service_role;

create function channel_feed(p_connection uuid, p_from date, p_to date) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c channel_connections%rowtype; p properties%rowtype; v_plan uuid; m record; v_night date; v_free integer; v_rate bigint; v_days jsonb; v_rooms jsonb := '[]'::jsonb;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select * into c from channel_connections where id = p_connection and status = 'active';
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  select * into p from properties where id = c.property_id;
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > 90 or p_from < property_today(p.id) then
    raise exception 'POLICY_VIOLATION: dates' using errcode = 'P0001';
  end if;
  select id into v_plan from rate_plans where property_id = p.id and is_default and status = 'active';
  for m in
    select cm.external_room_id, t.id as type_id, t.name
      from channel_room_map cm join room_types t on t.id = cm.room_type_id
     where cm.connection_id = c.id and t.status = 'active' and t.property_id = p.id
     order by cm.external_room_id
  loop
    v_days := '[]'::jsonb;
    for v_night in select generate_series(p_from, p_to - 1, interval '1 day')::date loop
      select count(*) into v_free from rooms r
       where r.property_id = p.id and r.room_type_id = m.type_id and r.operational_status = 'active'
         and not exists (
           select 1 from room_inventory_claims k
            where k.room_id = r.id and k.status = 'active'
              and (k.claim_type <> 'hold' or k.hold_expires_at > now())
              and daterange(k.start_date, k.end_date, '[)') @> v_night);
      v_rate := null;
      if v_plan is not null then
        begin
          select amount_minor into v_rate from resolve_rate(p.id, m.type_id, v_plan, v_night);
        exception when sqlstate 'P0001' then v_rate := null;
        end;
      end if;
      v_days := v_days || jsonb_build_object('date', v_night, 'available', case when v_rate is null then 0 else v_free end, 'rate_minor', v_rate);
    end loop;
    v_rooms := v_rooms || jsonb_build_object('external_room_id', m.external_room_id, 'room_type', m.name, 'days', v_days);
  end loop;
  return jsonb_build_object('currency', p.currency, 'from', p_from, 'to', p_to, 'rooms', v_rooms);
end $$;
revoke all on function channel_feed(uuid, date, date) from public, anon, authenticated;
grant execute on function channel_feed(uuid, date, date) to service_role;

create function channel_retry_due(p_limit integer default 20) returns integer
language plpgsql security definer set search_path = public as $$
declare r record; v_done integer := 0;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  for r in
    select b.id
      from channel_bookings b join channel_connections c on c.id = b.connection_id
     where b.status = 'failed' and b.attempts < 5 and c.status = 'active'
       and tenant_feature_on(c.tenant_id, 'channel_manager')
       and b.updated_at <= now() - (b.attempts * interval '15 minutes')
     order by b.updated_at, b.id
     limit greatest(least(coalesce(p_limit, 20), 100), 1)
       for update of b skip locked
  loop
    perform channel_import(r.id);
    v_done := v_done + 1;
  end loop;
  return v_done;
end $$;
revoke all on function channel_retry_due(integer) from public, anon, authenticated;
grant execute on function channel_retry_due(integer) to service_role;
