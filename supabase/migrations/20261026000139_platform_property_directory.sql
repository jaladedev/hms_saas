-- 139 The platform property directory: every property of every hotel group in one list, for platform admin and support. The hotels
-- overview (migration 050) only counts properties per group; this names them. Read only, and the same boundary as the rest of /platform:
-- names, place, time zone, currency, status and the guest-site host. No rooms, reservations, guests or payments.

create function platform_list_properties() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform platform_require('support');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', p.id, 'name', p.name, 'code', p.code, 'city', p.city, 'state', p.state, 'timezone', p.timezone,
      'currency', p.currency, 'status', p.status, 'created_at', p.created_at,
      'tenant_id', t.id, 'tenant_name', t.name, 'tenant_status', t.status,
      'host', (select d.host from tenant_domains d where d.property_id = p.id order by d.is_primary desc, d.host limit 1)
    ) order by t.name, p.name)
    from properties p join tenants t on t.id = p.tenant_id), '[]'::jsonb);
end $$;

revoke all on function platform_list_properties() from public, anon;
grant execute on function platform_list_properties() to authenticated;
