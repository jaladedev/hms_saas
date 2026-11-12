-- Hotel corner radius (migration 118). Hotel A: tenant a1, property a2. Owner aa01, front desk aa04, another hotel's owner bb01.
\set ON_ERROR_STOP on

-- 1. set, normalise, clear; guest_hotel follows; audited
do $$
declare
  v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; r jsonb;
begin
  perform t_sys();
  update properties set theme_radius = null where id = v_p;
  r := guest_hotel('book.hotel-a.test');
  if (r -> 'radius') <> 'null'::jsonb then raise exception 'FAIL no radius should show null %', r; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform set_hotel_radius(v_p, ' ROUND ');
  perform t_sys();
  r := guest_hotel('book.hotel-a.test');
  if r ->> 'radius' <> 'round' then raise exception 'FAIL radius not saved or returned %', r; end if;
  if not exists (select 1 from audit_logs where entity_id = v_p and action = 'property.updated' and metadata -> 'changed' ? 'theme_radius') then raise exception 'FAIL radius change not audited'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform set_hotel_radius(v_p, '');
  perform t_sys();
  if (select theme_radius from properties where id = v_p) is not null then raise exception 'FAIL radius not cleared'; end if;
  raise notice 'PASS hotel radius: set, normalised and cleared; guest_hotel follows; audited';
end $$;

-- 2. only the listed values are accepted, in the function and in the table
do $$
declare
  v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_try text; v_refused integer := 0;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  for v_try in select unnest(array['pill', '8px', 'sharp; x', 'url(x)'])
  loop
    begin
      perform set_hotel_radius(v_p, v_try);
    exception when others then
      if sqlerrm = 'INVALID_RADIUS' then v_refused := v_refused + 1; end if;
    end;
  end loop;
  perform t_sys();
  if v_refused <> 4 then raise exception 'FAIL % of 4 bad values refused', v_refused; end if;
  begin
    update properties set theme_radius = 'pill' where id = v_p;
    raise exception 'FAIL table accepted a bad radius';
  exception when check_violation then null;
  end;
  raise notice 'PASS hotel radius: only sharp and round are accepted';
end $$;

-- 3. who may set it: the owner only; front desk and another hotel's owner get NOT_FOUND
do $$
declare
  v_p constant uuid := '00000000-0000-0000-0000-0000000000a2';
begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select set_hotel_radius(%L, %L)', v_p, 'round'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select set_hotel_radius(%L, %L)', v_p, 'round'), 'NOT_FOUND');
  perform t_sys();
  if (select theme_radius from properties where id = v_p) is not null then raise exception 'FAIL a refused caller changed the radius'; end if;
  raise notice 'PASS hotel radius: front desk and another hotel are refused';
end $$;
