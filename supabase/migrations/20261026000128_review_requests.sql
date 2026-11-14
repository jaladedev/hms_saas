-- 128 A review request email after check-out.
--
-- properties.review_request_enabled: false by default (nothing is sent to guests until a hotel turns it on).
-- set_review_request(property, enabled): property.configure at that hotel (anyone else NOT_FOUND); null counts as off. The audit trigger lists the column.
--
-- queue_review_requests(limit): system callers only (the maintenance job). For each hotel with it on, a booking gets one 'review_request'
-- email when it is checked out, its last room was checked out between 2 hours and 14 days ago (so turning the setting on does not email
-- guests from months ago), the guest has an email, and no review has been left yet. The dedupe key (review:<reservation>) makes it once
-- per booking, however often this runs. The email links to the booking page, where the guest leaves the review (migration 104).
-- Returns how many were queued.

alter table email_outbox drop constraint email_outbox_kind_check;
alter table email_outbox add constraint email_outbox_kind_check
  check (kind in ('booking_held', 'booking_confirmed', 'booking_link', 'refund_processed', 'booking_cancelled', 'payment_no_room', 'folio_invoice',
                  'early_checkout_credit', 'stay_changed', 'change_request_answered', 'booking_invoice', 'arrival_reminder', 'review_request'));

alter table properties add column review_request_enabled boolean not null default false;

drop trigger properties_audit on properties;
create trigger properties_audit after insert or update or delete on properties
  for each row execute function audit_config_row('property', 'name,code,address,city,state,country_code,timezone,currency,check_in_time,check_out_time,status,phone,contact_email,intro,logo_path,theme,theme_primary,theme_font_display,theme_font_body,theme_radius,facilities,social_instagram,social_facebook,arrival_reminder_days,review_request_enabled');

create function set_review_request(p_property uuid, p_enabled boolean) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform require_permission(p_property, 'property.configure', 'NOT_FOUND');
  update properties set review_request_enabled = coalesce(p_enabled, false) where id = p_property;
end $$;
revoke all on function set_review_request(uuid, boolean) from public, anon;
grant execute on function set_review_request(uuid, boolean) to authenticated;

create function queue_review_requests(p_limit integer default 200) returns integer
language plpgsql security definer set search_path = public as $$
declare r record; v_queued integer := 0;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  for r in
    select res.id
      from reservations res
      join properties p on p.id = res.property_id and p.review_request_enabled
      join guests g on g.id = res.primary_guest_id and btrim(coalesce(g.email, '')) <> ''
      join lateral (select max(rr.checked_out_at) as out_at from reservation_rooms rr where rr.reservation_id = res.id) o on true
     where res.reservation_status = 'checked_out'
       and o.out_at between now() - interval '14 days' and now() - interval '2 hours'
       and not exists (select 1 from guest_reviews gr where gr.reservation_id = res.id)
       and not exists (select 1 from email_outbox e where e.kind = 'review_request' and e.dedupe_key = 'review:' || res.id)
     order by o.out_at, res.id
     limit greatest(least(coalesce(p_limit, 200), 1000), 1)
  loop
    if enqueue_booking_email(r.id, 'review_request', 'review:' || r.id) then v_queued := v_queued + 1; end if;
  end loop;
  return v_queued;
end $$;
revoke all on function queue_review_requests(integer) from public, anon, authenticated;
grant execute on function queue_review_requests(integer) to service_role;
