-- 176 Channel manager: record the money a channel collected (TODO 8.6, third cut).
-- A connection says who collects the guest's payment ('collects'). When the channel does, the hotel is paid later by the channel, and the booking
-- shows unpaid here until someone records it. channel_record_payment does that, on purpose and one booking at a time (never automatic):
--   - the booking must be imported, from a connection where the channel collects, with a live reservation (not cancelled, expired or no-show);
--   - the amount is what the reservation still owes at the hotel's own price (total minus the money already held), never the channel's figure, so
--     a price difference stays visible on the reconciliation screen and is never silently booked;
--   - it records an ordinary manual payment (record_manual_payment of 010: method 'other', reference 'Channel booking <id>', note naming the
--     channel), so invoices, allocation, payment status, receipts and the audit all work as for any payment;
--   - the caller needs channels.manage (the screen) and payment.record (the money); the channel manager flag must be on;
--   - a second click records nothing twice: the idempotency key is the booking and the amount owed, and once nothing is owed it is refused.
-- channel_sync_report also lists 'awaiting_payment': imported, live bookings of a collecting channel that still owe money.

create function channel_record_payment(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b channel_bookings%rowtype; c channel_connections%rowtype; r reservations%rowtype; v_actor uuid; v_owed bigint; v_pay jsonb;
begin
  select * into b from channel_bookings where id = p_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := channel_require(b.property_id);
  if not has_permission(b.property_id, 'payment.record') then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  select * into c from channel_connections where id = b.connection_id;
  if b.status <> 'imported' or b.reservation_id is null or c.collects <> 'channel' then raise exception 'INVALID_STATE: not collected by the channel' using errcode = 'P0001'; end if;
  select * into r from reservations where id = b.reservation_id for update;
  if r.reservation_status in ('cancelled', 'expired', 'no_show') then raise exception 'INVALID_STATE: %', r.reservation_status using errcode = 'P0001'; end if;
  v_owed := r.total_minor - reservation_money_held(r.id);
  if v_owed <= 0 then raise exception 'INVALID_STATE: nothing owed' using errcode = 'P0001'; end if;
  v_pay := record_manual_payment(r.id, v_owed, 'other', 'Channel booking ' || b.external_id, 'Collected by ' || c.label, 'chanpay:' || b.id || ':' || v_owed);
  perform write_audit(b.tenant_id, b.property_id, v_actor, 'channel_booking.payment_recorded', 'channel_booking', b.id, null,
                      jsonb_build_object('reservation_id', r.id, 'amount_minor', v_owed, 'channel', c.channel, 'external_id', b.external_id));
  return jsonb_build_object('amount_minor', v_owed, 'payment_status', v_pay ->> 'payment_status');
end $$;
revoke all on function channel_record_payment(uuid) from public, anon;
grant execute on function channel_record_payment(uuid) to authenticated;

create or replace function channel_sync_report(p_property uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_actor uuid;
begin
  v_actor := require_permission(p_property, 'channels.manage', 'NOT_FOUND');   -- readable with the flag off
  return jsonb_build_object(
    'counts', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) n from channel_bookings where property_id = p_property group by status) s), '{}'::jsonb),
    'price_differences', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'external_id', b.external_id, 'reference', r.booking_reference, 'channel_total_minor', b.channel_total_minor,
                                                                    'our_total_minor', r.total_minor, 'currency', r.currency) order by b.created_at desc)
                                     from channel_bookings b join reservations r on r.id = b.reservation_id
                                    where b.property_id = p_property and b.status = 'imported' and b.channel_total_minor is not null and b.channel_total_minor <> r.total_minor), '[]'::jsonb),
    'cancelled_here', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'external_id', b.external_id, 'reference', r.booking_reference) order by b.created_at desc)
                                  from channel_bookings b join reservations r on r.id = b.reservation_id
                                 where b.property_id = p_property and b.status = 'imported' and r.reservation_status in ('cancelled', 'expired', 'no_show')), '[]'::jsonb),
    'awaiting_payment', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'external_id', b.external_id, 'reference', r.booking_reference,
                                                                      'owed_minor', r.total_minor - reservation_money_held(r.id), 'currency', r.currency) order by b.created_at desc)
                                    from channel_bookings b join channel_connections c on c.id = b.connection_id and c.collects = 'channel'
                                    join reservations r on r.id = b.reservation_id
                                   where b.property_id = p_property and b.status = 'imported' and r.reservation_status not in ('cancelled', 'expired', 'no_show')
                                     and r.total_minor - reservation_money_held(r.id) > 0), '[]'::jsonb));
end $$;

