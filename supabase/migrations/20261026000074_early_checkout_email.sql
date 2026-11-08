-- 074 Email the guest when an early check-out credit is applied.
--
-- Early check-out (060) credits nights the guest did not stay and may leave money to go back, but the guest heard nothing until
-- a refund was paid out. Now a WEBSITE guest (like every automatic guest email) is emailed `early_checkout_credit` when the credit
-- is applied: the nights credited, the credit, the new total, and, when they have paid more than that, the amount the hotel
-- will refund (which comes separately, with the usual `refund_processed` email when it is paid). Bookings made by staff send
-- nothing, and a booking with no guest email sends nothing. One email per room checked out early (dedupe key = the room).
-- early_checkout_apply is 062's with the enqueue added at the end; the outbox kind list gains the new kind.

alter table email_outbox drop constraint email_outbox_kind_check;
alter table email_outbox add constraint email_outbox_kind_check
  check (kind in ('booking_held', 'booking_confirmed', 'booking_link', 'refund_processed', 'booking_cancelled', 'payment_no_room', 'folio_invoice', 'early_checkout_credit'));

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
  -- 074: a website guest is told about the credit, with the refund still to come (if any); the refund itself is a separate step
  if r.source = 'website' then
    perform enqueue_booking_email(r.id, 'early_checkout_credit', 'earlyout:' || p_reservation_room,
      jsonb_build_object('credit_minor', v_credit, 'nights_credited', t.nights_credited, 'new_total_minor', t.total,
                         'refund_due_minor', v_surplus, 'currency', r.currency));
  end if;
  return jsonb_build_object('credit_minor', v_credit, 'nights_credited', t.nights_credited, 'new_total_minor', t.total, 'surplus_minor', v_surplus);
end $$;

revoke all on function early_checkout_apply(uuid, uuid, date, text, uuid) from public, anon, authenticated;
