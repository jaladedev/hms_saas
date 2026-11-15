-- 131 Promo codes: a hotel's own codes that take a percentage or a fixed amount off a booking a guest makes on the website.
--
-- The hotel's owner (property.configure, as for offers in 102) makes the codes; staff never need one (they have discounts, 058 and 062).
-- Needs the discounts flag on for the hotel group (063): with it off, codes cannot be saved and an entered code is refused.
--
--   promo_codes             one row per code: code (A to Z, 0 to 9, - and _, 3 to 24 characters, stored in capitals, unique per hotel), kind
--                           'percent' (1 to 90, up to two decimals) or 'amount' (a fixed amount in minor units, more than 0), an optional
--                           window of dates the guest may BOOK in (the hotel's today), min_nights (1 to 30), max_uses (null = no limit), is_active.
--                           Staff with property.configure may read; every write goes through the functions (no direct insert, update, delete).
--   reservations.promo_code_id  which code a booking used (null for none).
--   save_promo_code         creates (p_promo null) or edits; edits keep the code text. At most 50 codes a hotel (POLICY_VIOLATION: limit).
--                           POLICY_VIOLATION: code | kind | value | dates | min nights | max uses | discounts off. A duplicate code: POLICY_VIOLATION: duplicate.
--                           Audited as promo_code.saved. NOT_FOUND also for no permission or another hotel.
--   delete_promo_code       removes a code that no booking has used; one that has been used can only be switched off (INVALID_STATE: used).
--                           Audited as promo_code.deleted.
--   promo_code_list         the hotel's codes for the staff page, with `used` (bookings that still count) and `remaining`.
--   promo_apply             internal, called by create_hold only. Locks the code, then checks: active, the hotel's today inside the window, enough
--                           nights, uses left (a booking counts unless it is cancelled, expired or a no-show, so an unpaid hold that lapses gives its use
--                           back), discounts flag on. Any failure is the same POLICY_VIOLATION: promo (a guest cannot tell a wrong code from a used up one).
--                           The discount comes off subtotal + tax like a staff discount (tax lines are not reduced; see the open question in TODO.md) and
--                           is never more than 90% of that, so a booking is never free. It writes the discount fields the same way apply_discount does,
--                           with the reason 'Promo CODE'.
--   create_hold             gets a last optional argument p_promo_code (null = none), replacing the 6 argument version. The code is part of the
--                           idempotency hash. A bad code fails the whole call, so no booking is left behind. The result adds discount_minor and promo_code.
--   guest_booking_status    adds discount_minor and discount_reason, so the booking page can show the discount.
-- A booking with a discount cannot be changed by the guest (dates, room type): the existing rule for discounts, 070 and 083.

create table promo_codes (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  property_id uuid not null,
  code        text not null check (code ~ '^[A-Z0-9_-]{3,24}$'),
  kind        text not null check (kind in ('percent', 'amount')),
  percent     numeric(5, 2) check (percent is null or (percent >= 1 and percent <= 90)),
  amount_minor bigint check (amount_minor is null or amount_minor > 0),
  valid_from  date,
  valid_to    date,
  min_nights  smallint not null default 1 check (min_nights between 1 and 30),
  max_uses    integer check (max_uses is null or max_uses between 1 and 100000),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  foreign key (tenant_id, property_id) references properties (tenant_id, id),
  unique (property_id, code),
  unique (tenant_id, property_id, id),
  check ((kind = 'percent' and percent is not null and amount_minor is null) or (kind = 'amount' and amount_minor is not null and percent is null)),
  check (valid_to is null or valid_from is null or valid_to >= valid_from)
);
alter table promo_codes enable row level security;
create policy promo_codes_select on promo_codes for select to authenticated using (has_permission(property_id, 'property.configure'));
revoke insert, update, delete on promo_codes from authenticated, anon;

alter table reservations add column promo_code_id uuid references promo_codes(id);
create index reservations_promo_idx on reservations (promo_code_id) where promo_code_id is not null;

create function save_promo_code(p_property uuid, p_promo uuid, p_code text, p_kind text, p_value numeric, p_valid_from date, p_valid_to date,
                                p_min_nights integer, p_max_uses integer, p_active boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_prop properties%rowtype; v_actor uuid; v_id uuid; v_code text := upper(btrim(coalesce(p_code, '')));
  v_percent numeric(5, 2); v_amount bigint;
begin
  select * into v_prop from properties where id = p_property;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(p_property, 'property.configure', 'NOT_FOUND');
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;   -- a person, never the system

  if not tenant_feature_on(v_prop.tenant_id, 'discounts') then raise exception 'POLICY_VIOLATION: discounts off' using errcode = 'P0001'; end if;
  if v_code !~ '^[A-Z0-9_-]{3,24}$' then raise exception 'POLICY_VIOLATION: code' using errcode = 'P0001'; end if;
  if p_kind is null or p_kind not in ('percent', 'amount') then raise exception 'POLICY_VIOLATION: kind' using errcode = 'P0001'; end if;
  if p_value is null or p_value <= 0 then raise exception 'POLICY_VIOLATION: value' using errcode = 'P0001'; end if;
  if p_kind = 'percent' then
    if p_value < 1 or p_value > 90 or p_value <> round(p_value, 2) then raise exception 'POLICY_VIOLATION: value' using errcode = 'P0001'; end if;
    v_percent := p_value;
  else
    if p_value <> trunc(p_value) or p_value > 100000000000 then raise exception 'POLICY_VIOLATION: value' using errcode = 'P0001'; end if;
    v_amount := p_value::bigint;
  end if;
  if p_valid_from is not null and p_valid_to is not null and p_valid_to < p_valid_from then raise exception 'POLICY_VIOLATION: dates' using errcode = 'P0001'; end if;
  if p_min_nights is null or p_min_nights < 1 or p_min_nights > 30 then raise exception 'POLICY_VIOLATION: min nights' using errcode = 'P0001'; end if;
  if p_max_uses is not null and (p_max_uses < 1 or p_max_uses > 100000) then raise exception 'POLICY_VIOLATION: max uses' using errcode = 'P0001'; end if;

  if p_promo is null then
    if (select count(*) from promo_codes where property_id = p_property) >= 50 then raise exception 'POLICY_VIOLATION: limit' using errcode = 'P0001'; end if;
    if exists (select 1 from promo_codes where property_id = p_property and code = v_code) then raise exception 'POLICY_VIOLATION: duplicate' using errcode = 'P0001'; end if;
    insert into promo_codes (tenant_id, property_id, code, kind, percent, amount_minor, valid_from, valid_to, min_nights, max_uses, is_active)
    values (v_prop.tenant_id, p_property, v_code, p_kind, v_percent, v_amount, p_valid_from, p_valid_to, p_min_nights, p_max_uses, coalesce(p_active, true))
    returning id into v_id;
  else
    update promo_codes set kind = p_kind, percent = v_percent, amount_minor = v_amount, valid_from = p_valid_from, valid_to = p_valid_to,
                           min_nights = p_min_nights, max_uses = p_max_uses, is_active = coalesce(p_active, true), updated_at = now()
     where id = p_promo and property_id = p_property
     returning id, code into v_id, v_code;
    if v_id is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  end if;

  perform write_audit(v_prop.tenant_id, p_property, v_actor, 'promo_code.saved', 'promo_code', v_id, null,
                      jsonb_build_object('code', v_code, 'kind', p_kind, 'value', p_value, 'active', coalesce(p_active, true), 'created', p_promo is null));
  return jsonb_build_object('promo_id', v_id, 'code', v_code);
end $$;
revoke all on function save_promo_code(uuid, uuid, text, text, numeric, date, date, integer, integer, boolean) from public, anon;
grant execute on function save_promo_code(uuid, uuid, text, text, numeric, date, date, integer, integer, boolean) to authenticated;

create function delete_promo_code(p_promo uuid) returns void
language plpgsql security definer set search_path = public as $$
declare c promo_codes%rowtype; v_actor uuid;
begin
  select * into c from promo_codes where id = p_promo;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(c.property_id, 'property.configure', 'NOT_FOUND');
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if exists (select 1 from reservations where promo_code_id = c.id) then raise exception 'INVALID_STATE: used' using errcode = 'P0001'; end if;
  delete from promo_codes where id = c.id;
  perform write_audit(c.tenant_id, c.property_id, v_actor, 'promo_code.deleted', 'promo_code', c.id, null, jsonb_build_object('code', c.code));
end $$;
revoke all on function delete_promo_code(uuid) from public, anon;
grant execute on function delete_promo_code(uuid) to authenticated;

create function promo_code_list(p_property uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_permission(p_property, 'property.configure', 'NOT_FOUND');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', c.id, 'code', c.code, 'kind', c.kind, 'percent', c.percent, 'amount_minor', c.amount_minor,
      'valid_from', c.valid_from, 'valid_to', c.valid_to, 'min_nights', c.min_nights, 'max_uses', c.max_uses, 'is_active', c.is_active,
      'ever_used', exists (select 1 from reservations r where r.promo_code_id = c.id),
      'used', u.n, 'remaining', case when c.max_uses is null then null else greatest(c.max_uses - u.n, 0) end)
      order by c.is_active desc, c.created_at desc)
      from promo_codes c
      cross join lateral (select count(*)::integer as n from reservations r
                           where r.promo_code_id = c.id and r.reservation_status not in ('cancelled', 'expired', 'no_show')) u
     where c.property_id = p_property
  ), '[]'::jsonb);
