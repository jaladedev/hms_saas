-- 010 Money, staff side: invoices, invoice lines, invoice numbering, payments, allocations, and
-- issue_invoice, void_invoice, record_manual_payment. Provider payments (payment_attempts,
-- payment_events, confirm_payment) and refunds come in 011.
--
-- Rules:
--   * Money is bigint kobo. Invoice lines are copied from reservation_nights at issue time; later rate
--     changes never alter an issued invoice.
--   * One live (non-void) invoice per reservation. An invoice with payments cannot be voided until
--     payment reversal and credit notes exist.
--   * Payments belong to a reservation. They are allocated to the live invoice when there is one
--     (and picked up automatically when an invoice is issued later), oldest payment first.
--   * Payments never exceed the reservation total (OVERPAYMENT is refused), and allocations never
--     exceed either the payment or the invoice (trigger safeguards on top of row locking).
--   * Clients never write these tables; every change goes through the functions below, which lock
--     the reservation row so payments and invoices for one reservation are serialised.
--   * Invoice numbers are per property and year: INV-<property code>-<year>-<6 digits>, allocated in
--     the same transaction as the invoice, so a rolled-back issue leaves no gap.

create table invoice_sequences (
  property_id uuid not null references properties(id),
  year        integer not null,
  last_number integer not null default 0,
  primary key (property_id, year)
);
alter table invoice_sequences enable row level security;   -- no policy: functions only
revoke all on invoice_sequences from authenticated, anon;

create table invoices (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null,
  property_id    uuid not null,
  reservation_id uuid not null,
  invoice_number text not null,
  invoice_status text not null default 'issued'
    check (invoice_status in ('issued','partially_paid','paid','void')),
  currency       char(3) not null,
  subtotal_minor bigint not null check (subtotal_minor >= 0),
  tax_minor      bigint not null check (tax_minor >= 0),
  discount_minor bigint not null default 0 check (discount_minor >= 0),
  total_minor    bigint not null check (total_minor >= 0),
  issued_at      timestamptz not null default now(),
  due_at         timestamptz,
  void_reason    text,
  voided_at      timestamptz,
  voided_by      uuid,
  created_by     uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  foreign key (tenant_id, property_id) references properties (tenant_id, id),
  foreign key (tenant_id, property_id, reservation_id) references reservations (tenant_id, property_id, id),
  unique (property_id, invoice_number),
  unique (tenant_id, id),
  check (total_minor = subtotal_minor + tax_minor - discount_minor),
  check ((invoice_status = 'void') = (voided_at is not null))
);
create unique index invoices_one_live_per_reservation on invoices (reservation_id) where invoice_status <> 'void';
create index on invoices (property_id, invoice_status, due_at);

create table invoice_lines (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null,
  invoice_id        uuid not null,
  description       text not null,
  quantity          integer not null default 1 check (quantity > 0),
  unit_amount_minor bigint not null check (unit_amount_minor >= 0),
  tax_amount_minor  bigint not null default 0 check (tax_amount_minor >= 0),
  line_total_minor  bigint not null,
  service_date      date,
  foreign key (tenant_id, invoice_id) references invoices (tenant_id, id),
  check (line_total_minor = quantity * unit_amount_minor + tax_amount_minor)
);
create index on invoice_lines (invoice_id);

create table payments (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null,
  property_id        uuid not null,
  reservation_id     uuid not null,
  payment_provider   text not null default 'manual',
  payment_method     text not null check (payment_method in ('cash','bank_transfer','pos','other')),
  provider_reference text,                       -- bank slip or POS receipt number for manual payments
  internal_reference text not null,
  amount_minor       bigint not null check (amount_minor > 0),
  currency           char(3) not null,
  payment_status     text not null default 'succeeded' check (payment_status in ('succeeded','reversed')),
  note               text,
  received_at        timestamptz not null default now(),
  recorded_by        uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  foreign key (tenant_id, property_id, reservation_id) references reservations (tenant_id, property_id, id),
  unique (tenant_id, internal_reference),
  unique (tenant_id, id)
);
create index on payments (reservation_id, payment_status);

