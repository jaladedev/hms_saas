-- 155 Group bookings, step four (TODO 8.7): company accounts with credit terms and an agreed corporate rate.
--
-- A company account is a standing record per hotel: who to bill, how many days the company has to pay (credit terms) and an agreed discount
-- percent (the corporate rate). A group can be attached to one. Effects, and only these:
--   * The group invoice (154) bills the company account's name and email, and the screen suggests a due date of today plus the credit days.
--     Credit terms are a SUGGESTION for the due date; nothing blocks a booking or a check-in when a company is late. A credit LIMIT and
--     blocking on overdue invoices are not built.
--   * apply_company_rate_to_group sets the company's agreed percent as the discount on the group's linked bookings, through the same columns
--     and the same guards as apply_discount (058): only a confirmed booking with no money on it, no live invoice and no payment in progress.
--     A booking that already has a discount, or is not eligible, is skipped, never replaced. The role caps of 058 do not apply because the
--     rate was approved when the company account was set up (company.manage: owner and general manager); applying it needs group.manage.
--     Changing the rate later does not change discounts already applied.
--   * Permission company.manage (owner, general manager) creates and changes accounts; group.manage can read them and attach one.
--   * The group_bookings flag covers all of it. Everything is audited.
-- Also fixed here: a group invoice line whose booking had a discount above about 93% would have had a negative net; the line now shows
-- net = total - tax with the tax capped at the total, so net and tax are never negative and always add up to the booking's total.

insert into permissions (key) values ('company.manage');
insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r, permissions p where p.key = 'company.manage' and r.key in ('owner', 'general_manager');

create table company_accounts (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null,
  property_id      uuid not null,
  name             text not null check (char_length(name) between 1 and 80),
  billing_contact  text not null check (char_length(billing_contact) between 1 and 80),
  billing_email    text check (billing_email is null or (char_length(billing_email) between 3 and 120 and billing_email like '%_@_%')),
  billing_phone    text check (billing_phone is null or char_length(billing_phone) between 3 and 30),
  credit_days      integer not null default 0 check (credit_days between 0 and 90),
  discount_percent numeric(5, 2) not null default 0 check (discount_percent >= 0 and discount_percent <= 50),
  status           text not null default 'active' check (status in ('active', 'archived')),
  notes            text check (notes is null or char_length(notes) <= 500),
  created_by       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  foreign key (tenant_id, property_id) references properties (tenant_id, id),
  unique (id, property_id)
);
create unique index company_accounts_name_uniq on company_accounts (property_id, lower(name));
alter table company_accounts enable row level security;
create policy company_accounts_select on company_accounts for select to authenticated
  using (has_permission(property_id, 'group.manage') or has_permission(property_id, 'company.manage'));
revoke insert, update, delete on company_accounts from authenticated, anon;
create trigger company_accounts_updated before update on company_accounts for each row execute function set_updated_at();

alter table group_bookings add column company_id uuid;
alter table group_bookings add constraint group_bookings_company_fk foreign key (company_id, property_id) references company_accounts (id, property_id);

create function company_guard(p_property uuid, out o_tenant uuid, out o_actor uuid) returns record
language plpgsql security definer set search_path = public as $$
begin
  select tenant_id into o_tenant from properties where id = p_property;
  if o_tenant is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  o_actor := require_permission(p_property, 'company.manage', 'NOT_FOUND');
  if o_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if not tenant_feature_on(o_tenant, 'group_bookings') then raise exception 'POLICY_VIOLATION: group bookings off' using errcode = 'P0001'; end if;
end $$;
revoke all on function company_guard(uuid) from public, anon, authenticated;

