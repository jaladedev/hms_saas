-- 009 Online booking entry point: resolve_host and create_hold.
--
-- The guest site never sends a tenant or property id. The Next.js server reads the request Host
-- header and passes it here; the tenant and property come from tenant_domains. Both functions are
-- executable by service_role only: anon and authenticated cannot reach them, so a guest cannot
-- call the database directly with a made-up host, and every online hold passes through server
-- code that can rate-limit by IP before it spends inventory.
--
-- create_hold wraps create_reservation (source 'website'), which already creates a pending
-- reservation with a 'hold' claim per room. On top of it, create_hold:
--   * finds or creates the guest (matched by email within the tenant, never modified),
--   * ignores any rate_plan_id from the caller (guests get the property's default plan; there is
--     no public/private flag on rate plans yet),
--   * limits stay length, booking horizon, rooms per hold and active holds per email,
--   * has its own idempotency key, so a retry cannot create a second guest or reservation.
-- A replayed response is returned as stored: the caller must check hold_expires_at, because the
-- hold may have lapsed since the first call.

create index on guests (tenant_id, lower(email));

create function resolve_host(p_host text)
returns table (tenant_id uuid, property_id uuid)
language plpgsql stable security definer set search_path = public as $$
declare
  v_host   text;
  v_tenant uuid;
  v_prop   uuid;
  v_count  integer;
begin
  if p_host is null or length(p_host) > 253 then
    raise exception 'NOT_FOUND: host' using errcode = 'P0001';
  end if;
  v_host := lower(regexp_replace(trim(p_host), ':[0-9]+$', ''));

  select d.tenant_id, d.property_id into v_tenant, v_prop
    from tenant_domains d
    join tenants t on t.id = d.tenant_id and t.status = 'active'
   where d.host = v_host and d.verified_at is not null;
  if v_tenant is null then raise exception 'NOT_FOUND: host' using errcode = 'P0001'; end if;

  if v_prop is null then
    -- A tenant-wide domain resolves only when the tenant has exactly one active property.
    select count(*), min(p.id::text)::uuid into v_count, v_prop
      from properties p where p.tenant_id = v_tenant and p.status = 'active';
    if v_count <> 1 then raise exception 'NOT_FOUND: property' using errcode = 'P0001'; end if;
  elsif not exists (select 1 from properties p where p.id = v_prop and p.status = 'active') then
    raise exception 'NOT_FOUND: property' using errcode = 'P0001';
  end if;

  tenant_id := v_tenant;
  property_id := v_prop;
  return next;
end $$;

