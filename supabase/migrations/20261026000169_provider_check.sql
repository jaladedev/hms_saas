-- 169 Test a payment account's connection (the prototype's "Paystack Settings" screen has a Test connection button).
--
-- Until now the only way to know a hotel's Paystack key worked was `npm run paystack:check` on a developer's machine, against a
-- test key typed into the shell. A platform admin setting up a hotel (docs/STAGING.md) has no such machine, and the secret lives in
-- the server's environment, not in the database (payment_provider_accounts.secret_reference is a pointer like `env:NAME`).
--
-- The database does two small things and the app does the rest (lib/platform/provider-check.ts):
--   * platform_provider_check_context(tenant, account): admin only; returns the pointer, mode and provider of ONE account of that
--     group, so the app never takes a pointer from the browser. An account of another group, or one that does not exist, is
--     NOT_FOUND.
--   * platform_log_provider_check(tenant, account, outcome, key_mode): admin only; writes the audit row
--     `platform.payment_account_checked`. It records only the outcome word, the account's mode and whether the key looked like a
--     test or live key. Never the key, the pointer's value, Paystack's reply or any error text.
-- The app resolves the pointer, makes ONE read-only call to Paystack (the bank list: no money moves, nothing is created) and reports
-- the outcome. Nothing in the database changes because of a check except the audit row.

create function platform_provider_check_context(p_tenant uuid, p_account uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare a payment_provider_accounts%rowtype;
begin
  perform platform_require('admin');
  select * into a from payment_provider_accounts where id = p_account and tenant_id = p_tenant;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  return jsonb_build_object('provider', a.provider, 'mode', a.mode, 'secret_reference', a.secret_reference, 'status', a.status);
end $$;

create function platform_log_provider_check(p_tenant uuid, p_account uuid, p_outcome text, p_key_mode text) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := platform_require('admin'); a payment_provider_accounts%rowtype;
begin
  select * into a from payment_provider_accounts where id = p_account and tenant_id = p_tenant;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if p_outcome is null or p_outcome not in ('ok', 'no_secret', 'bad_key', 'mode_mismatch', 'rejected', 'unreachable', 'unexpected') then
    raise exception 'POLICY_VIOLATION: check outcome' using errcode = 'P0001';
  end if;
  if p_key_mode is not null and p_key_mode not in ('test', 'live') then
    raise exception 'POLICY_VIOLATION: check outcome' using errcode = 'P0001';
  end if;
  perform write_audit(a.tenant_id, null, v_uid, 'platform.payment_account_checked', 'payment_provider_account', a.id, null,
    jsonb_build_object('outcome', p_outcome, 'mode', a.mode, 'key_mode', p_key_mode));
end $$;

revoke all on function platform_provider_check_context(uuid, uuid), platform_log_provider_check(uuid, uuid, text, text) from public, anon;
grant execute on function platform_provider_check_context(uuid, uuid), platform_log_provider_check(uuid, uuid, text, text) to authenticated;
