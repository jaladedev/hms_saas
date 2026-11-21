-- 8.7 step ten: overdue reminders for group invoices.
-- A company account has an off-by-default switch remind_overdue (company_set_reminders: company.manage, audited). For a company with it on, an
-- issued (not paid, not void) group invoice that has an email address on it gets up to 3 reminder emails: the first the day after the due date
-- (in the hotel's own day), then one every 7 days while it stays unpaid. queue_group_invoice_reminders (system only, run by the maintenance job)
-- queues them into group_invoice_reminder_outbox, one row per invoice and reminder number, so running it again never doubles a reminder.
-- Delivery is the same claim / send / mark pattern as the waiting list emails (130). The reminder only tells the company what is owed and when it
-- was due; it never changes the invoice. A paid or void invoice that still has a queued reminder is not sent (claim skips it).

alter table company_accounts add column remind_overdue boolean not null default false;

create function company_set_reminders(p_company uuid, p_on boolean) returns void
language plpgsql security definer set search_path = public as $$
declare c company_accounts%rowtype; g record;
begin
  select * into c from company_accounts where id = p_company for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  select * into g from company_guard(c.property_id);
  if p_on is null then raise exception 'POLICY_VIOLATION: details' using errcode = 'P0001'; end if;
  if c.remind_overdue = p_on then return; end if;
  update company_accounts set remind_overdue = p_on where id = c.id;
  perform write_audit(g.o_tenant, c.property_id, g.o_actor, 'company.reminders_set', 'company', c.id, null, jsonb_build_object('remind_overdue', p_on));
end $$;
revoke all on function company_set_reminders(uuid, boolean) from public, anon;
grant execute on function company_set_reminders(uuid, boolean) to authenticated;

create table group_invoice_reminder_outbox (
  id              uuid primary key default gen_random_uuid(),
  invoice_id      uuid not null references group_invoices(id) on delete cascade,
  reminder_no     smallint not null check (reminder_no between 1 and 3),
  tenant_id       uuid not null references tenants(id),
  property_id     uuid not null references properties(id),
  to_email        text not null,
  payload         jsonb not null,
  status          text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed')),
  attempts        integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  sent_at         timestamptz,
  unique (invoice_id, reminder_no)
);
create index group_invoice_reminder_due on group_invoice_reminder_outbox (next_attempt_at) where status in ('pending', 'sending');
alter table group_invoice_reminder_outbox enable row level security;   -- no policy: server only
revoke all on group_invoice_reminder_outbox from authenticated, anon;

create function queue_group_invoice_reminders(p_limit integer default 100) returns integer
language plpgsql security definer set search_path = public as $$
declare r record; v_queued integer := 0; v_next smallint;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  for r in
    select i.id, i.tenant_id, i.property_id, i.invoice_number, i.bill_to, i.bill_to_email, i.currency, i.total_minor, i.due_date,
           p.name as hotel, p.phone as hotel_phone, p.contact_email as hotel_email, property_today(i.property_id) as today,
           (select count(*) from group_invoice_reminder_outbox o where o.invoice_id = i.id) as sent_count
      from group_invoices i
      join group_bookings b on b.id = i.group_id
      join company_accounts c on c.id = b.company_id and c.remind_overdue
      join properties p on p.id = i.property_id
     where i.invoice_status = 'issued' and btrim(coalesce(i.bill_to_email, '')) <> ''
       and i.due_date < property_today(i.property_id)
       and (select count(*) from group_invoice_reminder_outbox o where o.invoice_id = i.id) < 3
     order by i.due_date, i.id
     limit greatest(least(coalesce(p_limit, 100), 500), 1)
  loop
    v_next := r.sent_count + 1;
    -- reminder 1 the day after the due date, then every 7 days
    continue when r.today <= r.due_date + ((v_next - 1) * 7);
    insert into group_invoice_reminder_outbox (invoice_id, reminder_no, tenant_id, property_id, to_email, payload)
    values (r.id, v_next, r.tenant_id, r.property_id, btrim(r.bill_to_email),
            jsonb_build_object('hotel', r.hotel, 'hotel_phone', r.hotel_phone, 'hotel_email', r.hotel_email, 'bill_to', r.bill_to,
                               'invoice_number', r.invoice_number, 'total_minor', r.total_minor, 'currency', r.currency,
                               'due_date', r.due_date, 'days_overdue', r.today - r.due_date, 'reminder_no', v_next))
    on conflict (invoice_id, reminder_no) do nothing;
    if found then v_queued := v_queued + 1; end if;
  end loop;
  return v_queued;
end $$;
revoke all on function queue_group_invoice_reminders(integer) from public, anon, authenticated;
grant execute on function queue_group_invoice_reminders(integer) to service_role;

create function claim_group_invoice_reminders(p_limit integer default 10) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_out jsonb;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then raise exception 'POLICY_VIOLATION: limit' using errcode = 'P0001'; end if;
  -- an invoice paid or voided since the reminder was queued is closed out, not sent
  update group_invoice_reminder_outbox o set status = 'failed', last_error = 'invoice no longer open', updated_at = now()
   where o.status = 'pending' and exists (select 1 from group_invoices i where i.id = o.invoice_id and i.invoice_status <> 'issued');
  with picked as (
    select id from group_invoice_reminder_outbox
     where attempts < 5
       and ((status = 'pending' and next_attempt_at <= now()) or (status = 'sending' and updated_at < now() - interval '10 minutes'))
     order by next_attempt_at, created_at
     limit p_limit
     for update skip locked),
  claimed as (
    update group_invoice_reminder_outbox d set status = 'sending', attempts = d.attempts + 1, updated_at = now()
      from picked where d.id = picked.id
    returning d.id, d.to_email, d.payload, d.attempts)
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'to_email', c.to_email, 'payload', c.payload, 'attempt', c.attempts) order by c.attempts, c.id), '[]'::jsonb)
    into v_out from claimed c;
  return v_out;
