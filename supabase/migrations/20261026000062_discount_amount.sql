-- 062 A discount given as a fixed naira amount.
--
-- 058 and 059 let staff take a percentage off a booking, capped per role. A hotel also gives "₦5,000 off". This adds it.
--   * apply_discount_amount(reservation, amount in kobo, reason, key): sets the discount to exactly that amount; 0 removes it.
--     It REPLACES any earlier discount of either kind (one discount per booking, percent or amount, never both).
--   * The limit is the same limit, read the same way: a role's cap is a percentage of the booking's price, so an amount is
--     allowed when it is no more than that percentage of the price (room price plus tax, before the discount). Owner 100%
--     means any amount up to the whole price; front desk 10% means up to a tenth of it. No new table, no new setting.
--   * The amount cannot be more than the price (the total would go below zero).
--   * Everything else is as in 058: confirmed booking, no payment, no live invoice, no payment in progress; the tax lines stay
--     as they are and the discount comes off the total; audited as reservation.discount_changed with the amount.
--   * reservations.discount_amount_minor holds the amount entered (null for a percentage discount). A discount is either a
--     percentage or an amount: exactly one of discount_percent and discount_amount_minor is set when there is a discount, and
--     neither when there is not.
-- apply_discount (percent) is replaced with its 059 body plus two changes: it uses the shared limit lookup, and it clears an
-- amount discount when it replaces or removes one (before, "0" on a booking with an amount discount would have said
-- "already in place"). The limit lookup moves into discount_cap_for so both functions read it the same way.

alter table reservations add column discount_amount_minor bigint check (discount_amount_minor is null or discount_amount_minor > 0);
alter table reservations drop constraint reservations_discount_pair_check;
alter table reservations add constraint reservations_discount_pair_check
  check ((discount_minor = 0) = (discount_percent is null and discount_amount_minor is null) and (discount_percent is null or discount_amount_minor is null));

