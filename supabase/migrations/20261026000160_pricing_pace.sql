-- 160 Booking pace: a forecast signal for the pricing rules (TODO 8.5, "later: demand forecast"). No outside data: it compares how many rooms are booked
-- for a future night, now, with how many rooms this hotel usually had booked for a night of the same weekday at the same distance from arrival.
--   usual    for each of the last 90 days that the hotel has history for (at least 28), the rooms booked for that night by the date that is that many
--            days before it, averaged over the nights of the same weekday. A "room" is one room on one night of a booking that is confirmed, checked in or
--            checked out (so net of cancellations and no-shows); "booked by" is the day the booking was made, in the hotel's time zone.
--   pace     (booked now / usual - 1) in percent. ahead at +20 or more, behind at -20 or less, on_pace between. no_history when the hotel has under 28 days of
--            stays, fewer than 3 sample nights for that weekday, or a usual of under 1 room.
-- Limits, stated on the page: a booking that was moved to other dates counts from the day it was first made at its new dates, and a booking cancelled
-- later is not counted at all, so past nights look slightly less booked-early than they were; a hotel under 28 days old gets no signal.
-- New rule kind 'pace' (band from -100 to 300 percent; "20 to 300" fires when 20 percent or more ahead): it adds its percent to a night like the other
-- kinds, and only when pace is known. pricing_rules, save_pricing_rule and pricing_compute_night are otherwise unchanged. Prices of bookings made keep
-- their nightly price as before; the apply job still works from the stored base. pricing_pace is read-only and, like the suggestions, needs
-- rate.view or rate.manage and the dynamic_pricing flag.

alter table pricing_rules drop constraint pricing_rules_kind_check;
alter table pricing_rules add constraint pricing_rules_kind_check check (kind in ('occupancy', 'lead_time', 'weekday', 'event', 'pace'));
alter table pricing_rules add constraint pricing_rules_pace_band_check check (kind <> 'pace' or (band_from between -100 and 300 and band_to between band_from and 300));

-- ---- The pace of a range of nights (internal) --------------------------------------------------------------------------------------------
create function pricing_pace_range(p_property uuid, p_from date, p_days integer, p_today date)
returns table (night date, lead_days integer, booked integer, typical numeric, pace_percent numeric, status text)
language plpgsql stable security definer set search_path = public as $$
declare v_tz text; v_start date;
begin
  select timezone into v_tz from properties where id = p_property;
  select min(n.night_date) into v_start
    from reservation_nights n join reservation_rooms rr on rr.id = n.reservation_room_id join reservations r on r.id = rr.reservation_id
   where rr.property_id = p_property and r.reservation_status in ('confirmed', 'checked_in', 'checked_out') and n.night_date < p_today;
  v_start := greatest(coalesce(v_start, p_today), p_today - 90);

  return query
  with ref as materialized (
    select n.night_date as d, (r.created_at at time zone v_tz)::date as booked_on
      from reservation_nights n join reservation_rooms rr on rr.id = n.reservation_room_id join reservations r on r.id = rr.reservation_id
     where rr.property_id = p_property and r.reservation_status in ('confirmed', 'checked_in', 'checked_out')
       and n.night_date >= v_start and n.night_date < p_today),
  refn as (
    select extract(isodow from g)::integer as dow, count(*)::integer as cnt from generate_series(v_start, p_today - 1, interval '1 day') g group by 1),
  want as (
    select g::date as night, (g::date - p_today) as lead, extract(isodow from g)::integer as dow
      from generate_series(p_from, p_from + (p_days - 1), interval '1 day') g where g::date >= p_today),
  cur as (
    select n.night_date as night, count(*)::integer as booked
      from reservation_nights n join reservation_rooms rr on rr.id = n.reservation_room_id join reservations r on r.id = rr.reservation_id
     where rr.property_id = p_property and r.reservation_status in ('confirmed', 'checked_in', 'checked_out')
       and n.night_date >= p_from and n.night_date <= p_from + (p_days - 1) group by 1),
  calc as (
    select w.night, w.lead, coalesce(c.booked, 0) as booked, rn.cnt as samples,
           (select count(*) from ref where extract(isodow from ref.d)::integer = w.dow and ref.booked_on <= ref.d - w.lead)::numeric / nullif(rn.cnt, 0) as typical
      from want w left join cur c on c.night = w.night left join refn rn on rn.dow = w.dow)
  select k.night, k.lead::integer, k.booked,
         case when p_today - v_start >= 28 and coalesce(k.samples, 0) >= 3 and k.typical >= 1 then round(k.typical, 1) end,
         case when p_today - v_start >= 28 and coalesce(k.samples, 0) >= 3 and k.typical >= 1 then round((k.booked / k.typical - 1) * 100) end,
         case when not (p_today - v_start >= 28 and coalesce(k.samples, 0) >= 3 and k.typical >= 1) then 'no_history'
              when (k.booked / k.typical - 1) * 100 >= 20 then 'ahead'
              when (k.booked / k.typical - 1) * 100 <= -20 then 'behind'
              else 'on_pace' end
    from calc k order by k.night;
