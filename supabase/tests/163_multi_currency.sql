-- One currency per hotel (migration 163). Reuses t_as / t_sys / t_expect (05).
-- Users: aa01 owner A, aa02 housekeeping A, aa05 accountant A, bb01 owner of Hotel B. Hotel A already has bookings, so its currency is locked.
\set ON_ERROR_STOP on

-- 1. Catalog and flag
do $$ begin
  perform t_sys();
  if supported_currencies() <> array['NGN', 'GHS', 'KES', 'ZAR', 'USD'] then raise exception 'FAIL supported list'; end if;
  if not ('multi_currency' = any (plan_enforced_flags())) then raise exception 'FAIL multi_currency is not an enforced flag'; end if;
  if not (select 'multi_currency' = any (features) from plans where code = 'pro') or (select 'multi_currency' = any (features) from plans where code = 'starter') then raise exception 'FAIL plan features'; end if;
  raise notice 'PASS catalog: five Paystack currencies; multi_currency is enforced and on the pro plan only';
end $$;

-- 2. A new hotel in another currency, and prices that follow it
do $$ declare v_t constant uuid := '00000000-0000-0000-0000-000000163001'; v_p constant uuid := '00000000-0000-0000-0000-000000163002'; v_rt uuid; begin
  perform t_sys();
  insert into tenants (id, name, slug) values (v_t, 'Hotel C', 'hotel-c-163');
  insert into properties (id, tenant_id, name, code, currency) values (v_p, v_t, 'Hotel C Accra', 'HC', 'ghs');
  if (select currency from properties where id = v_p) <> 'GHS' then raise exception 'FAIL currency not normalised'; end if;
  begin insert into properties (tenant_id, name, code, currency) values (v_t, 'Hotel C2', 'HC2', 'EUR'); raise exception 'FAIL unsupported currency accepted';
  exception when sqlstate 'P0001' then if sqlerrm not like 'POLICY_VIOLATION: currency%' then raise; end if; end;
  insert into room_types (tenant_id, property_id, name, code, slug, max_adults, max_occupancy, base_rate_minor, currency)
  values (v_t, v_p, 'Standard', 'STD', 'standard', 2, 2, 100000, 'NGN') returning id into v_rt;
  if (select currency from room_types where id = v_rt) <> 'GHS' then raise exception 'FAIL room type currency follows the hotel'; end if;
  insert into rate_plans (tenant_id, property_id, name, code, is_default, currency) values (v_t, v_p, 'Standard', 'STD', true, 'USD');
  if (select currency from rate_plans where property_id = v_p) <> 'GHS' then raise exception 'FAIL rate plan currency'; end if;
  insert into daily_rates (tenant_id, property_id, room_type_id, rate_plan_id, business_date, amount_minor, currency)
  select v_t, v_p, v_rt, id, current_date + 1, 120000, 'KES' from rate_plans where property_id = v_p;
  if (select currency from daily_rates where property_id = v_p) <> 'GHS' then raise exception 'FAIL daily rate currency'; end if;
  -- no bookings yet, so the currency can change, and the prices follow (amounts are not converted)
  update properties set currency = 'USD' where id = v_p;
  if (select count(*) from room_types where property_id = v_p and currency = 'USD') <> 1 or (select count(*) from daily_rates where property_id = v_p and currency = 'USD') <> 1
     or (select amount_minor from daily_rates where property_id = v_p) <> 120000 then raise exception 'FAIL change rewrites prices'; end if;
  raise notice 'PASS hotel currency: normalised, only the supported list, room types, rate plans and rates always take the hotel''s currency, a change before any booking rewrites them without converting';
end $$;

-- 3. Locked once money or bookings exist
do $$ begin
  perform t_sys();
  begin update properties set currency = 'GHS' where id = '00000000-0000-0000-0000-0000000000a2'; raise exception 'FAIL currency changed with bookings';
  exception when sqlstate 'P0001' then if sqlerrm not like 'INVALID_STATE: currency locked%' then raise; end if; end;
  if (select currency from properties where id = '00000000-0000-0000-0000-0000000000a2') <> 'NGN' then raise exception 'FAIL currency moved'; end if;
  update properties set currency = 'NGN' where id = '00000000-0000-0000-0000-0000000000a2';   -- the same value is not a change
  raise notice 'PASS lock: a hotel with bookings keeps its currency';
end $$;

-- 4. The flag decides who may leave NGN
do $$ declare v_t constant uuid := '00000000-0000-0000-0000-000000163001'; v_p constant uuid := '00000000-0000-0000-0000-000000163002'; begin
  perform t_sys();
  insert into tenant_feature_entitlements (tenant_id, feature_key, enabled) values (v_t, 'multi_currency', false);
  begin update properties set currency = 'KES' where id = v_p; raise exception 'FAIL changed with the flag off';
  exception when sqlstate 'P0001' then if sqlerrm not like 'POLICY_VIOLATION: multi_currency off%' then raise; end if; end;
  begin insert into properties (tenant_id, name, code, currency) values (v_t, 'Hotel C3', 'HC3', 'ZAR'); raise exception 'FAIL created with the flag off';
  exception when sqlstate 'P0001' then if sqlerrm not like 'POLICY_VIOLATION: multi_currency off%' then raise; end if; end;
  update properties set currency = 'NGN' where id = v_p;   -- back to NGN is always allowed
  update properties set name = 'Hotel C Accra' where id = v_p;   -- unrelated edits are never blocked
  delete from tenant_feature_entitlements where tenant_id = v_t and feature_key = 'multi_currency';
  update properties set currency = 'ZAR' where id = v_p;
  raise notice 'PASS flag: with it off a hotel cannot move to or start in another currency, NGN stays allowed; on again it can';
