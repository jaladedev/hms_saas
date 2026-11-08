-- 066 Revoking a guest's booking links.
--
-- Guest links are signed, stateless tokens (lib/booking-token.ts) and could not be taken back: a link forwarded by mistake, or
-- sent to a mailbox someone else reads, stayed good until it expired. Now staff can reset a booking's links:
--   * `reservations.guest_links_valid_from` (null = never reset). A new token carries the second it was issued (`i`); the guest
--     pages ask `guest_link_ok(reservation, issued_at)` and a token issued before the reset moment is refused. Tokens made
--     before this migration carry no `i` and count as issued at 0, so any reset ends them too. Links made after the reset work.
--   * the reset moment is rounded DOWN to the whole second, so a link made in the same second as the reset still works; the
--     email queued by the reset is built later with a fresh token anyway.
--   * `reset_guest_links(reservation, reason, key)`: reservation.modify, a written reason (200 chars), audited
--     (`reservation.guest_links_reset`), and it queues the guest a new `booking_link` email when the guest has an address.
-- Nothing else changes: cancelled or finished bookings can be reset too, and the guest can still ask for a link on /booking/find.

alter table reservations add column guest_links_valid_from timestamptz;

create function guest_link_ok(p_reservation_id uuid, p_issued_at bigint) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare v_from timestamptz; v_found boolean;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select true, r.guest_links_valid_from into v_found, v_from from reservations r where r.id = p_reservation_id;
  if v_found is not true then return false; end if;
  return v_from is null or coalesce(p_issued_at, 0) >= floor(extract(epoch from v_from));
end $$;
revoke all on function guest_link_ok(uuid, bigint) from public, anon, authenticated;
grant execute on function guest_link_ok(uuid, bigint) to service_role;

create function reset_guest_links(p_reservation_id uuid, p_reason text, p_idempotency_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r reservations%rowtype; v_actor uuid; v_reason text := nullif(btrim(p_reason), ''); v_idem record; v_hash text; v_queued boolean; v_result jsonb;
begin
  select * into r from reservations where id = p_reservation_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(r.property_id, 'reservation.modify', 'NOT_FOUND');
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if v_reason is null or length(v_reason) > 200 then raise exception 'POLICY_VIOLATION: reason' using errcode = 'P0001'; end if;

  v_hash := md5(concat_ws('|', p_reservation_id, v_reason));
  select * into v_idem from idem_begin(r.tenant_id, 'reset_guest_links', p_idempotency_key, v_hash);
  if not v_idem.out_is_new then return v_idem.out_response; end if;

  update reservations set guest_links_valid_from = date_trunc('second', clock_timestamp()) where id = r.id;
  v_queued := enqueue_booking_email(r.id, 'booking_link', null);

  v_result := jsonb_build_object('reservation_id', r.id, 'reset', true, 'email_queued', v_queued);
  perform idem_finish(r.tenant_id, 'reset_guest_links', p_idempotency_key, v_result);
  perform write_audit(r.tenant_id, r.property_id, v_actor, 'reservation.guest_links_reset', 'reservation', r.id, p_idempotency_key,
                      jsonb_build_object('reason', v_reason, 'email_queued', v_queued));
  return v_result;
end $$;
revoke all on function reset_guest_links(uuid, text, text) from public, anon;
grant execute on function reset_guest_links(uuid, text, text) to authenticated;
