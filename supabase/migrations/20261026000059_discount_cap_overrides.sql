-- 059 Discount limits for each hotel, with a screen to change them.
--
-- 058 keeps the largest discount each role may give in discount_caps, one row per role, with no screen: it is a single table
-- shared by every hotel, so it cannot be handed to a hotel's owner without letting them change every other hotel's limits.
-- This leaves discount_caps as the platform's DEFAULTS and adds a hotel's own say on top:
--   * discount_cap_overrides: for one hotel and one role, a limit that replaces the default for that hotel. No row means the
--     default applies. Read by people who can discount or manage staff at that hotel, written only by set_discount_cap.
--   * set_discount_cap(hotel, role, percent): the owner (staff.manage, so a general manager cannot raise their own limit) sets
--     a role's limit for this hotel, 0 to 100 with at most two decimals; a null percent removes the override and the role
--     goes back to the default. Only a role that holds discount.apply can be given one (POLICY_VIOLATION: role). One audit row
--     per real change (discount_cap.set) with the effective limit before and after.
--   * apply_discount reads the limit as: the hotel's override if there is one, otherwise the default, and a person with
--     several roles gets the highest of those. Nothing else in it changes.
-- Errors: NOT_FOUND, POLICY_VIOLATION: percent | role.

create table discount_cap_overrides (
  property_id uuid not null,
  tenant_id   uuid not null,
  role_key    text not null references roles (key),
  max_percent numeric(5, 2) not null check (max_percent >= 0 and max_percent <= 100),
  updated_by  uuid references auth.users (id) on delete set null,
  updated_at  timestamptz not null default now(),
  primary key (property_id, role_key),
  foreign key (tenant_id, property_id) references properties (tenant_id, id)
);
alter table discount_cap_overrides enable row level security;
create policy discount_cap_overrides_select on discount_cap_overrides for select to authenticated
  using (has_permission(property_id, 'discount.apply') or has_permission(property_id, 'staff.manage'));
revoke all on discount_cap_overrides from anon;
revoke insert, update, delete on discount_cap_overrides from authenticated;

create function set_discount_cap(p_property_id uuid, p_role_key text, p_percent numeric) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_prop properties%rowtype; v_actor uuid; v_default numeric; v_override numeric; v_before numeric; v_after numeric;
begin
  select * into v_prop from properties where id = p_property_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(p_property_id, 'staff.manage', 'NOT_FOUND');
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;   -- a person, never the system
  if p_percent is not null and (p_percent < 0 or p_percent > 100 or p_percent <> round(p_percent, 2)) then
    raise exception 'POLICY_VIOLATION: percent' using errcode = 'P0001';
  end if;
  if p_role_key is null or not exists (select 1 from roles ro join role_permissions rp on rp.role_id = ro.id
                                         join permissions p on p.id = rp.permission_id
                                        where ro.key = p_role_key and p.key = 'discount.apply') then
    raise exception 'POLICY_VIOLATION: role' using errcode = 'P0001';
  end if;

  select max_percent into v_default from discount_caps where role_key = p_role_key;
  select max_percent into v_override from discount_cap_overrides where property_id = p_property_id and role_key = p_role_key;
  v_before := coalesce(v_override, v_default, 0);

  if p_percent is null then
    delete from discount_cap_overrides where property_id = p_property_id and role_key = p_role_key;
    v_after := coalesce(v_default, 0);
  else
    insert into discount_cap_overrides (property_id, tenant_id, role_key, max_percent, updated_by)
    values (p_property_id, v_prop.tenant_id, p_role_key, p_percent, v_actor)
    on conflict (property_id, role_key) do update set max_percent = excluded.max_percent, updated_by = v_actor, updated_at = now();
    v_after := p_percent;
  end if;

  if v_after is distinct from v_before then
    perform write_audit(v_prop.tenant_id, p_property_id, v_actor, 'discount_cap.set', 'discount_cap', null, null,
                        jsonb_build_object('role', p_role_key, 'from_percent', v_before::numeric(5, 2), 'to_percent', v_after::numeric(5, 2), 'reset_to_default', p_percent is null));
  end if;
  return jsonb_build_object('role', p_role_key, 'percent', v_after, 'source', case when p_percent is null then 'default' else 'override' end);
end $$;
revoke all on function set_discount_cap(uuid, text, numeric) from public, anon;
grant execute on function set_discount_cap(uuid, text, numeric) to authenticated;

create or replace function apply_discount(p_reservation_id uuid, p_percent numeric, p_reason text, p_idempotency_key text)
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

  select coalesce(max(coalesce(o.max_percent, c.max_percent)), 0) into v_cap
    from tenant_memberships m
    join membership_roles mr on mr.membership_id = m.id
    join roles ro on ro.id = mr.role_id
    left join discount_caps c on c.role_key = ro.key
    left join discount_cap_overrides o on o.property_id = r.property_id and o.role_key = ro.key
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