end $$;
revoke all on function claim_group_invoice_reminders(integer) from public, anon, authenticated;
grant execute on function claim_group_invoice_reminders(integer) to service_role;

create function mark_group_invoice_reminder_result(p_id uuid, p_ok boolean, p_error text default null) returns void
language plpgsql security definer set search_path = public as $$
declare d group_invoice_reminder_outbox%rowtype;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select * into d from group_invoice_reminder_outbox where id = p_id for update;
  if not found or d.status <> 'sending' then return; end if;
  if p_ok then
    update group_invoice_reminder_outbox set status = 'sent', sent_at = now(), last_error = null, updated_at = now() where id = p_id;
  elsif d.attempts >= 5 then
    update group_invoice_reminder_outbox set status = 'failed', last_error = left(coalesce(p_error, 'failed'), 500), updated_at = now() where id = p_id;
  else
    update group_invoice_reminder_outbox set status = 'pending', last_error = left(coalesce(p_error, 'failed'), 500),
           next_attempt_at = now() + (d.attempts * interval '5 minutes'), updated_at = now() where id = p_id;
  end if;
end $$;
revoke all on function mark_group_invoice_reminder_result(uuid, boolean, text) from public, anon, authenticated;
grant execute on function mark_group_invoice_reminder_result(uuid, boolean, text) to service_role;

-- company_list again, with the switch.
create or replace function company_list(p_property uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not (has_permission(p_property, 'group.manage') or has_permission(p_property, 'company.manage')) then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'billing_contact', c.billing_contact, 'billing_email', c.billing_email,
           'billing_phone', c.billing_phone, 'credit_days', c.credit_days, 'discount_percent', c.discount_percent, 'status', c.status, 'notes', c.notes,
           'groups', (select count(*) from group_bookings b where b.company_id = c.id),
           'credit_limit_minor', c.credit_limit_minor, 'auto_apply_rate', c.auto_apply_rate, 'remind_overdue', c.remind_overdue,
           'rates', (select coalesce(jsonb_agg(jsonb_build_object('room_type_id', rr.room_type_id, 'room_type_name', t.name, 'mode', rr.mode,
                                'nightly_rate_minor', rr.nightly_rate_minor, 'percent', rr.percent) order by t.name), '[]'::jsonb)
                       from company_room_rates rr join room_types t on t.id = rr.room_type_id where rr.company_id = c.id),
           'exposure_minor', (select coalesce(sum(i.total_minor), 0) from group_invoices i join group_bookings b on b.id = i.group_id where b.company_id = c.id and i.invoice_status = 'issued'),
           'overdue_minor', (select coalesce(sum(i.total_minor), 0) from group_invoices i join group_bookings b on b.id = i.group_id
                              where b.company_id = c.id and i.invoice_status = 'issued' and i.due_date < property_today(c.property_id))) order by (c.status = 'active') desc, lower(c.name))
         from company_accounts c where c.property_id = p_property), '[]'::jsonb);
end $$;
revoke all on function company_list(uuid) from public, anon;
grant execute on function company_list(uuid) to authenticated;
