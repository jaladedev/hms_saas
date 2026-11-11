-- 094 Monitoring: a heartbeat for the maintenance job and one function that counts what has gone wrong.
--
-- System Design 9.5 asks monitoring to detect payment failures, booking conflicts and failed background jobs. This migration records
-- the facts; the app (lib/ops-health.ts) decides what is worrying and `/api/health` reports it to an uptime monitor.
--
-- ops_heartbeats: one row per background job, written by the job itself when it finishes (record_heartbeat). A job that stops
-- running leaves a row that grows old, which is the only way to notice a job that fails silently, so this is checked by age.
--
-- ops_health(): raw counts only, no judgement. Service role only (it reads server-only tables such as payment_events and the email
-- queue). It changes nothing.
--   maintenance            the heartbeat row for 'maintenance', or null if it has never reported
--   emails_failed_7d       guest emails that gave up in the last 7 days
--   emails_stuck           emails still waiting 30 minutes after they were due
--   payment_events_stuck   provider payment notices received but not processed 10 minutes later (money may not be applied)
--   payment_events_mismatch_7d   provider notices that did not match a payment attempt, last 7 days
--   refunds_stuck          refunds in processing for more than 2 hours (an unknown payout outcome)
--   holds_overdue          held rooms whose hold ended more than 15 minutes ago and was not released
--   paid_inventory_lost    guests who paid for a room that was no longer free (needs a person now)
--   attention_other        other open bookings flagged for attention

create table ops_heartbeats (
  job         text primary key check (length(job) between 1 and 60),
  last_run_at timestamptz not null,
  last_ok_at  timestamptz,
  last_error  text
);
alter table ops_heartbeats enable row level security;   -- no policy: server only
revoke all on ops_heartbeats from authenticated, anon;

create function record_heartbeat(p_job text, p_ok boolean, p_error text default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  insert into ops_heartbeats as h (job, last_run_at, last_ok_at, last_error)
  values (p_job, now(), case when p_ok then now() end, case when p_ok then null else left(coalesce(p_error, 'failed'), 500) end)
  on conflict (job) do update set
    last_run_at = now(),
    last_ok_at  = case when p_ok then now() else h.last_ok_at end,
    last_error  = case when p_ok then null else left(coalesce(p_error, 'failed'), 500) end;
end $$;
revoke all on function record_heartbeat(text, boolean, text) from public, anon, authenticated;
grant execute on function record_heartbeat(text, boolean, text) to service_role;

create function ops_health() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  return jsonb_build_object(
    'maintenance', (select jsonb_build_object('last_run_at', h.last_run_at, 'last_ok_at', h.last_ok_at, 'last_error', h.last_error)
                      from ops_heartbeats h where h.job = 'maintenance'),
    'emails_failed_7d', (select count(*) from email_outbox where status = 'failed' and updated_at > now() - interval '7 days'),
    'emails_stuck', (select count(*) from email_outbox where status in ('pending', 'sending') and next_attempt_at < now() - interval '30 minutes'),
    'payment_events_stuck', (select count(*) from payment_events where processing_status = 'received' and received_at < now() - interval '10 minutes'),
    'payment_events_mismatch_7d', (select count(*) from payment_events where processing_status = 'mismatch' and received_at > now() - interval '7 days'),
    'refunds_stuck', (select count(*) from refunds where refund_status = 'processing' and provider_call_started_at < now() - interval '2 hours'),
    'holds_overdue', (select count(*) from room_inventory_claims where claim_type = 'hold' and status = 'active' and hold_expires_at < now() - interval '15 minutes'),
    'paid_inventory_lost', (select count(*) from reservations where attention_reason = 'paid_inventory_lost' and reservation_status in ('pending', 'confirmed', 'checked_in')),
    'attention_other', (select count(*) from reservations where attention_reason is not null and attention_reason <> 'paid_inventory_lost' and reservation_status in ('pending', 'confirmed', 'checked_in'))
  );
end $$;
revoke all on function ops_health() from public, anon, authenticated;
grant execute on function ops_health() to service_role;
