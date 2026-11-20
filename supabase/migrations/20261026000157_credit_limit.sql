-- 157 Group bookings, step seven (TODO 8.7): a credit limit on a company account, and an overdue list.
--
--   * company_accounts.credit_limit_minor: empty means no limit. A company's EXPOSURE is the total of its issued (neither paid nor void) group
--     invoices (154). issue_group_invoice refuses a new invoice that would take the exposure above the limit (POLICY_VIOLATION: credit limit <room
--     left>). The company row is locked while checking, so two invoices cannot both slip under it. Raising the limit is a company.manage action
--     (owner, general manager), audited with the old and new limit. Only group invoices count: a booking's own folio is not part of the exposure.
--   * An invoice is OVERDUE when it is issued and its due date is before the hotel's today. group_invoice_overdue lists them (group.manage and the
--     right to see money). company_list now also returns each company's limit, exposure and overdue amount.
--   * Nothing else is blocked for a late company: bookings, check-in and payments carry on. Credit days still only suggest a due date.
-- company_create and company_update take the new limit parameter, so the old signatures are dropped.

alter table company_accounts add column credit_limit_minor bigint check (credit_limit_minor is null or (credit_limit_minor >= 1 and credit_limit_minor <= 1000000000000));

drop function company_create(uuid, text, text, text, text, integer, numeric, text);
drop function company_update(uuid, text, text, text, integer, numeric, text, text);

create function company_create(p_property uuid, p_name text, p_contact text, p_email text, p_phone text, p_credit_days integer, p_percent numeric, p_notes text, p_credit_limit_minor bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g record; v_name text := btrim(coalesce(p_name, '')); v_contact text := btrim(coalesce(p_contact, '')); v_email text := nullif(btrim(coalesce(p_email, '')), '');
  v_phone text := nullif(btrim(coalesce(p_phone, '')), ''); v_notes text := nullif(btrim(coalesce(p_notes, '')), ''); v_id uuid;
begin
  select * into g from company_guard(p_property);
  if char_length(v_name) not between 1 and 80 or char_length(v_contact) not between 1 and 80 or (v_email is not null and (char_length(v_email) > 120 or v_email not like '%_@_%'))
     or (v_phone is not null and char_length(v_phone) not between 3 and 30) or (v_notes is not null and char_length(v_notes) > 500)
     or (p_credit_limit_minor is not null and (p_credit_limit_minor < 1 or p_credit_limit_minor > 1000000000000)) or p_credit_days is null or p_credit_days not between 0 and 90 or p_percent is null or p_percent < 0 or p_percent > 50 or p_percent <> round(p_percent, 2) then
    raise exception 'POLICY_VIOLATION: details' using errcode = 'P0001';
  end if;
  if exists (select 1 from company_accounts where property_id = p_property and lower(name) = lower(v_name)) then raise exception 'POLICY_VIOLATION: name taken' using errcode = 'P0001'; end if;
  insert into company_accounts (tenant_id, property_id, name, billing_contact, billing_email, billing_phone, credit_days, discount_percent, notes, credit_limit_minor, created_by)
  values (g.o_tenant, p_property, v_name, v_contact, v_email, v_phone, p_credit_days, p_percent, v_notes, p_credit_limit_minor, g.o_actor) returning id into v_id;
  perform write_audit(g.o_tenant, p_property, g.o_actor, 'company.created', 'company', v_id, null, jsonb_build_object('name', v_name, 'credit_days', p_credit_days, 'discount_percent', p_percent));
  return jsonb_build_object('company_id', v_id);
end $$;

create function company_update(p_company uuid, p_contact text, p_email text, p_phone text, p_credit_days integer, p_percent numeric, p_notes text, p_status text, p_credit_limit_minor bigint) returns void
language plpgsql security definer set search_path = public as $$
declare c company_accounts%rowtype; g record; v_contact text := btrim(coalesce(p_contact, '')); v_email text := nullif(btrim(coalesce(p_email, '')), '');
  v_phone text := nullif(btrim(coalesce(p_phone, '')), ''); v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
begin
  select * into c from company_accounts where id = p_company for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  select * into g from company_guard(c.property_id);
  if char_length(v_contact) not between 1 and 80 or (v_email is not null and (char_length(v_email) > 120 or v_email not like '%_@_%'))
     or (v_phone is not null and char_length(v_phone) not between 3 and 30) or (v_notes is not null and char_length(v_notes) > 500)
     or (p_credit_limit_minor is not null and (p_credit_limit_minor < 1 or p_credit_limit_minor > 1000000000000)) or p_credit_days is null or p_credit_days not between 0 and 90 or p_percent is null or p_percent < 0 or p_percent > 50 or p_percent <> round(p_percent, 2)
     or p_status is null or p_status not in ('active', 'archived') then
    raise exception 'POLICY_VIOLATION: details' using errcode = 'P0001';
  end if;
  update company_accounts set billing_contact = v_contact, billing_email = v_email, billing_phone = v_phone, credit_days = p_credit_days,
         discount_percent = p_percent, notes = v_notes, status = p_status, credit_limit_minor = p_credit_limit_minor where id = c.id;
  perform write_audit(g.o_tenant, c.property_id, g.o_actor, 'company.updated', 'company', c.id, null,
                      jsonb_build_object('from_percent', c.discount_percent, 'to_percent', p_percent, 'from_credit_days', c.credit_days, 'to_credit_days', p_credit_days, 'status', p_status, 'from_limit', c.credit_limit_minor, 'to_limit', p_credit_limit_minor));
end $$;

-- company_list again, with the limit and what is owed.
create or replace function company_list(p_property uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not (has_permission(p_property, 'group.manage') or has_permission(p_property, 'company.manage')) then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'billing_contact', c.billing_contact, 'billing_email', c.billing_email,
           'billing_phone', c.billing_phone, 'credit_days', c.credit_days, 'discount_percent', c.discount_percent, 'status', c.status, 'notes', c.notes,
           'groups', (select count(*) from group_bookings b where b.company_id = c.id),
           'credit_limit_minor', c.credit_limit_minor,
           'exposure_minor', (select coalesce(sum(i.total_minor), 0) from group_invoices i join group_bookings b on b.id = i.group_id where b.company_id = c.id and i.invoice_status = 'issued'),
           'overdue_minor', (select coalesce(sum(i.total_minor), 0) from group_invoices i join group_bookings b on b.id = i.group_id
                              where b.company_id = c.id and i.invoice_status = 'issued' and i.due_date < property_today(c.property_id))) order by (c.status = 'active') desc, lower(c.name))
         from company_accounts c where c.property_id = p_property), '[]'::jsonb);
