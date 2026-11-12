-- 111 Access requests: how platform staff get to look at a hotel's setup (prototype "Support Workspace": Request Impersonation).
--
-- There is no login-as. Nobody on the platform side ever acts as a hotel user or sees a guest, reservation, payment or secret. What an
-- approved request opens is a read-only view of the hotel group's *setup*, for a limited time, and everything about it is on record.
--
-- The rules:
--   * platform_request_access(tenant, reason, hours, ticket)   support or admin. A reason of 10 to 500 characters is required.
--       hours is 1, 4 or 24 (the longest a request can ever run). One live request (pending or approved and not ended) per person
--       and hotel group at a time. The ticket is optional and must belong to the same group.
--   * platform_decide_access(request, decision, note)          admin, and never the person who asked: approved or denied. Only a
--       pending request that is under 24 hours old. Approving starts the clock: it runs `hours` from that moment.
--   * platform_end_access(request)                             the requester (a pending request is withdrawn, an approved one is
--       ended early) or any admin (revokes). An ended request cannot be reopened; ask again.
--   * platform_list_access(tenant, status)                     an admin sees every request; support sees their own. Newest first,
--       at most 200. Status shown is the effective one: pending past 24 hours and approved past its end read `expired`.
--   * platform_access_view(request)                            only the person who asked, only while approved and not ended. Returns
--       the setup of the group (see below) and counts the view. Anything else is NOT_FOUND.
--
-- What the view contains, and does not: the group's status; per hotel its name, status and look; room types (name, code, public,
-- status, occupancy, base rate); rate plans (name, code, default, status, the cancellation and payment policy settings); tax rules
-- (name, basis, rate, status); the policy version in force; the group's feature switches; domains (host, verified); payment account
-- status only; and how many active people hold each role (no names or emails). It holds no guest, reservation, payment, invoice,
-- email, staff identity or secret.
--
-- Both the request and each decision, view, and end are audited by the audit trigger (actor auth.uid()). The table is closed to logins.

create table access_requests (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id),
  requested_by   uuid not null,
  reason         text not null check (char_length(reason) between 10 and 500 and reason = btrim(reason)),
  hours          smallint not null check (hours in (1, 4, 24)),
  ticket_id      uuid references support_tickets(id),
  status         text not null default 'pending' check (status in ('pending', 'approved', 'denied', 'cancelled', 'revoked')),
  requested_at   timestamptz not null default now(),
  decided_by     uuid,
  decided_at     timestamptz,
  decision_note  text check (decision_note is null or char_length(decision_note) between 1 and 300),
  approved_until timestamptz,
  ended_at       timestamptz,
  views          integer not null default 0,
  last_viewed_at timestamptz,
  check (status <> 'approved' or (approved_until is not null and ended_at is null))
);
create index access_requests_tenant on access_requests (tenant_id, requested_at desc);
create index access_requests_user on access_requests (requested_by, requested_at desc);
create unique index access_requests_one_live on access_requests (requested_by, tenant_id) where status in ('pending', 'approved');

alter table access_requests enable row level security;
revoke all on access_requests from public, anon, authenticated;
create trigger access_requests_audit after insert or update or delete on access_requests
  for each row execute function audit_config_row('platform_access', 'reason,hours,ticket_id,status,decided_by,decision_note,approved_until,ended_at,views');

-- The status a person should see: stale pending and elapsed approved requests read as expired.
create function access_effective_status(r access_requests) returns text
language sql immutable set search_path = public, pg_temp as $$
  select case
    when r.status = 'pending' and r.requested_at < now() - interval '24 hours' then 'expired'
    when r.status = 'approved' and r.approved_until <= now() then 'expired'
    else r.status end
$$;
revoke all on function access_effective_status(access_requests) from public, anon, authenticated;