create table payment_allocations (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  payment_id  uuid not null,
  invoice_id  uuid not null,
  amount_minor bigint not null check (amount_minor > 0),
  created_at  timestamptz not null default now(),
  foreign key (tenant_id, payment_id) references payments (tenant_id, id),
  foreign key (tenant_id, invoice_id) references invoices (tenant_id, id)
);
create index on payment_allocations (payment_id);
create index on payment_allocations (invoice_id);

-- ---- safeguards ---------------------------------------------------------------------------
create function invoices_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'invoices cannot be deleted' using errcode = '23514'; end if;
  if old.invoice_status = 'void' then raise exception 'a void invoice cannot change' using errcode = '23514'; end if;
  if (new.tenant_id, new.property_id, new.reservation_id, new.invoice_number, new.currency, new.subtotal_minor,
      new.tax_minor, new.discount_minor, new.total_minor, new.issued_at, new.due_at)
     is distinct from
     (old.tenant_id, old.property_id, old.reservation_id, old.invoice_number, old.currency, old.subtotal_minor,
      old.tax_minor, old.discount_minor, old.total_minor, old.issued_at, old.due_at) then
    raise exception 'an issued invoice cannot be rewritten; void it instead' using errcode = '23514';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger invoices_guard_trg before update or delete on invoices
  for each row execute function invoices_guard();

create function immutable_money_row() returns trigger language plpgsql as $$
begin
  raise exception '% rows cannot be changed or deleted', tg_table_name using errcode = '23514';
end $$;
create trigger invoice_lines_immutable before update or delete on invoice_lines
  for each row execute function immutable_money_row();
create trigger payment_allocations_immutable before update or delete on payment_allocations
  for each row execute function immutable_money_row();

create function payments_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'payments cannot be deleted' using errcode = '23514'; end if;
  if (new.tenant_id, new.property_id, new.reservation_id, new.amount_minor, new.currency, new.internal_reference,
      new.payment_provider, new.payment_method, new.received_at)
     is distinct from
     (old.tenant_id, old.property_id, old.reservation_id, old.amount_minor, old.currency, old.internal_reference,
      old.payment_provider, old.payment_method, old.received_at) then
    raise exception 'a recorded payment cannot be rewritten' using errcode = '23514';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger payments_guard_trg before update or delete on payments
  for each row execute function payments_guard();

-- Allocations may not exceed the payment or the invoice, and must stay inside one reservation.
create function payment_allocations_check() returns trigger language plpgsql
security definer set search_path = public as $$
declare p payments%rowtype; i invoices%rowtype;
begin
  select * into p from payments where id = new.payment_id;
  select * into i from invoices where id = new.invoice_id;
  if p.reservation_id <> i.reservation_id then
    raise exception 'allocation crosses reservations' using errcode = '23514';
  end if;
  if i.invoice_status = 'void' or p.payment_status <> 'succeeded' then
    raise exception 'allocation needs a live invoice and a succeeded payment' using errcode = '23514';
  end if;
  if (select sum(amount_minor) from payment_allocations where payment_id = p.id) > p.amount_minor then
    raise exception 'allocations exceed payment' using errcode = '23514';
  end if;
  if (select sum(amount_minor) from payment_allocations where invoice_id = i.id) > i.total_minor then
    raise exception 'allocations exceed invoice' using errcode = '23514';
  end if;
  return null;
end $$;
create trigger payment_allocations_check_trg after insert on payment_allocations
  for each row execute function payment_allocations_check();

-- ---- RLS: read for finance-facing roles, no client writes ---------------------------------
alter table invoices            enable row level security;
alter table invoice_lines       enable row level security;
alter table payments            enable row level security;
alter table payment_allocations enable row level security;

