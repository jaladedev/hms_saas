-- Hotel profile (migration 087): who may change it, what is refused, the audit row, and what guest_hotel returns.
-- Hotel A: property a2. Owner aa01, front desk aa04, another hotel's owner bb01. Reuses t_as / t_sys / t_expect (05).
\set ON_ERROR_STOP on

-- 1. the owner saves; values are trimmed and blanks become null; guest_hotel returns them; the audit row lists what changed
do $$
declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; r jsonb;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform update_hotel_profile(v_p, '  +234 802 000 0000 ', ' desk@hotel-a.test ', '  A quiet hotel by the river.  ');
  perform t_sys();
  r := guest_hotel('book.hotel-a.test');
  if r ->> 'phone' <> '+234 802 000 0000' or r ->> 'email' <> 'desk@hotel-a.test' or r ->> 'intro' <> 'A quiet hotel by the river.' then raise exception 'FAIL profile %', r; end if;
  if not exists (select 1 from audit_logs where entity_id = v_p and action = 'property.updated' and metadata -> 'changed' ?& array['phone','contact_email','intro']) then
    raise exception 'FAIL profile change not audited';
  end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform update_hotel_profile(v_p, '   ', '', null);
  perform t_sys();
  r := guest_hotel('book.hotel-a.test');
  if r -> 'phone' <> 'null'::jsonb or r -> 'email' <> 'null'::jsonb or r -> 'intro' <> 'null'::jsonb then raise exception 'FAIL blanks should clear %', r; end if;
  raise notice 'PASS hotel profile: saved trimmed, blanks clear it, guest_hotel returns it, the change is audited';
end $$;

-- 2. refused values change nothing
do $$
declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_try text; v_refused integer := 0;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  for v_try in select unnest(array['phone letters', 'phone short', 'phone long', 'email no at', 'email no dot', 'email space', 'email long', 'intro long'])
  loop
    begin
      case v_try
        when 'phone letters' then perform update_hotel_profile(v_p, 'call me', null, null);
        when 'phone short' then perform update_hotel_profile(v_p, '1234', null, null);
        when 'phone long' then perform update_hotel_profile(v_p, repeat('1', 33), null, null);
        when 'email no at' then perform update_hotel_profile(v_p, null, 'desk.hotel-a.test', null);
        when 'email no dot' then perform update_hotel_profile(v_p, null, 'desk@hotel', null);
        when 'email space' then perform update_hotel_profile(v_p, null, 'de sk@hotel-a.test', null);
        when 'email long' then perform update_hotel_profile(v_p, null, repeat('a', 250) || '@b.co', null);
        when 'intro long' then perform update_hotel_profile(v_p, null, null, repeat('x', 501));
      end case;
      raise exception 'FAIL % was accepted', v_try;
    exception when check_violation then v_refused := v_refused + 1;
    end;
  end loop;
  if v_refused <> 8 then raise exception 'FAIL only % refused', v_refused; end if;
  perform t_sys();
  if (select count(*) from properties where id = v_p and (phone is not null or contact_email is not null or intro is not null)) <> 0 then raise exception 'FAIL a refused value was stored'; end if;
  raise notice 'PASS hotel profile: 8 bad values refused and nothing stored';
end $$;

-- 3. only property.configure at this hotel; anon cannot call it
do $$
declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_state text;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');   -- front desk
  perform t_expect(format('select update_hotel_profile(%L, %L, null, null)', v_p, '+234 802 000 0000'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');   -- another hotel's owner
  perform t_expect(format('select update_hotel_profile(%L, %L, null, null)', v_p, '+234 802 000 0000'), 'NOT_FOUND');
  perform t_sys();
  if (select phone from properties where id = v_p) is not null then raise exception 'FAIL a refused caller changed the hotel'; end if;
  begin
    set local role anon;
    perform update_hotel_profile(v_p, null, null, null);
    v_state := 'allowed';
  exception when insufficient_privilege then v_state := 'refused';
  end;
  reset role;
  if v_state <> 'refused' then raise exception 'FAIL anon could call update_hotel_profile'; end if;
  raise notice 'PASS hotel profile: front desk and another hotel are refused, anon cannot call it';
end $$;
