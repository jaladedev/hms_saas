-- Booking pace (migration 160): the forecast signal and the 'pace' pricing rule. Hotel A: tenant a1, property a2, Standard a3. Owner aa01, front desk aa04
-- (books, but has no rate permission), housekeeping aa02 (none), other hotel's owner bb01. The owner reads and writes rates.
-- History is built by cloning one real booking (a row per room per night, backdated) so the counts are exact and far above any rows other tests left:
-- every night of the last 85 days gets 20 rooms booked 15 days ahead. Targets: T+10 has 30 rooms booked (ahead), T+11 has 20 (on pace), T+12 has 10 and
-- T+13 has only what other tests booked (behind). The clones are deleted at the end so later tests see the hotel as before.
\set ON_ERROR_STOP on

create function t160_clone(p_res uuid, p_rr uuid, p_count integer, p_night date, p_created timestamptz) returns void language plpgsql as $$
declare i integer; v_res uuid; v_rr uuid;
begin
  for i in 1..p_count loop
    v_res := gen_random_uuid(); v_rr := gen_random_uuid();
    insert into reservations select (jsonb_populate_record(null::reservations, to_jsonb(r) || jsonb_build_object('id', v_res, 'booking_reference', 'PACE-' || substr(v_res::text, 1, 12),
      'created_at', p_created, 'arrival_date', p_night, 'departure_date', p_night + 1))).* from reservations r where r.id = p_res;
    insert into reservation_rooms select (jsonb_populate_record(null::reservation_rooms, to_jsonb(x) || jsonb_build_object('id', v_rr, 'reservation_id', v_res))).* from reservation_rooms x where x.id = p_rr;
    insert into reservation_nights (tenant_id, reservation_room_id, night_date, rate_minor, tax_minor, rate_source)
    select tenant_id, v_rr, p_night, rate_minor, tax_minor, rate_source from reservation_nights where reservation_room_id = p_rr limit 1;
  end loop;
end $$;
create function t160_pace(p_from date, p_days integer) returns jsonb language sql as $$ select pricing_pace('00000000-0000-0000-0000-0000000000a2', p_from, p_days) $$;
create function t160_rule(p_name text, p_kind text, p_percent numeric, p_from integer, p_to integer) returns jsonb language sql as $$
  select save_pricing_rule('00000000-0000-0000-0000-0000000000a2', null, null, p_name, p_kind, p_from, p_to, null, null, null, p_percent, true)
$$;
create table t160_ctx (label text primary key, val text not null);
select set_config('t160.rates_md5', (select md5(coalesce(string_agg(d::text, '|' order by d::text), '')) from daily_rates d), false);

-- 1. No history yet: nothing is promised. Who may read it, what is accepted, the flag.
do $$ declare
  v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; t date := property_today('00000000-0000-0000-0000-0000000000a2'); r jsonb; v_book jsonb;
begin
  perform t_sys();
  if exists (select 1 from pricing_rules where property_id = v_p) then
    delete from pricing_rules where property_id = v_p;
  end if;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  v_book := t_book('00000000-0000-0000-0000-0000000000a3', t + 500, t + 501, 'pace-src-0001');
  perform t_sys();
  insert into t160_ctx values ('res', v_book ->> 'reservation_id'), ('rr', t_rr(v_book)::text);

  perform t_as('00000000-0000-0000-0000-00000000aa01');
  r := t160_pace(t + 10, 4);
  if jsonb_array_length(r) <> 4 or exists (select 1 from jsonb_array_elements(r) e where e ->> 'status' <> 'no_history' or e -> 'usual' <> 'null'::jsonb or e -> 'pace_percent' <> 'null'::jsonb) then
    raise exception 'FAIL a hotel without history should get no_history: %', r;
  end if;
  perform t_as('00000000-0000-0000-0000-00000000aa04');                                                        -- front desk has no rate permission
  perform t_expect(format('select pricing_pace(%L, current_date, 5)', v_p), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform t_expect(format('select pricing_pace(%L, current_date, 5)', v_p), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select pricing_pace(%L, current_date, 5)', v_p), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select pricing_pace(%L, current_date, 0)', v_p), 'POLICY_VIOLATION: range');
  perform t_expect(format('select pricing_pace(%L, current_date, 61)', v_p), 'POLICY_VIOLATION: range');
  perform t_expect(format('select pricing_pace(%L, null, 5)', v_p), 'POLICY_VIOLATION: range');
  perform t_sys();
  insert into tenant_feature_entitlements (tenant_id, feature_key, enabled) values ('00000000-0000-0000-0000-0000000000a1', 'dynamic_pricing', false);
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select pricing_pace(%L, current_date, 5)', v_p), 'POLICY_VIOLATION: dynamic pricing off');
  perform t_sys();
  delete from tenant_feature_entitlements where tenant_id = '00000000-0000-0000-0000-0000000000a1' and feature_key = 'dynamic_pricing';
  raise notice 'PASS no history: no_history with nothing guessed, reads need rate.view, range and flag enforced';