end $$;
revoke all on function promo_code_list(uuid) from public, anon;
grant execute on function promo_code_list(uuid) to authenticated;

create function promo_apply(p_tenant uuid, p_property uuid, p_code text, p_reservation uuid, p_arrival date, p_departure date, p_today date)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c promo_codes%rowtype; r reservations%rowtype; v_used integer; v_base bigint; v_d bigint;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  -- the code row is locked, so two guests cannot both take the last use
  select * into c from promo_codes where property_id = p_property and code = upper(p_code) for update;
  if not found or not c.is_active
     or (c.valid_from is not null and p_today < c.valid_from) or (c.valid_to is not null and p_today > c.valid_to)
     or (p_departure - p_arrival) < c.min_nights
     or not tenant_feature_on(p_tenant, 'discounts') then
    raise exception 'POLICY_VIOLATION: promo' using errcode = 'P0001';
  end if;
  if c.max_uses is not null then
    select count(*) into v_used from reservations
     where promo_code_id = c.id and reservation_status not in ('cancelled', 'expired', 'no_show');
    if v_used >= c.max_uses then raise exception 'POLICY_VIOLATION: promo' using errcode = 'P0001'; end if;
  end if;

  select * into r from reservations where id = p_reservation for update;
  v_base := r.subtotal_minor + r.tax_minor;
  v_d := case c.kind when 'percent' then round(v_base * c.percent / 100)::bigint else c.amount_minor end;
  v_d := least(v_d, (v_base * 90 / 100));     -- never more than 90%, so a booking is never free
  if v_d <= 0 then raise exception 'POLICY_VIOLATION: promo' using errcode = 'P0001'; end if;

  update reservations set discount_minor = v_d,
         discount_percent = case when c.kind = 'percent' then c.percent end,
         discount_amount_minor = case when c.kind = 'amount' then v_d end,
         discount_reason = 'Promo ' || c.code, promo_code_id = c.id,
         total_minor = subtotal_minor + tax_minor - v_d
   where id = r.id returning * into r;
  return jsonb_build_object('discount_minor', r.discount_minor, 'total_minor', r.total_minor);
