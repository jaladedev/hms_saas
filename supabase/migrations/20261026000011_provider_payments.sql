-- 011 Provider payments (Paystack), server side only: payment_provider_accounts, payment_attempts,
-- payment_events, create_payment_attempt, confirm_payment, expire_lapsed_holds. Refunds are 012.
--
-- All functions here are executable by service_role only. The Next.js route or Edge Function that
-- receives a Paystack webhook must first verify the signature (HMAC-SHA512 of the raw body with the
-- merchant secret) and re-verify the transaction with Paystack's verify endpoint, then pass the
-- VERIFIED reference, status, amount and currency to confirm_payment. Nothing from a browser, and
-- nothing unverified, may reach it. Amounts are kobo end to end (Paystack's NGN unit is kobo), so no
-- conversion happens in the database.
--
-- confirm_payment rules:
--   * One row per (provider, event id) in payment_events; a repeated delivery returns the stored
--     result and changes nothing. A second event for an already-succeeded reference is ignored.
--   * The verified amount and currency must equal the attempt's. Otherwise nothing is recorded as
--     money, the attempt becomes needs_attention and the reservation is flagged for staff.
--   * Money that really arrived is always recorded, even when the booking can no longer be honoured.
--     A pending or expired reservation is confirmed by turning its holds into stays in place, or by
--     re-claiming the same room (then any room of the type) if the hold was released. If no room is
--     left the reservation keeps its status, gets attention_reason 'paid_inventory_lost', and the
--     payment stays on record for a refund or alternative.
--   * Payments arriving after cancellation are recorded and flagged 'paid_after_cancel'.

create table payment_provider_accounts (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenants(id),
  provider             text not null check (provider in ('paystack')),
  mode                 text not null check (mode in ('test', 'live')),
  account_label        text not null,
  public_configuration jsonb not null default '{}'::jsonb,
  secret_reference     text,                 -- pointer to server-side secret storage, never the secret
  status               text not null default 'inactive' check (status in ('inactive', 'active', 'disabled')),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (tenant_id, provider, mode)
);
alter table payment_provider_accounts enable row level security;   -- no policy: server only
revoke all on payment_provider_accounts from authenticated, anon;
create trigger payment_provider_accounts_updated before update on payment_provider_accounts
  for each row execute function set_updated_at();

create table payment_attempts (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null,
  property_id    uuid not null,
  reservation_id uuid not null,
  provider       text not null check (provider in ('paystack')),
  reference      text not null,
  amount_minor   bigint not null check (amount_minor > 0),
  currency       char(3) not null,
  status         text not null default 'initiated'
    check (status in ('initiated', 'succeeded', 'failed', 'abandoned', 'needs_attention')),
  failure_reason text,
  created_by     uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  completed_at   timestamptz,
  foreign key (tenant_id, property_id, reservation_id) references reservations (tenant_id, property_id, id),
  unique (provider, reference)
);
create index on payment_attempts (reservation_id, status);
create trigger payment_attempts_updated before update on payment_attempts
  for each row execute function set_updated_at();
alter table payment_attempts enable row level security;
create policy payment_attempts_select on payment_attempts for select to authenticated using (can_view_money(property_id));
revoke insert, update, delete on payment_attempts from authenticated, anon;

create table payment_events (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid,                       -- known once the reference is matched
  provider           text not null,
  provider_event_id  text not null check (length(provider_event_id) > 0),
  event_type         text,
  provider_reference text,
  processing_status  text not null default 'received'
    check (processing_status in ('received', 'processed', 'ignored', 'mismatch')),
  result             jsonb,
  payload            jsonb not null default '{}'::jsonb,
  error_summary      text,
  received_at        timestamptz not null default now(),
  processed_at       timestamptz,
  unique (provider, provider_event_id)
);
create index on payment_events (provider, provider_reference);
alter table payment_events enable row level security;   -- no policy: server only
revoke all on payment_events from authenticated, anon;

-- Provider payments extend the manual ones.
alter table payments drop constraint payments_payment_method_check;
alter table payments add constraint payments_payment_method_check
  check (payment_method in ('cash', 'bank_transfer', 'pos', 'other', 'card', 'bank', 'ussd', 'qr', 'mobile_money', 'eft'));
alter table payments add column attempt_id uuid references payment_attempts(id);
create unique index payments_one_per_provider_reference on payments (payment_provider, provider_reference)
  where payment_provider <> 'manual' and provider_reference is not null;

-- ---- create_payment_attempt ---------------------------------------------------------------
-- Amount is decided here, never by the caller: for a pending online reservation it is the
-- policy's required amount (policy_snapshot.online_payment: {"mode":"deposit_percent","value":30},
-- default the full total) less what is already paid; for a confirmed one it is the outstanding
-- balance. The reservation's hold must still be live. Holds are not extended by starting a payment.
create function create_payment_attempt(p_reservation_id uuid, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r reservations%rowtype; v_idem record; v_hash text; v_paid bigint; v_required bigint; v_amount bigint;
  v_mode text; v_pct numeric; v_ref text; v_id uuid := gen_random_uuid(); v_result jsonb;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select * into r from reservations where id = p_reservation_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;

  v_hash := md5(p_reservation_id::text);
  select * into v_idem from idem_begin(r.tenant_id, 'create_payment_attempt', p_idempotency_key, v_hash);
  if not v_idem.out_is_new then return v_idem.out_response; end if;

  if not exists (select 1 from payment_provider_accounts
                  where tenant_id = r.tenant_id and provider = 'paystack' and status = 'active') then
    raise exception 'INVALID_STATE: no payment provider configured' using errcode = 'P0001';
  end if;

  select * into r from reservations where id = p_reservation_id for update;
  if r.reservation_status not in ('pending', 'confirmed', 'checked_in') then
    raise exception 'INVALID_STATE: %', r.reservation_status using errcode = 'P0001';
  end if;
  if r.reservation_status = 'pending' and exists (
       select 1 from reservation_rooms rr
        where rr.reservation_id = r.id and rr.room_status = 'booked'
          and not exists (select 1 from room_inventory_claims c
                           where c.reservation_room_id = rr.id and c.status = 'active'
                             and (c.claim_type = 'stay' or (c.claim_type = 'hold' and c.hold_expires_at > now())))) then
    raise exception 'INVALID_STATE: hold lapsed' using errcode = 'P0001';
  end if;

  select coalesce(sum(amount_minor), 0) into v_paid from payments
   where reservation_id = r.id and payment_status = 'succeeded';
  if r.reservation_status = 'pending' then
    v_mode := coalesce(r.policy_snapshot -> 'online_payment' ->> 'mode', 'full');
    v_pct  := coalesce((r.policy_snapshot -> 'online_payment' ->> 'value')::numeric, 100);
    v_required := case when v_mode = 'deposit_percent' then ceil(r.total_minor * v_pct / 100)::bigint else r.total_minor end;
    v_amount := least(greatest(v_required - v_paid, 0), r.total_minor - v_paid);
  else
    v_amount := r.total_minor - v_paid;
  end if;
  if v_amount <= 0 then raise exception 'INVALID_STATE: nothing due' using errcode = 'P0001'; end if;

  loop
    v_ref := 'HMS-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 16));
    exit when not exists (select 1 from payment_attempts where provider = 'paystack' and reference = v_ref);
  end loop;
  insert into payment_attempts (id, tenant_id, property_id, reservation_id, provider, reference, amount_minor, currency)
  values (v_id, r.tenant_id, r.property_id, r.id, 'paystack', v_ref, v_amount, r.currency);

  v_result := jsonb_build_object('attempt_id', v_id, 'reference', v_ref, 'amount_minor', v_amount,
                                 'currency', r.currency, 'booking_reference', r.booking_reference);
  perform idem_finish(r.tenant_id, 'create_payment_attempt', p_idempotency_key, v_result);
  perform write_audit(r.tenant_id, r.property_id, null, 'payment_attempt.created', 'payment_attempt', v_id,
                      p_idempotency_key, jsonb_build_object('reservation_id', r.id, 'amount_minor', v_amount));
  return v_result;
end $$;

-- ---- confirm_payment ----------------------------------------------------------------------
create function confirm_payment(
  p_provider text, p_event_id text, p_event_type text, p_reference text, p_status text,
  p_amount_minor bigint, p_currency text, p_channel text, p_payload jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  a payment_attempts%rowtype; r reservations%rowtype; v_event uuid; v_prior jsonb;
  v_result jsonb; v_ev_status text := 'processed'; v_summary text;
  v_paid bigint; v_pay uuid := gen_random_uuid(); v_ref text; v_method text; v_inv uuid;
  v_inventory text := 'none'; rr record; v_prev_room uuid; v_alloc bigint := 0;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  if p_provider is null or p_event_id is null or length(p_event_id) = 0 or p_reference is null or length(p_reference) = 0 then
    raise exception 'POLICY_VIOLATION: provider, event id and reference required' using errcode = 'P0001';
  end if;
  if p_status is null or p_status not in ('success', 'failed', 'abandoned') then
    raise exception 'POLICY_VIOLATION: status' using errcode = 'P0001';
  end if;

  insert into payment_events (provider, provider_event_id, event_type, provider_reference, payload)
  values (p_provider, p_event_id, p_event_type, p_reference, coalesce(p_payload, '{}'::jsonb))
  on conflict (provider, provider_event_id) do nothing
  returning id into v_event;
  if v_event is null then
    -- Repeat delivery. If the first one is still running, the insert above waited for its commit.
    select result into v_prior from payment_events where provider = p_provider and provider_event_id = p_event_id;
    return coalesce(v_prior, '{}'::jsonb) || jsonb_build_object('duplicate', true);
  end if;

  select * into a from payment_attempts where provider = p_provider and reference = p_reference for update;
  if not found then
    v_result := jsonb_build_object('result', 'ignored', 'reason', 'unknown reference');
    update payment_events set processing_status = 'ignored', result = v_result, processed_at = now(),
           error_summary = 'unknown reference' where id = v_event;
    return v_result;
  end if;
  update payment_events set tenant_id = a.tenant_id where id = v_event;
  select * into r from reservations where id = a.reservation_id for update;

  if a.status = 'succeeded' then
    v_result := jsonb_build_object('result', 'already_processed', 'reservation_id', r.id);
    v_ev_status := 'ignored';
  elsif a.status = 'needs_attention' then
    v_result := jsonb_build_object('result', 'ignored', 'reason', 'attempt needs attention', 'reservation_id', r.id);
    v_ev_status := 'ignored';
  elsif p_status <> 'success' then
    update payment_attempts set status = case p_status when 'failed' then 'failed' else 'abandoned' end,
           completed_at = now() where id = a.id;
    if p_status = 'failed' and r.payment_status = 'unpaid' then
      update reservations set payment_status = 'payment_failed' where id = r.id;
    end if;
    v_result := jsonb_build_object('result', p_status, 'reservation_id', r.id);
  else
    select coalesce(sum(amount_minor), 0) into v_paid from payments
     where reservation_id = r.id and payment_status = 'succeeded';
    if p_amount_minor is distinct from a.amount_minor or upper(coalesce(p_currency, '')) <> a.currency then
      v_summary := 'amount_or_currency_mismatch';
    elsif v_paid + a.amount_minor > r.total_minor then
      v_summary := 'overpayment';
    end if;

    if v_summary is not null then
      update payment_attempts set status = 'needs_attention', failure_reason = v_summary, completed_at = now() where id = a.id;
      update reservations set attention_reason = 'payment_' || v_summary where id = r.id;
      v_result := jsonb_build_object('result', 'mismatch', 'reason', v_summary, 'reservation_id', r.id);
      v_ev_status := 'mismatch';
    else
      -- real, verified money: record it first, whatever happens to the booking
      loop
        v_ref := 'PAY-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
        exit when not exists (select 1 from payments where tenant_id = r.tenant_id and internal_reference = v_ref);
      end loop;
      v_method := case when lower(coalesce(p_channel, '')) in ('card', 'bank', 'ussd', 'qr', 'mobile_money', 'eft', 'bank_transfer')
                       then lower(p_channel) else 'other' end;
      insert into payments (id, tenant_id, property_id, reservation_id, payment_provider, payment_method,
                            provider_reference, internal_reference, amount_minor, currency, attempt_id)
      values (v_pay, r.tenant_id, r.property_id, r.id, p_provider, v_method, p_reference, v_ref,
              a.amount_minor, a.currency, a.id);
      update payment_attempts set status = 'succeeded', completed_at = now() where id = a.id;

      if r.reservation_status in ('pending', 'expired') then
        begin
          update room_inventory_claims set claim_type = 'stay', hold_expires_at = null
           where claim_type = 'hold' and status = 'active'
             and reservation_room_id in (select id from reservation_rooms where reservation_id = r.id);
          for rr in
            select x.id, x.room_type_id from reservation_rooms x
             where x.reservation_id = r.id and x.room_status = 'booked'
               and not exists (select 1 from room_inventory_claims c
                                where c.reservation_room_id = x.id and c.status = 'active' and c.claim_type = 'stay')
             order by x.id
          loop
            select room_id into v_prev_room from room_inventory_claims
             where reservation_room_id = rr.id order by created_at desc limit 1;
            begin
              perform claim_room(r.property_id, null, v_prev_room, r.arrival_date, r.departure_date, 'stay', rr.id);
            exception when sqlstate 'P0001' then
              if sqlerrm not like 'ROOM_UNAVAILABLE%' then raise; end if;
              perform claim_room(r.property_id, rr.room_type_id, null, r.arrival_date, r.departure_date, 'stay', rr.id);
            end;
          end loop;
          update reservations set reservation_status = 'confirmed', attention_reason = null where id = r.id;
          v_inventory := 'confirmed';
        exception when sqlstate 'P0001' then
          if sqlerrm not like 'ROOM_UNAVAILABLE%' then raise; end if;
          v_inventory := 'lost';       -- everything inside this block, including converted holds, is undone
        end;
        if v_inventory = 'lost' then
          update reservations set attention_reason = 'paid_inventory_lost' where id = r.id;
        end if;
      elsif r.reservation_status in ('cancelled', 'no_show') then
        update reservations set attention_reason = 'paid_after_cancel' where id = r.id;
        v_inventory := 'cancelled';
      end if;

      select id into v_inv from invoices where reservation_id = r.id and invoice_status <> 'void';
      if v_inv is not null then
        v_alloc := allocate_payments_to_invoice(v_inv);
        perform refresh_invoice_status(v_inv);
      end if;
      if (select payment_status from reservations where id = r.id) = 'payment_failed' then
        update reservations set payment_status = 'unpaid' where id = r.id;
      end if;
      perform refresh_reservation_payment_status(r.id);

      v_result := jsonb_build_object(
        'result', case v_inventory when 'confirmed' then 'confirmed' when 'lost' then 'recorded_inventory_lost'
                                   when 'cancelled' then 'recorded_after_cancel' else 'recorded' end,
        'reservation_id', r.id, 'payment_id', v_pay, 'amount_minor', a.amount_minor, 'allocated_minor', v_alloc,
        'reservation_status', (select reservation_status from reservations where id = r.id),
        'payment_status', (select payment_status from reservations where id = r.id));
      perform write_audit(r.tenant_id, r.property_id, null, 'payment.confirmed', 'payment', v_pay, p_event_id,
                          jsonb_build_object('reservation_id', r.id, 'amount_minor', a.amount_minor,
                                             'provider_reference', p_reference, 'inventory', v_inventory));
    end if;
  end if;

  update payment_events set processing_status = v_ev_status, result = v_result, processed_at = now(),
         error_summary = v_summary where id = v_event;
  return v_result;
end $$;

-- ---- expire_lapsed_holds ------------------------------------------------------------------
-- Backstop sweep for online reservations nobody paid for. A reservation is expired when none of its
-- holds is live any more and no payment attempt was started in the last 30 minutes (a payer may
-- still be on the provider's page). A payment that arrives afterwards is handled by confirm_payment.
create function expire_lapsed_holds(p_limit integer default 200) returns integer
language plpgsql security definer set search_path = public as $$
declare r record; n integer := 0;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  for r in
    select res.id, res.tenant_id, res.property_id from reservations res
     where res.reservation_status = 'pending' and res.source = 'website'
       and not exists (select 1 from reservation_rooms rr join room_inventory_claims c on c.reservation_room_id = rr.id
                        where rr.reservation_id = res.id and c.status = 'active'
                          and (c.claim_type = 'stay' or (c.claim_type = 'hold' and c.hold_expires_at > now())))
       and not exists (select 1 from payment_attempts pa
                        where pa.reservation_id = res.id and pa.status = 'initiated'
                          and pa.created_at > now() - interval '30 minutes')
     order by res.created_at
     limit p_limit
     for update of res skip locked
  loop
    update room_inventory_claims set status = 'expired'
     where claim_type = 'hold' and status = 'active'
       and reservation_room_id in (select id from reservation_rooms where reservation_id = r.id);
    update reservations set reservation_status = 'expired' where id = r.id;
    perform write_audit(r.tenant_id, r.property_id, null, 'reservation.expired', 'reservation', r.id, null, '{}'::jsonb);
    n := n + 1;
  end loop;
  return n;
end $$;

revoke all on function create_payment_attempt(uuid, text),
  confirm_payment(text, text, text, text, text, bigint, text, text, jsonb),
  expire_lapsed_holds(integer) from public, anon, authenticated;
grant execute on function create_payment_attempt(uuid, text),
  confirm_payment(text, text, text, text, text, bigint, text, text, jsonb),
  expire_lapsed_holds(integer) to service_role;
