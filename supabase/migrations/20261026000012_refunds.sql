-- 012 Refunds and payment reversal.
--
-- Rules:
--   * Money out takes two people. refund.request creates a request; a different person with
--     refund.approve approves or rejects it (SELF_APPROVAL is refused). The check lives in the function.
--   * A refund can never exceed what is left on its payment: payment amount minus every refund that
--     is requested, approved, processing or succeeded. Requests lock the reservation row, so
--     concurrent requests cannot jointly exceed it.
--   * Manual payments (cash, bank transfer, POS) are refunded by staff, who record the payout with
--     record_manual_refund. Provider payments are refunded through the provider: the server calls
--     begin_refund_processing, calls the provider's refund API, then reports the outcome with
--     record_refund_result (idempotent per provider event). Both server functions are service_role only.
--   * "Money held" for a reservation is succeeded payments minus succeeded refunds. Reservation
--     payment_status (paid, partially_paid, partially_refunded, refunded, unpaid) and invoice status
--     are derived from it. Allocations stay as the history of how payments were applied.
--   * reverse_payment undoes a manual payment recorded by mistake (no refund involved). It needs
--     refund.approve and is refused while the payment has any live refund.
--   * A paid invoice can be voided once the money held is zero (everything refunded or reversed).

create table refunds (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null,
  property_id        uuid not null,
  reservation_id     uuid not null,
  payment_id         uuid not null,
  internal_reference text not null,
  amount_minor       bigint not null check (amount_minor > 0),
  currency           char(3) not null,
  refund_status      text not null default 'requested'
    check (refund_status in ('requested', 'approved', 'rejected', 'processing', 'succeeded', 'failed')),
  reason             text not null check (length(trim(reason)) > 0),
  requested_by       uuid,
  decided_by         uuid,
  decided_at         timestamptz,
  decision_note      text,
  provider_refund_id text,
  payout_reference   text,
  failure_reason     text,
  -- Paystack's refund API has no idempotency key, so the provider is called at most once per refund.
  -- provider_call_started_at is set the first time a caller is told it may call; later callers are refused.
  provider_call_started_at timestamptz,
  attention_note     text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  completed_at       timestamptz,
  foreign key (tenant_id, property_id, reservation_id) references reservations (tenant_id, property_id, id),
  foreign key (tenant_id, payment_id) references payments (tenant_id, id),
  unique (tenant_id, internal_reference),
  check (decided_by is null or requested_by is null or decided_by <> requested_by)
);
create index on refunds (payment_id, refund_status);
create index on refunds (reservation_id);

create function refunds_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'refunds cannot be deleted' using errcode = '23514'; end if;
  if (new.tenant_id, new.property_id, new.reservation_id, new.payment_id, new.internal_reference,
      new.amount_minor, new.currency, new.reason, new.requested_by, new.created_at)
     is distinct from
     (old.tenant_id, old.property_id, old.reservation_id, old.payment_id, old.internal_reference,
      old.amount_minor, old.currency, old.reason, old.requested_by, old.created_at) then
    raise exception 'a refund request cannot be rewritten' using errcode = '23514';
  end if;
  if new.refund_status <> old.refund_status and not (
       (old.refund_status = 'requested'  and new.refund_status in ('approved', 'rejected')) or
       (old.refund_status = 'approved'   and new.refund_status in ('processing', 'succeeded')) or
       (old.refund_status = 'processing' and new.refund_status in ('succeeded', 'failed'))) then
    raise exception 'refund cannot go from % to %', old.refund_status, new.refund_status using errcode = '23514';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger refunds_guard_trg before update or delete on refunds
  for each row execute function refunds_guard();

alter table refunds enable row level security;
create policy refunds_select on refunds for select to authenticated
  using (can_view_money(property_id) or has_permission(property_id, 'refund.request') or has_permission(property_id, 'refund.approve'));
revoke insert, update, delete on refunds from authenticated, anon;

-- Money held = succeeded payments minus succeeded refunds (replaces the payments-only version from 010).
create or replace function reservation_money_held(p_reservation uuid) returns bigint
language sql stable security definer set search_path = public as $$
  select coalesce((select sum(amount_minor) from payments where reservation_id = p_reservation and payment_status = 'succeeded'), 0)
       - coalesce((select sum(amount_minor) from refunds where reservation_id = p_reservation and refund_status = 'succeeded'), 0)
