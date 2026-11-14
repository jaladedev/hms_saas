-- 126 The platform's own audit trail in one read (prototype "Platform Audit Log").
--
-- platform_audit_events(tenant, search, from, to, before_at, before_id, limit): platform support or admin (anyone else NOT_FOUND).
-- A platform event is a row of audit_logs where the action starts with 'platform.', the entity type starts with 'platform_' (invoices,
-- tickets, notes, access requests), or the actor is a platform login. A hotel's own staff work stays on that hotel's setup history.
-- Returns {events, has_more}, newest first, at most 100 a page (default 50), paged by (created_at, id) with before_at and before_id.
-- Filters: one hotel group, text found in the action or entity type (wildcards in it are escaped), a UTC date range.
-- Each event: when, action, entity_type, entity_id, hotel group id and name, who (the name or email of a platform login; a hotel's own
-- person is shown only as 'Hotel staff') and `fields`: the names of the columns a change touched. The values themselves, and any ticket,
-- note or reason text, are NOT returned: this is a list of who did what, and the item's own page shows the rest.
-- Read only.

create function platform_audit_events(
  p_tenant uuid default null, p_search text default null, p_from date default null, p_to date default null,
  p_before_at timestamptz default null, p_before_id uuid default null, p_limit integer default 50
) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_pat text;
  v_rows jsonb;
  v_n integer;
begin
  perform platform_require('support');
  if v_search is not null then
    v_pat := '%' || replace(replace(replace(left(v_search, 60), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;
  with picked as (
    select a.* from audit_logs a
     where (a.action like 'platform.%' or a.entity_type like 'platform\_%' or a.actor_user_id in (select user_id from platform_admins))
       and (p_tenant is null or a.tenant_id = p_tenant)
       and (v_pat is null or a.action ilike v_pat or a.entity_type ilike v_pat)
       and (p_from is null or a.created_at >= p_from::timestamptz)
       and (p_to is null or a.created_at < (p_to + 1)::timestamptz)
       and (p_before_at is null or (a.created_at, a.id) < (p_before_at, coalesce(p_before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)))
     order by a.created_at desc, a.id desc
     limit v_limit + 1
  )
  select count(*), coalesce(jsonb_agg(e order by e_at desc, e_id desc), '[]'::jsonb) into v_n, v_rows from (
    select p.created_at as e_at, p.id as e_id, jsonb_build_object(
      'id', p.id, 'at', p.created_at, 'action', p.action, 'entity_type', p.entity_type, 'entity_id', p.entity_id,
      'tenant_id', p.tenant_id, 'tenant_name', (select t.name from tenants t where t.id = p.tenant_id),
      'actor', case when p.actor_user_id is null then null
                    when exists (select 1 from platform_admins pa where pa.user_id = p.actor_user_id)
                      then (select coalesce(nullif(btrim(up.full_name), ''), nullif(btrim(u.email), ''), 'Platform')
                              from auth.users u left join user_profiles up on up.id = u.id where u.id = p.actor_user_id)
                    else 'Hotel staff' end,
      'fields', coalesce((select jsonb_agg(k order by k) from jsonb_object_keys(case when jsonb_typeof(p.metadata -> 'changed') = 'object' then p.metadata -> 'changed' else '{}'::jsonb end) k), '[]'::jsonb)
    ) as e from picked p
  ) x;
  -- one extra row was read only to know whether there is a next page
  return jsonb_build_object(
    'events', (select coalesce(jsonb_agg(el), '[]'::jsonb) from (select el from jsonb_array_elements(v_rows) with ordinality t(el, n) where n <= v_limit order by n) y),
    'has_more', v_n > v_limit);
end $$;
revoke all on function platform_audit_events(uuid, text, date, date, timestamptz, uuid, integer) from public, anon;
grant execute on function platform_audit_events(uuid, text, date, date, timestamptz, uuid, integer) to authenticated;
