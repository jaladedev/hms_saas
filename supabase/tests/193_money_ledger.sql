-- Migration 193: money_ledger, every payment and refund as one row, for the accountant. Reuses t_as / t_sys / t_expect (05).
-- Users: aa01 and aa05 hold report.export at hotel A; aa04 (front desk), aa02 (housekeeping) and bb01 (another hotel's owner) do not.
-- Ids: a1 tenant A, a2 property A (Africa/Lagos, NGN). The ledger is checked against what earlier tests left behind: 95+ booking
-- payments, extras payments, reversed ones, refunds in every status, and company payments. Scenarios that change data run in a
-- sub-transaction that raises ROLLBACK193, which undoes them (the same device as test 192).
\set ON_ERROR_STOP on

-- 1. Who may call it
do $$ declare
  a2 uuid := '00000000-0000-0000-0000-0000000000a2'; t date := property_today('00000000-0000-0000-0000-0000000000a2'); v_oid oid; v_n integer;
begin
  v_oid := to_regprocedure('money_ledger(uuid,date,date)');
  if v_oid is null then raise exception 'FAIL money_ledger is missing'; end if;
  if not has_function_privilege('authenticated', v_oid, 'execute') then raise exception 'FAIL authenticated cannot call it'; end if;
  if has_function_privilege('anon', v_oid, 'execute') or has_function_privilege('public', v_oid, 'execute') then raise exception 'FAIL anon or public can call it'; end if;
  if not (select prosecdef from pg_proc where oid = v_oid) then raise exception 'FAIL not security definer'; end if;
  if (select proconfig from pg_proc where oid = v_oid) is distinct from array['search_path=public'] then raise exception 'FAIL search_path not pinned'; end if;

  perform t_as('00000000-0000-0000-0000-00000000aa01');
  select count(*) into v_n from money_ledger(a2, t - 30, t + 30);
  if v_n = 0 then raise exception 'FAIL the owner got no rows from a range with payments in it'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  perform money_ledger(a2, t, t);
  perform t_as('00000000-0000-0000-0000-00000000aa04');   -- front desk: no report.export
  perform t_expect(format('select * from money_ledger(%L, %L, %L)', a2, t, t), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa02');   -- housekeeping
  perform t_expect(format('select * from money_ledger(%L, %L, %L)', a2, t, t), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');   -- another hotel's owner asking for this hotel
  perform t_expect(format('select * from money_ledger(%L, %L, %L)', a2, t, t), 'NOT_FOUND');
  perform t_expect(format('select * from money_ledger(%L, %L, %L)', gen_random_uuid(), t, t), 'NOT_FOUND');
  perform t_sys();
  raise notice 'PASS 193 callable by authenticated only, security definer, pinned search_path; export holders get rows; front desk, housekeeping, another hotel and an unknown hotel get NOT_FOUND';
end $$;

-- 2. The same switch as the CSV download: a hotel whose plan turns reports.export off gets nothing
do $$ declare a2 uuid := '00000000-0000-0000-0000-0000000000a2'; t date := property_today('00000000-0000-0000-0000-0000000000a2');
begin
  begin
    perform t_sys();
    insert into tenant_feature_entitlements (tenant_id, feature_key, enabled) values ('00000000-0000-0000-0000-0000000000a1', 'reports.export', false)
      on conflict (tenant_id, feature_key) do update set enabled = false;
    perform t_as('00000000-0000-0000-0000-00000000aa01');
    perform t_expect(format('select * from money_ledger(%L, %L, %L)', a2, t - 30, t + 30), 'NOT_FOUND');
    raise exception 'ROLLBACK193';
  exception when others then if sqlerrm <> 'ROLLBACK193' then raise; end if;
  end;
  perform t_sys();
  raise notice 'PASS 193 with the reports.export feature switched off the ledger is closed to everyone at that hotel';
end $$;

-- 3. The range is checked like the report's
do $$ declare a2 uuid := '00000000-0000-0000-0000-0000000000a2'; t date := property_today('00000000-0000-0000-0000-0000000000a2');
begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select * from money_ledger(%L, %L, %L)', a2, t, t - 1), 'POLICY_VIOLATION');
  perform t_expect(format('select * from money_ledger(%L, null, %L)', a2, t), 'POLICY_VIOLATION');
  perform t_expect(format('select * from money_ledger(%L, %L, null)', a2, t), 'POLICY_VIOLATION');
  perform t_expect(format('select * from money_ledger(%L, %L, %L)', a2, t - 367, t), 'POLICY_VIOLATION');
  perform money_ledger(a2, t - 366, t);                                     -- 366 days apart is allowed
  perform money_ledger(a2, t, t);                                           -- a single day is allowed
  perform t_sys();
  raise notice 'PASS 193 range: reversed, missing and over-366-day ranges are refused; a single day and 366 days apart are allowed';
end $$;

-- 4. It adds up to the day report, day by day, and lists only what the report counts
do $$ declare
  a2 uuid := '00000000-0000-0000-0000-0000000000a2'; t date := property_today('00000000-0000-0000-0000-0000000000a2');
  v_from date; v_to date; v_led jsonb; v_bad integer; v_cash bigint; v_ref bigint; v_days integer; v_n integer; v_exp integer;
begin
  v_from := t - 300; v_to := t + 66;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  select coalesce(jsonb_agg(to_jsonb(l)), '[]') into v_led from money_ledger(a2, v_from, v_to) l;
  perform t_sys();

  -- per day, in the hotel's own currency: received = cash_in, paid back (shown negative) = refunds_paid
  with led as (
    select (e ->> 'entry_day')::date as d,
           sum(case when e ->> 'kind' <> 'refund' then (e ->> 'amount_minor')::bigint else 0 end) as cash,
           sum(case when e ->> 'kind' = 'refund' then -(e ->> 'amount_minor')::bigint else 0 end) as refunds
      from jsonb_array_elements(v_led) e where e ->> 'currency' = 'NGN' group by 1),
  rep as (select day as d, cash_in_minor as cash, refunds_paid_minor as refunds from daily_report_figures(a2, v_from, v_to))
  select count(*), coalesce(sum(r.cash), 0), coalesce(sum(r.refunds), 0), count(*) filter (where coalesce(r.cash, 0) > 0)
    into v_bad, v_cash, v_ref, v_days
    from rep r full join led l on l.d = r.d
   where coalesce(r.cash, 0) <> coalesce(l.cash, 0) or coalesce(r.refunds, 0) <> coalesce(l.refunds, 0);
  if v_bad <> 0 then raise exception 'FAIL % days where the ledger and the day report disagree', v_bad; end if;

  -- the comparison above is not vacuous: there is real money in the window, on several days, and refunds were paid back
  select coalesce(sum(cash_in_minor), 0), coalesce(sum(refunds_paid_minor), 0), count(*) filter (where cash_in_minor > 0)
    into v_cash, v_ref, v_days from daily_report_figures(a2, v_from, v_to);
  if v_cash <= 0 or v_ref <= 0 or v_days < 1 then raise exception 'FAIL nothing to reconcile: cash %, refunds %, days %', v_cash, v_ref, v_days; end if;

  -- row counts equal what each table holds for the window (an independent count, so a dropped or doubled row shows)
  select count(*) into v_exp from payments where property_id = a2 and payment_status = 'succeeded' and (received_at at time zone 'Africa/Lagos')::date between v_from and v_to;
  select count(*) into v_n from jsonb_array_elements(v_led) e where e ->> 'kind' = 'booking_payment';
  if v_n <> v_exp or v_n = 0 then raise exception 'FAIL booking payments: ledger % vs table %', v_n, v_exp; end if;
  select count(*) into v_exp from folio_payments where property_id = a2 and payment_status = 'succeeded' and (received_at at time zone 'Africa/Lagos')::date between v_from and v_to;
  select count(*) into v_n from jsonb_array_elements(v_led) e where e ->> 'kind' = 'extras_payment';
  if v_n <> v_exp or v_n = 0 then raise exception 'FAIL extras payments: ledger % vs table %', v_n, v_exp; end if;
  select count(*) into v_exp from refunds where property_id = a2 and refund_status = 'succeeded' and completed_at is not null and (completed_at at time zone 'Africa/Lagos')::date between v_from and v_to;
  select count(*) into v_n from jsonb_array_elements(v_led) e where e ->> 'kind' = 'refund';
  if v_n <> v_exp or v_n = 0 then raise exception 'FAIL refunds: ledger % vs table %', v_n, v_exp; end if;

  -- nothing the report does not count is listed: reversed payments, and refunds that are not succeeded
  if exists (select 1 from jsonb_array_elements(v_led) e join payments p on p.internal_reference = e ->> 'internal_reference' where e ->> 'kind' = 'booking_payment' and p.payment_status <> 'succeeded')
    then raise exception 'FAIL a payment that is not succeeded is listed'; end if;
  if exists (select 1 from jsonb_array_elements(v_led) e join folio_payments p on p.internal_reference = e ->> 'internal_reference' where e ->> 'kind' = 'extras_payment' and p.payment_status <> 'succeeded')
    then raise exception 'FAIL an extras payment that is not succeeded is listed'; end if;
  if exists (select 1 from jsonb_array_elements(v_led) e join refunds f on f.internal_reference = e ->> 'internal_reference' where e ->> 'kind' = 'refund' and f.refund_status <> 'succeeded')
    then raise exception 'FAIL a refund that is not succeeded is listed'; end if;
  if (select count(*) from payments where property_id = a2 and payment_status = 'reversed') = 0 or (select count(*) from refunds where property_id = a2 and refund_status in ('failed', 'rejected', 'requested')) = 0
    then raise exception 'FAIL the data holds no reversed payment or unfinished refund to prove the exclusion with'; end if;

  -- every listed amount is positive for money in and negative for money out, and every row names its booking
  if exists (select 1 from jsonb_array_elements(v_led) e where (e ->> 'kind' = 'refund') <> ((e ->> 'amount_minor')::bigint < 0) or (e ->> 'amount_minor')::bigint = 0)
    then raise exception 'FAIL a sign is wrong'; end if;
  if exists (select 1 from jsonb_array_elements(v_led) e where coalesce(e ->> 'booking_reference', '') = '' or coalesce(e ->> 'internal_reference', '') = '')
    then raise exception 'FAIL a row has no booking or internal reference'; end if;
  -- only this hotel's bookings
  if exists (select 1 from jsonb_array_elements(v_led) e join reservations r on r.booking_reference = e ->> 'booking_reference' where r.property_id <> a2)
    then raise exception 'FAIL another hotel''s booking is listed'; end if;
  raise notice 'PASS 193 ledger = day report for every day (cash in and refunds paid, hotel currency), row counts match the tables, reversed and unfinished entries excluded, signs and references right, only this hotel';
end $$;

-- 5. Each row is dated on the hotel's calendar day (Lagos, UTC+1), not the UTC day
do $$ declare
  a2 uuid := '00000000-0000-0000-0000-0000000000a2'; v_ref text; v_pid uuid; v_in boolean; v_day date;
begin
  begin
    perform t_sys();
    alter table payments disable trigger payments_guard_trg;
    select id, internal_reference into v_pid, v_ref from payments where property_id = a2 and payment_status = 'succeeded' order by id limit 1;
    perform t_sys();
    -- 22:59:59 UTC is 23:59:59 in Lagos: still the 10th. 23:00:00 UTC is midnight in Lagos: the 11th.
    update payments set received_at = timestamptz '2026-03-10 22:59:59+00' where id = v_pid;
    perform t_as('00000000-0000-0000-0000-00000000aa01');
    select entry_day into v_day from money_ledger(a2, date '2026-03-10', date '2026-03-10') where internal_reference = v_ref;
    if v_day is distinct from date '2026-03-10' then raise exception 'FAIL 22:59:59 UTC should be the 10th in Lagos, got %', v_day; end if;
    select exists (select 1 from money_ledger(a2, date '2026-03-11', date '2026-03-11') where internal_reference = v_ref) into v_in;
    if v_in then raise exception 'FAIL listed on the 11th too'; end if;

    perform t_sys();
    update payments set received_at = timestamptz '2026-03-10 23:00:00+00' where id = v_pid;
    perform t_as('00000000-0000-0000-0000-00000000aa01');
    select entry_day into v_day from money_ledger(a2, date '2026-03-11', date '2026-03-11') where internal_reference = v_ref;
    if v_day is distinct from date '2026-03-11' then raise exception 'FAIL 23:00:00 UTC should be the 11th in Lagos, got %', v_day; end if;
    select exists (select 1 from money_ledger(a2, date '2026-03-10', date '2026-03-10') where internal_reference = v_ref) into v_in;
    if v_in then raise exception 'FAIL still listed on the 10th'; end if;
    raise exception 'ROLLBACK193';
  exception when others then if sqlerrm <> 'ROLLBACK193' then raise; end if;
  end;
  perform t_sys();
  raise notice 'PASS 193 days are the hotel''s: 22:59:59 UTC is still the 10th in Lagos, 23:00:00 UTC is the 11th, and a range asks for the hotel day';
end $$;

-- 6. A booking payment that was a share of one company payment says which, so the bank line can be matched
do $$ declare
  a2 uuid := '00000000-0000-0000-0000-0000000000a2'; a1 uuid := '00000000-0000-0000-0000-0000000000a1'; t date := property_today('00000000-0000-0000-0000-0000000000a2');
  g uuid; gp uuid; pay record; v_ref text; v_got text; v_other integer;
begin
  begin
    perform t_sys();
    select id into g from group_bookings where property_id = a2 order by id limit 1;
    select p.id, p.reservation_id, p.amount_minor, p.internal_reference into pay from payments p
     where p.property_id = a2 and p.payment_status = 'succeeded' and (p.received_at at time zone 'Africa/Lagos')::date between t - 300 and t + 66
       and not exists (select 1 from group_payment_lines where payment_id = p.id) order by p.id limit 1;
    insert into group_payments (tenant_id, property_id, group_id, amount_minor, method, reference)
      values (a1, a2, g, pay.amount_minor, 'bank_transfer', 'BANK-REF-193') returning id into gp;
    insert into group_payment_lines (tenant_id, property_id, group_payment_id, reservation_id, payment_id, amount_minor)
      values (a1, a2, gp, pay.reservation_id, pay.id, pay.amount_minor);
    perform t_as('00000000-0000-0000-0000-00000000aa01');
    select l.group_reference into v_got from money_ledger(a2, t - 300, t + 66) l where l.internal_reference = pay.internal_reference;
    if v_got is distinct from 'BANK-REF-193' then raise exception 'FAIL group reference is %', v_got; end if;
    select count(*) into v_other from money_ledger(a2, t - 300, t + 66) l where l.group_reference is not null and l.internal_reference <> pay.internal_reference;
    if v_other <> 0 then raise exception 'FAIL % other rows carry a group reference', v_other; end if;
    -- listed once: joining the group tables did not multiply the row
    if (select count(*) from money_ledger(a2, t - 300, t + 66) l where l.internal_reference = pay.internal_reference) <> 1 then raise exception 'FAIL the row is listed more than once'; end if;
    raise exception 'ROLLBACK193';
  exception when others then if sqlerrm <> 'ROLLBACK193' then raise; end if;
  end;
  perform t_sys();
  raise notice 'PASS 193 a share of a company payment carries that payment''s reference, other rows carry none, and no row is listed twice';
end $$;
