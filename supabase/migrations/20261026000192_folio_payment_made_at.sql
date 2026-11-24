-- 192 Money taken for extras keeps the time it was taken (TODO "Offline step 2b", the late-payment decision). The note is now written here, not by the app.
--
-- Until now `record_folio_payment` stamped `received_at = now()`, so cash taken at 14:05 on a laptop with no connection and sent the
-- next morning counted in the next day's report, and the offline queue had to write the real time into the note instead. The function
-- now takes an optional last argument `p_at`, the time the person actually took the money:
--   * null (every online caller, and every payment made before this migration) behaves exactly as before: received_at is now();
--   * otherwise received_at is p_at, kept inside bounds the database trusts, because the clock on a hotel laptop is not
--     trustworthy (the same bounds as housekeeping, migration 185): never later than now(), never more than two days before now(),
--     never before the booking existed. A value outside the bounds is moved to the nearest bound; the payment is not refused, since the
--     money was taken and a refusal would leave the guest's balance wrong;
--   * a signed-off day is never changed. If the hotel day of that time has been closed (migration 145, `day_closes`), the payment is
--     recorded now, on the open day, and says so in its note. A closed day's report must not move after the manager signed it.
-- The note says when the money was taken, written here and not by the app: "<the person's note> · Taken offline at 2026-11-23 14:05 UTC",
-- or "... Taken offline at ... UTC; that day is closed, recorded today". Nothing is added when the time is within a minute of now (a
-- change made online, or sent the moment the connection came back). The person's own note is trimmed first to fit 500 characters.
--
-- Idempotency: the time is NOT part of the request hash. The key and the money (booking, amount, method, reference, note) are what a
-- repeat must match; the time is advice, and the app may send a slightly different clamped value on a retry. A repeat returns the first
-- answer whatever time it carries. (The hash of a call without a time is unchanged.)
--
-- The audit entry of a payment made with a time also records `made_at` (the time asked for, after the bounds), `received_at` (the time
-- the payment was recorded at) and `day_closed` (true when the closed-day rule moved it to now).
--
-- The old six-argument signature is dropped, so the API has one function of this name (PostgREST cannot choose between overloads that
-- differ only by a defaulted argument). Callers that omit `p_at` keep working through its default. Privileges are as before:
-- authenticated only, no anon, security definer, search_path = public.

-- ---- the time a payment is recorded at ------------------------------------------------------
create function payment_effective_time(p_at timestamptz, p_floor timestamptz) returns timestamptz
language sql stable set search_path = public as $$
  select case
           when p_at is null then now()
           else least(now(), greatest(p_at, now() - interval '2 days', coalesce(p_floor, '-infinity'::timestamptz)))
         end
$$;
revoke all on function payment_effective_time(timestamptz, timestamptz) from public, anon, authenticated;

drop function record_folio_payment(uuid, bigint, text, text, text, text);

create function record_folio_payment(
  p_reservation_id  uuid,
  p_amount_minor    bigint,
  p_method          text,
  p_reference       text,
  p_note            text,
  p_idempotency_key text,
  p_at         timestamptz default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r reservations%rowtype; v_actor uuid; v_idem record; v_hash text; v_tot record; v_id uuid := gen_random_uuid(); v_ref text;
  v_reference text := nullif(btrim(p_reference), ''); v_note text := nullif(btrim(p_note), ''); v_result jsonb;
  v_made timestamptz; v_at timestamptz; v_closed boolean := false; v_stamp text; v_stored_note text;
begin
  select * into r from reservations where id = p_reservation_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(r.property_id, 'payment.record', 'NOT_FOUND');
  if p_amount_minor is null or p_amount_minor <= 0 then
    raise exception 'POLICY_VIOLATION: amount must be positive' using errcode = 'P0001';
  end if;
  if p_method is null or p_method not in ('cash', 'bank_transfer', 'pos', 'other') then
    raise exception 'POLICY_VIOLATION: payment method' using errcode = 'P0001';
  end if;
  if length(v_reference) > 100 or length(v_note) > 500 then raise exception 'POLICY_VIOLATION: too long' using errcode = 'P0001'; end if;

  -- the time is not in the hash (see above), so this is the same hash as before this migration
  v_hash := md5(concat_ws('|', p_reservation_id, p_amount_minor, p_method, coalesce(v_reference, ''), coalesce(v_note, '')));
  select * into v_idem from idem_begin(r.tenant_id, 'record_folio_payment', p_idempotency_key, v_hash);
  if not v_idem.out_is_new then return v_idem.out_response; end if;

  select * into r from reservations where id = p_reservation_id for update;
  if r.reservation_status not in ('checked_in', 'checked_out') then
    raise exception 'INVALID_STATE: %', r.reservation_status using errcode = 'P0001';
  end if;
  select * into v_tot from folio_totals(r.id);
  if v_tot.paid_minor + p_amount_minor > v_tot.charges_minor then
    raise exception 'POLICY_VIOLATION: OVERPAYMENT outstanding %', v_tot.charges_minor - v_tot.paid_minor using errcode = 'P0001';
  end if;

  -- when the money was taken, and when it is recorded: a closed hotel day is never added to
  v_made := payment_effective_time(p_at, r.created_at);
  v_at := v_made;
  if p_at is not null and exists (
       select 1 from day_closes d join properties pr on pr.id = d.property_id
        where d.property_id = r.property_id and d.business_date = (v_made at time zone pr.timezone)::date) then
    v_at := now();
    v_closed := true;
  end if;
  v_stored_note := v_note;
  if p_at is not null and (v_closed or v_made < now() - interval '1 minute') then
    v_stamp := 'Taken offline at ' || to_char(v_made at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC'
               || case when v_closed then '; that day is closed, recorded today' else '' end;
    v_stored_note := case when v_note is null then v_stamp
                          else rtrim(left(v_note, 500 - length(v_stamp) - 3)) || ' · ' || v_stamp end;
  end if;

  loop
    v_ref := 'FOL-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
    exit when not exists (select 1 from folio_payments where tenant_id = r.tenant_id and internal_reference = v_ref);
  end loop;
  insert into folio_payments (id, tenant_id, property_id, reservation_id, payment_method, provider_reference, internal_reference,
                              amount_minor, currency, note, received_at, recorded_by)
  values (v_id, r.tenant_id, r.property_id, r.id, p_method, v_reference, v_ref, p_amount_minor, r.currency, v_stored_note, v_at, v_actor);

  v_result := jsonb_build_object('payment_id', v_id, 'internal_reference', v_ref, 'amount_minor', p_amount_minor,
                                 'charges_minor', v_tot.charges_minor, 'paid_minor', v_tot.paid_minor + p_amount_minor,
                                 'balance_minor', v_tot.charges_minor - v_tot.paid_minor - p_amount_minor);
  perform idem_finish(r.tenant_id, 'record_folio_payment', p_idempotency_key, v_result);
  perform write_audit(r.tenant_id, r.property_id, v_actor, 'folio.payment_recorded', 'folio_payment', v_id, p_idempotency_key,
                      jsonb_build_object('reservation_id', r.id, 'amount_minor', p_amount_minor, 'method', p_method, 'internal_reference', v_ref)
                      || case when p_at is null then '{}'::jsonb
                              else jsonb_build_object('made_at', v_made, 'received_at', v_at, 'day_closed', v_closed) end);
  return v_result;
end $$;
revoke all on function record_folio_payment(uuid, bigint, text, text, text, text, timestamptz) from public, anon;
grant execute on function record_folio_payment(uuid, bigint, text, text, text, text, timestamptz) to authenticated;