create function platform_request_access(p_tenant uuid, p_reason text, p_hours integer, p_ticket uuid default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_uid uuid := platform_require('support'); v_reason text := btrim(coalesce(p_reason, '')); v_id uuid;
begin
  perform 1 from tenants where id = p_tenant;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if char_length(v_reason) not between 10 and 500 then raise exception 'POLICY_VIOLATION: access reason' using errcode = 'P0001'; end if;
  if p_hours is null or p_hours not in (1, 4, 24) then raise exception 'POLICY_VIOLATION: access hours' using errcode = 'P0001'; end if;
  if p_ticket is not null and not exists (select 1 from support_tickets where id = p_ticket and tenant_id = p_tenant) then
    raise exception 'POLICY_VIOLATION: access ticket' using errcode = 'P0001';
  end if;
  -- an ended window (elapsed, or stale and never decided) does not block a new request
  update access_requests set status = 'cancelled', ended_at = now()
   where requested_by = v_uid and tenant_id = p_tenant and status = 'pending' and requested_at < now() - interval '24 hours';
  update access_requests set status = 'revoked', ended_at = now()
   where requested_by = v_uid and tenant_id = p_tenant and status = 'approved' and approved_until <= now();
  if exists (select 1 from access_requests where requested_by = v_uid and tenant_id = p_tenant and status in ('pending', 'approved')) then
    raise exception 'CONFLICT: access open' using errcode = 'P0001';
  end if;
  insert into access_requests (tenant_id, requested_by, reason, hours, ticket_id) values (p_tenant, v_uid, v_reason, p_hours, p_ticket)
    returning id into v_id;
  return jsonb_build_object('id', v_id);
end $$;

create function platform_decide_access(p_request uuid, p_decision text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := platform_require('admin'); r access_requests%rowtype; v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  select * into r from access_requests where id = p_request for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if p_decision is null or p_decision not in ('approved', 'denied') then raise exception 'POLICY_VIOLATION: access decision' using errcode = 'P0001'; end if;
  if v_note is not null and char_length(v_note) > 300 then raise exception 'POLICY_VIOLATION: access note' using errcode = 'P0001'; end if;
  if r.requested_by = v_uid then raise exception 'POLICY_VIOLATION: access own request' using errcode = 'P0001'; end if;
  if access_effective_status(r) <> 'pending' then raise exception 'CONFLICT: access state' using errcode = 'P0001'; end if;
  update access_requests set status = p_decision, decided_by = v_uid, decided_at = now(), decision_note = v_note,
         approved_until = case when p_decision = 'approved' then now() + make_interval(hours => r.hours) end
   where id = r.id;
  return jsonb_build_object('status', p_decision);
end $$;

create function platform_end_access(p_request uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_uid uuid := platform_require('support'); r access_requests%rowtype; v_admin boolean := (platform_level() = 'admin');
begin
  select * into r from access_requests where id = p_request for update;
  if not found or (r.requested_by <> v_uid and not v_admin) then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if access_effective_status(r) not in ('pending', 'approved') then raise exception 'CONFLICT: access state' using errcode = 'P0001'; end if;
  update access_requests set status = case when r.status = 'pending' then 'cancelled' else 'revoked' end, ended_at = now(),
         approved_until = case when r.status = 'approved' then approved_until end
   where id = r.id;
  return jsonb_build_object('status', case when r.status = 'pending' then 'cancelled' else 'revoked' end);
end $$;

create function platform_list_access(p_tenant uuid default null, p_status text default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := platform_require('support'); v_admin boolean := (platform_level() = 'admin');
  v_status text := nullif(lower(btrim(coalesce(p_status, ''))), '');
begin
  if v_status is not null and v_status not in ('pending', 'approved', 'denied', 'cancelled', 'revoked', 'expired') then
    raise exception 'POLICY_VIOLATION: access status' using errcode = 'P0001';
  end if;
  return coalesce((
    select jsonb_agg(x.j order by x.requested_at desc, x.id) from (
      select a.requested_at, a.id, jsonb_build_object(
        'id', a.id, 'tenant_id', a.tenant_id, 'tenant_name', t.name, 'reason', a.reason, 'hours', a.hours,
        'ticket_number', (select k.number from support_tickets k where k.id = a.ticket_id),
        'status', access_effective_status(a), 'requested_at', a.requested_at,
        'requested_by_email', (select u.email from auth.users u where u.id = a.requested_by),
        'decided_by_email', (select u.email from auth.users u where u.id = a.decided_by),
        'decided_at', a.decided_at, 'decision_note', a.decision_note, 'approved_until', a.approved_until,
        'views', a.views, 'last_viewed_at', a.last_viewed_at, 'mine', a.requested_by = v_uid) as j
      from access_requests a join tenants t on t.id = a.tenant_id
      where (v_admin or a.requested_by = v_uid) and (p_tenant is null or a.tenant_id = p_tenant)
        and (v_status is null or access_effective_status(a) = v_status)
      order by a.requested_at desc, a.id limit 200) x), '[]'::jsonb);
end $$;

create function platform_access_view(p_request uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_uid uuid := platform_require('support'); r access_requests%rowtype; t tenants%rowtype;
begin
  select * into r from access_requests where id = p_request for update;
  if not found or r.requested_by <> v_uid or access_effective_status(r) <> 'approved' then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  select * into t from tenants where id = r.tenant_id;
  update access_requests set views = views + 1, last_viewed_at = now() where id = r.id;
  return jsonb_build_object(
    'tenant_name', t.name, 'tenant_status', t.status, 'approved_until', r.approved_until,
    'features', coalesce((select jsonb_agg(jsonb_build_object('key', f.feature_key, 'enabled', f.enabled) order by f.feature_key)
                            from tenant_feature_entitlements f where f.tenant_id = t.id), '[]'::jsonb),
    'domains', coalesce((select jsonb_agg(jsonb_build_object('host', d.host, 'verified', d.verified_at is not null) order by d.host)
                           from tenant_domains d where d.tenant_id = t.id), '[]'::jsonb),
    'payment_accounts', coalesce((select jsonb_agg(a.status order by a.status) from payment_provider_accounts a where a.tenant_id = t.id), '[]'::jsonb),
    'roles', coalesce((select jsonb_agg(jsonb_build_object('role', x.key, 'people', x.n) order by x.key) from (
                         select ro.key, count(distinct m.user_id) as n
                           from tenant_memberships m join membership_roles mr on mr.membership_id = m.id join roles ro on ro.id = mr.role_id
                          where m.tenant_id = t.id and m.status = 'active' group by ro.key) x), '[]'::jsonb),
    'properties', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', p.name, 'status', p.status,
        'room_types', coalesce((select jsonb_agg(jsonb_build_object('name', r2.name, 'code', r2.code, 'public', r2.is_public, 'status', r2.status,
                                   'max_occupancy', r2.max_occupancy, 'base_rate_minor', r2.base_rate_minor, 'currency', r2.currency) order by r2.name)
                                  from room_types r2 where r2.property_id = p.id), '[]'::jsonb),
        'rate_plans', coalesce((select jsonb_agg(jsonb_build_object('name', rp.name, 'code', rp.code, 'default', rp.is_default, 'status', rp.status,
                                   'cancellation_policy', rp.cancellation_policy, 'payment_policy', rp.payment_policy) order by rp.name)
                                  from rate_plans rp where rp.property_id = p.id), '[]'::jsonb),
        'tax_rules', coalesce((select jsonb_agg(jsonb_build_object('name', x.name, 'basis', x.basis, 'rate', x.rate_value, 'status', x.status) order by x.sequence)
                                 from tax_rules x where x.property_id = p.id), '[]'::jsonb),
        'policy_version', (select max(pp.version) from property_policies pp where pp.property_id = p.id)
      ) order by p.name) from properties p where p.tenant_id = t.id), '[]'::jsonb));
end $$;

revoke all on function platform_request_access(uuid, text, integer, uuid), platform_decide_access(uuid, text, text), platform_end_access(uuid),
  platform_list_access(uuid, text), platform_access_view(uuid) from public, anon;
grant execute on function platform_request_access(uuid, text, integer, uuid), platform_decide_access(uuid, text, text), platform_end_access(uuid),
  platform_list_access(uuid, text), platform_access_view(uuid) to authenticated;
