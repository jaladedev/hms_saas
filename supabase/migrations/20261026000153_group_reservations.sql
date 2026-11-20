-- 153 Group bookings, step two (TODO 8.7): link each rooming-list name to its real booking, and a group statement.
--
-- Staff book a freed room the normal way (use_group_unit, migration 149) and then enter that booking's reference against the name. A link
-- is a pointer only: the booking keeps its own folio, payments, invoices and reports, so nothing is counted twice and no money function
-- changes. The group statement READS the linked bookings: each one's total, payment status and extras, and the sums of the bookings that
-- are not cancelled. A shared company bill, credit terms and a company invoice are later steps.
--
--   link_rooming_reservation(entry, reference)  same hotel, booking not cancelled/expired/no-show, stay inside the group's dates, one name per
--                                               booking. POLICY_VIOLATION: booking not found / booking dates / already linked. Audited.
--   unlink_rooming_reservation(entry)           removes the pointer only. Audited.
--   group_statement(group)                      group.manage; money figures only for people who may see money (can_view_money).

alter table group_rooming add column reservation_id uuid references reservations (id) on delete set null;
create unique index group_rooming_reservation_uniq on group_rooming (reservation_id) where reservation_id is not null;

create function link_rooming_reservation(p_entry uuid, p_reference text) returns void
language plpgsql security definer set search_path = public as $$
declare r group_rooming%rowtype; b group_bookings%rowtype; g record; v_ref text := upper(btrim(coalesce(p_reference, ''))); v_res reservations%rowtype;
begin
  select * into r from group_rooming where id = p_entry for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  select * into b from group_bookings where id = r.group_id;
  select * into g from group_guard(b.property_id);
  if b.status = 'cancelled' then raise exception 'INVALID_STATE: cancelled' using errcode = 'P0001'; end if;
  select * into v_res from reservations where property_id = b.property_id and upper(booking_reference) = v_ref;
  if not found or v_res.reservation_status in ('cancelled', 'expired', 'no_show') then raise exception 'POLICY_VIOLATION: booking not found' using errcode = 'P0001'; end if;
  if v_res.arrival_date < b.arrival_date or v_res.departure_date > b.departure_date then raise exception 'POLICY_VIOLATION: booking dates' using errcode = 'P0001'; end if;
  if exists (select 1 from group_rooming where reservation_id = v_res.id and id <> r.id) then raise exception 'POLICY_VIOLATION: already linked' using errcode = 'P0001'; end if;
  update group_rooming set reservation_id = v_res.id where id = r.id;
  perform write_audit(g.o_tenant, b.property_id, g.o_actor, 'group.booking_linked', 'group', b.id, null, jsonb_build_object('entry_id', r.id, 'reservation_id', v_res.id));
end $$;

create function unlink_rooming_reservation(p_entry uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r group_rooming%rowtype; g record;
begin
  select * into r from group_rooming where id = p_entry for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  select * into g from group_guard(r.property_id);
  if r.reservation_id is null then return; end if;
  update group_rooming set reservation_id = null where id = r.id;
  perform write_audit(g.o_tenant, r.property_id, g.o_actor, 'group.booking_unlinked', 'group', r.group_id, null, jsonb_build_object('entry_id', r.id, 'reservation_id', r.reservation_id));
end $$;

-- group_detail again, with the booking each name points to.
create or replace function group_detail(p_group uuid) returns jsonb
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
      select jsonb_agg(jsonb_build_object('id', r.id, 'guest_name', r.guest_name, 'room_type_id', r.room_type_id, 'room_type_name', t.name, 'notes', r.notes,
               'reservation_id', r.reservation_id, 'booking_reference', v.booking_reference, 'reservation_status', v.reservation_status) order by r.created_at, r.id)
        from group_rooming r left join room_types t on t.id = r.room_type_id left join reservations v on v.id = r.reservation_id
       where r.group_id = b.id), '[]'::jsonb));
end $$;

create function group_statement(p_group uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare b group_bookings%rowtype; v_money boolean; v_rows jsonb; v_cur text;
begin
  select * into b from group_bookings where id = p_group;
  if not found or not has_permission(b.property_id, 'group.manage') then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_money := can_view_money(b.property_id);
  select coalesce(jsonb_agg(jsonb_build_object(
           'entry_id', r.id, 'guest_name', r.guest_name, 'reservation_id', v.id, 'booking_reference', v.booking_reference,
           'reservation_status', v.reservation_status, 'payment_status', v.payment_status, 'arrival_date', v.arrival_date, 'departure_date', v.departure_date,
           'total_minor', case when v_money then v.total_minor end,
           'extras_minor', case when v_money then f.charges_minor end,
           'extras_paid_minor', case when v_money then f.paid_minor end) order by r.created_at, r.id), '[]'::jsonb),
         max(v.currency)
    into v_rows, v_cur
    from group_rooming r join reservations v on v.id = r.reservation_id left join lateral folio_totals(v.id) f on true
   where r.group_id = b.id;
  return jsonb_build_object(
    'money_visible', v_money, 'currency', coalesce(v_cur, 'NGN'), 'bookings', v_rows,
    'linked_count', jsonb_array_length(v_rows),
    'names_without_booking', (select count(*) from group_rooming where group_id = b.id and reservation_id is null),
    'total_minor', case when v_money then (select coalesce(sum(v.total_minor), 0) from group_rooming r join reservations v on v.id = r.reservation_id
                                            where r.group_id = b.id and v.reservation_status not in ('cancelled', 'expired', 'no_show')) end,
    'extras_minor', case when v_money then (select coalesce(sum(f.charges_minor), 0) from group_rooming r join reservations v on v.id = r.reservation_id,
                                                  lateral folio_totals(v.id) f where r.group_id = b.id and v.reservation_status not in ('cancelled', 'expired', 'no_show')) end);
end $$;

do $$ declare f text; begin
  foreach f in array array['link_rooming_reservation(uuid, text)', 'unlink_rooming_reservation(uuid)', 'group_detail(uuid)', 'group_statement(uuid)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
