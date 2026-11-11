-- Hotel facilities and social links (migration 105). Hotel A: tenant a1, property a2. Owner aa01, front desk aa04, another hotel's owner bb01.
\set ON_ERROR_STOP on

-- 1. set, normalise, read back through guest_hotel, audited
do $$
declare
  v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; r jsonb;
begin
  perform t_sys();
  update properties set facilities = '{}', social_instagram = null, social_facebook = null where id = v_p;
  r := guest_hotel('book.hotel-a.test');
  if r -> 'facilities' <> '[]'::jsonb or r -> 'instagram' <> 'null'::jsonb or r -> 'facebook' <> 'null'::jsonb then raise exception 'FAIL empty extras %', r; end if;

  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform set_hotel_extras(v_p, array['  Pool ', '', 'Restaurant', '   ', 'Gym'], ' https://www.instagram.com/bodijaboutique/ ', 'https://facebook.com/bodija.boutique');
  perform t_sys();
  r := guest_hotel('book.hotel-a.test');
  if r -> 'facilities' <> '["Pool","Restaurant","Gym"]'::jsonb then raise exception 'FAIL facilities not trimmed or blanks kept, or order lost %', r -> 'facilities'; end if;
  if r ->> 'instagram' <> 'https://www.instagram.com/bodijaboutique/' or r ->> 'facebook' <> 'https://facebook.com/bodija.boutique' then raise exception 'FAIL links %', r; end if;
  if not exists (select 1 from audit_logs where entity_id = v_p and action = 'property.updated' and metadata -> 'changed' ? 'facilities') then raise exception 'FAIL facilities change not audited'; end if;
  if not exists (select 1 from audit_logs where entity_id = v_p and action = 'property.updated' and metadata -> 'changed' ? 'social_instagram') then raise exception 'FAIL link change not audited'; end if;
  raise notice 'PASS hotel extras: set, trimmed, blanks dropped, order kept; guest_hotel follows; audited';
end $$;

-- 2. blank or null clears everything
do $$
declare
  v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; r jsonb;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform set_hotel_extras(v_p, null, '   ', '');
  perform t_sys();
  r := guest_hotel('book.hotel-a.test');
  if r -> 'facilities' <> '[]'::jsonb or r -> 'instagram' <> 'null'::jsonb or r -> 'facebook' <> 'null'::jsonb then raise exception 'FAIL not cleared %', r; end if;
  raise notice 'PASS hotel extras: null and blank clear them, facilities come back as an empty list';
end $$;

-- 3. only well-formed values are accepted, by the function and by the table
do $$
declare
  v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_try text; v_refused integer := 0; v_expected integer := 0;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  -- facilities
  for v_try in select unnest(array['too many', 'too long', 'repeat'])
  loop
    v_expected := v_expected + 1;
    begin
      case v_try
        when 'too many' then perform set_hotel_extras(v_p, (select array_agg('f' || g) from generate_series(1, 21) g), null, null);
        when 'too long' then perform set_hotel_extras(v_p, array[repeat('x', 41)], null, null);
        when 'repeat' then perform set_hotel_extras(v_p, array['Pool', ' pool '], null, null);
      end case;
    exception when others then
      if sqlerrm = 'POLICY_VIOLATION: facilities' then v_refused := v_refused + 1; end if;
    end;
  end loop;
  -- instagram
  for v_try in select unnest(array['http://instagram.com/bodija', 'https://evil.com/bodija', 'https://instagram.com.evil.com/bodija', 'https://instagram.com/bodija?x=1', 'https://instagram.com/a/b', 'javascript:alert(1)', 'https://instagram.com/', 'https://instagram.com/' || repeat('a', 31), 'bodijaboutique', 'https://facebook.com/bodijaboutique'])
  loop
    v_expected := v_expected + 1;
    begin perform set_hotel_extras(v_p, null, v_try, null);
    exception when others then if sqlerrm = 'POLICY_VIOLATION: instagram' then v_refused := v_refused + 1; end if; end;
  end loop;
  -- facebook
  for v_try in select unnest(array['http://facebook.com/bodijaboutique', 'https://facebook.com/abcd', 'https://facebook.com.evil.com/bodijaboutique', 'https://facebook.com/bodija boutique', 'https://facebook.com/profile.php?id=1', 'https://instagram.com/bodijaboutique'])
  loop
    v_expected := v_expected + 1;
    begin perform set_hotel_extras(v_p, null, null, v_try);
    exception when others then if sqlerrm = 'POLICY_VIOLATION: facebook' then v_refused := v_refused + 1; end if; end;
  end loop;
  perform t_sys();
  if v_refused <> v_expected then raise exception 'FAIL only % of % bad values refused', v_refused, v_expected; end if;
  if (select count(*) from properties where id = v_p and facilities = '{}' and social_instagram is null and social_facebook is null) <> 1 then raise exception 'FAIL a refused value was stored'; end if;
  -- the table says no too, for a script that skips the function
  begin update properties set social_instagram = 'http://instagram.com/x' where id = v_p; raise exception 'FAIL table accepted an http link';
  exception when check_violation then null; end;
  begin update properties set social_facebook = 'https://facebook.com/abcd' where id = v_p; raise exception 'FAIL table accepted a short facebook name';
  exception when check_violation then null; end;
  begin update properties set facilities = array['Pool', 'pool'] where id = v_p; raise exception 'FAIL table accepted repeated facilities';
  exception when check_violation then null; end;
  raise notice 'PASS hotel extras: % bad values refused by the function, and the table refuses them too', v_expected;
end $$;

-- 4. front desk and another hotel are refused; anon cannot call it
do $$
declare
  v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_state text;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select set_hotel_extras(%L, %L, null, null)', v_p, '{Pool}'::text[]), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select set_hotel_extras(%L, %L, null, null)', v_p, '{Pool}'::text[]), 'NOT_FOUND');
  perform t_sys();
  if (select cardinality(facilities) from properties where id = v_p) <> 0 then raise exception 'FAIL a refused caller set facilities'; end if;
  begin
    set local role anon;
    perform set_hotel_extras(v_p, '{Pool}'::text[], null, null);
    v_state := 'allowed';
  exception when insufficient_privilege then v_state := 'refused';
  end;
  reset role;
  if v_state <> 'refused' then raise exception 'FAIL anon could call set_hotel_extras'; end if;
  raise notice 'PASS hotel extras: front desk and another hotel get NOT_FOUND; anon is refused';
end $$;
