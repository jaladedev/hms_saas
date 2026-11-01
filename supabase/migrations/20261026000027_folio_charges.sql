-- 027 Folio: extra charges during a stay (minibar, laundry, a late check-out) and the money taken for them.
--
-- Where this sits next to the money from 010-016:
--   * The reservation's own money is untouched. A charge never changes a reservation's totals, its invoice, its
--     payment status, the money it holds, the refund limits, the cancellation settlement or the provider checks.
--     Those all rest on "one invoice per reservation, equal to the reservation total" and stay exactly as they are.
--   * Extras live in their own small ledger: folio_charges (what the guest bought) and folio_payments (what was
--     collected for it). The folio balance is posted charges minus succeeded folio payments. Money for extras is
--     taken by staff (cash, transfer, POS); it is not a provider payment and not part of the reservation's payments.
--   * Not done here, on purpose: a numbered invoice for extras. That needs the invoice and payment code to handle
--     a second invoice per reservation (about twenty places assume one), so it is a separate, deliberate change.
--     Until then the folio is a statement (charges, tax, payments, balance), not an invoice. Anything that adds up
--     "all money received" (reports) must add folio_payments to payments.
--
-- Rules:
--   * Charges are posted while a guest is in the house or has just left (reservation checked_in or checked_out),
--     dated between the arrival and today. A charge is never edited; a wrong one is voided with a reason and posted
--     again. A void is refused if the folio has been paid beyond what would remain; reverse a folio payment first.
--   * Tax is taken from the hotel's tax_rules, but only the percent rules a person has marked applies_to_charges.
--     Nothing is taxed until a rule is marked: nights and extras are taxed differently, and an unmarked rule is not
--     guessed at. The tax is worked out when the charge is posted and stored on it, so a later change to the rules
--     never alters a charge already posted. Fixed-per-night rules never apply to an extra.
--   * Money is bigint kobo. A folio payment can never take the folio over its balance.
--   * Clients read under row-level security and change data only through the functions below. Rows are never deleted;
--     a charge or payment is frozen apart from being voided or reversed once.
--   * Every function locks the reservation row first, so charges, voids and payments for one reservation are
--     serialised and the balance cannot be overtaken by two clients at once.

-- ---- permission --------------------------------------------------------------------------
-- folio.charge: post and void charges (front desk, general manager, owner). Recording the money uses payment.record
-- (already held by front desk and accountants); reversing a recorded folio payment needs refund.approve, so the person
-- who takes the money cannot also undo it.
insert into permissions (key) values ('folio.charge');
insert into role_permissions (role_id, permission_id)
select r.id, p.id
  from roles r, permissions p
 where p.key = 'folio.charge' and r.key in ('owner', 'general_manager', 'front_desk');

-- ---- tax rules: which ones apply to extras ------------------------------------------------
alter table tax_rules add column applies_to_charges boolean not null default false;
alter table tax_rules add constraint tax_rules_charges_percent_only check (not applies_to_charges or basis = 'percent');

-- ---- tables ------------------------------------------------------------------------------
create table folio_charges (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null,
  property_id         uuid not null,
  reservation_id      uuid not null,
  reservation_room_id uuid,
  category            text not null check (category in ('minibar', 'laundry', 'food_beverage', 'late_checkout', 'damage', 'phone', 'other')),
  description         text not null check (length(description) between 1 and 200),
  quantity            integer not null check (quantity between 1 and 1000),
  unit_amount_minor   bigint not null check (unit_amount_minor between 1 and 1000000000),
  tax_minor           bigint not null default 0 check (tax_minor >= 0),
  total_minor         bigint not null,
  currency            char(3) not null,
  charge_date         date not null,
  status              text not null default 'posted' check (status in ('posted', 'voided')),
  posted_by           uuid references auth.users (id) on delete set null,
  created_at          timestamptz not null default now(),
  voided_at           timestamptz,
  voided_by           uuid references auth.users (id) on delete set null,
  void_reason         text check (void_reason is null or length(void_reason) <= 200),
  updated_at          timestamptz not null default now(),
  foreign key (tenant_id, property_id) references properties (tenant_id, id),
  foreign key (tenant_id, property_id, reservation_id) references reservations (tenant_id, property_id, id),
  foreign key (reservation_room_id) references reservation_rooms (id),
  check (total_minor = quantity * unit_amount_minor + tax_minor),
  check ((status = 'voided') = (voided_at is not null)),
  check (status <> 'voided' or void_reason is not null)
);
create index on folio_charges (reservation_id, status);
create index on folio_charges (property_id, charge_date);

