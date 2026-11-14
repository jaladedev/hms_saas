-- Platform audit log (migration 126). Platform people from 51: f050 admin, f051 support, f052 hotel owner; group 't50-hotel'.
\set ON_ERROR_STOP on

-- 1. platform actions show up, with the right shape; ticket text never does
do $$ declare v_t uuid := (select id from tenants where slug = 't50-hotel'); r jsonb; v_id uuid; e jsonb;
begin
  perform t_sys();
  perform t_as('00000000-0000-0000-0000-00000000f050');
  v_id := (platform_open_ticket(v_t, 'Audit probe ticket', 'SECRET-DETAIL-TEXT', 'normal') ->> 'id')::uuid;
  perform platform_set_ticket_status(v_id, 'in_progress');
  r := platform_audit_events(v_t, 'platform_ticket', null, null, null, null, 50);
  if jsonb_array_length(r -> 'events') < 2 then raise exception 'FAIL expected the ticket events %', r; end if;
  e := (select x from jsonb_array_elements(r -> 'events') x where x ->> 'entity_id' = v_id::text and x ->> 'action' = 'platform_ticket.updated' limit 1);
  if e is null or e ->> 'tenant_name' is null or e -> 'fields' <> '["status"]'::jsonb then raise exception 'FAIL updated event shape %', e; end if;
  if r::text like '%SECRET-DETAIL-TEXT%' or r::text like '%Audit probe ticket%' then raise exception 'FAIL ticket text leaked into the audit read'; end if;
  if (select (x ->> 'at')::timestamptz from jsonb_array_elements(r -> 'events') x limit 1) < (select (x ->> 'at')::timestamptz from jsonb_array_elements(r -> 'events') x offset 1 limit 1) then raise exception 'FAIL not newest first'; end if;
  raise notice 'PASS platform audit: platform events listed with their changed field names, newest first, no ticket text';
end $$;

-- 2. a hotel's own staff work is not a platform event
do $$ declare v_t uuid := (select id from tenants where slug = 't50-hotel'); r jsonb;
begin
  perform t_sys();
  insert into audit_logs (tenant_id, actor_user_id, action, entity_type, metadata)
    values (v_t, '00000000-0000-0000-0000-00000000f052', 'room.blocked', 'room', '{}');
  perform t_as('00000000-0000-0000-0000-00000000f051');
  r := platform_audit_events(v_t, 'room.', null, null, null, null, 50);
  if jsonb_array_length(r -> 'events') <> 0 then raise exception 'FAIL a hotel action was listed %', r; end if;
  raise notice 'PASS platform audit: a hotel''s own room action is not listed';
end $$;

-- 3. filters and paging: wildcards are plain text, dates, one hotel, pages of 1 walk everything once
do $$ declare v_t uuid := (select id from tenants where slug = 't50-hotel'); r jsonb; v_all integer; v_seen integer := 0; v_at timestamptz; v_id uuid; v_pages integer := 0;
begin
  perform t_as('00000000-0000-0000-0000-00000000f051');
  if jsonb_array_length((platform_audit_events(v_t, '%', null, null, null, null, 50)) -> 'events') <> 0 then raise exception 'FAIL percent acted as a wildcard'; end if;
  if jsonb_array_length((platform_audit_events(v_t, 'platform_t_cket', null, null, null, null, 50)) -> 'events') <> 0 then raise exception 'FAIL underscore acted as a wildcard'; end if;
  if jsonb_array_length((platform_audit_events(gen_random_uuid(), null, null, null, null, null, 50)) -> 'events') <> 0 then raise exception 'FAIL another group listed'; end if;
  if jsonb_array_length((platform_audit_events(v_t, null, current_date + 1, null, null, null, 50)) -> 'events') <> 0 then raise exception 'FAIL from-date ignored'; end if;
  if jsonb_array_length((platform_audit_events(v_t, null, null, current_date - 1, null, null, 50)) -> 'events') <> 0 then raise exception 'FAIL to-date ignored'; end if;
  v_all := jsonb_array_length((platform_audit_events(v_t, 'platform_ticket', null, null, null, null, 100)) -> 'events');
  if v_all < 2 then raise exception 'FAIL expected events %', v_all; end if;
  loop
    r := platform_audit_events(v_t, 'platform_ticket', null, null, v_at, v_id, 1);
    exit when jsonb_array_length(r -> 'events') = 0;
    v_seen := v_seen + 1; v_pages := v_pages + 1;
    v_at := (r -> 'events' -> 0 ->> 'at')::timestamptz; v_id := (r -> 'events' -> 0 ->> 'id')::uuid;
    if (r ->> 'has_more')::boolean is distinct from (v_seen < v_all) then raise exception 'FAIL has_more wrong at page %', v_pages; end if;
    exit when v_pages > v_all + 2;
  end loop;
  if v_seen <> v_all then raise exception 'FAIL paging saw % of %', v_seen, v_all; end if;
  if jsonb_array_length((platform_audit_events(v_t, null, null, null, null, null, 0)) -> 'events') <> 1 then raise exception 'FAIL limit 0 should be 1'; end if;
  raise notice 'PASS platform audit: wildcards are text, date and hotel filters work, pages of one walk every event once';
end $$;

-- 4. who may read it: support and admin; a hotel owner, a stranger and anon are NOT_FOUND / refused
do $$
begin
  perform t_as('00000000-0000-0000-0000-00000000f050');
  perform platform_audit_events(null, null, null, null, null, null, 5);
  perform t_as('00000000-0000-0000-0000-00000000f052');
  perform t_expect('select platform_audit_events(null, null, null, null, null, null, 5)', 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect('select platform_audit_events(null, null, null, null, null, null, 5)', 'NOT_FOUND');
  raise notice 'PASS platform audit: support and admin read; a hotel owner is refused';
end $$;
