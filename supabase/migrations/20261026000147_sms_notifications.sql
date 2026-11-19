-- 147 SMS and WhatsApp notifications (TODO 8.1).
--
-- Guests get a short text for three things: a website booking that is confirmed ('booking_confirmed'), a reminder before arrival
-- ('arrival_reminder') and a request to rate the stay after check-out ('review_request'). Nothing is sent until a hotel group's plan
-- has the sms_notifications flag (a missing row means on, like every flag) AND a person with property.configure turns it on for
-- the property. Staff-entered bookings send nothing, the same rule as email (015).
--
-- A text never carries the signed booking link (a link of that length costs several message parts and a text is easier to read over
-- someone's shoulder than an email): it carries the booking reference and the hotel's lookup page, /booking/find, where the guest
-- gets a fresh emailed link. The app builds the wording when it sends (lib/sms), from what claim_sms returns.
--
-- Settings, on properties (all audited by the properties trigger):
--   sms_enabled        false by default
--   sms_kinds          which of the three kinds this hotel sends; default booking_confirmed and arrival_reminder
--   sms_channel        'sms' (default) or 'whatsapp'. A hotel-started WhatsApp message needs a template approved with the provider;
--                      the provider adapter sends plain text, so 'whatsapp' only works for a provider account set up for it
--   sms_monthly_cap    most messages queued per calendar month in the hotel's time zone, 0 to 100000, default 300. A soft limit: two
--                      messages queued in the same instant can both pass the check, so the count may end a few over
--   sms_reminder_days  how many days before arrival the reminder goes (1 to 7, default 1); independent of the email reminder (122)
-- set_sms_settings(property, enabled, kinds, channel, monthly_cap, reminder_days): property.configure (anyone else NOT_FOUND), and
-- NOT_FOUND when the plan does not include the feature. Unknown kinds, channels or numbers are refused (INVALID_SMS_SETTING).
--
-- guest_sms_status(reservation) tells the booking page whether to show the opt-out box (the hotel texts this guest, or the guest has opted out).
-- Opt-out: guests.sms_opt_out. Staff with guest.manage change it with set_guest_sms_opt_out (audited, NOT_FOUND otherwise); a guest
-- changes their own from the booking page through guest_set_sms_opt_out (service role only: the app has already checked the signed
-- link). An opted-out guest is never queued, and a message already queued is dropped at claim time.
--
-- Numbers: phone_to_e164(phone, country) turns what the guest typed into +<country><number> or null. Spaces, dashes, dots and
-- brackets are ignored; 00 becomes +; a Nigerian mobile written 0803... (11 digits) becomes +234803.... Any other country needs the +.
-- Nigerian numbers must be mobile numbers (070, 080, 081, 090 and 091 ranges), so a landline never queues a text that cannot arrive.
--
-- sms_outbox works like email_outbox (015): rows are written by triggers or the queue function in the same transaction as the change
-- they report, claimed with FOR UPDATE SKIP LOCKED, retried with a back-off up to 5 times, then left 'failed' for staff. A row stuck
-- in 'sending' for 10 minutes is claimed again; the sender passes the row id as the provider's reference. A permanent refusal (the
-- provider says the number is invalid) can be marked failed at once (mark_sms_result p_permanent). Server only; no policy.
--
-- sms_usage(property) and sms_recent_failures(property): property.configure, for the settings screen. Usage also says whether the plan
-- includes the feature (plan_enabled), so the screen can say so instead of showing a form that would be refused. Failures show the number masked.
-- Rows older than 400 days are purged (usage keeps a year).

-- ---- plan flag -----------------------------------------------------------------------------------------------------
create or replace function plan_enforced_flags() returns text[]
language sql immutable set search_path = public as $$
  select array['reports.export', 'online_payments', 'discounts', 'online_booking', 'guest_cancel', 'guest_changes', 'early_checkin',
               'housekeeping', 'maintenance', 'audit_log', 'branding', 'dynamic_pricing', 'sms_notifications']
$$;

