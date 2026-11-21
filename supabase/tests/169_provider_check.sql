-- Test a payment account's connection (migration 169). Runs after 55: group 't50-hotel' has a test Paystack account whose secret
-- reference is env:PAYSTACK_SECRET_T50. Platform people: f050 admin, f051 support, f053 the new group's owner; aa01 owns Hotel A.
-- What is proven here is the database half: who may ask, that the account must belong to the group named, that the audit row holds
-- the outcome and modes and nothing else, and that a check changes no row of the account. The Paystack call is in lib/platform.
\set ON_ERROR_STOP on

do $$
declare
  v_t uuid := (select id from tenants where slug = 't50-hotel');
  v_a uuid := (select id from payment_provider_accounts where tenant_id = (select id from tenants where slug = 't50-hotel') and mode = 'test');
  v_o uuid := (select id from tenants where slug <> 't50-hotel' order by created_at, id limit 1);
  v_oa uuid; v_status text;
  adm text := '00000000-0000-0000-0000-00000000f050';
  u text; r jsonb; before_row text; n0 bigint; n1 bigint; o text; m jsonb; k text;
begin
  if v_t is null or v_a is null or v_o is null then raise exception 'FAIL setup: group %, account %, other group %', v_t, v_a, v_o; end if;
  insert into payment_provider_accounts (tenant_id, provider, mode, account_label, secret_reference)
    values (v_o, 'paystack', 'live', 't169 other group', 'env:PAYSTACK_SECRET_T169_OTHER')
    on conflict (tenant_id, provider, mode) do nothing;
  v_oa := (select id from payment_provider_accounts where tenant_id = v_o and mode = 'live');
  v_status := (select status from payment_provider_accounts where id = v_a);   -- read as the system: logins cannot read this table

  -- 1. only a platform admin: support, a hotel owner and the new group's own owner are all told NOT_FOUND, by both functions
  foreach u in array array['00000000-0000-0000-0000-00000000f051', '00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-00000000f053'] loop
    perform t_as(u);
    perform t_expect(format('select platform_provider_check_context(%L, %L)', v_t, v_a), 'NOT_FOUND');
    perform t_expect(format('select platform_log_provider_check(%L, %L, %L, %L)', v_t, v_a, 'ok', 'test'), 'NOT_FOUND');
  end loop;
  perform t_sys();
  select count(*) into n0 from audit_logs where action = 'platform.payment_account_checked';
  if n0 <> 0 then raise exception 'FAIL a refused call wrote % audit rows', n0; end if;

  -- 2. the admin gets the account's own pointer and mode, and only for an account that belongs to the group named
  perform t_as(adm);
  r := platform_provider_check_context(v_t, v_a);
  if r ->> 'provider' <> 'paystack' or r ->> 'mode' <> 'test' or r ->> 'secret_reference' <> 'env:PAYSTACK_SECRET_T50'
     or r ->> 'status' is distinct from v_status then raise exception 'FAIL context %', r; end if;
  if (select count(*) from jsonb_object_keys(r)) <> 4 then raise exception 'FAIL context has extra keys %', r; end if;
  perform t_expect(format('select platform_provider_check_context(%L, %L)', v_t, gen_random_uuid()), 'NOT_FOUND');
  perform t_expect(format('select platform_provider_check_context(%L, %L)', gen_random_uuid(), v_a), 'NOT_FOUND');
  perform t_expect(format('select platform_provider_check_context(%L, %L)', v_t, v_oa), 'NOT_FOUND');   -- another group's account
  perform t_expect(format('select platform_provider_check_context(%L, %L)', v_o, v_a), 'NOT_FOUND');    -- this account named under another group
  perform t_expect(format('select platform_log_provider_check(%L, %L, %L, %L)', v_t, v_oa, 'ok', 'live'), 'NOT_FOUND');
  perform t_expect(format('select platform_log_provider_check(%L, %L, %L, %L)', v_o, v_a, 'ok', 'test'), 'NOT_FOUND');
  perform t_expect(format('select platform_log_provider_check(%L, %L, %L, %L)', v_t, gen_random_uuid(), 'ok', 'test'), 'NOT_FOUND');
  perform t_sys();
  if (select count(*) from audit_logs where action = 'platform.payment_account_checked') <> 0 then raise exception 'FAIL a refused call wrote an audit row'; end if;

  -- 3. bad words are refused before anything is written
  perform t_as(adm);
  perform t_expect(format('select platform_log_provider_check(%L, %L, %L, %L)', v_t, v_a, 'success', 'test'), 'POLICY_VIOLATION: check outcome');
  perform t_expect(format('select platform_log_provider_check(%L, %L, %L, %L)', v_t, v_a, 'ok', 'staging'), 'POLICY_VIOLATION: check outcome');
  perform t_expect(format('select platform_log_provider_check(%L, %L, null, %L)', v_t, v_a, 'test'), 'POLICY_VIOLATION: check outcome');
  perform t_expect(format('select platform_log_provider_check(%L, %L, %L, %L)', v_t, v_a, 'OK', 'test'), 'POLICY_VIOLATION: check outcome');
  perform t_sys();
  if (select count(*) from audit_logs where action = 'platform.payment_account_checked') <> 0 then raise exception 'FAIL a refused word wrote an audit row'; end if;

  -- 4. each outcome the app can produce is accepted and writes exactly one row, under the admin, holding three facts and no secret
  before_row := (select row_to_json(a)::text from payment_provider_accounts a where id = v_a);
  select count(*) into n0 from payment_provider_accounts;
  perform t_as(adm);
  foreach o in array array['ok', 'no_secret', 'bad_key', 'mode_mismatch', 'rejected', 'unreachable', 'unexpected'] loop
    perform platform_log_provider_check(v_t, v_a, o, case when o in ('no_secret', 'bad_key') then null else 'test' end);
  end loop;
  perform t_sys();
  if (select count(*) from audit_logs where action = 'platform.payment_account_checked') <> 7 then raise exception 'FAIL expected one audit row per outcome'; end if;
  for m, k in select metadata, metadata ->> 'outcome' from audit_logs where action = 'platform.payment_account_checked' loop
    if (select count(*) from jsonb_object_keys(m)) <> 3 or not (m ? 'outcome' and m ? 'mode' and m ? 'key_mode') then raise exception 'FAIL metadata shape %', m; end if;
    if m ->> 'mode' <> 'test' then raise exception 'FAIL metadata mode %', m; end if;
    if k in ('no_secret', 'bad_key') and m -> 'key_mode' <> 'null'::jsonb then raise exception 'FAIL key_mode should be null for % %', k, m; end if;
    if k not in ('no_secret', 'bad_key') and m ->> 'key_mode' <> 'test' then raise exception 'FAIL key_mode should be test for % %', k, m; end if;
    if m::text ilike '%PAYSTACK%' or m::text like '%env:%' or m::text ilike '%sk_%' then raise exception 'FAIL the audit row names the secret: %', m; end if;
  end loop;
  if exists (select 1 from audit_logs where action = 'platform.payment_account_checked'
              and (actor_user_id is distinct from adm::uuid or tenant_id <> v_t or entity_type <> 'payment_provider_account' or entity_id <> v_a or property_id is not null))
    then raise exception 'FAIL an audit row is not filed against the account under the admin'; end if;

  -- 5. a check changes nothing else: the account row is byte for byte what it was, no account was added, and the other group's is untouched
  if (select row_to_json(a)::text from payment_provider_accounts a where id = v_a) is distinct from before_row then raise exception 'FAIL a check changed the account'; end if;
  select count(*) into n1 from payment_provider_accounts;
  if n1 <> n0 then raise exception 'FAIL a check changed the number of accounts'; end if;
  if (select status from payment_provider_accounts where id = v_oa) <> 'inactive' then raise exception 'FAIL the other group account changed'; end if;

  -- 6. the platform audit list (migration 126) shows the seven rows under the admin's name, with the field names only
  perform t_as(adm);
  r := platform_audit_events(v_t, 'payment_account_checked');
  if jsonb_array_length(r -> 'events') <> 7 then raise exception 'FAIL the platform audit list shows % checks, expected 7', jsonb_array_length(r -> 'events'); end if;
  if r::text ilike '%PAYSTACK%' or r::text like '%env:%' then raise exception 'FAIL the platform audit list names the secret'; end if;
  perform t_sys();

  delete from payment_provider_accounts where id = v_oa and account_label = 't169 other group';
  raise notice 'PASS payment account check: platform admin only, the account must belong to the group, bad words refused, one audit row per outcome holding only the outcome and modes, the account itself untouched';
end $$;
