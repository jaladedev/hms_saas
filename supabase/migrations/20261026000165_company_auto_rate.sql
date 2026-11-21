-- 8.7 step nine: company rates applied when a booking is linked to a group.
-- A company account can be switched to auto_apply_rate (off by default). When a rooming name is linked to a booking of a group whose company has it
-- on, the company's rate (room-type rates, else the flat percent) is applied to that booking right then, by the same rules as the apply button:
-- only a confirmed booking with no discount, payment, live invoice or payment in progress; otherwise it is left alone and the apply button can be
-- used later. Never replaces a discount. The shared rule now lives in apply_company_rate_to_reservation, used by both paths.

alter table company_accounts add column auto_apply_rate boolean not null default false;

create function apply_company_rate_to_reservation(p_company uuid, p_group uuid, p_reservation uuid, p_key text, p_tenant uuid, p_actor uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare c company_accounts%rowtype; r reservations%rowtype; v_amt bigint; v_typed boolean; v_new bigint;
begin
  select * into c from company_accounts where id = p_company;
  select * into r from reservations where id = p_reservation for update;
  if not found or c.id is null then return false; end if;
  if r.reservation_status <> 'confirmed' or r.discount_minor > 0
     or exists (select 1 from payments where reservation_id = r.id)
     or exists (select 1 from invoices where reservation_id = r.id and invoice_status <> 'void')
     or exists (select 1 from payment_attempts where reservation_id = r.id and status = 'initiated') then
    return false;
  end if;
  select d.amount_minor, d.typed into v_amt, v_typed from company_booking_discount(c.id, r.id) d;
  if v_typed then
    v_new := least(v_amt, r.subtotal_minor + r.tax_minor);
    if v_new <= 0 then return false; end if;
    update reservations set discount_minor = v_new, discount_percent = null, discount_amount_minor = v_new,
           discount_reason = left('Company rate: ' || c.name, 200), total_minor = subtotal_minor + tax_minor - v_new where id = r.id;
    perform write_audit(p_tenant, r.property_id, p_actor, 'reservation.company_rate_applied', 'reservation', r.id, p_key,
                        jsonb_build_object('company', c.name, 'kind', 'room_type_rates', 'discount_minor', v_new, 'group_id', p_group));
    return true;
  elsif c.discount_percent > 0 then
    v_new := round((r.subtotal_minor + r.tax_minor) * c.discount_percent / 100)::bigint;
    update reservations set discount_minor = v_new, discount_percent = c.discount_percent, discount_reason = left('Company rate: ' || c.name, 200),
           total_minor = subtotal_minor + tax_minor - v_new where id = r.id;
    perform write_audit(p_tenant, r.property_id, p_actor, 'reservation.company_rate_applied', 'reservation', r.id, p_key,
                        jsonb_build_object('company', c.name, 'percent', c.discount_percent, 'discount_minor', v_new, 'group_id', p_group));
    return true;
  end if;
  return false;
end $$;
revoke all on function apply_company_rate_to_reservation(uuid, uuid, uuid, text, uuid, uuid) from public, anon, authenticated;

create or replace function apply_company_rate_to_group(p_group uuid, p_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b group_bookings%rowtype; g record; c company_accounts%rowtype; v_idem record; v_applied integer := 0; v_skipped integer := 0; r reservations%rowtype; v_result jsonb;
begin
  select * into b from group_bookings where id = p_group;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  select * into g from group_guard(b.property_id);
  if b.status = 'cancelled' then raise exception 'INVALID_STATE: cancelled' using errcode = 'P0001'; end if;
  select * into v_idem from idem_begin(g.o_tenant, 'apply_company_rate', p_key, md5(p_group::text));
  if not v_idem.out_is_new then return v_idem.out_response; end if;

  select * into b from group_bookings where id = p_group for update;
  select * into c from company_accounts where id = b.company_id;
  if not found or (c.discount_percent <= 0 and not exists (select 1 from company_room_rates where company_id = c.id)) then raise exception 'POLICY_VIOLATION: no company rate' using errcode = 'P0001'; end if;

  for r in select v.* from group_rooming gr join reservations v on v.id = gr.reservation_id where gr.group_id = b.id order by v.created_at, v.id for update of v loop
    if apply_company_rate_to_reservation(c.id, b.id, r.id, p_key, g.o_tenant, g.o_actor) then v_applied := v_applied + 1; else v_skipped := v_skipped + 1; end if;
  end loop;
  v_result := jsonb_build_object('applied', v_applied, 'skipped', v_skipped, 'percent', c.discount_percent);
  perform idem_finish(g.o_tenant, 'apply_company_rate', p_key, v_result);
  perform write_audit(g.o_tenant, b.property_id, g.o_actor, 'group.company_rate_applied', 'group', b.id, p_key, v_result);
  return v_result;
end $$;

create function company_set_auto_rate(p_company uuid, p_on boolean) returns void
language plpgsql security definer set search_path = public as $$
declare c company_accounts%rowtype; g record;
begin
  select * into c from company_accounts where id = p_company for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  select * into g from company_guard(c.property_id);
  if p_on is null then raise exception 'POLICY_VIOLATION: details' using errcode = 'P0001'; end if;
  if c.auto_apply_rate = p_on then return; end if;
  update company_accounts set auto_apply_rate = p_on where id = c.id;
  perform write_audit(g.o_tenant, c.property_id, g.o_actor, 'company.auto_rate_set', 'company', c.id, null, jsonb_build_object('auto_apply_rate', p_on));
end $$;

create or replace function link_rooming_reservation(p_entry uuid, p_reference text) returns void
language plpgsql security definer set search_path = public as $$
declare r group_rooming%rowtype; b group_bookings%rowtype; g record; v_ref text := upper(btrim(coalesce(p_reference, ''))); v_res reservations%rowtype; c company_accounts%rowtype;
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
  if b.company_id is not null then
    select * into c from company_accounts where id = b.company_id;
    if c.auto_apply_rate and c.status = 'active'
       and (c.discount_percent > 0 or exists (select 1 from company_room_rates where company_id = c.id)) then
      perform apply_company_rate_to_reservation(c.id, b.id, v_res.id, null, g.o_tenant, g.o_actor);
    end if;
  end if;
end $$;

-- company_list again, with the switch.
create or replace function company_list(p_property uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not (has_permission(p_property, 'group.manage') or has_permission(p_property, 'company.manage')) then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'billing_contact', c.billing_contact, 'billing_email', c.billing_email,
           'billing_phone', c.billing_phone, 'credit_days', c.credit_days, 'discount_percent', c.discount_percent, 'status', c.status, 'notes', c.notes,
           'groups', (select count(*) from group_bookings b where b.company_id = c.id),
           'credit_limit_minor', c.credit_limit_minor, 'auto_apply_rate', c.auto_apply_rate,
           'rates', (select coalesce(jsonb_agg(jsonb_build_object('room_type_id', rr.room_type_id, 'room_type_name', t.name, 'mode', rr.mode,
                                'nightly_rate_minor', rr.nightly_rate_minor, 'percent', rr.percent) order by t.name), '[]'::jsonb)
                       from company_room_rates rr join room_types t on t.id = rr.room_type_id where rr.company_id = c.id),
           'exposure_minor', (select coalesce(sum(i.total_minor), 0) from group_invoices i join group_bookings b on b.id = i.group_id where b.company_id = c.id and i.invoice_status = 'issued'),
           'overdue_minor', (select coalesce(sum(i.total_minor), 0) from group_invoices i join group_bookings b on b.id = i.group_id
                              where b.company_id = c.id and i.invoice_status = 'issued' and i.due_date < property_today(c.property_id))) order by (c.status = 'active') desc, lower(c.name))
         from company_accounts c where c.property_id = p_property), '[]'::jsonb);
end $$;

do $$ declare f text; begin
  foreach f in array array['company_set_auto_rate(uuid, boolean)', 'company_list(uuid)', 'apply_company_rate_to_group(uuid, text)', 'link_rooming_reservation(uuid, text)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
