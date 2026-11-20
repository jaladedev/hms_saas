-- 154 Group bookings, step three (TODO 8.7): a numbered invoice to the company for a group's bookings.
--
-- A group invoice is a DOCUMENT, like the extras invoice (048): a frozen, numbered copy of what the company is asked to pay, in tables of its
-- own. It does not touch any booking's own invoice, payments, refunds, settlement or folio, so nothing is counted twice in the reports.
--   * What it bills: the bookings linked to the group's rooming list (153) that are confirmed, checked in or checked out, one line each at the
--     booking's total (room price after any discount, plus tax). Extras are NOT on it: each booking's extras keep their own invoice (048).
--   * One live group invoice per booking: a booking already on an issued or paid group invoice is skipped; void that invoice to bill it again.
--   * Number: the same per-property, per-year series as every other invoice (INV-<code>-<year>-<6 digits>).
--   * Status: 'issued', 'paid' or 'void'. 'paid' only RECORDS that the company paid this document (when, how, a reference). It does NOT post a
--     payment to the bookings: their own payment status is unchanged. Settling the bookings from one company payment is a later step.
--   * Permissions: invoice.issue to issue (plus group.manage), payment.record to mark paid, invoice.void to void. Reading needs group.manage and
--     the right to see money. NOT_FOUND for no permission or another hotel. Every change is audited. A void is the only change to an issued
--     invoice besides being marked paid; its lines never change.
-- Errors: NOT_FOUND, POLICY_VIOLATION: due date / reason / method / reference, INVALID_STATE: nothing to invoice / <status>.

create table group_invoices (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null,
  property_id    uuid not null,
  group_id       uuid not null references group_bookings (id),
  invoice_number text not null,
  invoice_status text not null default 'issued' check (invoice_status in ('issued', 'paid', 'void')),
  bill_to        text not null check (char_length(bill_to) between 1 and 80),
  bill_to_email  text,
  currency       char(3) not null,
  subtotal_minor bigint not null check (subtotal_minor >= 0),
  tax_minor      bigint not null check (tax_minor >= 0),
  total_minor    bigint not null check (total_minor > 0),
  due_date       date not null,
  issued_at      timestamptz not null default now(),
  issued_by      uuid references auth.users (id) on delete set null,
  paid_at        timestamptz,
  paid_by        uuid references auth.users (id) on delete set null,
  paid_method    text check (paid_method is null or paid_method in ('cash', 'bank_transfer', 'pos', 'other')),
  paid_reference text check (paid_reference is null or char_length(paid_reference) <= 60),
  void_reason    text check (void_reason is null or char_length(void_reason) <= 200),
  voided_at      timestamptz,
  voided_by      uuid references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  foreign key (tenant_id, property_id) references properties (tenant_id, id),
  unique (property_id, invoice_number),
  check (total_minor = subtotal_minor + tax_minor),
  check ((invoice_status = 'void') = (voided_at is not null)),
  check (invoice_status <> 'void' or void_reason is not null),
  check ((invoice_status = 'paid') = (paid_at is not null and paid_method is not null))
);
create index group_invoices_group_idx on group_invoices (group_id, invoice_status);
create trigger group_invoices_updated before update on group_invoices for each row execute function set_updated_at();

create table group_invoice_lines (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null,
  property_id       uuid not null,
  group_invoice_id  uuid not null references group_invoices (id),
  reservation_id    uuid not null references reservations (id),
  booking_reference text not null,
  guest_name        text not null,
  arrival_date      date not null,
  departure_date    date not null,
  net_minor         bigint not null check (net_minor >= 0),
  tax_minor         bigint not null check (tax_minor >= 0),
  line_total_minor  bigint not null,
  created_at        timestamptz not null default now(),
  check (line_total_minor = net_minor + tax_minor)
);
create index group_invoice_lines_invoice_idx on group_invoice_lines (group_invoice_id);
create index group_invoice_lines_reservation_idx on group_invoice_lines (reservation_id);

-- Only the status columns of an invoice ever change; a void cannot be undone; a paid invoice cannot be voided. Lines never change.
create function group_invoices_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'group_invoices rows are kept as history' using errcode = '23514'; end if;
  if (to_jsonb(new) - 'invoice_status' - 'void_reason' - 'voided_at' - 'voided_by' - 'paid_at' - 'paid_by' - 'paid_method' - 'paid_reference' - 'updated_at')
     is distinct from (to_jsonb(old) - 'invoice_status' - 'void_reason' - 'voided_at' - 'voided_by' - 'paid_at' - 'paid_by' - 'paid_method' - 'paid_reference' - 'updated_at') then
    raise exception 'an issued group invoice cannot be edited; void it and issue it again' using errcode = '23514';
  end if;
  if old.invoice_status <> 'issued' and new.invoice_status is distinct from old.invoice_status then
    raise exception 'a % group invoice cannot change status', old.invoice_status using errcode = '23514';
  end if;
  return new;