end $$;
revoke all on function pricing_pace_range(uuid, date, integer, date) from public, anon, authenticated;

-- ---- The pace, for the staff page ---------------------------------------------------------------------------------------------------------
create function pricing_pace(p_property uuid, p_from date, p_days integer default 21) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_prop properties%rowtype; v_today date;
begin
  select * into v_prop from properties where id = p_property;
  if not found or not (has_permission(p_property, 'rate.view') or has_permission(p_property, 'rate.manage')) then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if not tenant_feature_on(v_prop.tenant_id, 'dynamic_pricing') then raise exception 'POLICY_VIOLATION: dynamic pricing off' using errcode = 'P0001'; end if;
  if p_from is null or p_days is null or p_days < 1 or p_days > 60 then raise exception 'POLICY_VIOLATION: range' using errcode = 'P0001'; end if;
  v_today := (now() at time zone v_prop.timezone)::date;
  return coalesce((select jsonb_agg(jsonb_build_object('night', x.night, 'lead_days', x.lead_days, 'booked', x.booked, 'usual', x.typical, 'pace_percent', x.pace_percent, 'status', x.status) order by x.night)
                     from pricing_pace_range(p_property, p_from, p_days, v_today) x), '[]'::jsonb);
end $$;
revoke all on function pricing_pace(uuid, date, integer) from public, anon;
grant execute on function pricing_pace(uuid, date, integer) to authenticated;

