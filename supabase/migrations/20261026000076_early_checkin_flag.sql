-- 076 Seventh enforced flag: early_checkin.
--
-- Early check-in needs the hotel's own policy (early_checkin_days, 061) and, from now, the plan flag `early_checkin` (no row means
-- on). With the flag row set to enabled = false, early_checkin_days answers 0, which is how "off" has always been read: the quote says
-- 'off', early_check_in (and the waiver, 073) refuse with EARLY_CHECKIN_NOT_SUPPORTED, and the reservation page offers nothing.
-- Guests already checked in early are untouched, and ordinary check-in is untouched. early_checkin_days is copied from 061 with
-- only the flag check added (its grants are kept by create or replace).

create or replace function early_checkin_days(p_property uuid, p_on date) returns integer
language sql stable security definer set search_path = public as $$
  select case when not tenant_feature_on((select tenant_id from properties where id = p_property), 'early_checkin') then 0
              when jsonb_typeof(current_policy(p_property, p_on) -> 'early_checkin_days') = 'number'
               and (current_policy(p_property, p_on) ->> 'early_checkin_days')::numeric between 1 and 7
               and (current_policy(p_property, p_on) ->> 'early_checkin_days')::numeric = trunc((current_policy(p_property, p_on) ->> 'early_checkin_days')::numeric)
              then (current_policy(p_property, p_on) ->> 'early_checkin_days')::integer else 0 end
$$;
