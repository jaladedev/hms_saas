-- 183 Guest ID type and number (prototype "Create / Edit Guest"). Optional; reverses the 2026-11-12 default "no ID storage", so it is built
-- narrowly. Who may read it and for how long, as decided here (change the rules here, in one place, if the privacy review says otherwise):
--
--   * where: its own table `guest_identity_documents`, one row per guest, NOT columns on `guests`. No existing guest query, view, export,
--     the API or the guest site can pick it up by accident. The table has row-level security with no policy and no privileges for
--     `anon` or `authenticated`: the only doors are the four functions below.
--   * what: `id_type` (nin, passport, drivers_licence, voters_card, other) and `id_number` (6 to 40 letters, digits, spaces, slashes or
--     hyphens; stored trimmed, upper case, single spaces). Both or neither.
--   * who writes: guest.manage in the hotel group (front desk, reservations officer, general manager, owner), through set_guest_id.
--     Clearing it (both fields blank) is the same door.
--   * who sees it masked: guest.view sees the type and the LAST 3 characters only (guest_id_summary), so staff can tell whether an ID is on
--     file and check it against the document in hand.
--   * who sees it in full: only the new permission guest.id_view, given to the owner and general manager (guest_id_reveal), and EVERY
--     reveal writes an audit row (`guest_id.viewed`), so a read leaves a trace the way a change does.
--   * the audit trail names the type, never the number (`guest_id.set` with the type, `guest_id.cleared`, `guest_id.viewed`,
--     `guest_id.purged`).
--   * how long: purge_old_operational_data() deletes an ID 90 days after the guest's last stay ended (a stay that was cancelled, expired
--     or a no-show does not count), or 90 days after it was added when the guest has no stay at all. A guest with a booking now or in the
--     last 90 days keeps theirs. Each purge writes `guest_id.purged`. Deleting the guest deletes the ID.
--   * never copied: not into emails, the API, the channel feed, the digest, exports or the guest site; no code outside these functions
--     reads the table.

insert into permissions (key) values ('guest.id_view');
insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r, permissions p where p.key = 'guest.id_view' and r.key in ('owner', 'general_manager');

create table guest_identity_documents (
  guest_id    uuid primary key references guests (id) on delete cascade,
  tenant_id   uuid not null references tenants (id),
  id_type     text not null check (id_type in ('nin', 'passport', 'drivers_licence', 'voters_card', 'other')),
  id_number   text not null check (length(id_number) between 6 and 40 and id_number ~ '^[A-Z0-9][A-Z0-9 /-]*$'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);
create index on guest_identity_documents (tenant_id);
alter table guest_identity_documents enable row level security;
revoke all on guest_identity_documents from anon, authenticated;

create function set_guest_id(p_guest uuid, p_type text, p_number text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := auth.uid(); g guests%rowtype;
  v_type text := nullif(lower(btrim(coalesce(p_type, ''))), '');
  v_num text := nullif(upper(regexp_replace(btrim(coalesce(p_number, '')), '\s+', ' ', 'g')), '');
begin
  select * into g from guests where id = p_guest;
  if not found or v_actor is null or not has_tenant_permission(g.tenant_id, 'guest.manage') then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if (v_type is null) <> (v_num is null) then raise exception 'POLICY_VIOLATION: id both' using errcode = 'P0001'; end if;
  if v_type is null then
    delete from guest_identity_documents where guest_id = p_guest;
    if found then perform write_audit(g.tenant_id, null, v_actor, 'guest_id.cleared', 'guest', p_guest, null, '{}'::jsonb); end if;
    return;
  end if;
  if v_type not in ('nin', 'passport', 'drivers_licence', 'voters_card', 'other') then raise exception 'POLICY_VIOLATION: id type' using errcode = 'P0001'; end if;
  if length(v_num) not between 6 and 40 or v_num !~ '^[A-Z0-9][A-Z0-9 /-]*$' then raise exception 'POLICY_VIOLATION: id number' using errcode = 'P0001'; end if;
  insert into guest_identity_documents (guest_id, tenant_id, id_type, id_number, updated_by) values (p_guest, g.tenant_id, v_type, v_num, v_actor)
  on conflict (guest_id) do update set id_type = excluded.id_type, id_number = excluded.id_number, updated_at = now(), updated_by = v_actor;
  perform write_audit(g.tenant_id, null, v_actor, 'guest_id.set', 'guest', p_guest, null, jsonb_build_object('id_type', v_type));
end $$;
revoke all on function set_guest_id(uuid, text, text) from public, anon;
grant execute on function set_guest_id(uuid, text, text) to authenticated;

-- The masked view: type and the last three characters. Null when none is on file.
create function guest_id_summary(p_guest uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare g guests%rowtype; d guest_identity_documents%rowtype;
begin
  select * into g from guests where id = p_guest;
  if not found or auth.uid() is null or not has_tenant_permission(g.tenant_id, 'guest.view') then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  select * into d from guest_identity_documents where guest_id = p_guest;
  if not found then return null; end if;
  return jsonb_build_object('id_type', d.id_type, 'last3', right(d.id_number, 3), 'updated_at', d.updated_at);
end $$;
revoke all on function guest_id_summary(uuid) from public, anon;
grant execute on function guest_id_summary(uuid) to authenticated;

-- The full number. Needs guest.id_view and leaves an audit row every time it is called.
create function guest_id_reveal(p_guest uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare g guests%rowtype; d guest_identity_documents%rowtype; v_actor uuid := auth.uid();
begin
  select * into g from guests where id = p_guest;
  if not found or v_actor is null or not has_tenant_permission(g.tenant_id, 'guest.id_view') then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  select * into d from guest_identity_documents where guest_id = p_guest;
  if not found then return null; end if;
  perform write_audit(g.tenant_id, null, v_actor, 'guest_id.viewed', 'guest', p_guest, null, jsonb_build_object('id_type', d.id_type));
  return jsonb_build_object('id_type', d.id_type, 'id_number', d.id_number);
end $$;
revoke all on function guest_id_reveal(uuid) from public, anon;
grant execute on function guest_id_reveal(uuid) to authenticated;

-- Retention. Same function the cron route already calls, with one more count.
create or replace function purge_old_operational_data() returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_rl integer; v_em integer; v_idem integer; v_wl integer; v_dg integer; v_cm integer; v_ee integer; v_sms integer; v_gid integer;
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
  with gone as (
    delete from guest_identity_documents d
     where d.updated_at < now() - interval '90 days'
       and not exists (select 1 from reservations r
                        where r.primary_guest_id = d.guest_id
                          and r.reservation_status not in ('cancelled', 'expired', 'no_show')
                          and r.departure_date >= current_date - 90)
    returning d.guest_id, d.tenant_id
  ), logged as (
    insert into audit_logs (tenant_id, property_id, actor_user_id, action, entity_type, entity_id, request_id, metadata)
    select tenant_id, null, null, 'guest_id.purged', 'guest', guest_id, null, '{}'::jsonb from gone
    returning 1
  )
  select count(*) into v_gid from logged;
  return jsonb_build_object('rate_limit_rows', v_rl, 'emails', v_em, 'idempotency_keys', v_idem, 'waitlist', v_wl, 'digests', v_dg,
                            'contact_messages', v_cm, 'event_emails', v_ee, 'sms', v_sms, 'guest_ids', v_gid);
end $$;
