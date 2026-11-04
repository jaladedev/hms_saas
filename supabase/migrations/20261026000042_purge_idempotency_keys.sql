-- 042 Idempotency keys expire.
--
-- idempotency_keys has grown without limit since 007: nothing deleted a row, and idem_begin replays a stored answer
-- whatever the age of the key (the 24 hour expires_at column is not enforced there, and is left alone).
-- purge_old_operational_data() now also deletes keys created more than 30 days ago and reports how many in
-- 'idempotency_keys'. 30 days is far beyond any real retry: forms and payment links built from a key live for hours
-- or days, so a key this old can only come from a page left open for a month. After the purge the same key would run
-- as a new request, which is what a month-old resubmit should do (money is still capped by its own checks).
-- The function keeps its signature and grants (service_role only), so the cron route needs no change.

create or replace function purge_old_operational_data() returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_rl integer; v_em integer; v_idem integer;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  delete from rate_limit_hits where window_start < now() - interval '2 days';
  get diagnostics v_rl = row_count;
  delete from email_outbox where status = 'sent' and sent_at < now() - interval '90 days';
  get diagnostics v_em = row_count;
  delete from idempotency_keys where created_at < now() - interval '30 days';
  get diagnostics v_idem = row_count;
  return jsonb_build_object('rate_limit_rows', v_rl, 'emails', v_em, 'idempotency_keys', v_idem);
end $$;