end $$;

-- 5. Reports count the hotel's own currency
do $$ begin
  perform t_sys();
  if (select prosrc from pg_proc where proname = 'daily_report_figures') like '%''NGN''%' then raise exception 'FAIL report still counts only NGN'; end if;
  if (select count(*) from daily_report_figures('00000000-0000-0000-0000-000000163002', current_date, current_date + 2)) <> 3 then raise exception 'FAIL report rows for a ZAR hotel'; end if;
  if (select sum(room_revenue_minor + cash_in_minor) from daily_report_figures('00000000-0000-0000-0000-000000163002', current_date, current_date + 2)) <> 0 then raise exception 'FAIL empty hotel has figures'; end if;
  raise notice 'PASS report: figures follow the hotel''s currency, an empty ZAR hotel reports zeros';
end $$;

-- 6. Exchange rates by hand
do $$ declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_d date := property_today('00000000-0000-0000-0000-0000000000a2'); v_id uuid; r jsonb; begin
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform t_expect(format('select fx_rate_set(%L, ''NGN'', ''USD'', %L, 0.00065, null)', v_p, v_d), 'NOT_FOUND');
  perform t_expect(format('select fx_rate_get(%L, ''NGN'', ''USD'', %L)', v_p, v_d), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select fx_rate_set(%L, ''NGN'', ''USD'', %L, 0.00065, null)', v_p, v_d), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select fx_rate_set(%L, ''NGN'', ''EUR'', %L, 0.0006, null)', v_p, v_d), 'POLICY_VIOLATION: currency');
  perform t_expect(format('select fx_rate_set(%L, ''NGN'', ''NGN'', %L, 1, null)', v_p, v_d), 'POLICY_VIOLATION: currency');
  perform t_expect(format('select fx_rate_set(%L, ''NGN'', ''USD'', %L, 0, null)', v_p, v_d), 'POLICY_VIOLATION: rate');
  perform t_expect(format('select fx_rate_set(%L, ''NGN'', ''USD'', %L, 0.123456789, null)', v_p, v_d), 'POLICY_VIOLATION: rate');
  perform t_expect(format('select fx_rate_set(%L, ''NGN'', ''USD'', %L, 0.00065, null)', v_p, v_d + 1), 'POLICY_VIOLATION: date');
  v_id := fx_rate_set(v_p, 'ngn', 'usd', v_d - 5, 0.00060, 'Central bank') ->> 'rate_id';
  perform fx_rate_set(v_p, 'NGN', 'USD', v_d - 5, 0.00062, 'Corrected');
  if (select count(*) from exchange_rates where from_currency = 'NGN' and to_currency = 'USD') <> 1 or (select rate from exchange_rates where id = v_id) <> 0.00062 then raise exception 'FAIL correction replaces'; end if;
  if (select (metadata ->> 'was')::numeric from audit_logs where action = 'exchange_rate.set' and entity_id = v_id order by created_at desc, id desc limit 1) <> 0.00060 then raise exception 'FAIL audit holds the old rate'; end if;
  perform fx_rate_set(v_p, 'NGN', 'USD', v_d - 1, 0.00070, null);
  -- the latest rate on or before the date; never a later one
  if (fx_rate_get(v_p, 'NGN', 'USD', v_d) ->> 'rate')::numeric <> 0.0007 then raise exception 'FAIL latest rate'; end if;
  if (fx_rate_get(v_p, 'NGN', 'USD', v_d - 3) ->> 'rate')::numeric <> 0.00062 then raise exception 'FAIL earlier rate'; end if;
  if fx_rate_get(v_p, 'NGN', 'USD', v_d - 10) is not null then raise exception 'FAIL a rate before any was entered'; end if;
  r := fx_rate_get(v_p, 'USD', 'NGN', v_d - 3);
  if (r ->> 'rate')::numeric <> round(1 / 0.00062, 8) or not (r ->> 'inverse')::boolean then raise exception 'FAIL inverse %', r; end if;
  if (fx_rate_get(v_p, 'NGN', 'NGN', v_d) ->> 'rate')::numeric <> 1 then raise exception 'FAIL same currency'; end if;
  -- the accountant can read, the other hotel sees nothing
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  if (fx_rate_get(v_p, 'NGN', 'USD', v_d) ->> 'rate')::numeric <> 0.0007 or (select count(*) from exchange_rates) <> 2 then raise exception 'FAIL accountant reads'; end if;
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  if (select count(*) from exchange_rates) <> 0 then raise exception 'FAIL other hotel reads rates'; end if;
  raise notice 'PASS rates: property.configure enters them, same-day correction replaces and audits the old value, latest on or before a date, inverse, readers limited to the group';
end $$;

-- 7. Rates with the flag off: readable, not writable
do $$ declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_t constant uuid := '00000000-0000-0000-0000-0000000000a1'; v_d date := property_today('00000000-0000-0000-0000-0000000000a2'); begin
  perform t_sys();
  insert into tenant_feature_entitlements (tenant_id, feature_key, enabled) values (v_t, 'multi_currency', false);
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select fx_rate_set(%L, ''NGN'', ''USD'', %L, 0.0008, null)', v_p, v_d), 'POLICY_VIOLATION: multi_currency off');
  if (fx_rate_get(v_p, 'NGN', 'USD', v_d) ->> 'rate')::numeric <> 0.0007 then raise exception 'FAIL read with flag off'; end if;
  perform t_sys();
  delete from tenant_feature_entitlements where tenant_id = v_t and feature_key = 'multi_currency';
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform fx_rate_set(v_p, 'NGN', 'USD', v_d, 0.0008, null);
  raise notice 'PASS rates flag: off refuses writes, reads work; on again, writes work';
end $$;
