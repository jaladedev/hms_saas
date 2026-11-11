-- Hotel fonts (migration 100). Hotel A: tenant a1, property a2. Owner aa01, front desk aa04, another hotel's owner bb01.
\set ON_ERROR_STOP on

-- 1. set, normalise, clear; guest_hotel follows; audited
do $$
declare
  v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; r jsonb;
begin
  perform t_sys();
  update properties set theme_font_display = null, theme_font_body = null where id = v_p;
  r := guest_hotel('book.hotel-a.test');
  if (r -> 'font_display') <> 'null'::jsonb or (r -> 'font_body') <> 'null'::jsonb then raise exception 'FAIL no fonts should show null %', r; end if;

  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform set_hotel_fonts(v_p, ' Outfit ', 'SOURCE-SERIF');
  perform t_sys();
  r := guest_hotel('book.hotel-a.test');
  if r ->> 'font_display' <> 'outfit' or r ->> 'font_body' <> 'source-serif' then raise exception 'FAIL fonts not saved or returned %', r; end if;
  if not exists (select 1 from audit_logs where entity_id = v_p and action = 'property.updated' and metadata -> 'changed' ? 'theme_font_display') then raise exception 'FAIL font change not audited'; end if;

  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform set_hotel_fonts(v_p, 'lora', '');   -- one set, one cleared
  perform t_sys();
  if (select theme_font_display from properties where id = v_p) <> 'lora' or (select theme_font_body from properties where id = v_p) is not null then raise exception 'FAIL partial set'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform set_hotel_fonts(v_p, null, null);
  perform t_sys();
  if (select count(*) from properties where id = v_p and theme_font_display is null and theme_font_body is null) <> 1 then raise exception 'FAIL fonts not cleared'; end if;
  raise notice 'PASS hotel fonts: set, normalised and cleared; guest_hotel follows; audited';
end $$;

-- 2. only the listed fonts are accepted, in the function and in the table
do $$
declare
  v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_try text; v_refused integer := 0;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  for v_try in select unnest(array['comic-sans', 'inter', 'Arial; x', 'url(x)'])   -- inter is a body font, not a heading font
  loop
    begin
      perform set_hotel_fonts(v_p, v_try, null);
    exception when others then
      if sqlerrm = 'INVALID_FONT' then v_refused := v_refused + 1; end if;
    end;
  end loop;
  begin perform set_hotel_fonts(v_p, null, 'sora'); exception when others then if sqlerrm = 'INVALID_FONT' then v_refused := v_refused + 1; end if; end;   -- sora is a heading font
  perform t_sys();
  if v_refused <> 5 then raise exception 'FAIL % of 5 bad fonts refused', v_refused; end if;
  begin
    update properties set theme_font_body = 'comic-sans' where id = v_p;
    raise exception 'FAIL table accepted a bad font';
  exception when check_violation then null;
  end;
  raise notice 'PASS hotel fonts: unknown fonts refused by the function and the table';
end $$;

-- 3. front desk and another hotel are refused; anon cannot call it
do $$
declare
  v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_state text;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select set_hotel_fonts(%L, %L, %L)', v_p, 'sora', 'inter'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select set_hotel_fonts(%L, %L, %L)', v_p, 'sora', 'inter'), 'NOT_FOUND');
  perform t_sys();
  if (select theme_font_display from properties where id = v_p) is not null then raise exception 'FAIL a refused caller set a font'; end if;
  begin
    set local role anon;
    perform set_hotel_fonts(v_p, 'sora', 'inter');
    v_state := 'allowed';
  exception when insufficient_privilege then v_state := 'refused';
  end;
  reset role;
  if v_state <> 'refused' then raise exception 'FAIL anon could call set_hotel_fonts'; end if;
  raise notice 'PASS hotel fonts: front desk and another hotel refused, anon cannot call it';
end $$;