create table folio_payments (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null,
  property_id        uuid not null,
  reservation_id     uuid not null,
  payment_method     text not null check (payment_method in ('cash', 'bank_transfer', 'pos', 'other')),
  provider_reference text check (provider_reference is null or length(provider_reference) <= 100),  -- bank slip or POS receipt number
  internal_reference text not null,
  amount_minor       bigint not null check (amount_minor > 0),
  currency           char(3) not null,
  payment_status     text not null default 'succeeded' check (payment_status in ('succeeded', 'reversed')),
  note               text check (note is null or length(note) <= 500),
  received_at        timestamptz not null default now(),
  recorded_by        uuid references auth.users (id) on delete set null,
  reversed_at        timestamptz,
  reversed_by        uuid references auth.users (id) on delete set null,
  reverse_reason     text check (reverse_reason is null or length(reverse_reason) <= 200),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  foreign key (tenant_id, property_id, reservation_id) references reservations (tenant_id, property_id, id),
  unique (tenant_id, internal_reference),
  check ((payment_status = 'reversed') = (reversed_at is not null)),
  check (payment_status <> 'reversed' or reverse_reason is not null)
);
create index on folio_payments (reservation_id, payment_status);

create trigger folio_charges_updated before update on folio_charges for each row execute function set_updated_at();
create trigger folio_payments_updated before update on folio_payments for each row execute function set_updated_at();

-- Rows are history. Nothing is deleted. A posted charge may be voided once and a succeeded payment reversed once;
-- nothing else about either ever changes. The person columns may become null when a login is deleted.
create function folio_charges_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'folio_charges rows are kept as history' using errcode = '23514'; end if;
  if (to_jsonb(new) - 'status' - 'voided_at' - 'voided_by' - 'void_reason' - 'updated_at' - 'posted_by')
     is distinct from (to_jsonb(old) - 'status' - 'voided_at' - 'voided_by' - 'void_reason' - 'updated_at' - 'posted_by') then
    raise exception 'a posted folio charge cannot be edited; void it and post it again' using errcode = '23514';
  end if;
  if old.status = 'voided' and (new.status, new.voided_at, new.void_reason) is distinct from (old.status, old.voided_at, old.void_reason) then
    raise exception 'a voided folio charge cannot change' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger folio_charges_guard_trg before update or delete on folio_charges
  for each row execute function folio_charges_guard();

create function folio_payments_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'folio_payments rows are kept as history' using errcode = '23514'; end if;
  if (to_jsonb(new) - 'payment_status' - 'reversed_at' - 'reversed_by' - 'reverse_reason' - 'updated_at' - 'recorded_by')
     is distinct from (to_jsonb(old) - 'payment_status' - 'reversed_at' - 'reversed_by' - 'reverse_reason' - 'updated_at' - 'recorded_by') then
    raise exception 'a recorded folio payment cannot be edited; reverse it instead' using errcode = '23514';
  end if;
  if old.payment_status = 'reversed' and (new.payment_status, new.reversed_at, new.reverse_reason) is distinct from (old.payment_status, old.reversed_at, old.reverse_reason) then
    raise exception 'a reversed folio payment cannot change' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger folio_payments_guard_trg before update or delete on folio_payments
  for each row execute function folio_payments_guard();

revoke all on function folio_charges_guard(), folio_payments_guard() from public, anon, authenticated;

