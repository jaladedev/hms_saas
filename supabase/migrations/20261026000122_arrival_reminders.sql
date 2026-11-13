-- 122 A reminder email a few days before arrival.
--
-- properties.arrival_reminder_days: null = no reminders (the default: nothing is sent to guests until a hotel turns it on),
-- 1 to 7 = send one reminder to each confirmed booking whose arrival is within that many days. set_arrival_reminder_days(property, days)
-- sets it: property.configure at that hotel (anyone else NOT_FOUND); null or 0 turns it off; anything else outside 1 to 7 is
-- refused (INVALID_DAYS). The audit trigger lists the column.
--
-- queue_arrival_reminders(limit): system callers only (the maintenance job, every few minutes). For each hotel with reminders on, a
-- booking gets one 'arrival_reminder' email when it is confirmed (not yet checked in), its arrival is
-- from tomorrow up to arrival_reminder_days days ahead (in the hotel's own timezone), it was made more than 24 hours ago (so a
-- booking made today for tomorrow is not reminded straight after its confirmation), and the guest has an email (a booking with no email is left out of the query, so it can never use up the limit). The email's dedupe key
-- (reminder:<reservation>) makes it once per booking, however often this runs. A booking moved to a later date before its
-- reminder went out is reminded for the new date; one that has already been reminded is not reminded again.
-- Returns how many were queued. Cancelled, expired, no-show and checked-in bookings are never reminded.

alter table email_outbox drop constraint email_outbox_kind_check;
alter table email_outbox add constraint email_outbox_kind_check
  check (kind in ('booking_held', 'booking_confirmed', 'booking_link', 'refund_processed', 'booking_cancelled', 'payment_no_room', 'folio_invoice',
                  'early_checkout_credit', 'stay_changed', 'change_request_answered', 'booking_invoice', 'arrival_reminder'));

alter table properties add column arrival_reminder_days smallint check (arrival_reminder_days is null or arrival_reminder_days between 1 and 7);

drop trigger properties_audit on properties;
create trigger properties_audit after insert or update or delete on properties
  for each row execute function audit_config_row('property', 'name,code,address,city,state,country_code,timezone,currency,check_in_time,check_out_time,status,phone,contact_email,intro,logo_path,theme,theme_primary,theme_font_display,theme_font_body,theme_radius,facilities,social_instagram,social_facebook,arrival_reminder_days');

create function set_arrival_reminder_days(p_property uuid, p_days integer) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_days smallint;
begin
  perform require_permission(p_property, 'property.configure', 'NOT_FOUND');
  if p_days is null or p_days = 0 then
    v_days := null;
  elsif p_days between 1 and 7 then
    v_days := p_days;
  else
    raise exception 'INVALID_DAYS' using errcode = 'P0001';
  end if;
  update properties set arrival_reminder_days = v_days where id = p_property;
end $$;
revoke all on function set_arrival_reminder_days(uuid, integer) from public, anon;
grant execute on function set_arrival_reminder_days(uuid, integer) to authenticated;

create function queue_arrival_reminders(p_limit integer default 200) returns integer
language plpgsql security definer set search_path = public as $$
declare r record; v_queued integer := 0;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  for r in
    select res.id
      from reservations res
      join properties p on p.id = res.property_id
      join guests g on g.id = res.primary_guest_id and btrim(coalesce(g.email, '')) <> ''
     where p.arrival_reminder_days is not null
       and res.reservation_status = 'confirmed'
       and res.arrival_date between property_today(p.id) + 1 and property_today(p.id) + p.arrival_reminder_days
       and res.created_at < now() - interval '24 hours'
       and not exists (select 1 from email_outbox o where o.kind = 'arrival_reminder' and o.dedupe_key = 'reminder:' || res.id)
     order by res.arrival_date, res.id
     limit greatest(least(coalesce(p_limit, 200), 1000), 1)
  loop
    if enqueue_booking_email(r.id, 'arrival_reminder', 'reminder:' || r.id) then v_queued := v_queued + 1; end if;
  end loop;
  return v_queued;
end $$;
revoke all on function queue_arrival_reminders(integer) from public, anon, authenticated;
grant execute on function queue_arrival_reminders(integer) to service_role;
