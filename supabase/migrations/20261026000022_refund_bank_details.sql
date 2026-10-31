-- 022 Refunds that Paystack cannot finish without the customer's bank details.
--
-- Paystack moves a refund to "needs-attention" when it has no bank account to pay back to. It is completed by
-- POSTing the customer's bank to /refund/retry_with_customer_details/<provider refund id>. Until now we only
-- noted the state. This migration adds what the retry needs, and nothing more:
--   * needs_bank_details: set when Paystack reports needs-attention for a processing refund.
--   * details_retry_started_at: set for exactly one staff caller at a time (the same at-most-once idea as
--     provider_call_started_at), because the retry moves money and must not be sent twice.
--   * provider_refund_id: stored when the state is reported, since the retry endpoint is addressed by it.
-- The customer's account number and bank are NEVER stored: the server passes them straight to Paystack.
-- Audit rows carry the outcome only.

alter table refunds
  add column needs_bank_details boolean not null default false,
  add column details_retry_started_at timestamptz;

-- A refund that leaves "processing" no longer needs details, whichever path moved it.
create function refunds_clear_details() returns trigger language plpgsql as $$
begin
  if new.refund_status <> 'processing' then new.needs_bank_details := false; end if;
  return new;
end $$;
create trigger refunds_clear_details_trg before update on refunds
  for each row execute function refunds_clear_details();

-- Service side (webhook and payout route): Paystack said it needs the customer's bank details.
-- Reported again by Paystack (for example after the bank refused the account) it re-opens the retry.
create function mark_refund_needs_details(p_refund_id uuid, p_provider_refund_id text, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare f refunds%rowtype;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select * into f from refunds where id = p_refund_id for update;
  if not found or f.refund_status <> 'processing' then return; end if;
  update refunds
     set needs_bank_details = true,
         details_retry_started_at = null,
         provider_refund_id = coalesce(nullif(trim(p_provider_refund_id), ''), provider_refund_id),
         attention_note = left(coalesce(p_note, ''), 500)
   where id = f.id;
  perform write_audit(f.tenant_id, f.property_id, null, 'refund.needs_bank_details', 'refund', f.id, null,
                      jsonb_build_object('note', left(coalesce(p_note, ''), 500)));
end $$;

-- Staff side: tells exactly one caller that it may send the bank details to Paystack.
create function start_refund_details_retry(p_refund_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare f refunds%rowtype; v_actor uuid; v_call boolean := false;
begin
  select * into f from refunds where id = p_refund_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(f.property_id, 'refund.approve', 'NOT_FOUND');
  select * into f from refunds where id = p_refund_id for update;
  if f.refund_status <> 'processing' or not f.needs_bank_details then
    raise exception 'INVALID_STATE: refund is not waiting for bank details' using errcode = 'P0001';
  end if;
  if f.provider_refund_id is null then
    raise exception 'INVALID_STATE: no provider refund id to retry' using errcode = 'P0001';
  end if;
  if f.details_retry_started_at is null then
    update refunds set details_retry_started_at = now() where id = f.id;
    perform write_audit(f.tenant_id, f.property_id, v_actor, 'refund.bank_details_retry_started', 'refund', f.id, null, '{}'::jsonb);
    v_call := true;
  end if;
  return jsonb_build_object('refund_id', f.id, 'provider_refund_id', f.provider_refund_id,
                            'currency', f.currency, 'call_allowed', v_call);
end $$;

-- Service side: what Paystack answered.
--   accepted: Paystack took the details; the webhook (refund.processed or refund.failed) closes the refund.
--   rejected: a definite 4xx, so nothing was sent and the retry may be tried again with other details.
--   unknown:  timeout or 5xx. The retry stays used until a person checks Paystack, or Paystack reports needs-attention again.
create function finish_refund_details_retry(p_refund_id uuid, p_outcome text, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare f refunds%rowtype;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  if p_outcome is null or p_outcome not in ('accepted', 'rejected', 'unknown') then
    raise exception 'POLICY_VIOLATION: retry outcome' using errcode = 'P0001';
  end if;
  select * into f from refunds where id = p_refund_id for update;
  if not found or f.refund_status <> 'processing' then return; end if;
  if p_outcome = 'accepted' then
    update refunds set needs_bank_details = false, attention_note = null where id = f.id;
  elsif p_outcome = 'rejected' then
    update refunds set details_retry_started_at = null, attention_note = left(coalesce(p_note, ''), 500) where id = f.id;
  else
    update refunds set attention_note = left(coalesce(p_note, ''), 500) where id = f.id;
  end if;
  perform write_audit(f.tenant_id, f.property_id, null, 'refund.bank_details_' || p_outcome, 'refund', f.id, null,
                      jsonb_build_object('outcome', p_outcome));
end $$;

revoke all on function mark_refund_needs_details(uuid, text, text), finish_refund_details_retry(uuid, text, text)
  from public, anon, authenticated;
grant execute on function mark_refund_needs_details(uuid, text, text), finish_refund_details_retry(uuid, text, text)
  to service_role;
revoke all on function start_refund_details_retry(uuid) from public, anon;
grant execute on function start_refund_details_retry(uuid) to authenticated;
