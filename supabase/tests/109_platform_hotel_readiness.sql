-- Hotel readiness for platform support (migration 109). Platform people from 51: f050 admin, f051 support, f052 hotel owner; group 't50-hotel'.
\set ON_ERROR_STOP on

do $$ declare v_t uuid := (select id from tenants where slug = 't50-hotel'); r jsonb; v_state text; v_props int;
begin
  perform t_sys();
  v_props := (select count(*) from properties where tenant_id = v_t);
  delete from tenant_feature_entitlements where tenant_id = v_t and feature_key in ('online_booking', 'online_payments');

  -- support reads: counts and facts, flags default to on, one entry per property
  perform t_as('00000000-0000-0000-0000-00000000f051');
  r := platform_hotel_readiness(v_t);
  if r ->> 'tenant_status' is null or (r ->> 'online_booking')::boolean is not true or (r ->> 'online_payments')::boolean is not true then raise exception 'FAIL defaults %', r; end if;
  if jsonb_array_length(r -> 'properties') <> v_props then raise exception 'FAIL one entry per property, got %', jsonb_array_length(r -> 'properties'); end if;
  if (r ->> 'domains_verified')::int > (r ->> 'domains')::int then raise exception 'FAIL verified exceeds domains'; end if;

  -- a flag set off shows as false; no names of guests, payments or references anywhere in the answer
  perform t_as('00000000-0000-0000-0000-00000000f050');
  perform platform_set_entitlement(v_t, 'online_booking', false);
  r := platform_hotel_readiness(v_t);
  if (r ->> 'online_booking')::boolean is not false then raise exception 'FAIL online_booking off not shown %', r; end if;
  if r::text ~* '(secret|reference|email|guest|reservation)' then raise exception 'FAIL answer mentions something it must not: %', r; end if;
  perform t_sys();
  delete from tenant_feature_entitlements where tenant_id = v_t and feature_key = 'online_booking';

  -- an unknown group, a hotel owner and a signed-out caller get nothing
  perform t_as('00000000-0000-0000-0000-00000000f051');
  perform t_expect('select platform_hotel_readiness(gen_random_uuid())', 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000f052');
  perform t_expect(format('select platform_hotel_readiness(%L)', v_t), 'NOT_FOUND');
  perform t_sys();
  begin
    set local role anon;
    perform platform_hotel_readiness(v_t);
    v_state := 'allowed';
  exception when insufficient_privilege then v_state := 'refused';
  end;
  reset role;
  if v_state <> 'refused' then raise exception 'FAIL anon could call platform_hotel_readiness'; end if;
  raise notice 'PASS platform hotel readiness: support reads counts and flags, nothing private; owner, unknown group and anon refused';
end $$;
