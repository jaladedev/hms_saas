-- Property-scoped roles. Hotel C (tenant c1, created in 06) has two properties, c2 and c3. A role granted on one property
-- must give nothing on the other. Reuses t_as / t_sys / t_expect (05).
--   cc01 front desk on c2 only, cc02 accountant on c3 only, cc03 owner on every property of the tenant.
-- Each property gets one pending reservation, written as the system.
\set ON_ERROR_STOP on

insert into auth.users (id) values ('00000000-0000-0000-0000-00000000cc01'), ('00000000-0000-0000-0000-00000000cc02'), ('00000000-0000-0000-0000-00000000cc03');
insert into tenant_memberships (id, tenant_id, user_id, status) values
  ('00000000-0000-0000-0000-0000000ccc01', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-00000000cc01', 'active'),
  ('00000000-0000-0000-0000-0000000ccc02', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-00000000cc02', 'active'),
  ('00000000-0000-0000-0000-0000000ccc03', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-00000000cc03', 'active');
insert into membership_roles (membership_id, role_id, property_id)
select '00000000-0000-0000-0000-0000000ccc01'::uuid, id, '00000000-0000-0000-0000-0000000000c2'::uuid from roles where key = 'front_desk'
union all select '00000000-0000-0000-0000-0000000ccc02'::uuid, id, '00000000-0000-0000-0000-0000000000c3'::uuid from roles where key = 'accountant'
union all select '00000000-0000-0000-0000-0000000ccc03'::uuid, id, null::uuid from roles where key = 'owner';

insert into guests (id, tenant_id, full_name) values ('00000000-0000-0000-0000-0000000000c9', '00000000-0000-0000-0000-0000000000c1', 'Guest C');
insert into reservations (id, tenant_id, property_id, booking_reference, primary_guest_id, source, arrival_date, departure_date, subtotal_minor, total_minor) values
  ('00000000-0000-0000-0000-000000000c21', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c2', 'HC1-SCOPE-1', '00000000-0000-0000-0000-0000000000c9', 'walk_in', current_date + 1500, current_date + 1501, 1000000, 1000000),
  ('00000000-0000-0000-0000-000000000c31', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3', 'HC2-SCOPE-1', '00000000-0000-0000-0000-0000000000c9', 'walk_in', current_date + 1500, current_date + 1501, 1000000, 1000000);

-- 1. What each person's role answers for each property
do $$ declare c2 constant uuid := '00000000-0000-0000-0000-0000000000c2'; c3 constant uuid := '00000000-0000-0000-0000-0000000000c3'; begin
  perform t_as('00000000-0000-0000-0000-00000000cc01');
  if not has_permission(c2, 'reservation.view') then raise exception 'FAIL front desk on c2 cannot view reservations at c2'; end if;
  if has_permission(c3, 'reservation.view') or has_permission(c3, 'payment.record') then raise exception 'FAIL a role scoped to c2 answers at c3'; end if;
  perform t_as('00000000-0000-0000-0000-00000000cc02');
  if not has_permission(c3, 'report.view') then raise exception 'FAIL accountant on c3 cannot report at c3'; end if;
  if has_permission(c2, 'report.view') then raise exception 'FAIL a role scoped to c3 answers at c2'; end if;
  perform t_as('00000000-0000-0000-0000-00000000cc03');
  if not (has_permission(c2, 'report.view') and has_permission(c3, 'report.view')) then raise exception 'FAIL an unscoped owner lacks a property'; end if;
  perform t_sys();
  raise notice 'PASS a scoped role answers only for its own property; an unscoped owner for all';
end $$;

-- 2. What they can read
do $$ declare ids text; begin
  perform t_as('00000000-0000-0000-0000-00000000cc01');
  select string_agg(booking_reference, ',' order by booking_reference) into ids from reservations where tenant_id = '00000000-0000-0000-0000-0000000000c1';
  if ids is distinct from 'HC1-SCOPE-1' then raise exception 'FAIL front desk on c2 reads reservations: %', ids; end if;
  perform t_as('00000000-0000-0000-0000-00000000cc02');
  select string_agg(booking_reference, ',' order by booking_reference) into ids from reservations where tenant_id = '00000000-0000-0000-0000-0000000000c1';
  if ids is distinct from 'HC2-SCOPE-1' then raise exception 'FAIL accountant on c3 reads reservations: %', ids; end if;
  perform t_as('00000000-0000-0000-0000-00000000cc03');
  select string_agg(booking_reference, ',' order by booking_reference) into ids from reservations where tenant_id = '00000000-0000-0000-0000-0000000000c1';
  if ids is distinct from 'HC1-SCOPE-1,HC2-SCOPE-1' then raise exception 'FAIL unscoped owner reads %', ids; end if;
  perform t_sys();
  raise notice 'PASS reads follow the property the role was granted on';
end $$;

-- 3. What they can do
do $$ declare c2 constant text := '00000000-0000-0000-0000-0000000000c2'; c3 constant text := '00000000-0000-0000-0000-0000000000c3'; begin
  perform t_as('00000000-0000-0000-0000-00000000cc01');
  perform t_expect(format('select record_manual_payment(%L, 1000, ''cash'', null, null, ''sc-1'')', '00000000-0000-0000-0000-000000000c31'), 'NOT_FOUND');
  perform t_expect(format('select * from daily_report(%L, current_date, current_date)', c2), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000cc02');
  if (select count(*) from daily_report(c3::uuid, current_date, current_date + 1)) <> 2 then raise exception 'FAIL accountant on c3 cannot report at c3'; end if;
  perform t_expect(format('select * from daily_report(%L, current_date, current_date)', c2), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000cc03');
  if (select count(*) from daily_report(c2::uuid, current_date, current_date)) <> 1 or (select count(*) from daily_report(c3::uuid, current_date, current_date)) <> 1
    then raise exception 'FAIL an unscoped owner cannot report on both properties'; end if;
  perform t_sys();
  if exists (select 1 from payments where reservation_id = '00000000-0000-0000-0000-000000000c31') then raise exception 'FAIL a refused payment left a row'; end if;
  raise notice 'PASS actions and reports are refused at a property the role was not granted on';
end $$;
