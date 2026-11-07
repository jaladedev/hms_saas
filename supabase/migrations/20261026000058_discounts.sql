-- 058 A percentage discount on a booking, capped by role.
--
-- The permission discount.apply and the column reservations.discount_minor have existed since the start (the totals check,
-- the invoice header and the cancellation maths already allow for a discount) but nothing could set one. This adds it.
--
-- Rules chosen:
--   * A discount is a percentage of the booking's whole price before the discount (room price plus tax), rounded to a whole
--     kobo. 100% makes a free stay. The tax lines on the nights are NOT changed: the discount sits on the booking, and the
--     invoice shows it on its header (subtotal + tax - discount = total), as the invoice and totals checks were built to.
--     Whether tax should be charged on the discounted price is a question for the tax adviser (TODO), not decided here.
--   * Setting a discount REPLACES any earlier one (it does not stack); 0 removes it. A reason is required either way.
--   * Only a booking with no money on it: the same guard update_reservation_stay uses. Confirmed, no payment recorded, no live
--     invoice (void it first), no payment in progress. So no paid amount can be left above the new total and no issued
--     invoice goes out of step with the booking.
--   * Who, and how much: discount.apply is held by the owner, the general manager and (new here) front desk. Each role has a
--     cap in discount_caps: owner and general manager 100, front desk 10. A person with several roles gets the highest cap.
--     A role with the permission and no row in discount_caps can discount nothing. The caps have no screen yet: change them
--     in SQL (the table is read-only to clients), and say so in HANDOFF.
--   * After a discount, update_reservation_stay still refuses to change the dates (it already did for any discount): remove
--     the discount, change the dates, apply it again.
--   * Each change is audited (reservation.discount_changed) with the old and new percent and amount and the reason.

alter table reservations add column discount_percent numeric(5, 2) check (discount_percent is null or (discount_percent > 0 and discount_percent <= 100));
alter table reservations add column discount_reason text check (discount_reason is null or length(discount_reason) <= 200);
alter table reservations add constraint reservations_discount_pair_check check ((discount_minor = 0) = (discount_percent is null));

create table discount_caps (
  role_key    text primary key references roles (key),
  max_percent numeric(5, 2) not null check (max_percent >= 0 and max_percent <= 100)
);
insert into discount_caps (role_key, max_percent) values ('owner', 100), ('general_manager', 100), ('front_desk', 10);
alter table discount_caps enable row level security;
create policy discount_caps_read on discount_caps for select to authenticated using (true);
revoke all on discount_caps from anon;
revoke insert, update, delete on discount_caps from authenticated;

insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r, permissions p where r.key = 'front_desk' and p.key = 'discount.apply';

create function apply_discount(p_reservation_id uuid, p_percent numeric, p_reason text, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r reservations%rowtype; v_actor uuid; v_idem record; v_hash text; v_reason text := nullif(btrim(p_reason), '');
  v_cap numeric; v_new bigint; v_old_pct numeric; v_old bigint; v_result jsonb;
begin
  select * into r from reservations where id = p_reservation_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(r.property_id, 'discount.apply', 'NOT_FOUND');
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;   -- a person, never the system

  if p_percent is null or p_percent < 0 or p_percent > 100 or p_percent <> round(p_percent, 2) then
    raise exception 'POLICY_VIOLATION: percent' using errcode = 'P0001';
  end if;
  if v_reason is null or length(v_reason) > 200 then raise exception 'POLICY_VIOLATION: reason' using errcode = 'P0001'; end if;

  select coalesce(max(c.max_percent), 0) into v_cap
    from tenant_memberships m
    join membership_roles mr on mr.membership_id = m.id
    join roles ro on ro.id = mr.role_id
    join discount_caps c on c.role_key = ro.key
   where m.user_id = v_actor and m.tenant_id = r.tenant_id and m.status = 'active'
     and (mr.property_id is null or mr.property_id = r.property_id);
  if p_percent > v_cap then raise exception 'POLICY_VIOLATION: discount limit %', v_cap using errcode = 'P0001'; end if;

  v_hash := md5(concat_ws('|', p_reservation_id, p_percent, v_reason));
  select * into v_idem from idem_begin(r.tenant_id, 'apply_discount', p_idempotency_key, v_hash);
  if not v_idem.out_is_new then return v_idem.out_response; end if;

  -- the booking row first: this serialises discounts with edits, cancellations, payments and invoices on one booking
  select * into r from reservations where id = p_reservation_id for update;
  if r.reservation_status <> 'confirmed' then raise exception 'INVALID_STATE: %', r.reservation_status using errcode = 'P0001'; end if;
  if exists (select 1 from payments where reservation_id = r.id) then raise exception 'INVALID_STATE: money held' using errcode = 'P0001'; end if;
  if exists (select 1 from invoices where reservation_id = r.id and invoice_status <> 'void') then raise exception 'INVALID_STATE: invoice' using errcode = 'P0001'; end if;
  if exists (select 1 from payment_attempts where reservation_id = r.id and status = 'initiated') then raise exception 'INVALID_STATE: payment in progress' using errcode = 'P0001'; end if;

  v_old_pct := coalesce(r.discount_percent, 0);
  v_old := r.discount_minor;
  v_new := round((r.subtotal_minor + r.tax_minor) * p_percent / 100)::bigint;

  if v_old_pct = p_percent then
    v_result := jsonb_build_object('reservation_id', r.id, 'changed', false, 'discount_percent', p_percent, 'discount_minor', r.discount_minor, 'total_minor', r.total_minor);
    perform idem_finish(r.tenant_id, 'apply_discount', p_idempotency_key, v_result);
    return v_result;
  end if;

  update reservations set discount_minor = v_new, discount_percent = nullif(p_percent, 0),
         discount_reason = case when p_percent > 0 then v_reason end,
         total_minor = subtotal_minor + tax_minor - v_new
   where id = r.id returning * into r;

  v_result := jsonb_build_object('reservation_id', r.id, 'changed', true, 'discount_percent', p_percent, 'discount_minor', r.discount_minor, 'total_minor', r.total_minor);
  perform idem_finish(r.tenant_id, 'apply_discount', p_idempotency_key, v_result);
  perform write_audit(r.tenant_id, r.property_id, v_actor, 'reservation.discount_changed', 'reservation', r.id, p_idempotency_key,
                      jsonb_build_object('reason', v_reason, 'from_percent', v_old_pct, 'to_percent', p_percent,
                                         'from_discount_minor', v_old, 'to_discount_minor', r.discount_minor, 'to_total_minor', r.total_minor));
  return v_result;
end $$;

revoke all on function apply_discount(uuid, numeric, text, text) from public, anon;
grant execute on function apply_discount(uuid, numeric, text, text) to authenticated;