-- ---- row-level security ------------------------------------------------------------------
-- Charges and folio payments are money: readable by people who post charges and by the finance-facing roles that
-- can already read invoices and payments (can_view_money, from 010). Housekeeping and maintenance see neither.
alter table folio_charges  enable row level security;
alter table folio_payments enable row level security;

create policy folio_charges_select on folio_charges for select to authenticated
  using (has_permission(property_id, 'folio.charge') or can_view_money(property_id));
create policy folio_payments_select on folio_payments for select to authenticated
  using (has_permission(property_id, 'folio.charge') or can_view_money(property_id));

revoke insert, update, delete on folio_charges, folio_payments from authenticated, anon;

-- ---- internal helpers --------------------------------------------------------------------
-- Tax on an extra: the percent rules marked applies_to_charges and in force on the charge date, in sequence, a
-- compounding rule applying to the running total. p_amount is the line amount before tax (quantity x unit).
create function calc_charge_tax(p_property uuid, p_date date, p_amount bigint) returns bigint
language plpgsql stable security definer set search_path = public as $$
declare r record; running numeric := p_amount; total bigint := 0; t bigint;
begin
  for r in
    select * from tax_rules
     where property_id = p_property and status = 'active' and basis = 'percent' and applies_to_charges
       and effective_from <= p_date and (effective_to is null or effective_to >= p_date)
     order by sequence, id
  loop
    t := round((case when r.compounds then running else p_amount end) * r.rate_value / 100)::bigint;
    running := running + t;
    total := total + t;
  end loop;
  return total;
end $$;

-- What the folio holds right now: posted charges, the tax in them, and money collected (succeeded folio payments).
create function folio_totals(p_reservation uuid, out charges_minor bigint, out tax_minor bigint, out paid_minor bigint, out charge_count integer)
language sql stable security definer set search_path = public as $$
  select coalesce((select sum(total_minor) from folio_charges where reservation_id = p_reservation and status = 'posted'), 0),
         coalesce((select sum(tax_minor)   from folio_charges where reservation_id = p_reservation and status = 'posted'), 0),
         coalesce((select sum(amount_minor) from folio_payments where reservation_id = p_reservation and payment_status = 'succeeded'), 0),
         (select count(*) from folio_charges where reservation_id = p_reservation and status = 'posted')::integer
$$;

revoke all on function calc_charge_tax(uuid, date, bigint), folio_totals(uuid) from public, anon, authenticated;

-- ---- functions clients call --------------------------------------------------------------
-- Errors: NOT_FOUND (no such thing, no permission, or another hotel: they look the same), FORBIDDEN, POLICY_VIOLATION
-- (bad input; 'OVERPAYMENT outstanding N' when a payment is more than the balance, the same wording as 010), and
-- INVALID_STATE. Repeating a post or a payment with the same key answers with the first answer.

