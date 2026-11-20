-- Spa, gym and laundry services (migration 151). Reuses t_as / t_sys / t_expect / t_book / t_rr (05) and t21_free_room / t21_room (21).
-- Users: aa01 owner A, aa02 housekeeping A (no services access), aa04 front desk A (view and book), aa05 accountant A (view, report), bb01 owner of Hotel B.
\set ON_ERROR_STOP on

create table t151_ctx (label text primary key, val text not null);
create function t151(p_label text) returns uuid language sql stable as $$ select val::uuid from t151_ctx where label = p_label $$;
create function t151_audits(p_action text, p_entity uuid) returns bigint language sql stable as $$ select count(*) from audit_logs where action = p_action and entity_id = p_entity $$;

-- 1. Grants and flag
do $$ declare v_n integer; begin
  perform t_sys();
  select count(*) into v_n from role_permissions rp join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id
   where p.key = 'services.view' and r.is_system and r.key in ('owner', 'general_manager', 'front_desk', 'accountant');
  if v_n <> 4 then raise exception 'FAIL services.view grants (%)', v_n; end if;
  select count(*) into v_n from role_permissions rp join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id
   where p.key = 'services.book' and r.is_system and r.key in ('owner', 'general_manager', 'front_desk');
  if v_n <> 3 then raise exception 'FAIL services.book grants (%)', v_n; end if;
  select count(*) into v_n from role_permissions rp join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id
   where p.key = 'services.manage' and r.is_system and r.key in ('owner', 'general_manager');
  if v_n <> 2 then raise exception 'FAIL services.manage grants (%)', v_n; end if;
  if exists (select 1 from role_permissions rp join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id
              where p.key like 'services.%' and r.is_system and r.key in ('housekeeping')) then raise exception 'FAIL housekeeping has services access'; end if;
  if not ('guest_services' = any (plan_enforced_flags())) then raise exception 'FAIL guest_services is not an enforced flag'; end if;
  if not (select 'guest_services' = any (features) from plans where code = 'pro') or (select 'guest_services' = any (features) from plans where code = 'starter') then raise exception 'FAIL plan features'; end if;
  raise notice 'PASS grants: view for four roles, book for three, manage for two; guest_services is enforced and on the pro plan only';
end $$;

