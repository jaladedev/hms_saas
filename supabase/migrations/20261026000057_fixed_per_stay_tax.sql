-- 057 A tax or levy that is a fixed amount once per stay (tax_rules.basis = 'fixed_per_stay').
--
-- Until now a fixed tax could only be "per night". A flat levy charged once for the whole stay (a destination fee, a
-- registration charge) had no home. Rules chosen:
--   * Per ROOM, not per reservation: a booking of two rooms pays it twice. It is charged on the first night of each room, so it
--     sits inside that night's tax and every existing total (reservation tax, invoices, refunds, cancellation charges) keeps
--     working without a new line type. Cancelling before the stay refunds it with the first night, as the policy treats that
--     night; a first night that is charged on cancellation charges the levy with it.
--   * The rule in force on the ARRIVAL date decides whether and how much, whatever the later nights' dates.
--   * It does NOT feed a compounding percent rule: a percent that compounds is taken on the running total of the percent and
--     fixed-per-night amounts as before. (Adding the levy to that base would make one night's tax depend on which night it is.)
--   * reservation_nights.stay_tax_minor records how much of a night's tax_minor is the levy, so a date change can move it.
--     update_reservation_stay moves the levy already charged to the new first night at the SAME amount: changing dates never
--     adds a second levy and never drops one, and a rule created after the booking does not reach back to it (nights already
--     sold keep their tax). A rule that is a stay levy cannot be marked for extras (it was never a percent rule).
--   * Existing reservations are untouched (stay_tax_minor defaults to 0 and no existing rule has the new basis).
-- Three functions are replaced with exactly their earlier bodies plus the levy: create_reservation (007), search_availability
-- (014, the guest quote, so a guest is quoted the same total they are charged) and update_reservation_stay (033).

alter table tax_rules drop constraint tax_rules_basis_check;
alter table tax_rules add constraint tax_rules_basis_check check (basis in ('percent', 'fixed_per_night', 'fixed_per_stay'));

alter table reservation_nights add column stay_tax_minor bigint not null default 0;
alter table reservation_nights add constraint reservation_nights_stay_tax_check check (stay_tax_minor >= 0 and stay_tax_minor <= tax_minor);

-- The per-night rules, now explicit about their basis: a fixed-per-stay rule is skipped here (it is not a nightly amount).
create or replace function calc_night_tax(p_property uuid, p_night date, p_rate bigint) returns bigint
language plpgsql stable security definer set search_path = public as $$
declare r record; running numeric := p_rate; total bigint := 0; t bigint;
begin
  for r in
    select * from tax_rules
     where property_id = p_property and status = 'active' and basis in ('percent', 'fixed_per_night')
       and effective_from <= p_night and (effective_to is null or effective_to >= p_night)
     order by sequence, id
  loop
    if r.basis = 'percent' then
      t := round((case when r.compounds then running else p_rate end) * r.rate_value / 100)::bigint;
    else
      t := round(r.rate_value)::bigint;
    end if;
    running := running + t;
    total := total + t;
  end loop;
  return total;
end $$;

-- The stay levy for one room arriving on p_arrival: every fixed-per-stay rule in force that day, each rounded to a whole kobo.
create function calc_stay_tax(p_property uuid, p_arrival date) returns bigint
language sql stable security definer set search_path = public as $$
  select coalesce(sum(round(rate_value)::bigint), 0)::bigint
    from tax_rules
   where property_id = p_property and status = 'active' and basis = 'fixed_per_stay'
     and effective_from <= p_arrival and (effective_to is null or effective_to >= p_arrival)
$$;
revoke all on function calc_stay_tax(uuid, date) from public, anon, authenticated;

create or replace function create_reservation(
  p_property_id      uuid,
  p_primary_guest_id uuid,
  p_source           text,
  p_arrival          date,
  p_departure        date,
  p_rooms            jsonb,     -- [{"room_type_id":..., "requested_room_id":null, "rate_plan_id":null, "adults":2, "children":0}]
  p_idempotency_key  text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_actor    uuid := auth.uid();
  v_tenant   uuid;
  v_tz       text;
  v_today    date;
  v_policy   jsonb;
  v_online   boolean := (p_source = 'website');
  v_hold_min integer;
  v_res_id   uuid := gen_random_uuid();
  v_ref      text;
  v_item     record;
  v_type     record;
  v_plan     uuid;
  v_rr       uuid;
  v_night    date;
  v_rate     record;
  v_tax      bigint;
  v_stay     bigint;
  v_sub      bigint := 0;
  v_taxsum   bigint := 0;
  v_claim    uuid;
  v_out      jsonb := '[]'::jsonb;
  v_room_id  uuid;
  v_hash     text;
  v_prior    record;
  v_result   jsonb;
begin
  -- 1. who and where
  select tenant_id, timezone into v_tenant, v_tz from properties where id = p_property_id and status = 'active';
  if v_tenant is null then raise exception 'NOT_FOUND: property' using errcode = 'P0001'; end if;
  if v_actor is null then
    if not is_system_caller() then
      raise exception 'FORBIDDEN' using errcode = 'P0001';
    end if;
  elsif not (case when v_online then false else has_permission(p_property_id, 'reservation.create') end) then
    raise exception 'FORBIDDEN' using errcode = 'P0001';
  end if;

  -- 2. dates and input shape
  if p_source not in ('website','walk_in','phone','staff_entry','partner') then
    raise exception 'POLICY_VIOLATION: source' using errcode = 'P0001';
  end if;
  if p_departure <= p_arrival then raise exception 'POLICY_VIOLATION: departure must follow arrival' using errcode = 'P0001'; end if;
  v_today := (now() at time zone v_tz)::date;
  if p_arrival < v_today then raise exception 'POLICY_VIOLATION: arrival in the past' using errcode = 'P0001'; end if;
  if jsonb_typeof(p_rooms) <> 'array' or jsonb_array_length(p_rooms) not between 1 and 10 then
    raise exception 'POLICY_VIOLATION: rooms must be 1 to 10 entries' using errcode = 'P0001';
  end if;
  if not exists (select 1 from guests where id = p_primary_guest_id and tenant_id = v_tenant) then
    raise exception 'NOT_FOUND: guest' using errcode = 'P0001';
  end if;

  if p_idempotency_key is null or length(p_idempotency_key) = 0 then
    raise exception 'POLICY_VIOLATION: idempotency key required' using errcode = 'P0001';
  end if;
  v_hash := md5(concat_ws('|', p_property_id, p_primary_guest_id, p_source, p_arrival, p_departure, p_rooms::text));
  insert into idempotency_keys (tenant_id, operation, idempotency_key, request_hash)
  values (v_tenant, 'create_reservation', p_idempotency_key, v_hash)
  on conflict (tenant_id, operation, idempotency_key) do nothing;
  if not found then
    -- Key exists. A concurrent first call that is still running would have blocked the insert
    -- above until it committed, so the row is complete here.
    select request_hash, response into v_prior from idempotency_keys
     where tenant_id = v_tenant and operation = 'create_reservation' and idempotency_key = p_idempotency_key;
    if v_prior.request_hash <> v_hash then
      raise exception 'IDEMPOTENCY_MISMATCH' using errcode = 'P0001';
    end if;
    return v_prior.response;
  end if;

  -- Serialise bookings that compete for the same room types, taking locks in sorted order so
  -- two multi-room requests can never wait on each other. The exclusion constraint on claims
  -- stays the final referee (blocks and transfers rely on it directly); the locks only keep
  -- concurrent bookings from deadlocking while they pick rooms.
  perform lock_room_types(p_property_id,
    array(select distinct (e ->> 'room_type_id')::uuid from jsonb_array_elements(p_rooms) e));

  v_policy := current_policy(p_property_id, v_today);
  v_hold_min := coalesce((v_policy ->> 'hold_minutes')::integer, 20);

  -- 3. reservation shell; totals are filled in once every room is priced and claimed
  loop
    v_ref := new_booking_reference();
    exit when not exists (select 1 from reservations where tenant_id = v_tenant and booking_reference = v_ref);
  end loop;
  insert into reservations (id, tenant_id, property_id, booking_reference, primary_guest_id, source,
                            reservation_status, arrival_date, departure_date, policy_snapshot, created_by)
  values (v_res_id, v_tenant, p_property_id, v_ref, p_primary_guest_id, p_source,
          case when v_online then 'pending' else 'confirmed' end,
          p_arrival, p_departure, v_policy, v_actor);

  -- 4. each room, in a fixed order so concurrent multi-room requests contend consistently
  for v_item in
    select (e ->> 'room_type_id')::uuid as room_type_id,
           nullif(e ->> 'requested_room_id', '')::uuid as requested_room_id,
           nullif(e ->> 'rate_plan_id', '')::uuid as rate_plan_id,
           coalesce((e ->> 'adults')::int, 0) as adults,
           coalesce((e ->> 'children')::int, 0) as children
      from jsonb_array_elements(p_rooms) e
     order by 1, 2 nulls last
  loop
    select * into v_type from room_types
     where id = v_item.room_type_id and property_id = p_property_id and status = 'active';
    if not found then raise exception 'NOT_FOUND: room type' using errcode = 'P0001'; end if;
    if v_item.adults < 1 or v_item.adults > v_type.max_adults or v_item.children > v_type.max_children
       or v_item.adults + v_item.children > v_type.max_occupancy then
      raise exception 'CAPACITY_EXCEEDED' using errcode = 'P0001';
    end if;
    if v_item.requested_room_id is not null and not exists (
         select 1 from rooms where id = v_item.requested_room_id and property_id = p_property_id
            and room_type_id = v_item.room_type_id) then
      raise exception 'NOT_FOUND: requested room' using errcode = 'P0001';
    end if;

    v_plan := coalesce(v_item.rate_plan_id,
                       (select id from rate_plans where property_id = p_property_id and is_default and status = 'active'));
    if v_plan is null or not exists (select 1 from rate_plans where id = v_plan and property_id = p_property_id and status = 'active') then
      raise exception 'RATE_MISSING: no rate plan' using errcode = 'P0001';
    end if;

    v_rr := gen_random_uuid();
    insert into reservation_rooms (id, tenant_id, property_id, reservation_id, room_type_id,
                                   requested_room_id, rate_plan_id, adults, children)
    values (v_rr, v_tenant, p_property_id, v_res_id, v_item.room_type_id,
            v_item.requested_room_id, v_plan, v_item.adults, v_item.children);

    for v_night in select generate_series(p_arrival, p_departure - 1, interval '1 day')::date loop
      select * into v_rate from resolve_rate(p_property_id, v_item.room_type_id, v_plan, v_night);
      v_tax := calc_night_tax(p_property_id, v_night, v_rate.amount_minor);
      v_stay := case when v_night = p_arrival then calc_stay_tax(p_property_id, p_arrival) else 0 end;   -- 057: once per room, on night 1
      v_tax := v_tax + v_stay;
      insert into reservation_nights (tenant_id, reservation_room_id, night_date, rate_minor, tax_minor, stay_tax_minor, rate_source)
      values (v_tenant, v_rr, v_night, v_rate.amount_minor, v_tax, v_stay, v_rate.source);
      v_sub := v_sub + v_rate.amount_minor;
      v_taxsum := v_taxsum + v_tax;
    end loop;

    v_claim := claim_room(p_property_id, v_item.room_type_id, v_item.requested_room_id,
                          p_arrival, p_departure,
                          case when v_online then 'hold' else 'stay' end, v_rr,
                          case when v_online then now() + make_interval(mins => v_hold_min) end,
                          null, v_actor);
    select room_id into v_room_id from room_inventory_claims where id = v_claim;
    v_out := v_out || jsonb_build_object('reservation_room_id', v_rr, 'room_type_id', v_item.room_type_id,
                                         'claim_id', v_claim, 'room_id', v_room_id);
  end loop;

  -- 5. totals
  update reservations set subtotal_minor = v_sub, tax_minor = v_taxsum, total_minor = v_sub + v_taxsum
   where id = v_res_id;

  v_result := jsonb_build_object('reservation_id', v_res_id, 'booking_reference', v_ref,
                            'status', case when v_online then 'pending' else 'confirmed' end,
                            'subtotal_minor', v_sub, 'tax_minor', v_taxsum, 'total_minor', v_sub + v_taxsum,
                            'rooms', v_out);

  update idempotency_keys set response = v_result
   where tenant_id = v_tenant and operation = 'create_reservation' and idempotency_key = p_idempotency_key;
  insert into audit_logs (tenant_id, property_id, actor_user_id, action, entity_type, entity_id, request_id, metadata)
  values (v_tenant, p_property_id, v_actor, 'reservation.created', 'reservation', v_res_id, p_idempotency_key,
          jsonb_build_object('booking_reference', v_ref, 'source', p_source, 'rooms', jsonb_array_length(p_rooms),
                             'total_minor', v_sub + v_taxsum));
  return v_result;
end $$;

create or replace function search_availability(p_host text, p_arrival date, p_departure date, p_adults integer, p_children integer default 0)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  c_max_nights  constant integer := 30;
  c_max_advance constant integer := 365;
  v_tenant uuid; v_property uuid; v_today date; v_prop record; v_plan uuid;
  t record; v_free integer; v_night date; v_rate bigint; v_tax bigint; v_sub bigint; v_taxsum bigint;
  v_nights jsonb; v_ok boolean; v_types jsonb := '[]'::jsonb;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select h.tenant_id, h.property_id into v_tenant, v_property from resolve_host(p_host) h;
  v_today := property_today(v_property);

  if p_arrival is null or p_departure is null or p_departure <= p_arrival then
    raise exception 'POLICY_VIOLATION: departure must follow arrival' using errcode = 'P0001';
  end if;
  if p_arrival < v_today then raise exception 'POLICY_VIOLATION: arrival in the past' using errcode = 'P0001'; end if;
  if p_departure - p_arrival > c_max_nights then raise exception 'POLICY_VIOLATION: stay too long' using errcode = 'P0001'; end if;
  if p_arrival > v_today + c_max_advance then raise exception 'POLICY_VIOLATION: arrival too far ahead' using errcode = 'P0001'; end if;
  if p_adults is null or p_adults < 1 or p_adults > 20 or p_children is null or p_children < 0 or p_children > 20 then
    raise exception 'POLICY_VIOLATION: party size' using errcode = 'P0001';
  end if;

  select name, currency, check_in_time, check_out_time, timezone into v_prop from properties where id = v_property;
  select id into v_plan from rate_plans where property_id = v_property and is_default and status = 'active';

  for t in
    select * from room_types rt
     where rt.property_id = v_property and rt.is_public and rt.status = 'active'
       and p_adults <= rt.max_adults and p_children <= rt.max_children and p_adults + p_children <= rt.max_occupancy
     order by rt.base_rate_minor, rt.name
  loop
    select count(*) into v_free from rooms r
     where r.property_id = v_property and r.room_type_id = t.id and r.operational_status = 'active'
       and not exists (
         select 1 from room_inventory_claims c
          where c.room_id = r.id and c.status = 'active'
            and (c.claim_type <> 'hold' or c.hold_expires_at > now())
            and daterange(c.start_date, c.end_date, '[)') && daterange(p_arrival, p_departure, '[)'));
    continue when v_free = 0 or v_plan is null;

    v_sub := 0; v_taxsum := 0; v_nights := '[]'::jsonb; v_ok := true;
    for v_night in select generate_series(p_arrival, p_departure - 1, interval '1 day')::date loop
      begin
        select amount_minor into v_rate from resolve_rate(v_property, t.id, v_plan, v_night);
      exception when sqlstate 'P0001' then
        v_ok := false; exit;
      end;
      v_tax := calc_night_tax(v_property, v_night, v_rate) + case when v_night = p_arrival then calc_stay_tax(v_property, p_arrival) else 0 end;   -- 057
      v_sub := v_sub + v_rate; v_taxsum := v_taxsum + v_tax;
      v_nights := v_nights || jsonb_build_object('date', v_night, 'rate_minor', v_rate);
    end loop;
    continue when not v_ok;

    v_types := v_types || jsonb_build_object(
      'room_type_id', t.id, 'name', t.name, 'description', t.description, 'bed_config', t.bed_config,
      'max_adults', t.max_adults, 'max_children', t.max_children, 'max_occupancy', t.max_occupancy,
      'rooms_available', v_free, 'nights', v_nights,
      'subtotal_minor', v_sub, 'tax_minor', v_taxsum, 'total_minor', v_sub + v_taxsum);
  end loop;

  return jsonb_build_object(
    'property_name', v_prop.name, 'currency', v_prop.currency, 'timezone', v_prop.timezone,
    'check_in_time', v_prop.check_in_time, 'check_out_time', v_prop.check_out_time,
    'arrival_date', p_arrival, 'departure_date', p_departure, 'nights', p_departure - p_arrival,
    'adults', p_adults, 'children', p_children, 'room_types', v_types);
end $$;

create or replace function update_reservation_stay(
  p_reservation_id  uuid,
  p_arrival         date,
  p_departure       date,
  p_guests          jsonb,      -- [{"reservation_room_id": ..., "adults": 2, "children": 0}]; rooms left out keep their numbers
  p_reason          text,
  p_idempotency_key text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r reservations%rowtype; rr reservation_rooms%rowtype; v_type room_types%rowtype;
  v_actor uuid; v_idem record; v_hash text; v_today date; v_reason text := nullif(btrim(p_reason), '');
  v_guests jsonb := coalesce(p_guests, '[]'::jsonb);
  e jsonb; v_rr uuid; v_adults integer; v_children integer; v_seen uuid[] := '{}';
  v_dates_changed boolean; v_guests_changed boolean := false;
  v_keep uuid; v_claim uuid; v_room uuid; v_night date; v_rate record; v_n integer;
  v_old_arr date; v_old_dep date; v_old_total bigint; v_levy bigint;
  v_sub bigint; v_tax bigint; v_out jsonb := '[]'::jsonb; v_result jsonb; v_moved boolean; v_moves integer := 0;
begin
  select * into r from reservations where id = p_reservation_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(r.property_id, 'reservation.modify', 'NOT_FOUND');

  -- input shape (the checks that need no lock)
  if v_reason is null or length(v_reason) > 200 then raise exception 'POLICY_VIOLATION: reason' using errcode = 'P0001'; end if;
  if p_arrival is null or p_departure is null or p_departure <= p_arrival then
    raise exception 'POLICY_VIOLATION: departure must follow arrival' using errcode = 'P0001';
  end if;
  if p_departure - p_arrival > 30 then raise exception 'POLICY_VIOLATION: stay too long' using errcode = 'P0001'; end if;
  if jsonb_typeof(v_guests) <> 'array' or jsonb_array_length(v_guests) > 10 then
    raise exception 'POLICY_VIOLATION: guests' using errcode = 'P0001';
  end if;
  v_today := property_today(r.property_id);
  if p_arrival <> r.arrival_date and p_arrival < v_today then
    raise exception 'POLICY_VIOLATION: arrival in the past' using errcode = 'P0001';
  end if;

  v_hash := md5(concat_ws('|', p_reservation_id, p_arrival, p_departure, v_guests::text, v_reason));
  select * into v_idem from idem_begin(r.tenant_id, 'update_reservation_stay', p_idempotency_key, v_hash);
  if not v_idem.out_is_new then return v_idem.out_response; end if;

  -- 1. the booking row first: this serialises edits, cancellations, payments and invoices on one booking
  select * into r from reservations where id = p_reservation_id for update;
  if r.reservation_status <> 'confirmed' then
    raise exception 'INVALID_STATE: %', r.reservation_status using errcode = 'P0001';
  end if;
  if exists (select 1 from reservation_rooms where reservation_id = r.id and room_status <> 'booked') then
    raise exception 'INVALID_STATE: room' using errcode = 'P0001';
  end if;
  if exists (select 1 from payments where reservation_id = r.id) then raise exception 'INVALID_STATE: money held' using errcode = 'P0001'; end if;
  if exists (select 1 from invoices where reservation_id = r.id and invoice_status <> 'void') then
    raise exception 'INVALID_STATE: invoice' using errcode = 'P0001';
  end if;
  if exists (select 1 from payment_attempts where reservation_id = r.id and status = 'initiated') then
    raise exception 'INVALID_STATE: payment started' using errcode = 'P0001';
  end if;
  if r.discount_minor > 0 then raise exception 'POLICY_VIOLATION: discount' using errcode = 'P0001'; end if;
  v_old_arr := r.arrival_date; v_old_dep := r.departure_date; v_old_total := r.total_minor;

  -- 2. the guest numbers: check every entry before changing anything
  for e in select * from jsonb_array_elements(v_guests) loop
    begin
      v_rr := (e ->> 'reservation_room_id')::uuid;
      v_adults := (e ->> 'adults')::integer;
      v_children := coalesce((e ->> 'children')::integer, 0);
    exception when others then
      raise exception 'POLICY_VIOLATION: guests' using errcode = 'P0001';
    end;
    if v_rr is null or v_adults is null or v_rr = any (v_seen) then raise exception 'POLICY_VIOLATION: guests' using errcode = 'P0001'; end if;
    v_seen := v_seen || v_rr;
    select * into rr from reservation_rooms where id = v_rr and reservation_id = r.id;
    if not found then raise exception 'POLICY_VIOLATION: room' using errcode = 'P0001'; end if;
    select * into v_type from room_types where id = rr.room_type_id;
    if v_adults < 1 or v_children < 0 or v_adults > v_type.max_adults or v_children > v_type.max_children
       or v_adults + v_children > v_type.max_occupancy then
      raise exception 'CAPACITY_EXCEEDED' using errcode = 'P0001';
    end if;
    if v_adults <> rr.adults or v_children <> rr.children then v_guests_changed := true; end if;
  end loop;

  v_dates_changed := (p_arrival <> r.arrival_date or p_departure <> r.departure_date);
  if not v_dates_changed and not v_guests_changed then
    v_result := jsonb_build_object('reservation_id', r.id, 'changed', false, 'arrival_date', r.arrival_date,
                                   'departure_date', r.departure_date, 'total_minor', r.total_minor);
    perform idem_finish(r.tenant_id, 'update_reservation_stay', p_idempotency_key, v_result);
    return v_result;
  end if;

  -- 3. new dates: claims, then nights, then totals
  if v_dates_changed then
    -- the claim rows first, then the room types (the order transfer_room uses)
    perform 1 from room_inventory_claims
     where reservation_room_id in (select id from reservation_rooms where reservation_id = r.id)
       and status = 'active' and claim_type in ('stay', 'hold')
     order by id for update;
    perform lock_room_types(r.property_id, array(select room_type_id from reservation_rooms where reservation_id = r.id));

    for rr in select * from reservation_rooms where reservation_id = r.id order by id loop
      select count(*) into v_n from room_inventory_claims
       where reservation_room_id = rr.id and status = 'active' and claim_type in ('stay', 'hold');
      if v_n <> 1 then raise exception 'INVALID_STATE: split stay' using errcode = 'P0001'; end if;
      select room_id into v_keep from room_inventory_claims
       where reservation_room_id = rr.id and status = 'active' and claim_type in ('stay', 'hold');

      update room_inventory_claims set status = 'released'
       where reservation_room_id = rr.id and status = 'active' and claim_type in ('stay', 'hold');
      v_claim := null;
      begin
        v_claim := claim_room(r.property_id, null, v_keep, p_arrival, p_departure, 'stay', rr.id, null, null, v_actor);
      exception when sqlstate 'P0001' then
        if sqlerrm <> 'ROOM_UNAVAILABLE' then raise; end if;
      end;
      if v_claim is null then
        v_claim := claim_room(r.property_id, rr.room_type_id, null, p_arrival, p_departure, 'stay', rr.id, null, null, v_actor);
      end if;
      select room_id into v_room from room_inventory_claims where id = v_claim;
      v_moved := v_room <> v_keep;
      if v_moved then v_moves := v_moves + 1; end if;

      -- nights already sold keep their price; nights that fall away go; new nights take today's price and tax.
      -- 057: the stay levy (fixed per stay) was charged once on the old first night; it moves with the stay to the new first
      -- night at the same amount, so changing dates never adds a second levy and never drops the one already charged.
      select coalesce(sum(stay_tax_minor), 0) into v_levy from reservation_nights where reservation_room_id = rr.id;
      delete from reservation_nights where reservation_room_id = rr.id and (night_date < p_arrival or night_date >= p_departure);
      for v_night in select generate_series(p_arrival, p_departure - 1, interval '1 day')::date loop
        if not exists (select 1 from reservation_nights where reservation_room_id = rr.id and night_date = v_night) then
          select * into v_rate from resolve_rate(r.property_id, rr.room_type_id, rr.rate_plan_id, v_night);
          insert into reservation_nights (tenant_id, reservation_room_id, night_date, rate_minor, tax_minor, rate_source)
          values (r.tenant_id, rr.id, v_night, v_rate.amount_minor, calc_night_tax(r.property_id, v_night, v_rate.amount_minor), v_rate.source);
        end if;
      end loop;
      update reservation_nights set tax_minor = tax_minor - stay_tax_minor, stay_tax_minor = 0 where reservation_room_id = rr.id and stay_tax_minor > 0;
      if v_levy > 0 then
        update reservation_nights set tax_minor = tax_minor + v_levy, stay_tax_minor = v_levy where reservation_room_id = rr.id and night_date = p_arrival;
      end if;
    end loop;

    select coalesce(sum(n.rate_minor), 0), coalesce(sum(n.tax_minor), 0) into v_sub, v_tax
      from reservation_nights n join reservation_rooms x on x.id = n.reservation_room_id where x.reservation_id = r.id;
    update reservations set arrival_date = p_arrival, departure_date = p_departure,
           subtotal_minor = v_sub, tax_minor = v_tax, total_minor = v_sub + v_tax
     where id = r.id;
  end if;

  -- 4. the guest numbers
  for e in select * from jsonb_array_elements(v_guests) loop
    update reservation_rooms set adults = (e ->> 'adults')::integer, children = coalesce((e ->> 'children')::integer, 0)
     where id = (e ->> 'reservation_room_id')::uuid and reservation_id = r.id;
  end loop;

  select coalesce(jsonb_agg(jsonb_build_object('reservation_room_id', x.id, 'room_id', c.room_id, 'adults', x.adults, 'children', x.children) order by x.id), '[]'::jsonb)
    into v_out
    from reservation_rooms x
    left join room_inventory_claims c on c.reservation_room_id = x.id and c.status = 'active' and c.claim_type in ('stay', 'hold')
   where x.reservation_id = r.id;
  select * into r from reservations where id = r.id;
  v_result := jsonb_build_object('reservation_id', r.id, 'changed', true, 'arrival_date', r.arrival_date, 'departure_date', r.departure_date,
                                 'subtotal_minor', r.subtotal_minor, 'tax_minor', r.tax_minor, 'total_minor', r.total_minor,
                                 'rooms_moved', v_moves, 'rooms', v_out);
  perform idem_finish(r.tenant_id, 'update_reservation_stay', p_idempotency_key, v_result);
  perform write_audit(r.tenant_id, r.property_id, v_actor, 'reservation.stay_changed', 'reservation', r.id, p_idempotency_key,
                      jsonb_build_object('reason', v_reason, 'dates_changed', v_dates_changed, 'guests_changed', v_guests_changed, 'rooms_moved', v_moves,
                                         'from_arrival', v_old_arr, 'from_departure', v_old_dep, 'from_total_minor', v_old_total,
                                         'to_arrival', r.arrival_date, 'to_departure', r.departure_date, 'to_total_minor', r.total_minor));
  return v_result;
end $$;