create function can_view_money(p_property uuid) returns boolean language sql stable security definer
set search_path = public as $$
  select has_permission(p_property, 'invoice.issue') or has_permission(p_property, 'payment.record')
      or has_permission(p_property, 'report.view')
$$;
revoke all on function can_view_money(uuid) from public, anon;
grant execute on function can_view_money(uuid) to authenticated;

create policy invoices_select on invoices for select to authenticated using (can_view_money(property_id));
create policy invoice_lines_select on invoice_lines for select to authenticated
  using (exists (select 1 from invoices i where i.id = invoice_id and can_view_money(i.property_id)));
create policy payments_select on payments for select to authenticated using (can_view_money(property_id));
create policy payment_allocations_select on payment_allocations for select to authenticated
  using (exists (select 1 from payments p where p.id = payment_id and can_view_money(p.property_id)));
revoke insert, update, delete on invoices, invoice_lines, payments, payment_allocations from authenticated, anon;

-- ---- internal helpers ---------------------------------------------------------------------
create function refresh_invoice_status(p_invoice uuid) returns void
language plpgsql security definer set search_path = public as $$
declare i invoices%rowtype; v_alloc bigint;
begin
  select * into i from invoices where id = p_invoice;
  if i.invoice_status = 'void' then return; end if;
  select coalesce(sum(amount_minor), 0) into v_alloc from payment_allocations where invoice_id = p_invoice;
  update invoices set invoice_status = case when v_alloc >= i.total_minor then 'paid'
                                            when v_alloc > 0 then 'partially_paid' else 'issued' end
   where id = p_invoice;
end $$;

