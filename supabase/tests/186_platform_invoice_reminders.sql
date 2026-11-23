-- Platform invoice reminders (migration 186). Platform people from 51: f050 admin, f051 support, f052 an ordinary hotel owner; group 't50-hotel'.
-- The platform's day is Africa/Lagos. Invoices use 2032 periods so they never meet other tests' invoices.
\set ON_ERROR_STOP on

create function t186_today() returns date language sql as $$ select (now() at time zone 'Africa/Lagos')::date $$;
create function t186_info(p_invoice uuid) returns jsonb language sql as $$
  select x -> 'info' from jsonb_array_elements(platform_billing_reminders(current_setting('t186.tenant')::uuid) -> 'invoices') x where x ->> 'invoice_id' = p_invoice::text
$$;

do $$ declare
  v_t uuid := (select id from tenants where slug = 't50-hotel'); v_inv uuid; v_inv2 uuid; v_claim jsonb; i jsonb; l jsonb; r jsonb;
begin
  perform t_sys();
  perform set_config('t186.tenant', v_t::text, false);
  insert into platform_invoices (tenant_id, number, period_start, period_end, amount_minor, due_date)
  values (v_t, 'PI-T171-A', '2032-01-01', '2032-02-01', 5000000, t186_today() - 1) returning id into v_inv;

  -- who may set the billing contact, and what is accepted
  perform t_as('00000000-0000-0000-0000-00000000f051');
  perform t_expect(format('select platform_set_billing_contact(%L, ''a@b.test'', true)', v_t), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000f052');
  perform t_expect(format('select platform_set_billing_contact(%L, ''a@b.test'', true)', v_t), 'NOT_FOUND');
  perform t_expect(format('select platform_billing_reminders(%L)', v_t), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000f050');
  perform t_expect(format('select platform_set_billing_contact(%L, ''nope'', false)', v_t), 'POLICY_VIOLATION: billing email');
  perform t_expect(format('select platform_set_billing_contact(%L, ''a@b'', false)', v_t), 'POLICY_VIOLATION: billing email');
  perform t_expect(format('select platform_set_billing_contact(%L, ''a b@c.test'', false)', v_t), 'POLICY_VIOLATION: billing email');
  perform t_expect(format('select platform_set_billing_contact(%L, %L, false)', v_t, repeat('x', 200) || '@c.test'), 'POLICY_VIOLATION: billing email');
  perform t_expect(format('select platform_set_billing_contact(%L, null, true)', v_t), 'POLICY_VIOLATION: billing email');
  perform t_expect(format('select platform_set_billing_contact(%L, ''a@b.test'', null)', v_t), 'POLICY_VIOLATION: details');
  perform t_expect(format('select platform_set_billing_contact(%L, ''a@b.test'', true)', gen_random_uuid()), 'NOT_FOUND');

  -- off by default: nothing is promised
  perform t_as('00000000-0000-0000-0000-00000000f051');
  i := t186_info(v_inv);
  if (i ->> 'reminders_on')::boolean or i -> 'next_reminder_date' <> 'null'::jsonb or i -> 'reminders' <> '[]'::jsonb then raise exception 'FAIL off state %', i; end if;
  perform t_sys();
  if queue_platform_invoice_reminders(100) <> 0 then raise exception 'FAIL queued while off'; end if;

  -- on: set twice is one audit row; the first reminder is due the day after the due date
  perform t_as('00000000-0000-0000-0000-00000000f050');
  if not (platform_set_billing_contact(v_t, '  Billing@Hotel.test ', true) ->> 'changed')::boolean then raise exception 'FAIL first set'; end if;
  if (platform_set_billing_contact(v_t, 'Billing@Hotel.test', true) ->> 'changed')::boolean then raise exception 'FAIL repeat should change nothing'; end if;
  perform t_sys();
  if (select count(*) from audit_logs where entity_id = v_t and action = 'platform.billing_contact_set') <> 1 then raise exception 'FAIL billing contact audit'; end if;
  perform t_as('00000000-0000-0000-0000-00000000f051');
  l := platform_billing_reminders(v_t);
  if l ->> 'billing_email' <> 'Billing@Hotel.test' or not (l ->> 'remind_overdue_invoices')::boolean then raise exception 'FAIL contact %', l; end if;
  i := t186_info(v_inv);
  if not (i ->> 'reminders_on')::boolean or (i ->> 'next_reminder_date')::date <> t186_today() then raise exception 'FAIL on state %', i; end if;

  -- a closed group gets none
  perform t_sys();
  update tenants set status = 'closed' where id = v_t;
  if queue_platform_invoice_reminders(100) <> 0 then raise exception 'FAIL a closed group was reminded'; end if;
  update tenants set status = 'active' where id = v_t;

  -- one reminder the day after the due date, never twice
  if queue_platform_invoice_reminders(100) <> 1 then raise exception 'FAIL first reminder'; end if;
  if queue_platform_invoice_reminders(100) <> 0 then raise exception 'FAIL double queue'; end if;
  if (select to_email from platform_invoice_reminder_outbox where invoice_id = v_inv) <> 'Billing@Hotel.test' then raise exception 'FAIL address'; end if;
  if (select (payload ->> 'days_overdue')::int from platform_invoice_reminder_outbox where invoice_id = v_inv and reminder_no = 1) <> 1 then raise exception 'FAIL days overdue'; end if;
  if (select (payload ->> 'amount_minor')::bigint from platform_invoice_reminder_outbox where invoice_id = v_inv and reminder_no = 1) <> 5000000 then raise exception 'FAIL amount'; end if;

  -- the next only after 7 more days, then a third, then no more
  update platform_invoices set due_date = t186_today() - 7 where id = v_inv;
  if queue_platform_invoice_reminders(100) <> 0 then raise exception 'FAIL early second reminder'; end if;
  update platform_invoices set due_date = t186_today() - 8 where id = v_inv;
  if queue_platform_invoice_reminders(100) <> 1 then raise exception 'FAIL second reminder'; end if;
  update platform_invoices set due_date = t186_today() - 15 where id = v_inv;
  if queue_platform_invoice_reminders(100) <> 1 then raise exception 'FAIL third reminder'; end if;
  update platform_invoices set due_date = t186_today() - 60 where id = v_inv;
  if queue_platform_invoice_reminders(100) <> 0 then raise exception 'FAIL fourth reminder'; end if;
  perform t_as('00000000-0000-0000-0000-00000000f051');
  i := t186_info(v_inv);
  if jsonb_array_length(i -> 'reminders') <> 3 or i -> 'next_reminder_date' <> 'null'::jsonb then raise exception 'FAIL after three %', i; end if;

  -- an address changed before sending: the reminder goes to the new one
  perform t_as('00000000-0000-0000-0000-00000000f050');
  perform platform_set_billing_contact(v_t, 'new@hotel.test', true);
  perform t_sys();
  v_claim := claim_platform_invoice_reminders(10);
  if jsonb_array_length(v_claim) <> 3 or exists (select 1 from jsonb_array_elements(v_claim) x where x ->> 'to_email' <> 'new@hotel.test') then raise exception 'FAIL claim %', v_claim; end if;
  perform mark_platform_invoice_reminder_result((select (x ->> 'id')::uuid from jsonb_array_elements(v_claim) x where x #>> '{payload,reminder_no}' = '1'), true);
  perform mark_platform_invoice_reminder_result((select (x ->> 'id')::uuid from jsonb_array_elements(v_claim) x where x #>> '{payload,reminder_no}' = '2'), false, 'boom');
  update platform_invoice_reminder_outbox set attempts = 5 where invoice_id = v_inv and reminder_no = 3;
  perform mark_platform_invoice_reminder_result((select (x ->> 'id')::uuid from jsonb_array_elements(v_claim) x where x #>> '{payload,reminder_no}' = '3'), false, 'boom');

  -- what support sees: outcomes, never an address or error text in the invoice part
  perform t_as('00000000-0000-0000-0000-00000000f051');
  i := t186_info(v_inv);
  if i #>> '{reminders,0,outcome}' <> 'sent' or i #>> '{reminders,0,sent_at}' is null or i #>> '{reminders,1,outcome}' <> 'queued' or i #>> '{reminders,2,outcome}' <> 'failed' then raise exception 'FAIL outcomes %', i; end if;
  if (platform_billing_reminders(v_t) -> 'invoices')::text like '%hotel.test%' or i::text like '%boom%' then raise exception 'FAIL an address or the error text leaked'; end if;
  r := (select x from jsonb_array_elements(platform_open_invoices()) x where x ->> 'number' = 'PI-T171-A');
  if r is null or r -> 'reminder_info' <> i then raise exception 'FAIL open invoices list %', r; end if;

  -- switched off: the reminder still waiting is closed out, not sent
  perform t_as('00000000-0000-0000-0000-00000000f050');
  perform platform_set_billing_contact(v_t, 'new@hotel.test', false);
  perform t_sys();
  update platform_invoice_reminder_outbox set next_attempt_at = now() - interval '1 minute' where invoice_id = v_inv and status = 'pending';
  if jsonb_array_length(claim_platform_invoice_reminders(10)) <> 0 then raise exception 'FAIL a reminder was claimed after the switch went off'; end if;
  perform t_as('00000000-0000-0000-0000-00000000f051');
  i := t186_info(v_inv);
  if i #>> '{reminders,1,outcome}' <> 'closed' or i #>> '{reminders,2,outcome}' <> 'failed' or (i ->> 'reminders_on')::boolean then raise exception 'FAIL after off %', i; end if;

  -- paid: nothing more is due
  perform t_as('00000000-0000-0000-0000-00000000f050');
  perform platform_set_billing_contact(v_t, 'new@hotel.test', true);
  perform platform_mark_invoice_paid(v_inv, 'REF-171');
  perform t_as('00000000-0000-0000-0000-00000000f051');
  i := t186_info(v_inv);
  if i -> 'next_reminder_date' <> 'null'::jsonb then raise exception 'FAIL a paid invoice still has a next reminder: %', i; end if;
  perform t_sys();
  if queue_platform_invoice_reminders(100) <> 0 then raise exception 'FAIL a paid invoice was reminded'; end if;

  -- paid before the reminder went out: closed out, never claimed or sent
  perform t_sys();
  insert into platform_invoices (tenant_id, number, period_start, period_end, amount_minor, due_date)
  values (v_t, 'PI-T186-B', '2032-02-01', '2032-03-01', 3000000, t186_today() - 1) returning id into v_inv2;
  if queue_platform_invoice_reminders(100) <> 1 then raise exception 'FAIL reminder for the second invoice'; end if;
  perform t_as('00000000-0000-0000-0000-00000000f050');
  perform platform_mark_invoice_paid(v_inv2, 'REF-186-B');
  perform t_sys();
  if jsonb_array_length(claim_platform_invoice_reminders(10)) <> 0 then raise exception 'FAIL a reminder for a paid invoice was claimed'; end if;
  if (select last_error from platform_invoice_reminder_outbox where invoice_id = v_inv2) <> 'invoice no longer open' then raise exception 'FAIL paid close-out reason'; end if;
  perform t_as('00000000-0000-0000-0000-00000000f051');
  if (platform_billing_reminders(v_t) -> 'invoices' -> 0 ->> 'number') is null or not exists (
       select 1 from jsonb_array_elements(platform_billing_reminders(v_t) -> 'invoices') x where x ->> 'number' = 'PI-T186-B' and x #>> '{info,reminders,0,outcome}' = 'closed') then
    raise exception 'FAIL the paid invoice reminder should read closed';
  end if;

  -- nobody logged in can touch the queue
  perform t_as('00000000-0000-0000-0000-00000000f050');
  begin perform queue_platform_invoice_reminders(10); raise exception 'FAIL admin ran the system function'; exception when insufficient_privilege then null; end;
  begin perform claim_platform_invoice_reminders(10); raise exception 'FAIL admin claimed'; exception when insufficient_privilege then null; end;
  begin perform pinv_reminder_info(v_inv); raise exception 'FAIL admin called the internal function'; exception when insufficient_privilege then null; end;
  begin perform count(*) from platform_invoice_reminder_outbox; raise exception 'FAIL admin read the outbox table'; exception when insufficient_privilege then null; end;

  perform t_sys();
  delete from platform_invoice_reminder_outbox where invoice_id in (v_inv, v_inv2);
  delete from platform_invoices where id in (v_inv, v_inv2);
  update tenants set remind_overdue_invoices = false, billing_email = null where id = v_t;
  raise notice 'PASS platform invoice reminders: off by default, admin sets a checked address and the switch, 3 reminders 7 days apart once each, new address used, off or paid-before-sent closes out, status for support without addresses, system functions closed';
end $$;
