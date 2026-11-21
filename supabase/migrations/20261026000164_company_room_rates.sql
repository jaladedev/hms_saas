-- 164 Group bookings, step eight (TODO 8.7): corporate rates per room type.
--
-- A company account (155) can now carry an agreed rate for a room type, in addition to its flat discount percent:
--   mode 'fixed'    the agreed nightly price for that room type (before tax). A night priced at or below it gets no discount; a dearer night is
--                   brought down to it, with the tax scaled by the same ratio (so the company pays the agreed price plus the usual tax share).
--   mode 'percent'  a percent off that room type's nights (0.01 to 50), tax included, like the flat discount.
-- A room type without its own rate falls back to the company's flat percent. One rate per company and room type; company.manage sets and removes
-- them (owner, general manager), audited.
-- It is applied by the same action as the flat rate: apply_company_rate_to_group (155). For each linked booking the discount is worked out night by
-- night (company_booking_discount) and stored as a FIXED-AMOUNT discount on the booking through the same columns and guards as apply_discount_amount
-- (062): only a confirmed booking with no discount, payment, live invoice or payment in progress; others are skipped, never replaced; a booking that
-- gains nothing is skipped. A booking with no room-type rate in play keeps the flat-percent behaviour of 155 exactly. A rate changed later does not
-- touch bookings that already have a discount. Rates are NOT applied automatically when a booking is made.
-- company_list returns each company's rates.

create table company_room_rates (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null,
  property_id        uuid not null,
  company_id         uuid not null,
  room_type_id       uuid not null,
  mode               text not null check (mode in ('fixed', 'percent')),
  nightly_rate_minor bigint check (nightly_rate_minor is null or (nightly_rate_minor >= 1 and nightly_rate_minor <= 1000000000000)),
  percent            numeric(5, 2) check (percent is null or (percent > 0 and percent <= 50)),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  foreign key (company_id, property_id) references company_accounts (id, property_id),
  foreign key (tenant_id, property_id, room_type_id) references room_types (tenant_id, property_id, id),
  unique (company_id, room_type_id),
  check ((mode = 'fixed' and nightly_rate_minor is not null and percent is null) or (mode = 'percent' and percent is not null and nightly_rate_minor is null))
);
create trigger company_room_rates_updated before update on company_room_rates for each row execute function set_updated_at();
alter table company_room_rates enable row level security;
create policy company_room_rates_select on company_room_rates for select to authenticated
  using (has_permission(property_id, 'group.manage') or has_permission(property_id, 'company.manage'));
revoke insert, update, delete on company_room_rates from authenticated, anon;

create function company_rate_set(p_company uuid, p_room_type uuid, p_mode text, p_value numeric) returns void
language plpgsql security definer set search_path = public as $$
declare c company_accounts%rowtype; g record;
begin
  select * into c from company_accounts where id = p_company for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  select * into g from company_guard(c.property_id);
  if p_mode is null or p_mode not in ('fixed', 'percent') or p_value is null or p_value <= 0
     or (p_mode = 'fixed' and (p_value <> trunc(p_value) or p_value > 1000000000000))
     or (p_mode = 'percent' and (p_value > 50 or p_value <> round(p_value, 2)))
     or not exists (select 1 from room_types where id = p_room_type and property_id = c.property_id and status = 'active') then
    raise exception 'POLICY_VIOLATION: details' using errcode = 'P0001';
  end if;
  insert into company_room_rates (tenant_id, property_id, company_id, room_type_id, mode, nightly_rate_minor, percent)
  values (c.tenant_id, c.property_id, c.id, p_room_type, p_mode, case when p_mode = 'fixed' then p_value::bigint end, case when p_mode = 'percent' then p_value end)
  on conflict (company_id, room_type_id) do update set mode = excluded.mode, nightly_rate_minor = excluded.nightly_rate_minor, percent = excluded.percent;
  perform write_audit(g.o_tenant, c.property_id, g.o_actor, 'company.rate_set', 'company', c.id, null, jsonb_build_object('room_type_id', p_room_type, 'mode', p_mode, 'value', p_value));
end $$;

create function company_rate_remove(p_company uuid, p_room_type uuid) returns void
language plpgsql security definer set search_path = public as $$
declare c company_accounts%rowtype; g record;
begin
  select * into c from company_accounts where id = p_company for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  select * into g from company_guard(c.property_id);
  delete from company_room_rates where company_id = c.id and room_type_id = p_room_type;
  if found then
    perform write_audit(g.o_tenant, c.property_id, g.o_actor, 'company.rate_removed', 'company', c.id, null, jsonb_build_object('room_type_id', p_room_type));
  end if;
end $$;

-- What the company's rates take off one booking, night by night. typed is true when a room-type rate applied to at least one night.
create function company_booking_discount(p_company uuid, p_reservation uuid) returns table (amount_minor bigint, typed boolean)
language sql stable security definer set search_path = public as $$
  with c as (select discount_percent from company_accounts where id = p_company),
  n as (
    select nt.rate_minor, nt.tax_minor, rr.mode, rr.nightly_rate_minor, rr.percent as type_percent
      from reservation_nights nt
      join reservation_rooms x on x.id = nt.reservation_room_id and x.room_status <> 'cancelled'
      left join company_room_rates rr on rr.company_id = p_company and rr.room_type_id = x.room_type_id
     where x.reservation_id = p_reservation)
  select coalesce(sum(case
           when n.mode = 'fixed' then case when n.nightly_rate_minor < n.rate_minor
                                           then (n.rate_minor + n.tax_minor) - round((n.rate_minor + n.tax_minor) * n.nightly_rate_minor::numeric / n.rate_minor)::bigint else 0 end
           when n.mode = 'percent' then round((n.rate_minor + n.tax_minor) * n.type_percent / 100)::bigint
           else round((n.rate_minor + n.tax_minor) * (select discount_percent from c) / 100)::bigint end), 0)::bigint,
         coalesce(bool_or(n.mode is not null), false)
    from n
