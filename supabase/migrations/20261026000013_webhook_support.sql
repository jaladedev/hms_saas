-- 013 Server-side lookups for the Paystack webhook route and the guest booking pages.
-- All service_role only. They return only what the caller needs and never a secret value:
-- payment_provider_accounts.secret_reference is a pointer ("env:NAME"), resolved by the server.

-- The webhook URL carries the provider account id (/api/webhooks/paystack/<account id>), so the
-- route knows which tenant and which secret an incoming event must be checked against.
create function payment_provider_account_for_webhook(p_account_id uuid)
returns table (tenant_id uuid, provider text, mode text, secret_reference text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  return query
    select a.tenant_id, a.provider, a.mode, a.secret_reference
      from payment_provider_accounts a
      join tenants t on t.id = a.tenant_id and t.status = 'active'
     where a.id = p_account_id and a.status = 'active' and a.secret_reference is not null;
end $$;

-- Provider refund webhooks identify the original transaction and the amount, not our refund row.
-- Match the oldest refund still processing for that transaction and amount, inside one tenant.
create function find_processing_refund(p_tenant_id uuid, p_provider text, p_transaction_reference text, p_amount_minor bigint)
returns uuid language plpgsql stable security definer set search_path = public as $$
declare v_id uuid;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select f.id into v_id
    from refunds f join payments p on p.id = f.payment_id
   where f.tenant_id = p_tenant_id and p.payment_provider = p_provider and p.provider_reference = p_transaction_reference
     and f.refund_status = 'processing' and f.amount_minor = p_amount_minor
   order by f.created_at, f.id limit 1;
  return v_id;
end $$;

-- What a guest may see about their own booking, after the server has checked their token.
create function guest_booking_status(p_reservation_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r reservations%rowtype; v_prop record; v_held bigint; v_hold timestamptz;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select * into r from reservations where id = p_reservation_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  select name, check_in_time, check_out_time, timezone into v_prop from properties where id = r.property_id;
  v_held := reservation_money_held(r.id);
  select min(c.hold_expires_at) into v_hold
    from reservation_rooms rr join room_inventory_claims c on c.reservation_room_id = rr.id
   where rr.reservation_id = r.id and c.claim_type = 'hold' and c.status = 'active' and c.hold_expires_at > now();
  return jsonb_build_object(
    'reservation_id', r.id, 'booking_reference', r.booking_reference, 'status', r.reservation_status,
    'payment_status', r.payment_status, 'property_name', v_prop.name, 'timezone', v_prop.timezone,
    'arrival_date', r.arrival_date, 'departure_date', r.departure_date,
    'check_in_time', v_prop.check_in_time, 'check_out_time', v_prop.check_out_time,
    'currency', r.currency, 'total_minor', r.total_minor, 'paid_minor', v_held,
    'outstanding_minor', greatest(r.total_minor - v_held, 0), 'hold_expires_at', v_hold,
    'rooms', (select coalesce(jsonb_agg(jsonb_build_object('room_type', rt.name, 'adults', rr.adults, 'children', rr.children)
                                         order by rr.id), '[]'::jsonb)
                from reservation_rooms rr join room_types rt on rt.id = rr.room_type_id
               where rr.reservation_id = r.id and rr.room_status = 'booked'));
end $$;

revoke all on function payment_provider_account_for_webhook(uuid), find_processing_refund(uuid, text, text, bigint),
  guest_booking_status(uuid) from public, anon, authenticated;
grant execute on function payment_provider_account_for_webhook(uuid), find_processing_refund(uuid, text, text, bigint),
  guest_booking_status(uuid) to service_role;
