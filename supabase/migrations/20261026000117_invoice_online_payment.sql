-- 117 A hotel pays a platform invoice online (Paystack, the platform's own account).
--
-- Platform invoices (098) were paid by hand: an admin recorded the payment. This lets the hotel's owner or general manager start a card
-- payment for an open invoice from their billing page. The platform's Paystack secret lives in the server environment
-- (PLATFORM_PAYSTACK_SECRET_KEY), never in the database.
--
-- platform_invoice_payments: one row per attempt. reference is PIP- plus 32 hex characters and is what Paystack is given. Status:
--   initiated (started, not settled), paid (settled and the invoice was marked paid), failed (Paystack said the charge failed),
--   mismatch (Paystack's amount or currency differs from the attempt: nothing is marked paid, a person must look).
-- hotel_start_invoice_payment(property, invoice): property.configure at that hotel (NOT_FOUND for anyone else, another hotel's invoice
--   or an unknown one). The invoice must be open ('CONFLICT: invoice state' otherwise). Creates an attempt for the invoice's own amount
--   and currency (the caller cannot choose them) and returns reference, amount, currency and the caller's sign-in email for the checkout.
-- settle_invoice_payment(reference, status, amount, currency): service role only, called after the app has verified the
--   transaction with Paystack (status, amount and currency come from Paystack's reply, never from a webhook body). Idempotent:
--     unknown        no such attempt
--     duplicate      the attempt was already settled
--     not_success    Paystack did not report success (a 'failed' status marks the attempt failed; anything else leaves it open)
--     mismatch       amount or currency differ from the attempt
--     paid           the invoice was open: it is now paid, paid_at now, payment_ref the reference
--     invoice_closed the money was taken but the invoice was already paid or void (an admin recorded it, or voided it): the attempt is
--                    marked paid and the app logs it, because a person must decide about the money.
-- The invoice's own audit trigger records the change to paid. The table is closed to logins.

create table platform_invoice_payments (
  id           uuid primary key default gen_random_uuid(),
  invoice_id   uuid not null references platform_invoices(id),
  reference    text not null unique check (reference ~ '^PIP-[0-9a-f]{32}$'),
  amount_minor bigint not null check (amount_minor > 0),
  currency     text not null check (currency ~ '^[A-Z]{3}$'),
  status       text not null default 'initiated' check (status in ('initiated', 'paid', 'failed', 'mismatch')),
  started_by   uuid,
  created_at   timestamptz not null default now(),
  settled_at   timestamptz
);
create index platform_invoice_payments_invoice on platform_invoice_payments (invoice_id, created_at desc);
alter table platform_invoice_payments enable row level security;
revoke all on platform_invoice_payments from public, anon, authenticated;

create function hotel_start_invoice_payment(p_property uuid, p_invoice uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_tenant uuid; v_uid uuid; i platform_invoices%rowtype; v_ref text; v_email text;
begin
  select tenant_id into v_tenant from properties where id = p_property;
  if v_tenant is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_uid := require_permission(p_property, 'property.configure', 'NOT_FOUND');
  select * into i from platform_invoices where id = p_invoice and tenant_id = v_tenant;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if i.status <> 'open' then raise exception 'CONFLICT: invoice state' using errcode = 'P0001'; end if;
  select email into v_email from auth.users where id = v_uid;
  if v_email is null or btrim(v_email) = '' then raise exception 'INVALID_STATE: email missing' using errcode = 'P0001'; end if;
  v_ref := 'PIP-' || replace(gen_random_uuid()::text, '-', '');
  insert into platform_invoice_payments (invoice_id, reference, amount_minor, currency, started_by)
    values (i.id, v_ref, i.amount_minor, i.currency, v_uid);
  return jsonb_build_object('reference', v_ref, 'amount_minor', i.amount_minor, 'currency', i.currency, 'email', v_email, 'number', i.number);
end $$;
revoke all on function hotel_start_invoice_payment(uuid, uuid) from public, anon;
grant execute on function hotel_start_invoice_payment(uuid, uuid) to authenticated;

create function settle_invoice_payment(p_reference text, p_status text, p_amount_minor bigint, p_currency text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare a platform_invoice_payments%rowtype; i platform_invoices%rowtype;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select * into a from platform_invoice_payments where reference = p_reference for update;
  if not found then return jsonb_build_object('result', 'unknown'); end if;
  if a.status in ('paid', 'mismatch') then return jsonb_build_object('result', 'duplicate', 'invoice_id', a.invoice_id); end if;
  if p_status is distinct from 'success' then
    if p_status = 'failed' and a.status = 'initiated' then update platform_invoice_payments set status = 'failed', settled_at = now() where id = a.id; end if;
    return jsonb_build_object('result', 'not_success', 'invoice_id', a.invoice_id);
  end if;
  if p_amount_minor is distinct from a.amount_minor or upper(coalesce(p_currency, '')) <> a.currency then
    update platform_invoice_payments set status = 'mismatch', settled_at = now() where id = a.id;
    return jsonb_build_object('result', 'mismatch', 'invoice_id', a.invoice_id);
  end if;
  select * into i from platform_invoices where id = a.invoice_id for update;
  update platform_invoice_payments set status = 'paid', settled_at = now() where id = a.id;
  if i.status = 'open' then
    update platform_invoices set status = 'paid', paid_at = now(), payment_ref = a.reference where id = i.id;
    return jsonb_build_object('result', 'paid', 'invoice_id', i.id);
  end if;
  return jsonb_build_object('result', 'invoice_closed', 'invoice_id', i.id);
end $$;
revoke all on function settle_invoice_payment(text, text, bigint, text) from public, anon, authenticated;
grant execute on function settle_invoice_payment(text, text, bigint, text) to service_role;
