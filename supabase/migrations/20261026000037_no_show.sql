-- 037 No-show: a guest who never arrived.
--
-- Until now nothing could mark a booking as a no-show. A no-show is settled exactly like a cancellation (a charge under the
-- booking's own cancellation rules, a fee invoice for it, a refund request for any money held beyond it), so it is recorded
-- AS a cancellation, reached through its own door, and told apart by reservations.no_show_at:
--   * the booking's status becomes 'cancelled' (every settlement, invoice, refund and payment rule already handles that),
--   * cancel_reason is 'No-show' (plus the staff note), and no_show_at is set,
--   * the audit action is reservation.no_show, not reservation.cancelled.
-- The status value 'no_show' stays in the allowed list but is not used.
--
-- mark_no_show(reservation, note, waive_charge, key): needs reservation.cancel (the same people who may cancel). Only a
-- confirmed booking with nobody checked in, and only once check-in time on the arrival day has passed (INVALID_STATE: too
-- early otherwise). The charge is what the cancellation rules say at that moment (normally the rule for "0 hours": the
-- first night, a percentage or all of it); waive_charge = true sets it to nothing and says so in the audit.
--
-- Errors: NOT_FOUND, POLICY_VIOLATION: note (over 200 characters), INVALID_STATE: <status>, INVALID_STATE: too early.

alter table reservations add column no_show_at timestamptz;
alter table reservations add constraint reservations_no_show_check check (no_show_at is null or reservation_status = 'cancelled');

-- cancel_reservation_apply (035) with the no-show path: its own audit action, no_show_at, and an optional waived charge.
create or replace function cancel_reservation_apply(p_reservation_id uuid, p_reason text, p_actor uuid, p_by text, p_idempotency_key text,
                                                    p_expected_charge bigint default null, p_waive boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r reservations%rowtype; v_quote jsonb; v_charge bigint; v_result jsonb;
begin
  select * into r from reservations where id = p_reservation_id for update;
  if r.reservation_status not in ('pending', 'confirmed')
     or exists (select 1 from reservation_rooms where reservation_id = r.id and room_status in ('checked_in','checked_out')) then
    raise exception 'INVALID_STATE: %', r.reservation_status using errcode = 'P0001';
  end if;
  v_quote := cancellation_quote(r.id);
  v_charge := case when p_waive then 0 else (v_quote ->> 'charge_minor')::bigint end;
  if p_expected_charge is not null and p_expected_charge <> v_charge then
    raise exception 'POLICY_VIOLATION: charge changed' using errcode = 'P0001';
  end if;

  update room_inventory_claims set status = 'released'
   where status = 'active' and reservation_room_id in (select id from reservation_rooms where reservation_id = r.id);
  update reservation_rooms set room_status = 'cancelled' where reservation_id = r.id;
  update reservations set reservation_status = 'cancelled', cancelled_at = now(),
         cancellation_charge_minor = v_charge, cancel_reason = p_reason,
         no_show_at = case when p_by = 'no_show' then now() else null end
   where id = r.id;

  v_result := jsonb_build_object('reservation_id', r.id, 'status', 'cancelled', 'cancellation_charge_minor', v_charge,
                                 'hours_before_arrival', (v_quote ->> 'hours_before_arrival')::numeric);
  perform idem_finish(r.tenant_id, case p_by when 'guest' then 'guest_cancel_reservation' when 'no_show' then 'mark_no_show' else 'cancel_reservation' end,
                      p_idempotency_key, v_result);
  perform write_audit(r.tenant_id, r.property_id, p_actor, case when p_by = 'no_show' then 'reservation.no_show' else 'reservation.cancelled' end,
                      'reservation', r.id, p_idempotency_key,
                      jsonb_build_object('reason', p_reason, 'charge_minor', v_charge)
                      || case when p_by = 'guest' then jsonb_build_object('by', 'guest') else '{}'::jsonb end
                      || case when p_waive then jsonb_build_object('charge_waived', true, 'charge_would_have_been_minor', (v_quote ->> 'charge_minor')::bigint) else '{}'::jsonb end);
  return v_result;
end $$;
revoke all on function cancel_reservation_apply(uuid, text, uuid, text, text, bigint, boolean) from public, anon, authenticated;
drop function cancel_reservation_apply(uuid, text, uuid, text, text, bigint);

create function mark_no_show(p_reservation_id uuid, p_note text, p_waive_charge boolean, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r reservations%rowtype; v_actor uuid; v_idem record; v_hash text; v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_reason text;
begin
  select * into r from reservations where id = p_reservation_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(r.property_id, 'reservation.cancel', 'NOT_FOUND');
  if v_note is not null and length(v_note) > 200 then raise exception 'POLICY_VIOLATION: note' using errcode = 'P0001'; end if;
  v_reason := case when v_note is null then 'No-show' else 'No-show: ' || v_note end;

  v_hash := md5(concat_ws('|', p_reservation_id, coalesce(v_note, ''), coalesce(p_waive_charge, false)));
  select * into v_idem from idem_begin(r.tenant_id, 'mark_no_show', p_idempotency_key, v_hash);
  if not v_idem.out_is_new then return v_idem.out_response; end if;

  select * into r from reservations where id = p_reservation_id for update;
  if r.reservation_status <> 'confirmed'
     or exists (select 1 from reservation_rooms where reservation_id = r.id and room_status in ('checked_in', 'checked_out')) then
    raise exception 'INVALID_STATE: %', r.reservation_status using errcode = 'P0001';
  end if;
  if (cancellation_quote(r.id) ->> 'hours_before_arrival')::numeric > 0 then
    raise exception 'INVALID_STATE: too early' using errcode = 'P0001';
  end if;
  return cancel_reservation_apply(r.id, v_reason, v_actor, 'no_show', p_idempotency_key, null, coalesce(p_waive_charge, false));
end $$;

revoke all on function mark_no_show(uuid, text, boolean, text) from public, anon;
grant execute on function mark_no_show(uuid, text, boolean, text) to authenticated;
