-- Payment verification (TODO: "payment verification workflow"; ui-spec page 29/30).
--
-- RULE. A payment taken by hand is either checked by the person who took it or it is not. Cash and card-terminal (pos) payments
-- are counted as verified the moment they are recorded. Bank transfers and "other" are recorded as UNVERIFIED: they still
-- count toward the balance (the guest has said they paid and the desk has the slip), but they sit in a queue until
-- somebody holding payment.verify checks them against the bank statement. A payment that turns out not to exist is undone
-- with the existing reverse_payment. Payments that came through Paystack are verified by definition.
-- Whoever holds payment.verify may verify, including the person who recorded the payment (small hotels have one accountant).
--
--   payments.verification_status   'verified' | 'unverified'  (default 'verified'; set by the insert trigger)
--   payments.verified_at, verified_by, verification_note
--   verify_payment(payment, note)          payment.verify; marks it verified, audit 'payment.verified'; verifying twice is harmless
--   payments_to_verify(status, limit)      payment.verify; the queue ('unverified', oldest first) or recent verified ones, with counts
-- A new unverified payment raises a 'payment_unverified' notice (money, attention) for payment.verify holders.
-- Folio (extras) payments are NOT covered: they are taken at the desk and have no verification step.

alter table payments
  add column verification_status text not null default 'verified' check (verification_status in ('verified', 'unverified')),
  add column verified_at timestamptz,
  add column verified_by uuid,
  add column verification_note text;

-- Existing manual bank transfers and "other" payments have never been checked, so they join the queue.
update payments set verification_status = 'unverified'
 where payment_provider = 'manual' and payment_method in ('bank_transfer', 'other') and payment_status = 'succeeded';
update payments set verified_at = coalesce(received_at, created_at) where verification_status = 'verified';

create function payments_set_verification() returns trigger language plpgsql as $$
begin
  if new.payment_provider = 'manual' and new.payment_method in ('bank_transfer', 'other') then
    new.verification_status := 'unverified'; new.verified_at := null; new.verified_by := null; new.verification_note := null;
  else
    new.verification_status := 'verified'; new.verified_at := coalesce(new.verified_at, now());
  end if;
  return new;
end $$;
revoke all on function payments_set_verification() from public, anon, authenticated;
create trigger payments_set_verification_trg before insert on payments for each row execute function payments_set_verification();

-- The verification columns may change after the fact; the guard already leaves them alone (it watches only the money fields),
-- but a verified payment may never go back to unverified.
create function payments_verification_guard() returns trigger language plpgsql as $$
begin
  if old.verification_status = 'verified' and new.verification_status = 'unverified' then
    raise exception 'a verified payment cannot become unverified' using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function payments_verification_guard() from public, anon, authenticated;
create trigger payments_verification_guard_trg before update on payments for each row execute function payments_verification_guard();

-- ---- Notice ------------------------------------------------------------------------------------------------------

alter table notifications drop constraint notifications_kind_check;
alter table notifications add constraint notifications_kind_check check (kind in (
  'reservation_attention', 'refund_needs_bank_details', 'refund_needs_attention', 'email_failed', 'repair_urgent', 'repair_overdue',
  'guest_cancelled', 'website_booking', 'no_show', 'room_dirty_arrival', 'payment_unverified'));

create function notify_payment_unverified() returns trigger language plpgsql security definer set search_path = public as $$
declare v_ref text;
begin
  select booking_reference into v_ref from reservations where id = new.reservation_id;
  perform enqueue_notification(new.property_id, 'payment_unverified', 'money', 'attention',
    'Payment to verify: ' || coalesce(v_ref, 'a booking'),
    to_char(new.amount_minor / 100.0, 'FM999G999G999G990D00') || ' ' || new.currency || ' by ' || replace(new.payment_method, '_', ' ')
      || ' has been recorded but not checked against the bank.',
    '/app/payments', 'payment.verify', 'payment', new.id, 'unverified:' || new.id);
  return null;
