-- 110 Support tickets, kept by the platform team about a hotel group (prototype "Support Workspace": the ticket list).
--
-- Internal bookkeeping only: a ticket is a title, optional details, a priority (normal or high) and a status (open, in progress,
-- resolved, closed), with notes added over time. Hotels do not see tickets, and nothing in a ticket is a reservation, guest, payment
-- or secret: it says what the hotel asked or what is wrong, in the platform team's words.
--
-- platform_open_ticket(tenant, title, details, priority)   admin. Number TK-000001 and up (one sequence).
-- platform_add_ticket_note(ticket, note)                   admin. Notes are only added, never edited or removed.
-- platform_set_ticket_status(ticket, status)               admin. resolved and closed record when; opening it again clears that.
-- platform_list_tickets(tenant, status)                    support or admin. Newest first, at most 200; either filter may be null.
-- platform_ticket_detail(ticket)                           support or admin. The ticket and its notes, oldest note first.
-- As with platform invoices, support is read only. Both tables are closed to logins and audited by the 047 trigger (actor auth.uid()).

create sequence platform_ticket_seq;

create table support_tickets (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  number      text not null unique,
  title       text not null check (char_length(title) between 3 and 120 and title = btrim(title)),
  details     text check (details is null or (char_length(details) between 1 and 2000 and details = btrim(details))),
  priority    text not null default 'normal' check (priority in ('normal', 'high')),
  status      text not null default 'open' check (status in ('open', 'in_progress', 'resolved', 'closed')),
  resolved_at timestamptz,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check ((status in ('resolved', 'closed')) = (resolved_at is not null))
);
create index support_tickets_tenant on support_tickets (tenant_id, created_at desc);
create trigger support_tickets_updated before update on support_tickets for each row execute function set_updated_at();

create table support_ticket_notes (
  id         uuid primary key default gen_random_uuid(),
  seq        bigint generated always as identity,   -- the order notes were added, even within one instant
  ticket_id  uuid not null references support_tickets(id),
  tenant_id  uuid not null references tenants(id),
  note       text not null check (char_length(note) between 1 and 1000 and note = btrim(note)),
  created_by uuid,
  created_at timestamptz not null default now()
);
create index support_ticket_notes_ticket on support_ticket_notes (ticket_id, seq);

alter table support_tickets enable row level security;
alter table support_ticket_notes enable row level security;
revoke all on support_tickets, support_ticket_notes from public, anon, authenticated;
revoke all on sequence platform_ticket_seq from public, anon, authenticated;
create trigger support_tickets_audit after insert or update or delete on support_tickets
  for each row execute function audit_config_row('platform_ticket', 'number,title,details,priority,status,resolved_at');
create trigger support_ticket_notes_audit after insert or update or delete on support_ticket_notes
  for each row execute function audit_config_row('platform_ticket_note', 'ticket_id,note');

create function platform_open_ticket(p_tenant uuid, p_title text, p_details text, p_priority text default 'normal') returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := platform_require('admin');
  v_title text := btrim(coalesce(p_title, ''));
  v_details text := nullif(btrim(coalesce(p_details, '')), '');
  v_priority text := lower(btrim(coalesce(p_priority, 'normal')));
  v_id uuid; v_number text;
begin
  perform 1 from tenants where id = p_tenant;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if char_length(v_title) not between 3 and 120 then raise exception 'POLICY_VIOLATION: ticket title' using errcode = 'P0001'; end if;
  if v_details is not null and char_length(v_details) > 2000 then raise exception 'POLICY_VIOLATION: ticket details' using errcode = 'P0001'; end if;
  if v_priority not in ('normal', 'high') then raise exception 'POLICY_VIOLATION: ticket priority' using errcode = 'P0001'; end if;
  v_number := 'TK-' || lpad(nextval('platform_ticket_seq')::text, 6, '0');
  insert into support_tickets (tenant_id, number, title, details, priority, created_by) values (p_tenant, v_number, v_title, v_details, v_priority, v_uid)
    returning id into v_id;
  return jsonb_build_object('id', v_id, 'number', v_number);