end $$;
create trigger group_invoices_guard_trg before update or delete on group_invoices for each row execute function group_invoices_guard();
create function group_invoice_lines_guard() returns trigger language plpgsql as $$
begin raise exception 'group_invoice_lines rows are kept as history' using errcode = '23514'; end $$;
create trigger group_invoice_lines_guard_trg before update or delete on group_invoice_lines for each row execute function group_invoice_lines_guard();
revoke all on function group_invoices_guard(), group_invoice_lines_guard() from public, anon, authenticated;

alter table group_invoices enable row level security;
alter table group_invoice_lines enable row level security;
create policy group_invoices_select on group_invoices for select to authenticated using (has_permission(property_id, 'group.manage') and can_view_money(property_id));
create policy group_invoice_lines_select on group_invoice_lines for select to authenticated using (has_permission(property_id, 'group.manage') and can_view_money(property_id));
revoke insert, update, delete on group_invoices, group_invoice_lines from authenticated, anon;

create function issue_group_invoice(p_group uuid, p_due date, p_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  b group_bookings%rowtype; g record; v_idem record; v_inv uuid := gen_random_uuid(); v_code text; v_year integer; v_n integer; v_number text;
  v_sub bigint; v_tax bigint; v_count integer; v_cur text; v_result jsonb; v_to text; v_lines jsonb;
begin
  select * into b from group_bookings where id = p_group;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  select * into g from group_guard(b.property_id);
  perform require_permission(b.property_id, 'invoice.issue', 'NOT_FOUND');
  if p_due is null or p_due < property_today(b.property_id) or p_due > property_today(b.property_id) + 365 then raise exception 'POLICY_VIOLATION: due date' using errcode = 'P0001'; end if;

  select * into v_idem from idem_begin(g.o_tenant, 'issue_group_invoice', p_key, md5(p_group::text || '|' || p_due::text));
  if not v_idem.out_is_new then return v_idem.out_response; end if;

  perform 1 from group_bookings where id = b.id for update;
  select coalesce(jsonb_agg(jsonb_build_object('reservation_id', v.id, 'booking_reference', v.booking_reference, 'guest_name', gu.full_name,
                    'arrival_date', v.arrival_date, 'departure_date', v.departure_date, 'net_minor', v.subtotal_minor - v.discount_minor,
                    'tax_minor', v.tax_minor, 'currency', v.currency) order by v.arrival_date, v.booking_reference), '[]'::jsonb)
    into v_lines
    from group_rooming r join reservations v on v.id = r.reservation_id join guests gu on gu.id = v.primary_guest_id
   where r.group_id = b.id and v.reservation_status in ('confirmed', 'checked_in', 'checked_out') and v.total_minor > 0
     and not exists (select 1 from group_invoice_lines l join group_invoices i on i.id = l.group_invoice_id where l.reservation_id = v.id and i.invoice_status <> 'void');
  select count(*), coalesce(sum(x.net_minor), 0), coalesce(sum(x.tax_minor), 0), max(x.currency)
    into v_count, v_sub, v_tax, v_cur
    from jsonb_to_recordset(v_lines) as x(net_minor bigint, tax_minor bigint, currency text);
  if v_count = 0 then raise exception 'INVALID_STATE: nothing to invoice' using errcode = 'P0001'; end if;

  select code into v_code from properties where id = b.property_id;
  v_year := extract(year from property_today(b.property_id))::integer;
  insert into invoice_sequences (property_id, year, last_number) values (b.property_id, v_year, 1)
  on conflict (property_id, year) do update set last_number = invoice_sequences.last_number + 1 returning last_number into v_n;
  v_number := 'INV-' || v_code || '-' || v_year || '-' || lpad(v_n::text, 6, '0');
  v_to := coalesce(b.company, b.contact_name);

  insert into group_invoices (id, tenant_id, property_id, group_id, invoice_number, bill_to, bill_to_email, currency, subtotal_minor, tax_minor, total_minor, due_date, issued_by)
  values (v_inv, b.tenant_id, b.property_id, b.id, v_number, v_to, b.contact_email, v_cur, v_sub, v_tax, v_sub + v_tax, p_due, g.o_actor);
  insert into group_invoice_lines (tenant_id, property_id, group_invoice_id, reservation_id, booking_reference, guest_name, arrival_date, departure_date, net_minor, tax_minor, line_total_minor)
  select b.tenant_id, b.property_id, v_inv, x.reservation_id, x.booking_reference, x.guest_name, x.arrival_date, x.departure_date, x.net_minor, x.tax_minor, x.net_minor + x.tax_minor
    from jsonb_to_recordset(v_lines) as x(reservation_id uuid, booking_reference text, guest_name text, arrival_date date, departure_date date, net_minor bigint, tax_minor bigint);

  v_result := jsonb_build_object('group_invoice_id', v_inv, 'invoice_number', v_number, 'status', 'issued', 'total_minor', v_sub + v_tax, 'line_count', v_count);
  perform idem_finish(g.o_tenant, 'issue_group_invoice', p_key, v_result);
  perform write_audit(g.o_tenant, b.property_id, g.o_actor, 'group_invoice.issued', 'group_invoice', v_inv, p_key,
                      jsonb_build_object('invoice_number', v_number, 'total_minor', v_sub + v_tax, 'group_id', b.id, 'line_count', v_count));
  return v_result;
end $$;

create function void_group_invoice(p_invoice uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare i group_invoices%rowtype; v_actor uuid; v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  select * into i from group_invoices where id = p_invoice for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  perform group_guard(i.property_id);
  v_actor := require_permission(i.property_id, 'invoice.void', 'NOT_FOUND');
  if v_reason is null or char_length(v_reason) > 200 then raise exception 'POLICY_VIOLATION: reason' using errcode = 'P0001'; end if;
  if i.invoice_status <> 'issued' then raise exception 'INVALID_STATE: %', i.invoice_status using errcode = 'P0001'; end if;
  update group_invoices set invoice_status = 'void', void_reason = v_reason, voided_at = now(), voided_by = v_actor where id = i.id;
  perform write_audit(i.tenant_id, i.property_id, v_actor, 'group_invoice.voided', 'group_invoice', i.id, null, jsonb_build_object('invoice_number', i.invoice_number));
end $$;

create function mark_group_invoice_paid(p_invoice uuid, p_method text, p_reference text) returns void
language plpgsql security definer set search_path = public as $$
declare i group_invoices%rowtype; v_actor uuid; v_ref text := nullif(btrim(coalesce(p_reference, '')), '');
begin
  select * into i from group_invoices where id = p_invoice for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  perform group_guard(i.property_id);
  v_actor := require_permission(i.property_id, 'payment.record', 'NOT_FOUND');
  if p_method is null or p_method not in ('cash', 'bank_transfer', 'pos', 'other') then raise exception 'POLICY_VIOLATION: method' using errcode = 'P0001'; end if;
  if v_ref is not null and char_length(v_ref) > 60 then raise exception 'POLICY_VIOLATION: reference' using errcode = 'P0001'; end if;
  if i.invoice_status <> 'issued' then raise exception 'INVALID_STATE: %', i.invoice_status using errcode = 'P0001'; end if;
  update group_invoices set invoice_status = 'paid', paid_at = now(), paid_by = v_actor, paid_method = p_method, paid_reference = v_ref where id = i.id;
  perform write_audit(i.tenant_id, i.property_id, v_actor, 'group_invoice.paid', 'group_invoice', i.id, null, jsonb_build_object('invoice_number', i.invoice_number, 'method', p_method));
end $$;

create function group_invoice_list(p_group uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare b group_bookings%rowtype;
begin
  select * into b from group_bookings where id = p_group;
  if not found or not has_permission(b.property_id, 'group.manage') or not can_view_money(b.property_id) then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', i.id, 'invoice_number', i.invoice_number, 'status', i.invoice_status, 'bill_to', i.bill_to, 'currency', i.currency,
      'subtotal_minor', i.subtotal_minor, 'tax_minor', i.tax_minor, 'total_minor', i.total_minor, 'due_date', i.due_date, 'issued_at', i.issued_at,
      'paid_at', i.paid_at, 'paid_method', i.paid_method, 'paid_reference', i.paid_reference, 'void_reason', i.void_reason,
      'lines', (select coalesce(jsonb_agg(jsonb_build_object('reservation_id', l.reservation_id, 'booking_reference', l.booking_reference, 'guest_name', l.guest_name,
                  'arrival_date', l.arrival_date, 'departure_date', l.departure_date, 'net_minor', l.net_minor, 'tax_minor', l.tax_minor, 'line_total_minor', l.line_total_minor)
                  order by l.arrival_date, l.booking_reference), '[]'::jsonb) from group_invoice_lines l where l.group_invoice_id = i.id))
      order by i.issued_at desc, i.id)
    from group_invoices i where i.group_id = b.id), '[]'::jsonb);
end $$;

do $$ declare f text; begin
  foreach f in array array['issue_group_invoice(uuid, date, text)', 'void_group_invoice(uuid, text)', 'mark_group_invoice_paid(uuid, text, text)', 'group_invoice_list(uuid)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
