-- 8.6 fourth cut: apply a modification from a channel.
-- Until now a "modify" event only moved the booking to attention. Now the new dates the channel sent (arrival, departure, optional total) are kept
-- in channel_bookings.proposed, and a person with channels.manage AND reservation.modify can apply them from /app/channels (channel_modify_apply).
-- Applying runs the ordinary staff stay change (update_reservation_stay, migration 70), so every rule of it holds: only a confirmed booking not yet
-- checked in, rooms free for the new dates (otherwise ROOM_UNAVAILABLE and nothing changes), no discount, no payment in flight, a live invoice is
-- replaced and the money state worked out again. The hotel's own rate applies to the new nights; the channel's new total is only kept for the
-- price-difference list. A later modify replaces a waiting proposal. Guests and rooms are never changed from a channel event.

alter table channel_bookings add column proposed jsonb;

create or replace function channel_receive(p_connection uuid, p_event text, p_external text, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c channel_connections%rowtype; b channel_bookings%rowtype; v_ext text := btrim(coalesce(p_external, '')); v_p jsonb := coalesce(p_payload, '{}'::jsonb);
  v_arr date; v_dep date; v_total bigint; v_out text; v_rooms jsonb; v_hash text; v_res reservations%rowtype; v_idem record; v_name text; v_proposed jsonb;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select * into c from channel_connections where id = p_connection and status = 'active';
  if not found or not tenant_feature_on(c.tenant_id, 'channel_manager') then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if p_event is null or p_event not in ('booking', 'modify', 'cancel') then raise exception 'POLICY_VIOLATION: event' using errcode = 'P0001'; end if;
  if char_length(v_ext) not between 1 and 80 then raise exception 'POLICY_VIOLATION: id' using errcode = 'P0001'; end if;
  perform pg_advisory_xact_lock(hashtext('channel:' || c.id::text || ':' || v_ext));
  select * into b from channel_bookings where connection_id = c.id and external_id = v_ext;

  if p_event = 'booking' then
    if found then
      if b.status = 'failed' and b.attempts < 5 then
        v_out := channel_import(b.id);
        return jsonb_build_object('status', v_out, 'duplicate', true);
      end if;
      return jsonb_build_object('status', b.status, 'duplicate', true);
    end if;
    begin
      v_arr := (v_p ->> 'arrival')::date; v_dep := (v_p ->> 'departure')::date; v_total := nullif(v_p ->> 'total_minor', '')::bigint;
    exception when others then raise exception 'POLICY_VIOLATION: payload' using errcode = 'P0001'; end;
    if v_arr is null or v_dep is null or v_dep <= v_arr or v_dep - v_arr > 30 or (v_total is not null and v_total < 0) then raise exception 'POLICY_VIOLATION: payload' using errcode = 'P0001'; end if;
    if jsonb_typeof(v_p -> 'rooms') <> 'array' or jsonb_array_length(v_p -> 'rooms') not between 1 and 10 then raise exception 'POLICY_VIOLATION: payload' using errcode = 'P0001'; end if;
    select coalesce(jsonb_agg(jsonb_build_object('external_room_id', left(x ->> 'external_room_id', 80), 'adults', coalesce((x ->> 'adults')::int, 1), 'children', coalesce((x ->> 'children')::int, 0))), '[]'::jsonb)
      into v_rooms from jsonb_array_elements(v_p -> 'rooms') x;
    v_name := left(btrim(coalesce(v_p ->> 'guest_name', '')), 120);
    insert into channel_bookings (tenant_id, property_id, connection_id, external_id, guest_label, arrival_date, departure_date, channel_total_minor, summary)
    values (c.tenant_id, c.property_id, c.id, v_ext, nullif(v_name, ''), v_arr, v_dep, v_total,
            jsonb_build_object('rooms', v_rooms, '_email', left(coalesce(v_p ->> 'email', ''), 254), '_phone', left(coalesce(v_p ->> 'phone', ''), 40)))
    returning * into b;
    v_out := channel_import(b.id);
    return jsonb_build_object('status', v_out, 'duplicate', false);
  end if;

  if p_event = 'modify' then
    -- the new dates the channel wants, kept for a person to apply (channel_modify_apply); anything not usable is just left for hand work
    begin
      v_arr := nullif(v_p ->> 'arrival', '')::date; v_dep := nullif(v_p ->> 'departure', '')::date; v_total := nullif(v_p ->> 'total_minor', '')::bigint;
    exception when others then v_arr := null; v_dep := null; v_total := null; end;
    if v_arr is null or v_dep is null or v_dep <= v_arr or v_dep - v_arr > 30 or (v_total is not null and v_total < 0) then
      v_proposed := null;
    else
      v_proposed := jsonb_build_object('arrival', v_arr, 'departure', v_dep, 'total_minor', v_total, 'received_at', now());
    end if;
    if not found then
      insert into channel_bookings (tenant_id, property_id, connection_id, external_id, status, note) values (c.tenant_id, c.property_id, c.id, v_ext, 'attention', 'Changed at the channel before it was received')
      returning * into b;
    elsif b.status in ('imported', 'received', 'failed') then
      update channel_bookings set status = 'attention', proposed = v_proposed,
             note = case when v_proposed is not null and b.reservation_id is not null then 'Changed at the channel: check the new dates and apply them, or change the booking by hand' else 'Changed at the channel: change the booking by hand' end,
             updated_at = now() where id = b.id returning * into b;
    elsif b.status = 'attention' and b.reservation_id is not null and v_proposed is not null then
      update channel_bookings set proposed = v_proposed, updated_at = now() where id = b.id returning * into b;   -- the latest change wins
    end if;
    perform write_audit(c.tenant_id, c.property_id, null, 'channel_booking.modified', 'channel_booking', b.id, null, jsonb_build_object('external_id', v_ext, 'proposed', v_proposed is not null));
    return jsonb_build_object('status', b.status);
  end if;

  -- cancel
  if not found then
    insert into channel_bookings (tenant_id, property_id, connection_id, external_id, status, note) values (c.tenant_id, c.property_id, c.id, v_ext, 'cancelled', 'Cancelled at the channel before it was received')
    returning * into b;
    return jsonb_build_object('status', 'cancelled');
  end if;
  if b.status = 'cancelled' then return jsonb_build_object('status', 'cancelled', 'duplicate', true); end if;
  if b.reservation_id is null then
    update channel_bookings set status = 'cancelled', updated_at = now() where id = b.id;
    return jsonb_build_object('status', 'cancelled');
  end if;
  select * into v_res from reservations where id = b.reservation_id for update;
  if v_res.reservation_status = 'cancelled' then
    update channel_bookings set status = 'cancelled', updated_at = now() where id = b.id;
    return jsonb_build_object('status', 'cancelled');
  end if;
  begin
    v_hash := md5('channel cancel ' || b.id::text);
    select * into v_idem from idem_begin(v_res.tenant_id, 'cancel_reservation', 'chan-cancel:' || b.id::text, v_hash);
    if v_idem.out_is_new then perform cancel_reservation_apply(v_res.id, 'Cancelled at the channel', null, 'staff', 'chan-cancel:' || b.id::text, null, true); end if;
    update channel_bookings set status = 'cancelled', updated_at = now() where id = b.id;
    perform write_audit(c.tenant_id, c.property_id, null, 'channel_booking.cancelled', 'channel_booking', b.id, null, jsonb_build_object('external_id', v_ext, 'reservation_id', v_res.id));
    return jsonb_build_object('status', 'cancelled');
  exception when sqlstate 'P0001' then
    update channel_bookings set status = 'attention', note = 'Cancelled at the channel, but the booking is already in house or finished', updated_at = now() where id = b.id;
    return jsonb_build_object('status', 'attention');
  end;
end $$;

create function channel_modify_apply(p_id uuid, p_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b channel_bookings%rowtype; v_actor uuid; v_arr date; v_dep date; v_total bigint; v_res jsonb;
begin
  select * into b from channel_bookings where id = p_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := channel_require(b.property_id);
  if p_key is null or char_length(btrim(p_key)) not between 8 and 80 then raise exception 'POLICY_VIOLATION: key' using errcode = 'P0001'; end if;
  select * into b from channel_bookings where id = p_id for update;
  if b.status <> 'attention' or b.proposed is null or b.reservation_id is null then raise exception 'INVALID_STATE: %', b.status using errcode = 'P0001'; end if;
  v_arr := (b.proposed ->> 'arrival')::date; v_dep := (b.proposed ->> 'departure')::date; v_total := nullif(b.proposed ->> 'total_minor', '')::bigint;
  v_res := update_reservation_stay(b.reservation_id, v_arr, v_dep, null, 'Changed at the channel', 'chan-mod:' || b.id || ':' || p_key);
  update channel_bookings set status = 'imported', arrival_date = v_arr, departure_date = v_dep, channel_total_minor = coalesce(v_total, channel_total_minor),
         proposed = null, note = 'Change from the channel applied', updated_at = now() where id = b.id;
  perform write_audit(b.tenant_id, b.property_id, v_actor, 'channel_booking.modification_applied', 'channel_booking', b.id, p_key,
                      jsonb_build_object('arrival', v_arr, 'departure', v_dep, 'reservation_id', b.reservation_id));
  return jsonb_build_object('status', 'imported', 'arrival', v_arr, 'departure', v_dep);
end $$;
revoke all on function channel_modify_apply(uuid, text) from public, anon;
grant execute on function channel_modify_apply(uuid, text) to authenticated;
revoke all on function channel_receive(uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function channel_receive(uuid, text, text, jsonb) to service_role;
