-- 043 Policy version dates are enforced by the database.
--
-- The policies screen refused a new version dated before today or not after the latest version, but only in the app
-- (checkEffectiveDate). A person with property.configure writing to the table directly skipped both rules, and two people
-- saving at the same moment were checked against the same old "latest". The same rules now run in a BEFORE INSERT trigger:
--   * the date may not be before today at the property;
--   * the date must be after every version already stored (a version dated before the newest would never be read,
--     because the database takes the latest start date that has come).
-- The check runs while the property row is locked, so two inserts for one property are checked one after the other.
-- Callers with no signed-in user (the system, migrations, test fixtures) are not checked: they are how history is loaded.
-- SECURITY DEFINER because property_today() is not callable by logins. Refusals use P0001 with 'POLICY_VIOLATION: ...'.

create function property_policies_date_rules() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;
  perform 1 from properties where id = new.property_id for update;
  if new.effective_from < property_today(new.property_id) then
    raise exception 'POLICY_VIOLATION: policy date in the past' using errcode = 'P0001';
  end if;
  if exists (select 1 from property_policies p where p.property_id = new.property_id and p.effective_from >= new.effective_from) then
    raise exception 'POLICY_VIOLATION: policy date not after the latest version' using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger property_policies_date_rules before insert on property_policies
  for each row execute function property_policies_date_rules();
