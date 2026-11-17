-- 137 Contact messages: a guest writes to the hotel from the contact page; staff read the messages in an inbox and mark them handled.
-- Nothing is emailed and no reply is sent from the system: staff answer by email or phone themselves.
--
--   contact_messages              one row per message. Staff with reservation.view may read; all writes go through the functions.
--   guest_send_message(host, name, email, message)
--                                 service_role (the app rate limits). Host picks the hotel (resolve_host). POLICY_VIOLATION: contact name |
--                                 email | message (5 to 2000 characters) | too many (5 per email and hotel per day). The same email sending
--                                 the same text again within a day is a no-op that returns the existing id (`created` false).
--   contact_messages_list(property)
--                                 reservation.view. New messages (oldest first) and those handled in the last 30 days (newest first), at most 200.
--   contact_message_set_status(id, status)
--                                 reservation.modify. 'new' | 'handled'. NOT_FOUND for no permission, another hotel or unknown.
--                                 Audited as contact.status.
--   purge_old_operational_data()  also deletes messages older than 90 days (personal data is not kept).

create table contact_messages (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  property_id uuid not null,
  guest_name  text not null check (length(guest_name) between 2 and 80),
  email       text not null check (length(email) between 5 and 254),
  message     text not null check (length(message) between 5 and 2000),
  status      text not null default 'new' check (status in ('new', 'handled')),
  created_at  timestamptz not null default now(),
  handled_by  uuid,
  handled_at  timestamptz,
  foreign key (tenant_id, property_id) references properties (tenant_id, id)
);
create index contact_messages_property_idx on contact_messages (property_id, status, created_at);

alter table contact_messages enable row level security;
create policy contact_messages_select on contact_messages for select to authenticated using (has_permission(property_id, 'reservation.view'));
revoke insert, update, delete on contact_messages from authenticated, anon;

create function guest_send_message(p_host text, p_name text, p_email text, p_message text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid; v_property uuid; v_name text := btrim(coalesce(p_name, '')); v_email text := lower(btrim(coalesce(p_email, '')));
  v_msg text := btrim(coalesce(p_message, '')); v_id uuid;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select h.tenant_id, h.property_id into v_tenant, v_property from resolve_host(p_host) h;
  if v_property is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;

  if length(v_name) < 2 or length(v_name) > 80 then raise exception 'POLICY_VIOLATION: contact name' using errcode = 'P0001'; end if;
  if length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'POLICY_VIOLATION: contact email' using errcode = 'P0001'; end if;
  if length(v_msg) < 5 or length(v_msg) > 2000 then raise exception 'POLICY_VIOLATION: contact message' using errcode = 'P0001'; end if;

  select id into v_id from contact_messages
   where property_id = v_property and lower(email) = v_email and message = v_msg and created_at > now() - interval '1 day';
  if found then return jsonb_build_object('message_id', v_id, 'created', false); end if;

  if (select count(*) from contact_messages where property_id = v_property and lower(email) = v_email and created_at > now() - interval '1 day') >= 5 then
    raise exception 'POLICY_VIOLATION: contact too many' using errcode = 'P0001';
  end if;

  insert into contact_messages (tenant_id, property_id, guest_name, email, message) values (v_tenant, v_property, v_name, v_email, v_msg)
  returning id into v_id;
  return jsonb_build_object('message_id', v_id, 'created', true);
end $$;
revoke all on function guest_send_message(text, text, text, text) from public, anon, authenticated;
grant execute on function guest_send_message(text, text, text, text) to service_role;

create function contact_messages_list(p_property uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_permission(p_property, 'reservation.view', 'NOT_FOUND');
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', m.id, 'guest_name', m.guest_name, 'email', m.email, 'message', m.message,
                                        'status', m.status, 'created_at', m.created_at, 'handled_at', m.handled_at)
                     order by (m.status = 'new') desc, case when m.status = 'new' then m.created_at end asc, m.handled_at desc)
    from (select * from contact_messages
           where property_id = p_property and (status = 'new' or handled_at > now() - interval '30 days')
           order by (status = 'new') desc, created_at desc limit 200) m
  ), '[]'::jsonb);
end $$;
revoke all on function contact_messages_list(uuid) from public, anon;
grant execute on function contact_messages_list(uuid) to authenticated;

create function contact_message_set_status(p_id uuid, p_status text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare m contact_messages%rowtype; v_actor uuid;
begin
  select * into m from contact_messages where id = p_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(m.property_id, 'reservation.modify', 'NOT_FOUND');
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if p_status is null or p_status not in ('new', 'handled') then raise exception 'POLICY_VIOLATION: status' using errcode = 'P0001'; end if;
  if m.status <> p_status then
    update contact_messages set status = p_status, handled_by = case when p_status = 'handled' then v_actor end,
                                handled_at = case when p_status = 'handled' then now() end where id = m.id;
    perform write_audit(m.tenant_id, m.property_id, v_actor, 'contact.status', 'contact_message', m.id, null,
                        jsonb_build_object('from', m.status, 'to', p_status));
  end if;
  return jsonb_build_object('message_id', m.id, 'status', p_status, 'changed', m.status <> p_status);
end $$;
revoke all on function contact_message_set_status(uuid, text) from public, anon;
grant execute on function contact_message_set_status(uuid, text) to authenticated;

create or replace function purge_old_operational_data() returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_rl integer; v_em integer; v_idem integer; v_wl integer; v_dg integer; v_cm integer;
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
  return jsonb_build_object('rate_limit_rows', v_rl, 'emails', v_em, 'idempotency_keys', v_idem, 'waitlist', v_wl, 'digests', v_dg,
                            'contact_messages', v_cm);
end $$;
