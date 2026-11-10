-- Hotel theme (migration 093). Hotel A: tenant a1, property a2. Owner aa01, front desk aa04, another hotel's owner bb01.
\set ON_ERROR_STOP on

-- 1. a new hotel has no theme; set, change and clear it; guest_hotel follows; every change is audited
do $$
declare
  v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; r jsonb;
begin
  perform t_sys();
  update properties set theme = null where id = v_p;
  r := guest_hotel('book.hotel-a.test');
  if (r -> 'theme') <> 'null'::jsonb then raise exception 'FAIL a hotel with no theme shows %', r -> 'theme'; end if;

  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform set_hotel_theme(v_p, 'luxury');
  perform t_sys();
  if (select theme from properties where id = v_p) <> 'luxury' then raise exception 'FAIL theme not saved'; end if;
  if (guest_hotel('book.hotel-a.test') ->> 'theme') <> 'luxury' then raise exception 'FAIL guest_hotel does not return the theme'; end if;
  if not exists (select 1 from audit_logs where entity_id = v_p and action = 'property.updated' and metadata -> 'changed' ? 'theme') then raise exception 'FAIL theme change not audited'; end if;

  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform set_hotel_theme(v_p, 'classic');
  perform set_hotel_theme(v_p, ' modern ');   -- surrounding blanks are trimmed; the names are lower case
  perform t_sys();
  if (select theme from properties where id = v_p) is distinct from 'modern' then raise exception 'FAIL theme is %', (select theme from properties where id = v_p); end if;

  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform set_hotel_theme(v_p, '  ');
  perform t_sys();
  if (select theme from properties where id = v_p) is not null then raise exception 'FAIL blank did not return to the standard look'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform set_hotel_theme(v_p, null);
  perform t_sys();
  if (select theme from properties where id = v_p) is not null then raise exception 'FAIL null did not return to the standard look'; end if;
  raise notice 'PASS hotel theme: set, changed and cleared; guest_hotel follows; audited';
end $$;

-- 2. only the three names are accepted, and the table says so too
do $$
declare
  v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_try text; v_refused integer := 0;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  foreach v_try in array array['Modern', 'neon', 'luxury; drop table properties', '<script>', 'default', 'standard'] loop
    begin
      perform set_hotel_theme(v_p, v_try);
      raise exception 'FAIL % was accepted', v_try;
    exception when others then
      if sqlerrm like 'FAIL%' then raise; end if;
      v_refused := v_refused + 1;
    end;
  end loop;
  if v_refused <> 6 then raise exception 'FAIL only % refused', v_refused; end if;
  perform t_sys();
  if (select theme from properties where id = v_p) is not null then raise exception 'FAIL a refused value was stored'; end if;
  begin
    update properties set theme = 'neon' where id = v_p;
    raise exception 'FAIL the table accepted an unknown theme';
  exception when check_violation then null;
  end;
  raise notice 'PASS hotel theme: unknown names refused by the function and by the table';
end $$;

-- 3. only property.configure at this hotel; anon cannot call it
do $$
declare
  v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_state text;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select set_hotel_theme(%L, %L)', v_p, 'luxury'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select set_hotel_theme(%L, %L)', v_p, 'luxury'), 'NOT_FOUND');
  perform t_sys();
  if (select theme from properties where id = v_p) is not null then raise exception 'FAIL a refused caller set the theme'; end if;
  begin
    set local role anon;
    perform set_hotel_theme(v_p, 'luxury');
    v_state := 'allowed';
  exception when insufficient_privilege then v_state := 'refused';
  end;
  reset role;
  if v_state <> 'refused' then raise exception 'FAIL anon could call set_hotel_theme'; end if;
  raise notice 'PASS hotel theme: front desk and another hotel are refused, anon cannot call it';
end $$;
