-- Group bookings, step thirteen (migration 173): overdue invoice reminders by text. Hotel A as in tests 149 to 168.
\set ON_ERROR_STOP on

do $$ declare
  v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_c uuid; v_g uuid; e jsonb; ra text; v_id uuid; v_today date; v_claim jsonb; v_cap integer;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  v_c := (company_create(v_p, 'Sms Co', 'Tola', 'accounts@smsco.example', '0803 123 4567', 7, 0, null, null)::jsonb ->> 'company_id')::uuid;
  v_g := (t149_group('Sms Group', 3, 0, 1300, 4, 1290)::jsonb ->> 'group_id')::uuid;
  perform set_group_company(v_g, v_c);
  ra := t150_ref(1300, 1302, 'g173-a');
  e := add_rooming_entry(v_g, 'A', null, null); perform link_rooming_reservation((e ->> 'entry_id')::uuid, ra);
  perform t_sys(); update reservations set reservation_status = 'confirmed' where booking_reference = ra; perform t_as('00000000-0000-0000-0000-00000000aa01');
  v_id := (issue_group_invoice(v_g, current_date + 7, 'sm-1') ->> 'group_invoice_id')::uuid;

  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select company_set_sms_reminders(%L, true)', v_c), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select company_set_sms_reminders(%L, null)', v_c), 'POLICY_VIOLATION: details');
  perform t_sys(); v_today := property_today(v_p);
  alter table group_invoices disable trigger group_invoices_guard_trg;
  update group_invoices set due_date = v_today - 1 where id = v_id;
  alter table group_invoices enable trigger group_invoices_guard_trg;

  -- off by default; on but hotel texting off: nothing
  if queue_group_invoice_sms(100) <> 0 then raise exception 'FAIL queued while off'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform company_set_sms_reminders(v_c, true); perform company_set_sms_reminders(v_c, true);
  if (select count(*) from audit_logs where entity_id = v_c and action = 'company.sms_reminders_set') <> 1 then raise exception 'FAIL audit'; end if;
  if not (select (x ->> 'remind_sms')::boolean from jsonb_array_elements(company_list(v_p)) x where x ->> 'id' = v_c::text) then raise exception 'FAIL list'; end if;
  perform t_sys();
  if queue_group_invoice_sms(100) <> 0 then raise exception 'FAIL queued with hotel texting off'; end if;
  update properties set sms_enabled = true where id = v_p;

  -- on: one text the day after the due date, to the +234 number, once
  if queue_group_invoice_sms(100) <> 1 then raise exception 'FAIL first text'; end if;
  if queue_group_invoice_sms(100) <> 0 then raise exception 'FAIL double queue'; end if;
  if (select to_phone from group_invoice_sms_outbox where invoice_id = v_id) <> '+2348031234567' then raise exception 'FAIL number'; end if;

  -- 7 days apart, three at most
  alter table group_invoices disable trigger group_invoices_guard_trg;
  update group_invoices set due_date = v_today - 7 where id = v_id;
  if queue_group_invoice_sms(100) <> 0 then raise exception 'FAIL early second text'; end if;
  update group_invoices set due_date = v_today - 8 where id = v_id;
  if queue_group_invoice_sms(100) <> 1 then raise exception 'FAIL second text'; end if;
  update group_invoices set due_date = v_today - 15 where id = v_id;
  if queue_group_invoice_sms(100) <> 1 then raise exception 'FAIL third text'; end if;
  update group_invoices set due_date = v_today - 60 where id = v_id;
  alter table group_invoices enable trigger group_invoices_guard_trg;
  if queue_group_invoice_sms(100) <> 0 then raise exception 'FAIL fourth text'; end if;

  -- claim and mark
  v_claim := claim_group_invoice_sms(10);
  if jsonb_array_length(v_claim) <> 3 then raise exception 'FAIL claim %', v_claim; end if;
  perform mark_group_invoice_sms_result((v_claim -> 0 ->> 'id')::uuid, true);
  perform mark_group_invoice_sms_result((v_claim -> 1 ->> 'id')::uuid, false, 'boom');
  perform mark_group_invoice_sms_result((v_claim -> 2 ->> 'id')::uuid, false, 'bad number', true);
  if (select count(*) from group_invoice_sms_outbox where invoice_id = v_id and status = 'sent') <> 1
     or (select count(*) from group_invoice_sms_outbox where invoice_id = v_id and status = 'pending' and last_error = 'boom') <> 1
     or (select count(*) from group_invoice_sms_outbox where invoice_id = v_id and status = 'failed') <> 1 then raise exception 'FAIL mark'; end if;
  if jsonb_array_length(group_invoice_reminder_info(v_id) -> 'sms_reminders') <> 3 then raise exception 'FAIL info'; end if;

  -- the cap: a hotel at its cap queues nothing
  delete from group_invoice_sms_outbox;
  alter table group_invoices disable trigger group_invoices_guard_trg;
  update group_invoices set due_date = v_today - 1 where id = v_id;
  alter table group_invoices enable trigger group_invoices_guard_trg;
  update properties set sms_monthly_cap = 0 where id = v_p;
  if queue_group_invoice_sms(100) <> 0 then raise exception 'FAIL queued over the cap'; end if;
  update properties set sms_monthly_cap = 300 where id = v_p;
  -- a number that is not usable: nothing
  update company_accounts set billing_phone = '12345' where id = v_c;
  if queue_group_invoice_sms(100) <> 0 then raise exception 'FAIL queued to a bad number'; end if;
  update company_accounts set billing_phone = '0803 123 4567' where id = v_c;
  if queue_group_invoice_sms(100) <> 1 then raise exception 'FAIL should queue again'; end if;
  update properties set sms_enabled = false where id = v_p;
  if jsonb_array_length(claim_group_invoice_sms(10)) <> 0 then raise exception 'FAIL sent with hotel texting off'; end if;
  update properties set sms_enabled = true where id = v_p;
  delete from group_invoice_sms_outbox;
  if queue_group_invoice_sms(100) <> 1 then raise exception 'FAIL requeue'; end if;


  -- paid: waiting text closed out
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform mark_group_invoice_paid(v_id, 'bank_transfer', 'REF-173');
  perform t_sys();
  update group_invoice_sms_outbox set next_attempt_at = now() - interval '1 minute' where invoice_id = v_id and status = 'pending';
  if jsonb_array_length(claim_group_invoice_sms(10)) <> 0 then raise exception 'FAIL paid invoice text claimed'; end if;
  if (select count(*) from group_invoice_sms_outbox where invoice_id = v_id and last_error = 'invoice no longer open') <> 1 then raise exception 'FAIL not closed out'; end if;

  perform t_as('00000000-0000-0000-0000-00000000aa01');
  begin perform queue_group_invoice_sms(10); raise exception 'FAIL staff ran the system function';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS group bookings step thirteen: invoice texts off by default, queue 3 spaced by 7 days, cap, bad number, claim and mark, paid and switched-off closed out';
end $$;
