-- 007 audit_logs, idempotency_keys and create_reservation: one transaction, single or multi-room,
-- all-or-nothing. A repeated call with the same idempotency key and the same request returns the
-- stored result; the same key with a different request raises IDEMPOTENCY_MISMATCH. Deadlocks
-- (40P01) are safe to retry because the whole transaction rolls back, key row included.
-- Outbox events arrive in a later migration.

create table audit_logs (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid,            -- null for platform-level events
  property_id   uuid,
  actor_user_id uuid,
  action        text not null,
  entity_type   text not null,
  entity_id     uuid,
  request_id    text,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);
create index on audit_logs (tenant_id, created_at);
create index on audit_logs (entity_type, entity_id);

-- Insert-only: nobody rewrites history through SQL, including the table owner's functions.
create function audit_logs_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'audit_logs is append-only' using errcode = '23514';
end $$;
create trigger audit_logs_no_change before update or delete on audit_logs
  for each row execute function audit_logs_append_only();

alter table audit_logs enable row level security;
create policy audit_logs_select on audit_logs for select to authenticated
  using (property_id is not null and has_permission(property_id, 'audit.view'));
revoke insert, update, delete on audit_logs from authenticated, anon;

create table idempotency_keys (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id),
  operation       text not null,
  idempotency_key text not null check (length(idempotency_key) > 0),
  request_hash    text not null,
  response        jsonb,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null default now() + interval '24 hours',
  unique (tenant_id, operation, idempotency_key)
);
alter table idempotency_keys enable row level security;   -- no policy: functions only
revoke all on idempotency_keys from authenticated, anon;

create function new_booking_reference() returns text language sql volatile as $$
  select 'BK-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))
$$;

-- True for trusted server-side callers: no signed-in user AND either a direct database session
-- (postgres, supabase_admin) or a request whose verified JWT carries the service_role claim.
-- On real Supabase every API call reaches Postgres through PostgREST, where session_user is always
-- 'authenticator' and the key's role arrives as a JWT claim, so session_user alone never matches.
create function is_system_caller() returns boolean language sql stable as $$
  select auth.uid() is null and (
    session_user in ('postgres', 'service_role', 'supabase_admin')
    or coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
                nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role') = 'service_role'
  )
$$;
revoke all on function is_system_caller() from public, anon, authenticated;

create function create_reservation(
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
      insert into reservation_nights (tenant_id, reservation_room_id, night_date, rate_minor, tax_minor, rate_source)
      values (v_tenant, v_rr, v_night, v_rate.amount_minor, v_tax, v_rate.source);
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

revoke all on function create_reservation(uuid, uuid, text, date, date, jsonb, text) from public, anon;
grant execute on function create_reservation(uuid, uuid, text, date, date, jsonb, text) to authenticated;
revoke all on function new_booking_reference() from public, anon, authenticated;