end $$;

-- 2. With history: ahead, on pace, behind, and the lead time matters
do $$ declare
  v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; t date := property_today('00000000-0000-0000-0000-0000000000a2');
  v_res uuid := (select val::uuid from t160_ctx where label = 'res'); v_rr uuid := (select val::uuid from t160_ctx where label = 'rr'); d date; r jsonb; e jsonb;
begin
  perform t_sys();
  for d in select g::date from generate_series(t - 85, t - 1, interval '1 day') g loop
    perform t160_clone(v_res, v_rr, 20, d, (d - 15)::timestamp + interval '12 hours');
  end loop;
  perform t160_clone(v_res, v_rr, 30, t + 10, now());
  perform t160_clone(v_res, v_rr, 20, t + 11, now());
  perform t160_clone(v_res, v_rr, 10, t + 12, now());

  perform t_as('00000000-0000-0000-0000-00000000aa01');
  r := t160_pace(t + 10, 4);
  if jsonb_array_length(r) <> 4 then raise exception 'FAIL pace rows: %', r; end if;
  if (r -> 0 ->> 'status') <> 'ahead' or (r -> 1 ->> 'status') <> 'on_pace' or (r -> 2 ->> 'status') <> 'behind' or (r -> 3 ->> 'status') <> 'behind' then
    raise exception 'FAIL statuses (ahead, on_pace, behind, behind expected): %', r;
  end if;
  e := r -> 0;
  if (e ->> 'usual')::numeric not between 19 and 24 or (e ->> 'booked')::int not between 30 and 34 or (e ->> 'pace_percent')::numeric not between 20 and 80 or (e ->> 'lead_days')::int <> 10 then
    raise exception 'FAIL the ahead night: %', e;
  end if;
  if (r -> 3 ->> 'booked')::int > 3 or (r -> 3 ->> 'pace_percent')::numeric not between -100 and -80 then raise exception 'FAIL a nearly empty night is far behind (rooms from other tests may be on it): %', r -> 3; end if;
  -- the lead time matters: rooms were booked 15 days ahead, so at 20 days ahead the usual is nothing and no signal is given
  e := t160_pace(t + 20, 1) -> 0;
  if e ->> 'status' <> 'no_history' or e -> 'usual' <> 'null'::jsonb then raise exception 'FAIL at 20 days ahead nothing was booked in the past: %', e; end if;
  -- past nights are left out, today is lead 0
  r := t160_pace(t - 3, 6);
  if jsonb_array_length(r) <> 3 or (r -> 0 ->> 'night')::date <> t or (r -> 0 ->> 'lead_days')::int <> 0 then raise exception 'FAIL past nights should be skipped: %', r; end if;
  raise notice 'PASS pace: ahead, on pace and behind from the hotel''s own history, a nearly empty night is far behind, the lead time counts, past nights left out';
end $$;

