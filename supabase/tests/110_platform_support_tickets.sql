-- Support tickets (migration 110). Platform people from 51: f050 admin, f051 support, f052 hotel owner; group 't50-hotel'.
\set ON_ERROR_STOP on

-- 1. an admin opens, notes and moves a ticket; the numbers, times and audit follow
do $$ declare v_t uuid := (select id from tenants where slug = 't50-hotel'); r jsonb; v_id uuid; d jsonb; v_when timestamptz;
begin
  perform t_sys();
  delete from support_ticket_notes where tenant_id = v_t;
  delete from support_tickets where tenant_id = v_t;
  perform t_as('00000000-0000-0000-0000-00000000f050');
  r := platform_open_ticket(v_t, '  Paystack webhook failing  ', ' Callbacks return 500 since Monday. ', 'high');
  v_id := (r ->> 'id')::uuid;
  if r ->> 'number' !~ '^TK-[0-9]{6}$' then raise exception 'FAIL number %', r; end if;
  d := platform_ticket_detail(v_id);
  if d ->> 'title' <> 'Paystack webhook failing' or d ->> 'details' <> 'Callbacks return 500 since Monday.' or d ->> 'status' <> 'open' or d ->> 'priority' <> 'high' then raise exception 'FAIL stored values %', d; end if;
  if d ->> 'tenant_name' is null or jsonb_array_length(d -> 'notes') <> 0 then raise exception 'FAIL detail shape %', d; end if;

  perform platform_add_ticket_note(v_id, '  Asked the hotel for the webhook log.  ');
  perform platform_add_ticket_note(v_id, 'Fixed the endpoint URL.');
  d := platform_ticket_detail(v_id);
  if d -> 'notes' -> 0 ->> 'note' <> 'Asked the hotel for the webhook log.' or d -> 'notes' -> 1 ->> 'note' <> 'Fixed the endpoint URL.' then raise exception 'FAIL notes order or trim %', d -> 'notes'; end if;
  if d -> 'notes' -> 0 ->> 'author' is null and exists (select 1 from auth.users where id = '00000000-0000-0000-0000-00000000f050') then raise exception 'FAIL note author missing'; end if;

  -- status: resolving records when; the same status again changes nothing; reopening clears it
  if (platform_set_ticket_status(v_id, 'in_progress') ->> 'changed')::boolean is not true then raise exception 'FAIL in_progress'; end if;
  perform platform_set_ticket_status(v_id, 'resolved');
  perform t_sys();
  v_when := (select resolved_at from support_tickets where id = v_id);
  if v_when is null then raise exception 'FAIL resolved_at not set'; end if;
  perform t_as('00000000-0000-0000-0000-00000000f050');
  if (platform_set_ticket_status(v_id, 'resolved') ->> 'changed')::boolean is not false then raise exception 'FAIL same status reported a change'; end if;
  perform platform_set_ticket_status(v_id, 'closed');
  perform t_sys();
  if (select resolved_at from support_tickets where id = v_id) <> v_when then raise exception 'FAIL resolved_at moved on close'; end if;
  perform t_as('00000000-0000-0000-0000-00000000f050');
  perform platform_set_ticket_status(v_id, 'open');
  perform t_sys();
  if (select resolved_at from support_tickets where id = v_id) is not null then raise exception 'FAIL reopen did not clear resolved_at'; end if;

  if not exists (select 1 from audit_logs where entity_id = v_id and action = 'platform_ticket.created') then raise exception 'FAIL ticket creation not audited'; end if;
  if not exists (select 1 from audit_logs where entity_id = v_id and action = 'platform_ticket.updated' and metadata -> 'changed' ? 'status') then raise exception 'FAIL status change not audited'; end if;
  if (select count(*) from audit_logs where entity_type = 'platform_ticket_note' and tenant_id = v_t and action = 'platform_ticket_note.created') <> 2 then raise exception 'FAIL notes not audited'; end if;
  raise notice 'PASS support tickets: open, note, status, resolved_at and audit';
end $$;

