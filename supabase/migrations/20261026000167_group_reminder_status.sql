-- 167 Group bookings, step eleven: see which overdue reminders went out (the leftover of 166). Read-only; nothing is sent or changed.
-- For one group invoice: whether the company has reminders on, whether the invoice has an email, each reminder (1 to 3) with its outcome and
-- time, and the day the next one is due. The outcome is one of queued, sending, sent, closed (the invoice was paid or voided before it went out,
-- nothing was sent) or failed (all attempts used). The address and the internal error text are not returned; the invoice screen already shows the
-- address, and a failure is only ever "failed" here.
-- Reminder k goes on the first day after due_date + (k - 1) * 7 (166), so with n reminders already queued the next is due_date + n * 7 + 1; there is
-- none when reminders are off, there is no email, three are already queued, or the invoice is no longer open.
-- Needs group.manage and the right to see money, as the overdue list does. group_invoice_overdue now also carries this per invoice.

create function group_invoice_reminder_info(p_invoice uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'reminders_on', coalesce(c.remind_overdue, false),
    'has_email', btrim(coalesce(i.bill_to_email, '')) <> '',
    'next_reminder_date',
      case when i.invoice_status = 'issued' and coalesce(c.remind_overdue, false) and btrim(coalesce(i.bill_to_email, '')) <> ''
                and (select count(*) from group_invoice_reminder_outbox o where o.invoice_id = i.id) < 3
           then i.due_date + ((select count(*) from group_invoice_reminder_outbox o where o.invoice_id = i.id)::integer * 7) + 1 end,
    'reminders', coalesce((
      select jsonb_agg(jsonb_build_object(
               'no', o.reminder_no,
               'outcome', case o.status when 'pending' then 'queued' when 'sending' then 'sending' when 'sent' then 'sent'
                                        else case when o.last_error = 'invoice no longer open' then 'closed' else 'failed' end end,
               'queued_at', o.created_at, 'sent_at', o.sent_at) order by o.reminder_no)
        from group_invoice_reminder_outbox o where o.invoice_id = i.id), '[]'::jsonb))
    from group_invoices i join group_bookings b on b.id = i.group_id left join company_accounts c on c.id = b.company_id
   where i.id = p_invoice
$$;
revoke all on function group_invoice_reminder_info(uuid) from public, anon, authenticated;

create function group_invoice_reminders(p_invoice uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_property uuid;
begin
  select property_id into v_property from group_invoices where id = p_invoice;
  if v_property is null or not has_permission(v_property, 'group.manage') or not can_view_money(v_property) then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  return group_invoice_reminder_info(p_invoice);
end $$;
revoke all on function group_invoice_reminders(uuid) from public, anon;
grant execute on function group_invoice_reminders(uuid) to authenticated;

-- The overdue list of 157, with the reminder information of each invoice.
create or replace function group_invoice_overdue(p_property uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_today date := property_today(p_property);
begin
  if not has_permission(p_property, 'group.manage') or not can_view_money(p_property) then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'invoice_id', i.id, 'invoice_number', i.invoice_number, 'group_id', b.id, 'group_name', b.name, 'bill_to', i.bill_to, 'currency', i.currency,
      'total_minor', i.total_minor, 'due_date', i.due_date, 'days_overdue', v_today - i.due_date, 'reminder_info', group_invoice_reminder_info(i.id))
      order by i.due_date, i.invoice_number)
    from group_invoices i join group_bookings b on b.id = i.group_id
   where i.property_id = p_property and i.invoice_status = 'issued' and i.due_date < v_today), '[]'::jsonb);
end $$;