-- Reservation payment status from received money. Failed, refunded and partially refunded states
-- belong to the provider and refund flows (011) and are left alone here.
create function refresh_reservation_payment_status(p_reservation uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r reservations%rowtype; v_paid bigint;
begin
  select * into r from reservations where id = p_reservation;
  if r.payment_status not in ('unpaid', 'partially_paid', 'paid') then return; end if;
  select coalesce(sum(amount_minor), 0) into v_paid from payments
   where reservation_id = p_reservation and payment_status = 'succeeded';
  update reservations set payment_status = case when v_paid >= r.total_minor and v_paid > 0 then 'paid'
                                                when v_paid > 0 then 'partially_paid' else 'unpaid' end
   where id = p_reservation;
end $$;

-- Allocate unallocated money (oldest payment first) to an invoice until it is covered.
create function allocate_payments_to_invoice(p_invoice uuid) returns bigint
language plpgsql security definer set search_path = public as $$
declare i invoices%rowtype; v_out bigint; v_take bigint; v_total bigint := 0; p record;
begin
  select * into i from invoices where id = p_invoice;
  v_out := i.total_minor - coalesce((select sum(amount_minor) from payment_allocations where invoice_id = p_invoice), 0);
  for p in
    select pay.id, pay.amount_minor - coalesce((select sum(a.amount_minor) from payment_allocations a where a.payment_id = pay.id), 0) as free
      from payments pay
     where pay.reservation_id = i.reservation_id and pay.payment_status = 'succeeded'
     order by pay.received_at, pay.id
  loop
    exit when v_out <= 0;
    if p.free > 0 then
      v_take := least(p.free, v_out);
      insert into payment_allocations (tenant_id, payment_id, invoice_id, amount_minor)
      values (i.tenant_id, p.id, p_invoice, v_take);
      v_out := v_out - v_take;
      v_total := v_total + v_take;
    end if;
  end loop;
  return v_total;
end $$;
revoke all on function refresh_invoice_status(uuid), refresh_reservation_payment_status(uuid),
  allocate_payments_to_invoice(uuid) from public, anon, authenticated;

-- Money currently held for a reservation. Refunds (012) redefine this to subtract succeeded refunds.
create function reservation_money_held(p_reservation uuid) returns bigint
language sql stable security definer set search_path = public as $$
  select coalesce(sum(amount_minor), 0) from payments where reservation_id = p_reservation and payment_status = 'succeeded'
$$;
revoke all on function reservation_money_held(uuid) from public, anon, authenticated;

-- ---- issue_invoice ------------------------------------------------------------------------
create function issue_invoice(p_reservation_id uuid, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r reservations%rowtype; v_prop record; v_actor uuid; v_idem record; v_hash text;
  v_inv uuid := gen_random_uuid(); v_year integer; v_n integer; v_number text;
  v_sub bigint; v_tax bigint; v_alloc bigint; v_status text; v_result jsonb;
begin
  select * into r from reservations where id = p_reservation_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(r.property_id, 'invoice.issue', 'NOT_FOUND');

  v_hash := md5(p_reservation_id::text);
  select * into v_idem from idem_begin(r.tenant_id, 'issue_invoice', p_idempotency_key, v_hash);
  if not v_idem.out_is_new then return v_idem.out_response; end if;

  select * into r from reservations where id = p_reservation_id for update;
  if r.reservation_status in ('cancelled', 'expired', 'no_show') then
    raise exception 'INVALID_STATE: %', r.reservation_status using errcode = 'P0001';
  end if;
  if exists (select 1 from invoices where reservation_id = r.id and invoice_status <> 'void') then
    raise exception 'INVALID_STATE: invoice exists' using errcode = 'P0001';
  end if;

  select code, timezone, check_in_time into v_prop from properties where id = r.property_id;
  v_year := extract(year from property_today(r.property_id))::integer;
  insert into invoice_sequences (property_id, year, last_number) values (r.property_id, v_year, 1)
  on conflict (property_id, year) do update set last_number = invoice_sequences.last_number + 1
  returning last_number into v_n;
  v_number := 'INV-' || v_prop.code || '-' || v_year || '-' || lpad(v_n::text, 6, '0');

  insert into invoices (id, tenant_id, property_id, reservation_id, invoice_number, currency,
                        subtotal_minor, tax_minor, discount_minor, total_minor, due_at, created_by)
  values (v_inv, r.tenant_id, r.property_id, r.id, v_number, r.currency,
          r.subtotal_minor, r.tax_minor, r.discount_minor, r.total_minor,
          (r.arrival_date + v_prop.check_in_time) at time zone v_prop.timezone, v_actor);

  insert into invoice_lines (tenant_id, invoice_id, description, quantity, unit_amount_minor,
                             tax_amount_minor, line_total_minor, service_date)
  select r.tenant_id, v_inv, rt.name || ', night of ' || n.night_date, 1, n.rate_minor, n.tax_minor,
         n.rate_minor + n.tax_minor, n.night_date
    from reservation_nights n
    join reservation_rooms rr on rr.id = n.reservation_room_id
    join room_types rt on rt.id = rr.room_type_id
   where rr.reservation_id = r.id
   order by n.night_date, rt.name, rr.id;

  select coalesce(sum(unit_amount_minor * quantity), 0), coalesce(sum(tax_amount_minor), 0)
    into v_sub, v_tax from invoice_lines where invoice_id = v_inv;
  if v_sub <> r.subtotal_minor or v_tax <> r.tax_minor then
    raise exception 'INTERNAL: invoice lines (% + %) do not match reservation (% + %)',
      v_sub, v_tax, r.subtotal_minor, r.tax_minor using errcode = 'XX000';
  end if;

  v_alloc := allocate_payments_to_invoice(v_inv);
  perform refresh_invoice_status(v_inv);
  select invoice_status into v_status from invoices where id = v_inv;

  v_result := jsonb_build_object('invoice_id', v_inv, 'invoice_number', v_number, 'status', v_status,
                                 'total_minor', r.total_minor, 'allocated_minor', v_alloc);
  perform idem_finish(r.tenant_id, 'issue_invoice', p_idempotency_key, v_result);
  perform write_audit(r.tenant_id, r.property_id, v_actor, 'invoice.issued', 'invoice', v_inv,
                      p_idempotency_key, jsonb_build_object('invoice_number', v_number, 'total_minor', r.total_minor,
                                                           'reservation_id', r.id));
  return v_result;
end $$;

-- ---- void_invoice -------------------------------------------------------------------------
create function void_invoice(p_invoice_id uuid, p_reason text, p_idempotency_key text)
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
  if exists (select 1 from payment_allocations where invoice_id = i.id) then
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

-- ---- record_manual_payment ----------------------------------------------------------------
-- Cash, bank transfer or POS money received by staff. Refused on cancelled, expired and no-show
-- reservations until settlement exists, and refused when it would exceed the reservation total.
create function record_manual_payment(
  p_reservation_id uuid, p_amount_minor bigint, p_method text, p_reference text, p_note text,
  p_idempotency_key text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r reservations%rowtype; v_actor uuid; v_idem record; v_hash text; v_paid bigint; v_pay uuid := gen_random_uuid();
  v_ref text; v_inv uuid; v_alloc bigint := 0; v_out bigint; v_result jsonb; v_status text;
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

  v_hash := md5(concat_ws('|', p_reservation_id, p_amount_minor, p_method, coalesce(p_reference, ''), coalesce(p_note, '')));
  select * into v_idem from idem_begin(r.tenant_id, 'record_manual_payment', p_idempotency_key, v_hash);
  if not v_idem.out_is_new then return v_idem.out_response; end if;

  select * into r from reservations where id = p_reservation_id for update;
  if r.reservation_status in ('cancelled', 'expired', 'no_show') then
    raise exception 'INVALID_STATE: %', r.reservation_status using errcode = 'P0001';
  end if;
  v_paid := reservation_money_held(r.id);
  if v_paid + p_amount_minor > r.total_minor then
    raise exception 'POLICY_VIOLATION: OVERPAYMENT outstanding %', r.total_minor - v_paid using errcode = 'P0001';
  end if;

  loop
    v_ref := 'PAY-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
    exit when not exists (select 1 from payments where tenant_id = r.tenant_id and internal_reference = v_ref);
  end loop;
  insert into payments (id, tenant_id, property_id, reservation_id, payment_method, provider_reference,
                        internal_reference, amount_minor, currency, note, recorded_by)
  values (v_pay, r.tenant_id, r.property_id, r.id, p_method, nullif(trim(p_reference), ''), v_ref,
          p_amount_minor, r.currency, nullif(trim(p_note), ''), v_actor);

  select id into v_inv from invoices where reservation_id = r.id and invoice_status <> 'void';
  if v_inv is not null then
    v_alloc := allocate_payments_to_invoice(v_inv);
    perform refresh_invoice_status(v_inv);
  end if;
  perform refresh_reservation_payment_status(r.id);
  select payment_status into v_status from reservations where id = r.id;

  v_result := jsonb_build_object('payment_id', v_pay, 'internal_reference', v_ref, 'amount_minor', p_amount_minor,
                                 'invoice_id', v_inv, 'allocated_minor', v_alloc,
                                 'payment_status', v_status, 'outstanding_minor', r.total_minor - v_paid - p_amount_minor);
  perform idem_finish(r.tenant_id, 'record_manual_payment', p_idempotency_key, v_result);
  perform write_audit(r.tenant_id, r.property_id, v_actor, 'payment.recorded', 'payment', v_pay, p_idempotency_key,
                      jsonb_build_object('reservation_id', r.id, 'amount_minor', p_amount_minor, 'method', p_method,
                                         'internal_reference', v_ref));
  return v_result;
end $$;

revoke all on function issue_invoice(uuid, text), void_invoice(uuid, text, text),
  record_manual_payment(uuid, bigint, text, text, text, text) from public, anon;
grant execute on function issue_invoice(uuid, text), void_invoice(uuid, text, text),
  record_manual_payment(uuid, bigint, text, text, text, text) to authenticated;
