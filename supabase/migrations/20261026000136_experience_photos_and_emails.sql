-- 136 Photos on places and experiences, and an email to the guest when staff answer an experience request (builds on 119 and 134).
--
-- Photos. hotel_places.photo_path and hotel_experiences.photo_path hold a path in the public room-photos bucket (088, 090):
-- <tenant>/<property>/places/<uuid>.<jpg|png|webp> and <tenant>/<property>/experiences/<uuid>.<jpg|png|webp>. A table check ties the
-- path to the row's own tenant and hotel, so it cannot point at another hotel's folder. Null means no photo.
--   set_place_photo(place, path), set_experience_photo(experience, path)
--       property.configure at that hotel (anyone else NOT_FOUND). A null or empty path removes the photo. The app stores the file first
--       (service key) and calls this as the signed-in person; if this refuses, the app removes the file again. Audited.
--   Replacing or removing a photo, and deleting the place or experience, put the old path in room_photo_cleanup (088), so the
--   maintenance job deletes the old file.
--   guest_places and guest_experiences also return `photo` (the path, or null).
--
-- Email. When staff confirm or decline an experience request, the guest is emailed once (kind experience_answered, dedupe key
-- exp:<request>:<action>) if the booking has a guest email, through the same outbox as the other booking emails. The email is the
-- hotel answering the guest's own request, so it is not behind a switch. 'charge' sends nothing (the guest sees it on their bill).
-- experience_request_set is 134's with the enqueue added.

-- ---- photos ------------------------------------------------------------------------------
alter table hotel_places
  add column photo_path text,
  add constraint hotel_places_photo_check check (photo_path is null or photo_path ~ ('^' || tenant_id || '/' || property_id || '/places/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](jpg|png|webp)$'));
alter table hotel_experiences
  add column photo_path text,
  add constraint hotel_experiences_photo_check check (photo_path is null or photo_path ~ ('^' || tenant_id || '/' || property_id || '/experiences/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](jpg|png|webp)$'));

create function hotel_extra_photo_queue_cleanup() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if old.photo_path is not null and (tg_op = 'DELETE' or new.photo_path is distinct from old.photo_path) then
    insert into room_photo_cleanup (path) values (old.photo_path) on conflict do nothing;
  end if;
  return null;
end $$;
revoke all on function hotel_extra_photo_queue_cleanup() from public, anon, authenticated;
create trigger hotel_places_photo_cleanup after update of photo_path or delete on hotel_places
  for each row execute function hotel_extra_photo_queue_cleanup();
create trigger hotel_experiences_photo_cleanup after update of photo_path or delete on hotel_experiences
  for each row execute function hotel_extra_photo_queue_cleanup();

