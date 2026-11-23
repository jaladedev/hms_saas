-- 186 Overdue reminders for the invoices the platform raises to hotel groups (the leftover of "enforce more flags: automatic reminders to hotels").
-- Until now /platform/invoices was a list to chase by hand. Same shape as the group invoice reminders (166), for platform_invoices (098):
--   tenants.billing_email and tenants.remind_overdue_invoices (off by default). A platform admin sets both with platform_set_billing_contact (audited,
--   admin only); the switch cannot be on without an address, and an address is checked for a plausible shape (one @, a dot after it, no spaces, 200 at most).
--   For a group with it on, an open invoice with a due date before today (the platform's day is Africa/Lagos) gets up to 3 reminders: the first the day
--   after the due date, then one every 7 days while it is open. queue_platform_invoice_reminders (system only, in the maintenance job) queues one row per
--   invoice and reminder number, so it never doubles. A group that is closed gets none; a suspended one still does.
--   Delivery: claim, send, mark with retries, like 166. At claim time a reminder for an invoice that is no longer open, or for a group whose switch went
--   off or whose address was removed, is closed out and not sent; one still to go is sent to the address the group has NOW.
-- The email only states the invoice, amount, due date and how to reach the platform; it charges nothing. What was sent is read with
-- platform_billing_reminders(tenant) (support or admin) and as reminder_info on platform_open_invoices (116). Neither returns the address of a
-- reminder or the internal error text; platform_billing_reminders returns the group's own billing address for the admin's form.
-- NOT built: reminders by SMS or chat, automatic suspension of a group that does not pay, a reminder sent to the hotel's own users.

alter table tenants add column billing_email text
  check (billing_email is null or (char_length(billing_email) <= 200 and billing_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'));
alter table tenants add column remind_overdue_invoices boolean not null default false;
alter table tenants add constraint tenants_remind_needs_email check (not remind_overdue_invoices or billing_email is not null);

create function platform_set_billing_contact(p_tenant uuid, p_email text, p_remind boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid; t tenants%rowtype; v_email text := nullif(btrim(coalesce(p_email, '')), '');
begin
  v_uid := platform_require('admin');
  if p_remind is null then raise exception 'POLICY_VIOLATION: details' using errcode = 'P0001'; end if;
  if v_email is not null and (char_length(v_email) > 200 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') then raise exception 'POLICY_VIOLATION: billing email' using errcode = 'P0001'; end if;
  if p_remind and v_email is null then raise exception 'POLICY_VIOLATION: billing email' using errcode = 'P0001'; end if;
  select * into t from tenants where id = p_tenant for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if t.billing_email is not distinct from v_email and t.remind_overdue_invoices = p_remind then return jsonb_build_object('changed', false); end if;
  update tenants set billing_email = v_email, remind_overdue_invoices = p_remind where id = p_tenant;
  perform write_audit(p_tenant, null, v_uid, 'platform.billing_contact_set', 'tenant', p_tenant, null,
    jsonb_build_object('had_email', t.billing_email is not null, 'has_email', v_email is not null, 'remind_from', t.remind_overdue_invoices, 'remind_to', p_remind));
  return jsonb_build_object('changed', true);
end $$;
revoke all on function platform_set_billing_contact(uuid, text, boolean) from public, anon;
grant execute on function platform_set_billing_contact(uuid, text, boolean) to authenticated;

create table platform_invoice_reminder_outbox (
  id              uuid primary key default gen_random_uuid(),
  invoice_id      uuid not null references platform_invoices(id) on delete cascade,
  reminder_no     smallint not null check (reminder_no between 1 and 3),
  tenant_id       uuid not null references tenants(id),
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
create index platform_invoice_reminder_due on platform_invoice_reminder_outbox (next_attempt_at) where status in ('pending', 'sending');
alter table platform_invoice_reminder_outbox enable row level security;   -- no policy: server only
revoke all on platform_invoice_reminder_outbox from authenticated, anon;

create function queue_platform_invoice_reminders(p_limit integer default 100) returns integer
language plpgsql security definer set search_path = public as $$
declare r record; v_queued integer := 0; v_next smallint; v_today date := (now() at time zone 'Africa/Lagos')::date;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  for r in
    select i.id, i.tenant_id, i.number, i.amount_minor, i.currency, i.due_date, i.period_start, i.period_end, t.name as tenant_name, t.billing_email,
           (select count(*) from platform_invoice_reminder_outbox o where o.invoice_id = i.id) as queued_count
      from platform_invoices i
      join tenants t on t.id = i.tenant_id and t.remind_overdue_invoices and t.billing_email is not null and t.status <> 'closed'
     where i.status = 'open' and i.due_date is not null and i.due_date < v_today
       and (select count(*) from platform_invoice_reminder_outbox o where o.invoice_id = i.id) < 3
     order by i.due_date, i.id
     limit greatest(least(coalesce(p_limit, 100), 500), 1)
  loop
    v_next := r.queued_count + 1;
    -- reminder 1 the day after the due date, then every 7 days
    continue when v_today <= r.due_date + ((v_next - 1) * 7);
    insert into platform_invoice_reminder_outbox (invoice_id, reminder_no, tenant_id, to_email, payload)
    values (r.id, v_next, r.tenant_id, r.billing_email,
            jsonb_build_object('tenant_name', r.tenant_name, 'invoice_number', r.number, 'amount_minor', r.amount_minor, 'currency', r.currency,
                               'due_date', r.due_date, 'period_start', r.period_start, 'period_end', r.period_end, 'days_overdue', v_today - r.due_date, 'reminder_no', v_next))
    on conflict (invoice_id, reminder_no) do nothing;
    if found then v_queued := v_queued + 1; end if;
  end loop;
  return v_queued;
end $$;
revoke all on function queue_platform_invoice_reminders(integer) from public, anon, authenticated;
grant execute on function queue_platform_invoice_reminders(integer) to service_role;

create function claim_platform_invoice_reminders(p_limit integer default 10) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_out jsonb;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then raise exception 'POLICY_VIOLATION: limit' using errcode = 'P0001'; end if;
  -- an invoice paid or voided since the reminder was queued is closed out, not sent
  update platform_invoice_reminder_outbox o set status = 'failed', last_error = 'invoice no longer open', updated_at = now()
   where o.status = 'pending' and exists (select 1 from platform_invoices i where i.id = o.invoice_id and i.status <> 'open');
  -- so is a reminder for a group that has since switched reminders off, removed its address or been closed
  update platform_invoice_reminder_outbox o set status = 'failed', last_error = 'reminders switched off', updated_at = now()
   where o.status = 'pending' and exists (select 1 from tenants t where t.id = o.tenant_id and (not t.remind_overdue_invoices or t.billing_email is null or t.status = 'closed'));
  -- one still to go is sent to the address the group has now
  update platform_invoice_reminder_outbox o set to_email = t.billing_email
    from tenants t where t.id = o.tenant_id and o.status = 'pending' and t.billing_email is not null and o.to_email <> t.billing_email;
  with picked as (
    select id from platform_invoice_reminder_outbox
     where attempts < 5
       and ((status = 'pending' and next_attempt_at <= now()) or (status = 'sending' and updated_at < now() - interval '10 minutes'))
     order by next_attempt_at, created_at
     limit p_limit
     for update skip locked),
  claimed as (
    update platform_invoice_reminder_outbox d set status = 'sending', attempts = d.attempts + 1, updated_at = now()
      from picked where d.id = picked.id
    returning d.id, d.to_email, d.payload, d.attempts)
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'to_email', c.to_email, 'payload', c.payload, 'attempt', c.attempts) order by c.attempts, c.id), '[]'::jsonb)
    into v_out from claimed c;
  return v_out;
end $$;
revoke all on function claim_platform_invoice_reminders(integer) from public, anon, authenticated;
grant execute on function claim_platform_invoice_reminders(integer) to service_role;

create function mark_platform_invoice_reminder_result(p_id uuid, p_ok boolean, p_error text default null) returns void
language plpgsql security definer set search_path = public as $$
declare d platform_invoice_reminder_outbox%rowtype;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select * into d from platform_invoice_reminder_outbox where id = p_id for update;
  if not found or d.status <> 'sending' then return; end if;
  if p_ok then
    update platform_invoice_reminder_outbox set status = 'sent', sent_at = now(), last_error = null, updated_at = now() where id = p_id;
  elsif d.attempts >= 5 then
    update platform_invoice_reminder_outbox set status = 'failed', last_error = left(coalesce(p_error, 'failed'), 500), updated_at = now() where id = p_id;
  else
    update platform_invoice_reminder_outbox set status = 'pending', last_error = left(coalesce(p_error, 'failed'), 500),
           next_attempt_at = now() + (d.attempts * interval '5 minutes'), updated_at = now() where id = p_id;
  end if;
end $$;
revoke all on function mark_platform_invoice_reminder_result(uuid, boolean, text) from public, anon, authenticated;
grant execute on function mark_platform_invoice_reminder_result(uuid, boolean, text) to service_role;

-- What happened to one invoice's reminders (internal; the two readers below check the caller).
create function pinv_reminder_info(p_invoice uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'reminders_on', t.remind_overdue_invoices and t.billing_email is not null,
    'next_reminder_date',
      case when i.status = 'open' and i.due_date is not null and t.remind_overdue_invoices and t.billing_email is not null and t.status <> 'closed'
                and (select count(*) from platform_invoice_reminder_outbox o where o.invoice_id = i.id) < 3
           then i.due_date + ((select count(*) from platform_invoice_reminder_outbox o where o.invoice_id = i.id)::integer * 7) + 1 end,
    'reminders', coalesce((
      select jsonb_agg(jsonb_build_object(
               'no', o.reminder_no,
               'outcome', case o.status when 'pending' then 'queued' when 'sending' then 'sending' when 'sent' then 'sent'
                                        else case when o.last_error in ('invoice no longer open', 'reminders switched off') then 'closed' else 'failed' end end,
               'queued_at', o.created_at, 'sent_at', o.sent_at) order by o.reminder_no)
        from platform_invoice_reminder_outbox o where o.invoice_id = i.id), '[]'::jsonb))
    from platform_invoices i join tenants t on t.id = i.tenant_id where i.id = p_invoice
$$;
revoke all on function pinv_reminder_info(uuid) from public, anon, authenticated;

-- The billing contact of one group and the reminder status of its open invoices, for its page (support or admin).
create function platform_billing_reminders(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare t tenants%rowtype;
begin
  perform platform_require('support');
  select * into t from tenants where id = p_tenant;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  return jsonb_build_object(
    'billing_email', t.billing_email, 'remind_overdue_invoices', t.remind_overdue_invoices,
    'invoices', coalesce((select jsonb_agg(jsonb_build_object('invoice_id', i.id, 'number', i.number, 'due_date', i.due_date, 'info', pinv_reminder_info(i.id)) order by i.due_date nulls last, i.number)
                            from platform_invoices i where i.tenant_id = p_tenant and (i.status = 'open' or exists (select 1 from platform_invoice_reminder_outbox o where o.invoice_id = i.id))), '[]'::jsonb));
end $$;
revoke all on function platform_billing_reminders(uuid) from public, anon;
grant execute on function platform_billing_reminders(uuid) to authenticated;

-- The open invoices list of 116, with the reminder status of each.
create or replace function platform_open_invoices() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform platform_require('support');
  return coalesce((select jsonb_agg(row_to_json(x)::jsonb) from (
    select i.id, i.number, i.tenant_id, t.name as tenant_name, i.period_start, i.period_end, i.amount_minor, i.currency, i.due_date, i.note,
           pinv_reminder_info(i.id) as reminder_info
      from platform_invoices i join tenants t on t.id = i.tenant_id
     where i.status = 'open'
     order by i.due_date asc nulls last, i.created_at
     limit 500) x), '[]'::jsonb);
end $$;
