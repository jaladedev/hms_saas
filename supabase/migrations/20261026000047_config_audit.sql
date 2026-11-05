-- 047 Audit coverage: platform configuration, and guests can only be changed through the audited function.
--
-- Found in the audit coverage review (docs/AUDIT_COVERAGE.md):
--  1. Tables that decide which hotel a visitor reaches, who may sign in as an admin, how a hotel gets paid and what a hotel
--     may use were written only by the service role or from the SQL editor, and left no record: tenants, properties,
--     tenant_domains, payment_provider_accounts, tenant_subscriptions, tenant_feature_entitlements, platform_admins.
--     A changed domain sends guests, and their payments, to a different hotel; a changed provider account changes where
--     the money goes. They are now audited by triggers, so every path (service role, SQL editor, a future admin screen) is
--     covered. The actor is auth.uid(), which is null for the service role and the SQL editor; the row still says what
--     changed, from what, to what, and when. Rows of these tables have no property of their own to show to, so staff
--     screens do not list them: they are read from audit_logs by the database owner and the service role.
--  2. Staff with guest.manage could UPDATE guests directly through row level security, which 020 itself calls out as
--     leaving no record of who changed a phone number or email (the email is also what a guest uses to get a booking
--     link back). update_guest is the audited door and the only one the app uses. UPDATE is revoked from logins and the
--     policy dropped. INSERT stays: the walk-in booking flow creates guests directly, and a new row replaces nothing.

create function audit_config_row() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_entity  text   := tg_argv[0];
  v_cols    text[] := string_to_array(tg_argv[1], ',');
  v_row     jsonb  := to_jsonb(case when tg_op = 'DELETE' then old else new end);
  v_tenant  uuid   := coalesce(v_row ->> 'tenant_id', case when tg_table_name = 'tenants' then v_row ->> 'id' end)::uuid;
  v_prop    uuid   := coalesce(v_row ->> 'property_id', case when tg_table_name = 'properties' then v_row ->> 'id' end)::uuid;
  v_id      uuid   := coalesce(v_row ->> 'id', v_row ->> 'user_id')::uuid;
  v_changed jsonb;
begin
  if tg_op = 'INSERT' then
    perform write_audit(v_tenant, v_prop, auth.uid(), v_entity || '.created', v_entity, v_id, null,
      jsonb_build_object('values', (select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from jsonb_each(v_row) where key = any (v_cols))));
  elsif tg_op = 'DELETE' then
    perform write_audit(v_tenant, v_prop, auth.uid(), v_entity || '.deleted', v_entity, v_id, null,
      jsonb_build_object('values', (select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from jsonb_each(v_row) where key = any (v_cols))));
  else
    select coalesce(jsonb_object_agg(n.key, jsonb_build_object('from', o.value, 'to', n.value)), '{}'::jsonb) into v_changed
      from jsonb_each(v_row) n
      join jsonb_each(to_jsonb(old)) o on o.key = n.key
     where n.key = any (v_cols) and n.value is distinct from o.value;
    if v_changed <> '{}'::jsonb then
      perform write_audit(v_tenant, v_prop, auth.uid(), v_entity || '.updated', v_entity, v_id, null, jsonb_build_object('changed', v_changed));
    end if;
  end if;
  return null;
end $$;
revoke all on function audit_config_row() from public, anon, authenticated;

create trigger tenants_audit after insert or update or delete on tenants
  for each row execute function audit_config_row('tenant', 'name,slug,status,default_currency');
create trigger properties_audit after insert or update or delete on properties
  for each row execute function audit_config_row('property', 'name,code,address,city,state,country_code,timezone,currency,check_in_time,check_out_time,status');
create trigger tenant_domains_audit after insert or update or delete on tenant_domains
  for each row execute function audit_config_row('tenant_domain', 'host,property_id,is_primary,verified_at');
create trigger payment_provider_accounts_audit after insert or update or delete on payment_provider_accounts
  for each row execute function audit_config_row('payment_provider_account', 'provider,mode,account_label,public_configuration,secret_reference,status');
create trigger tenant_subscriptions_audit after insert or update or delete on tenant_subscriptions
  for each row execute function audit_config_row('tenant_subscription', 'plan_code,status,trial_ends_at,current_period_start,current_period_end');
create trigger tenant_feature_entitlements_audit after insert or update or delete on tenant_feature_entitlements
  for each row execute function audit_config_row('tenant_feature_entitlement', 'feature_key,enabled,configuration');
create trigger platform_admins_audit after insert or update or delete on platform_admins
  for each row execute function audit_config_row('platform_admin', 'user_id,level');

-- Guests: the audited function is the only way to change one.
drop policy guests_update on guests;
revoke update on guests from authenticated, anon;
