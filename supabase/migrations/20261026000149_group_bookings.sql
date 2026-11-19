-- 149 Group bookings, step one (TODO 8.7): a group record, a room block with a release date, and a rooming list.
--
-- A group is one party with a contact (a wedding, a company, a team). Creating it HOLDS rooms by room type for the group's dates, using the
-- same 'block' claims as the event room blocks (140), so the rooms cannot be sold meanwhile and every rule about overlaps, expiry and
-- availability stays in one place (claim_room, migration 004). Nothing about money or a booking is built here: the master folio, corporate
-- rate plans, credit terms and the company invoice are later steps in TODO 8.7.
--
--   group_bookings     the group. status 'open' (rooms held), 'released' (the release date passed, rooms freed automatically) or 'cancelled'.
--                      release_date is the last day the hotel keeps the rooms; the day after it, release_due_group_blocks frees what is
--                      still unused. release_date is never after arrival_date.
--   group_block_units  one row per held room: status 'held', 'used' (staff handed that room to a guest's booking) or 'released'.
--   group_rooming      the rooming list: guest names added whenever the group sends them, with an optional room type.
--   Permission group.manage (owner, general manager, reservations officer) and the group_bookings flag (no row = on, as for every flag).
--   NOT_FOUND for no permission or another hotel. Every write is audited. Writes go through the functions only.
--   create_group       holds the rooms all or nothing: if one room type has too few free rooms the whole group is refused (ROOMS_UNAVAILABLE
--                      in the message) and nothing is held. Idempotent per key.
--   use_group_unit     frees one held room of a type so staff can book it for a named guest the normal way; the unit becomes 'used'.
--   release_due_group_blocks   system only (the maintenance cron): frees the held rooms of every open group whose release date has passed.

insert into permissions (key) values ('group.manage');
insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r, permissions p
 where p.key = 'group.manage' and r.key in ('owner', 'general_manager', 'reservations_officer');

create table group_bookings (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null,
  property_id    uuid not null,
  name           text not null check (char_length(name) between 1 and 80),
  company        text check (company is null or char_length(company) between 1 and 80),
  contact_name   text not null check (char_length(contact_name) between 1 and 80),
  contact_phone  text check (contact_phone is null or char_length(contact_phone) between 3 and 30),
  contact_email  text check (contact_email is null or (char_length(contact_email) between 3 and 120 and contact_email like '%_@_%')),
  arrival_date   date not null,
  departure_date date not null,
  release_date   date not null,
  status         text not null default 'open' check (status in ('open', 'released', 'cancelled')),
  notes          text check (notes is null or char_length(notes) <= 1000),
  created_by     uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  foreign key (tenant_id, property_id) references properties (tenant_id, id),
  check (departure_date > arrival_date and departure_date - arrival_date <= 60),
  check (release_date <= arrival_date)
);
create index group_bookings_property_idx on group_bookings (property_id, status, arrival_date);
create index group_bookings_due_idx on group_bookings (release_date) where status = 'open';
alter table group_bookings enable row level security;
create policy group_bookings_select on group_bookings for select to authenticated using (has_permission(property_id, 'group.manage'));
revoke insert, update, delete on group_bookings from authenticated, anon;
create trigger group_bookings_updated before update on group_bookings for each row execute function set_updated_at();

create table group_block_units (
  id           uuid primary key default gen_random_uuid(),
  group_id     uuid not null references group_bookings (id) on delete cascade,
  tenant_id    uuid not null,
  property_id  uuid not null,
  room_type_id uuid not null,
  claim_id     uuid not null unique references room_inventory_claims (id),
  status       text not null default 'held' check (status in ('held', 'used', 'released')),
  created_at   timestamptz not null default clock_timestamp(),
  foreign key (tenant_id, property_id, room_type_id) references room_types (tenant_id, property_id, id)
);
create index group_block_units_group_idx on group_block_units (group_id, room_type_id, status);
alter table group_block_units enable row level security;
create policy group_block_units_select on group_block_units for select to authenticated using (has_permission(property_id, 'group.manage'));
revoke insert, update, delete on group_block_units from authenticated, anon;

create table group_rooming (
  id           uuid primary key default gen_random_uuid(),
  group_id     uuid not null references group_bookings (id) on delete cascade,
  tenant_id    uuid not null,
  property_id  uuid not null,
  guest_name   text not null check (char_length(guest_name) between 1 and 80),
  room_type_id uuid,
  notes        text check (notes is null or char_length(notes) <= 200),
  created_at   timestamptz not null default clock_timestamp(),
  foreign key (tenant_id, property_id) references properties (tenant_id, id),
  foreign key (tenant_id, property_id, room_type_id) references room_types (tenant_id, property_id, id)
);
create index group_rooming_group_idx on group_rooming (group_id, created_at);
alter table group_rooming enable row level security;
create policy group_rooming_select on group_rooming for select to authenticated using (has_permission(property_id, 'group.manage'));
revoke insert, update, delete on group_rooming from authenticated, anon;

-- The flag is enforced; keep the platform's list in step (latest list: migration 148).
create or replace function plan_enforced_flags() returns text[]
language sql immutable set search_path = public as $$
  select array['reports.export', 'online_payments', 'discounts', 'online_booking', 'guest_cancel', 'guest_changes', 'early_checkin',
               'housekeeping', 'maintenance', 'audit_log', 'branding', 'dynamic_pricing', 'sms_notifications', 'restaurant_pos', 'group_bookings']
$$;
revoke all on function plan_enforced_flags() from public, anon;
update plans set features = (select array_agg(distinct k order by k) from unnest(features || array['group_bookings']) k) where code = 'pro';

-- Shared by the writes: the hotel row, the person and the flag.
create function group_guard(p_property uuid, out o_tenant uuid, out o_actor uuid) returns record
language plpgsql security definer set search_path = public as $$
begin
  select tenant_id into o_tenant from properties where id = p_property;
  if o_tenant is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  o_actor := require_permission(p_property, 'group.manage', 'NOT_FOUND');
  if o_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if not tenant_feature_on(o_tenant, 'group_bookings') then raise exception 'POLICY_VIOLATION: group bookings off' using errcode = 'P0001'; end if;
end $$;
revoke all on function group_guard(uuid) from public, anon, authenticated;

create function create_group(p_property uuid, p_name text, p_company text, p_contact_name text, p_contact_phone text, p_contact_email text,
                             p_arrival date, p_departure date, p_release date, p_notes text, p_rooms jsonb, p_key text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  g record; v_today date; v_name text := btrim(coalesce(p_name, '')); v_idem record; v_hash text; v_id uuid; v_types uuid[] := '{}';
  e jsonb; v_type uuid; v_qty integer; v_total integer := 0; i integer; v_claim uuid; v_result jsonb; v_company text := nullif(btrim(coalesce(p_company, '')), '');
  v_phone text := nullif(btrim(coalesce(p_contact_phone, '')), ''); v_email text := nullif(btrim(coalesce(p_contact_email, '')), '');
  v_contact text := btrim(coalesce(p_contact_name, '')); v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
begin
  select * into g from group_guard(p_property);
  v_today := property_today(p_property);
  if char_length(v_name) not between 1 and 80 or char_length(v_contact) not between 1 and 80 or (v_company is not null and char_length(v_company) > 80)
     or (v_phone is not null and char_length(v_phone) not between 3 and 30) or (v_email is not null and (char_length(v_email) > 120 or v_email not like '%_@_%'))
     or (v_notes is not null and char_length(v_notes) > 1000) then raise exception 'POLICY_VIOLATION: details' using errcode = 'P0001'; end if;
  if p_arrival is null or p_departure is null or p_release is null or p_departure <= p_arrival or p_departure - p_arrival > 60
     or p_arrival < v_today or p_release < v_today or p_release > p_arrival then raise exception 'POLICY_VIOLATION: dates' using errcode = 'P0001'; end if;
  if p_rooms is null or jsonb_typeof(p_rooms) <> 'array' or jsonb_array_length(p_rooms) not between 1 and 10 then raise exception 'POLICY_VIOLATION: rooms' using errcode = 'P0001'; end if;
  for e in select * from jsonb_array_elements(p_rooms) loop
    begin
      v_type := (e ->> 'room_type_id')::uuid; v_qty := (e ->> 'quantity')::integer;
    exception when others then raise exception 'POLICY_VIOLATION: rooms' using errcode = 'P0001';
    end;
    if v_qty is null or v_qty not between 1 and 50 or v_type = any (v_types)
       or not exists (select 1 from room_types where id = v_type and property_id = p_property and status = 'active') then
      raise exception 'POLICY_VIOLATION: rooms' using errcode = 'P0001';
    end if;
    v_types := v_types || v_type; v_total := v_total + v_qty;
  end loop;
  if v_total > 100 then raise exception 'POLICY_VIOLATION: rooms' using errcode = 'P0001'; end if;

  v_hash := md5(concat_ws('|', p_property, v_name, v_contact, p_arrival, p_departure, p_release, p_rooms::text));
  select * into v_idem from idem_begin(g.o_tenant, 'create_group', p_key, v_hash);
  if not v_idem.out_is_new then return v_idem.out_response; end if;

  insert into group_bookings (tenant_id, property_id, name, company, contact_name, contact_phone, contact_email, arrival_date, departure_date, release_date, notes, created_by)
  values (g.o_tenant, p_property, v_name, v_company, v_contact, v_phone, v_email, p_arrival, p_departure, p_release, v_notes, g.o_actor)
  returning id into v_id;

  perform lock_room_types(p_property, v_types);
  for e in select * from jsonb_array_elements(p_rooms) loop
    v_type := (e ->> 'room_type_id')::uuid; v_qty := (e ->> 'quantity')::integer;
    for i in 1..v_qty loop
      begin
        v_claim := claim_room(p_property, v_type, null, p_arrival, p_departure, 'block', null, null, left('Group ' || v_name, 200), g.o_actor);
      exception when others then
        if sqlerrm like 'ROOM_UNAVAILABLE%' then raise exception 'POLICY_VIOLATION: ROOMS_UNAVAILABLE' using errcode = 'P0001'; end if;
        raise;
      end;
      insert into group_block_units (group_id, tenant_id, property_id, room_type_id, claim_id) values (v_id, g.o_tenant, p_property, v_type, v_claim);
    end loop;
  end loop;

  v_result := jsonb_build_object('group_id', v_id, 'rooms_held', v_total);
  perform idem_finish(g.o_tenant, 'create_group', p_key, v_result);
  perform write_audit(g.o_tenant, p_property, g.o_actor, 'group.created', 'group', v_id, p_key,
                      jsonb_build_object('name', v_name, 'rooms', v_total, 'arrival', p_arrival, 'departure', p_departure, 'release', p_release));
  return v_result;
end $$;

create function update_group(p_group uuid, p_company text, p_contact_name text, p_contact_phone text, p_contact_email text, p_release date, p_notes text)
returns void language plpgsql security definer set search_path = public as $$
declare b group_bookings%rowtype; g record; v_company text := nullif(btrim(coalesce(p_company, '')), ''); v_contact text := btrim(coalesce(p_contact_name, ''));
  v_phone text := nullif(btrim(coalesce(p_contact_phone, '')), ''); v_email text := nullif(btrim(coalesce(p_contact_email, '')), ''); v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
begin
  select * into b from group_bookings where id = p_group for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  select * into g from group_guard(b.property_id);
  if b.status <> 'open' then raise exception 'INVALID_STATE: %', b.status using errcode = 'P0001'; end if;
  if char_length(v_contact) not between 1 and 80 or (v_company is not null and char_length(v_company) > 80)
     or (v_phone is not null and char_length(v_phone) not between 3 and 30) or (v_email is not null and (char_length(v_email) > 120 or v_email not like '%_@_%'))
     or (v_notes is not null and char_length(v_notes) > 1000) then raise exception 'POLICY_VIOLATION: details' using errcode = 'P0001'; end if;
  if p_release is null or p_release > b.arrival_date or p_release < property_today(b.property_id) then raise exception 'POLICY_VIOLATION: dates' using errcode = 'P0001'; end if;
  update group_bookings set company = v_company, contact_name = v_contact, contact_phone = v_phone, contact_email = v_email, release_date = p_release, notes = v_notes where id = b.id;
  perform write_audit(g.o_tenant, b.property_id, g.o_actor, 'group.updated', 'group', b.id, null, jsonb_build_object('release', p_release));
end $$;

create function cancel_group(p_group uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b group_bookings%rowtype; g record; v_freed integer;
begin
  select * into b from group_bookings where id = p_group for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  select * into g from group_guard(b.property_id);
  if b.status <> 'open' then raise exception 'INVALID_STATE: %', b.status using errcode = 'P0001'; end if;
  update room_inventory_claims set status = 'released' where status = 'active' and id in (select claim_id from group_block_units where group_id = b.id and status = 'held');
  update group_block_units set status = 'released' where group_id = b.id and status = 'held';
  get diagnostics v_freed = row_count;
  update group_bookings set status = 'cancelled' where id = b.id;
  perform write_audit(g.o_tenant, b.property_id, g.o_actor, 'group.cancelled', 'group', b.id, null, jsonb_build_object('rooms_freed', v_freed));
  return jsonb_build_object('group_id', b.id, 'rooms_freed', v_freed);
end $$;

create function use_group_unit(p_group uuid, p_room_type uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b group_bookings%rowtype; g record; u group_block_units%rowtype; v_left integer;
begin
  select * into b from group_bookings where id = p_group for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  select * into g from group_guard(b.property_id);
  if b.status <> 'open' then raise exception 'INVALID_STATE: %', b.status using errcode = 'P0001'; end if;
  select * into u from group_block_units where group_id = b.id and room_type_id = p_room_type and status = 'held' order by created_at, id limit 1 for update;
  if not found then raise exception 'POLICY_VIOLATION: no held room' using errcode = 'P0001'; end if;
  update room_inventory_claims set status = 'released' where id = u.claim_id and status = 'active';
  update group_block_units set status = 'used' where id = u.id;
  select count(*) into v_left from group_block_units where group_id = b.id and room_type_id = p_room_type and status = 'held';
  perform write_audit(g.o_tenant, b.property_id, g.o_actor, 'group.room_used', 'group', b.id, null, jsonb_build_object('room_type_id', p_room_type, 'held_left', v_left));
  return jsonb_build_object('group_id', b.id, 'room_type_id', p_room_type, 'held_left', v_left);
end $$;

create function add_rooming_entry(p_group uuid, p_guest text, p_room_type uuid, p_notes text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b group_bookings%rowtype; g record; v_name text := btrim(coalesce(p_guest, '')); v_notes text := nullif(btrim(coalesce(p_notes, '')), ''); v_id uuid;
begin
  select * into b from group_bookings where id = p_group for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  select * into g from group_guard(b.property_id);
  if b.status = 'cancelled' then raise exception 'INVALID_STATE: cancelled' using errcode = 'P0001'; end if;
  if char_length(v_name) not between 1 and 80 or (v_notes is not null and char_length(v_notes) > 200) then raise exception 'POLICY_VIOLATION: details' using errcode = 'P0001'; end if;
  if p_room_type is not null and not exists (select 1 from room_types where id = p_room_type and property_id = b.property_id) then raise exception 'POLICY_VIOLATION: room type' using errcode = 'P0001'; end if;
  if (select count(*) from group_rooming where group_id = b.id) >= 200 then raise exception 'POLICY_VIOLATION: limit' using errcode = 'P0001'; end if;
  insert into group_rooming (group_id, tenant_id, property_id, guest_name, room_type_id, notes) values (b.id, b.tenant_id, b.property_id, v_name, p_room_type, v_notes) returning id into v_id;
  perform write_audit(g.o_tenant, b.property_id, g.o_actor, 'group.rooming_added', 'group', b.id, null, jsonb_build_object('entry_id', v_id));
  return jsonb_build_object('entry_id', v_id);
end $$;

create function remove_rooming_entry(p_entry uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r group_rooming%rowtype; g record;
begin
  select * into r from group_rooming where id = p_entry;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  select * into g from group_guard(r.property_id);
  delete from group_rooming where id = r.id;
  perform write_audit(g.o_tenant, r.property_id, g.o_actor, 'group.rooming_removed', 'group', r.group_id, null, jsonb_build_object('entry_id', r.id));
end $$;

create function group_list(p_property uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not has_permission(p_property, 'group.manage') then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', b.id, 'name', b.name, 'company', b.company, 'contact_name', b.contact_name, 'arrival_date', b.arrival_date, 'departure_date', b.departure_date,
      'release_date', b.release_date, 'status', b.status,
      'rooms_total', (select count(*) from group_block_units u where u.group_id = b.id),
      'rooms_held', (select count(*) from group_block_units u where u.group_id = b.id and u.status = 'held'),
      'rooming_count', (select count(*) from group_rooming r where r.group_id = b.id))
      order by (b.status = 'open') desc, b.arrival_date, b.created_at)
    from group_bookings b where b.property_id = p_property), '[]'::jsonb);
end $$;

create function group_detail(p_group uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare b group_bookings%rowtype;
begin
  select * into b from group_bookings where id = p_group;
  if not found or not has_permission(b.property_id, 'group.manage') then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  return jsonb_build_object(
    'id', b.id, 'property_id', b.property_id, 'name', b.name, 'company', b.company, 'contact_name', b.contact_name, 'contact_phone', b.contact_phone,
    'contact_email', b.contact_email, 'arrival_date', b.arrival_date, 'departure_date', b.departure_date, 'release_date', b.release_date,
    'status', b.status, 'notes', b.notes,
    'rooms', coalesce((
      select jsonb_agg(jsonb_build_object('room_type_id', x.room_type_id, 'room_type_name', x.name, 'held', x.held, 'used', x.used, 'released', x.released) order by x.name)
        from (select t.id as room_type_id, t.name, count(*) filter (where u.status = 'held') as held, count(*) filter (where u.status = 'used') as used,
                     count(*) filter (where u.status = 'released') as released
                from group_block_units u join room_types t on t.id = u.room_type_id where u.group_id = b.id group by t.id, t.name) x), '[]'::jsonb),
    'rooming', coalesce((
      select jsonb_agg(jsonb_build_object('id', r.id, 'guest_name', r.guest_name, 'room_type_id', r.room_type_id, 'room_type_name', t.name, 'notes', r.notes) order by r.created_at, r.id)
        from group_rooming r left join room_types t on t.id = r.room_type_id where r.group_id = b.id), '[]'::jsonb));
end $$;

-- The cron's job: free the rooms of every open group whose release date has passed (the hotel's own day, per its time zone).
create function release_due_group_blocks() returns integer
language plpgsql security definer set search_path = public as $$
declare b record; v_groups integer := 0; v_freed integer;
begin
  for b in select id, tenant_id, property_id from group_bookings
            where status = 'open' and release_date < property_today(property_id) order by release_date limit 200 for update skip locked loop
    update room_inventory_claims set status = 'released' where status = 'active' and id in (select claim_id from group_block_units where group_id = b.id and status = 'held');
    update group_block_units set status = 'released' where group_id = b.id and status = 'held';
    get diagnostics v_freed = row_count;
    update group_bookings set status = 'released' where id = b.id;
    perform write_audit(b.tenant_id, b.property_id, null, 'group.released', 'group', b.id, null, jsonb_build_object('rooms_freed', v_freed, 'by', 'release date'));
    v_groups := v_groups + 1;
  end loop;
  return v_groups;
end $$;

do $$ declare f text; begin
  foreach f in array array[
    'create_group(uuid, text, text, text, text, text, date, date, date, text, jsonb, text)',
    'update_group(uuid, text, text, text, text, date, text)', 'cancel_group(uuid)', 'use_group_unit(uuid, uuid)',
    'add_rooming_entry(uuid, text, uuid, text)', 'remove_rooming_entry(uuid)', 'group_list(uuid)', 'group_detail(uuid)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
revoke all on function release_due_group_blocks() from public, anon, authenticated;
grant execute on function release_due_group_blocks() to service_role;
