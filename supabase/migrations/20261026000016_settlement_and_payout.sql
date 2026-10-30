-- 016 Cancellation settlement and the refund payout path.
--
-- Cancelling is not refunding. cancel_reservation (008) releases the rooms and stores the cancellation
-- charge. When a reservation becomes 'cancelled', a trigger in the same transaction settles the money:
--   * the stay invoice is voided (the stay no longer happens);
--   * if a cancellation charge applies, a "Cancellation charge" invoice is issued and the money already
--     held is allocated to it, oldest payment first;
--   * if more is held than the charge, refund REQUESTS are created for the difference, newest payment
--     first (so card money goes back to the card). They still need a second person's approval;
--   * if less is held than the charge, the reservation is flagged 'cancellation_charge_unpaid' until
--     the charge is collected (record_manual_payment accepts payments up to the charge on a cancelled
--     reservation); the flag clears itself when the charge is covered.
-- A website guest is emailed (booking_cancelled) with the charge and any refund due.
--
-- Refund payout: Paystack's refund API has no idempotency key, so the provider is called at most once
-- per refund. start_refund_payout (staff, refund.approve) and begin_refund_processing (server) both move
-- approved -> processing and report call_allowed = true to exactly one caller. If that call's outcome is
-- unknown (timeout, 5xx), the refund stays processing with an attention_note for a person to check on
-- Paystack's dashboard; stale_processing_refunds lists them. Nothing retries automatically.

-- ---- allocations: only live invoices count -------------------------------------------------
-- Voiding a stay invoice leaves its allocations as history. They must not stop the same money from
-- being applied to the cancellation-charge invoice.
create or replace function allocate_payments_to_invoice(p_invoice uuid) returns bigint
language plpgsql security definer set search_path = public as $$
declare i invoices%rowtype; v_out bigint; v_take bigint; v_total bigint := 0; p record;
begin
  select * into i from invoices where id = p_invoice;
  v_out := i.total_minor - coalesce((select sum(amount_minor) from payment_allocations where invoice_id = p_invoice), 0);
  for p in
    select pay.id, pay.amount_minor - coalesce((select sum(a.amount_minor) from payment_allocations a
                                                  join invoices ai on ai.id = a.invoice_id and ai.invoice_status <> 'void'
                                                 where a.payment_id = pay.id), 0) as free
      from payments pay
     where pay.reservation_id = i.reservation_id and pay.payment_status = 'succeeded'
     order by pay.received_at, pay.id
  loop
    exit when v_out <= 0;
    if p.free > 0 then
      v_take := least(p.free, v_out);
      insert into payment_allocations (tenant_id, payment_id, invoice_id, amount_minor)
      values (i.tenant_id, p.id, p_invoice, v_take);
      v_out := v_out - v_take;
      v_total := v_total + v_take;
    end if;
  end loop;
  return v_total;
end $$;

create or replace function payment_allocations_check() returns trigger language plpgsql
security definer set search_path = public as $$
declare p payments%rowtype; i invoices%rowtype;
begin
  select * into p from payments where id = new.payment_id;
  select * into i from invoices where id = new.invoice_id;
  if p.reservation_id <> i.reservation_id then
    raise exception 'allocation crosses reservations' using errcode = '23514';
  end if;
  if i.invoice_status = 'void' or p.payment_status <> 'succeeded' then
    raise exception 'allocation needs a live invoice and a succeeded payment' using errcode = '23514';
  end if;
  if (select sum(a.amount_minor) from payment_allocations a join invoices ai on ai.id = a.invoice_id and ai.invoice_status <> 'void'
       where a.payment_id = p.id) > p.amount_minor then
    raise exception 'allocations exceed payment' using errcode = '23514';
  end if;
  if (select sum(amount_minor) from payment_allocations where invoice_id = i.id) > i.total_minor then
    raise exception 'allocations exceed invoice' using errcode = '23514';
  end if;
  return null;
end $$;

