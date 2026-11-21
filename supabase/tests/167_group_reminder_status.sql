-- Group bookings, step eleven (migration 167): the status of overdue reminders. Hotel A as in tests 149 to 166. Owner aa01, front desk aa04 (no group
-- permission), other hotel's owner bb01.
\set ON_ERROR_STOP on

do $$ declare
  v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_c uuid; v_g uuid; e jsonb; ra text; v_id uuid; v_today date; v_claim jsonb; i jsonb; v_row jsonb;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  v_c := (company_create(v_p, 'Status Co', 'Tola', 'accounts@status.example', null, 7, 0, null, null)::jsonb ->> 'company_id')::uuid;
  v_g := (t149_group('Status Group', 3, 0, 1300, 4, 1290)::jsonb ->> 'group_id')::uuid;
  perform set_group_company(v_g, v_c);
  ra := t150_ref(1300, 1302, 'g167-a');
  e := add_rooming_entry(v_g, 'A', null, null); perform link_rooming_reservation((e ->> 'entry_id')::uuid, ra);
  perform t_sys(); update reservations set reservation_status = 'confirmed' where booking_reference = ra; perform t_as('00000000-0000-0000-0000-00000000aa01');
  v_id := (issue_group_invoice(v_g, current_date + 7, 'st-1') ->> 'group_invoice_id')::uuid;
  perform t_sys(); v_today := property_today(v_p);
  alter table group_invoices disable trigger group_invoices_guard_trg;
  update group_invoices set due_date = v_today - 1 where id = v_id;
  alter table group_invoices enable trigger group_invoices_guard_trg;

  -- who may read it
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select group_invoice_reminders(%L)', v_id), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select group_invoice_reminders(%L)', v_id), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select group_invoice_reminders(%L)', gen_random_uuid()), 'NOT_FOUND');
  begin perform group_invoice_reminder_info(v_id); raise exception 'FAIL staff called the internal function'; exception when insufficient_privilege then null; end;

  -- off by default: nothing is promised
  i := group_invoice_reminders(v_id);
  if (i ->> 'reminders_on')::boolean or not (i ->> 'has_email')::boolean or i -> 'next_reminder_date' <> 'null'::jsonb or i -> 'reminders' <> '[]'::jsonb then raise exception 'FAIL off state %', i; end if;

  -- on: the first reminder is due the day after the due date (today); no email, no reminder
  perform company_set_reminders(v_c, true);
  i := group_invoice_reminders(v_id);
  if not (i ->> 'reminders_on')::boolean or (i ->> 'next_reminder_date')::date <> v_today then raise exception 'FAIL on state %', i; end if;
  perform t_sys();
  alter table group_invoices disable trigger group_invoices_guard_trg;
  update group_invoices set bill_to_email = null where id = v_id;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  i := group_invoice_reminders(v_id);
  if (i ->> 'has_email')::boolean or i -> 'next_reminder_date' <> 'null'::jsonb then raise exception 'FAIL no email %', i; end if;
  perform t_sys();
  update group_invoices set bill_to_email = 'accounts@status.example' where id = v_id;
  alter table group_invoices enable trigger group_invoices_guard_trg;

  -- queued, then the next one 7 days later, then three and no more
  if queue_group_invoice_reminders(100) <> 1 then raise exception 'FAIL first queue'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  i := group_invoice_reminders(v_id);
  if jsonb_array_length(i -> 'reminders') <> 1 or i #>> '{reminders,0,outcome}' <> 'queued' or i #>> '{reminders,0,no}' <> '1' or (i ->> 'next_reminder_date')::date <> v_today + 7 then raise exception 'FAIL after first %', i; end if;
  perform t_sys();
  alter table group_invoices disable trigger group_invoices_guard_trg;
  update group_invoices set due_date = v_today - 8 where id = v_id;
  perform queue_group_invoice_reminders(100);
  update group_invoices set due_date = v_today - 15 where id = v_id;
  perform queue_group_invoice_reminders(100);
  alter table group_invoices enable trigger group_invoices_guard_trg;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  i := group_invoice_reminders(v_id);
  if jsonb_array_length(i -> 'reminders') <> 3 or i -> 'next_reminder_date' <> 'null'::jsonb then raise exception 'FAIL after three %', i; end if;

  -- outcomes: sent, still queued after a failed try, and failed after all attempts
  perform t_sys();
  v_claim := claim_group_invoice_reminders(10);
  perform mark_group_invoice_reminder_result((select (x ->> 'id')::uuid from jsonb_array_elements(v_claim) x where x #>> '{payload,reminder_no}' = '1'), true);
  perform mark_group_invoice_reminder_result((select (x ->> 'id')::uuid from jsonb_array_elements(v_claim) x where x #>> '{payload,reminder_no}' = '2'), false, 'boom');
  update group_invoice_reminder_outbox set attempts = 5 where invoice_id = v_id and reminder_no = 3;
  perform mark_group_invoice_reminder_result((select (x ->> 'id')::uuid from jsonb_array_elements(v_claim) x where x #>> '{payload,reminder_no}' = '3'), false, 'boom');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  i := group_invoice_reminders(v_id);
  if i #>> '{reminders,0,outcome}' <> 'sent' or i #>> '{reminders,0,sent_at}' is null or i #>> '{reminders,1,outcome}' <> 'queued' or i #>> '{reminders,2,outcome}' <> 'failed' then raise exception 'FAIL outcomes %', i; end if;
  if i::text like '%accounts@status.example%' or i::text like '%boom%' then raise exception 'FAIL the address or the error text leaked: %', i; end if;

  -- the overdue list carries it
  v_row := (select x from jsonb_array_elements(group_invoice_overdue(v_p)) x where x ->> 'invoice_id' = v_id::text);
  if v_row is null or v_row -> 'reminder_info' <> i then raise exception 'FAIL overdue list %', v_row; end if;

  -- paid: the waiting reminder is closed out, never sent, and nothing more is due
  perform mark_group_invoice_paid(v_id, 'bank_transfer', 'REF-167');
  perform t_sys();
  update group_invoice_reminder_outbox set next_attempt_at = now() - interval '1 minute' where invoice_id = v_id and status = 'pending';
  v_claim := claim_group_invoice_reminders(10);
  if jsonb_array_length(v_claim) <> 0 then raise exception 'FAIL paid invoice reminder claimed'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  i := group_invoice_reminders(v_id);
  if i #>> '{reminders,1,outcome}' <> 'closed' or i #>> '{reminders,2,outcome}' <> 'failed' or i -> 'next_reminder_date' <> 'null'::jsonb then raise exception 'FAIL after paid %', i; end if;
  if exists (select 1 from jsonb_array_elements(group_invoice_overdue(v_p)) x where x ->> 'invoice_id' = v_id::text) then raise exception 'FAIL a paid invoice is still in the overdue list'; end if;
  raise notice 'PASS group bookings step eleven: reminder status for an invoice (off, on, next date, queued, sent, failed, closed), no address or error text, in the overdue list, access limited';
end $$;
