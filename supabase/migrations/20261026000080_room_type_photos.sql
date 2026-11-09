-- 080 Photos for room types.
--
-- A hotel shows a few pictures of each room type on its guest site.
--   * `room_type_photos`: one row per picture (tenant, property, room type, storage path, content type, size, optional
--     caption, sort order). The file itself lives in the public Storage bucket `room-photos`; the row is what makes it part
--     of the hotel's setup. Same rules as the room type: read by whoever may read room types, written only with
--     property.configure; every row is checked against the room type's own tenant and property (composite foreign key).
--   * limits, enforced by the table so no script can break them: JPEG, PNG or WebP; 1 byte to 2 MB; the caption is empty or
--     1 to 100 characters; at most 5 pictures per room type (a trigger that locks the room type while it counts); the path
--     must be exactly `<tenant>/<property>/<room type>/<uuid>.<jpg|png|webp>`, so a row can never point at another hotel's file.
--   * the audit trigger from 024 records every added, changed or removed picture (`room_type_photo.*`).
--   * the bucket is created here when Storage exists (not in the plain-Postgres test database): public read, 2 MB limit, the
--     three image types. Uploads are made by the server with the service role after it has checked the person may configure the
--     property, never straight from the browser, so the bucket needs no write policy for logins.
--   * search_availability (last replaced in 077) is replaced with exactly its 077 body plus `photos`: a list of
--     {path, caption} in order, which the guest site turns into public URLs.

create table room_type_photos (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null,
  property_id   uuid not null,
  room_type_id  uuid not null,
  storage_path  text not null unique,
  content_type  text not null check (content_type in ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes    integer not null check (size_bytes between 1 and 2097152),
  caption       text check (caption is null or (caption = btrim(caption) and length(caption) between 1 and 100)),
  sort_order    integer not null default 0,
  created_at    timestamptz not null default now(),
  foreign key (tenant_id, property_id, room_type_id) references room_types (tenant_id, property_id, id) on delete cascade,
  constraint room_type_photos_path_check check (storage_path ~ ('^' || tenant_id::text || '/' || property_id::text || '/' || room_type_id::text
    || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](jpg|png|webp)$'))
);
create index on room_type_photos (room_type_id, sort_order, created_at);

alter table room_type_photos enable row level security;
create policy room_type_photos_select on room_type_photos for select to authenticated
  using (has_permission(property_id, 'reservation.view') or has_permission(property_id, 'rate.view') or has_permission(property_id, 'property.configure'));
create policy room_type_photos_write on room_type_photos for all to authenticated
  using (has_permission(property_id, 'property.configure'))
  with check (has_permission(property_id, 'property.configure'));

create function room_type_photos_limit() returns trigger language plpgsql as $$
begin
  perform 1 from room_types where id = new.room_type_id for update;
  if (select count(*) from room_type_photos where room_type_id = new.room_type_id) >= 5 then
    raise exception 'POLICY_VIOLATION: photos limit' using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke all on function room_type_photos_limit() from public, anon, authenticated;   -- STAGING step 4c: only three functions are callable by anon
create trigger room_type_photos_limit before insert on room_type_photos
  for each row execute function room_type_photos_limit();

create trigger room_type_photos_audit after insert or update or delete on room_type_photos
  for each row execute function audit_setup_row('room_type_photo', 'room_type_id,storage_path,content_type,size_bytes,caption,sort_order');

do $b$ begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('room-photos', 'room-photos', true, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
    on conflict (id) do update set public = true, file_size_limit = 2097152, allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];
  end if;
end $b$;

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
      'amenities', to_jsonb(t.amenities),   -- 077
      'photos', coalesce((select jsonb_agg(jsonb_build_object('path', p.storage_path, 'caption', p.caption) order by p.sort_order, p.created_at)
                            from room_type_photos p where p.room_type_id = t.id), '[]'::jsonb),   -- 080
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
