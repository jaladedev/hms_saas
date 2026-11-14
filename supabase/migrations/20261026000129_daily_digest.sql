-- 129 A morning summary email for the hotel's owner or manager.
--
-- properties.digest_email: null = no summary (the default). set_daily_digest(property, email) sets it: property.configure at that hotel
-- (anyone else NOT_FOUND); a blank or null address turns it off; an address that is not a plausible email (or over 254 characters) is
-- refused (INVALID_EMAIL). The audit trigger lists the column.
--
-- queue_daily_digests(): system callers only (the maintenance job). Once a day per hotel with an address, from 06:00 hotel time, it
-- writes one digest_outbox row for the hotel's own today: arrivals still to come (confirmed bookings arriving today), departures still to
-- go (checked-in bookings leaving today), guests in house (checked in), arrivals tomorrow (confirmed) and holds waiting for payment.
-- Counts only: no guest names or money are emailed. A second run the same day queues nothing (unique per property and date). Returns
-- how many were queued.
--
-- claim_digests(limit) and mark_digest_result(id, ok, error) work like claim_emails and mark_email_result (015): exclusive claims, up to 5 attempts
-- with a 5 minute backoff, a row stuck in 'sending' for 10 minutes is claimed again. Sent rows are deleted after 30 days by purge_old_operational_data.

alter table properties add column digest_email text check (digest_email is null or length(digest_email) <= 254);

drop trigger properties_audit on properties;
create trigger properties_audit after insert or update or delete on properties
  for each row execute function audit_config_row('property', 'name,code,address,city,state,country_code,timezone,currency,check_in_time,check_out_time,status,phone,contact_email,intro,logo_path,theme,theme_primary,theme_font_display,theme_font_body,theme_radius,facilities,social_instagram,social_facebook,arrival_reminder_days,review_request_enabled,digest_email');

create function set_daily_digest(p_property uuid, p_email text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
begin
  perform require_permission(p_property, 'property.configure', 'NOT_FOUND');
  if v_email is not null and (length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then
    raise exception 'INVALID_EMAIL' using errcode = 'P0001';
  end if;
  update properties set digest_email = v_email where id = p_property;
end $$;
revoke all on function set_daily_digest(uuid, text) from public, anon;
grant execute on function set_daily_digest(uuid, text) to authenticated;

create table digest_outbox (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id),
  property_id     uuid not null references properties(id),
  report_date     date not null,
  to_email        text not null,
  payload         jsonb not null,
  status          text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed')),
  attempts        integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  sent_at         timestamptz,
  unique (property_id, report_date)
);
create index digest_outbox_due on digest_outbox (next_attempt_at) where status in ('pending', 'sending');
alter table digest_outbox enable row level security;   -- no policy: server only
revoke all on digest_outbox from authenticated, anon;

create function queue_daily_digests() returns integer
language plpgsql security definer set search_path = public as $$
declare p record; v_today date; v_n integer; v_queued integer := 0;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  for p in
    select id, tenant_id, name, digest_email, timezone from properties
     where digest_email is not null and status = 'active'
       and extract(hour from now() at time zone timezone) >= 6
  loop
    v_today := property_today(p.id);
    insert into digest_outbox (tenant_id, property_id, report_date, to_email, payload)
    select p.tenant_id, p.id, v_today, p.digest_email,
           jsonb_build_object(
             'hotel', p.name, 'date', v_today,
             'arrivals', count(*) filter (where reservation_status = 'confirmed' and arrival_date = v_today),
             'departures', count(*) filter (where reservation_status = 'checked_in' and departure_date = v_today),
             'in_house', count(*) filter (where reservation_status = 'checked_in'),
             'tomorrow', count(*) filter (where reservation_status = 'confirmed' and arrival_date = v_today + 1),
             'holds', count(*) filter (where reservation_status = 'pending'))
      from reservations where property_id = p.id
    on conflict (property_id, report_date) do nothing;
    get diagnostics v_n = row_count;
    v_queued := v_queued + v_n;
  end loop;
  return v_queued;
end $$;
revoke all on function queue_daily_digests() from public, anon, authenticated;
grant execute on function queue_daily_digests() to service_role;

create function claim_digests(p_limit integer default 10) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_out jsonb;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then raise exception 'POLICY_VIOLATION: limit' using errcode = 'P0001'; end if;
  with picked as (
    select id from digest_outbox
     where attempts < 5
       and ((status = 'pending' and next_attempt_at <= now()) or (status = 'sending' and updated_at < now() - interval '10 minutes'))
     order by next_attempt_at, created_at
     limit p_limit
     for update skip locked),
  claimed as (
    update digest_outbox d set status = 'sending', attempts = d.attempts + 1, updated_at = now()
      from picked where d.id = picked.id
    returning d.id, d.to_email, d.payload, d.attempts)
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'to_email', c.to_email, 'payload', c.payload, 'attempt', c.attempts) order by c.attempts, c.id), '[]'::jsonb)
    into v_out from claimed c;
  return v_out;
end $$;
revoke all on function claim_digests(integer) from public, anon, authenticated;
grant execute on function claim_digests(integer) to service_role;

create function mark_digest_result(p_id uuid, p_ok boolean, p_error text default null) returns void
language plpgsql security definer set search_path = public as $$
declare d digest_outbox%rowtype;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select * into d from digest_outbox where id = p_id for update;
  if not found or d.status <> 'sending' then return; end if;
  if p_ok then
    update digest_outbox set status = 'sent', sent_at = now(), last_error = null, updated_at = now() where id = p_id;
  elsif d.attempts >= 5 then
    update digest_outbox set status = 'failed', last_error = left(coalesce(p_error, 'failed'), 500), updated_at = now() where id = p_id;
  else
    update digest_outbox set status = 'pending', last_error = left(coalesce(p_error, 'failed'), 500),
           next_attempt_at = now() + (d.attempts * interval '5 minutes'), updated_at = now() where id = p_id;
  end if;
end $$;
revoke all on function mark_digest_result(uuid, boolean, text) from public, anon, authenticated;
grant execute on function mark_digest_result(uuid, boolean, text) to service_role;

create or replace function purge_old_operational_data() returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_rl integer; v_em integer; v_idem integer; v_wl integer; v_dg integer;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  delete from rate_limit_hits where window_start < now() - interval '2 days';
  get diagnostics v_rl = row_count;
  delete from email_outbox where status = 'sent' and sent_at < now() - interval '90 days';
  get diagnostics v_em = row_count;
  delete from idempotency_keys where created_at < now() - interval '30 days';
  get diagnostics v_idem = row_count;
  delete from waitlist_requests where departure_date < current_date - 30;
  get diagnostics v_wl = row_count;
  delete from digest_outbox where status = 'sent' and sent_at < now() - interval '30 days';
  get diagnostics v_dg = row_count;
  return jsonb_build_object('rate_limit_rows', v_rl, 'emails', v_em, 'idempotency_keys', v_idem, 'waitlist', v_wl, 'digests', v_dg);
end $$;