-- 3. The pace rule
do $$ declare
  v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_t constant uuid := '00000000-0000-0000-0000-0000000000a3'; t date := property_today('00000000-0000-0000-0000-0000000000a2');
  c jsonb; r jsonb; n jsonb; l jsonb;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect('select t160_rule(''Ahead'', ''pace'', 10, 20, 300)', 'NOT_FOUND');                          -- front desk never writes rules
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect('select t160_rule(''x'', ''pace'', 10, -101, 20)', 'POLICY_VIOLATION: band');
  perform t_expect('select t160_rule(''x'', ''pace'', 10, 20, 301)', 'POLICY_VIOLATION: band');
  perform t_expect('select t160_rule(''x'', ''pace'', 10, 30, 20)', 'POLICY_VIOLATION: band');
  perform t_expect('select t160_rule(''x'', ''pace'', 10, null, 20)', 'POLICY_VIOLATION: band');
  perform t_expect('select t160_rule(''x'', ''pace'', 0, 20, 300)', 'POLICY_VIOLATION: percent');
  perform t_expect('select t160_rule(''x'', ''pace2'', 10, 20, 300)', 'POLICY_VIOLATION: kind');
  perform t160_rule('Ahead', 'pace', 10, 20, 300);
  perform t160_rule('Behind', 'pace', -10, -100, -20);
  l := pricing_rule_list(v_p);
  if (select count(*) from jsonb_array_elements(l) e where e ->> 'kind' = 'pace') <> 2
     or not exists (select 1 from jsonb_array_elements(l) e where e ->> 'name' = 'Behind' and (e ->> 'band_from')::int = -100 and (e ->> 'band_to')::int = -20) then
    raise exception 'FAIL rule list %', l;
  end if;

  perform t_sys();
  c := pricing_compute_night(v_p, v_t, t + 10, 10000000, t);
  if (c ->> 'change_percent')::numeric <> 10 or c -> 'rules' <> '["Ahead"]'::jsonb or (c ->> 'pace_percent')::numeric not between 20 and 80 or (c ->> 'suggested_minor')::bigint <> 11000000 then raise exception 'FAIL ahead night: %', c; end if;
  c := pricing_compute_night(v_p, v_t, t + 11, 10000000, t);
  if (c ->> 'change_percent')::numeric <> 0 or c -> 'rules' <> '[]'::jsonb then raise exception 'FAIL on-pace night: %', c; end if;
  c := pricing_compute_night(v_p, v_t, t + 12, 10000000, t);
  if (c ->> 'change_percent')::numeric <> -10 or c -> 'rules' <> '["Behind"]'::jsonb or (c ->> 'suggested_minor')::bigint <> 9000000 then raise exception 'FAIL behind night: %', c; end if;
  c := pricing_compute_night(v_p, v_t, t + 20, 10000000, t);                    -- no signal: the rule stays out of it
  if (c ->> 'change_percent')::numeric <> 0 or c -> 'pace_percent' <> 'null'::jsonb then raise exception 'FAIL a night with no pace: %', c; end if;
  -- no pace rule, no pace work: the field is empty
  delete from pricing_rules where property_id = v_p;
  c := pricing_compute_night(v_p, v_t, t + 10, 10000000, t);
  if c -> 'pace_percent' <> 'null'::jsonb or (c ->> 'change_percent')::numeric <> 0 then raise exception 'FAIL without a pace rule: %', c; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t160_rule('Ahead', 'pace', 10, 20, 300);

  -- the staff suggestions show it
  n := (select x from jsonb_array_elements(pricing_suggestions(v_p, t + 10, 3)) tt, jsonb_array_elements(tt -> 'nights') x
         where tt ->> 'room_type_id' = v_t::text and (x ->> 'night')::date = t + 10);
  if n is null or n -> 'rules' <> '["Ahead"]'::jsonb or (n ->> 'suggested_minor')::bigint <= (n ->> 'current_minor')::bigint then raise exception 'FAIL suggestion for the ahead night: %', n; end if;
  raise notice 'PASS pace rule: bands from -100 to 300 checked, ahead and behind nights move by the rule, no signal means no change, shown in the suggestions';
end $$;

-- 4. Nothing was priced by looking at pace, and the clones are removed
do $$ begin
  perform t_sys();
  delete from pricing_rules where property_id = '00000000-0000-0000-0000-0000000000a2';
  delete from reservation_nights where reservation_room_id in (select rr.id from reservation_rooms rr join reservations r on r.id = rr.reservation_id where r.booking_reference like 'PACE-%');
  delete from reservation_rooms where reservation_id in (select id from reservations where booking_reference like 'PACE-%');
  delete from reservations where booking_reference like 'PACE-%';
  if exists (select 1 from reservations where booking_reference like 'PACE-%') then raise exception 'FAIL clones left behind'; end if;
  if (select md5(coalesce(string_agg(d::text, '|' order by d::text), '')) from daily_rates d) <> current_setting('t160.rates_md5') then raise exception 'FAIL a daily rate moved'; end if;
  raise notice 'PASS no daily rate moved by the forecast or the rule';
end $$;
