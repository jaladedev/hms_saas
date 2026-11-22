-- 179 AI helpers, first cut (TODO 8.14): reply drafts for guest messages on /app/messages.
-- What this is: a button that asks a language model to write a first draft of a reply. The draft appears in a box for staff to edit and copy.
-- Nothing is sent from here, nothing is stored, and no money, availability or booking is ever read or changed by it.
-- What leaves the system: only the guest's first name, the message text and the hotel's name. Not the email address, not the surname, not any booking.
-- Switched off unless the hotel group has an entitlement row 'ai_helpers' with enabled = true. This is the opposite of the other flags, where a missing
-- row means on: here a missing row means OFF (a helper that sends guest text to a third party must be switched on on purpose). The flag is in
-- plan_enforced_flags, so applying a plan sets it (no existing plan includes it, so applying a plan turns it off). The platform switches it on for one
-- hotel group after the privacy review has covered the model provider (TODO: privacy review).
--   ai_helpers_on(property)       true when the caller may use drafts at that hotel (reservation.modify) and the plan has the flag; else false
--   ai_reply_context(message)     what the server sends to the model; refuses with NOT_FOUND without the permission, POLICY_VIOLATION: ai off without the flag
-- The call to the model is made by the app server (lib/ai/reply-draft.ts), limited to 30 drafts an hour per hotel.

create or replace function plan_enforced_flags() returns text[]
language sql immutable set search_path = public as $$
  select array['reports.export', 'online_payments', 'discounts', 'online_booking', 'guest_cancel', 'guest_changes', 'early_checkin',
               'housekeeping', 'maintenance', 'audit_log', 'branding', 'dynamic_pricing', 'sms_notifications', 'restaurant_pos', 'group_bookings', 'inventory',
               'guest_services', 'api_access', 'loyalty', 'staff_hr', 'multi_currency', 'channel_manager', 'ai_helpers']
$$;
revoke all on function plan_enforced_flags() from public, anon;

create function ai_enabled(p_tenant uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from tenant_feature_entitlements where tenant_id = p_tenant and feature_key = 'ai_helpers' and enabled)
$$;
revoke all on function ai_enabled(uuid) from public, anon, authenticated;

create function ai_helpers_on(p_property uuid) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare v_tenant uuid;
begin
  select tenant_id into v_tenant from properties where id = p_property;
  if v_tenant is null or not has_permission(p_property, 'reservation.modify') then return false; end if;
  return ai_enabled(v_tenant);
end $$;
revoke all on function ai_helpers_on(uuid) from public, anon;
grant execute on function ai_helpers_on(uuid) to authenticated;

create function ai_reply_context(p_message uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare m contact_messages%rowtype; v_actor uuid; p properties%rowtype;
begin
  select * into m from contact_messages where id = p_message;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(m.property_id, 'reservation.modify', 'NOT_FOUND');
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if not ai_enabled(m.tenant_id) then raise exception 'POLICY_VIOLATION: ai off' using errcode = 'P0001'; end if;
  select * into p from properties where id = m.property_id;
  return jsonb_build_object('property_id', m.property_id, 'hotel', p.name,
                            'first_name', left(split_part(btrim(m.guest_name), ' ', 1), 40), 'message', left(m.message, 2000));
end $$;
revoke all on function ai_reply_context(uuid) from public, anon;
grant execute on function ai_reply_context(uuid) to authenticated;