end $$;
revoke all on function promo_apply(uuid, uuid, text, uuid, date, date, date) from public, anon, authenticated;

drop function create_hold(text, date, date, jsonb, jsonb, text);
create function create_hold(
  p_host            text,
  p_arrival         date,
  p_departure       date,
  p_rooms           jsonb,     -- [{"room_type_id":..., "adults":2, "children":0}]
  p_guest           jsonb,     -- {"full_name":..., "email":..., "phone":..., "address":..., "special_requests":...}
  p_idempotency_key text,
  p_promo_code      text default null   -- 131: optional
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
  v_address  text;
  v_note     text;
  v_rooms    jsonb;
  v_hash     text;
  v_idem     record;
  v_guest    uuid;
  v_res      jsonb;
  v_expires  timestamptz;
  v_currency text;
  v_result   jsonb;
  v_code     text;
  v_promo    jsonb;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;

  select h.tenant_id, h.property_id into v_tenant, v_property from resolve_host(p_host) h;

  -- 064: the hotel group's online_booking flag; no row means on
  if not tenant_feature_on(v_tenant, 'online_booking') then
    raise exception 'INVALID_STATE: online booking off' using errcode = 'P0001';
  end if;

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
  -- 107: an address and special requests, both optional; blank means none
  v_address := nullif(btrim(coalesce(p_guest ->> 'address', '')), '');
  v_note    := nullif(btrim(coalesce(p_guest ->> 'special_requests', '')), '');
  if v_address is not null and length(v_address) > 200 then
    raise exception 'POLICY_VIOLATION: guest address' using errcode = 'P0001';
  end if;
  if v_note is not null and length(v_note) > 500 then
    raise exception 'POLICY_VIOLATION: guest requests' using errcode = 'P0001';
  end if;

  v_code := nullif(upper(btrim(coalesce(p_promo_code, ''))), '');
  if v_code is not null and (length(v_code) > 24 or v_code !~ '^[A-Z0-9_-]+$') then
    raise exception 'POLICY_VIOLATION: promo' using errcode = 'P0001';
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
             'adults',            coalesce((e.value ->> 'adults')::integer, 0),
             'children',          coalesce((e.value ->> 'children')::integer, 0))
           order by e.ordinality)
      into v_rooms
      from jsonb_array_elements(p_rooms) with ordinality e(value, ordinality);
  exception when invalid_text_representation or invalid_parameter_value or datatype_mismatch then
    raise exception 'POLICY_VIOLATION: rooms' using errcode = 'P0001';
  end;
  if v_rooms is null then raise exception 'POLICY_VIOLATION: rooms' using errcode = 'P0001'; end if;
  -- Online guests book public, active room types of this property only, and never choose a physical room.
  if exists (select 1 from jsonb_array_elements(v_rooms) e
              left join room_types rt on rt.id = (e ->> 'room_type_id')::uuid and rt.property_id = v_property
                                     and rt.is_public and rt.status = 'active'
             where rt.id is null) then
    raise exception 'NOT_FOUND: room type' using errcode = 'P0001';
  end if;

  -- idempotency before any write
  v_hash := md5(concat_ws('|', v_property, p_arrival, p_departure, v_rooms::text, v_name, v_email, coalesce(v_phone, ''), coalesce(v_address, ''), coalesce(v_note, ''), coalesce(v_code, '')));
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
    insert into guests (tenant_id, full_name, email, phone, address)
    values (v_tenant, v_name, v_email, v_phone, v_address) returning id into v_guest;
  elsif v_address is not null then
    -- a returning guest keeps the address on file; one with none gets the address they gave
    update guests set address = v_address where id = v_guest and address is null;
  end if;

  v_res := create_reservation(v_property, v_guest, 'website', p_arrival, p_departure, v_rooms,
                              'hold:' || p_idempotency_key);
  if v_note is not null then
    update reservations set guest_note = v_note where id = (v_res ->> 'reservation_id')::uuid;
  end if;

  -- 131: a promo code, checked and applied in the same transaction, so a bad code leaves no booking behind
  if v_code is not null then
    v_promo := promo_apply(v_tenant, v_property, v_code, (v_res ->> 'reservation_id')::uuid, p_arrival, p_departure, v_today);
    v_res := v_res || jsonb_build_object('total_minor', v_promo -> 'total_minor');
  end if;

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
    'discount_minor',    coalesce((v_promo ->> 'discount_minor')::bigint, 0),
    'promo_code',        v_code,
    'rooms', (select jsonb_agg(jsonb_build_object('reservation_room_id', x ->> 'reservation_room_id',
                                                  'room_type_id', x ->> 'room_type_id'))
                from jsonb_array_elements(v_res -> 'rooms') x));

  perform idem_finish(v_tenant, 'create_hold', p_idempotency_key, v_result);
  perform write_audit(v_tenant, v_property, null, 'hold.created', 'reservation',
                      (v_res ->> 'reservation_id')::uuid, p_idempotency_key,
                      jsonb_build_object('rooms', jsonb_array_length(v_rooms), 'hold_expires_at', v_expires));
  return v_result;