create function create_hold(
  p_host            text,
  p_arrival         date,
  p_departure       date,
  p_rooms           jsonb,     -- [{"room_type_id":..., "requested_room_id":null, "adults":2, "children":0}]
  p_guest           jsonb,     -- {"full_name":..., "email":..., "phone":...}
  p_idempotency_key text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  c_max_nights  constant integer := 30;
  c_max_advance constant integer := 365;
  c_max_rooms   constant integer := 5;
  c_max_holds   constant integer := 3;
  v_tenant   uuid;
  v_property uuid;
  v_today    date;
  v_name     text;
  v_email    text;
  v_phone    text;
  v_rooms    jsonb;
  v_hash     text;
  v_idem     record;
  v_guest    uuid;
  v_res      jsonb;
  v_expires  timestamptz;
  v_currency text;
  v_result   jsonb;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;

  select h.tenant_id, h.property_id into v_tenant, v_property from resolve_host(p_host) h;

  -- guest details
  if p_guest is null or jsonb_typeof(p_guest) <> 'object' then
    raise exception 'POLICY_VIOLATION: guest' using errcode = 'P0001';
  end if;
  v_name  := trim(coalesce(p_guest ->> 'full_name', ''));
  v_email := lower(trim(coalesce(p_guest ->> 'email', '')));
  v_phone := nullif(trim(coalesce(p_guest ->> 'phone', '')), '');
  if length(v_name) < 2 or length(v_name) > 120 then
    raise exception 'POLICY_VIOLATION: guest name' using errcode = 'P0001';
  end if;
  if length(v_email) > 254 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'POLICY_VIOLATION: guest email' using errcode = 'P0001';
  end if;
  if v_phone is not null and length(v_phone) > 32 then
    raise exception 'POLICY_VIOLATION: guest phone' using errcode = 'P0001';
  end if;

  -- stay shape
  v_today := property_today(v_property);
  if p_arrival is null or p_departure is null or p_departure <= p_arrival then
    raise exception 'POLICY_VIOLATION: departure must follow arrival' using errcode = 'P0001';
  end if;
  if p_departure - p_arrival > c_max_nights then
    raise exception 'POLICY_VIOLATION: stay too long' using errcode = 'P0001';
  end if;
  if p_arrival > v_today + c_max_advance then
    raise exception 'POLICY_VIOLATION: arrival too far ahead' using errcode = 'P0001';
  end if;
  if p_rooms is null or jsonb_typeof(p_rooms) <> 'array' or jsonb_array_length(p_rooms) not between 1 and c_max_rooms then
    raise exception 'POLICY_VIOLATION: rooms must be 1 to % entries', c_max_rooms using errcode = 'P0001';
  end if;

  -- Keep only the fields a guest may choose. Rate plan selection is staff-only for now.
  begin
    select jsonb_agg(jsonb_build_object(
             'room_type_id',      (e.value ->> 'room_type_id')::uuid,
             'requested_room_id', nullif(e.value ->> 'requested_room_id', '')::uuid,
             'adults',            coalesce((e.value ->> 'adults')::integer, 0),
             'children',          coalesce((e.value ->> 'children')::integer, 0))
           order by e.ordinality)
      into v_rooms
      from jsonb_array_elements(p_rooms) with ordinality e(value, ordinality);
  exception when invalid_text_representation or invalid_parameter_value or datatype_mismatch then
    raise exception 'POLICY_VIOLATION: rooms' using errcode = 'P0001';
  end;
  if v_rooms is null then raise exception 'POLICY_VIOLATION: rooms' using errcode = 'P0001'; end if;

  -- idempotency before any write
  v_hash := md5(concat_ws('|', v_property, p_arrival, p_departure, v_rooms::text, v_name, v_email, coalesce(v_phone, '')));
  select * into v_idem from idem_begin(v_tenant, 'create_hold', p_idempotency_key, v_hash);
  if not v_idem.out_is_new then return v_idem.out_response; end if;

  -- soft cap on live holds per email (concurrent requests from one email can overshoot slightly)
  if (select count(distinct r.id)
        from reservations r
        join guests g on g.id = r.primary_guest_id
        join reservation_rooms rr on rr.reservation_id = r.id
        join room_inventory_claims c on c.reservation_room_id = rr.id
       where r.tenant_id = v_tenant and r.source = 'website' and r.reservation_status = 'pending'
         and lower(g.email) = v_email
         and c.claim_type = 'hold' and c.status = 'active' and c.hold_expires_at > now()) >= c_max_holds then
    raise exception 'POLICY_VIOLATION: too many active holds' using errcode = 'P0001';
  end if;

  select id into v_guest from guests
   where tenant_id = v_tenant and lower(email) = v_email order by created_at limit 1;
  if v_guest is null then
    insert into guests (tenant_id, full_name, email, phone)
    values (v_tenant, v_name, v_email, v_phone) returning id into v_guest;
  end if;

  v_res := create_reservation(v_property, v_guest, 'website', p_arrival, p_departure, v_rooms,
                              'hold:' || p_idempotency_key);

  select min(c.hold_expires_at) into v_expires
    from reservation_rooms rr
    join room_inventory_claims c on c.reservation_room_id = rr.id
   where rr.reservation_id = (v_res ->> 'reservation_id')::uuid
     and c.claim_type = 'hold' and c.status = 'active';
  select currency into v_currency from properties where id = v_property;

  -- Internal ids (claims, physical rooms) stay out of the guest-facing response.
  v_result := jsonb_build_object(
    'reservation_id',    v_res ->> 'reservation_id',
    'booking_reference', v_res ->> 'booking_reference',
    'status',            v_res ->> 'status',
    'hold_expires_at',   v_expires,
    'currency',          v_currency,
    'subtotal_minor',    (v_res ->> 'subtotal_minor')::bigint,
    'tax_minor',         (v_res ->> 'tax_minor')::bigint,
    'total_minor',       (v_res ->> 'total_minor')::bigint,
    'rooms', (select jsonb_agg(jsonb_build_object('reservation_room_id', x ->> 'reservation_room_id',
                                                  'room_type_id', x ->> 'room_type_id'))
                from jsonb_array_elements(v_res -> 'rooms') x));

  perform idem_finish(v_tenant, 'create_hold', p_idempotency_key, v_result);
  perform write_audit(v_tenant, v_property, null, 'hold.created', 'reservation',
                      (v_res ->> 'reservation_id')::uuid, p_idempotency_key,
                      jsonb_build_object('rooms', jsonb_array_length(v_rooms), 'hold_expires_at', v_expires));
  return v_result;
end $$;

revoke all on function resolve_host(text) from public, anon, authenticated;
revoke all on function create_hold(text, date, date, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function resolve_host(text) to service_role;
grant execute on function create_hold(text, date, date, jsonb, jsonb, text) to service_role;
