-- The platform property directory (migration 139). Platform people from 51: f050 admin, f051 support, f052 hotel owner.
\set ON_ERROR_STOP on

do $$ declare v_all int; r jsonb; row jsonb;
begin
  perform t_sys();
  v_all := (select count(*) from properties);   -- counted as the system: a platform user's own view is limited by row security
  -- support and admin read; every property appears once, with its group
  perform t_as('00000000-0000-0000-0000-00000000f051');
  r := platform_list_properties();
  if jsonb_array_length(r) <> v_all then raise exception 'FAIL not one row per property: % of %', jsonb_array_length(r), v_all; end if;
  select e into row from jsonb_array_elements(r) e where e ->> 'tenant_id' = '00000000-0000-0000-0000-0000000000a1' limit 1;
  if row ->> 'tenant_name' is null or row ->> 'name' is null or row ->> 'timezone' is null then raise exception 'FAIL row incomplete %', row; end if;
  if row ?| array['secret', 'secret_reference', 'email', 'guests', 'reservations'] then raise exception 'FAIL unexpected keys %', row; end if;
  perform t_as('00000000-0000-0000-0000-00000000f050');
  if jsonb_array_length(platform_list_properties()) <> v_all then raise exception 'FAIL admin cannot read'; end if;

  -- a hotel owner and a signed-out caller get nothing
  perform t_as('00000000-0000-0000-0000-00000000f052');
  perform t_expect('select platform_list_properties()', 'NOT_FOUND');
  perform t_sys();
  begin
    set local role anon;
    perform platform_list_properties();
    raise exception 'FAIL anon executed';
  exception when insufficient_privilege then null; end;
  perform t_sys();
  raise notice 'PASS property directory: one row per property for platform people, nothing for owners or anonymous';
end $$;
