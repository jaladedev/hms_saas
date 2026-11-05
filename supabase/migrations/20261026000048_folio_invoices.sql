-- 048 A numbered invoice for extras.
--
-- 027 kept the folio beside the reservation's money and said a numbered invoice for extras needs "a second invoice per
-- reservation", which about twenty places in the invoice, payment, refund and settlement code do not expect (one live invoice
-- equal to the reservation total, and the unique index invoices_one_live_per_reservation). This does not touch any of that.
-- An invoice for extras is its own thing:
--   * folio_invoices / folio_invoice_lines: a numbered, frozen snapshot of the posted extras it covers, in a table of its own.
--     The reservation's invoices table, its payments, allocation, refunds and settlement are exactly as they were.
--   * The number comes from the same per-property, per-year counter as the booking invoice (invoice_sequences), in the same
--     form (INV-<code>-<year>-<6 digits>), so there is one series with no gaps or repeats between the two kinds.
--   * A posted charge belongs to at most one live invoice (folio_charges.folio_invoice_id). A charge that is on an invoice
--     cannot be voided: void the invoice first, which frees its charges to be invoiced again. Extras posted later stay
--     uninvoiced until the next invoice, so one stay can have several.
--   * Money for extras stays at the level of the folio (folio_payments, as in 027). It is not tied to one invoice, so an
--     invoice has no paid status of its own: it is issued or void. The folio balance is what says what is still owed.
--     Voiding an invoice therefore never moves money; it only withdraws the document.
--
-- Permissions: invoice.issue issues one, invoice.void voids one (the same as for the booking invoice). Reading follows the
-- folio: people who post charges (folio.charge), who issue invoices, or who can see money. Clients read under row-level
-- security and change data only through the two functions below. Rows are history: a void is the only change an invoice
-- ever gets, and its lines never change.
-- Errors: NOT_FOUND, POLICY_VIOLATION: reason, INVALID_STATE: <status> (no folio yet) or INVALID_STATE: nothing to invoice.

create table folio_invoices (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null,
  property_id    uuid not null,
  reservation_id uuid not null,
  invoice_number text not null,
  invoice_status text not null default 'issued' check (invoice_status in ('issued', 'void')),
  currency       char(3) not null,
  subtotal_minor bigint not null check (subtotal_minor >= 0),
  tax_minor      bigint not null check (tax_minor >= 0),
  total_minor    bigint not null check (total_minor > 0),
  issued_at      timestamptz not null default now(),
  issued_by      uuid references auth.users (id) on delete set null,
  void_reason    text check (void_reason is null or length(void_reason) <= 200),
  voided_at      timestamptz,
  voided_by      uuid references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  foreign key (tenant_id, property_id) references properties (tenant_id, id),
  foreign key (tenant_id, property_id, reservation_id) references reservations (tenant_id, property_id, id),
  unique (property_id, invoice_number),
  unique (tenant_id, id),
  check (total_minor = subtotal_minor + tax_minor),
  check ((invoice_status = 'void') = (voided_at is not null)),
  check (invoice_status <> 'void' or void_reason is not null)
);
create index on folio_invoices (reservation_id, invoice_status);
create trigger folio_invoices_updated before update on folio_invoices for each row execute function set_updated_at();

create table folio_invoice_lines (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null,
  property_id       uuid not null,
  folio_invoice_id  uuid not null references folio_invoices (id),
  folio_charge_id   uuid not null references folio_charges (id),
  category          text not null,
  description       text not null,
  quantity          integer not null check (quantity > 0),
  unit_amount_minor bigint not null check (unit_amount_minor > 0),
  tax_minor         bigint not null check (tax_minor >= 0),
  line_total_minor  bigint not null,
  service_date      date not null,
  created_at        timestamptz not null default now(),
  check (line_total_minor = quantity * unit_amount_minor + tax_minor)
);
create index on folio_invoice_lines (folio_invoice_id, service_date);
create index on folio_invoice_lines (folio_charge_id);

-- Which live invoice a charge is on. Set when the invoice is issued, cleared when it is voided.
alter table folio_charges add column folio_invoice_id uuid references folio_invoices (id);
create index on folio_charges (folio_invoice_id) where folio_invoice_id is not null;

-- 027's guard froze everything on a charge except the void columns. The invoice link may now change, and a charge that is
-- on an invoice may not be voided (the functions say so first; this is the backstop).
create or replace function folio_charges_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'folio_charges rows are kept as history' using errcode = '23514'; end if;
  if (to_jsonb(new) - 'status' - 'voided_at' - 'voided_by' - 'void_reason' - 'updated_at' - 'posted_by' - 'folio_invoice_id')
     is distinct from (to_jsonb(old) - 'status' - 'voided_at' - 'voided_by' - 'void_reason' - 'updated_at' - 'posted_by' - 'folio_invoice_id') then
    raise exception 'a posted folio charge cannot be edited; void it and post it again' using errcode = '23514';
  end if;
  if old.status = 'voided' and (new.status, new.voided_at, new.void_reason, new.folio_invoice_id) is distinct from (old.status, old.voided_at, old.void_reason, old.folio_invoice_id) then
    raise exception 'a voided folio charge cannot change' using errcode = '23514';
  end if;
  if new.status = 'voided' and old.status = 'posted' and old.folio_invoice_id is not null then
    raise exception 'a charge on an invoice cannot be voided; void the invoice first' using errcode = '23514';
  end if;
  return new;
