-- 098 Invoices to hotel groups, raised and settled by hand by a platform admin.
--
-- The plan catalog (097) says what a plan costs. This records what a group was billed for a period and whether it paid. Nothing
-- charges a card or contacts a payment provider: an admin raises the invoice, and marks it paid when the money arrived (bank
-- transfer, cash, a Paystack payment seen on the dashboard) with the reference they saw.
--
-- platform_invoices: one row per invoice. number is PI-<year>-<6 digits> from one sequence (gaps are fine). Amount is whole kobo and
-- the currency is the plan's. status: open -> paid or void; nothing leaves paid or void. At most one invoice per group per period
-- start that is not void, so a period cannot be billed twice (void it to raise it again).
--
-- platform_raise_invoice(tenant, period_start, period_end, amount_minor, due_date, note): admin. amount_minor may be null to take
-- the price of the group's current plan, but not while that price is still a placeholder (097) or the group has no listed plan.
-- platform_mark_invoice_paid(invoice, reference): admin; a repeat on a paid invoice changes nothing; a void invoice is refused.
-- platform_void_invoice(invoice, reason): admin; open only; the reason (3 to 500 characters) is kept.
-- platform_list_invoices(tenant): support or admin; newest first.
-- The table is closed to logins; it is audited by the 047 trigger (actor auth.uid()). It is not shown to hotels.

create sequence platform_invoice_seq;

create table platform_invoices (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id),
  number        text not null unique,
  plan_code     text,
  period_start  date not null,
  period_end    date not null,
  amount_minor  bigint not null check (amount_minor > 0 and amount_minor <= 100000000000),
  currency      text not null default 'NGN' check (currency ~ '^[A-Z]{3}$'),
  status        text not null default 'open' check (status in ('open', 'paid', 'void')),
  due_date      date,
  note          text check (note is null or char_length(note) <= 300),
  paid_at       timestamptz,
  payment_ref   text check (payment_ref is null or char_length(payment_ref) between 1 and 120),
  void_reason   text check (void_reason is null or char_length(void_reason) between 3 and 500),
  created_by    uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (period_end > period_start),
  check ((status = 'paid') = (paid_at is not null)),
  check ((status = 'void') = (void_reason is not null))
);
create unique index platform_invoices_one_per_period on platform_invoices (tenant_id, period_start) where status <> 'void';
create trigger platform_invoices_updated before update on platform_invoices for each row execute function set_updated_at();
alter table platform_invoices enable row level security;
revoke all on platform_invoices from public, anon, authenticated;
revoke all on sequence platform_invoice_seq from public, anon, authenticated;
create trigger platform_invoices_audit after insert or update or delete on platform_invoices
  for each row execute function audit_config_row('platform_invoice', 'number,plan_code,period_start,period_end,amount_minor,currency,status,due_date,note,paid_at,payment_ref,void_reason');

create function platform_raise_invoice(p_tenant uuid, p_period_start date, p_period_end date, p_amount_minor bigint, p_due_date date, p_note text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := platform_require('admin');
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_plan_code text; pl plans%rowtype; v_amount bigint := p_amount_minor; v_currency text := 'NGN';
  v_id uuid; v_number text;
begin
  perform 1 from tenants where id = p_tenant for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if p_period_start is null or p_period_end is null or p_period_end <= p_period_start or p_period_end - p_period_start > 400 then
    raise exception 'POLICY_VIOLATION: invoice period' using errcode = 'P0001';
  end if;
  if p_due_date is not null and p_due_date < p_period_start - 366 then raise exception 'POLICY_VIOLATION: invoice due' using errcode = 'P0001'; end if;
  if v_note is not null and char_length(v_note) > 300 then raise exception 'POLICY_VIOLATION: invoice note' using errcode = 'P0001'; end if;

  select plan_code into v_plan_code from tenant_subscriptions where tenant_id = p_tenant order by created_at desc limit 1;
  select * into pl from plans where code = v_plan_code;
  if found then v_currency := pl.currency; end if;
  if v_amount is null then
    if not found or pl.price_is_placeholder then raise exception 'POLICY_VIOLATION: invoice amount' using errcode = 'P0001'; end if;
    v_amount := pl.monthly_price_minor;
  end if;
  if v_amount <= 0 or v_amount > 100000000000 then raise exception 'POLICY_VIOLATION: invoice amount' using errcode = 'P0001'; end if;

  if exists (select 1 from platform_invoices where tenant_id = p_tenant and period_start = p_period_start and status <> 'void') then
    raise exception 'CONFLICT: invoice period' using errcode = 'P0001';
  end if;
  v_number := 'PI-' || to_char(p_period_start, 'YYYY') || '-' || lpad(nextval('platform_invoice_seq')::text, 6, '0');
  insert into platform_invoices (tenant_id, number, plan_code, period_start, period_end, amount_minor, currency, due_date, note, created_by)
  values (p_tenant, v_number, v_plan_code, p_period_start, p_period_end, v_amount, v_currency, p_due_date, v_note, v_uid)
  returning id into v_id;
  return jsonb_build_object('changed', true, 'id', v_id, 'number', v_number);
end $$;

create function platform_mark_invoice_paid(p_invoice uuid, p_reference text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_ref text := nullif(btrim(coalesce(p_reference, '')), ''); i platform_invoices%rowtype;
begin
  perform platform_require('admin');
  select * into i from platform_invoices where id = p_invoice for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if i.status = 'paid' then return jsonb_build_object('changed', false); end if;
  if i.status = 'void' then raise exception 'CONFLICT: invoice state' using errcode = 'P0001'; end if;
  if v_ref is null or char_length(v_ref) > 120 then raise exception 'POLICY_VIOLATION: invoice reference' using errcode = 'P0001'; end if;
  update platform_invoices set status = 'paid', paid_at = now(), payment_ref = v_ref where id = i.id;
  return jsonb_build_object('changed', true);
end $$;

create function platform_void_invoice(p_invoice uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_reason text := btrim(coalesce(p_reason, '')); i platform_invoices%rowtype;
begin
  perform platform_require('admin');
  select * into i from platform_invoices where id = p_invoice for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if i.status = 'void' then return jsonb_build_object('changed', false); end if;
  if i.status = 'paid' then raise exception 'CONFLICT: invoice state' using errcode = 'P0001'; end if;
  if char_length(v_reason) not between 3 and 500 then raise exception 'POLICY_VIOLATION: invoice reason' using errcode = 'P0001'; end if;
  update platform_invoices set status = 'void', void_reason = v_reason where id = i.id;
  return jsonb_build_object('changed', true);
end $$;

create function platform_list_invoices(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform platform_require('support');
  perform 1 from tenants where id = p_tenant;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', i.id, 'number', i.number, 'plan_code', i.plan_code, 'period_start', i.period_start, 'period_end', i.period_end,
      'amount_minor', i.amount_minor, 'currency', i.currency, 'status', i.status, 'due_date', i.due_date, 'note', i.note,
      'paid_at', i.paid_at, 'payment_ref', i.payment_ref, 'void_reason', i.void_reason) order by i.period_start desc, i.created_at desc)
    from platform_invoices i where i.tenant_id = p_tenant), '[]'::jsonb);
end $$;

revoke all on function platform_raise_invoice(uuid, date, date, bigint, date, text), platform_mark_invoice_paid(uuid, text),
  platform_void_invoice(uuid, text), platform_list_invoices(uuid) from public, anon;
grant execute on function platform_raise_invoice(uuid, date, date, bigint, date, text), platform_mark_invoice_paid(uuid, text),
  platform_void_invoice(uuid, text), platform_list_invoices(uuid) to authenticated;
