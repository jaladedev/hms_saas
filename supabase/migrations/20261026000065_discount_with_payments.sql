-- 065 Discounts on a booking that already has money on it.
--
-- 058 and 062 refused any discount once a payment existed ("money held"), so a guest who had paid a deposit could not be
-- given one. Now a discount (percentage or amount) may be set, changed or removed on a confirmed booking with payments as
-- long as the booking's NEW price is still at least what the guest has paid (succeeded payments, reservation_money_held):
-- otherwise POLICY_VIOLATION: below paid. So no surplus can appear and no refund is created or needed; a bigger discount
-- than that needs a refund first (or a smaller discount). The payment status (unpaid / partially paid / paid) is recomputed
-- against the new total. Still refused: a live invoice (void it first; an invoice with payments cannot be voided), a payment in
-- progress, and any status but confirmed. Removing a discount raises the price, which only raises the balance.
-- Both functions are 062's with the money-held guard replaced by the below-paid check.

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

  -- 065: money already taken is allowed, as long as the new price still covers it (no refund is created here)
  if reservation_money_held(r.id) > r.subtotal_minor + r.tax_minor - v_new then raise exception 'POLICY_VIOLATION: below paid' using errcode = 'P0001'; end if;
  update reservations set discount_minor = v_new, discount_percent = nullif(p_percent, 0), discount_amount_minor = null,
         discount_reason = case when p_percent > 0 then v_reason end,
         total_minor = subtotal_minor + tax_minor - v_new
   where id = r.id returning * into r;

  perform refresh_reservation_payment_status(r.id);
  v_result := jsonb_build_object('reservation_id', r.id, 'changed', true, 'discount_percent', p_percent, 'discount_minor', r.discount_minor, 'total_minor', r.total_minor);
  perform idem_finish(r.tenant_id, 'apply_discount', p_idempotency_key, v_result);
  perform write_audit(r.tenant_id, r.property_id, v_actor, 'reservation.discount_changed', 'reservation', r.id, p_idempotency_key,
                      jsonb_build_object('reason', v_reason, 'from_percent', v_old_pct, 'to_percent', p_percent,
                                         'from_discount_minor', v_old, 'to_discount_minor', r.discount_minor, 'to_total_minor', r.total_minor));
  return v_result;
end $$;

create or replace function apply_discount_amount(p_reservation_id uuid, p_amount_minor bigint, p_reason text, p_idempotency_key text)
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

  -- 065: money already taken is allowed, as long as the new price still covers it (no refund is created here)
  if reservation_money_held(r.id) > r.subtotal_minor + r.tax_minor - p_amount_minor then raise exception 'POLICY_VIOLATION: below paid' using errcode = 'P0001'; end if;
  update reservations set discount_minor = p_amount_minor, discount_percent = null, discount_amount_minor = nullif(p_amount_minor, 0),
         discount_reason = case when p_amount_minor > 0 then v_reason end,
         total_minor = subtotal_minor + tax_minor - p_amount_minor
   where id = r.id returning * into r;

  perform refresh_reservation_payment_status(r.id);
  v_result := jsonb_build_object('reservation_id', r.id, 'changed', true, 'discount_amount_minor', p_amount_minor, 'discount_minor', r.discount_minor, 'total_minor', r.total_minor);
  perform idem_finish(r.tenant_id, 'apply_discount_amount', p_idempotency_key, v_result);
  perform write_audit(r.tenant_id, r.property_id, v_actor, 'reservation.discount_changed', 'reservation', r.id, p_idempotency_key,
                      jsonb_build_object('reason', v_reason, 'kind', 'amount', 'from_percent', v_old_pct, 'from_discount_minor', v_old,
                                         'to_discount_minor', r.discount_minor, 'to_total_minor', r.total_minor));
  return v_result;
end $$;

revoke all on function apply_discount(uuid, numeric, text, text), apply_discount_amount(uuid, bigint, text, text) from public, anon;
grant execute on function apply_discount(uuid, numeric, text, text), apply_discount_amount(uuid, bigint, text, text) to authenticated;