create function discount_cap_for(p_user uuid, p_tenant uuid, p_property uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(max(coalesce(o.max_percent, c.max_percent)), 0)
    from tenant_memberships m
    join membership_roles mr on mr.membership_id = m.id
    join roles ro on ro.id = mr.role_id
    left join discount_caps c on c.role_key = ro.key
    left join discount_cap_overrides o on o.property_id = p_property and o.role_key = ro.key
   where m.user_id = p_user and m.tenant_id = p_tenant and m.status = 'active'
     and (mr.property_id is null or mr.property_id = p_property)
$$;
revoke all on function discount_cap_for(uuid, uuid, uuid) from public, anon, authenticated;

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

  v_cap := discount_cap_for(v_actor, r.tenant_id, r.property_id);
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

  -- unchanged only when this booking already has exactly this percentage (an amount discount is a different thing)
  if v_old_pct = p_percent and r.discount_amount_minor is null then
    v_result := jsonb_build_object('reservation_id', r.id, 'changed', false, 'discount_percent', p_percent, 'discount_minor', r.discount_minor, 'total_minor', r.total_minor);
    perform idem_finish(r.tenant_id, 'apply_discount', p_idempotency_key, v_result);
    return v_result;
  end if;

  update reservations set discount_minor = v_new, discount_percent = nullif(p_percent, 0), discount_amount_minor = null,
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

create function apply_discount_amount(p_reservation_id uuid, p_amount_minor bigint, p_reason text, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r reservations%rowtype; v_actor uuid; v_idem record; v_hash text; v_reason text := nullif(btrim(p_reason), '');
  v_cap numeric; v_base bigint; v_old bigint; v_old_pct numeric; v_result jsonb;
begin
  select * into r from reservations where id = p_reservation_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(r.property_id, 'discount.apply', 'NOT_FOUND');
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;

  if p_amount_minor is null or p_amount_minor < 0 then raise exception 'POLICY_VIOLATION: amount' using errcode = 'P0001'; end if;
  if v_reason is null or length(v_reason) > 200 then raise exception 'POLICY_VIOLATION: reason' using errcode = 'P0001'; end if;
  v_base := r.subtotal_minor + r.tax_minor;
  if p_amount_minor > v_base then raise exception 'POLICY_VIOLATION: amount' using errcode = 'P0001'; end if;

  v_cap := discount_cap_for(v_actor, r.tenant_id, r.property_id);
  if p_amount_minor * 100 > v_cap * v_base then raise exception 'POLICY_VIOLATION: discount limit %', v_cap using errcode = 'P0001'; end if;

  v_hash := md5(concat_ws('|', p_reservation_id, p_amount_minor, v_reason));
  select * into v_idem from idem_begin(r.tenant_id, 'apply_discount_amount', p_idempotency_key, v_hash);
  if not v_idem.out_is_new then return v_idem.out_response; end if;

  select * into r from reservations where id = p_reservation_id for update;
  if r.reservation_status <> 'confirmed' then raise exception 'INVALID_STATE: %', r.reservation_status using errcode = 'P0001'; end if;
  if exists (select 1 from payments where reservation_id = r.id) then raise exception 'INVALID_STATE: money held' using errcode = 'P0001'; end if;
  if exists (select 1 from invoices where reservation_id = r.id and invoice_status <> 'void') then raise exception 'INVALID_STATE: invoice' using errcode = 'P0001'; end if;
  if exists (select 1 from payment_attempts where reservation_id = r.id and status = 'initiated') then raise exception 'INVALID_STATE: payment in progress' using errcode = 'P0001'; end if;

  v_old := r.discount_minor;
  v_old_pct := coalesce(r.discount_percent, 0);

  -- unchanged: the same amount is already set, or 0 is asked and there is no discount at all
  if (p_amount_minor = 0 and r.discount_minor = 0) or (p_amount_minor > 0 and r.discount_amount_minor = p_amount_minor) then
    v_result := jsonb_build_object('reservation_id', r.id, 'changed', false, 'discount_amount_minor', p_amount_minor, 'discount_minor', r.discount_minor, 'total_minor', r.total_minor);
    perform idem_finish(r.tenant_id, 'apply_discount_amount', p_idempotency_key, v_result);
    return v_result;
  end if;

  update reservations set discount_minor = p_amount_minor, discount_percent = null, discount_amount_minor = nullif(p_amount_minor, 0),
         discount_reason = case when p_amount_minor > 0 then v_reason end,
         total_minor = subtotal_minor + tax_minor - p_amount_minor
   where id = r.id returning * into r;

  v_result := jsonb_build_object('reservation_id', r.id, 'changed', true, 'discount_amount_minor', p_amount_minor, 'discount_minor', r.discount_minor, 'total_minor', r.total_minor);
  perform idem_finish(r.tenant_id, 'apply_discount_amount', p_idempotency_key, v_result);
  perform write_audit(r.tenant_id, r.property_id, v_actor, 'reservation.discount_changed', 'reservation', r.id, p_idempotency_key,
                      jsonb_build_object('reason', v_reason, 'kind', 'amount', 'from_percent', v_old_pct, 'from_discount_minor', v_old,
                                         'to_discount_minor', r.discount_minor, 'to_total_minor', r.total_minor));
  return v_result;
end $$;

revoke all on function apply_discount(uuid, numeric, text, text), apply_discount_amount(uuid, bigint, text, text) from public, anon;
grant execute on function apply_discount(uuid, numeric, text, text), apply_discount_amount(uuid, bigint, text, text) to authenticated;

-- ---- early check-out and early check-in (060, 061) keep a fixed amount: it stays, capped at the new price -----------
-- What the booking would cost after crediting the given nights of one room (discount re-applied).
create or replace function early_checkout_new_totals(p_reservation uuid, p_reservation_room uuid, p_today date, p_mode text)
returns table (subtotal bigint, tax bigint, discount bigint, total bigint, nights_credited integer)
language plpgsql stable security definer set search_path = public as $$
declare r reservations%rowtype; v_sub bigint; v_tax bigint; v_disc bigint := 0; v_n integer;
begin
  select * into r from reservations where id = p_reservation;
  select coalesce(sum(n.rate_minor), 0), coalesce(sum(n.tax_minor), 0) into v_sub, v_tax
    from reservation_nights n join reservation_rooms x on x.id = n.reservation_room_id
   where x.reservation_id = r.id
     and n.id not in (select c.id from early_credit_nights(p_reservation_room, p_today, p_mode) c);
  select count(*) into v_n from early_credit_nights(p_reservation_room, p_today, p_mode);
  if r.discount_percent is not null and v_sub + v_tax > 0 then v_disc := round((v_sub + v_tax) * r.discount_percent / 100)::bigint; end if;
  if r.discount_amount_minor is not null then v_disc := least(r.discount_amount_minor, v_sub + v_tax); end if;
  return query select v_sub, v_tax, v_disc, v_sub + v_tax - v_disc, v_n;
end $$;
revoke all on function early_checkout_new_totals(uuid, uuid, date, text) from public, anon, authenticated;


create or replace function early_checkout_apply(p_reservation uuid, p_reservation_room uuid, p_today date, p_mode text, p_actor uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r reservations%rowtype; t record; v_old_total bigint; v_inv uuid; v_new uuid; v_year integer; v_n integer; v_number text; v_prop record;
  v_held bigint; v_live bigint; v_credit bigint; v_surplus bigint := 0; v_alloc bigint; v_nights date[];
begin
  select * into r from reservations where id = p_reservation for update;
  select * into t from early_checkout_new_totals(p_reservation, p_reservation_room, p_today, p_mode);
  if t.nights_credited = 0 then
    return jsonb_build_object('credit_minor', 0, 'nights_credited', 0);
  end if;
  v_old_total := r.total_minor;
  select array_agg(night_date order by night_date) into v_nights from early_credit_nights(p_reservation_room, p_today, p_mode);

  delete from reservation_nights where id in (select c.id from early_credit_nights(p_reservation_room, p_today, p_mode) c);
  update reservations set subtotal_minor = t.subtotal, tax_minor = t.tax, discount_minor = t.discount,
         discount_percent = case when t.discount > 0 then discount_percent else null end,
         discount_amount_minor = case when t.discount > 0 then discount_amount_minor else null end,
         discount_reason = case when t.discount > 0 then discount_reason else null end,
         total_minor = t.total, early_checkout_credit_minor = early_checkout_credit_minor + (v_old_total - t.total)
   where id = r.id;
  v_credit := v_old_total - t.total;

  -- a live invoice is for the old total: replace it with one for what remains
  select id into v_inv from invoices where reservation_id = r.id and invoice_status <> 'void';
  if v_inv is not null then
    update invoices set invoice_status = 'void', void_reason = 'early check-out', voided_at = now(), voided_by = p_actor where id = v_inv;
    if t.subtotal + t.tax > 0 then
      select code, check_in_time, timezone into v_prop from properties where id = r.property_id;
      v_year := extract(year from property_today(r.property_id))::integer;
      insert into invoice_sequences (property_id, year, last_number) values (r.property_id, v_year, 1)
      on conflict (property_id, year) do update set last_number = invoice_sequences.last_number + 1
      returning last_number into v_n;
      v_number := 'INV-' || v_prop.code || '-' || v_year || '-' || lpad(v_n::text, 6, '0');
      v_new := gen_random_uuid();
      insert into invoices (id, tenant_id, property_id, reservation_id, invoice_number, currency, subtotal_minor, tax_minor, discount_minor, total_minor, due_at, created_by)
      values (v_new, r.tenant_id, r.property_id, r.id, v_number, r.currency, t.subtotal, t.tax, t.discount, t.total,
              (r.arrival_date + v_prop.check_in_time) at time zone v_prop.timezone, p_actor);
      insert into invoice_lines (tenant_id, invoice_id, description, quantity, unit_amount_minor, tax_amount_minor, line_total_minor, service_date)
      select r.tenant_id, v_new, rt.name || ', night of ' || n.night_date, 1, n.rate_minor, n.tax_minor, n.rate_minor + n.tax_minor, n.night_date
        from reservation_nights n join reservation_rooms x on x.id = n.reservation_room_id join room_types rt on rt.id = x.room_type_id
       where x.reservation_id = r.id order by n.night_date, rt.name, x.id;
      v_alloc := allocate_payments_to_invoice(v_new);
    end if;
  end if;

  v_held := reservation_money_held(r.id);
  select coalesce(sum(amount_minor), 0) into v_live from refunds where reservation_id = r.id and refund_status in ('requested', 'approved', 'processing');
  v_surplus := greatest(v_held - v_live - t.total, 0);
  if v_surplus > 0 and r.attention_reason is null then
    update reservations set attention_reason = 'early_checkout_refund_due' where id = r.id;
  end if;
  perform refresh_money_state(r.id);

  perform write_audit(r.tenant_id, r.property_id, p_actor, 'reservation.early_checkout_credited', 'reservation', r.id, null,
                      jsonb_build_object('mode', p_mode, 'reservation_room_id', p_reservation_room, 'nights', to_jsonb(v_nights),
                                         'from_total_minor', v_old_total, 'to_total_minor', t.total, 'credit_minor', v_credit,
                                         'held_minor', v_held, 'surplus_minor', v_surplus,
                                         'invoice_replaced', v_inv is not null and v_new is not null));
  return jsonb_build_object('credit_minor', v_credit, 'nights_credited', t.nights_credited, 'new_total_minor', t.total, 'surplus_minor', v_surplus);
end $$;
revoke all on function early_checkout_apply(uuid, uuid, date, text, uuid) from public, anon, authenticated;

-- The booking's totals once the room has the nights from p_today to the day before arrival (discount re-applied). Raises RATE_MISSING.
create or replace function early_checkin_new_totals(p_reservation uuid, p_reservation_room uuid, p_today date)
returns table (subtotal bigint, tax bigint, discount bigint, total bigint, nights_added integer, added_minor bigint)
language plpgsql stable security definer set search_path = public as $$
declare r reservations%rowtype; rr reservation_rooms%rowtype; v_sub bigint; v_tax bigint; v_disc bigint := 0; v_night date; v_rate record; v_n integer := 0; v_new bigint;
begin
  select * into r from reservations where id = p_reservation;
  select * into rr from reservation_rooms where id = p_reservation_room;
  select coalesce(sum(n.rate_minor), 0), coalesce(sum(n.tax_minor), 0) into v_sub, v_tax
    from reservation_nights n join reservation_rooms x on x.id = n.reservation_room_id where x.reservation_id = r.id;
  for v_night in select generate_series(p_today, r.arrival_date - 1, interval '1 day')::date loop
    select * into v_rate from resolve_rate(r.property_id, rr.room_type_id, rr.rate_plan_id, v_night);
    if v_rate.amount_minor is null then raise exception 'RATE_MISSING' using errcode = 'P0001'; end if;
    v_sub := v_sub + v_rate.amount_minor;
    v_tax := v_tax + calc_night_tax(r.property_id, v_night, v_rate.amount_minor);
    v_n := v_n + 1;
  end loop;
  if r.discount_percent is not null then v_disc := round((v_sub + v_tax) * r.discount_percent / 100)::bigint; end if;
  if r.discount_amount_minor is not null then v_disc := least(r.discount_amount_minor, v_sub + v_tax); end if;
  v_new := v_sub + v_tax - v_disc;
  return query select v_sub, v_tax, v_disc, v_new, v_n, v_new - r.total_minor;
end $$;
revoke all on function early_checkin_new_totals(uuid, uuid, date) from public, anon, authenticated;
