-- 127 Minimum and maximum nights, set by the hotel (prototype "Min/Max Stay" under Booking and Cancellation Policies).
--
-- Two optional keys in the hotel's policy (property_policies.config): min_nights (1 to 30) and max_nights (1 to 30, not below
-- min_nights). Absent means 1 and 30, which is what the system always allowed, so no hotel changes until it chooses.
-- Enforced in ONE place, whoever books (the guest site, a staff reservation, a hold, a date edit): a trigger on reservations.
--   * insert: the stay's nights must be inside the range of the policy in force today at the hotel.
--   * update of the dates, only while the booking is pending or confirmed AND the number of nights changes: same check. A booking
--     that was made under an older rule is never blocked for moving its dates by the same length, and check-in, early check-out and
--     cancel never touch it (early check-out is a credit, not a date change). Early check-in moves the arrival back to today with the
--     departure unchanged: that is allowed (the guest is already at the desk), so the maximum can be passed by an early arrival.
-- Refusal: 'POLICY_VIOLATION: minimum stay N' or 'POLICY_VIOLATION: maximum stay N' (N is the hotel's number), so a screen can say it.
-- A stored value that is not a whole number in range is ignored (treated as absent), never an error that blocks every booking.
-- guest_policy(host) also returns min_nights and max_nights, so the guest site can say the rule before a guest tries.

create function stay_limits(p_property uuid, p_on date) returns integer[]
language sql stable security definer set search_path = public, pg_temp as $$
  with c as (select current_policy(p_property, p_on) as cfg),
  v as (
    select case when jsonb_typeof(cfg -> 'min_nights') = 'number' and (cfg ->> 'min_nights') ~ '^[0-9]+$' and (cfg ->> 'min_nights')::integer between 1 and 30
                then (cfg ->> 'min_nights')::integer else 1 end as lo,
           case when jsonb_typeof(cfg -> 'max_nights') = 'number' and (cfg ->> 'max_nights') ~ '^[0-9]+$' and (cfg ->> 'max_nights')::integer between 1 and 30
                then (cfg ->> 'max_nights')::integer else 30 end as hi
      from c)
  select array[lo, case when hi < lo then lo else hi end] from v
$$;
revoke all on function stay_limits(uuid, date) from public, anon, authenticated;

create function check_stay_length() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_nights integer := new.departure_date - new.arrival_date;
  v_lim integer[];
begin
  if tg_op = 'UPDATE' then
    if new.reservation_status not in ('pending', 'confirmed') or old.reservation_status not in ('pending', 'confirmed') then return new; end if;
    if v_nights = old.departure_date - old.arrival_date then return new; end if;
    -- early check-in (061, 073) moves the arrival back to today and keeps the departure: the guest is already there, so it is not refused
    if new.departure_date = old.departure_date and new.arrival_date < old.arrival_date and new.arrival_date = property_today(new.property_id) then return new; end if;
  end if;
  v_lim := stay_limits(new.property_id, property_today(new.property_id));
  if v_nights < v_lim[1] then raise exception 'POLICY_VIOLATION: minimum stay %', v_lim[1] using errcode = 'P0001'; end if;
  if v_nights > v_lim[2] then raise exception 'POLICY_VIOLATION: maximum stay %', v_lim[2] using errcode = 'P0001'; end if;
  return new;
end $$;
revoke all on function check_stay_length() from public, anon, authenticated;

create trigger reservations_stay_length before insert or update of arrival_date, departure_date on reservations
  for each row execute function check_stay_length();

create or replace function guest_policy(p_host text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_tenant uuid; v_property uuid; v_today date; v_cfg jsonb; v_currency text; v_lim integer[];
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select h.tenant_id, h.property_id into v_tenant, v_property from resolve_host(p_host) h;
  v_today := property_today(v_property);
  v_cfg := current_policy(v_property, v_today);
  v_lim := stay_limits(v_property, v_today);
  select currency into v_currency from properties where id = v_property;
  return jsonb_build_object(
    'currency', v_currency,
    'cancellation_rules', coalesce(v_cfg -> 'cancellation_rules', '[]'::jsonb),
    'online_payment', coalesce(v_cfg -> 'online_payment', '{"mode":"full"}'::jsonb),
    'checkin_payment', coalesce(v_cfg -> 'checkin_payment', '"none"'::jsonb),
    'guest_cancellation', case when v_cfg ->> 'guest_cancellation' = 'off' or not tenant_feature_on(v_tenant, 'guest_cancel') then '"off"'::jsonb else '"on"'::jsonb end,
    'min_nights', v_lim[1],
    'max_nights', v_lim[2]);
end $$;
