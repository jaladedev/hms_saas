-- Contact messages (migration 137). Hotel A: tenant a1, property a2. Owner aa01, front desk aa04, other hotel's owner bb01. Host book.hotel-a.test.
\set ON_ERROR_STOP on

create function t137_send(p_email text, p_msg text default 'Do you have parking for two cars?', p_name text default 'Ada Guest')
returns jsonb language sql as $$ select guest_send_message('book.hotel-a.test', p_name, p_email, p_msg); $$;

-- 1. a message is stored, the email lowercased, an identical repeat is a no-op
do $$ declare r jsonb; r2 jsonb; begin
  perform t_sys();
  delete from contact_messages;
  r := t137_send(' Ada@Example.com ');
  if (r ->> 'created')::boolean is not true then raise exception 'FAIL not created %', r; end if;
  if (select email from contact_messages where id = (r ->> 'message_id')::uuid) <> 'ada@example.com' then raise exception 'FAIL email not normalised'; end if;
  r2 := t137_send('ada@example.com');
  if (r2 ->> 'created')::boolean is not false or r2 ->> 'message_id' <> r ->> 'message_id' then raise exception 'FAIL repeat %', r2; end if;
  raise notice 'PASS contact: message stored, email normalised, repeat is a no-op';
end $$;

-- 2. refusals: name, email, message length, and more than 5 a day from one email
do $$ begin
  perform t_sys();
  perform t_expect('select t137_send(''ok@example.com'', ''Hello there'', ''A'')', 'POLICY_VIOLATION: contact name');
  perform t_expect('select t137_send(''not-an-email'')', 'POLICY_VIOLATION: contact email');
  perform t_expect('select t137_send(''ok@example.com'', ''Hi'')', 'POLICY_VIOLATION: contact message');
  perform t_expect('select t137_send(''ok@example.com'', repeat(''x'', 2001))', 'POLICY_VIOLATION: contact message');
  perform t137_send('many@example.com', 'message number 1'); perform t137_send('many@example.com', 'message number 2');
  perform t137_send('many@example.com', 'message number 3'); perform t137_send('many@example.com', 'message number 4');
  perform t137_send('many@example.com', 'message number 5');
  perform t_expect('select t137_send(''many@example.com'', ''message number 6'')', 'POLICY_VIOLATION: contact too many');
  raise notice 'PASS contact: refusals for name, email, message length and more than 5 a day';
end $$;

-- 3. only the service sends
do $$ begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  begin perform t137_send('staff@example.com'); raise exception 'FAIL staff sent';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS contact: sending is for the service only';
end $$;

-- 4. staff list needs permission and hides other hotels' staff
do $$ declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; l jsonb; begin
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select contact_messages_list(%L)', v_p), 'NOT_FOUND');
  if (select count(*) from contact_messages) <> 0 then raise exception 'FAIL other hotel sees rows'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  l := contact_messages_list(v_p);
  if jsonb_array_length(l) <> 6 then raise exception 'FAIL list size %', l; end if;
  raise notice 'PASS contact: list needs permission and hides other hotels';
end $$;

-- 5. status: reservation.modify, audited, handled sorts after new, invalid and unknown refused
do $$ declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_id uuid; r jsonb; l jsonb; begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  select id into v_id from contact_messages where email = 'ada@example.com';
  r := contact_message_set_status(v_id, 'handled');
  if (r ->> 'changed')::boolean is not true then raise exception 'FAIL not changed %', r; end if;
  if (contact_message_set_status(v_id, 'handled') ->> 'changed')::boolean is not false then raise exception 'FAIL repeat changed'; end if;
  l := contact_messages_list(v_p);
  if l -> (jsonb_array_length(l) - 1) ->> 'status' <> 'handled' then raise exception 'FAIL handled not last %', l; end if;
  perform t_expect(format('select contact_message_set_status(%L, ''done'')', v_id), 'POLICY_VIOLATION: status');
  perform t_expect('select contact_message_set_status(gen_random_uuid(), ''handled'')', 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select contact_message_set_status(%L, ''new'')', v_id), 'NOT_FOUND');
  perform t_sys();
  if not exists (select 1 from audit_logs where action = 'contact.status' and entity_id = v_id) then raise exception 'FAIL not audited'; end if;
  raise notice 'PASS contact: status change is permission-checked, audited, sorted';
end $$;

-- 6. purge removes messages older than 90 days
do $$ declare v_id uuid; r jsonb; begin
  perform t_sys();
  select id into v_id from contact_messages where email = 'ada@example.com';
  update contact_messages set created_at = now() - interval '91 days' where id = v_id;
  r := purge_old_operational_data();
  if (r ->> 'contact_messages')::int <> 1 or exists (select 1 from contact_messages where id = v_id) then raise exception 'FAIL purge %', r; end if;
  delete from contact_messages;
  raise notice 'PASS contact: old messages purged';
end $$;