$$;

-- ---- statuses now follow money held
create or replace function refresh_invoice_status(p_invoice uuid) returns void
language plpgsql security definer set search_path = public as $$
declare i invoices%rowtype; v_held bigint;
begin
  select * into i from invoices where id = p_invoice;
  if i.invoice_status = 'void' then return; end if;
  v_held := reservation_money_held(i.reservation_id);
  update invoices set invoice_status = case when v_held >= i.total_minor then 'paid'
                                            when v_held > 0 then 'partially_paid' else 'issued' end
   where id = p_invoice;
end $$;

create or replace function refresh_reservation_payment_status(p_reservation uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r reservations%rowtype; v_held bigint; v_refunded bigint; v_target bigint;
begin
  select * into r from reservations where id = p_reservation;
  if r.payment_status = 'payment_failed' then return; end if;   -- cleared by confirm_payment on success
  v_held := reservation_money_held(p_reservation);
  -- once cancelled, "paid" means the cancellation charge is covered, not the whole stay
  v_target := case when r.reservation_status = 'cancelled' then r.cancellation_charge_minor else r.total_minor end;
  select coalesce(sum(amount_minor), 0) into v_refunded from refunds
   where reservation_id = p_reservation and refund_status = 'succeeded';
  update reservations set payment_status =
    case when v_held >= v_target and v_held > 0 then 'paid'
         when v_held > 0 and v_refunded > 0 then 'partially_refunded'
         when v_held > 0 then 'partially_paid'
         when v_refunded > 0 then 'refunded'
         else 'unpaid' end
   where id = p_reservation;
end $$;

create function refresh_money_state(p_reservation uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_inv uuid;
begin
  select id into v_inv from invoices where reservation_id = p_reservation and invoice_status <> 'void';
  if v_inv is not null then perform refresh_invoice_status(v_inv); end if;
  perform refresh_reservation_payment_status(p_reservation);
end $$;
revoke all on function refresh_money_state(uuid) from public, anon, authenticated;

-- A paid invoice can be voided once nothing is held for the reservation.
create or replace function void_invoice(p_invoice_id uuid, p_reason text, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare i invoices%rowtype; v_actor uuid; v_idem record; v_hash text; v_result jsonb;
begin
  select * into i from invoices where id = p_invoice_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(i.property_id, 'invoice.void', 'NOT_FOUND');
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'POLICY_VIOLATION: reason required' using errcode = 'P0001';
  end if;

  v_hash := md5(concat_ws('|', p_invoice_id, p_reason));
  select * into v_idem from idem_begin(i.tenant_id, 'void_invoice', p_idempotency_key, v_hash);
  if not v_idem.out_is_new then return v_idem.out_response; end if;

  perform 1 from reservations where id = i.reservation_id for update;
  select * into i from invoices where id = p_invoice_id;
  if i.invoice_status = 'void' then raise exception 'INVALID_STATE: void' using errcode = 'P0001'; end if;
  if reservation_money_held(i.reservation_id) > 0 then
    raise exception 'INVALID_STATE: invoice has payments' using errcode = 'P0001';
  end if;

  update invoices set invoice_status = 'void', void_reason = p_reason, voided_at = now(), voided_by = v_actor
   where id = i.id;
  v_result := jsonb_build_object('invoice_id', i.id, 'status', 'void');
  perform idem_finish(i.tenant_id, 'void_invoice', p_idempotency_key, v_result);
  perform write_audit(i.tenant_id, i.property_id, v_actor, 'invoice.voided', 'invoice', i.id, p_idempotency_key,
                      jsonb_build_object('invoice_number', i.invoice_number, 'reason', p_reason));
  return v_result;
end $$;

-- ---- request_refund -----------------------------------------------------------------------
create function request_refund(p_payment_id uuid, p_amount_minor bigint, p_reason text, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  pay payments%rowtype; v_actor uuid; v_idem record; v_hash text; v_live bigint; v_id uuid := gen_random_uuid();
  v_ref text; v_result jsonb;
begin
  select * into pay from payments where id = p_payment_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(pay.property_id, 'refund.request', 'NOT_FOUND');
  if p_amount_minor is null or p_amount_minor <= 0 then
    raise exception 'POLICY_VIOLATION: amount must be positive' using errcode = 'P0001';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'POLICY_VIOLATION: reason required' using errcode = 'P0001';
  end if;

  v_hash := md5(concat_ws('|', p_payment_id, p_amount_minor, p_reason));
  select * into v_idem from idem_begin(pay.tenant_id, 'request_refund', p_idempotency_key, v_hash);
  if not v_idem.out_is_new then return v_idem.out_response; end if;

  perform 1 from reservations where id = pay.reservation_id for update;
  select * into pay from payments where id = p_payment_id;
  if pay.payment_status <> 'succeeded' then raise exception 'INVALID_STATE: payment %', pay.payment_status using errcode = 'P0001'; end if;
  select coalesce(sum(amount_minor), 0) into v_live from refunds
   where payment_id = pay.id and refund_status in ('requested', 'approved', 'processing', 'succeeded');
  if v_live + p_amount_minor > pay.amount_minor then
    raise exception 'POLICY_VIOLATION: REFUND_EXCEEDS_PAYMENT refundable %', pay.amount_minor - v_live using errcode = 'P0001';
  end if;

  loop
    v_ref := 'RF-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
    exit when not exists (select 1 from refunds where tenant_id = pay.tenant_id and internal_reference = v_ref);
  end loop;
  insert into refunds (id, tenant_id, property_id, reservation_id, payment_id, internal_reference, amount_minor,
                       currency, reason, requested_by)
  values (v_id, pay.tenant_id, pay.property_id, pay.reservation_id, pay.id, v_ref, p_amount_minor, pay.currency,
          trim(p_reason), v_actor);

  v_result := jsonb_build_object('refund_id', v_id, 'internal_reference', v_ref, 'status', 'requested',
                                 'amount_minor', p_amount_minor, 'refundable_after_minor', pay.amount_minor - v_live - p_amount_minor);
  perform idem_finish(pay.tenant_id, 'request_refund', p_idempotency_key, v_result);
  perform write_audit(pay.tenant_id, pay.property_id, v_actor, 'refund.requested', 'refund', v_id, p_idempotency_key,
                      jsonb_build_object('payment_id', pay.id, 'amount_minor', p_amount_minor, 'reason', trim(p_reason)));
  return v_result;
end $$;

-- ---- approve_refund -----------------------------------------------------------------------
create function approve_refund(p_refund_id uuid, p_approve boolean, p_note text, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare f refunds%rowtype; v_actor uuid; v_idem record; v_hash text; v_status text; v_result jsonb;
begin
  select * into f from refunds where id = p_refund_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(f.property_id, 'refund.approve', 'NOT_FOUND');
  if p_approve is null then raise exception 'POLICY_VIOLATION: decision required' using errcode = 'P0001'; end if;
  if v_actor is not null and v_actor is not distinct from f.requested_by then
    raise exception 'POLICY_VIOLATION: SELF_APPROVAL' using errcode = 'P0001';
  end if;
  if not p_approve and (p_note is null or length(trim(p_note)) = 0) then
    raise exception 'POLICY_VIOLATION: note required to reject' using errcode = 'P0001';
  end if;

  v_hash := md5(concat_ws('|', p_refund_id, p_approve, coalesce(p_note, '')));
  select * into v_idem from idem_begin(f.tenant_id, 'approve_refund', p_idempotency_key, v_hash);
  if not v_idem.out_is_new then return v_idem.out_response; end if;

  perform 1 from reservations where id = f.reservation_id for update;
  select * into f from refunds where id = p_refund_id;
  if f.refund_status <> 'requested' then raise exception 'INVALID_STATE: %', f.refund_status using errcode = 'P0001'; end if;
  v_status := case when p_approve then 'approved' else 'rejected' end;
  update refunds set refund_status = v_status, decided_by = v_actor, decided_at = now(),
         decision_note = nullif(trim(p_note), ''), completed_at = case when p_approve then null else now() end
   where id = f.id;

  v_result := jsonb_build_object('refund_id', f.id, 'status', v_status);
  perform idem_finish(f.tenant_id, 'approve_refund', p_idempotency_key, v_result);
  perform write_audit(f.tenant_id, f.property_id, v_actor, 'refund.' || v_status, 'refund', f.id, p_idempotency_key,
                      jsonb_build_object('amount_minor', f.amount_minor, 'note', nullif(trim(p_note), '')));
  return v_result;
end $$;

-- ---- record_manual_refund: staff paid the money back (cash, bank transfer, POS) -------------
create function record_manual_refund(p_refund_id uuid, p_payout_reference text, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  f refunds%rowtype; pay payments%rowtype; v_actor uuid; v_idem record; v_hash text; v_result jsonb;
begin
  select * into f from refunds where id = p_refund_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(f.property_id, 'refund.approve', 'NOT_FOUND');

  v_hash := md5(concat_ws('|', p_refund_id, coalesce(p_payout_reference, '')));
  select * into v_idem from idem_begin(f.tenant_id, 'record_manual_refund', p_idempotency_key, v_hash);
  if not v_idem.out_is_new then return v_idem.out_response; end if;

  perform 1 from reservations where id = f.reservation_id for update;
  select * into f from refunds where id = p_refund_id;
  select * into pay from payments where id = f.payment_id;
  if pay.payment_provider <> 'manual' then
    raise exception 'POLICY_VIOLATION: provider payments are refunded through the provider' using errcode = 'P0001';
  end if;
  if f.refund_status <> 'approved' then raise exception 'INVALID_STATE: %', f.refund_status using errcode = 'P0001'; end if;

  update refunds set refund_status = 'succeeded', payout_reference = nullif(trim(p_payout_reference), ''),
         completed_at = now() where id = f.id;
  perform refresh_money_state(f.reservation_id);

  v_result := jsonb_build_object('refund_id', f.id, 'status', 'succeeded',
                                 'payment_status', (select payment_status from reservations where id = f.reservation_id));
  perform idem_finish(f.tenant_id, 'record_manual_refund', p_idempotency_key, v_result);
  perform write_audit(f.tenant_id, f.property_id, v_actor, 'refund.paid_out', 'refund', f.id, p_idempotency_key,
                      jsonb_build_object('amount_minor', f.amount_minor, 'payout_reference', nullif(trim(p_payout_reference), '')));
  return v_result;
end $$;

-- ---- provider refunds (service_role) -------------------------------------------------------
-- Step 1: mark an approved provider refund as processing and hand back what the provider call needs.
-- call_allowed is true for exactly one caller, the one that moved it from approved to processing.
create function begin_refund_processing(p_refund_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare f refunds%rowtype; pay payments%rowtype; v_call boolean := false;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select * into f from refunds where id = p_refund_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  perform 1 from reservations where id = f.reservation_id for update;
  select * into f from refunds where id = p_refund_id;
  select * into pay from payments where id = f.payment_id;
  if pay.payment_provider = 'manual' then
    raise exception 'POLICY_VIOLATION: manual payments are refunded by staff' using errcode = 'P0001';
  end if;
  if f.refund_status = 'approved' then
    update refunds set refund_status = 'processing', provider_call_started_at = now() where id = f.id;
    perform write_audit(f.tenant_id, f.property_id, null, 'refund.processing', 'refund', f.id, null, '{}'::jsonb);
    v_call := true;
  elsif f.refund_status = 'processing' then
    v_call := false;                 -- the provider was already called (or is being called): never call twice
  else
    raise exception 'INVALID_STATE: %', f.refund_status using errcode = 'P0001';
  end if;
  return jsonb_build_object('refund_id', f.id, 'internal_reference', f.internal_reference, 'provider', pay.payment_provider,
                            'payment_provider_reference', pay.provider_reference, 'amount_minor', f.amount_minor,
                            'currency', f.currency, 'call_allowed', v_call);
end $$;

-- Step 2: the verified outcome from the provider. Idempotent per (provider, event id).
create function record_refund_result(
  p_provider text, p_event_id text, p_refund_id uuid, p_status text, p_provider_refund_id text,
  p_failure_reason text default null, p_payload jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare f refunds%rowtype; v_event uuid; v_prior jsonb; v_result jsonb; v_ev_status text := 'processed';
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  if p_provider is null or p_event_id is null or length(p_event_id) = 0 then
    raise exception 'POLICY_VIOLATION: provider and event id required' using errcode = 'P0001';
  end if;
  if p_status is null or p_status not in ('succeeded', 'failed') then
    raise exception 'POLICY_VIOLATION: status' using errcode = 'P0001';
  end if;
  select * into f from refunds where id = p_refund_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;

  insert into payment_events (tenant_id, provider, provider_event_id, event_type, provider_reference, payload)
  values (f.tenant_id, p_provider, p_event_id, 'refund.' || p_status, f.internal_reference, coalesce(p_payload, '{}'::jsonb))
  on conflict (provider, provider_event_id) do nothing returning id into v_event;
  if v_event is null then
    select result into v_prior from payment_events where provider = p_provider and provider_event_id = p_event_id;
    return coalesce(v_prior, '{}'::jsonb) || jsonb_build_object('duplicate', true);
  end if;

  perform 1 from reservations where id = f.reservation_id for update;
  select * into f from refunds where id = p_refund_id;
  if f.refund_status <> 'processing' then
    v_result := jsonb_build_object('result', 'ignored', 'reason', 'refund is ' || f.refund_status, 'refund_id', f.id);
    v_ev_status := 'ignored';
  else
    update refunds set refund_status = p_status, provider_refund_id = nullif(p_provider_refund_id, ''),
           failure_reason = case when p_status = 'failed' then coalesce(nullif(trim(p_failure_reason), ''), 'provider failed') end,
           completed_at = now()
     where id = f.id;
    if p_status = 'succeeded' then perform refresh_money_state(f.reservation_id); end if;
    v_result := jsonb_build_object('result', p_status, 'refund_id', f.id,
                                   'payment_status', (select payment_status from reservations where id = f.reservation_id));
    perform write_audit(f.tenant_id, f.property_id, null, 'refund.' || p_status, 'refund', f.id, p_event_id,
                        jsonb_build_object('amount_minor', f.amount_minor, 'provider_refund_id', p_provider_refund_id));
  end if;
  update payment_events set processing_status = v_ev_status, result = v_result, processed_at = now() where id = v_event;
  return v_result;
end $$;

-- ---- reverse_payment: undo a manual payment recorded by mistake ----------------------------
create function reverse_payment(p_payment_id uuid, p_reason text, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare pay payments%rowtype; v_actor uuid; v_idem record; v_hash text; v_result jsonb;
begin
  select * into pay from payments where id = p_payment_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(pay.property_id, 'refund.approve', 'NOT_FOUND');
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'POLICY_VIOLATION: reason required' using errcode = 'P0001';
  end if;

  v_hash := md5(concat_ws('|', p_payment_id, p_reason));
  select * into v_idem from idem_begin(pay.tenant_id, 'reverse_payment', p_idempotency_key, v_hash);
  if not v_idem.out_is_new then return v_idem.out_response; end if;

  perform 1 from reservations where id = pay.reservation_id for update;
  select * into pay from payments where id = p_payment_id;
  if pay.payment_provider <> 'manual' then
    raise exception 'POLICY_VIOLATION: provider payments are refunded, not reversed' using errcode = 'P0001';
  end if;
  if pay.payment_status <> 'succeeded' then raise exception 'INVALID_STATE: payment %', pay.payment_status using errcode = 'P0001'; end if;
  if exists (select 1 from refunds where payment_id = pay.id and refund_status in ('requested', 'approved', 'processing', 'succeeded')) then
    raise exception 'INVALID_STATE: payment has refunds' using errcode = 'P0001';
  end if;

  update payments set payment_status = 'reversed',
         note = concat_ws(' | ', pay.note, 'reversed: ' || trim(p_reason)) where id = pay.id;
  perform refresh_money_state(pay.reservation_id);

  v_result := jsonb_build_object('payment_id', pay.id, 'status', 'reversed',
                                 'payment_status', (select payment_status from reservations where id = pay.reservation_id));
  perform idem_finish(pay.tenant_id, 'reverse_payment', p_idempotency_key, v_result);
  perform write_audit(pay.tenant_id, pay.property_id, v_actor, 'payment.reversed', 'payment', pay.id, p_idempotency_key,
                      jsonb_build_object('amount_minor', pay.amount_minor, 'reason', trim(p_reason)));
  return v_result;
end $$;

revoke all on function request_refund(uuid, bigint, text, text), approve_refund(uuid, boolean, text, text),
  record_manual_refund(uuid, text, text), reverse_payment(uuid, text, text) from public, anon;
grant execute on function request_refund(uuid, bigint, text, text), approve_refund(uuid, boolean, text, text),
  record_manual_refund(uuid, text, text), reverse_payment(uuid, text, text) to authenticated;
revoke all on function begin_refund_processing(uuid),
  record_refund_result(text, text, uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function begin_refund_processing(uuid),
  record_refund_result(text, text, uuid, text, text, text, jsonb) to service_role;
