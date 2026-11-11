-- Hotel main colour (migration 099). Hotel A: tenant a1, property a2. Owner aa01, front desk aa04, another hotel's owner bb01.
\set ON_ERROR_STOP on

-- 1. set, normalise, clear; guest_hotel follows; audited
do $$
declare
  v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; r jsonb;
begin
  perform t_sys();
  update properties set theme_primary = null where id = v_p;
  if (guest_hotel('book.hotel-a.test') -> 'theme_primary') <> 'null'::jsonb then raise exception 'FAIL no colour should show null'; end if;

  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform set_hotel_primary_color(v_p, ' #7C2D12 ');
  perform t_sys();
  if (select theme_primary from properties where id = v_p) is distinct from '#7c2d12' then raise exception 'FAIL colour not saved lower case: %', (select theme_primary from properties where id = v_p); end if;
  r := guest_hotel('book.hotel-a.test');
  if r ->> 'theme_primary' <> '#7c2d12' then raise exception 'FAIL guest_hotel does not return the colour %', r; end if;
  if not exists (select 1 from audit_logs where entity_id = v_p and action = 'property.updated' and metadata -> 'changed' ? 'theme_primary') then raise exception 'FAIL colour change not audited'; end if;

  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform set_hotel_primary_color(v_p, '  ');
  perform t_sys();
  if (select theme_primary from properties where id = v_p) is not null then raise exception 'FAIL blank did not clear the colour'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform set_hotel_primary_color(v_p, '#0f766e');
  perform set_hotel_primary_color(v_p, null);
  perform t_sys();
  if (select theme_primary from properties where id = v_p) is not null then raise exception 'FAIL null did not clear the colour'; end if;
  raise notice 'PASS hotel colour: set, normalised and cleared; guest_hotel follows; audited';
end $$;

-- 2. only #rrggbb is accepted, in the function and in the table
do $$
declare
  v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_try text; v_refused integer := 0;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  for v_try in select unnest(array['red', '#fff', '0f766e', '#12345g', '#1234567', 'url(x)', '#0f766e; x'])
  loop
    begin
      perform set_hotel_primary_color(v_p, v_try);
    exception when others then
      if sqlerrm = 'INVALID_COLOR' then v_refused := v_refused + 1; end if;
    end;
  end loop;
  perform t_sys();
  if v_refused <> 7 then raise exception 'FAIL % of 7 bad colours refused', v_refused; end if;
  begin
    update properties set theme_primary = 'red' where id = v_p;
    raise exception 'FAIL table accepted a bad colour';
  exception when check_violation then null;
  end;
  raise notice 'PASS hotel colour: malformed colours refused by the function and the table';
end $$;

-- 3. front desk and another hotel are refused; anon cannot call it
do $$
declare
  v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_state text;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select set_hotel_primary_color(%L, %L)', v_p, '#7c2d12'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select set_hotel_primary_color(%L, %L)', v_p, '#7c2d12'), 'NOT_FOUND');
  perform t_sys();
  if (select theme_primary from properties where id = v_p) is not null then raise exception 'FAIL a refused caller set the colour'; end if;
  begin
    set local role anon;
    perform set_hotel_primary_color(v_p, '#7c2d12');
    v_state := 'allowed';
  exception when insufficient_privilege then v_state := 'refused';
  end;
  reset role;
  if v_state <> 'refused' then raise exception 'FAIL anon could call set_hotel_primary_color'; end if;
  raise notice 'PASS hotel colour: front desk and another hotel refused, anon cannot call it';
end $$;
