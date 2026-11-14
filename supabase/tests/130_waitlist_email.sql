-- Waitlist email (migration 130). Hotel A: tenant a1, property a2, a test room type (one room). Owner aa01, front desk aa04, other hotel's owner bb01.
\set ON_ERROR_STOP on

-- a room type of its own with one room, blocked for two weeks, so no other test's bookings are in the way
insert into room_types (id, tenant_id, property_id, name, code, slug, max_adults, max_occupancy, base_rate_minor) values
  ('00000000-0000-0000-0000-000000000130', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', 'Test Loft', 'LOFT130', 'test-loft-130', 2, 2, 5000000);
insert into rooms (tenant_id, property_id, room_type_id, room_number, floor) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000130', '130', 3);
insert into room_inventory_claims (tenant_id, property_id, room_id, claim_type, start_date, end_date, block_reason)
select tenant_id, property_id, id, 'block', current_date + 60, current_date + 75, 'works'
  from rooms where room_type_id = '00000000-0000-0000-0000-000000000130';

create function t130_join(p_email text, p_off integer default 61) returns uuid language sql as $$
  select (guest_join_waitlist('book.hotel-a.test', '00000000-0000-0000-0000-000000000130', current_date + p_off, current_date + p_off + 2, 2, 0, 'Notice Guest', p_email, null) ->> 'waitlist_id')::uuid;
$$;

-- 1. only property.configure sets it; off by default; audited; anon refused
do $$ declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_state text; begin
  perform t_sys();
  if (select waitlist_email_enabled from properties where id = v_p) then raise exception 'FAIL should start off'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select set_waitlist_email(%L, true)', v_p), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select set_waitlist_email(%L, true)', v_p), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform set_waitlist_email(v_p, true);
  perform t_sys();
  if not (select waitlist_email_enabled from properties where id = v_p) then raise exception 'FAIL not saved'; end if;
  if not exists (select 1 from audit_logs where entity_id = v_p and action = 'property.updated' and metadata -> 'changed' ? 'waitlist_email_enabled') then raise exception 'FAIL not audited'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform set_waitlist_email(v_p, null);
  perform t_sys();
  if (select waitlist_email_enabled from properties where id = v_p) then raise exception 'FAIL null did not turn it off'; end if;
  begin
    set local role anon;
    perform set_waitlist_email(v_p, true);
    v_state := 'allowed';
  exception when insufficient_privilege then v_state := 'refused';
  end;
  reset role;
  if v_state <> 'refused' then raise exception 'FAIL anon could call set_waitlist_email'; end if;
  raise notice 'PASS waitlist email: set by property.configure only, off by default, audited, anon refused';
end $$;

-- 2. nothing while sold out, off, contacted or without a verified domain; one email once a room frees up
do $$ declare
  v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; a uuid; b uuid; n integer; pl jsonb;
begin
  perform t_sys();
  delete from waitlist_requests;   -- requests left by the 124 test would be queued too
  a := t130_join('wl-a@example.test', 61);
  b := t130_join('wl-b@example.test', 63);
  update waitlist_requests set status = 'contacted' where id = b;
  perform set_config('t130.dummy', '1', true);
  update properties set waitlist_email_enabled = true where id = v_p;
  if queue_waitlist_notices() <> 0 then raise exception 'FAIL queued while sold out'; end if;

  delete from room_inventory_claims where claim_type = 'block' and block_reason = 'works' and start_date = current_date + 60;
  update properties set waitlist_email_enabled = false where id = v_p;
  if queue_waitlist_notices() <> 0 then raise exception 'FAIL queued while the setting is off'; end if;
  update properties set waitlist_email_enabled = true where id = v_p;

  update tenant_domains set verified_at = null where tenant_id = '00000000-0000-0000-0000-0000000000a1';
  if queue_waitlist_notices() <> 0 then raise exception 'FAIL queued with no verified domain'; end if;
  if (select notified_at from waitlist_requests where id = a) is not null then raise exception 'FAIL marked notified without sending'; end if;
  update tenant_domains set verified_at = now() where tenant_id = '00000000-0000-0000-0000-0000000000a1';

  n := queue_waitlist_notices();
  if n <> 1 then raise exception 'FAIL expected 1 queued, got %', n; end if;
  select payload into pl from waitlist_notice_outbox where waitlist_id = a;
  if pl is null or pl ->> 'site_host' is null or pl ->> 'room_type' <> 'Test Loft' then raise exception 'FAIL payload %', pl; end if;
  if exists (select 1 from waitlist_notice_outbox where waitlist_id = b) then raise exception 'FAIL a contacted request was queued'; end if;
  if (select notified_at from waitlist_requests where id = a) is null then raise exception 'FAIL not marked notified'; end if;
  if (select status from waitlist_requests where id = a) <> 'waiting' then raise exception 'FAIL status changed'; end if;
  if queue_waitlist_notices() <> 0 then raise exception 'FAIL a repeat queued again'; end if;

  perform t_as('00000000-0000-0000-0000-00000000aa04');
  if not exists (select 1 from jsonb_array_elements(waitlist_list(v_p)) e where e ->> 'id' = a::text and e ->> 'notified_at' is not null) then raise exception 'FAIL list lacks notified_at'; end if;
  raise notice 'PASS waitlist email: only when a room is free, enabled, still waiting and the site has a domain; once per request';