-- The placeholder Standard and Pro plans include it; Starter does not (to be decided with the prices, see /platform/plans).
update plans set features = (select array_agg(distinct k order by k) from unnest(features || array['sms_notifications']) k)
 where code in ('standard', 'pro');

-- ---- settings and opt-out columns ------------------------------------------------------------------------------------
alter table properties
  add column sms_enabled boolean not null default false,
  add column sms_kinds text[] not null default array['booking_confirmed', 'arrival_reminder'],
  add column sms_channel text not null default 'sms' check (sms_channel in ('sms', 'whatsapp')),
  add column sms_monthly_cap integer not null default 300 check (sms_monthly_cap between 0 and 100000),
  add column sms_reminder_days smallint not null default 1 check (sms_reminder_days between 1 and 7),
  add constraint properties_sms_kinds_valid check (sms_kinds <@ array['booking_confirmed', 'arrival_reminder', 'review_request']);

alter table guests add column sms_opt_out boolean not null default false;

drop trigger properties_audit on properties;
create trigger properties_audit after insert or update or delete on properties
  for each row execute function audit_config_row('property', 'name,code,address,city,state,country_code,timezone,currency,check_in_time,check_out_time,status,phone,contact_email,intro,logo_path,theme,theme_primary,theme_font_display,theme_font_body,theme_radius,facilities,social_instagram,social_facebook,arrival_reminder_days,review_request_enabled,digest_email,waitlist_email_enabled,sms_enabled,sms_kinds,sms_channel,sms_monthly_cap,sms_reminder_days');

-- ---- phone numbers -------------------------------------------------------------------------------------------------------
create function phone_to_e164(p_phone text, p_country text default 'NG') returns text
language plpgsql immutable set search_path = public as $$
declare s text := regexp_replace(coalesce(p_phone, ''), '[\s().-]', '', 'g');
begin
  if s = '' or length(s) > 20 then return null; end if;
  if s ~ '^00' then s := '+' || substr(s, 3); end if;
  if s !~ '^\+' then
    if upper(coalesce(p_country, '')) = 'NG' and s ~ '^0[789]\d{9}$' then
      s := '+234' || substr(s, 2);
    elsif upper(coalesce(p_country, '')) = 'NG' and s ~ '^234[789]\d{9}$' then
      s := '+' || s;
    else
      return null;
    end if;
  end if;
  if s !~ '^\+[1-9]\d{7,14}$' then return null; end if;
  if s ~ '^\+234' and s !~ '^\+234[789]\d{9}$' then return null; end if;   -- a Nigerian number must be a mobile number
  return s;
end $$;
revoke all on function phone_to_e164(text, text) from public, anon, authenticated;

-- ---- the outbox ------------------------------------------------------------------------------------------------------------
create table sms_outbox (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenants(id),
  property_id          uuid not null references properties(id),
  reservation_id       uuid not null references reservations(id),
  kind                 text not null check (kind in ('booking_confirmed', 'arrival_reminder', 'review_request')),
  channel              text not null check (channel in ('sms', 'whatsapp')),
  to_phone             text not null check (to_phone ~ '^\+[1-9]\d{7,14}$'),
  payload              jsonb not null default '{}'::jsonb,
  dedupe_key           text,
  status               text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed')),
  attempts             integer not null default 0,
  next_attempt_at      timestamptz not null default now(),
  last_error           text,
  provider_message_id  text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  sent_at              timestamptz
);
create unique index sms_outbox_dedupe on sms_outbox (kind, dedupe_key) where dedupe_key is not null;
create index sms_outbox_due on sms_outbox (next_attempt_at) where status in ('pending', 'sending');
create index sms_outbox_usage on sms_outbox (property_id, created_at);
alter table sms_outbox enable row level security;   -- no policy: server only
revoke all on sms_outbox from authenticated, anon;

