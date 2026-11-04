-- The no-show list (migration 046). Reuses t_as / t_sys / t_expect (05) and the t40_book helper (46).
-- Users: aa01 owner A, aa04 front desk A (no report.view), aa05 accountant A, aa02 housekeeping A, bb01 owner B.
-- Bookings sit 1800 to 1810 days ahead, which nothing else uses, so the list over that window is absolute.
\set ON_ERROR_STOP on

create function t47_list(p_from date, p_to date) returns jsonb language sql as $$ select no_show_list('00000000-0000-0000-0000-0000000000a2', p_from, p_to) $$;

-- 1. Who may read it, and the range rules
do $$ declare t date := property_today('00000000-0000-0000-0000-0000000000a2'); begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select t47_list(%L,%L)', t, t), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform t_expect(format('select t47_list(%L,%L)', t, t), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select t47_list(%L,%L)', t, t), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  perform t_expect(format('select t47_list(%L,%L)', t, t - 1), 'POLICY_VIOLATION: range');
  perform t_expect(format('select t47_list(%L,%L)', t, t + 92), 'POLICY_VIOLATION: range');
  perform t_expect(format('select no_show_list(%L,null,%L)', '00000000-0000-0000-0000-0000000000a2', t), 'POLICY_VIOLATION: range');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t47_list(t, t + 91);
  perform t_sys();
  raise notice 'PASS access: accountant and owner may read; front desk, housekeeping and another hotel get NOT_FOUND; 1 to 92 days only';
end $$;

-- 2. Only real no-shows, by arrival day, newest first, with their charge; names and links follow the viewer's permissions
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); g uuid := gen_random_uuid(); a uuid; b uuid; c uuid; d uuid; r jsonb; hid uuid; vid uuid;
begin
  perform t_sys();
  insert into guests (id, tenant_id, full_name) select g, tenant_id, 'T47 Guest' from properties where id = '00000000-0000-0000-0000-0000000000a2';
  a := t40_book(g, 'phone', 1800, 2, 't47-a');      -- no-show
  b := t40_book(g, 'walk_in', 1805, 1, 't47-b');    -- no-show, later arrival
  c := t40_book(g, 'phone', 1802, 1, 't47-c');      -- plain cancellation: not a no-show
  d := t40_book(g, 'phone', 1808, 1, 't47-d');      -- stays booked: not a no-show
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform cancel_reservation(a, 'no-show', 't47-a-c');
  perform cancel_reservation(b, 'no-show', 't47-b-c');
  perform cancel_reservation(c, 'changed plans', 't47-c-c');
  perform t_sys();
  update reservations set no_show_at = now() where id in (a, b);
  update reservations set cancellation_charge_minor = 123400 where id = a;
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  r := t47_list(t + 1800, t + 1810);
  perform t_sys();
  if (r ->> 'total')::int <> 2 or jsonb_array_length(r -> 'rows') <> 2 then raise exception 'FAIL only the two no-shows, not the cancellation or the live booking %', r; end if;
  if (r #>> '{rows,0,reservation_id}')::uuid <> b or (r #>> '{rows,1,reservation_id}')::uuid <> a then raise exception 'FAIL newest arrival first %', r -> 'rows'; end if;
  if (r #>> '{rows,1,charge_minor}')::bigint <> 123400 or (r #>> '{rows,1,nights}')::int <> 2 or r #>> '{rows,1,source}' <> 'phone' or r #>> '{rows,0,source}' <> 'walk_in'
    then raise exception 'FAIL row values %', r -> 'rows'; end if;
  if r #>> '{rows,0,guest_name}' <> 'T47 Guest' or r #>> '{rows,0,booking_reference}' is null or (r ->> 'names_hidden')::boolean or (r ->> 'links_hidden')::boolean
    then raise exception 'FAIL accountant sees names and booking numbers %', r; end if;
  -- a window that holds only one arrival
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  r := t47_list(t + 1800, t + 1801);
  perform t_sys();
  if (r ->> 'total')::int <> 1 or (r #>> '{rows,0,reservation_id}')::uuid <> a then raise exception 'FAIL one-arrival window %', r; end if;

  -- without guest.view the names go; without reservation.view the booking numbers and ids go; the rows stay
  select p.id into hid from permissions p where p.key = 'guest.view';
  select p.id into vid from permissions p where p.key = 'reservation.view';
  delete from role_permissions where permission_id in (hid, vid) and role_id = (select id from roles where key = 'accountant');
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  r := t47_list(t + 1800, t + 1810);
  perform t_sys();
  insert into role_permissions (role_id, permission_id) select r2.id, x from roles r2, unnest(array[hid, vid]) as x where r2.key = 'accountant';
  if not (r ->> 'names_hidden')::boolean or not (r ->> 'links_hidden')::boolean or (r ->> 'total')::int <> 2 or jsonb_array_length(r -> 'rows') <> 2
    then raise exception 'FAIL rows stay, flags set, without the two permissions %', r; end if;
  if r::text like '%T47%' or r #>> '{rows,0,reservation_id}' is not null or r #>> '{rows,0,booking_reference}' is not null
    then raise exception 'FAIL a name or booking number leaked %', r; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  if (t47_list(t + 1800, t + 1810) ->> 'names_hidden')::boolean then raise exception 'FAIL permissions were not restored'; end if;
  perform t_sys();
  raise notice 'PASS list: real no-shows only, newest arrival first, with charge; names and booking numbers only with guest.view and reservation.view';
end $$;

-- 3. An empty window, and closed to anon
do $$ declare t date := property_today('00000000-0000-0000-0000-0000000000a2'); r jsonb; begin
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  r := t47_list(t + 1820, t + 1830);
  perform t_sys();
  if (r ->> 'total')::int <> 0 or r -> 'rows' <> '[]'::jsonb then raise exception 'FAIL empty window %', r; end if;
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('role', 'anon', true);
  begin
    perform no_show_list('00000000-0000-0000-0000-0000000000a2', current_date, current_date);
    raise exception 'FAIL anon ran no_show_list';
  exception when insufficient_privilege then null;
  end;
  perform set_config('role', 'postgres', true);
  raise notice 'PASS an empty window gives an empty list; anon cannot run it';
end $$;