-- 2. bad input changes nothing
do $$ declare v_t uuid := (select id from tenants where slug = 't50-hotel'); v_id uuid := (select id from support_tickets where tenant_id = v_t limit 1); v_before int;
begin
  perform t_sys();
  v_before := (select count(*) from support_tickets);
  perform t_as('00000000-0000-0000-0000-00000000f050');
  perform t_expect(format($q$select platform_open_ticket(%L, 'ab', null)$q$, v_t), 'POLICY_VIOLATION: ticket title');
  perform t_expect(format($q$select platform_open_ticket(%L, %L, null)$q$, v_t, repeat('x', 121)), 'POLICY_VIOLATION: ticket title');
  perform t_expect(format($q$select platform_open_ticket(%L, 'Fine title', %L)$q$, v_t, repeat('x', 2001)), 'POLICY_VIOLATION: ticket details');
  perform t_expect(format($q$select platform_open_ticket(%L, 'Fine title', null, 'urgent')$q$, v_t), 'POLICY_VIOLATION: ticket priority');
  perform t_expect($q$select platform_open_ticket(gen_random_uuid(), 'Fine title', null)$q$, 'NOT_FOUND');
  perform t_expect(format($q$select platform_add_ticket_note(%L, '   ')$q$, v_id), 'POLICY_VIOLATION: ticket note');
  perform t_expect(format($q$select platform_add_ticket_note(%L, %L)$q$, v_id, repeat('n', 1001)), 'POLICY_VIOLATION: ticket note');
  perform t_expect(format($q$select platform_set_ticket_status(%L, 'done')$q$, v_id), 'POLICY_VIOLATION: ticket status');
  perform t_expect($q$select platform_add_ticket_note(gen_random_uuid(), 'x')$q$, 'NOT_FOUND');
  perform t_expect($q$select platform_ticket_detail(gen_random_uuid())$q$, 'NOT_FOUND');
  perform t_expect($q$select platform_list_tickets(null, 'bogus')$q$, 'POLICY_VIOLATION: ticket status');
  perform t_sys();
  if (select count(*) from support_tickets) <> v_before then raise exception 'FAIL a refused call stored a ticket'; end if;
  raise notice 'PASS support tickets: bad titles, details, priorities, notes and statuses refused';
end $$;

-- 3. list filters; support reads but writes nothing; an owner and anon get nothing
do $$ declare v_t uuid := (select id from tenants where slug = 't50-hotel'); v_id uuid := (select id from support_tickets where tenant_id = v_t limit 1); r jsonb; v_state text; v_second uuid;
begin
  perform t_as('00000000-0000-0000-0000-00000000f050');
  v_second := (platform_open_ticket(v_t, 'Second ticket', null) ->> 'id')::uuid;
  perform platform_set_ticket_status(v_second, 'closed');
  perform t_as('00000000-0000-0000-0000-00000000f051');
  r := platform_list_tickets(v_t, null);
  if jsonb_array_length(r) <> 2 then raise exception 'FAIL list for the hotel: %', jsonb_array_length(r); end if;
  if r -> 0 ->> 'title' <> 'Second ticket' then raise exception 'FAIL newest first: %', r -> 0 ->> 'title'; end if;
  if (r -> 1 ->> 'notes')::int <> 2 then raise exception 'FAIL note count %', r -> 1; end if;
  if jsonb_array_length(platform_list_tickets(v_t, 'closed')) <> 1 or jsonb_array_length(platform_list_tickets(v_t, 'open')) <> 1 then raise exception 'FAIL status filter'; end if;
  if jsonb_array_length(platform_list_tickets(gen_random_uuid(), null)) <> 0 then raise exception 'FAIL filter by another hotel'; end if;
  if r::text ~* '(secret|reference)' then raise exception 'FAIL list mentions a secret'; end if;
  perform platform_ticket_detail(v_id);
  perform t_expect(format($q$select platform_open_ticket(%L, 'Support cannot', null)$q$, v_t), 'NOT_FOUND');
  perform t_expect(format($q$select platform_add_ticket_note(%L, 'Support cannot')$q$, v_id), 'NOT_FOUND');
  perform t_expect(format($q$select platform_set_ticket_status(%L, 'closed')$q$, v_id), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000f052');
  perform t_expect(format($q$select platform_list_tickets(%L, null)$q$, v_t), 'NOT_FOUND');
  perform t_expect(format($q$select platform_ticket_detail(%L)$q$, v_id), 'NOT_FOUND');
  perform t_expect(format($q$select platform_open_ticket(%L, 'Owner cannot', null)$q$, v_t), 'NOT_FOUND');
  perform t_sys();
  begin
    set local role anon;
    perform platform_list_tickets(null, null);
    v_state := 'allowed';
  exception when insufficient_privilege then v_state := 'refused';
  end;
  reset role;
  if v_state <> 'refused' then raise exception 'FAIL anon could list tickets'; end if;
  -- the tables are closed to logins
  perform t_as('00000000-0000-0000-0000-00000000f050');
  begin perform count(*) from support_tickets; raise exception 'FAIL an admin login read the table directly';
  exception when insufficient_privilege then null; end;
  perform t_sys();
  raise notice 'PASS support tickets: list filters; support reads only; owner, anon and direct table access refused';
end $$;
