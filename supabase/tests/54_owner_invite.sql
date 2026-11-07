-- Resend an owner's invitation (migration 054). Runs after 51: group 't50-hotel' with owner f053 (email not yet confirmed).
\set ON_ERROR_STOP on

do $$
declare v_t uuid := (select id from tenants where slug = 't50-hotel'); r jsonb; n bigint;
begin
  -- 1. only an admin; a support user, an ordinary login and a user who is not an owner of the group are refused
  perform t_as('00000000-0000-0000-0000-00000000f051');
  perform t_expect(format('select platform_owner_invite_check(%L, %L)', v_t, '00000000-0000-0000-0000-00000000f053'), 'NOT_FOUND');
  perform t_expect(format('select platform_log_owner_invite(%L, %L)', v_t, '00000000-0000-0000-0000-00000000f053'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000f053');
  perform t_expect(format('select platform_owner_invite_check(%L, %L)', v_t, '00000000-0000-0000-0000-00000000f053'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000f050');
  perform t_expect(format('select platform_owner_invite_check(%L, %L)', v_t, '00000000-0000-0000-0000-00000000f051'), 'NOT_FOUND');   -- a platform user, not an owner here
  perform t_expect(format('select platform_owner_invite_check(%L, %L)', gen_random_uuid(), '00000000-0000-0000-0000-00000000f053'), 'NOT_FOUND');
  perform t_expect(format('select platform_owner_invite_check(%L, %L)', v_t, gen_random_uuid()), 'NOT_FOUND');
  perform t_expect(format('select platform_owner_invite_check(%L, %L)', v_t, (select user_id from tenant_memberships where tenant_id <> v_t limit 1)), 'NOT_FOUND');   -- another group's member

  -- 2. the owner has not accepted; after confirming the email they have; the detail agrees
  r := platform_owner_invite_check(v_t, '00000000-0000-0000-0000-00000000f053');
  if r ->> 'email' <> 'owner@newhotel.test' or (r ->> 'accepted') <> 'false' then raise exception 'FAIL check before accept %', r; end if;
  if (platform_tenant_detail(v_t) -> 'owners' -> 0 ->> 'accepted') <> 'false' then raise exception 'FAIL detail before accept'; end if;

  -- 3. logging writes one audit row attributed to the admin; nothing else changes
  perform t_sys();
  select count(*) into n from audit_logs where action = 'platform.owner_invite_resent';
  perform t_as('00000000-0000-0000-0000-00000000f050');
  perform platform_log_owner_invite(v_t, '00000000-0000-0000-0000-00000000f053');
  perform t_sys();
  if (select count(*) from audit_logs where action = 'platform.owner_invite_resent') - n <> 1 then raise exception 'FAIL expected one audit row'; end if;
  if not exists (select 1 from audit_logs where action = 'platform.owner_invite_resent' and tenant_id = v_t and actor_user_id = '00000000-0000-0000-0000-00000000f050') then raise exception 'FAIL not attributed to the admin'; end if;

  update auth.users set email_confirmed_at = now() where id = '00000000-0000-0000-0000-00000000f053';
  perform t_as('00000000-0000-0000-0000-00000000f050');
  if (platform_owner_invite_check(v_t, '00000000-0000-0000-0000-00000000f053') ->> 'accepted') <> 'true' then raise exception 'FAIL check after accept'; end if;
  if (platform_tenant_detail(v_t) -> 'owners' -> 0 ->> 'accepted') <> 'true' then raise exception 'FAIL detail after accept'; end if;
  perform t_sys();
  raise notice 'PASS owner invite: admin only, owners of that group only, accepted state shown, resend audited under the admin';
end $$;