-- ---- The two rule functions, now knowing the pace kind ---------------------------------------------------------------------------------------
create or replace function save_pricing_rule(p_property uuid, p_rule uuid, p_room_type uuid, p_name text, p_kind text, p_from integer, p_to integer,
                                  p_weekdays integer[], p_date_from date, p_date_to date, p_percent numeric, p_active boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_prop properties%rowtype; v_actor uuid; v_id uuid; v_name text := btrim(coalesce(p_name, '')); v_days smallint[];
begin
  select * into v_prop from properties where id = p_property;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(p_property, 'rate.manage', 'NOT_FOUND');
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if not tenant_feature_on(v_prop.tenant_id, 'dynamic_pricing') then raise exception 'POLICY_VIOLATION: dynamic pricing off' using errcode = 'P0001'; end if;

  if char_length(v_name) not between 1 and 60 then raise exception 'POLICY_VIOLATION: name' using errcode = 'P0001'; end if;
  if p_kind is null or p_kind not in ('occupancy', 'lead_time', 'weekday', 'event', 'pace') then raise exception 'POLICY_VIOLATION: kind' using errcode = 'P0001'; end if;
  if p_percent is null or p_percent = 0 or p_percent < -50 or p_percent > 100 or p_percent <> round(p_percent, 2) then
    raise exception 'POLICY_VIOLATION: percent' using errcode = 'P0001';
  end if;
  if p_room_type is not null and not exists (select 1 from room_types where id = p_room_type and property_id = p_property) then
    raise exception 'POLICY_VIOLATION: room type' using errcode = 'P0001';
  end if;
  if p_kind = 'occupancy' and (p_from is null or p_to is null or p_from < 0 or p_to > 100 or p_to < p_from) then raise exception 'POLICY_VIOLATION: band' using errcode = 'P0001'; end if;
  if p_kind = 'lead_time' and (p_from is null or p_to is null or p_from < 0 or p_to > 365 or p_to < p_from) then raise exception 'POLICY_VIOLATION: band' using errcode = 'P0001'; end if;
  if p_kind = 'pace' and (p_from is null or p_to is null or p_from < -100 or p_to > 300 or p_to < p_from) then raise exception 'POLICY_VIOLATION: band' using errcode = 'P0001'; end if;
  if p_kind = 'weekday' then
    select array_agg(distinct d::smallint order by d::smallint) into v_days from unnest(coalesce(p_weekdays, '{}'::integer[])) d;
    if v_days is null or exists (select 1 from unnest(v_days) d where d < 1 or d > 7) then raise exception 'POLICY_VIOLATION: weekdays' using errcode = 'P0001'; end if;
  end if;
  if p_kind = 'event' and (p_date_from is null or p_date_to is null or p_date_to < p_date_from or p_date_to - p_date_from > 365) then
    raise exception 'POLICY_VIOLATION: dates' using errcode = 'P0001';
  end if;

  if p_rule is null then
    if (select count(*) from pricing_rules where property_id = p_property) >= 40 then raise exception 'POLICY_VIOLATION: limit' using errcode = 'P0001'; end if;
    insert into pricing_rules (tenant_id, property_id, room_type_id, name, kind, band_from, band_to, weekdays, date_from, date_to, adjust_percent, is_active)
    values (v_prop.tenant_id, p_property, p_room_type, v_name, p_kind,
            case when p_kind in ('occupancy', 'lead_time', 'pace') then p_from end, case when p_kind in ('occupancy', 'lead_time', 'pace') then p_to end,
            case when p_kind = 'weekday' then v_days end,
            case when p_kind = 'event' then p_date_from end, case when p_kind = 'event' then p_date_to end,
            p_percent, coalesce(p_active, true))
    returning id into v_id;
  else
    update pricing_rules set room_type_id = p_room_type, name = v_name, kind = p_kind,
           band_from = case when p_kind in ('occupancy', 'lead_time', 'pace') then p_from end, band_to = case when p_kind in ('occupancy', 'lead_time', 'pace') then p_to end,
           weekdays = case when p_kind = 'weekday' then v_days end,
           date_from = case when p_kind = 'event' then p_date_from end, date_to = case when p_kind = 'event' then p_date_to end,
           adjust_percent = p_percent, is_active = coalesce(p_active, true)
     where id = p_rule and property_id = p_property
     returning id into v_id;
    if v_id is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  end if;

  perform write_audit(v_prop.tenant_id, p_property, v_actor, 'pricing_rule.saved', 'pricing_rule', v_id, null,
                      jsonb_build_object('name', v_name, 'kind', p_kind, 'percent', p_percent, 'active', coalesce(p_active, true), 'created', p_rule is null));
  return jsonb_build_object('rule_id', v_id);
end $$;
revoke all on function save_pricing_rule(uuid, uuid, uuid, text, text, integer, integer, integer[], date, date, numeric, boolean) from public, anon;
grant execute on function save_pricing_rule(uuid, uuid, uuid, text, text, integer, integer, integer[], date, date, numeric, boolean) to authenticated;

create or replace function pricing_compute_night(p_property uuid, p_room_type uuid, p_night date, p_base bigint, p_today date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_rooms integer; v_busy integer; v_occ numeric; v_lead integer; v_sum numeric; v_names text[]; v_sug bigint; v_limited text; l pricing_limits%rowtype; v_pace numeric;
begin
  select * into l from pricing_limits where room_type_id = p_room_type;
  select count(*)::integer into v_rooms from rooms where room_type_id = p_room_type and operational_status = 'active';
  select count(distinct c.room_id)::integer into v_busy
    from room_inventory_claims c join rooms r on r.id = c.room_id
   where r.room_type_id = p_room_type and r.operational_status = 'active' and c.status = 'active'
     and (c.claim_type <> 'hold' or c.hold_expires_at > now()) and c.start_date <= p_night and c.end_date > p_night;
  v_occ := case when v_rooms > 0 then round(v_busy * 100.0 / v_rooms, 1) end;
  v_lead := p_night - p_today;
  -- the booking pace is only worked out when a pace rule could use it
  if exists (select 1 from pricing_rules r where r.property_id = p_property and r.is_active and r.kind = 'pace' and (r.room_type_id is null or r.room_type_id = p_room_type)) then
    select pc.pace_percent into v_pace from pricing_pace_range(p_property, p_night, 1, p_today) pc;
  end if;

  select coalesce(sum(r.adjust_percent), 0), coalesce(array_agg(r.name order by r.created_at), '{}')
    into v_sum, v_names
    from pricing_rules r
   where r.property_id = p_property and r.is_active and (r.room_type_id is null or r.room_type_id = p_room_type)
     and ((r.kind = 'occupancy' and v_occ is not null and v_occ >= r.band_from and v_occ <= r.band_to)
       or (r.kind = 'lead_time' and v_lead >= r.band_from and v_lead <= r.band_to)
       or (r.kind = 'pace' and v_pace is not null and v_pace >= r.band_from and v_pace <= r.band_to)
       or (r.kind = 'weekday' and extract(isodow from p_night)::smallint = any (r.weekdays))
       or (r.kind = 'event' and p_night between r.date_from and r.date_to));

  v_sug := (round(p_base * (1 + v_sum / 100) / 10000) * 10000)::bigint;      -- nearest 100 naira
  v_limited := null;
  if l.floor_minor is not null and v_sug < l.floor_minor then v_sug := l.floor_minor; v_limited := 'floor'; end if;
  if l.ceiling_minor is not null and v_sug > l.ceiling_minor then v_sug := l.ceiling_minor; v_limited := 'ceiling'; end if;
  if v_sug <= 0 then v_sug := p_base; v_limited := 'floor'; end if;           -- a price is never zero

  return jsonb_build_object('suggested_minor', v_sug, 'change_percent', v_sum, 'occupancy_percent', v_occ, 'lead_days', v_lead, 'pace_percent', v_pace,
                            'rules', to_jsonb(v_names), 'limited', v_limited);
end $$;
revoke all on function pricing_compute_night(uuid, uuid, date, bigint, date) from public, anon, authenticated;