-- ---- money state also tracks an unpaid cancellation charge ---------------------------------
create or replace function refresh_money_state(p_reservation uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_inv uuid; r reservations%rowtype; v_held bigint;
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
  end if;
end $$;

-- ---- cancellation email --------------------------------------------------------------------
alter table email_outbox drop constraint email_outbox_kind_check;
alter table email_outbox add constraint email_outbox_kind_check
  check (kind in ('booking_held', 'booking_confirmed', 'booking_link', 'refund_processed', 'booking_cancelled'));

create or replace function reservations_email_trigger() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.source <> 'website' then return null; end if;
  if tg_op = 'INSERT' and new.reservation_status = 'pending' then
    perform enqueue_booking_email(new.id, 'booking_held', 'held:' || new.id);
  elsif tg_op = 'UPDATE' and new.reservation_status = 'confirmed' and old.reservation_status in ('pending', 'expired') then
    perform enqueue_booking_email(new.id, 'booking_confirmed', 'confirmed:' || new.id);
  elsif tg_op = 'UPDATE' and new.reservation_status = 'cancelled' and old.reservation_status <> 'cancelled' then
    perform enqueue_booking_email(new.id, 'booking_cancelled', 'cancelled:' || new.id,
      jsonb_build_object('charge_minor', new.cancellation_charge_minor, 'currency', new.currency,
                         'refund_due_minor', greatest(reservation_money_held(new.id) - new.cancellation_charge_minor, 0)));
  end if;
  return null;
end $$;

-- ---- settlement ----------------------------------------------------------------------------
create function settle_cancelled_reservation(p_reservation uuid, p_actor uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r reservations%rowtype; v_prop record; v_charge bigint; v_held bigint; v_live bigint; v_due bigint;
  v_inv uuid; v_year integer; v_n integer; v_number text; v_take bigint; v_ref text; v_requests integer := 0;
  v_fee_invoice uuid; p record;
begin
  select * into r from reservations where id = p_reservation for update;
  v_charge := coalesce(r.cancellation_charge_minor, 0);

  -- the stay no longer happens
  update invoices set invoice_status = 'void', void_reason = 'reservation cancelled', voided_at = now(), voided_by = p_actor
   where reservation_id = r.id and invoice_status <> 'void';

  if v_charge > 0 then
    select code, timezone into v_prop from properties where id = r.property_id;
    v_year := extract(year from property_today(r.property_id))::integer;
    insert into invoice_sequences (property_id, year, last_number) values (r.property_id, v_year, 1)
    on conflict (property_id, year) do update set last_number = invoice_sequences.last_number + 1
    returning last_number into v_n;
    v_number := 'INV-' || v_prop.code || '-' || v_year || '-' || lpad(v_n::text, 6, '0');
    v_inv := gen_random_uuid();
    insert into invoices (id, tenant_id, property_id, reservation_id, invoice_number, currency,
                          subtotal_minor, tax_minor, discount_minor, total_minor, due_at, created_by)
    values (v_inv, r.tenant_id, r.property_id, r.id, v_number, r.currency, v_charge, 0, 0, v_charge, now(), p_actor);
    insert into invoice_lines (tenant_id, invoice_id, description, quantity, unit_amount_minor, tax_amount_minor, line_total_minor)
    values (r.tenant_id, v_inv, 'Cancellation charge (tax included)', 1, v_charge, 0, v_charge);
    perform allocate_payments_to_invoice(v_inv);
    v_fee_invoice := v_inv;
  end if;

  v_held := reservation_money_held(r.id);
  select coalesce(sum(amount_minor), 0) into v_live from refunds
   where reservation_id = r.id and refund_status in ('requested', 'approved', 'processing');
  v_due := greatest(v_held - v_charge - v_live, 0);

  for p in
    select pay.id, pay.amount_minor - coalesce((select sum(f.amount_minor) from refunds f where f.payment_id = pay.id
             and f.refund_status in ('requested', 'approved', 'processing', 'succeeded')), 0) as refundable
      from payments pay where pay.reservation_id = r.id and pay.payment_status = 'succeeded'
     order by pay.received_at desc, pay.id
  loop
    exit when v_due <= 0;
    if p.refundable > 0 then
      v_take := least(p.refundable, v_due);
      loop
        v_ref := 'RF-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
        exit when not exists (select 1 from refunds where tenant_id = r.tenant_id and internal_reference = v_ref);
      end loop;
      insert into refunds (tenant_id, property_id, reservation_id, payment_id, internal_reference, amount_minor, currency, reason, requested_by)
      values (r.tenant_id, r.property_id, r.id, p.id, v_ref, v_take, r.currency,
              'Cancellation settlement: amount paid beyond the cancellation charge', p_actor);
      v_due := v_due - v_take;
      v_requests := v_requests + 1;
    end if;
  end loop;

  perform refresh_money_state(r.id);
  perform write_audit(r.tenant_id, r.property_id, p_actor, 'reservation.settled', 'reservation', r.id, null,
                      jsonb_build_object('charge_minor', v_charge, 'held_minor', v_held, 'refund_requests', v_requests,
                                         'fee_invoice_id', v_fee_invoice));
  return jsonb_build_object('charge_minor', v_charge, 'held_minor', v_held, 'refund_requests', v_requests);
end $$;

create function reservations_settle_trigger() returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform settle_cancelled_reservation(new.id, auth.uid());
  return null;
end $$;
create trigger reservations_settle_upd after update of reservation_status on reservations
  for each row when (new.reservation_status = 'cancelled' and old.reservation_status is distinct from 'cancelled')
  execute function reservations_settle_trigger();
revoke all on function settle_cancelled_reservation(uuid, uuid) from public, anon, authenticated;

-- What is still owed either way, for the staff screen.
create function reservation_settlement(p_reservation_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r reservations%rowtype; v_held bigint; v_live bigint; v_ok bigint; v_refund_due bigint; v_charge_due bigint;
begin
  select * into r from reservations where id = p_reservation_id;
  if not found or not (is_system_caller() or can_view_money(r.property_id)) then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_held := reservation_money_held(r.id);
  select coalesce(sum(amount_minor) filter (where refund_status in ('requested', 'approved', 'processing')), 0),
         coalesce(sum(amount_minor) filter (where refund_status = 'succeeded'), 0)
    into v_live, v_ok from refunds where reservation_id = r.id;
  v_refund_due := case when r.reservation_status = 'cancelled' then greatest(v_held - r.cancellation_charge_minor - v_live, 0) else 0 end;
  v_charge_due := case when r.reservation_status = 'cancelled' then greatest(r.cancellation_charge_minor - v_held, 0) else 0 end;
  return jsonb_build_object(
    'applicable', r.reservation_status = 'cancelled', 'reservation_status', r.reservation_status,
    'charge_minor', r.cancellation_charge_minor, 'held_minor', v_held,
    'refunds_in_flight_minor', v_live, 'refunded_minor', v_ok,
    'refund_still_to_request_minor', v_refund_due, 'charge_due_minor', v_charge_due,
    'settled', r.reservation_status = 'cancelled' and v_refund_due = 0 and v_live = 0 and v_charge_due = 0);
end $$;
revoke all on function reservation_settlement(uuid) from public, anon;
grant execute on function reservation_settlement(uuid) to authenticated;

-- ---- refund payout --------------------------------------------------------------------------
create function start_refund_payout(p_refund_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare f refunds%rowtype; pay payments%rowtype; v_actor uuid; v_call boolean := false;
begin
  select * into f from refunds where id = p_refund_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(f.property_id, 'refund.approve', 'NOT_FOUND');
  perform 1 from reservations where id = f.reservation_id for update;
  select * into f from refunds where id = p_refund_id;
  select * into pay from payments where id = f.payment_id;
  if pay.payment_provider = 'manual' then
    raise exception 'POLICY_VIOLATION: manual payments are refunded by staff' using errcode = 'P0001';
  end if;
  if f.refund_status = 'approved' then
    update refunds set refund_status = 'processing', provider_call_started_at = now() where id = f.id;
    perform write_audit(f.tenant_id, f.property_id, v_actor, 'refund.processing', 'refund', f.id, null, '{}'::jsonb);
    v_call := true;
  elsif f.refund_status <> 'processing' then
    raise exception 'INVALID_STATE: %', f.refund_status using errcode = 'P0001';
  end if;
  return jsonb_build_object('refund_id', f.id, 'tenant_id', f.tenant_id, 'internal_reference', f.internal_reference,
                            'provider', pay.payment_provider, 'payment_provider_reference', pay.provider_reference,
                            'amount_minor', f.amount_minor, 'currency', f.currency, 'call_allowed', v_call);
end $$;
revoke all on function start_refund_payout(uuid) from public, anon;
grant execute on function start_refund_payout(uuid) to authenticated;

create function refund_payout_context(p_refund_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare f refunds%rowtype; a record;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select * into f from refunds where id = p_refund_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  select id, secret_reference, mode into a from payment_provider_accounts
   where tenant_id = f.tenant_id and provider = 'paystack' and status = 'active' and secret_reference is not null
   order by (mode = 'live') desc limit 1;
  if not found then raise exception 'INVALID_STATE: no payment provider configured' using errcode = 'P0001'; end if;
  return jsonb_build_object('account_id', a.id, 'secret_reference', a.secret_reference, 'mode', a.mode);
end $$;

create function note_refund_attention(p_refund_id uuid, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare f refunds%rowtype;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select * into f from refunds where id = p_refund_id for update;
  if not found or f.refund_status <> 'processing' then return; end if;
  update refunds set attention_note = left(coalesce(p_note, ''), 500) where id = f.id;
  perform write_audit(f.tenant_id, f.property_id, null, 'refund.needs_attention', 'refund', f.id, null,
                      jsonb_build_object('note', left(coalesce(p_note, ''), 500)));
end $$;

create function stale_processing_refunds(p_older_than_minutes integer default 120) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
            'refund_id', f.id, 'tenant_id', f.tenant_id, 'internal_reference', f.internal_reference,
            'minutes_processing', floor(extract(epoch from (now() - f.provider_call_started_at)) / 60),
            'attention_note', f.attention_note) order by f.provider_call_started_at)
          from refunds f
         where f.refund_status = 'processing' and f.provider_call_started_at < now() - make_interval(mins => p_older_than_minutes)),
          '[]'::jsonb);
end $$;

revoke all on function refund_payout_context(uuid), note_refund_attention(uuid, text), stale_processing_refunds(integer)
  from public, anon, authenticated;
grant execute on function refund_payout_context(uuid), note_refund_attention(uuid, text), stale_processing_refunds(integer)
  to service_role;
