-- 021 Tell the guest when they paid but their room was gone.
--
-- When a website guest's payment arrives after their hold lapsed and the room has been taken, the money stays on
-- record and the reservation is flagged paid_inventory_lost (011) for a person to resolve. Until now the guest
-- heard nothing: no confirmation, no explanation. This queues one email (payment_no_room) at the moment the flag
-- is set, saying the payment was received, they need not pay again, and the hotel will be in touch to arrange
-- another room or a full refund. A repeat of the same flag never sends a second email (dedupe key).
-- Staff-entered bookings are not emailed, as with the other kinds.

alter table email_outbox drop constraint email_outbox_kind_check;
alter table email_outbox add constraint email_outbox_kind_check
  check (kind in ('booking_held', 'booking_confirmed', 'booking_link', 'refund_processed', 'booking_cancelled', 'payment_no_room'));

create function reservations_lost_room_email_trigger() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.source = 'website' then
    perform enqueue_booking_email(new.id, 'payment_no_room', 'lost:' || new.id,
      jsonb_build_object('paid_minor', reservation_money_held(new.id), 'currency', new.currency));
  end if;
  return null;
end $$;
revoke all on function reservations_lost_room_email_trigger() from public, anon, authenticated;

create trigger reservations_lost_room_email after update of attention_reason on reservations
  for each row when (new.attention_reason = 'paid_inventory_lost' and old.attention_reason is distinct from new.attention_reason)
  execute function reservations_lost_room_email_trigger();
