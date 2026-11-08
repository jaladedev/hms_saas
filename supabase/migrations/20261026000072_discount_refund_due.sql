-- 072 A discount may take the price below what the guest has already paid.
--
-- 065 refused that (POLICY_VIOLATION: below paid). Now it is allowed, and the difference is handled the way an early check-out
-- credit is (060): NO refund is created; the booking is flagged `attention_reason = 'discount_refund_due'`, staff are told on the
-- notification inbox, and a person requests the refund from the booking's payments, so the second-person approval stays.
-- The flag is set only when no other reason is already on the booking, and when refunds already requested or paying out cover
-- the difference nothing is flagged. `refresh_money_state` clears it, like the early check-out flag, once the held money less
-- live refunds no longer exceeds the total; changing the discount again re-checks it. The functions answer `refund_due_minor`.
-- apply_discount and apply_discount_amount are 065's without the below-paid refusal; notify_reservation_attention and
-- refresh_money_state are 070's with the new reason.

create or replace function notify_reservation_attention() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_title text; v_body text; v_sev text := 'attention';
begin
  case
    when new.attention_reason = 'paid_inventory_lost' then
      v_title := 'Paid, but the room is gone: ' || new.booking_reference; v_sev := 'urgent';
      v_body := 'The guest paid after the hold lapsed and the room was taken. Arrange another room or a full refund.';
    when new.attention_reason = 'paid_after_cancel' then
      v_title := 'Payment arrived for a cancelled booking: ' || new.booking_reference; v_sev := 'urgent';
      v_body := 'Money was received after the booking was cancelled. Check it and refund it if it is due.';
    when new.attention_reason = 'cancellation_charge_unpaid' then
      v_title := 'Cancellation charge not covered: ' || new.booking_reference;
      v_body := 'The booking was cancelled with a charge larger than what was paid.';
    when new.attention_reason = 'early_checkout_refund_due' then
      v_title := 'Refund due after early check-out: ' || new.booking_reference;
      v_body := 'The guest left early and has paid more than the reduced total. Request a refund for the difference from the settlement page.';
    when new.attention_reason = 'stay_change_refund_due' then
      v_title := 'Refund due after a date change: ' || new.booking_reference;
      v_body := 'The dates were changed and the guest has paid more than the new total. Request a refund for the difference from the booking''s payments.';
    when new.attention_reason = 'discount_refund_due' then
      v_title := 'Refund due after a discount: ' || new.booking_reference;
      v_body := 'A discount took the price below what the guest has paid. Request a refund for the difference from the settlement page.';
    when new.attention_reason like 'payment\_%' then
      v_title := 'A payment needs a look: ' || new.booking_reference;
      v_body := 'Reason: ' || replace(substr(new.attention_reason, 9), '_', ' ') || '.';
    else
      v_title := 'Booking needs attention: ' || new.booking_reference;
      v_body := 'Reason: ' || replace(new.attention_reason, '_', ' ') || '.';
  end case;
  perform enqueue_notification(new.property_id, 'reservation_attention', 'money', v_sev, v_title, v_body,
                               '/app/reservations/' || new.id, 'payment.verify', 'reservation', new.id);
  return null;
end $$;

