-- Group bookings, step ten (migration 166): overdue reminders for group invoices. Hotel A as in tests 149 to 165.
\set ON_ERROR_STOP on

do $$ declare
  v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_c uuid; v_g uuid; e jsonb; ra text; v_id uuid; v_n integer; v_claim jsonb; v_today date;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  v_c := (company_create(v_p, 'Remind Co', 'Tola', 'accounts@remind.example', null, 7, 0, null, null)::jsonb ->> 'company_id')::uuid;
  v_g := (t149_group('Remind Group', 3, 0, 1200, 4, 1190)::jsonb ->> 'group_id')::uuid;
  perform set_group_company(v_g, v_c);
  ra := t150_ref(1200, 1202, 'g166-a');
  e := add_rooming_entry(v_g, 'A', null, null); perform link_rooming_reservation((e ->> 'entry_id')::uuid, ra);
  perform t_sys(); update reservations set reservation_status = 'confirmed' where booking_reference = ra; perform t_as('00000000-0000-0000-0000-00000000aa01');
  v_id := (issue_group_invoice(v_g, current_date + 7, 'rm-1') ->> 'group_invoice_id')::uuid;

  -- who may switch it, and it is off by default
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select company_set_reminders(%L, true)', v_c), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select company_set_reminders(%L, null)', v_c), 'POLICY_VIOLATION: details');
  perform t_sys(); v_today := property_today(v_p);
  alter table group_invoices disable trigger group_invoices_guard_trg;
  update group_invoices set due_date = v_today - 1 where id = v_id;
  alter table group_invoices enable trigger group_invoices_guard_trg;
  if queue_group_invoice_reminders(100) <> 0 then raise exception 'FAIL queued while off'; end if;

  -- on: one reminder the day after the due date, none twice
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform company_set_reminders(v_c, true); perform company_set_reminders(v_c, true);
  if (select count(*) from audit_logs where entity_id = v_c and action = 'company.reminders_set') <> 1 then raise exception 'FAIL audit'; end if;
  if not (select (x ->> 'remind_overdue')::boolean from jsonb_array_elements(company_list(v_p)) x where x ->> 'id' = v_c::text) then raise exception 'FAIL list'; end if;
  perform t_sys();
  if queue_group_invoice_reminders(100) <> 1 then raise exception 'FAIL first reminder'; end if;
  if queue_group_invoice_reminders(100) <> 0 then raise exception 'FAIL double queue'; end if;
  if (select to_email from group_invoice_reminder_outbox where invoice_id = v_id) <> 'accounts@remind.example' then raise exception 'FAIL address'; end if;
  if (select (payload ->> 'days_overdue')::int from group_invoice_reminder_outbox where invoice_id = v_id and reminder_no = 1) <> 1 then raise exception 'FAIL days'; end if;

  -- the next one only after 7 more days, then a third, then no more
  alter table group_invoices disable trigger group_invoices_guard_trg;
  update group_invoices set due_date = v_today - 7 where id = v_id;
  if queue_group_invoice_reminders(100) <> 0 then raise exception 'FAIL early second reminder'; end if;
  update group_invoices set due_date = v_today - 8 where id = v_id;
  if queue_group_invoice_reminders(100) <> 1 then raise exception 'FAIL second reminder'; end if;
  update group_invoices set due_date = v_today - 15 where id = v_id;
  if queue_group_invoice_reminders(100) <> 1 then raise exception 'FAIL third reminder'; end if;
  update group_invoices set due_date = v_today - 60 where id = v_id;
  alter table group_invoices enable trigger group_invoices_guard_trg;
  if queue_group_invoice_reminders(100) <> 0 then raise exception 'FAIL fourth reminder'; end if;

  -- claim and mark: a failure retries, a success closes
  v_claim := claim_group_invoice_reminders(10);
  if jsonb_array_length(v_claim) <> 3 then raise exception 'FAIL claim %', v_claim; end if;
  perform mark_group_invoice_reminder_result((v_claim -> 0 ->> 'id')::uuid, true);
  perform mark_group_invoice_reminder_result((v_claim -> 1 ->> 'id')::uuid, false, 'boom');
  if (select count(*) from group_invoice_reminder_outbox where invoice_id = v_id and status = 'sent') <> 1
     or (select count(*) from group_invoice_reminder_outbox where invoice_id = v_id and status = 'pending' and last_error = 'boom') <> 1 then raise exception 'FAIL mark'; end if;

  -- a paid invoice: its waiting reminders are closed out, not sent
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform mark_group_invoice_paid(v_id, 'bank_transfer', 'REF-166');
  perform t_sys();
  update group_invoice_reminder_outbox set next_attempt_at = now() - interval '1 minute' where invoice_id = v_id and status = 'pending';
  v_claim := claim_group_invoice_reminders(10);
  if jsonb_array_length(v_claim) <> 0 then raise exception 'FAIL paid invoice reminder claimed %', v_claim; end if;
  if (select count(*) from group_invoice_reminder_outbox where invoice_id = v_id and status = 'failed') < 1 then raise exception 'FAIL not closed out'; end if;

  -- ordinary users cannot call the system functions
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  begin perform queue_group_invoice_reminders(10); raise exception 'FAIL staff ran the system function';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS group bookings step ten: reminders off by default, on queues 3 spaced by 7 days, once each, claim and mark, paid invoice closed out';
end $$;