-- ---- enqueue (internal) ----------------------------------------------------------------------------------------------------
create function enqueue_sms(p_reservation uuid, p_kind text, p_dedupe text, p_payload jsonb default '{}'::jsonb) returns boolean
language plpgsql security definer set search_path = public as $$
declare r reservations%rowtype; p properties%rowtype; g guests%rowtype; v_phone text; v_used integer; v_n integer;
begin
  select * into r from reservations where id = p_reservation;
  if not found then return false; end if;
  select * into p from properties where id = r.property_id;
  if not p.sms_enabled or not (p_kind = any (p.sms_kinds)) then return false; end if;
  if not tenant_feature_on(p.tenant_id, 'sms_notifications') then return false; end if;
  select * into g from guests where id = r.primary_guest_id;
  if not found or g.sms_opt_out then return false; end if;
  v_phone := phone_to_e164(g.phone, coalesce(g.country_code, p.country_code, 'NG'));
  if v_phone is null then return false; end if;
  select count(*) into v_used from sms_outbox o
   where o.property_id = p.id and o.status <> 'failed'
     and o.created_at >= date_trunc('month', now() at time zone p.timezone) at time zone p.timezone;
  if v_used >= p.sms_monthly_cap then return false; end if;
  insert into sms_outbox (tenant_id, property_id, reservation_id, kind, channel, to_phone, payload, dedupe_key)
  values (r.tenant_id, r.property_id, r.id, p_kind, p.sms_channel, v_phone, coalesce(p_payload, '{}'::jsonb), p_dedupe)
  on conflict (kind, dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics v_n = row_count;
  return v_n > 0;
end $$;
revoke all on function enqueue_sms(uuid, text, text, jsonb) from public, anon, authenticated;

create function reservations_sms_trigger() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.source = 'website' and new.reservation_status = 'confirmed' and old.reservation_status in ('pending', 'expired') then
    perform enqueue_sms(new.id, 'booking_confirmed', 'confirmed:' || new.id);
  end if;
  return null;
end $$;
create trigger reservations_sms_upd after update of reservation_status on reservations
  for each row when (old.reservation_status is distinct from new.reservation_status)
  execute function reservations_sms_trigger();

-- ---- reminders and review requests (the maintenance job) -----------------------------------------------------------------------
create function queue_sms_messages(p_limit integer default 200) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r record; v_lim integer := greatest(least(coalesce(p_limit, 200), 1000), 1); v_rem integer := 0; v_rev integer := 0;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  -- arrival reminders: confirmed, from tomorrow up to sms_reminder_days ahead in the hotel's own time zone, made over 24 hours ago
  for r in
    select res.id
      from reservations res
      join properties p on p.id = res.property_id and p.sms_enabled and 'arrival_reminder' = any (p.sms_kinds)
      join guests g on g.id = res.primary_guest_id and not g.sms_opt_out and btrim(coalesce(g.phone, '')) <> ''
     where res.reservation_status = 'confirmed'
       and res.arrival_date between property_today(p.id) + 1 and property_today(p.id) + p.sms_reminder_days
       and res.created_at < now() - interval '24 hours'
       and not exists (select 1 from sms_outbox o where o.kind = 'arrival_reminder' and o.dedupe_key = 'reminder:' || res.id)
     order by res.arrival_date, res.id
     limit v_lim
  loop
    if enqueue_sms(r.id, 'arrival_reminder', 'reminder:' || r.id) then v_rem := v_rem + 1; end if;
  end loop;
  -- review requests: checked out between 2 hours and 14 days ago, no review yet
  for r in
    select res.id
      from reservations res
      join properties p on p.id = res.property_id and p.sms_enabled and 'review_request' = any (p.sms_kinds)
      join guests g on g.id = res.primary_guest_id and not g.sms_opt_out and btrim(coalesce(g.phone, '')) <> ''
      join lateral (select max(rr.checked_out_at) as out_at from reservation_rooms rr where rr.reservation_id = res.id) o on true
     where res.reservation_status = 'checked_out'
       and o.out_at between now() - interval '14 days' and now() - interval '2 hours'
       and not exists (select 1 from guest_reviews gr where gr.reservation_id = res.id)
       and not exists (select 1 from sms_outbox s where s.kind = 'review_request' and s.dedupe_key = 'review:' || res.id)
     order by o.out_at, res.id
     limit v_lim
  loop
    if enqueue_sms(r.id, 'review_request', 'review:' || r.id) then v_rev := v_rev + 1; end if;
  end loop;
  return jsonb_build_object('arrival_reminder', v_rem, 'review_request', v_rev);
end $$;
revoke all on function queue_sms_messages(integer) from public, anon, authenticated;
grant execute on function queue_sms_messages(integer) to service_role;

-- ---- claim and result (the sender) ---------------------------------------------------------------------------------------------
create function claim_sms(p_limit integer default 10) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_out jsonb;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then raise exception 'POLICY_VIOLATION: limit' using errcode = 'P0001'; end if;
  -- a guest who opted out, or a hotel that switched it off, after the row was queued: drop it without sending
  update sms_outbox o set status = 'failed', last_error = 'not sent: switched off or opted out', updated_at = now()
   where o.status = 'pending' and o.next_attempt_at <= now()
     and (not exists (select 1 from properties p where p.id = o.property_id and p.sms_enabled)
          or exists (select 1 from reservations r join guests g on g.id = r.primary_guest_id where r.id = o.reservation_id and g.sms_opt_out));
  with picked as (
    select id from sms_outbox
     where attempts < 5
       and ((status = 'pending' and next_attempt_at <= now()) or (status = 'sending' and updated_at < now() - interval '10 minutes'))
     order by next_attempt_at, created_at
     limit p_limit
     for update skip locked),
  claimed as (
    update sms_outbox o set status = 'sending', attempts = o.attempts + 1, updated_at = now()
      from picked where o.id = picked.id
    returning o.id, o.kind, o.channel, o.to_phone, o.payload, o.attempts, o.reservation_id, o.tenant_id, o.property_id)
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'kind', c.kind, 'channel', c.channel, 'to_phone', c.to_phone, 'payload', c.payload, 'attempt', c.attempts,
           'hotel_phone', (select nullif(btrim(p.phone), '') from properties p where p.id = c.property_id),
           'site_host', (select d.host from tenant_domains d
                          where d.tenant_id = c.tenant_id and d.verified_at is not null and (d.property_id is null or d.property_id = c.property_id)
                          order by (d.property_id is not null) desc, d.host limit 1),
           'booking', guest_booking_status(c.reservation_id)) order by c.attempts, c.id), '[]'::jsonb)
    into v_out from claimed c;
  return v_out;
