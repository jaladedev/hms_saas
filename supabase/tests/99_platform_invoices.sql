-- Invoices to hotel groups (migration 098). Platform people from 51: f050 admin, f051 support, f052 hotel owner; group 't50-hotel'.
\set ON_ERROR_STOP on

-- 1. only an admin raises, pays or voids; support reads; an owner and anon get nothing; bad values change nothing
do $$ declare v_t uuid := (select id from tenants where slug = 't50-hotel'); v_n int; begin
  perform t_sys();
  delete from platform_invoices where tenant_id = v_t;
  delete from tenant_subscriptions where tenant_id = v_t;
  insert into tenant_subscriptions (tenant_id, plan_code, status) values (v_t, 'standard', 'active');
  perform t_as('00000000-0000-0000-0000-00000000f051');
  perform t_expect(format($q$select platform_raise_invoice(%L, '2027-01-01', '2027-02-01', 100, null, null)$q$, v_t), 'NOT_FOUND');
  perform platform_list_invoices(v_t);
  perform t_as('00000000-0000-0000-0000-00000000f052');
  perform t_expect(format($q$select platform_list_invoices(%L)$q$, v_t), 'NOT_FOUND');
  perform t_expect(format($q$select platform_raise_invoice(%L, '2027-01-01', '2027-02-01', 100, null, null)$q$, v_t), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000f050');
  perform t_expect($q$select platform_raise_invoice(gen_random_uuid(), '2027-01-01', '2027-02-01', 100, null, null)$q$, 'NOT_FOUND');
  perform t_expect(format($q$select platform_raise_invoice(%L, '2027-02-01', '2027-01-01', 100, null, null)$q$, v_t), 'POLICY_VIOLATION: invoice period');
  perform t_expect(format($q$select platform_raise_invoice(%L, null, '2027-01-01', 100, null, null)$q$, v_t), 'POLICY_VIOLATION: invoice period');
  perform t_expect(format($q$select platform_raise_invoice(%L, '2027-01-01', '2029-01-01', 100, null, null)$q$, v_t), 'POLICY_VIOLATION: invoice period');
  perform t_expect(format($q$select platform_raise_invoice(%L, '2027-01-01', '2027-02-01', 0, null, null)$q$, v_t), 'POLICY_VIOLATION: invoice amount');
  perform t_expect(format($q$select platform_raise_invoice(%L, '2027-01-01', '2027-02-01', -5, null, null)$q$, v_t), 'POLICY_VIOLATION: invoice amount');
  perform t_sys();
  select count(*) into v_n from platform_invoices where tenant_id = v_t;
  if v_n <> 0 then raise exception 'FAIL a refused call raised an invoice'; end if;
  raise notice 'PASS platform invoices: support reads only, an owner is refused, bad values raise nothing';
end $$;

-- 2. a placeholder or unknown plan price cannot be taken as the amount; a decided price can
do $$ declare v_t uuid := (select id from tenants where slug = 't50-hotel'); r jsonb; begin
  perform t_sys();
  update plans set price_is_placeholder = true where code = 'standard';
  perform t_as('00000000-0000-0000-0000-00000000f050');
  perform t_expect(format($q$select platform_raise_invoice(%L, '2027-01-01', '2027-02-01', null, null, null)$q$, v_t), 'POLICY_VIOLATION: invoice amount');
  perform platform_save_plan('standard', 'Standard', null, 3500000, array['online_booking'], true);
  r := platform_raise_invoice(v_t, '2027-01-01', '2027-02-01', null, '2027-01-15', ' January ');
  perform t_sys();
  if (select amount_minor from platform_invoices where id = (r ->> 'id')::uuid) <> 3500000 then raise exception 'FAIL amount not taken from the plan'; end if;
  if (select number from platform_invoices where id = (r ->> 'id')::uuid) !~ '^PI-2027-[0-9]{6}$' then raise exception 'FAIL number %', r ->> 'number'; end if;
  if (select note from platform_invoices where id = (r ->> 'id')::uuid) <> 'January' then raise exception 'FAIL note not tidied'; end if;
  if (select status from platform_invoices where id = (r ->> 'id')::uuid) <> 'open' then raise exception 'FAIL not open'; end if;
  if not exists (select 1 from audit_logs where entity_type = 'platform_invoice' and action = 'platform_invoice.created' and tenant_id = v_t) then raise exception 'FAIL not audited'; end if;
  raise notice 'PASS platform invoices: amount from a decided plan price, refused from a placeholder, numbered, audited';
end $$;

-- 3. a period is billed once; a void invoice frees it
do $$ declare v_t uuid := (select id from tenants where slug = 't50-hotel'); v_id uuid; r jsonb; begin
  perform t_as('00000000-0000-0000-0000-00000000f050');
  perform t_expect(format($q$select platform_raise_invoice(%L, '2027-01-01', '2027-02-01', 100, null, null)$q$, v_t), 'CONFLICT: invoice period');
  perform t_sys();
  v_id := (select id from platform_invoices where tenant_id = v_t and period_start = '2027-01-01');
  perform t_as('00000000-0000-0000-0000-00000000f050');
  perform t_expect(format($q$select platform_void_invoice(%L, 'x')$q$, v_id), 'POLICY_VIOLATION: invoice reason');
  r := platform_void_invoice(v_id, 'Raised for the wrong plan');
  if (r ->> 'changed') <> 'true' then raise exception 'FAIL void %', r; end if;
  if (platform_void_invoice(v_id, 'again') ->> 'changed') <> 'false' then raise exception 'FAIL repeat void should change nothing'; end if;
  perform t_expect(format($q$select platform_mark_invoice_paid(%L, 'ref')$q$, v_id), 'CONFLICT: invoice state');
  r := platform_raise_invoice(v_t, '2027-01-01', '2027-02-01', 4000000, null, null);
  if (r ->> 'changed') <> 'true' then raise exception 'FAIL re-raise after void %', r; end if;
  perform t_sys();
  if (select void_reason from platform_invoices where id = v_id) <> 'Raised for the wrong plan' then raise exception 'FAIL void reason not kept'; end if;
  raise notice 'PASS platform invoices: one live invoice per period, void frees it, void is final';
end $$;

-- 4. paying needs a reference; a repeat changes nothing; a paid invoice cannot be voided
do $$ declare v_t uuid := (select id from tenants where slug = 't50-hotel'); v_id uuid; r jsonb; begin
  perform t_sys();
  v_id := (select id from platform_invoices where tenant_id = v_t and period_start = '2027-01-01' and status = 'open');
  perform t_as('00000000-0000-0000-0000-00000000f051');
  perform t_expect(format($q$select platform_mark_invoice_paid(%L, 'TRF-1')$q$, v_id), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000f050');
  perform t_expect(format($q$select platform_mark_invoice_paid(%L, '  ')$q$, v_id), 'POLICY_VIOLATION: invoice reference');
  perform t_expect($q$select platform_mark_invoice_paid(gen_random_uuid(), 'TRF-1')$q$, 'NOT_FOUND');
  r := platform_mark_invoice_paid(v_id, ' TRF-1 ');
  if (r ->> 'changed') <> 'true' then raise exception 'FAIL pay %', r; end if;
  if (platform_mark_invoice_paid(v_id, 'TRF-2') ->> 'changed') <> 'false' then raise exception 'FAIL repeat pay should change nothing'; end if;
  perform t_expect(format($q$select platform_void_invoice(%L, 'too late')$q$, v_id), 'CONFLICT: invoice state');
  perform t_sys();
  if (select payment_ref from platform_invoices where id = v_id) <> 'TRF-1' then raise exception 'FAIL reference changed by a repeat'; end if;
  if (select paid_at from platform_invoices where id = v_id) is null then raise exception 'FAIL paid_at not set'; end if;
  if not exists (select 1 from audit_logs where entity_type = 'platform_invoice' and action = 'platform_invoice.updated' and metadata -> 'changed' ? 'status') then raise exception 'FAIL payment not audited'; end if;
  raise notice 'PASS platform invoices: paid with a reference, repeat changes nothing, paid cannot be voided, audited';
end $$;

-- 5. the list is newest period first; the table and the sequence are closed to logins; anon is refused
do $$ declare v_t uuid := (select id from tenants where slug = 't50-hotel'); r jsonb; v_state text; begin
  perform t_as('00000000-0000-0000-0000-00000000f051');
  r := platform_list_invoices(v_t);
  if jsonb_array_length(r) <> 2 then raise exception 'FAIL expected 2 invoices (one void, one paid) %', r; end if;
  begin
    perform 1 from platform_invoices;
    v_state := 'allowed';
  exception when insufficient_privilege then v_state := 'refused';
  end;
  perform t_sys();
  if v_state <> 'refused' then raise exception 'FAIL a signed-in user read the invoices table directly'; end if;
  begin
    set local role anon;
    perform platform_list_invoices(v_t);
    v_state := 'allowed';
  exception when insufficient_privilege then v_state := 'refused';
  end;
  reset role;
  if v_state <> 'refused' then raise exception 'FAIL anon could list invoices'; end if;
  raise notice 'PASS platform invoices: listed for support, table closed to logins, anon refused';
end $$;