end $$;

-- 3. claim and result like the other outboxes
do $$ declare c jsonb; v_id uuid; begin
  perform t_sys();
  c := claim_waitlist_notices(10);
  if jsonb_array_length(c) <> 1 or c -> 0 ->> 'to_email' <> 'wl-a@example.test' then raise exception 'FAIL claim %', c; end if;
  v_id := (c -> 0 ->> 'id')::uuid;
  if jsonb_array_length(claim_waitlist_notices(10)) <> 0 then raise exception 'FAIL claimed twice'; end if;
  perform mark_waitlist_notice_result(v_id, false, 'mail down');
  if (select status || attempts from waitlist_notice_outbox where id = v_id) <> 'pending1' then raise exception 'FAIL not pending'; end if;
  update waitlist_notice_outbox set next_attempt_at = now() where id = v_id;
  perform claim_waitlist_notices(10);
  perform mark_waitlist_notice_result(v_id, true);
  if (select status from waitlist_notice_outbox where id = v_id) <> 'sent' then raise exception 'FAIL not sent'; end if;
  update waitlist_notice_outbox set status = 'sending', attempts = 5 where id = v_id;
  perform mark_waitlist_notice_result(v_id, false, 'x');
  if (select status from waitlist_notice_outbox where id = v_id) <> 'failed' then raise exception 'FAIL fifth failure should stick'; end if;
  delete from waitlist_requests where id = (select waitlist_id from waitlist_notice_outbox where id = v_id);
  if exists (select 1 from waitlist_notice_outbox where id = v_id) then raise exception 'FAIL outbox row outlived its request'; end if;
  raise notice 'PASS waitlist email: exclusive claims, backoff, fifth failure sticks, rows go with their request';
end $$;

-- 4. worker functions are for the system only
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000aa01';
do $$ begin
  begin perform queue_waitlist_notices(); raise exception 'FAIL authenticated queue';
  exception when insufficient_privilege then null; end;
  begin perform claim_waitlist_notices(1); raise exception 'FAIL authenticated claim';
  exception when insufficient_privilege then null; end;
  begin perform mark_waitlist_notice_result(gen_random_uuid(), true); raise exception 'FAIL authenticated mark';
  exception when insufficient_privilege then null; end;
end $$;
rollback;
do $$ begin raise notice 'PASS waitlist email: worker functions closed to authenticated callers'; end $$;

do $$ begin
  perform t_sys();
  update properties set waitlist_email_enabled = false where id = '00000000-0000-0000-0000-0000000000a2';
  delete from waitlist_requests where email in ('wl-a@example.test', 'wl-b@example.test');
end $$;
do $$ begin
  perform t_sys();
  delete from room_inventory_claims where room_id in (select id from rooms where room_type_id = '00000000-0000-0000-0000-000000000130');
  delete from rooms where room_type_id = '00000000-0000-0000-0000-000000000130';
  delete from room_types where id = '00000000-0000-0000-0000-000000000130';
end $$;
drop function t130_join(text, integer);