end $$;
revoke all on function claim_sms(integer) from public, anon, authenticated;
grant execute on function claim_sms(integer) to service_role;

create function mark_sms_result(p_id uuid, p_ok boolean, p_error text default null, p_provider_id text default null, p_permanent boolean default false)
returns void language plpgsql security definer set search_path = public as $$
declare d sms_outbox%rowtype;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select * into d from sms_outbox where id = p_id for update;
  if not found or d.status <> 'sending' then return; end if;
  if p_ok then
    update sms_outbox set status = 'sent', sent_at = now(), last_error = null, provider_message_id = left(p_provider_id, 100), updated_at = now() where id = p_id;
  elsif coalesce(p_permanent, false) or d.attempts >= 5 then
    update sms_outbox set status = 'failed', last_error = left(coalesce(p_error, 'failed'), 500), updated_at = now() where id = p_id;
  else
    update sms_outbox set status = 'pending', last_error = left(coalesce(p_error, 'failed'), 500),
           next_attempt_at = now() + (d.attempts * interval '5 minutes'), updated_at = now() where id = p_id;
  end if;
end $$;
revoke all on function mark_sms_result(uuid, boolean, text, text, boolean) from public, anon, authenticated;
grant execute on function mark_sms_result(uuid, boolean, text, text, boolean) to service_role;

