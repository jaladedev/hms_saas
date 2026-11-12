-- Access requests (migration 111). Platform people from 51: f050 admin, f051 support, f052 ordinary hotel owner; group 't50-hotel'.
-- This test adds a second admin, f054.
\set ON_ERROR_STOP on

insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000f054', 'admin2@platform.test') on conflict do nothing;
insert into platform_admins (user_id, level) values ('00000000-0000-0000-0000-00000000f054', 'admin') on conflict do nothing;

-- 1. request: who, what is checked, one live request at a time
do $$ declare v_t uuid := (select id from tenants where slug = 't50-hotel'); v_other uuid; v_tk uuid; r jsonb; v_id uuid;
begin
  perform t_sys();
  delete from access_requests where tenant_id = v_t;
  delete from support_ticket_notes where tenant_id = v_t; delete from support_tickets where tenant_id = v_t;
  select id into v_other from tenants where id <> v_t limit 1;

  perform t_as('00000000-0000-0000-0000-00000000f052');   -- an ordinary hotel owner
  perform t_expect(format('select platform_request_access(%L, ''Looking into a payment problem'', 1)', v_t), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000f051');
  perform t_expect(format('select platform_request_access(%L, ''Looking into a payment problem'', 1)', gen_random_uuid()), 'NOT_FOUND');
  perform t_expect(format('select platform_request_access(%L, ''too short'', 1)', v_t), 'POLICY_VIOLATION: access reason');
  perform t_expect(format('select platform_request_access(%L, %L, 1)', v_t, repeat('x', 501)), 'POLICY_VIOLATION: access reason');
  perform t_expect(format('select platform_request_access(%L, ''Looking into a payment problem'', 2)', v_t), 'POLICY_VIOLATION: access hours');
  perform t_expect(format('select platform_request_access(%L, ''Looking into a payment problem'', 48)', v_t), 'POLICY_VIOLATION: access hours');
  perform t_expect(format('select platform_request_access(%L, ''Looking into a payment problem'', null)', v_t), 'POLICY_VIOLATION: access hours');
  perform t_expect(format('select platform_request_access(%L, ''Looking into a payment problem'', 1, %L)', v_t, gen_random_uuid()), 'POLICY_VIOLATION: access ticket');

  perform t_as('00000000-0000-0000-0000-00000000f050');
  v_tk := (platform_open_ticket(v_t, 'Paystack webhook failing', null, 'normal') ->> 'id')::uuid;
  perform t_as('00000000-0000-0000-0000-00000000f051');
  r := platform_request_access(v_t, '  Looking into a payment problem  ', 4, v_tk);
  v_id := (r ->> 'id')::uuid;
  perform t_sys();
  if (select reason from access_requests where id = v_id) <> 'Looking into a payment problem' then raise exception 'FAIL reason not trimmed'; end if;
  perform t_as('00000000-0000-0000-0000-00000000f051');
  perform t_expect(format('select platform_request_access(%L, ''Another reason entirely'', 1)', v_t), 'CONFLICT: access open');
  raise notice 'PASS access requests: who may ask, reason, hours and ticket checked, one live request each';
end $$;

-- 2. decision: another admin only; the clock starts on approval; the view is the requester's alone
do $$ declare
  v_t uuid := (select id from tenants where slug = 't50-hotel'); v_id uuid; v_own uuid; v text; l jsonb; sn jsonb; v_until timestamptz;
begin
  perform t_sys();
  select id into v_id from access_requests where tenant_id = v_t and status = 'pending';

  perform t_as('00000000-0000-0000-0000-00000000f051');   -- support cannot decide
  perform t_expect(format('select platform_decide_access(%L, ''approved'')', v_id), 'NOT_FOUND');
  perform t_expect(format('select platform_access_view(%L)', v_id), 'NOT_FOUND');   -- nothing to see before approval

  perform t_as('00000000-0000-0000-0000-00000000f050');
  perform t_expect(format('select platform_decide_access(%L, ''maybe'')', v_id), 'POLICY_VIOLATION: access decision');
  perform t_expect(format('select platform_decide_access(%L, null)', v_id), 'POLICY_VIOLATION: access decision');
  perform t_expect(format('select platform_decide_access(%L, ''approved'', %L)', v_id, repeat('x', 301)), 'POLICY_VIOLATION: access note');
  perform t_expect(format('select platform_decide_access(%L, ''approved'')', gen_random_uuid()), 'NOT_FOUND');
  -- an admin who asks may not decide their own request
  perform t_sys();
  insert into access_requests (tenant_id, requested_by, reason, hours) values (v_t, '00000000-0000-0000-0000-00000000f054', 'Checking the rate setup myself', 1)
    returning id into v_own;
  perform t_as('00000000-0000-0000-0000-00000000f054');
  perform t_expect(format('select platform_decide_access(%L, ''approved'')', v_own), 'POLICY_VIOLATION: access own request');
  perform t_sys();
  delete from access_requests where requested_by = '00000000-0000-0000-0000-00000000f054';

  perform t_as('00000000-0000-0000-0000-00000000f050');
  perform platform_decide_access(v_id, 'approved', '  OK, one look.  ');
  perform t_sys();
  select approved_until into v_until from access_requests where id = v_id;
  if v_until is null or v_until < now() + interval '3 hours 55 minutes' or v_until > now() + interval '4 hours 5 minutes' then raise exception 'FAIL clock % ', v_until; end if;
  if (select decision_note from access_requests where id = v_id) <> 'OK, one look.' then raise exception 'FAIL note'; end if;
  perform t_as('00000000-0000-0000-0000-00000000f050');
  perform t_expect(format('select platform_decide_access(%L, ''denied'')', v_id), 'CONFLICT: access state');   -- already decided

  -- only the requester sees the setup, and only while it is approved
  perform t_as('00000000-0000-0000-0000-00000000f050');
  perform t_expect(format('select platform_access_view(%L)', v_id), 'NOT_FOUND');   -- not even an admin
  perform t_as('00000000-0000-0000-0000-00000000f052');
  perform t_expect(format('select platform_access_view(%L)', v_id), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000f051');
  sn := platform_access_view(v_id);
  perform platform_access_view(v_id);
  perform t_sys();
  if (select views from access_requests where id = v_id) <> 2 or (select last_viewed_at from access_requests where id = v_id) is null then raise exception 'FAIL views not counted'; end if;
  if sn ->> 'tenant_name' is null or jsonb_typeof(sn -> 'properties') <> 'array' or jsonb_array_length(sn -> 'properties') < 1 then raise exception 'FAIL snapshot shape %', sn; end if;

  -- nothing personal or secret in it
  if (select string_agg(k, ',') from jsonb_object_keys(sn) k where k not in ('tenant_name','tenant_status','approved_until','features','domains','payment_accounts','roles','properties')) is not null then raise exception 'FAIL unexpected top-level key %', sn; end if;
  if sn::text ~* '(@|secret|api_key|provider_reference|password|guest|email)' then raise exception 'FAIL snapshot mentions something personal or secret %', left(sn::text, 400); end if;

  -- audit: the request, the decision and the views are on record
  if not exists (select 1 from audit_logs where entity_id = v_id and action = 'platform_access.created') then raise exception 'FAIL request not audited'; end if;
  if not exists (select 1 from audit_logs where entity_id = v_id and action = 'platform_access.updated' and metadata -> 'changed' ? 'status') then raise exception 'FAIL decision not audited'; end if;
  if not exists (select 1 from audit_logs where entity_id = v_id and action = 'platform_access.updated' and metadata -> 'changed' ? 'views') then raise exception 'FAIL views not audited'; end if;
  raise notice 'PASS access requests: another admin decides, clock starts on approval, only the requester sees a no-secrets setup, all audited';
end $$;

-- 3. ending, expiry, denial and the list
do $$ declare
  v_t uuid := (select id from tenants where slug = 't50-hotel'); v_id uuid; v_pending uuid; l jsonb;
begin
  perform t_sys();
  select id into v_id from access_requests where tenant_id = v_t and status = 'approved';

  -- the list: an admin sees all, support sees their own, an ordinary owner nothing
  perform t_as('00000000-0000-0000-0000-00000000f050');
  l := platform_list_access(v_t, null);
  if not (l @> format('[{"id":"%s","status":"approved","mine":false}]', v_id)::jsonb) then raise exception 'FAIL admin list %', l; end if;
  perform t_as('00000000-0000-0000-0000-00000000f051');
  if jsonb_array_length(platform_list_access(v_t, null)) <> 1 then raise exception 'FAIL support list'; end if;
  perform t_expect($q$select platform_list_access(null, 'bogus')$q$, 'POLICY_VIOLATION: access status');
  perform t_as('00000000-0000-0000-0000-00000000f052');
  perform t_expect('select platform_list_access()', 'NOT_FOUND');

  -- an ordinary owner cannot end it; the requester ends it early
  perform t_expect(format('select platform_end_access(%L)', v_id), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000f051');
  if platform_end_access(v_id) ->> 'status' <> 'revoked' then raise exception 'FAIL end early'; end if;
  perform t_expect(format('select platform_access_view(%L)', v_id), 'NOT_FOUND');
  perform t_expect(format('select platform_end_access(%L)', v_id), 'CONFLICT: access state');

  -- ask again, an admin denies it; a denied request can be asked again
  v_pending := (platform_request_access(v_t, 'Second look at the tax rules', 1) ->> 'id')::uuid;
  perform t_as('00000000-0000-0000-0000-00000000f054');
  perform platform_decide_access(v_pending, 'denied', 'Not needed');
  perform t_as('00000000-0000-0000-0000-00000000f051');
  v_id := (platform_request_access(v_t, 'Third attempt with a better reason', 1) ->> 'id')::uuid;
  -- the requester withdraws it
  if platform_end_access(v_id) ->> 'status' <> 'cancelled' then raise exception 'FAIL withdraw'; end if;

  -- time: an approved window that has elapsed reads expired and shows nothing; a stale pending one cannot be decided
  perform t_as('00000000-0000-0000-0000-00000000f051');
  v_id := (platform_request_access(v_t, 'Checking after the window', 1) ->> 'id')::uuid;
  perform t_as('00000000-0000-0000-0000-00000000f050');
  perform platform_decide_access(v_id, 'approved');
  perform t_sys();
  update access_requests set approved_until = now() - interval '1 minute' where id = v_id;
  perform t_as('00000000-0000-0000-0000-00000000f051');
  if (select x ->> 'status' from jsonb_array_elements(platform_list_access(v_t, null)) x where x ->> 'id' = v_id::text) <> 'expired' then raise exception 'FAIL expired not shown'; end if;
  perform t_expect(format('select platform_access_view(%L)', v_id), 'NOT_FOUND');
  perform t_expect(format('select platform_end_access(%L)', v_id), 'CONFLICT: access state');
  -- an elapsed window does not block asking again
  v_id := (platform_request_access(v_t, 'A fresh request after expiry', 1) ->> 'id')::uuid;
  perform t_sys();
  update access_requests set requested_at = now() - interval '25 hours' where id = v_id;
  perform t_as('00000000-0000-0000-0000-00000000f050');
  perform t_expect(format('select platform_decide_access(%L, ''approved'')', v_id), 'CONFLICT: access state');
  perform t_as('00000000-0000-0000-0000-00000000f051');
  perform platform_request_access(v_t, 'Asking again after a stale one', 1);

  perform t_sys();
  delete from access_requests where tenant_id = v_t;
  raise notice 'PASS access requests: list scoped by role, end early, withdraw, deny and ask again, expiry shows nothing and never blocks';
end $$;

-- 4. closed to logins and anon
do $$ declare v_state text; begin
  perform t_as('00000000-0000-0000-0000-00000000f050');
  begin perform 1 from access_requests; v_state := 'allowed'; exception when insufficient_privilege then v_state := 'refused'; end;
  if v_state <> 'refused' then raise exception 'FAIL table readable by a login'; end if;
  perform t_sys();
  begin set local role anon; perform platform_request_access(gen_random_uuid(), 'Anonymous attempt here', 1); v_state := 'allowed';
  exception when insufficient_privilege then v_state := 'refused'; end;
  reset role;
  if v_state <> 'refused' then raise exception 'FAIL anon could ask'; end if;
  raise notice 'PASS access requests: table closed to logins, anon refused';
end $$;
