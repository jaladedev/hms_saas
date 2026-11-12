-- Online payment of a platform invoice (migration 117). Hotel A (a1 / a2): owner aa01, front desk aa04; other hotel's owner bb01.
\set ON_ERROR_STOP on

do $$ declare
  prop uuid := '00000000-0000-0000-0000-0000000000a2'; v_t uuid := '00000000-0000-0000-0000-0000000000a1';
  owner text := '00000000-0000-0000-0000-00000000aa01'; fd text := '00000000-0000-0000-0000-00000000aa04'; other text := '00000000-0000-0000-0000-00000000bb01';
  v_inv uuid; v_inv2 uuid; v_other uuid; v_x uuid; s jsonb; s2 jsonb; r jsonb; n int;
begin
  perform t_sys();
  delete from platform_invoice_payments where invoice_id in (select id from platform_invoices where number like 'PI-T117-%');
  delete from platform_invoices where number like 'PI-T117-%';
  insert into platform_invoices (tenant_id, number, period_start, period_end, amount_minor, currency) values (v_t, 'PI-T117-A', '2032-01-01', '2032-02-01', 250000, 'NGN') returning id into v_inv;
  insert into platform_invoices (tenant_id, number, period_start, period_end, amount_minor, currency) values (v_t, 'PI-T117-B', '2032-02-01', '2032-03-01', 90000, 'NGN') returning id into v_inv2;
  select id into v_other from tenants where id <> v_t limit 1;
  insert into platform_invoices (tenant_id, number, period_start, period_end, amount_minor, currency) values (v_other, 'PI-T117-X', '2032-01-01', '2032-02-01', 1000, 'NGN') returning id into v_x;

  -- who may start
  perform t_as(fd);
  perform t_expect(format('select hotel_start_invoice_payment(%L, %L)', prop, v_inv), 'NOT_FOUND');
  perform t_as(other);
  perform t_expect(format('select hotel_start_invoice_payment(%L, %L)', prop, v_inv), 'NOT_FOUND');
  perform t_as(owner);
  perform t_expect(format('select hotel_start_invoice_payment(%L, %L)', prop, gen_random_uuid()), 'NOT_FOUND');
  perform t_expect(format('select hotel_start_invoice_payment(%L, %L)', gen_random_uuid(), v_inv), 'NOT_FOUND');
  perform t_expect(format('select hotel_start_invoice_payment(%L, %L)', prop, v_x), 'NOT_FOUND');   -- another group's invoice

  -- start: the amount and currency are the invoice's own
  s := hotel_start_invoice_payment(prop, v_inv);
  if (s ->> 'amount_minor')::bigint <> 250000 or s ->> 'currency' <> 'NGN' or s ->> 'reference' !~ '^PIP-[0-9a-f]{32}$' or coalesce(s ->> 'email', '') = '' then raise exception 'FAIL start %', s; end if;
  s2 := hotel_start_invoice_payment(prop, v_inv2);   -- used for the mismatch case below

  -- the database functions are for the server only
  begin
    perform settle_invoice_payment(s ->> 'reference', 'success', 250000, 'NGN');
    raise exception 'FAIL a login ran the settle function';
  exception when insufficient_privilege then null;
  end;

  perform t_sys();
  r := settle_invoice_payment('PIP-00000000000000000000000000000000', 'success', 1, 'NGN');
  if r ->> 'result' <> 'unknown' then raise exception 'FAIL unknown %', r; end if;
  -- not success: invoice stays open
  r := settle_invoice_payment(s ->> 'reference', 'abandoned', 250000, 'NGN');
  if r ->> 'result' <> 'not_success' or (select status from platform_invoices where id = v_inv) <> 'open' then raise exception 'FAIL abandoned %', r; end if;
  -- wrong amount: marked mismatch, nothing paid; repeat is a duplicate
  r := settle_invoice_payment(s2 ->> 'reference', 'success', 1, 'NGN');
  if r ->> 'result' <> 'mismatch' or (select status from platform_invoices where id = v_inv2) <> 'open' then raise exception 'FAIL mismatch %', r; end if;
  r := settle_invoice_payment(s2 ->> 'reference', 'success', 90000, 'NGN');
  if r ->> 'result' <> 'duplicate' or (select status from platform_invoices where id = v_inv2) <> 'open' then raise exception 'FAIL mismatch repeat %', r; end if;
  -- wrong currency on a fresh attempt
  perform t_as(owner);
  s2 := hotel_start_invoice_payment(prop, v_inv2);
  perform t_sys();
  r := settle_invoice_payment(s2 ->> 'reference', 'success', 90000, 'USD');
  if r ->> 'result' <> 'mismatch' then raise exception 'FAIL currency %', r; end if;

  -- success: paid, with the reference; a repeat changes nothing
  r := settle_invoice_payment(s ->> 'reference', 'success', 250000, 'NGN');
  if r ->> 'result' <> 'paid' then raise exception 'FAIL paid %', r; end if;
  if (select status from platform_invoices where id = v_inv) <> 'paid' or (select payment_ref from platform_invoices where id = v_inv) <> s ->> 'reference'
     or (select paid_at from platform_invoices where id = v_inv) is null then raise exception 'FAIL invoice not marked paid'; end if;
  r := settle_invoice_payment(s ->> 'reference', 'success', 250000, 'NGN');
  if r ->> 'result' <> 'duplicate' then raise exception 'FAIL repeat %', r; end if;

  -- a paid invoice cannot be paid again
  perform t_as(owner);
  perform t_expect(format('select hotel_start_invoice_payment(%L, %L)', prop, v_inv), 'CONFLICT: invoice state');

  -- money taken after an admin already recorded the invoice: invoice_closed, the invoice is untouched
  s := hotel_start_invoice_payment(prop, v_inv2);
  perform t_sys();
  update platform_invoices set status = 'paid', paid_at = now(), payment_ref = 'by hand' where id = v_inv2;
  r := settle_invoice_payment(s ->> 'reference', 'success', 90000, 'NGN');
  if r ->> 'result' <> 'invoice_closed' or (select payment_ref from platform_invoices where id = v_inv2) <> 'by hand' then raise exception 'FAIL closed %', r; end if;

  -- a failed charge marks the attempt failed
  update platform_invoices set status = 'open', paid_at = null, payment_ref = null where id = v_inv2;
  perform t_as(owner);
  s := hotel_start_invoice_payment(prop, v_inv2);
  perform t_sys();
  r := settle_invoice_payment(s ->> 'reference', 'failed', 90000, 'NGN');
  select count(*) into n from platform_invoice_payments where reference = s ->> 'reference' and status = 'failed';
  if r ->> 'result' <> 'not_success' or n <> 1 then raise exception 'FAIL failed %', r; end if;

  -- table closed to logins
  perform t_as(owner);
  begin
    perform count(*) from platform_invoice_payments;
    raise exception 'FAIL a login read the attempts table';
  exception when insufficient_privilege then null;
  end;
  reset role;
  perform t_sys();
  delete from platform_invoice_payments where invoice_id in (select id from platform_invoices where number like 'PI-T117-%');
  delete from platform_invoices where number like 'PI-T117-%';
  raise notice 'PASS invoice online payment: owner starts for the invoice''s own amount, settles once, mismatches and closed invoices are not marked paid';
end $$;