-- ---- settings (staff) ------------------------------------------------------------------------------------------------------------
create function set_sms_settings(p_property uuid, p_enabled boolean, p_kinds text[], p_channel text, p_monthly_cap integer, p_reminder_days integer)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_kinds text[]; v_channel text := coalesce(nullif(btrim(p_channel), ''), 'sms');
begin
  perform require_permission(p_property, 'property.configure', 'NOT_FOUND');
  if not tenant_feature_on((select tenant_id from properties where id = p_property), 'sms_notifications') then
    raise exception 'NOT_FOUND' using errcode = 'P0001';
  end if;
  select coalesce(array_agg(distinct k order by k), '{}') into v_kinds from unnest(coalesce(p_kinds, '{}')) k;
  if not (v_kinds <@ array['booking_confirmed', 'arrival_reminder', 'review_request'])
     or v_channel not in ('sms', 'whatsapp')
     or p_monthly_cap is null or p_monthly_cap not between 0 and 100000
     or p_reminder_days is null or p_reminder_days not between 1 and 7 then
    raise exception 'INVALID_SMS_SETTING' using errcode = 'P0001';
  end if;
  update properties
     set sms_enabled = coalesce(p_enabled, false), sms_kinds = v_kinds, sms_channel = v_channel,
         sms_monthly_cap = p_monthly_cap, sms_reminder_days = p_reminder_days
   where id = p_property;
end $$;
revoke all on function set_sms_settings(uuid, boolean, text[], text, integer, integer) from public, anon;
grant execute on function set_sms_settings(uuid, boolean, text[], text, integer, integer) to authenticated;