create function company_create(p_property uuid, p_name text, p_contact text, p_email text, p_phone text, p_credit_days integer, p_percent numeric, p_notes text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g record; v_name text := btrim(coalesce(p_name, '')); v_contact text := btrim(coalesce(p_contact, '')); v_email text := nullif(btrim(coalesce(p_email, '')), '');
  v_phone text := nullif(btrim(coalesce(p_phone, '')), ''); v_notes text := nullif(btrim(coalesce(p_notes, '')), ''); v_id uuid;
begin
  select * into g from company_guard(p_property);
  if char_length(v_name) not between 1 and 80 or char_length(v_contact) not between 1 and 80 or (v_email is not null and (char_length(v_email) > 120 or v_email not like '%_@_%'))
     or (v_phone is not null and char_length(v_phone) not between 3 and 30) or (v_notes is not null and char_length(v_notes) > 500)
     or p_credit_days is null or p_credit_days not between 0 and 90 or p_percent is null or p_percent < 0 or p_percent > 50 or p_percent <> round(p_percent, 2) then
    raise exception 'POLICY_VIOLATION: details' using errcode = 'P0001';
  end if;
  if exists (select 1 from company_accounts where property_id = p_property and lower(name) = lower(v_name)) then raise exception 'POLICY_VIOLATION: name taken' using errcode = 'P0001'; end if;
  insert into company_accounts (tenant_id, property_id, name, billing_contact, billing_email, billing_phone, credit_days, discount_percent, notes, created_by)
  values (g.o_tenant, p_property, v_name, v_contact, v_email, v_phone, p_credit_days, p_percent, v_notes, g.o_actor) returning id into v_id;
  perform write_audit(g.o_tenant, p_property, g.o_actor, 'company.created', 'company', v_id, null, jsonb_build_object('name', v_name, 'credit_days', p_credit_days, 'discount_percent', p_percent));
  return jsonb_build_object('company_id', v_id);
end $$;

create function company_update(p_company uuid, p_contact text, p_email text, p_phone text, p_credit_days integer, p_percent numeric, p_notes text, p_status text) returns void
language plpgsql security definer set search_path = public as $$
declare c company_accounts%rowtype; g record; v_contact text := btrim(coalesce(p_contact, '')); v_email text := nullif(btrim(coalesce(p_email, '')), '');
  v_phone text := nullif(btrim(coalesce(p_phone, '')), ''); v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
begin
  select * into c from company_accounts where id = p_company for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  select * into g from company_guard(c.property_id);
  if char_length(v_contact) not between 1 and 80 or (v_email is not null and (char_length(v_email) > 120 or v_email not like '%_@_%'))
     or (v_phone is not null and char_length(v_phone) not between 3 and 30) or (v_notes is not null and char_length(v_notes) > 500)
     or p_credit_days is null or p_credit_days not between 0 and 90 or p_percent is null or p_percent < 0 or p_percent > 50 or p_percent <> round(p_percent, 2)
     or p_status is null or p_status not in ('active', 'archived') then
    raise exception 'POLICY_VIOLATION: details' using errcode = 'P0001';
  end if;
  update company_accounts set billing_contact = v_contact, billing_email = v_email, billing_phone = v_phone, credit_days = p_credit_days,
         discount_percent = p_percent, notes = v_notes, status = p_status where id = c.id;
  perform write_audit(g.o_tenant, c.property_id, g.o_actor, 'company.updated', 'company', c.id, null,
                      jsonb_build_object('from_percent', c.discount_percent, 'to_percent', p_percent, 'from_credit_days', c.credit_days, 'to_credit_days', p_credit_days, 'status', p_status));
end $$;

create function company_list(p_property uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not (has_permission(p_property, 'group.manage') or has_permission(p_property, 'company.manage')) then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'billing_contact', c.billing_contact, 'billing_email', c.billing_email,
           'billing_phone', c.billing_phone, 'credit_days', c.credit_days, 'discount_percent', c.discount_percent, 'status', c.status, 'notes', c.notes,
           'groups', (select count(*) from group_bookings b where b.company_id = c.id)) order by (c.status = 'active') desc, lower(c.name))
         from company_accounts c where c.property_id = p_property), '[]'::jsonb);
end $$;

create function set_group_company(p_group uuid, p_company uuid) returns void
language plpgsql security definer set search_path = public as $$
declare b group_bookings%rowtype; g record; c company_accounts%rowtype;
begin
  select * into b from group_bookings where id = p_group for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  select * into g from group_guard(b.property_id);
  if b.status = 'cancelled' then raise exception 'INVALID_STATE: cancelled' using errcode = 'P0001'; end if;
  if p_company is not null then
    select * into c from company_accounts where id = p_company and property_id = b.property_id and status = 'active';
    if not found then raise exception 'POLICY_VIOLATION: company' using errcode = 'P0001'; end if;
  end if;
  update group_bookings set company_id = p_company where id = b.id;
  perform write_audit(g.o_tenant, b.property_id, g.o_actor, 'group.company_set', 'group', b.id, null, jsonb_build_object('company_id', p_company));
end $$;