end $$;

revoke all on function create_hold(text, date, date, jsonb, jsonb, text, text) from public, anon, authenticated;
grant execute on function create_hold(text, date, date, jsonb, jsonb, text, text) to service_role;

create or replace function guest_booking_status(p_reservation_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r reservations%rowtype; v_prop record; v_held bigint; v_hold timestamptz;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select * into r from reservations where id = p_reservation_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  select name, check_in_time, check_out_time, timezone into v_prop from properties where id = r.property_id;
  v_held := reservation_money_held(r.id);
  select min(c.hold_expires_at) into v_hold
    from reservation_rooms rr join room_inventory_claims c on c.reservation_room_id = rr.id
   where rr.reservation_id = r.id and c.claim_type = 'hold' and c.status = 'active' and c.hold_expires_at > now();
  return jsonb_build_object(
    'reservation_id', r.id, 'booking_reference', r.booking_reference, 'status', r.reservation_status,
    'payment_status', r.payment_status, 'property_name', v_prop.name, 'timezone', v_prop.timezone,
    'arrival_date', r.arrival_date, 'departure_date', r.departure_date,
    'check_in_time', v_prop.check_in_time, 'check_out_time', v_prop.check_out_time,
    'currency', r.currency, 'total_minor', r.total_minor, 'discount_minor', r.discount_minor, 'discount_reason', r.discount_reason, 'paid_minor', v_held,
    'outstanding_minor', greatest(r.total_minor - v_held, 0), 'hold_expires_at', v_hold,
    'rooms', (select coalesce(jsonb_agg(jsonb_build_object('room_type', rt.name, 'adults', rr.adults, 'children', rr.children)
                                         order by rr.id), '[]'::jsonb)
                from reservation_rooms rr join room_types rt on rt.id = rr.room_type_id
               where rr.reservation_id = r.id and rr.room_status = 'booked'));
end $$;
