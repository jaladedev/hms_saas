-- 024 Audit for hotel setup changes.
--
-- Room types, rooms, rate plans and nightly prices are written straight from the staff screens under row-level
-- security (the people who may write are checked by the tables' own policies), so until now a changed price or a
-- room switched off left no trace of who did it. These triggers record every change in audit_logs, whoever
-- makes it: the screens, a script, or a database function. They add nothing to the app code.
--
--   * room_types, rooms, rate_plans: one audit row per changed row. Only setup columns are watched, so day-to-day
--     changes that already have their own audit (housekeeping status, for example) are not recorded twice.
--     An update that changes none of the watched columns writes nothing.
--       <entity>.created / <entity>.updated / <entity>.deleted, entity_type room_type, room or rate_plan.
--       metadata: {"values": {...}} on create and delete, {"changed": {"column": {"from": .., "to": ..}}} on update.
--   * daily_rates: a price change can touch a year of nights in one statement, so it is summarised, one row per
--     room type per statement, against the ROOM TYPE (entity_type room_type, entity_id the room type), which is where
--     someone looking for "who changed this price" will look:
--       rates.set (nights newly priced), rates.changed (existing nights whose price changed, with old and new),
--       rates.cleared (nights that went back to the standard price).
--     Nights re-saved at the price they already had write nothing.
-- The actor is the signed-in user (auth.uid()), or null for the service role and database scripts.
-- Nothing secret lives on these tables, so values are stored as they are.

create function audit_setup_row() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_entity  text   := tg_argv[0];
  v_cols    text[] := string_to_array(tg_argv[1], ',');
  v_changed jsonb;
begin
  if tg_op = 'INSERT' then
    perform write_audit(new.tenant_id, new.property_id, auth.uid(), v_entity || '.created', v_entity, new.id, null,
      jsonb_build_object('values', (select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from jsonb_each(to_jsonb(new)) where key = any (v_cols))));
  elsif tg_op = 'DELETE' then
    perform write_audit(old.tenant_id, old.property_id, auth.uid(), v_entity || '.deleted', v_entity, old.id, null,
      jsonb_build_object('values', (select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from jsonb_each(to_jsonb(old)) where key = any (v_cols))));
  else
    select coalesce(jsonb_object_agg(n.key, jsonb_build_object('from', o.value, 'to', n.value)), '{}'::jsonb) into v_changed
      from jsonb_each(to_jsonb(new)) n
      join jsonb_each(to_jsonb(old)) o on o.key = n.key
     where n.key = any (v_cols) and n.value is distinct from o.value;
    if v_changed <> '{}'::jsonb then
      perform write_audit(new.tenant_id, new.property_id, auth.uid(), v_entity || '.updated', v_entity, new.id, null,
                          jsonb_build_object('changed', v_changed));
    end if;
  end if;
  return null;
end $$;

create trigger room_types_audit after insert or update or delete on room_types
  for each row execute function audit_setup_row('room_type',
    'name,code,slug,description,bed_config,max_adults,max_children,max_occupancy,base_rate_minor,currency,is_public,status');
create trigger rooms_audit after insert or update or delete on rooms
  for each row execute function audit_setup_row('room', 'room_number,floor,room_type_id,operational_status');
create trigger rate_plans_audit after insert or update or delete on rate_plans
  for each row execute function audit_setup_row('rate_plan',
    'name,code,is_default,cancellation_policy,payment_policy,currency,status');

-- ---- nightly prices: one summary row per room type per statement ---------------------------------
create function audit_daily_rates_inserted() returns trigger
language plpgsql security definer set search_path = public as $$
declare g record;
begin
  for g in select tenant_id, property_id, room_type_id, rate_plan_id, count(*) as nights,
                  min(business_date) as d_from, max(business_date) as d_to,
                  min(amount_minor) as lo, max(amount_minor) as hi
             from new_rows group by tenant_id, property_id, room_type_id, rate_plan_id
  loop
    perform write_audit(g.tenant_id, g.property_id, auth.uid(), 'rates.set', 'room_type', g.room_type_id, null,
      jsonb_build_object('rate_plan_id', g.rate_plan_id, 'nights', g.nights, 'from', g.d_from, 'to', g.d_to,
                         'amount_minor_min', g.lo, 'amount_minor_max', g.hi));
  end loop;
  return null;
end $$;

create function audit_daily_rates_updated() returns trigger
language plpgsql security definer set search_path = public as $$
declare g record;
begin
  for g in select n.tenant_id, n.property_id, n.room_type_id, n.rate_plan_id, count(*) as nights,
                  min(n.business_date) as d_from, max(n.business_date) as d_to,
                  min(o.amount_minor) as old_lo, max(o.amount_minor) as old_hi,
                  min(n.amount_minor) as new_lo, max(n.amount_minor) as new_hi
             from new_rows n join old_rows o on o.id = n.id
            where o.amount_minor is distinct from n.amount_minor
            group by n.tenant_id, n.property_id, n.room_type_id, n.rate_plan_id
  loop
    perform write_audit(g.tenant_id, g.property_id, auth.uid(), 'rates.changed', 'room_type', g.room_type_id, null,
      jsonb_build_object('rate_plan_id', g.rate_plan_id, 'nights', g.nights, 'from', g.d_from, 'to', g.d_to,
                         'old_amount_minor_min', g.old_lo, 'old_amount_minor_max', g.old_hi,
                         'new_amount_minor_min', g.new_lo, 'new_amount_minor_max', g.new_hi));
  end loop;
  return null;
end $$;

create function audit_daily_rates_deleted() returns trigger
language plpgsql security definer set search_path = public as $$
declare g record;
begin
  for g in select tenant_id, property_id, room_type_id, rate_plan_id, count(*) as nights,
                  min(business_date) as d_from, max(business_date) as d_to,
                  min(amount_minor) as lo, max(amount_minor) as hi
             from old_rows group by tenant_id, property_id, room_type_id, rate_plan_id
  loop
    perform write_audit(g.tenant_id, g.property_id, auth.uid(), 'rates.cleared', 'room_type', g.room_type_id, null,
      jsonb_build_object('rate_plan_id', g.rate_plan_id, 'nights', g.nights, 'from', g.d_from, 'to', g.d_to,
                         'old_amount_minor_min', g.lo, 'old_amount_minor_max', g.hi));
  end loop;
  return null;
end $$;

create trigger daily_rates_audit_ins after insert on daily_rates
  referencing new table as new_rows for each statement execute function audit_daily_rates_inserted();
create trigger daily_rates_audit_upd after update on daily_rates
  referencing old table as old_rows new table as new_rows for each statement execute function audit_daily_rates_updated();
create trigger daily_rates_audit_del after delete on daily_rates
  referencing old table as old_rows for each statement execute function audit_daily_rates_deleted();

-- Trigger functions run when the trigger fires; nobody needs to (or may) call them directly.
revoke all on function audit_setup_row(), audit_daily_rates_inserted(), audit_daily_rates_updated(), audit_daily_rates_deleted()
  from public, anon, authenticated;
