-- 109 What stands between a hotel and its first guest booking, for platform support ("why can't this hotel take bookings?").
--
-- platform_hotel_readiness(tenant): platform support or admin (anyone else NOT_FOUND; an unknown group is NOT_FOUND too). Counts and
-- yes/no facts only, never a name, guest, reservation, payment or secret: the hotel group's status, whether the group's online_booking
-- and online_payments flags let guests through (no row means on), whether a payment account is active (status only, no reference),
-- how many domains are verified, and per property: its status, public active room types, rooms still in use, an active default rate
-- plan, tax rules, policy versions and verified domains pointing at it. The app turns these into plain checks (lib/platform/readiness.ts).
-- Read only; nothing here changes a hotel.

create function platform_hotel_readiness(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare t tenants%rowtype;
begin
  perform platform_require('support');
  select * into t from tenants where id = p_tenant;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  return jsonb_build_object(
    'tenant_status', t.status,
    'online_booking', coalesce((select f.enabled from tenant_feature_entitlements f where f.tenant_id = t.id and f.feature_key = 'online_booking'), true),
    'online_payments', coalesce((select f.enabled from tenant_feature_entitlements f where f.tenant_id = t.id and f.feature_key = 'online_payments'), true),
    'active_payment_accounts', (select count(*) from payment_provider_accounts a where a.tenant_id = t.id and a.status = 'active'),
    'domains', (select count(*) from tenant_domains d where d.tenant_id = t.id),
    'domains_verified', (select count(*) from tenant_domains d where d.tenant_id = t.id and d.verified_at is not null),
    'properties', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'name', p.name, 'status', p.status,
        'room_types', (select count(*) from room_types r where r.property_id = p.id and r.status = 'active' and r.is_public),
        'rooms', (select count(*) from rooms r where r.property_id = p.id and r.operational_status <> 'retired'),
        'default_rate_plan', exists (select 1 from rate_plans rp where rp.property_id = p.id and rp.is_default and rp.status = 'active'),
        'tax_rules', (select count(*) from tax_rules x where x.property_id = p.id and x.status = 'active'),
        'policy_versions', (select count(*) from property_policies pp where pp.property_id = p.id),
        'domains_verified', (select count(*) from tenant_domains d where d.property_id = p.id and d.verified_at is not null)
      ) order by p.name) from properties p where p.tenant_id = t.id), '[]'::jsonb));
end $$;
revoke all on function platform_hotel_readiness(uuid) from public, anon;
grant execute on function platform_hotel_readiness(uuid) to authenticated;
