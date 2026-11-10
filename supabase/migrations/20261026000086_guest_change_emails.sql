-- 086 Email the guest about changes to their booking (TODO: "guest email on change / answer").
--
-- Two new automatic emails, to a WEBSITE guest only (like every automatic guest email; a booking made by staff sends nothing, and a
-- booking with no guest email sends nothing):
--   stay_changed            the dates or the room type of the booking changed, whoever did it (the guest from their link, 071; staff,
--                           033/070; a room upgrade or downgrade, 083). Carries the old and new dates, the old and new total and, for
--                           staff changes, the refund the hotel owes when the guest has paid more than the new total.
--   change_request_answered a member of staff dealt with, or declined, the guest's change request (069). Carries the outcome and the
--                           note the hotel wrote. A request the guest closed themselves by changing the dates is not answered by staff,
--                           so it sends nothing (the stay_changed email covers it).
-- Both are sent by triggers, so none of the money functions changed:
--   * stay changes: an insert on audit_logs of 'reservation.stay_changed' (only when the dates changed; a guest-numbers edit sends
--     nothing) or 'reservation.room_type_changed'. All three paths already write exactly that row, once per change, so the audit
--     row's id is the dedupe key and a retried request (idempotent, no second audit row) never sends a second email.
--   * request answers: an update of guest_change_requests from open to done or declined by a person (resolved_by set).
-- Staff-written reasons for a change (the 'reason' in the audit row) are internal and are not put in the email.

alter table email_outbox drop constraint email_outbox_kind_check;
alter table email_outbox add constraint email_outbox_kind_check
  check (kind in ('booking_held', 'booking_confirmed', 'booking_link', 'refund_processed', 'booking_cancelled', 'payment_no_room', 'folio_invoice',
                  'early_checkout_credit', 'stay_changed', 'change_request_answered'));

create function stay_change_email_trigger() returns trigger language plpgsql security definer set search_path = public as $$
declare r reservations%rowtype; m jsonb := new.metadata; v_payload jsonb; v_type text;
begin
  if new.entity_id is null then return null; end if;
  if new.action = 'reservation.stay_changed' and coalesce((m ->> 'dates_changed')::boolean, false) is not true then return null; end if;
  select * into r from reservations where id = new.entity_id;
  if not found or r.source <> 'website' then return null; end if;
  if new.action = 'reservation.stay_changed' then
    v_payload := jsonb_build_object('change', 'dates', 'from_arrival', m ->> 'from_arrival', 'from_departure', m ->> 'from_departure',
                                    'to_arrival', m ->> 'to_arrival', 'to_departure', m ->> 'to_departure',
                                    'from_total_minor', (m ->> 'from_total_minor')::bigint, 'to_total_minor', (m ->> 'to_total_minor')::bigint,
                                    'refund_due_minor', coalesce((m ->> 'surplus_minor')::bigint, 0), 'by', coalesce(m ->> 'by', 'staff'), 'currency', r.currency);
  else
    select name into v_type from room_types where id = (m ->> 'to_room_type_id')::uuid;
    v_payload := jsonb_build_object('change', 'room_type', 'room_type', v_type, 'effective', m ->> 'effective',
                                    'from_total_minor', (m ->> 'old_total_minor')::bigint, 'to_total_minor', (m ->> 'new_total_minor')::bigint,
                                    'refund_due_minor', coalesce((m ->> 'surplus_minor')::bigint, 0), 'by', 'staff', 'currency', r.currency);
  end if;
  perform enqueue_booking_email(r.id, 'stay_changed', 'stay:' || new.id, v_payload);
  return null;
end $$;
create trigger audit_logs_stay_change_email after insert on audit_logs
  for each row when (new.action in ('reservation.stay_changed', 'reservation.room_type_changed'))
  execute function stay_change_email_trigger();

create function change_request_email_trigger() returns trigger language plpgsql security definer set search_path = public as $$
declare r reservations%rowtype;
begin
  select * into r from reservations where id = new.reservation_id;
  if not found or r.source <> 'website' then return null; end if;
  perform enqueue_booking_email(r.id, 'change_request_answered', 'creq:' || new.id,
    jsonb_build_object('kind', new.kind, 'outcome', new.status, 'note', new.resolution_note,
                       'requested_arrival', new.requested_arrival, 'requested_departure', new.requested_departure));
  return null;
end $$;
create trigger guest_change_requests_email after update of status on guest_change_requests
  for each row when (old.status = 'open' and new.status in ('done', 'declined') and new.resolved_by is not null)
  execute function change_request_email_trigger();