create or replace function refresh_money_state(p_reservation uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_inv uuid; r reservations%rowtype; v_held bigint; v_live bigint;
begin
  select id into v_inv from invoices where reservation_id = p_reservation and invoice_status <> 'void';
  if v_inv is not null then perform refresh_invoice_status(v_inv); end if;
  perform refresh_reservation_payment_status(p_reservation);
  select * into r from reservations where id = p_reservation;
  if r.reservation_status = 'cancelled' then
    v_held := reservation_money_held(p_reservation);
    if r.cancellation_charge_minor > v_held and r.attention_reason is null then
      update reservations set attention_reason = 'cancellation_charge_unpaid' where id = p_reservation;
    elsif r.cancellation_charge_minor <= v_held and r.attention_reason = 'cancellation_charge_unpaid' then
      update reservations set attention_reason = null where id = p_reservation;
    end if;
  elsif r.attention_reason in ('early_checkout_refund_due', 'stay_change_refund_due', 'discount_refund_due') then
    v_held := reservation_money_held(p_reservation);
    select coalesce(sum(amount_minor), 0) into v_live from refunds
     where reservation_id = p_reservation and refund_status in ('requested', 'approved', 'processing');
    if v_held - v_live <= r.total_minor then update reservations set attention_reason = null where id = p_reservation; end if;
  end if;
end $$;

create or replace function apply_discount(p_reservation_id uuid, p_percent numeric, p_reason text, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r reservations%rowtype; v_actor uuid; v_idem record; v_hash text; v_reason text := nullif(btrim(p_reason), '');
  v_cap numeric; v_new bigint; v_old_pct numeric; v_old bigint; v_result jsonb; v_held bigint; v_live bigint; v_due bigint;
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

  update reservations set discount_minor = v_new, discount_percent = nullif(p_percent, 0), discount_amount_minor = null,
         discount_reason = case when p_percent > 0 then v_reason end,
         total_minor = subtotal_minor + tax_minor - v_new
   where id = r.id returning * into r;

  perform refresh_reservation_payment_status(r.id);
  v_held := reservation_money_held(r.id);
  select coalesce(sum(amount_minor), 0) into v_live from refunds where reservation_id = r.id and refund_status in ('requested', 'approved', 'processing');
  v_due := greatest(v_held - v_live - r.total_minor, 0);
  if v_due > 0 and r.attention_reason is null then update reservations set attention_reason = 'discount_refund_due' where id = r.id;
  elsif v_due = 0 and r.attention_reason = 'discount_refund_due' then update reservations set attention_reason = null where id = r.id; end if;
  v_result := jsonb_build_object('reservation_id', r.id, 'changed', true, 'discount_percent', p_percent, 'discount_minor', r.discount_minor, 'total_minor', r.total_minor, 'refund_due_minor', v_due);
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
  v_cap numeric; v_base bigint; v_old bigint; v_old_pct numeric; v_result jsonb; v_held bigint; v_live bigint; v_due bigint;
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

  update reservations set discount_minor = p_amount_minor, discount_percent = null, discount_amount_minor = nullif(p_amount_minor, 0),
         discount_reason = case when p_amount_minor > 0 then v_reason end,
         total_minor = subtotal_minor + tax_minor - p_amount_minor
   where id = r.id returning * into r;

  perform refresh_reservation_payment_status(r.id);
  v_held := reservation_money_held(r.id);
  select coalesce(sum(amount_minor), 0) into v_live from refunds where reservation_id = r.id and refund_status in ('requested', 'approved', 'processing');
  v_due := greatest(v_held - v_live - r.total_minor, 0);
  if v_due > 0 and r.attention_reason is null then update reservations set attention_reason = 'discount_refund_due' where id = r.id;
  elsif v_due = 0 and r.attention_reason = 'discount_refund_due' then update reservations set attention_reason = null where id = r.id; end if;
  v_result := jsonb_build_object('reservation_id', r.id, 'changed', true, 'discount_amount_minor', p_amount_minor, 'discount_minor', r.discount_minor, 'total_minor', r.total_minor, 'refund_due_minor', v_due);
  perform idem_finish(r.tenant_id, 'apply_discount_amount', p_idempotency_key, v_result);
  perform write_audit(r.tenant_id, r.property_id, v_actor, 'reservation.discount_changed', 'reservation', r.id, p_idempotency_key,
                      jsonb_build_object('reason', v_reason, 'kind', 'amount', 'from_percent', v_old_pct, 'from_discount_minor', v_old,
                                         'to_discount_minor', r.discount_minor, 'to_total_minor', r.total_minor));
  return v_result;
end $$;

revoke all on function apply_discount(uuid, numeric, text, text), apply_discount_amount(uuid, bigint, text, text) from public, anon;
grant execute on function apply_discount(uuid, numeric, text, text), apply_discount_amount(uuid, bigint, text, text) to authenticated;
