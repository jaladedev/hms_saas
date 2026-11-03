-- Role isolation sweep: housekeeping (aa02) and maintenance (aa10, created in test 24) are working roles. They must
-- read rooms, tasks and their own screens, and nothing about guests, rates, tax, policy, money, email or the audit
-- trail. Every table that holds such data is read as each role: a count of zero, or a refusal, passes; any row fails.
-- The owner's count is checked first so the sweep cannot pass on empty tables. Runs after test 24 (needs aa10).
\set ON_ERROR_STOP on

do $$
declare
  c_tables constant text[] := array[
    'guests','reservations','reservation_rooms','reservation_nights','invoices','invoice_lines','payments',
    'payment_allocations','payment_attempts','payment_events','payment_provider_accounts','refunds','folio_charges',
    'folio_payments','rate_plans','daily_rates','room_types','tax_rules','property_policies','email_outbox',
    'audit_logs','idempotency_keys','invoice_sequences','tenant_subscriptions','tenant_feature_entitlements'];
  c_roles constant text[][] := array[['housekeeping','00000000-0000-0000-0000-00000000aa02'], ['maintenance','00000000-0000-0000-0000-00000000aa10']];
  c_must_have constant text[] := array['guests','reservations','reservation_nights','rate_plans','daily_rates','tax_rules','property_policies','room_types'];
  t text; i integer; n bigint; r text[];
begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');   -- owner A
  foreach t in array c_must_have loop
    execute format('select count(*) from %I', t) into n;
    if n = 0 then raise exception 'FAIL the owner sees no % rows, so the sweep would prove nothing', t; end if;
  end loop;

  for i in 1 .. array_length(c_roles, 1) loop
    perform t_as(c_roles[i][2]);
    foreach t in array c_tables loop
      begin
        execute format('select count(*) from %I', t) into n;
        if n <> 0 then raise exception 'FAIL % reads % rows of %', c_roles[i][1], n, t; end if;
      exception when insufficient_privilege then null;
      end;
    end loop;
    -- and what they do need
    execute 'select count(*) from rooms' into n;
    if n = 0 then raise exception 'FAIL % cannot see rooms', c_roles[i][1]; end if;
  end loop;
  perform t_sys();
  raise notice 'PASS housekeeping and maintenance read no guest, rate, tax, policy, money, email or audit data';
end $$;