create function post_folio_charge(
  p_reservation_id      uuid,
  p_category            text,
  p_description         text,
  p_quantity            integer,
  p_unit_amount_minor   bigint,
  p_idempotency_key     text,
  p_charge_date         date default null,
  p_reservation_room_id uuid default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r reservations%rowtype; v_actor uuid; v_idem record; v_hash text; v_today date; v_date date; v_desc text := btrim(p_description);
  v_tax bigint; v_id uuid := gen_random_uuid(); v_tot record; v_result jsonb;
begin
  select * into r from reservations where id = p_reservation_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(r.property_id, 'folio.charge', 'NOT_FOUND');
  -- a guest who is not in the house and has not left has no folio; checked again under the lock below
  if r.reservation_status not in ('checked_in', 'checked_out') then
    raise exception 'INVALID_STATE: %', r.reservation_status using errcode = 'P0001';
  end if;

  if p_category is null or p_category not in ('minibar', 'laundry', 'food_beverage', 'late_checkout', 'damage', 'phone', 'other') then
    raise exception 'POLICY_VIOLATION: category' using errcode = 'P0001';
  end if;
  if v_desc is null or length(v_desc) not between 1 and 200 then raise exception 'POLICY_VIOLATION: description' using errcode = 'P0001'; end if;
  if p_quantity is null or p_quantity not between 1 and 1000 then raise exception 'POLICY_VIOLATION: quantity' using errcode = 'P0001'; end if;
  if p_unit_amount_minor is null or p_unit_amount_minor not between 1 and 1000000000 then
    raise exception 'POLICY_VIOLATION: amount' using errcode = 'P0001';
  end if;
  v_today := property_today(r.property_id);
  v_date := coalesce(p_charge_date, v_today);
  if v_date > v_today or v_date < r.arrival_date then raise exception 'POLICY_VIOLATION: date' using errcode = 'P0001'; end if;
  if p_reservation_room_id is not null
     and not exists (select 1 from reservation_rooms where id = p_reservation_room_id and reservation_id = r.id) then
    raise exception 'POLICY_VIOLATION: room' using errcode = 'P0001';
  end if;

  v_hash := md5(concat_ws('|', p_reservation_id, p_category, v_desc, p_quantity, p_unit_amount_minor, v_date, p_reservation_room_id));
  select * into v_idem from idem_begin(r.tenant_id, 'post_folio_charge', p_idempotency_key, v_hash);
  if not v_idem.out_is_new then return v_idem.out_response; end if;

  select * into r from reservations where id = p_reservation_id for update;
  if r.reservation_status not in ('checked_in', 'checked_out') then
    raise exception 'INVALID_STATE: %', r.reservation_status using errcode = 'P0001';
  end if;

  v_tax := calc_charge_tax(r.property_id, v_date, p_quantity::bigint * p_unit_amount_minor);
  insert into folio_charges (id, tenant_id, property_id, reservation_id, reservation_room_id, category, description, quantity,
                             unit_amount_minor, tax_minor, total_minor, currency, charge_date, posted_by)
  values (v_id, r.tenant_id, r.property_id, r.id, p_reservation_room_id, p_category, v_desc, p_quantity,
          p_unit_amount_minor, v_tax, p_quantity::bigint * p_unit_amount_minor + v_tax, r.currency, v_date, v_actor);

  select * into v_tot from folio_totals(r.id);
  v_result := jsonb_build_object('charge_id', v_id, 'total_minor', p_quantity::bigint * p_unit_amount_minor + v_tax, 'tax_minor', v_tax,
                                 'charges_minor', v_tot.charges_minor, 'paid_minor', v_tot.paid_minor,
                                 'balance_minor', v_tot.charges_minor - v_tot.paid_minor);
  perform idem_finish(r.tenant_id, 'post_folio_charge', p_idempotency_key, v_result);
  perform write_audit(r.tenant_id, r.property_id, v_actor, 'folio.charge_posted', 'folio_charge', v_id, p_idempotency_key,
                      jsonb_build_object('reservation_id', r.id, 'category', p_category, 'quantity', p_quantity,
                                         'unit_amount_minor', p_unit_amount_minor, 'tax_minor', v_tax, 'charge_date', v_date));
  return v_result;
end $$;

-- Take a charge off the folio, with a reason. Refused when the money already collected would then be more than the
-- charges that remain (reverse a folio payment first). A second void is a no-op.
create function void_folio_charge(p_charge_id uuid, p_reason text) returns jsonb
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

-- Money collected for the extras. It can never be more than the balance.
create function record_folio_payment(
  p_reservation_id  uuid,
  p_amount_minor    bigint,
  p_method          text,
  p_reference       text,
  p_note            text,
  p_idempotency_key text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r reservations%rowtype; v_actor uuid; v_idem record; v_hash text; v_tot record; v_id uuid := gen_random_uuid(); v_ref text;
  v_reference text := nullif(btrim(p_reference), ''); v_note text := nullif(btrim(p_note), ''); v_result jsonb;
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

  loop
    v_ref := 'FOL-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
    exit when not exists (select 1 from folio_payments where tenant_id = r.tenant_id and internal_reference = v_ref);
  end loop;
  insert into folio_payments (id, tenant_id, property_id, reservation_id, payment_method, provider_reference, internal_reference,
                              amount_minor, currency, note, recorded_by)
  values (v_id, r.tenant_id, r.property_id, r.id, p_method, v_reference, v_ref, p_amount_minor, r.currency, v_note, v_actor);

  v_result := jsonb_build_object('payment_id', v_id, 'internal_reference', v_ref, 'amount_minor', p_amount_minor,
                                 'charges_minor', v_tot.charges_minor, 'paid_minor', v_tot.paid_minor + p_amount_minor,
                                 'balance_minor', v_tot.charges_minor - v_tot.paid_minor - p_amount_minor);
  perform idem_finish(r.tenant_id, 'record_folio_payment', p_idempotency_key, v_result);
  perform write_audit(r.tenant_id, r.property_id, v_actor, 'folio.payment_recorded', 'folio_payment', v_id, p_idempotency_key,
                      jsonb_build_object('reservation_id', r.id, 'amount_minor', p_amount_minor, 'method', p_method, 'internal_reference', v_ref));
  return v_result;
end $$;

-- Undo a folio payment recorded by mistake. Needs refund.approve, so it is a different person from the one who took
-- the money. The money is not refunded by this: it only puts the amount back on the balance. A second reversal is a no-op.
create function reverse_folio_payment(p_payment_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  p folio_payments%rowtype; v_actor uuid; v_reason text := nullif(btrim(p_reason), ''); v_tot record;
begin
  select * into p from folio_payments where id = p_payment_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(p.property_id, 'refund.approve', 'NOT_FOUND');
  if v_reason is null or length(v_reason) > 200 then raise exception 'POLICY_VIOLATION: reason' using errcode = 'P0001'; end if;

  perform 1 from reservations where id = p.reservation_id for update;
  select * into p from folio_payments where id = p_payment_id for update;
  if p.payment_status = 'succeeded' then
    update folio_payments set payment_status = 'reversed', reversed_at = now(), reversed_by = v_actor, reverse_reason = v_reason where id = p.id;
    perform write_audit(p.tenant_id, p.property_id, v_actor, 'folio.payment_reversed', 'folio_payment', p.id, null,
                        jsonb_build_object('reservation_id', p.reservation_id, 'amount_minor', p.amount_minor, 'reason', v_reason));
  end if;
  select * into v_tot from folio_totals(p.reservation_id);
  return jsonb_build_object('payment_id', p.id, 'status', 'reversed', 'balance_minor', v_tot.charges_minor - v_tot.paid_minor);
end $$;

-- The folio at a glance: for a check-out screen and for statements.
create function folio_balance(p_reservation_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r reservations%rowtype; v_tot record;
begin
  select * into r from reservations where id = p_reservation_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if not (has_permission(r.property_id, 'folio.charge') or can_view_money(r.property_id)) then
    raise exception 'NOT_FOUND' using errcode = 'P0001';
  end if;
  select * into v_tot from folio_totals(r.id);
  return jsonb_build_object('currency', r.currency, 'charge_count', v_tot.charge_count, 'charges_minor', v_tot.charges_minor,
                            'tax_minor', v_tot.tax_minor, 'paid_minor', v_tot.paid_minor,
                            'balance_minor', v_tot.charges_minor - v_tot.paid_minor);
end $$;

revoke all on function
  post_folio_charge(uuid, text, text, integer, bigint, text, date, uuid),
  void_folio_charge(uuid, text),
  record_folio_payment(uuid, bigint, text, text, text, text),
  reverse_folio_payment(uuid, text),
  folio_balance(uuid)
  from public, anon;
grant execute on function
  post_folio_charge(uuid, text, text, integer, bigint, text, date, uuid),
  void_folio_charge(uuid, text),
  record_folio_payment(uuid, bigint, text, text, text, text),
  reverse_folio_payment(uuid, text),
  folio_balance(uuid)
  to authenticated;
