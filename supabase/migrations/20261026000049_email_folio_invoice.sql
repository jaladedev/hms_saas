-- 049 Email the invoice for extras to the guest.
--
-- email_folio_invoice(invoice, key): a person with invoice.issue at the hotel asks for one issued invoice for extras (048) to
-- be emailed to the booking's guest. It does not send anything itself: it puts a `folio_invoice` row in email_outbox, the
-- same queue and worker as the other guest emails (015), and the worker's next pass sends it.
--   * The email carries a frozen copy of the invoice (number, each line, tax, total), taken now, so it matches what the guest
--     would see printed. Money taken for extras is not in it, as on the printed invoice.
--   * The key makes a double click or a retry send once: the same key never queues a second email. Asking again with a new
--     key (the screen makes one each time it loads) sends again, which is what "send it again" means.
--   * Needs an issued invoice (a voided one is refused: INVALID_STATE: void) and an email address on the guest
--     (POLICY_VIOLATION: no email). Not found, no permission and another hotel look the same: NOT_FOUND.
-- Errors: NOT_FOUND, INVALID_STATE: void, POLICY_VIOLATION: key | no email.

alter table email_outbox drop constraint email_outbox_kind_check;
alter table email_outbox add constraint email_outbox_kind_check
  check (kind in ('booking_held', 'booking_confirmed', 'booking_link', 'refund_processed', 'booking_cancelled', 'payment_no_room', 'folio_invoice'));

create function email_folio_invoice(p_invoice_id uuid, p_idempotency_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  i folio_invoices%rowtype; r reservations%rowtype; v_actor uuid; v_to text; v_payload jsonb; v_n integer;
begin
  select * into i from folio_invoices where id = p_invoice_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(i.property_id, 'invoice.issue', 'NOT_FOUND');
  if p_idempotency_key is null or length(p_idempotency_key) not between 8 and 100 then
    raise exception 'POLICY_VIOLATION: key' using errcode = 'P0001';
  end if;

  select * into r from reservations where id = i.reservation_id for update;
  select * into i from folio_invoices where id = p_invoice_id;
  if i.invoice_status <> 'issued' then raise exception 'INVALID_STATE: void' using errcode = 'P0001'; end if;
  select lower(btrim(email)) into v_to from guests where id = r.primary_guest_id;
  if v_to is null or v_to = '' then raise exception 'POLICY_VIOLATION: no email' using errcode = 'P0001'; end if;

  v_payload := jsonb_build_object(
    'invoice_number', i.invoice_number, 'currency', i.currency, 'subtotal_minor', i.subtotal_minor,
    'tax_minor', i.tax_minor, 'total_minor', i.total_minor,
    'lines', coalesce((select jsonb_agg(jsonb_build_object(
                'service_date', l.service_date, 'description', l.description, 'quantity', l.quantity,
                'unit_amount_minor', l.unit_amount_minor, 'tax_minor', l.tax_minor, 'line_total_minor', l.line_total_minor)
              order by l.service_date, l.created_at, l.id)
           from folio_invoice_lines l where l.folio_invoice_id = i.id), '[]'::jsonb));

  insert into email_outbox (tenant_id, reservation_id, kind, to_email, payload, dedupe_key)
  values (r.tenant_id, r.id, 'folio_invoice', v_to, v_payload, 'folio_invoice:' || i.id || ':' || p_idempotency_key)
  on conflict (kind, dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics v_n = row_count;

  if v_n > 0 then
    perform write_audit(r.tenant_id, r.property_id, v_actor, 'folio_invoice.emailed', 'folio_invoice', i.id, p_idempotency_key,
                        jsonb_build_object('invoice_number', i.invoice_number, 'reservation_id', r.id));
  end if;
  return jsonb_build_object('folio_invoice_id', i.id, 'invoice_number', i.invoice_number, 'queued', v_n > 0);
end $$;

revoke all on function email_folio_invoice(uuid, text) from public, anon;
grant execute on function email_folio_invoice(uuid, text) to authenticated;