create function apply_company_rate_to_group(p_group uuid, p_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b group_bookings%rowtype; g record; c company_accounts%rowtype; v_idem record; v_applied integer := 0; v_skipped integer := 0; r reservations%rowtype; v_new bigint; v_result jsonb;
begin
  select * into b from group_bookings where id = p_group;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  select * into g from group_guard(b.property_id);
  if b.status = 'cancelled' then raise exception 'INVALID_STATE: cancelled' using errcode = 'P0001'; end if;
  select * into v_idem from idem_begin(g.o_tenant, 'apply_company_rate', p_key, md5(p_group::text));
  if not v_idem.out_is_new then return v_idem.out_response; end if;

  select * into b from group_bookings where id = p_group for update;
  select * into c from company_accounts where id = b.company_id;
  if not found or c.discount_percent <= 0 then raise exception 'POLICY_VIOLATION: no company rate' using errcode = 'P0001'; end if;

  for r in select v.* from group_rooming gr join reservations v on v.id = gr.reservation_id where gr.group_id = b.id order by v.created_at, v.id for update of v loop
    if r.reservation_status <> 'confirmed' or r.discount_minor > 0
       or exists (select 1 from payments where reservation_id = r.id)
       or exists (select 1 from invoices where reservation_id = r.id and invoice_status <> 'void')
       or exists (select 1 from payment_attempts where reservation_id = r.id and status = 'initiated') then
      v_skipped := v_skipped + 1;
    else
      v_new := round((r.subtotal_minor + r.tax_minor) * c.discount_percent / 100)::bigint;
      update reservations set discount_minor = v_new, discount_percent = c.discount_percent, discount_reason = left('Company rate: ' || c.name, 200),
             total_minor = subtotal_minor + tax_minor - v_new where id = r.id;
      perform write_audit(g.o_tenant, b.property_id, g.o_actor, 'reservation.company_rate_applied', 'reservation', r.id, p_key,
                          jsonb_build_object('company', c.name, 'percent', c.discount_percent, 'discount_minor', v_new, 'group_id', b.id));
      v_applied := v_applied + 1;
    end if;
  end loop;
  v_result := jsonb_build_object('applied', v_applied, 'skipped', v_skipped, 'percent', c.discount_percent);
  perform idem_finish(g.o_tenant, 'apply_company_rate', p_key, v_result);
  perform write_audit(g.o_tenant, b.property_id, g.o_actor, 'group.company_rate_applied', 'group', b.id, p_key, v_result);
  return v_result;
end $$;

-- group_detail again, with the company account.
create or replace function group_detail(p_group uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare b group_bookings%rowtype;
begin
  select * into b from group_bookings where id = p_group;
  if not found or not has_permission(b.property_id, 'group.manage') then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  return jsonb_build_object(
    'id', b.id, 'property_id', b.property_id, 'name', b.name, 'company', b.company, 'contact_name', b.contact_name, 'contact_phone', b.contact_phone,
    'contact_email', b.contact_email, 'arrival_date', b.arrival_date, 'departure_date', b.departure_date, 'release_date', b.release_date,
    'status', b.status, 'notes', b.notes, 'company_id', b.company_id, 'company_account', (select ca.name from company_accounts ca where ca.id = b.company_id),
    'rooms', coalesce((
      select jsonb_agg(jsonb_build_object('room_type_id', x.room_type_id, 'room_type_name', x.name, 'held', x.held, 'used', x.used, 'released', x.released) order by x.name)
        from (select t.id as room_type_id, t.name, count(*) filter (where u.status = 'held') as held, count(*) filter (where u.status = 'used') as used,
                     count(*) filter (where u.status = 'released') as released
                from group_block_units u join room_types t on t.id = u.room_type_id where u.group_id = b.id group by t.id, t.name) x), '[]'::jsonb),
    'rooming', coalesce((
      select jsonb_agg(jsonb_build_object('id', r.id, 'guest_name', r.guest_name, 'room_type_id', r.room_type_id, 'room_type_name', t.name, 'notes', r.notes,
               'reservation_id', r.reservation_id, 'booking_reference', v.booking_reference, 'reservation_status', v.reservation_status) order by r.created_at, r.id)
        from group_rooming r left join room_types t on t.id = r.room_type_id left join reservations v on v.id = r.reservation_id
       where r.group_id = b.id), '[]'::jsonb));
end $$;

-- issue_group_invoice again: bills the company account and never writes a negative net.
create or replace function issue_group_invoice(p_group uuid, p_due date, p_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  b group_bookings%rowtype; g record; v_idem record; v_inv uuid := gen_random_uuid(); v_code text; v_year integer; v_n integer; v_number text;
  v_sub bigint; v_tax bigint; v_count integer; v_cur text; v_result jsonb; v_to text; v_lines jsonb; v_co_name text; v_co_email text;
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


do $$ declare f text; begin
  foreach f in array array[
    'company_create(uuid, text, text, text, text, integer, numeric, text)', 'company_update(uuid, text, text, text, integer, numeric, text, text)',
    'company_list(uuid)', 'set_group_company(uuid, uuid)', 'apply_company_rate_to_group(uuid, text)', 'group_detail(uuid)', 'issue_group_invoice(uuid, date, text)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
