-- 054 Resend an owner's invitation.
--
-- 050 invites a new owner by email when it creates a group. If that email is lost or the link expires, the owner has no way in
-- and nobody to ask but the platform admin. This lets an admin see which owners have not accepted yet and resend the invitation.
--
-- The database does two small things and the app does the third:
--   * platform_owner_invite_check(tenant, user): admin only; says whether this user is an owner of this group and whether they
--     have confirmed their email (accepted). Anyone else, or a user who is not an owner of that group, gets NOT_FOUND, so the
--     function cannot be used to look up an arbitrary login.
--   * platform_log_owner_invite(tenant, user): writes the audit row `platform.owner_invite_resent` with the admin as actor.
--   * the app sends the email (the service key is needed for that) only after the check passes, then records it.
-- "Accepted" means email_confirmed_at is set, which Supabase does when the person follows the invitation link.

create function platform_owner_invite_check(p_tenant uuid, p_user uuid) returns jsonb
language plpgsql security definer set search_path = public, auth as $$
declare u record;
begin
  perform platform_require('admin');
  select au.email, au.email_confirmed_at into u
    from auth.users au
    join tenant_memberships m on m.user_id = au.id and m.tenant_id = p_tenant and m.status = 'active'
   where au.id = p_user
     and exists (select 1 from membership_roles mr join roles r on r.id = mr.role_id where mr.membership_id = m.id and r.key = 'owner');
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  return jsonb_build_object('email', u.email, 'accepted', u.email_confirmed_at is not null);
end $$;

create function platform_log_owner_invite(p_tenant uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := platform_require('admin');
begin
  perform platform_owner_invite_check(p_tenant, p_user);
  perform write_audit(p_tenant, null, v_uid, 'platform.owner_invite_resent', 'tenant_membership', p_user, null, jsonb_build_object('owner_user_id', p_user));
end $$;

-- The detail shows whether each owner has accepted. (Same function as 051 plus `accepted` on each owner.)
create or replace function platform_tenant_detail(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare t tenants%rowtype;
begin
  perform platform_require('support');
  select * into t from tenants where id = p_tenant;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  return jsonb_build_object(
    'tenant', jsonb_build_object('id', t.id, 'name', t.name, 'slug', t.slug, 'status', t.status, 'currency', t.default_currency, 'created_at', t.created_at),
    'properties', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'code', p.code, 'city', p.city, 'state', p.state,
                     'timezone', p.timezone, 'currency', p.currency, 'status', p.status) order by p.name) from properties p where p.tenant_id = t.id), '[]'::jsonb),
    'domains', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'host', d.host, 'property_id', d.property_id, 'is_primary', d.is_primary,
                     'verified_at', d.verified_at) order by d.host) from tenant_domains d where d.tenant_id = t.id), '[]'::jsonb),
    'payment_accounts', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'provider', a.provider, 'mode', a.mode, 'label', a.account_label,
                     'secret_reference', a.secret_reference, 'status', a.status) order by a.mode, a.account_label)
                     from payment_provider_accounts a where a.tenant_id = t.id), '[]'::jsonb),
    'owners', coalesce((select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'email', u.email, 'status', m.status, 'accepted', u.email_confirmed_at is not null) order by u.email)
                     from tenant_memberships m join auth.users u on u.id = m.user_id
                    where m.tenant_id = t.id and exists (select 1 from membership_roles mr join roles r on r.id = mr.role_id
                                                          where mr.membership_id = m.id and r.key = 'owner')), '[]'::jsonb),
    'subscription', (select jsonb_build_object('plan_code', s.plan_code, 'status', s.status, 'trial_ends_at', s.trial_ends_at,
                     'current_period_end', s.current_period_end) from tenant_subscriptions s where s.tenant_id = t.id order by s.created_at desc limit 1),
    'entitlements', coalesce((select jsonb_agg(jsonb_build_object('feature_key', f.feature_key, 'enabled', f.enabled) order by f.feature_key)
                     from tenant_feature_entitlements f where f.tenant_id = t.id), '[]'::jsonb));
end $$;

revoke all on function platform_owner_invite_check(uuid, uuid), platform_log_owner_invite(uuid, uuid) from public, anon;
grant execute on function platform_owner_invite_check(uuid, uuid), platform_log_owner_invite(uuid, uuid) to authenticated;