end $$;

-- Invoices and their lines are history. An issued invoice may be voided once; nothing else about it changes.
create function folio_invoices_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'folio_invoices rows are kept as history' using errcode = '23514'; end if;
  if (to_jsonb(new) - 'invoice_status' - 'void_reason' - 'voided_at' - 'voided_by' - 'updated_at' - 'issued_by')
     is distinct from (to_jsonb(old) - 'invoice_status' - 'void_reason' - 'voided_at' - 'voided_by' - 'updated_at' - 'issued_by') then
    raise exception 'an issued invoice cannot be edited; void it and issue it again' using errcode = '23514';
  end if;
  if old.invoice_status = 'void' and (new.invoice_status, new.voided_at, new.void_reason) is distinct from (old.invoice_status, old.voided_at, old.void_reason) then
    raise exception 'a voided invoice cannot change' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger folio_invoices_guard_trg before update or delete on folio_invoices
  for each row execute function folio_invoices_guard();

create function folio_invoice_lines_guard() returns trigger language plpgsql as $$
begin
  raise exception 'folio_invoice_lines rows are kept as history' using errcode = '23514';
end $$;
create trigger folio_invoice_lines_guard_trg before update or delete on folio_invoice_lines
  for each row execute function folio_invoice_lines_guard();

revoke all on function folio_invoices_guard(), folio_invoice_lines_guard() from public, anon, authenticated;

-- ---- row-level security --------------------------------------------------------------------
alter table folio_invoices      enable row level security;
alter table folio_invoice_lines enable row level security;
create policy folio_invoices_select on folio_invoices for select to authenticated
  using (has_permission(property_id, 'folio.charge') or has_permission(property_id, 'invoice.issue') or can_view_money(property_id));
create policy folio_invoice_lines_select on folio_invoice_lines for select to authenticated
  using (has_permission(property_id, 'folio.charge') or has_permission(property_id, 'invoice.issue') or can_view_money(property_id));
revoke insert, update, delete on folio_invoices, folio_invoice_lines from authenticated, anon;

