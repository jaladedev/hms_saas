-- 035 Policy JSON validity: a malformed policy is refused however it is written.
--
-- property_policies (005) holds a hotel's booking policy as JSON, and cancel_reservation, the hold, payment and
-- check-in functions read it straight from that JSON. Nothing checked it, so one malformed cancellation rule saved by
-- anyone with property.configure (the screen, a script, PostgREST) would make cancel_reservation raise for every
-- booking at that hotel. policy_config_valid() now guards the table. Keys it does not know are allowed.

-- hold_minutes            whole number, 5 to 120 (default when absent: 20)
-- cancellation_rules      at most 8 rules; each: within_hours (whole number 0 to 8760, no two the same) and
--                         charge {type: percent | nights | fixed, value}: percent above 0 and at most 100,
--                         nights a whole number 1 to 30, fixed a whole number of kobo 1 to 1,000,000,000
-- online_payment          {mode: full | deposit_percent, value}: for deposit_percent, value above 0 and at most 100
-- checkin_payment         the text "full" (payment in full required before check-in)
-- check_in_time           a time of day as text, "14:00"
create function policy_config_valid(p jsonb) returns boolean
language plpgsql immutable as $$
declare r jsonb; v numeric; t text; seen numeric[] := '{}'; w numeric;
begin
  if p is null or jsonb_typeof(p) <> 'object' then return false; end if;

  if p ? 'hold_minutes' then
    if jsonb_typeof(p -> 'hold_minutes') <> 'number' then return false; end if;
    v := (p ->> 'hold_minutes')::numeric;
    if v <> trunc(v) or v < 5 or v > 120 then return false; end if;
  end if;

  if p ? 'cancellation_rules' then
    if jsonb_typeof(p -> 'cancellation_rules') <> 'array' or jsonb_array_length(p -> 'cancellation_rules') > 8 then return false; end if;
    for r in select * from jsonb_array_elements(p -> 'cancellation_rules') loop
      if jsonb_typeof(r) <> 'object' or jsonb_typeof(r -> 'within_hours') is distinct from 'number'
         or jsonb_typeof(r -> 'charge') is distinct from 'object' then return false; end if;
      w := (r ->> 'within_hours')::numeric;
      if w <> trunc(w) or w < 0 or w > 8760 or w = any (seen) then return false; end if;
      seen := seen || w;
      t := r -> 'charge' ->> 'type';
      if jsonb_typeof(r -> 'charge' -> 'value') is distinct from 'number' then return false; end if;
      v := (r -> 'charge' ->> 'value')::numeric;
      if t = 'percent' then
        if v <= 0 or v > 100 then return false; end if;
      elsif t = 'nights' then
        if v <> trunc(v) or v < 1 or v > 30 then return false; end if;
      elsif t = 'fixed' then
        if v <> trunc(v) or v < 1 or v > 1000000000 then return false; end if;
      else
        return false;
      end if;
    end loop;
  end if;

  if p ? 'online_payment' then
    if jsonb_typeof(p -> 'online_payment') <> 'object' then return false; end if;
    t := p -> 'online_payment' ->> 'mode';
    if t = 'deposit_percent' then
      if jsonb_typeof(p -> 'online_payment' -> 'value') is distinct from 'number' then return false; end if;
      v := (p -> 'online_payment' ->> 'value')::numeric;
      if v <= 0 or v > 100 then return false; end if;
    elsif t is distinct from 'full' then
      return false;
    end if;
  end if;

  if p ? 'checkin_payment' and p -> 'checkin_payment' is distinct from '"full"'::jsonb then return false; end if;

  if p ? 'check_in_time' then
    if jsonb_typeof(p -> 'check_in_time') <> 'string' then return false; end if;
    perform (p ->> 'check_in_time')::time;
  end if;

  return true;
exception when others then
  return false;
end $$;

alter table property_policies add constraint property_policies_config_valid check (policy_config_valid(config));


revoke all on function policy_config_valid(jsonb) from public, anon;