create function set_place_photo(p_place uuid, p_path text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare o hotel_places%rowtype; v_actor uuid; v_path text := nullif(btrim(coalesce(p_path, '')), '');
begin
  select * into o from hotel_places where id = p_place;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(o.property_id, 'property.configure', 'NOT_FOUND');
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  update hotel_places set photo_path = v_path, updated_at = now() where id = p_place;
  perform write_audit(o.tenant_id, o.property_id, v_actor, 'hotel_place.photo', 'hotel_place', o.id, null, jsonb_build_object('has_photo', v_path is not null));
end $$;
revoke all on function set_place_photo(uuid, text) from public, anon;
grant execute on function set_place_photo(uuid, text) to authenticated;

create function set_experience_photo(p_experience uuid, p_path text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare o hotel_experiences%rowtype; v_actor uuid; v_path text := nullif(btrim(coalesce(p_path, '')), '');
begin
  select * into o from hotel_experiences where id = p_experience;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(o.property_id, 'property.configure', 'NOT_FOUND');
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  update hotel_experiences set photo_path = v_path, updated_at = now() where id = p_experience;
  perform write_audit(o.tenant_id, o.property_id, v_actor, 'hotel_experience.photo', 'hotel_experience', o.id, null, jsonb_build_object('has_photo', v_path is not null));
end $$;
revoke all on function set_experience_photo(uuid, text) from public, anon;
grant execute on function set_experience_photo(uuid, text) to authenticated;

create or replace function guest_places(p_host text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_property uuid;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select h.property_id into v_property from resolve_host(p_host) h;
  return jsonb_build_object('places', coalesce((
    select jsonb_agg(jsonb_build_object('name', x.name, 'body', x.body, 'category', x.category, 'link', x.link_url, 'photo', x.photo_path)
                     order by x.sort_order, x.created_at)
      from hotel_places x where x.property_id = v_property and x.is_active), '[]'::jsonb));
end $$;

create or replace function guest_experiences(p_host text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_property uuid; v_currency char(3);
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select h.property_id into v_property from resolve_host(p_host) h;
  select currency into v_currency from properties where id = v_property;
  return jsonb_build_object('currency', v_currency, 'experiences', coalesce((
    select jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'body', x.body, 'price_minor', x.price_minor, 'unit', x.unit, 'photo', x.photo_path)
                     order by x.sort_order, x.created_at)
      from hotel_experiences x where x.property_id = v_property and x.is_active), '[]'::jsonb));
end $$;

-- ---- email -------------------------------------------------------------------------------
alter table email_outbox drop constraint email_outbox_kind_check;
alter table email_outbox add constraint email_outbox_kind_check
  check (kind in ('booking_held', 'booking_confirmed', 'booking_link', 'refund_processed', 'booking_cancelled', 'payment_no_room', 'folio_invoice',
                  'early_checkout_credit', 'stay_changed', 'change_request_answered', 'booking_invoice', 'arrival_reminder', 'review_request',
                  'experience_answered'));

create or replace function experience_request_set(p_request uuid, p_action text, p_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  q experience_requests%rowtype; r reservations%rowtype; v_actor uuid; v_qty integer; v_res jsonb; v_charge uuid; v_total bigint;
begin
  select * into q from experience_requests where id = p_request;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(q.property_id, 'folio.charge', 'NOT_FOUND');
  if p_action is null or p_action not in ('confirm', 'decline', 'charge') then raise exception 'POLICY_VIOLATION: action' using errcode = 'P0001'; end if;
  select * into r from reservations where id = q.reservation_id for update;
  select * into q from experience_requests where id = p_request for update;
  v_total := case when q.unit = 'person' then q.quantity * q.unit_price_minor else q.unit_price_minor end;

  if p_action = 'confirm' then
    if q.status = 'confirmed' then return jsonb_build_object('status', 'confirmed'); end if;
    if q.status <> 'requested' then raise exception 'INVALID_STATE: %', q.status using errcode = 'P0001'; end if;
    update experience_requests set status = 'confirmed', updated_at = now() where id = q.id;
  elsif p_action = 'decline' then
    if q.status = 'declined' then return jsonb_build_object('status', 'declined'); end if;
    if q.status not in ('requested', 'confirmed') then raise exception 'INVALID_STATE: %', q.status using errcode = 'P0001'; end if;
    update experience_requests set status = 'declined', updated_at = now() where id = q.id;
  else
    if q.status = 'charged' then return jsonb_build_object('status', 'charged', 'charge_id', q.folio_charge_id); end if;
    if q.status <> 'confirmed' then raise exception 'INVALID_STATE: %', q.status using errcode = 'P0001'; end if;
    if r.reservation_status not in ('checked_in', 'checked_out') then raise exception 'INVALID_STATE: %', r.reservation_status using errcode = 'P0001'; end if;
    v_qty := case when q.unit = 'person' then q.quantity else 1 end;
    v_res := post_folio_charge(q.reservation_id, 'other', left('Experience: ' || q.name_at_request, 200), v_qty, q.unit_price_minor,
                               'exp-' || q.id::text || '-' || coalesce(p_key, 'x'), null, null);
    v_charge := (v_res ->> 'charge_id')::uuid;
    update experience_requests set status = 'charged', folio_charge_id = v_charge, updated_at = now() where id = q.id;
  end if;

  perform write_audit(q.tenant_id, q.property_id, v_actor, 'experience.' || case p_action when 'confirm' then 'confirmed' when 'decline' then 'declined' else 'charged' end,
                      'experience_request', q.id, null, jsonb_build_object('reservation_id', q.reservation_id, 'experience', q.name_at_request));
  if p_action in ('confirm', 'decline') then
    perform enqueue_booking_email(q.reservation_id, 'experience_answered', 'exp:' || q.id::text || ':' || p_action,
      jsonb_build_object('answer', case p_action when 'confirm' then 'confirmed' else 'declined' end, 'experience', q.name_at_request,
                         'quantity', q.quantity, 'date', q.preferred_date, 'total_minor', v_total, 'currency', r.currency));
  end if;
  return jsonb_build_object('status', case p_action when 'confirm' then 'confirmed' when 'decline' then 'declined' else 'charged' end);
end $$;
revoke all on function experience_request_set(uuid, text, text) from public, anon;
grant execute on function experience_request_set(uuid, text, text) to authenticated;