create function set_guest_sms_opt_out(p_guest uuid, p_opt_out boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g guests%rowtype; v_actor uuid := auth.uid();
begin
  select * into g from guests where id = p_guest for update;
  if not found or v_actor is null or not has_tenant_permission(g.tenant_id, 'guest.manage') then
    raise exception 'NOT_FOUND' using errcode = 'P0001';
  end if;
  if p_opt_out is null then raise exception 'POLICY_VIOLATION: opt_out' using errcode = 'P0001'; end if;
  if g.sms_opt_out = p_opt_out then return jsonb_build_object('guest_id', g.id, 'changed', false, 'sms_opt_out', g.sms_opt_out); end if;
  update guests set sms_opt_out = p_opt_out where id = g.id;
  perform write_audit(g.tenant_id, null, v_actor, 'guest.sms_opt_out_changed', 'guest', g.id, null, jsonb_build_object('sms_opt_out', p_opt_out, 'by', 'staff'));
  return jsonb_build_object('guest_id', g.id, 'changed', true, 'sms_opt_out', p_opt_out);
end $$;
revoke all on function set_guest_sms_opt_out(uuid, boolean) from public, anon;
grant execute on function set_guest_sms_opt_out(uuid, boolean) to authenticated;

-- The guest, from their own booking page. The app has checked the signed link; the database only accepts a system caller.
create function guest_set_sms_opt_out(p_reservation uuid, p_opt_out boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g guests%rowtype; r reservations%rowtype;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  if p_opt_out is null then raise exception 'POLICY_VIOLATION: opt_out' using errcode = 'P0001'; end if;
  select * into r from reservations where id = p_reservation;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  select * into g from guests where id = r.primary_guest_id for update;
  if g.sms_opt_out = p_opt_out then return jsonb_build_object('changed', false, 'sms_opt_out', g.sms_opt_out); end if;
  update guests set sms_opt_out = p_opt_out where id = g.id;
  perform write_audit(g.tenant_id, r.property_id, null, 'guest.sms_opt_out_changed', 'guest', g.id, null, jsonb_build_object('sms_opt_out', p_opt_out, 'by', 'guest'));
  return jsonb_build_object('changed', true, 'sms_opt_out', p_opt_out);
end $$;
revoke all on function guest_set_sms_opt_out(uuid, boolean) from public, anon, authenticated;
grant execute on function guest_set_sms_opt_out(uuid, boolean) to service_role;

-- What the guest's booking page needs to know: whether this hotel texts at all (the setting, the plan, and a usable number on the
-- booking) and whether the guest has opted out. Service role only; the app has checked the signed link.
create function guest_sms_status(p_reservation uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r reservations%rowtype; p properties%rowtype; g guests%rowtype;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select * into r from reservations where id = p_reservation;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  select * into p from properties where id = r.property_id;
  select * into g from guests where id = r.primary_guest_id;
  return jsonb_build_object(
    'hotel_texts', p.sms_enabled and cardinality(p.sms_kinds) > 0 and tenant_feature_on(p.tenant_id, 'sms_notifications')
                   and phone_to_e164(g.phone, coalesce(g.country_code, p.country_code, 'NG')) is not null,
    'opt_out', g.sms_opt_out);
end $$;
revoke all on function guest_sms_status(uuid) from public, anon, authenticated;
grant execute on function guest_sms_status(uuid) to service_role;

-- ---- usage and failures (staff) ----------------------------------------------------------------------------------------------------
create function sms_usage(p_property uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare p properties%rowtype; v_start timestamptz;
begin
  perform require_permission(p_property, 'property.configure', 'NOT_FOUND');
  select * into p from properties where id = p_property;
  v_start := date_trunc('month', now() at time zone p.timezone) at time zone p.timezone;
  return jsonb_build_object(
    'plan_enabled', tenant_feature_on(p.tenant_id, 'sms_notifications'),
    'cap', p.sms_monthly_cap,
    'used_this_month', (select count(*) from sms_outbox o where o.property_id = p.id and o.status <> 'failed' and o.created_at >= v_start),
    'months', coalesce((
      select jsonb_agg(jsonb_build_object('month', m.month, 'sent', m.sent, 'waiting', m.waiting, 'failed', m.failed) order by m.month desc)
        from (select to_char(date_trunc('month', o.created_at at time zone p.timezone), 'YYYY-MM') as month,
                     count(*) filter (where o.status = 'sent') as sent,
                     count(*) filter (where o.status in ('pending', 'sending')) as waiting,
                     count(*) filter (where o.status = 'failed') as failed
                from sms_outbox o
               where o.property_id = p.id and o.created_at >= v_start - interval '5 months'
               group by 1) m), '[]'::jsonb));
end $$;
revoke all on function sms_usage(uuid) from public, anon;
grant execute on function sms_usage(uuid) to authenticated;

create function sms_recent_failures(p_property uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_permission(p_property, 'property.configure', 'NOT_FOUND');
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', f.id, 'kind', f.kind, 'to', left(f.to_phone, 4) || repeat('•', greatest(length(f.to_phone) - 7, 0)) || right(f.to_phone, 3),
                                        'error', f.last_error, 'attempts', f.attempts, 'created_at', f.created_at) order by f.created_at desc)
      from (select * from sms_outbox o where o.property_id = p_property and o.status = 'failed' order by o.created_at desc limit 20) f), '[]'::jsonb);
end $$;
revoke all on function sms_recent_failures(uuid) from public, anon;
grant execute on function sms_recent_failures(uuid) to authenticated;

-- ---- purge ---------------------------------------------------------------------------------------------------------------------------
create or replace function purge_old_operational_data() returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_rl integer; v_em integer; v_idem integer; v_wl integer; v_dg integer; v_cm integer; v_ee integer; v_sms integer;
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
  delete from contact_messages where created_at < now() - interval '90 days';
  get diagnostics v_cm = row_count;
  delete from event_email_outbox where status = 'sent' and sent_at < now() - interval '90 days';
  get diagnostics v_ee = row_count;
  delete from sms_outbox where status in ('sent', 'failed') and created_at < now() - interval '400 days';
  get diagnostics v_sms = row_count;
  return jsonb_build_object('rate_limit_rows', v_rl, 'emails', v_em, 'idempotency_keys', v_idem, 'waitlist', v_wl, 'digests', v_dg,
                            'contact_messages', v_cm, 'event_emails', v_ee, 'sms', v_sms);
end $$;
