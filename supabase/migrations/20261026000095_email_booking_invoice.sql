-- 095 Email the booking invoice to the guest.
--
-- email_booking_invoice(invoice, key): a person with invoice.issue at the hotel asks for a booking invoice (010) to be emailed to
-- the booking's guest. Like email_folio_invoice (049) it sends nothing itself: it puts a `booking_invoice` row in email_outbox and
-- the worker's next pass sends it.
--   * The email carries a frozen copy taken now: number, each line, tax, discount, total, and the balance still owing at that moment
--     (total less reservation_money_held, never below zero), so it matches what the guest would see printed.
--   * The key makes a double click or retry send once; a new key sends again.
--   * A void invoice is refused (INVALID_STATE: void) and so is a guest with no email (POLICY_VIOLATION: no email). Not found, no
--     permission and another hotel look the same: NOT_FOUND.
-- Errors: NOT_FOUND, INVALID_STATE: void, POLICY_VIOLATION: key | no email.

alter table email_outbox drop constraint email_outbox_kind_check;
alter table email_outbox add constraint email_outbox_kind_check
  check (kind in ('booking_held', 'booking_confirmed', 'booking_link', 'refund_processed', 'booking_cancelled', 'payment_no_room', 'folio_invoice',
                  'early_checkout_credit', 'stay_changed', 'change_request_answered', 'booking_invoice'));

create function email_booking_invoice(p_invoice_id uuid, p_idempotency_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  i invoices%rowtype; r reservations%rowtype; v_actor uuid; v_to text; v_payload jsonb; v_n integer;
begin
  select * into i from invoices where id = p_invoice_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(i.property_id, 'invoice.issue', 'NOT_FOUND');
  if p_idempotency_key is null or length(p_idempotency_key) not between 8 and 100 then
    raise exception 'POLICY_VIOLATION: key' using errcode = 'P0001';
  end if;

  select * into r from reservations where id = i.reservation_id for update;
  select * into i from invoices where id = p_invoice_id;
  if i.invoice_status = 'void' then raise exception 'INVALID_STATE: void' using errcode = 'P0001'; end if;
  select lower(btrim(email)) into v_to from guests where id = r.primary_guest_id;
  if v_to is null or v_to = '' then raise exception 'POLICY_VIOLATION: no email' using errcode = 'P0001'; end if;

  v_payload := jsonb_build_object(
    'invoice_number', i.invoice_number, 'currency', i.currency, 'subtotal_minor', i.subtotal_minor,
    'tax_minor', i.tax_minor, 'discount_minor', i.discount_minor, 'total_minor', i.total_minor,
    'balance_minor', greatest(i.total_minor - greatest(reservation_money_held(r.id), 0), 0),
    'lines', coalesce((select jsonb_agg(jsonb_build_object(
                'service_date', l.service_date, 'description', l.description, 'quantity', l.quantity,
                'unit_amount_minor', l.unit_amount_minor, 'tax_minor', l.tax_amount_minor, 'line_total_minor', l.line_total_minor)
              order by l.service_date, l.id)
           from invoice_lines l where l.invoice_id = i.id), '[]'::jsonb));

  insert into email_outbox (tenant_id, reservation_id, kind, to_email, payload, dedupe_key)
  values (r.tenant_id, r.id, 'booking_invoice', v_to, v_payload, 'booking_invoice:' || i.id || ':' || p_idempotency_key)
  on conflict (kind, dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics v_n = row_count;

  if v_n > 0 then
    perform write_audit(r.tenant_id, r.property_id, v_actor, 'invoice.emailed', 'invoice', i.id, p_idempotency_key,
                        jsonb_build_object('invoice_number', i.invoice_number, 'reservation_id', r.id));
  end if;
  return jsonb_build_object('invoice_id', i.id, 'invoice_number', i.invoice_number, 'queued', v_n > 0);
end $$;

revoke all on function email_booking_invoice(uuid, text) from public, anon;
grant execute on function email_booking_invoice(uuid, text) to authenticated;