$$;
revoke all on function company_booking_discount(uuid, uuid) from public, anon, authenticated;

-- company_list again, with the rates.
create or replace function company_list(p_property uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not (has_permission(p_property, 'group.manage') or has_permission(p_property, 'company.manage')) then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'billing_contact', c.billing_contact, 'billing_email', c.billing_email,
           'billing_phone', c.billing_phone, 'credit_days', c.credit_days, 'discount_percent', c.discount_percent, 'status', c.status, 'notes', c.notes,
           'groups', (select count(*) from group_bookings b where b.company_id = c.id),
           'credit_limit_minor', c.credit_limit_minor,
           'rates', (select coalesce(jsonb_agg(jsonb_build_object('room_type_id', rr.room_type_id, 'room_type_name', t.name, 'mode', rr.mode,
                                'nightly_rate_minor', rr.nightly_rate_minor, 'percent', rr.percent) order by t.name), '[]'::jsonb)
                       from company_room_rates rr join room_types t on t.id = rr.room_type_id where rr.company_id = c.id),
           'exposure_minor', (select coalesce(sum(i.total_minor), 0) from group_invoices i join group_bookings b on b.id = i.group_id where b.company_id = c.id and i.invoice_status = 'issued'),
           'overdue_minor', (select coalesce(sum(i.total_minor), 0) from group_invoices i join group_bookings b on b.id = i.group_id
                              where b.company_id = c.id and i.invoice_status = 'issued' and i.due_date < property_today(c.property_id))) order by (c.status = 'active') desc, lower(c.name))
         from company_accounts c where c.property_id = p_property), '[]'::jsonb);
end $$;

-- apply_company_rate_to_group again, with the room-type rates.
create or replace function apply_company_rate_to_group(p_group uuid, p_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_amt bigint; v_typed boolean; b group_bookings%rowtype; g record; c company_accounts%rowtype; v_idem record; v_applied integer := 0; v_skipped integer := 0; r reservations%rowtype; v_new bigint; v_result jsonb;
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
    if r.reservation_status <> 'confirmed' or r.discount_minor > 0
       or exists (select 1 from payments where reservation_id = r.id)
       or exists (select 1 from invoices where reservation_id = r.id and invoice_status <> 'void')
       or exists (select 1 from payment_attempts where reservation_id = r.id and status = 'initiated') then
      v_skipped := v_skipped + 1;
    else
      select d.amount_minor, d.typed into v_amt, v_typed from company_booking_discount(c.id, r.id) d;
      if v_typed then
        -- a room-type rate applies to some night: the discount is the sum over the nights, held as a fixed amount
        v_new := least(v_amt, r.subtotal_minor + r.tax_minor);
        if v_new <= 0 then
          v_skipped := v_skipped + 1;
        else
          update reservations set discount_minor = v_new, discount_percent = null, discount_amount_minor = v_new,
                 discount_reason = left('Company rate: ' || c.name, 200), total_minor = subtotal_minor + tax_minor - v_new where id = r.id;
          perform write_audit(g.o_tenant, b.property_id, g.o_actor, 'reservation.company_rate_applied', 'reservation', r.id, p_key,
                              jsonb_build_object('company', c.name, 'kind', 'room_type_rates', 'discount_minor', v_new, 'group_id', b.id));
          v_applied := v_applied + 1;
        end if;
      elsif c.discount_percent > 0 then
        v_new := round((r.subtotal_minor + r.tax_minor) * c.discount_percent / 100)::bigint;
        update reservations set discount_minor = v_new, discount_percent = c.discount_percent, discount_reason = left('Company rate: ' || c.name, 200),
               total_minor = subtotal_minor + tax_minor - v_new where id = r.id;
        perform write_audit(g.o_tenant, b.property_id, g.o_actor, 'reservation.company_rate_applied', 'reservation', r.id, p_key,
                            jsonb_build_object('company', c.name, 'percent', c.discount_percent, 'discount_minor', v_new, 'group_id', b.id));
        v_applied := v_applied + 1;
      else
        v_skipped := v_skipped + 1;
      end if;
    end if;
  end loop;
  v_result := jsonb_build_object('applied', v_applied, 'skipped', v_skipped, 'percent', c.discount_percent);
  perform idem_finish(g.o_tenant, 'apply_company_rate', p_key, v_result);
  perform write_audit(g.o_tenant, b.property_id, g.o_actor, 'group.company_rate_applied', 'group', b.id, p_key, v_result);
  return v_result;
end $$;

-- group_detail again, with the company account.

do $$ declare f text; begin
  foreach f in array array['company_rate_set(uuid, uuid, text, numeric)', 'company_rate_remove(uuid, uuid)', 'company_list(uuid)', 'apply_company_rate_to_group(uuid, text)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
