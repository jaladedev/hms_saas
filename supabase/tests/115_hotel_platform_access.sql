-- hotel_platform_access (migration 115). Hotel A (a1 / a2). Platform users from 51 and 111: f050, f051, f054. Reuses t_as / t_sys / t_expect.
\set ON_ERROR_STOP on

do $$ declare
  prop uuid := '00000000-0000-0000-0000-0000000000a2'; v_t uuid := '00000000-0000-0000-0000-0000000000a1';
  owner text := '00000000-0000-0000-0000-00000000aa01'; fd text := '00000000-0000-0000-0000-00000000aa04';
  other text := '00000000-0000-0000-0000-00000000bb01'; l jsonb; txt text;
begin
  perform t_sys();
  delete from access_requests where tenant_id = v_t;
  -- none yet
  perform t_as(owner);
  if jsonb_array_length(hotel_platform_access(prop)) <> 0 then raise exception 'FAIL expected an empty list'; end if;

  perform t_sys();
  -- pending, denied and cancelled are not windows; an open window, a window stopped early and one that ran out are
  insert into access_requests (tenant_id, requested_by, reason, hours) values (v_t, '00000000-0000-0000-0000-00000000f051', 'Secret internal reason one', 1);
  insert into access_requests (tenant_id, requested_by, reason, hours, status, decided_by, decided_at, decision_note)
    values (v_t, '00000000-0000-0000-0000-00000000f054', 'Secret internal reason two', 4, 'denied', '00000000-0000-0000-0000-00000000f050', now(), 'no');
  insert into access_requests (tenant_id, requested_by, reason, hours, status, decided_by, decided_at, approved_until, views, last_viewed_at)
    values (v_t, '00000000-0000-0000-0000-00000000f050', 'Secret internal reason three', 4, 'approved', '00000000-0000-0000-0000-00000000f054', now() - interval '1 hour', now() + interval '3 hours', 2, now() - interval '10 minutes');
  insert into access_requests (tenant_id, requested_by, reason, hours, status, decided_by, decided_at, approved_until, ended_at)
    values (v_t, '00000000-0000-0000-0000-00000000f052', 'Secret internal reason four', 24, 'revoked', '00000000-0000-0000-0000-00000000f050', now() - interval '5 hours', now() + interval '19 hours', now() - interval '4 hours');
  insert into access_requests (tenant_id, requested_by, reason, hours, status, decided_by, decided_at, approved_until, ended_at)
    values (v_t, '00000000-0000-0000-0000-00000000f053', 'Secret internal reason five', 1, 'revoked', '00000000-0000-0000-0000-00000000f050', now() - interval '3 days', now() - interval '3 days' + interval '1 hour', now() - interval '2 days');
  insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000f053', 'x53@platform.test') on conflict do nothing;

  perform t_as(owner);
  l := hotel_platform_access(prop);
  if jsonb_array_length(l) <> 3 then raise exception 'FAIL expected 3 windows, got %', l; end if;
  if l -> 0 ->> 'state' <> 'open' or (l -> 0 ->> 'views')::int <> 2 then raise exception 'FAIL newest should be the open one %', l -> 0; end if;
  if l -> 1 ->> 'state' <> 'ended_early' then raise exception 'FAIL second should be ended early %', l -> 1; end if;
  if l -> 2 ->> 'state' <> 'finished' then raise exception 'FAIL third should be finished (ran out) %', l -> 2; end if;
  txt := l::text;
  if txt ~* 'secret internal|requested_by|decided_by|decision_note|ticket|f05' then raise exception 'FAIL internal detail leaked: %', txt; end if;

  -- who may read
  perform t_expect(format('select hotel_platform_access(%L)', gen_random_uuid()), 'NOT_FOUND');
  perform t_as(fd);
  perform t_expect(format('select hotel_platform_access(%L)', prop), 'NOT_FOUND');
  perform t_as(other);
  perform t_expect(format('select hotel_platform_access(%L)', prop), 'NOT_FOUND');
  reset role;
  perform t_sys();
  delete from access_requests where tenant_id = v_t;
  raise notice 'PASS hotel platform access: owner sees approved windows (open, ended early, finished) and nothing internal; others NOT_FOUND';
end $$;