-- ---- void_folio_charge: a charge on an invoice is refused with a clear reason ----------------
create or replace function void_folio_charge(p_charge_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c folio_charges%rowtype; v_actor uuid; v_reason text := nullif(btrim(p_reason), ''); v_tot record; v_result jsonb;
begin
  select * into c from folio_charges where id = p_charge_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(c.property_id, 'folio.charge', 'NOT_FOUND');
  if v_reason is null or length(v_reason) > 200 then raise exception 'POLICY_VIOLATION: reason' using errcode = 'P0001'; end if;

  perform 1 from reservations where id = c.reservation_id for update;
  select * into c from folio_charges where id = p_charge_id for update;
  select * into v_tot from folio_totals(c.reservation_id);
  if c.status = 'voided' then
    return jsonb_build_object('charge_id', c.id, 'status', 'voided', 'balance_minor', v_tot.charges_minor - v_tot.paid_minor);
  end if;
  if c.folio_invoice_id is not null then
    raise exception 'INVALID_STATE: on an invoice' using errcode = 'P0001';
  end if;
  if v_tot.paid_minor > v_tot.charges_minor - c.total_minor then
    raise exception 'INVALID_STATE: folio paid' using errcode = 'P0001';
  end if;

  update folio_charges set status = 'voided', voided_at = now(), voided_by = v_actor, void_reason = v_reason where id = c.id;
  select * into v_tot from folio_totals(c.reservation_id);
  v_result := jsonb_build_object('charge_id', c.id, 'status', 'voided', 'balance_minor', v_tot.charges_minor - v_tot.paid_minor);
  perform write_audit(c.tenant_id, c.property_id, v_actor, 'folio.charge_voided', 'folio_charge', c.id, null,
                      jsonb_build_object('reservation_id', c.reservation_id, 'total_minor', c.total_minor, 'reason', v_reason));
  return v_result;
end $$;

-- ---- issue_folio_invoice -----------------------------------------------------------------------
-- Numbers every posted extra that is not yet on an invoice, all together, as one invoice. Repeating the call with the same
-- key answers with the first answer; a second call with a new key finds nothing left and is refused.
create function issue_folio_invoice(p_reservation_id uuid, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r reservations%rowtype; v_prop record; v_actor uuid; v_idem record; v_inv uuid := gen_random_uuid();
  v_year integer; v_n integer; v_number text; v_sub bigint; v_tax bigint; v_count integer; v_lines bigint; v_result jsonb;
begin
  select * into r from reservations where id = p_reservation_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(r.property_id, 'invoice.issue', 'NOT_FOUND');
  if r.reservation_status not in ('checked_in', 'checked_out') then
    raise exception 'INVALID_STATE: %', r.reservation_status using errcode = 'P0001';
  end if;

  select * into v_idem from idem_begin(r.tenant_id, 'issue_folio_invoice', p_idempotency_key, md5(p_reservation_id::text));
  if not v_idem.out_is_new then return v_idem.out_response; end if;

  select * into r from reservations where id = p_reservation_id for update;
  if r.reservation_status not in ('checked_in', 'checked_out') then
    raise exception 'INVALID_STATE: %', r.reservation_status using errcode = 'P0001';
  end if;

  select count(*), coalesce(sum(quantity * unit_amount_minor), 0), coalesce(sum(tax_minor), 0)
    into v_count, v_sub, v_tax
    from folio_charges where reservation_id = r.id and status = 'posted' and folio_invoice_id is null;
  if v_count = 0 then raise exception 'INVALID_STATE: nothing to invoice' using errcode = 'P0001'; end if;

  select code into v_prop from properties where id = r.property_id;
  v_year := extract(year from property_today(r.property_id))::integer;
  insert into invoice_sequences (property_id, year, last_number) values (r.property_id, v_year, 1)
  on conflict (property_id, year) do update set last_number = invoice_sequences.last_number + 1
  returning last_number into v_n;
  v_number := 'INV-' || v_prop.code || '-' || v_year || '-' || lpad(v_n::text, 6, '0');

  insert into folio_invoices (id, tenant_id, property_id, reservation_id, invoice_number, currency,
                              subtotal_minor, tax_minor, total_minor, issued_by)
  values (v_inv, r.tenant_id, r.property_id, r.id, v_number, r.currency, v_sub, v_tax, v_sub + v_tax, v_actor);

  insert into folio_invoice_lines (tenant_id, property_id, folio_invoice_id, folio_charge_id, category, description, quantity,
                                   unit_amount_minor, tax_minor, line_total_minor, service_date)
  select c.tenant_id, c.property_id, v_inv, c.id, c.category, c.description, c.quantity,
         c.unit_amount_minor, c.tax_minor, c.total_minor, c.charge_date
    from folio_charges c
   where c.reservation_id = r.id and c.status = 'posted' and c.folio_invoice_id is null
   order by c.charge_date, c.created_at, c.id;
  get diagnostics v_lines = row_count;

  update folio_charges set folio_invoice_id = v_inv
   where reservation_id = r.id and status = 'posted' and folio_invoice_id is null;
  if v_lines <> v_count then
    raise exception 'INTERNAL: invoice lines (%) do not match charges (%)', v_lines, v_count using errcode = 'XX000';
  end if;

  v_result := jsonb_build_object('folio_invoice_id', v_inv, 'invoice_number', v_number, 'status', 'issued',
                                 'subtotal_minor', v_sub, 'tax_minor', v_tax, 'total_minor', v_sub + v_tax, 'line_count', v_count);
  perform idem_finish(r.tenant_id, 'issue_folio_invoice', p_idempotency_key, v_result);
  perform write_audit(r.tenant_id, r.property_id, v_actor, 'folio_invoice.issued', 'folio_invoice', v_inv, p_idempotency_key,
                      jsonb_build_object('invoice_number', v_number, 'total_minor', v_sub + v_tax, 'reservation_id', r.id, 'line_count', v_count));
  return v_result;
end $$;

-- ---- void_folio_invoice ------------------------------------------------------------------------
-- Withdraws the invoice and frees its charges to be invoiced again. No money moves: extras money lives on the folio.
-- A second void is a no-op.
create function void_folio_invoice(p_invoice_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  i folio_invoices%rowtype; v_actor uuid; v_reason text := nullif(btrim(p_reason), ''); v_freed integer := 0;
begin
  select * into i from folio_invoices where id = p_invoice_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(i.property_id, 'invoice.void', 'NOT_FOUND');
  if v_reason is null or length(v_reason) > 200 then raise exception 'POLICY_VIOLATION: reason' using errcode = 'P0001'; end if;

  perform 1 from reservations where id = i.reservation_id for update;
  select * into i from folio_invoices where id = p_invoice_id for update;
  if i.invoice_status = 'issued' then
    update folio_invoices set invoice_status = 'void', voided_at = now(), voided_by = v_actor, void_reason = v_reason where id = i.id;
    update folio_charges set folio_invoice_id = null where folio_invoice_id = i.id;
    get diagnostics v_freed = row_count;
    perform write_audit(i.tenant_id, i.property_id, v_actor, 'folio_invoice.voided', 'folio_invoice', i.id, null,
                        jsonb_build_object('invoice_number', i.invoice_number, 'total_minor', i.total_minor, 'reason', v_reason,
                                           'reservation_id', i.reservation_id, 'charges_freed', v_freed));
  end if;
  return jsonb_build_object('folio_invoice_id', i.id, 'invoice_number', i.invoice_number, 'status', 'void');
end $$;

revoke all on function issue_folio_invoice(uuid, text), void_folio_invoice(uuid, text) from public, anon;
grant execute on function issue_folio_invoice(uuid, text), void_folio_invoice(uuid, text) to authenticated;
