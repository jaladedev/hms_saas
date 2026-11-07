-- 053 Second enforced feature flag: online_payments.
--
-- With a flag row `online_payments` set to enabled = false, a guest can no longer start a card payment for that hotel group:
-- payment_start_context (the first step of the guest's "pay now") refuses, using the same refusal as a hotel with no payment
-- provider, so the guest sees the existing "payment unavailable" message and no payment attempt is created.
--
-- Deliberately NOT gated: anything that concerns money already taken or recorded by staff. Paystack webhooks, reconciliation,
-- refunds, and staff recording a manual payment all keep working, so switching the flag off never strands a payment in flight.
-- A missing row means on (see 052), so existing hotels are unchanged.

create or replace function payment_start_context(p_reservation_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r reservations%rowtype; a record; g record;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select * into r from reservations where id = p_reservation_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if not tenant_feature_on(r.tenant_id, 'online_payments') then raise exception 'INVALID_STATE: no payment provider configured' using errcode = 'P0001'; end if;
  select id, secret_reference, mode into a from payment_provider_accounts
   where tenant_id = r.tenant_id and provider = 'paystack' and status = 'active' and secret_reference is not null
   order by (mode = 'live') desc limit 1;
  if not found then raise exception 'INVALID_STATE: no payment provider configured' using errcode = 'P0001'; end if;
  select email, full_name into g from guests where id = r.primary_guest_id;
  if not found or g.email is null then raise exception 'INVALID_STATE: guest email missing' using errcode = 'P0001'; end if;
  return jsonb_build_object('account_id', a.id, 'secret_reference', a.secret_reference, 'mode', a.mode,
                            'guest_email', g.email, 'booking_reference', r.booking_reference);
end $$;