end $$;

create function platform_add_ticket_note(p_ticket uuid, p_note text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_uid uuid := platform_require('admin'); t support_tickets%rowtype; v_note text := btrim(coalesce(p_note, ''));
begin
  select * into t from support_tickets where id = p_ticket for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if char_length(v_note) not between 1 and 1000 then raise exception 'POLICY_VIOLATION: ticket note' using errcode = 'P0001'; end if;
  insert into support_ticket_notes (ticket_id, tenant_id, note, created_by) values (t.id, t.tenant_id, v_note, v_uid);
  update support_tickets set updated_at = now() where id = t.id;
  return jsonb_build_object('added', true);
end $$;

create function platform_set_ticket_status(p_ticket uuid, p_status text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_uid uuid := platform_require('admin'); t support_tickets%rowtype; v_status text := lower(btrim(coalesce(p_status, '')));
begin
  select * into t from support_tickets where id = p_ticket for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if v_status not in ('open', 'in_progress', 'resolved', 'closed') then raise exception 'POLICY_VIOLATION: ticket status' using errcode = 'P0001'; end if;
  if t.status = v_status then return jsonb_build_object('changed', false, 'status', t.status); end if;
  update support_tickets set status = v_status,
    resolved_at = case when v_status in ('resolved', 'closed') then coalesce(t.resolved_at, now()) else null end
   where id = t.id;
  return jsonb_build_object('changed', true, 'status', v_status);
end $$;

create function platform_list_tickets(p_tenant uuid default null, p_status text default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_status text := nullif(lower(btrim(coalesce(p_status, ''))), '');
begin
  perform platform_require('support');
  if v_status is not null and v_status not in ('open', 'in_progress', 'resolved', 'closed') then raise exception 'POLICY_VIOLATION: ticket status' using errcode = 'P0001'; end if;
  return coalesce((
    select jsonb_agg(x.j order by x.created_at desc, x.number desc) from (
      select k.created_at, k.number, jsonb_build_object(
        'id', k.id, 'number', k.number, 'tenant_id', k.tenant_id, 'tenant_name', t.name, 'title', k.title, 'priority', k.priority,
        'status', k.status, 'created_at', k.created_at, 'updated_at', k.updated_at,
        'notes', (select count(*) from support_ticket_notes n where n.ticket_id = k.id)) as j
      from support_tickets k join tenants t on t.id = k.tenant_id
      where (p_tenant is null or k.tenant_id = p_tenant) and (v_status is null or k.status = v_status)
      order by k.created_at desc, k.number desc limit 200) x), '[]'::jsonb);
end $$;

create function platform_ticket_detail(p_ticket uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare k support_tickets%rowtype; v_tenant text;
begin
  perform platform_require('support');
  select * into k from support_tickets where id = p_ticket;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  select name into v_tenant from tenants where id = k.tenant_id;
  return jsonb_build_object(
    'id', k.id, 'number', k.number, 'tenant_id', k.tenant_id, 'tenant_name', v_tenant, 'title', k.title, 'details', k.details,
    'priority', k.priority, 'status', k.status, 'resolved_at', k.resolved_at, 'created_at', k.created_at, 'updated_at', k.updated_at,
    'notes', coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'note', n.note, 'created_at', n.created_at,
                         'author', (select u.email from auth.users u where u.id = n.created_by)) order by n.seq)
                        from support_ticket_notes n where n.ticket_id = k.id), '[]'::jsonb));
end $$;

revoke all on function platform_open_ticket(uuid, text, text, text), platform_add_ticket_note(uuid, text),
  platform_set_ticket_status(uuid, text), platform_list_tickets(uuid, text), platform_ticket_detail(uuid) from public, anon;
grant execute on function platform_open_ticket(uuid, text, text, text), platform_add_ticket_note(uuid, text),
  platform_set_ticket_status(uuid, text), platform_list_tickets(uuid, text), platform_ticket_detail(uuid) to authenticated;