exception when others then
  raise warning 'payment notice failed: %', sqlerrm;
  return null;
end $$;
revoke all on function notify_payment_unverified() from public, anon, authenticated;
create trigger payments_notify_unverified after insert on payments
  for each row when (new.verification_status = 'unverified' and new.payment_status = 'succeeded')
  execute function notify_payment_unverified();

-- ---- Functions ---------------------------------------------------------------------------------------------------

create function verify_payment(p_payment_id uuid, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare pay payments%rowtype; v_actor uuid; v_note text := nullif(left(trim(coalesce(p_note, '')), 500), '');
begin
  select * into pay from payments where id = p_payment_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(pay.property_id, 'payment.verify', 'NOT_FOUND');

  perform 1 from reservations where id = pay.reservation_id for update;
  select * into pay from payments where id = p_payment_id;
  if pay.payment_status <> 'succeeded' then raise exception 'INVALID_STATE: payment %', pay.payment_status using errcode = 'P0001'; end if;
  if pay.verification_status = 'verified' then
    return jsonb_build_object('payment_id', pay.id, 'verification_status', 'verified', 'already', true);
  end if;

  update payments set verification_status = 'verified', verified_at = now(), verified_by = v_actor, verification_note = v_note where id = pay.id;
  perform write_audit(pay.tenant_id, pay.property_id, v_actor, 'payment.verified', 'payment', pay.id, null,
                      jsonb_build_object('amount_minor', pay.amount_minor, 'currency', pay.currency, 'method', pay.payment_method,
                                         'reference', pay.provider_reference, 'note', v_note, 'recorded_by', pay.recorded_by));
  return jsonb_build_object('payment_id', pay.id, 'verification_status', 'verified', 'already', false);
end $$;

create function payments_to_verify(p_status text default 'unverified', p_limit integer default 100) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_rows jsonb; v_open integer;
begin
  if v_uid is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if p_status is null or p_status not in ('unverified', 'verified') or p_limit is null or p_limit < 1 or p_limit > 200 then
    raise exception 'POLICY_VIOLATION: arguments' using errcode = 'P0001';
  end if;

  with mine as (
    select p.*, pr.name as property_name, r.booking_reference,
           case when has_permission(p.property_id, 'guest.view') then g.full_name end as guest_name,
           (select up.full_name from user_profiles up where up.id = p.recorded_by) as recorded_by_name,
           (select up.full_name from user_profiles up where up.id = p.verified_by) as verified_by_name
      from payments p
      join properties pr on pr.id = p.property_id
      join reservations r on r.id = p.reservation_id
      left join guests g on g.id = r.primary_guest_id
     where p.payment_provider = 'manual' and p.payment_status = 'succeeded' and has_permission(p.property_id, 'payment.verify')
  )
  select coalesce((select jsonb_agg(jsonb_build_object(
           'id', id, 'property_id', property_id, 'property_name', property_name, 'reservation_id', reservation_id,
           'booking_reference', booking_reference, 'guest_name', guest_name, 'amount_minor', amount_minor, 'currency', currency,
           'method', payment_method, 'reference', provider_reference, 'note', note, 'received_at', received_at,
           'recorded_by_name', recorded_by_name, 'verification_status', verification_status, 'verified_at', verified_at,
           'verified_by_name', verified_by_name, 'verification_note', verification_note)
           order by case when p_status = 'unverified' then received_at end asc, case when p_status = 'verified' then verified_at end desc, id)
         from (select * from mine where verification_status = p_status
                order by case when p_status = 'unverified' then received_at end asc, case when p_status = 'verified' then verified_at end desc, id
                limit p_limit) page), '[]'::jsonb),
         count(*) filter (where verification_status = 'unverified')::integer
    into v_rows, v_open from mine;
  return jsonb_build_object('items', v_rows, 'unverified', v_open);
end $$;

revoke all on function verify_payment(uuid, text), payments_to_verify(text, integer) from public, anon;
grant execute on function verify_payment(uuid, text), payments_to_verify(text, integer) to authenticated;
