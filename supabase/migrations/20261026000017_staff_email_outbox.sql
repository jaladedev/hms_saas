-- 017 Staff view of failed guest emails, and resend.
--
-- email_outbox has no RLS policy on purpose: only the server worker touches it (015). Staff still need to
-- see which guest emails could not be delivered and to send them again, so these two functions are the
-- only door, each checking the caller's permission at the reservation's property:
--   * staff_failed_emails: failed emails (five attempts used up) and emails still retrying after an error,
--     for every property the caller can see reservations at. reservation.view.
--   * resend_email: puts a failed email back in the queue with a fresh set of attempts. reservation.modify.
--     It does not send anything itself: the worker's next pass does, and the provider idempotency key
--     (the row id) keeps a resend after a send that actually got through from reaching the guest twice
--     within the provider's idempotency window.
--
-- A "your room is held" email is refused once the hold is no longer active: sending it late would tell
-- the guest something untrue. The other kinds describe the booking as it is now when they are rendered.

create function staff_failed_emails(p_limit integer default 100) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if p_limit is null or p_limit < 1 or p_limit > 200 then
    raise exception 'POLICY_VIOLATION: limit' using errcode = 'P0001';
  end if;
  return coalesce((
    select jsonb_agg(row_to_json(x)::jsonb order by x.sort_failed, x.updated_at desc)
      from (
        select e.id, e.kind, e.to_email, e.attempts, e.last_error, e.created_at, e.updated_at, e.next_attempt_at,
               r.id as reservation_id, r.property_id, r.booking_reference, r.reservation_status,
               case when e.status = 'failed' then 'failed' else 'retrying' end as state,
               case when e.status = 'failed' then 0 else 1 end as sort_failed
          from email_outbox e
          join reservations r on r.id = e.reservation_id
         where (e.status = 'failed' or (e.status = 'pending' and e.attempts > 0 and e.last_error is not null))
           and has_permission(r.property_id, 'reservation.view')
         order by (e.status = 'failed') desc, e.updated_at desc
         limit p_limit
      ) x), '[]'::jsonb);
end $$;

create function resend_email(p_email_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare e email_outbox%rowtype; r reservations%rowtype; v_actor uuid;
begin
  select * into e from email_outbox where id = p_email_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  select * into r from reservations where id = e.reservation_id;
  v_actor := require_permission(r.property_id, 'reservation.modify', 'NOT_FOUND');
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;

  select * into e from email_outbox where id = p_email_id for update;
  if e.status = 'pending' then
    return jsonb_build_object('email_id', e.id, 'status', 'pending', 'already_queued', true);   -- a double click
  end if;
  if e.status <> 'failed' then raise exception 'INVALID_STATE: %', e.status using errcode = 'P0001'; end if;
  if e.kind = 'booking_held' and r.reservation_status <> 'pending' then
    raise exception 'POLICY_VIOLATION: hold is no longer active' using errcode = 'P0001';
  end if;

  update email_outbox set status = 'pending', attempts = 0, next_attempt_at = now(), updated_at = now() where id = e.id;
  perform write_audit(e.tenant_id, r.property_id, v_actor, 'email.resend_requested', 'email', e.id, null,
                      jsonb_build_object('kind', e.kind, 'reservation_id', r.id, 'previous_attempts', e.attempts,
                                         'previous_error', e.last_error));
  return jsonb_build_object('email_id', e.id, 'status', 'pending', 'already_queued', false);
end $$;

revoke all on function staff_failed_emails(integer), resend_email(uuid) from public, anon;
grant execute on function staff_failed_emails(integer), resend_email(uuid) to authenticated;
