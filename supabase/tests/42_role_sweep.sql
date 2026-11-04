-- Role sweep for the office roles: general manager, front desk, reservations officer and accountant (35 covers housekeeping
-- and maintenance). Four logins at Hotel A (tenant a1, property a2), one per role, granted for the whole tenant:
--   ab01 general manager, ab02 front desk, ab03 reservations officer, ab04 accountant.
-- 1. No role reads a single row of another hotel group, in any table that has a tenant_id (a refusal also passes).
-- 2. Roles whose job does not touch money, the audit trail, the email queue or the account behind the hotel read none of it.
-- 3. What each role may and may not do, by permission, so a change to the role matrix has to change this test too.
-- The owner's counts are checked first, so no sweep can pass on empty tables. Reuses t_as / t_sys / t_expect (05).
\set ON_ERROR_STOP on

insert into auth.users (id) values
  ('00000000-0000-0000-0000-00000000ab01'), ('00000000-0000-0000-0000-00000000ab02'),
  ('00000000-0000-0000-0000-00000000ab03'), ('00000000-0000-0000-0000-00000000ab04');
insert into tenant_memberships (id, tenant_id, user_id, status) values
  ('00000000-0000-0000-0000-0000000abb01', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000ab01', 'active'),
  ('00000000-0000-0000-0000-0000000abb02', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000ab02', 'active'),
  ('00000000-0000-0000-0000-0000000abb03', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000ab03', 'active'),
  ('00000000-0000-0000-0000-0000000abb04', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000ab04', 'active');
insert into membership_roles (membership_id, role_id, property_id)
select '00000000-0000-0000-0000-0000000abb01'::uuid, id, null::uuid from roles where key = 'general_manager'
union all select '00000000-0000-0000-0000-0000000abb02'::uuid, id, null::uuid from roles where key = 'front_desk'
union all select '00000000-0000-0000-0000-0000000abb03'::uuid, id, null::uuid from roles where key = 'reservations_officer'
union all select '00000000-0000-0000-0000-0000000abb04'::uuid, id, null::uuid from roles where key = 'accountant';

-- 1. Nothing of another hotel group is readable
do $$
declare
  c_roles constant text[][] := array[['general_manager','00000000-0000-0000-0000-00000000ab01'], ['front_desk','00000000-0000-0000-0000-00000000ab02'],
    ['reservations_officer','00000000-0000-0000-0000-00000000ab03'], ['accountant','00000000-0000-0000-0000-00000000ab04']];
  c_a constant uuid := '00000000-0000-0000-0000-0000000000a1';
  t text; i integer; n bigint; v_tables text[]; v_other bigint := 0; v_checked integer := 0;
begin
  select array_agg(c.table_name order by c.table_name) into v_tables
    from information_schema.columns c join information_schema.tables x on x.table_schema = c.table_schema and x.table_name = c.table_name
   where c.table_schema = 'public' and c.column_name = 'tenant_id' and x.table_type = 'BASE TABLE';
  if coalesce(array_length(v_tables, 1), 0) < 25 then raise exception 'FAIL the sweep found only % tables with a tenant_id', coalesce(array_length(v_tables, 1), 0); end if;

  perform t_sys();
  foreach t in array v_tables loop
    execute format('select count(*) from %I where tenant_id <> $1', t) using c_a into n;
    v_other := v_other + n;
  end loop;
  if v_other = 0 then raise exception 'FAIL there is no data of another hotel group, so the sweep would prove nothing'; end if;
  foreach t in array array['guests','rooms','room_types','audit_logs','properties'] loop
    execute format('select count(*) from %I where tenant_id <> $1', t) using c_a into n;
    if n = 0 then raise exception 'FAIL no other-group rows in %, so that table proves nothing', t; end if;
  end loop;

  for i in 1 .. array_length(c_roles, 1) loop
    perform t_as(c_roles[i][2]);
    foreach t in array v_tables loop
      begin
        execute format('select count(*) from %I where tenant_id <> $1', t) using c_a into n;
        if n <> 0 then raise exception 'FAIL % reads % rows of another hotel group in %', c_roles[i][1], n, t; end if;
        v_checked := v_checked + 1;
      exception when insufficient_privilege then null;
      end;
    end loop;
    perform t_sys();
  end loop;
  if v_checked < 100 then raise exception 'FAIL only % table reads were checked: the roles are being refused everything', v_checked; end if;
  raise notice 'PASS no office role reads a row of another hotel group in any of % tables', array_length(v_tables, 1);
end $$;

-- 2. Data a role has no reason to see
do $$
declare
  c_a constant uuid := '00000000-0000-0000-0000-0000000000a1';
  -- who may not read what; every role is also kept away from the keys, the account and the subscription
  c_always constant text[] := array['idempotency_keys','invoice_sequences','tenant_subscriptions','tenant_feature_entitlements','payment_provider_accounts','payment_events'];
  c_money constant text[] := array['payments','payment_allocations','payment_attempts','refunds','invoices','invoice_lines','folio_charges','folio_payments'];
  v_must constant text[] := array['payments','invoices','refunds','audit_logs'];
  t text; n bigint; v_role text; v_user text; v_deny text[]; i integer;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');   -- owner A
  foreach t in array v_must loop
    execute format('select count(*) from %I', t) into n;
    if n = 0 then raise exception 'FAIL the owner sees no % rows, so the sweep would prove nothing', t; end if;
  end loop;
  perform t_sys();

  for i in 1 .. 4 loop
    v_role := (array['general_manager','front_desk','reservations_officer','accountant'])[i];
    v_user := (array['00000000-0000-0000-0000-00000000ab01','00000000-0000-0000-0000-00000000ab02','00000000-0000-0000-0000-00000000ab03','00000000-0000-0000-0000-00000000ab04'])[i];
    v_deny := c_always;
    -- the audit trail is for the owner and the general manager; the email queue is for people who run the desk
    if v_role in ('front_desk','reservations_officer','accountant') then v_deny := v_deny || array['audit_logs']; end if;
    if v_role in ('reservations_officer','accountant') then v_deny := v_deny || array['email_outbox']; end if;
    -- a reservations officer takes bookings and does not touch money
    if v_role = 'reservations_officer' then v_deny := v_deny || c_money; end if;
    perform t_as(v_user);
    foreach t in array v_deny loop
      begin
        execute format('select count(*) from %I', t) into n;
        if n <> 0 then raise exception 'FAIL % reads % rows of %', v_role, n, t; end if;
      exception when insufficient_privilege then null;
      end;
    end loop;
    perform t_sys();
  end loop;
  raise notice 'PASS office roles read no keys, provider account, subscription, and (by role) no audit trail, email queue or money they have no use for';
end $$;

-- 3. What each role may and may not do
do $$
declare
  a constant uuid := '00000000-0000-0000-0000-0000000000a2';
  gm constant text := '00000000-0000-0000-0000-00000000ab01'; fd constant text := '00000000-0000-0000-0000-00000000ab02';
  ro constant text := '00000000-0000-0000-0000-00000000ab03'; ac constant text := '00000000-0000-0000-0000-00000000ab04';
  p text;
begin
  -- general manager: everything except managing who has access
  perform t_as(gm);
  foreach p in array array['reservation.create','reservation.cancel','refund.approve','report.view','audit.view','property.configure','rate.manage','folio.charge'] loop
    if not has_permission(a, p) then raise exception 'FAIL the general manager lacks %', p; end if;
  end loop;
  if has_permission(a, 'staff.manage') then raise exception 'FAIL the general manager can manage staff'; end if;

  -- front desk: runs the desk and takes money, does not approve refunds, report, audit, configure or manage staff
  perform t_as(fd);
  foreach p in array array['reservation.create','reservation.checkin','reservation.checkout','payment.record','invoice.issue','guest.manage'] loop
    if not has_permission(a, p) then raise exception 'FAIL front desk lacks %', p; end if;
  end loop;
  foreach p in array array['refund.approve','refund.request','invoice.void','report.view','report.export','audit.view','property.configure','rate.manage','staff.manage','reservation.cancel','payment.verify'] loop
    if has_permission(a, p) then raise exception 'FAIL front desk holds %', p; end if;
  end loop;

  -- reservations officer: bookings and guests, no money, no check-in or check-out, no reports
  perform t_as(ro);
  foreach p in array array['reservation.create','reservation.modify','reservation.cancel','guest.manage','rate.view'] loop
    if not has_permission(a, p) then raise exception 'FAIL the reservations officer lacks %', p; end if;
  end loop;
  foreach p in array array['payment.record','payment.verify','invoice.issue','invoice.void','refund.request','refund.approve','reservation.checkin','reservation.checkout',
                           'report.view','audit.view','property.configure','rate.manage','staff.manage','folio.charge'] loop
    if has_permission(a, p) then raise exception 'FAIL the reservations officer holds %', p; end if;
  end loop;

  -- accountant: money and reports, does not take bookings, run the desk or change setup
  perform t_as(ac);
  foreach p in array array['payment.record','payment.verify','refund.request','refund.approve','invoice.issue','invoice.void','report.view','report.export'] loop
    if not has_permission(a, p) then raise exception 'FAIL the accountant lacks %', p; end if;
  end loop;
  foreach p in array array['reservation.create','reservation.modify','reservation.cancel','reservation.checkin','reservation.checkout','room.assign','room.block',
                           'guest.manage','audit.view','property.configure','rate.manage','staff.manage','housekeeping.update','maintenance.manage','folio.charge'] loop
    if has_permission(a, p) then raise exception 'FAIL the accountant holds %', p; end if;
  end loop;
  perform t_sys();
  raise notice 'PASS each office role holds the permissions of its job and none of the ones that belong to another';
end $$;

-- 4. The same limits hold when a role calls the operations, not only when it reads
do $$
declare r uuid := '00000000-0000-0000-0000-000000000000';
begin
  perform t_as('00000000-0000-0000-0000-00000000ab04');   -- accountant cannot book
  perform t_expect($q$select create_reservation('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a9', 'walk_in', current_date + 2000, current_date + 2001, '[]'::jsonb, 'sweep-ac-1')$q$, 'FORBIDDEN');
  perform t_as('00000000-0000-0000-0000-00000000ab03');   -- reservations officer cannot take money
  perform t_expect(format($q$select record_manual_payment(%L, 100, 'cash', null, null, 'sweep-ro-1')$q$, (select id from reservations where property_id = '00000000-0000-0000-0000-0000000000a2' limit 1)), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000ab02');   -- front desk cannot approve a refund
  perform t_expect(format($q$select approve_refund(%L, true, null, 'sweep-fd-1')$q$, r), 'NOT_FOUND');
  perform t_sys();
  raise notice 'PASS an accountant cannot book, a reservations officer cannot take money and front desk cannot approve a refund';
end $$;
