-- Waitlist (migration 124). Hotel A: tenant a1, property a2, Solo Suite a4 (one room), Standard a3 (several). Owner aa01, front desk aa04,
-- other hotel's owner bb01. Host book.hotel-a.test.
\set ON_ERROR_STOP on

-- the only Solo Suite is blocked for a week, 300 days ahead
insert into room_inventory_claims (tenant_id, property_id, room_id, claim_type, start_date, end_date, block_reason)
select tenant_id, property_id, id, 'block', current_date + 300, current_date + 307, 'repairs'
  from rooms where room_type_id = '00000000-0000-0000-0000-0000000000a4';

create function t124_join(p_email text, p_off integer default 301, p_type uuid default '00000000-0000-0000-0000-0000000000a4', p_name text default 'Wait Guest', p_phone text default '0800')
returns jsonb language sql as $$
  select guest_join_waitlist('book.hotel-a.test', p_type, current_date + p_off, current_date + p_off + 2, 2, 0, p_name, p_email, p_phone);
$$;

-- 1. a sold out type can be joined; email is lowercased; a repeat is a no-op
do $$ declare r jsonb; r2 jsonb; begin
  perform t_sys();
  r := t124_join(' Wait1@Example.com ');
  if (r ->> 'created')::boolean is not true then raise exception 'FAIL not created %', r; end if;
  if (select email from waitlist_requests where id = (r ->> 'waitlist_id')::uuid) <> 'wait1@example.com' then raise exception 'FAIL email not normalised'; end if;
  r2 := t124_join('wait1@example.com');
  if (r2 ->> 'created')::boolean is not false or r2 ->> 'waitlist_id' <> r ->> 'waitlist_id' then raise exception 'FAIL repeat %', r2; end if;
  raise notice 'PASS waitlist: sold out type joined, email normalised, repeat is a no-op';
end $$;

-- 2. refused: rooms free, bad input, unknown type, over capacity, too many requests
do $$ begin
  perform t_sys();
  perform t_expect('select t124_join(''free@example.com'', 301, ''00000000-0000-0000-0000-0000000000a3'')', 'POLICY_VIOLATION: waitlist rooms free');
  perform t_expect('select t124_join(''bad-email'')', 'POLICY_VIOLATION: waitlist email');
  perform t_expect('select t124_join(''ok@example.com'', 301, ''00000000-0000-0000-0000-0000000000a4'', ''A'')', 'POLICY_VIOLATION: waitlist name');
  perform t_expect('select t124_join(''ok@example.com'', 301, ''00000000-0000-0000-0000-0000000000a4'', ''Ok Guest'', repeat(''9'', 33))', 'POLICY_VIOLATION: waitlist phone');
  perform t_expect('select t124_join(''ok@example.com'', -1)', 'POLICY_VIOLATION: waitlist dates');
  perform t_expect('select t124_join(''ok@example.com'', 400)', 'POLICY_VIOLATION: waitlist dates');
  perform t_expect('select t124_join(''ok@example.com'', 301, gen_random_uuid())', 'NOT_FOUND');
  perform t_expect('select guest_join_waitlist(''book.hotel-a.test'', ''00000000-0000-0000-0000-0000000000a4'', current_date + 301, current_date + 303, 3, 0, ''Big Party'', ''ok@example.com'', null)', 'POLICY_VIOLATION: waitlist party');
  perform t124_join('many@example.com', 301); perform t124_join('many@example.com', 302); perform t124_join('many@example.com', 303);
  perform t_expect('select t124_join(''many@example.com'', 304)', 'POLICY_VIOLATION: waitlist too many requests');
  raise notice 'PASS waitlist: refusals for free rooms, bad name, email, phone, dates, type, party and more than 3 requests';
end $$;

-- 3. only the service joins; staff and the public cannot
do $$ begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  begin perform t124_join('staff@example.com'); raise exception 'FAIL staff joined';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS waitlist: joining is for the service only';
end $$;

-- 4. staff list: permission, rooms_free_now follows the claims, closed and other hotels hidden
do $$ declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; l jsonb; v_id uuid; begin
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select waitlist_list(%L)', v_p), 'NOT_FOUND');
  if (select count(*) from waitlist_requests) <> 0 then raise exception 'FAIL other hotel sees rows'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  l := waitlist_list(v_p);
  if jsonb_array_length(l) <> 4 then raise exception 'FAIL list size %', l; end if;
  if exists (select 1 from jsonb_array_elements(l) e where (e ->> 'rooms_free_now')::int <> 0 and (e ->> 'arrival_date')::date < current_date + 307) then
    raise exception 'FAIL room reported free while blocked'; end if;
  perform t_sys();
  delete from room_inventory_claims where claim_type = 'block' and block_reason = 'repairs' and start_date = current_date + 300;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  if not exists (select 1 from jsonb_array_elements(waitlist_list(v_p)) e where (e ->> 'rooms_free_now')::int > 0) then raise exception 'FAIL freed room not shown'; end if;
  raise notice 'PASS waitlist: list needs permission, shows the free-now count, hides other hotels';
end $$;

-- 5. status changes: reservation.modify, audited, closed leaves the list, invalid refused
do $$ declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_id uuid; r jsonb; begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  select id into v_id from waitlist_requests where email = 'wait1@example.com';
  r := waitlist_set_status(v_id, 'contacted');
  if (r ->> 'changed')::boolean is not true then raise exception 'FAIL not changed'; end if;
  if (waitlist_set_status(v_id, 'contacted') ->> 'changed')::boolean then raise exception 'FAIL repeat changed'; end if;
  perform t_expect(format('select waitlist_set_status(%L, ''gone'')', v_id), 'POLICY_VIOLATION: status');
  perform waitlist_set_status(v_id, 'closed');
  if exists (select 1 from jsonb_array_elements(waitlist_list(v_p)) e where e ->> 'id' = v_id::text) then raise exception 'FAIL closed still listed'; end if;
  perform t_sys();
  if (select count(*) from audit_logs where action = 'waitlist.status' and entity_id = v_id) <> 2 then raise exception 'FAIL audit'; end if;
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select waitlist_set_status(%L, ''waiting'')', v_id), 'NOT_FOUND');
  perform t_expect('select waitlist_set_status(gen_random_uuid(), ''waiting'')', 'NOT_FOUND');
  raise notice 'PASS waitlist: status changes audited, closed leaves the list, other hotel refused';
end $$;

-- 6. old requests are purged
do $$ declare r jsonb; begin
  perform t_sys();
  insert into waitlist_requests (tenant_id, property_id, room_type_id, arrival_date, departure_date, adults, guest_name, email)
  values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a4',
          current_date - 60, current_date - 58, 1, 'Old Guest', 'old@example.com');
  r := purge_old_operational_data();
  if (r ->> 'waitlist')::int <> 1 then raise exception 'FAIL purge %', r; end if;
  raise notice 'PASS waitlist: requests past 30 days after departure are purged';
end $$;