end $$;

-- issue_group_invoice again, with the credit limit check.
create or replace function issue_group_invoice(p_group uuid, p_due date, p_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  b group_bookings%rowtype; g record; v_idem record; v_inv uuid := gen_random_uuid(); v_code text; v_year integer; v_n integer; v_number text;
  v_sub bigint; v_tax bigint; v_count integer; v_cur text; v_result jsonb; v_to text; v_lines jsonb; v_co_name text; v_co_email text; v_limit bigint; v_exposure bigint;
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
                    'arrival_date', v.arrival_date, 'departure_date', v.departure_date, 'net_minor', v.total_minor - least(v.tax_minor, v.total_minor),
                    'tax_minor', least(v.tax_minor, v.total_minor), 'currency', v.currency) order by v.arrival_date, v.booking_reference), '[]'::jsonb)
    into v_lines
    from group_rooming r join reservations v on v.id = r.reservation_id join guests gu on gu.id = v.primary_guest_id
   where r.group_id = b.id and v.reservation_status in ('confirmed', 'checked_in', 'checked_out') and v.total_minor > 0
     and not exists (select 1 from group_invoice_lines l join group_invoices i on i.id = l.group_invoice_id where l.reservation_id = v.id and i.invoice_status <> 'void');
  select count(*), coalesce(sum(x.net_minor), 0), coalesce(sum(x.tax_minor), 0), max(x.currency)
    into v_count, v_sub, v_tax, v_cur
    from jsonb_to_recordset(v_lines) as x(net_minor bigint, tax_minor bigint, currency text);
  if v_count = 0 then raise exception 'INVALID_STATE: nothing to invoice' using errcode = 'P0001'; end if;
  if b.company_id is not null then
    perform 1 from company_accounts where id = b.company_id for update;   -- two invoices for one company cannot both slip under the limit
    select credit_limit_minor into v_limit from company_accounts where id = b.company_id;
    if v_limit is not null then
      select coalesce(sum(i.total_minor), 0) into v_exposure
        from group_invoices i join group_bookings gb on gb.id = i.group_id where gb.company_id = b.company_id and i.invoice_status = 'issued';
      if v_exposure + v_sub + v_tax > v_limit then raise exception 'POLICY_VIOLATION: credit limit %', greatest(v_limit - v_exposure, 0) using errcode = 'P0001'; end if;
    end if;
  end if;

  select code into v_code from properties where id = b.property_id;
  v_year := extract(year from property_today(b.property_id))::integer;
  insert into invoice_sequences (property_id, year, last_number) values (b.property_id, v_year, 1)
  on conflict (property_id, year) do update set last_number = invoice_sequences.last_number + 1 returning last_number into v_n;
  v_number := 'INV-' || v_code || '-' || v_year || '-' || lpad(v_n::text, 6, '0');
  select ca.name, ca.billing_email into v_co_name, v_co_email from company_accounts ca where ca.id = b.company_id;
  v_to := coalesce(v_co_name, b.company, b.contact_name);

  insert into group_invoices (id, tenant_id, property_id, group_id, invoice_number, bill_to, bill_to_email, currency, subtotal_minor, tax_minor, total_minor, due_date, issued_by)
  values (v_inv, b.tenant_id, b.property_id, b.id, v_number, v_to, coalesce(v_co_email, b.contact_email), v_cur, v_sub, v_tax, v_sub + v_tax, p_due, g.o_actor);
  insert into group_invoice_lines (tenant_id, property_id, group_invoice_id, reservation_id, booking_reference, guest_name, arrival_date, departure_date, net_minor, tax_minor, line_total_minor)
  select b.tenant_id, b.property_id, v_inv, x.reservation_id, x.booking_reference, x.guest_name, x.arrival_date, x.departure_date, x.net_minor, x.tax_minor, x.net_minor + x.tax_minor
    from jsonb_to_recordset(v_lines) as x(reservation_id uuid, booking_reference text, guest_name text, arrival_date date, departure_date date, net_minor bigint, tax_minor bigint);

  v_result := jsonb_build_object('group_invoice_id', v_inv, 'invoice_number', v_number, 'status', 'issued', 'total_minor', v_sub + v_tax, 'line_count', v_count);
  perform idem_finish(g.o_tenant, 'issue_group_invoice', p_key, v_result);
  perform write_audit(g.o_tenant, b.property_id, g.o_actor, 'group_invoice.issued', 'group_invoice', v_inv, p_key,
                      jsonb_build_object('invoice_number', v_number, 'total_minor', v_sub + v_tax, 'group_id', b.id, 'line_count', v_count));
  return v_result;
end $$;



create function group_invoice_overdue(p_property uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_today date := property_today(p_property);
begin
  if not has_permission(p_property, 'group.manage') or not can_view_money(p_property) then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'invoice_id', i.id, 'invoice_number', i.invoice_number, 'group_id', b.id, 'group_name', b.name, 'bill_to', i.bill_to, 'currency', i.currency,
      'total_minor', i.total_minor, 'due_date', i.due_date, 'days_overdue', v_today - i.due_date) order by i.due_date, i.invoice_number)
    from group_invoices i join group_bookings b on b.id = i.group_id
   where i.property_id = p_property and i.invoice_status = 'issued' and i.due_date < v_today), '[]'::jsonb);
end $$;

do $$ declare f text; begin
  foreach f in array array[
    'company_create(uuid, text, text, text, text, integer, numeric, text, bigint)', 'company_update(uuid, text, text, text, integer, numeric, text, text, bigint)',
    'company_list(uuid)', 'issue_group_invoice(uuid, date, text)', 'group_invoice_overdue(uuid)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