-- 2. Catalog
do $$ declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select service_save(%L, null, ''Massage'', ''spa'', 2500000, 60, 1, true)', v_p), 'NOT_FOUND');        -- book is not manage
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select service_save(%L, null, ''Massage'', ''spa'', 2500000, 60, 1, true)', v_p), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select service_save(%L, null, '''', ''spa'', 2500000, 60, 1, true)', v_p), 'POLICY_VIOLATION: name');
  perform t_expect(format('select service_save(%L, null, ''X'', ''pool'', 2500000, 60, 1, true)', v_p), 'POLICY_VIOLATION: kind');
  perform t_expect(format('select service_save(%L, null, ''X'', ''spa'', 0, 60, 1, true)', v_p), 'POLICY_VIOLATION: price');
  perform t_expect(format('select service_save(%L, null, ''X'', ''spa'', 100, 3, 1, true)', v_p), 'POLICY_VIOLATION: duration');
  perform t_expect(format('select service_save(%L, null, ''X'', ''spa'', 100, 60, 0, true)', v_p), 'POLICY_VIOLATION: capacity');
  insert into t151_ctx values ('massage', service_save(v_p, null, 'Massage', 'spa', 2500000, 60, 1, true) ->> 'service_id');
  insert into t151_ctx values ('gym', service_save(v_p, null, 'Gym session', 'gym', 500000, 30, 3, true) ->> 'service_id');
  insert into t151_ctx values ('laundry', service_save(v_p, null, 'Laundry bag', 'laundry', 800000, null, 1, true) ->> 'service_id');
  insert into t151_ctx values ('off', service_save(v_p, null, 'Old sauna', 'spa', 100000, 30, 1, false) ->> 'service_id');
  perform t_expect(format('select service_save(%L, null, ''massage'', ''spa'', 100, 60, 1, true)', v_p), 'POLICY_VIOLATION: name taken');
  perform service_save(v_p, t151('massage'), 'Massage', 'spa', 2600000, 60, 1, true);
  if (select price_minor from hotel_services where id = t151('massage')) <> 2600000 then raise exception 'FAIL edit'; end if;
  perform service_save(v_p, t151('massage'), 'Massage', 'spa', 2500000, 60, 1, true);
  perform t_expect(format('select service_save(%L, %L, ''X'', ''spa'', 100, 60, 1, true)', v_p, gen_random_uuid()), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  if (select count(*) from hotel_services) <> 4 then raise exception 'FAIL front desk reads the catalog'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  if (select count(*) from hotel_services) <> 0 then raise exception 'FAIL housekeeping reads the catalog'; end if;
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  if (select count(*) from hotel_services) <> 0 then raise exception 'FAIL hotel B reads the catalog'; end if;
  perform t_sys();
  begin delete from hotel_services where id = t151('off'); raise exception 'FAIL a service was deleted'; exception when sqlstate 'P0001' then null; end;
  if t151_audits('hotel_service.saved', t151('massage')) <> 3 then raise exception 'FAIL audits'; end if;
  raise notice 'PASS catalog: manage only, values checked, names unique, hotels apart, never deleted, audited';
end $$;

-- 3. Booking, slots and capacity
do $$ declare
  v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_start timestamp := date_trunc('hour', localtimestamp) + interval '3 days'; r jsonb; r2 jsonb;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform t_expect(format('select service_book(%L, %L, null, ''Walk-in'', %L, 1, null, ''s-0'')', v_p, t151('massage'), v_start), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  perform t_expect(format('select service_book(%L, %L, null, ''Walk-in'', %L, 1, null, ''s-0'')', v_p, t151('massage'), v_start), 'NOT_FOUND');   -- view only
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select service_book(%L, %L, null, ''Walk-in'', %L, 1, null, ''s-1'')', v_p, t151('off'), v_start), 'POLICY_VIOLATION: service');
  perform t_expect(format('select service_book(%L, %L, null, null, %L, 1, null, ''s-1'')', v_p, t151('massage'), v_start), 'POLICY_VIOLATION: guest');
  perform t_expect(format('select service_book(%L, %L, null, ''Walk-in'', null, 1, null, ''s-1'')', v_p, t151('massage')), 'POLICY_VIOLATION: time');
  perform t_expect(format('select service_book(%L, %L, null, ''Walk-in'', %L, 1, null, ''s-1'')', v_p, t151('massage'), now() - interval '2 days'), 'POLICY_VIOLATION: time');
  perform t_expect(format('select service_book(%L, %L, null, ''Walk-in'', %L, 0, null, ''s-1'')', v_p, t151('massage'), v_start), 'POLICY_VIOLATION: quantity');
  perform t_expect(format('select service_book(%L, %L, %L, null, %L, 1, null, ''s-1'')', v_p, t151('massage'), gen_random_uuid(), v_start), 'POLICY_VIOLATION: guest');

  r := service_book(v_p, t151('massage'), null, 'Walk-in Ade', v_start, 1, 'oil allergy: none', 's-2');
  r2 := service_book(v_p, t151('massage'), null, 'Walk-in Ade', v_start, 1, 'oil allergy: none', 's-2');
  if r <> r2 or (r ->> 'total_minor')::bigint <> 2500000 then raise exception 'FAIL booking replay %', r; end if;
  insert into t151_ctx values ('walkin', r ->> 'booking_id');
  if (select count(*) from service_bookings) <> 1 then raise exception 'FAIL replay wrote twice'; end if;
  -- capacity 1: the same hour, and a start that overlaps, are full; the next hour is free
  perform t_expect(format('select service_book(%L, %L, null, ''Other'', %L, 1, null, ''s-3'')', v_p, t151('massage'), v_start), 'POLICY_VIOLATION: slot full');
  perform t_expect(format('select service_book(%L, %L, null, ''Other'', %L, 1, null, ''s-3'')', v_p, t151('massage'), v_start + interval '30 minutes'), 'POLICY_VIOLATION: slot full');
  perform t_expect(format('select service_book(%L, %L, null, ''Other'', %L, 1, null, ''s-3'')', v_p, t151('massage'), v_start - interval '30 minutes'), 'POLICY_VIOLATION: slot full');
  perform service_book(v_p, t151('massage'), null, 'Next hour', v_start + interval '1 hour', 1, null, 's-4');
  -- capacity 3 on the gym
  perform service_book(v_p, t151('gym'), null, 'G1', v_start, 2, null, 'g-1');
  perform service_book(v_p, t151('gym'), null, 'G2', v_start, 1, null, 'g-2');
  perform t_expect(format('select service_book(%L, %L, null, ''G3'', %L, 1, null, ''g-3'')', v_p, t151('gym'), v_start), 'POLICY_VIOLATION: slot full');
  -- laundry has no slots at all
  perform service_book(v_p, t151('laundry'), null, 'L1', null, 1, null, 'l-1');
  perform service_book(v_p, t151('laundry'), null, 'L2', null, 1, null, 'l-2');
  -- a cancelled booking frees the slot
  perform service_booking_set(t151('walkin'), 'cancel', 'c-1');
  perform service_book(v_p, t151('massage'), null, 'Took the slot', v_start, 1, null, 's-5');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select service_book(%L, %L, null, ''X'', %L, 1, null, ''s-6'')', v_p, t151('massage'), v_start), 'NOT_FOUND');
  if (select count(*) from service_bookings) <> 0 then raise exception 'FAIL hotel B reads bookings'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  if (select count(*) from service_bookings) <> 0 then raise exception 'FAIL housekeeping reads bookings'; end if;
  perform t_sys();
  if t151_audits('service_booking.created', t151('walkin')) <> 1 then raise exception 'FAIL booking audit'; end if;
  raise notice 'PASS booking: book access, bad input refused, replay-safe, slot and capacity checked, laundry has no slots, cancelling frees the slot';
end $$;

-- 4. Steps, and posting to a folio
do $$ declare
  v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; t date := property_today('00000000-0000-0000-0000-0000000000a2');
  v_start timestamp := date_trunc('hour', localtimestamp) + interval '10 days';
  v_room text; v_book jsonb; v_rr uuid; v_res uuid; v_conf jsonb; v_b uuid; v_b2 uuid; v_b3 uuid; v_walk uuid; r jsonb; v_before bigint;
begin
  perform t_sys();
  v_room := t21_free_room();
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  v_book := t_book('00000000-0000-0000-0000-0000000000a3', t, t + 2, 't151-res-1', t21_room(v_room));
  v_rr := t_rr(v_book); v_res := (v_book ->> 'reservation_id')::uuid;
  -- booked but not yet in the house
  v_b := (service_book(v_p, t151('massage'), v_res, null, v_start, 1, null, 'st-1') ->> 'booking_id')::uuid;
  perform t_expect(format('select service_booking_set(%L, ''charge'', ''k1'')', v_b), 'INVALID_STATE');
  perform t_expect(format('select service_booking_set(%L, ''fly'', ''k1'')', v_b), 'POLICY_VIOLATION: action');
  perform check_in(v_rr, 'test');
  v_before := (select coalesce(sum(total_minor), 0) from folio_charges where reservation_id = v_res);
  r := service_booking_set(v_b, 'charge', 'k2');
  if r ->> 'status' <> 'charged' or r ->> 'charge_id' is null then raise exception 'FAIL charge %', r; end if;
  if not exists (select 1 from folio_charges where id = (r ->> 'charge_id')::uuid and reservation_id = v_res and category = 'other') then raise exception 'FAIL folio charge row'; end if;
  if (select coalesce(sum(total_minor), 0) from folio_charges where reservation_id = v_res) <= v_before then raise exception 'FAIL folio total did not grow'; end if;
  if service_booking_set(v_b, 'charge', 'k3') <> r then raise exception 'FAIL repeat charge answered differently'; end if;
  if (select count(*) from folio_charges where reservation_id = v_res) <> 1 then raise exception 'FAIL repeat charge posted twice'; end if;
  perform t_expect(format('select service_booking_set(%L, ''cancel'', ''k4'')', v_b), 'INVALID_STATE');
  -- laundry posts under its own category, quantity and price as booked
  v_b2 := (service_book(v_p, t151('laundry'), v_res, null, null, 2, null, 'st-2') ->> 'booking_id')::uuid;
  perform service_booking_set(v_b2, 'done', 'd-1');
  r := service_booking_set(v_b2, 'charge', 'k5');
  if not exists (select 1 from folio_charges where id = (r ->> 'charge_id')::uuid and category = 'laundry' and quantity = 2 and unit_amount_minor = 800000) then raise exception 'FAIL laundry charge'; end if;
  -- a price change later leaves a booking alone
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform service_save(v_p, t151('gym'), 'Gym session', 'gym', 900000, 30, 3, true);
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  v_b3 := (service_book(v_p, t151('gym'), v_res, null, v_start + interval '2 hours', 1, null, 'st-3') ->> 'booking_id')::uuid;
  if (select unit_price_minor from service_bookings where id = v_b3) <> 900000 then raise exception 'FAIL booked price'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform service_save(v_p, t151('gym'), 'Gym session', 'gym', 500000, 30, 3, true);
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  if (select unit_price_minor from service_bookings where id = v_b3) <> 900000 then raise exception 'FAIL later price change altered a booking'; end if;
  -- steps: no_show from booked, none after; a walk-in cannot go to a room bill
  perform service_booking_set(v_b3, 'no_show', 'n-1');
  perform service_booking_set(v_b3, 'no_show', 'n-2');
  perform t_expect(format('select service_booking_set(%L, ''done'', ''n-3'')', v_b3), 'INVALID_STATE');
  perform t_expect(format('select service_booking_set(%L, ''charge'', ''n-4'')', v_b3), 'INVALID_STATE');
  v_walk := (service_book(v_p, t151('massage'), null, 'Walk-in two', v_start + interval '4 hours', 1, null, 'st-4') ->> 'booking_id')::uuid;
  perform t_expect(format('select service_booking_set(%L, ''charge'', ''w-1'')', v_walk), 'INVALID_STATE: no room bill');
  perform service_booking_set(v_walk, 'done', 'w-2');
  -- other people
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  perform t_expect(format('select service_booking_set(%L, ''done'', ''x-1'')', v_walk), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select service_booking_set(%L, ''done'', ''x-1'')', v_walk), 'NOT_FOUND');
  perform t_sys();
  begin update service_bookings set quantity = 9 where id = v_b3; raise exception 'FAIL a booking was edited'; exception when sqlstate 'P0001' then null; end;
  begin update service_bookings set status = 'booked' where id = v_b; raise exception 'FAIL a charged booking moved'; exception when sqlstate 'P0001' then null; end;
  begin delete from service_bookings where id = v_walk; raise exception 'FAIL a booking was deleted'; exception when sqlstate 'P0001' then null; end;
  if t151_audits('service_booking.charged', v_b) <> 1 then raise exception 'FAIL charge audit'; end if;
  insert into t151_ctx values ('res', v_res::text);
  raise notice 'PASS steps: charge needs a guest in the house, repeats are no-ops, laundry has its own category, booked price is kept, walk-ins settle outside, bookings are final';
end $$;

-- 5. Report
do $$ declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; t date := property_today('00000000-0000-0000-0000-0000000000a2'); r jsonb; e jsonb; begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select service_report(%L, %L, %L)', v_p, t, t + 30), 'NOT_FOUND');                      -- no report.view
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select service_report(%L, %L, %L)', v_p, t, t + 30), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  r := service_report(v_p, t, t + 30);
  select x into e from jsonb_array_elements(r -> 'services') x where x ->> 'name' = 'Laundry bag';
  -- two laundry bookings made with no time, counted on the day created: 1 charged (2 bags), 2 others still booked
  if (e ->> 'charged')::int <> 1 or (e ->> 'booked')::int <> 2 or (e ->> 'revenue_minor')::bigint <> 1600000 then raise exception 'FAIL laundry row %', e; end if;
  select x into e from jsonb_array_elements(r -> 'services') x where x ->> 'name' = 'Massage';
  -- massage: cancelled 1 (walk-in Ade), booked 3 (next hour, the slot taker; walk-in two is done), charged 1, done 1
  if (e ->> 'cancelled')::int <> 1 or (e ->> 'charged')::int <> 1 or (e ->> 'done')::int <> 1 or (e ->> 'revenue_minor')::bigint <> 5000000 then raise exception 'FAIL massage row %', e; end if;
  select x into e from jsonb_array_elements(r -> 'services') x where x ->> 'name' = 'Gym session';
  if (e ->> 'no_show')::int <> 1 or (e ->> 'revenue_minor')::bigint <> 0 then raise exception 'FAIL gym row %', e; end if;
  if (r ->> 'revenue_minor')::bigint <> 5000000 + 1600000 then raise exception 'FAIL total revenue %', r ->> 'revenue_minor'; end if;
  perform t_expect(format('select service_report(%L, %L, %L)', v_p, t, t - 1), 'POLICY_VIOLATION: dates');
  perform t_expect(format('select service_report(%L, %L, %L)', v_p, t - 400, t), 'POLICY_VIOLATION: dates');
  raise notice 'PASS report: bookings by status and revenue of done and charged ones per service, report.view needed';
end $$;

-- 6. The flag: off refuses every write and still lets everything be read
do $$ declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_t constant uuid := '00000000-0000-0000-0000-0000000000a1'; v_b uuid; begin
  perform t_sys();
  v_b := (select id from service_bookings where status = 'booked' limit 1);
  insert into tenant_feature_entitlements (tenant_id, feature_key, enabled) values (v_t, 'guest_services', false);
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select service_save(%L, null, ''Sauna'', ''spa'', 100, 30, 1, true)', v_p), 'POLICY_VIOLATION: services off');
  perform t_expect(format('select service_book(%L, %L, null, ''X'', null, 1, null, ''f-1'')', v_p, t151('laundry')), 'POLICY_VIOLATION: services off');
  perform t_expect(format('select service_booking_set(%L, ''done'', ''f-2'')', v_b), 'POLICY_VIOLATION: services off');
  if (select count(*) from hotel_services) <> 4 or (select count(*) from service_bookings) = 0 then raise exception 'FAIL reads with the flag off'; end if;
  perform t_sys();
  delete from tenant_feature_entitlements where tenant_id = v_t and feature_key = 'guest_services';
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform service_booking_set(v_b, 'done', 'f-3');
  raise notice 'PASS flag: off refuses every write, reads work; on again, writes work';
end $$;
