-- 162 Staff shifts, attendance and leave, first cut (TODO 8.11). No pay calculation: pension, PAYE and other deductions need an adviser first.
--
-- HR data is kept apart from access control: these tables name a user and a hotel, nothing in them grants any access.
--   staff_shifts      a planned shift for one person at one hotel (start and end in the hotel's own time, an optional label such as "Night desk").
--                     A person cannot have two overlapping shifts, and cannot be given a shift on a day of approved leave. A shift that ended
--                     more than 7 days ago cannot be removed.
--   staff_attendance  clock in and clock out, one open row at a time per person and hotel. A row made by clocking links to the shift it falls in.
--                     A manager can correct a row or add a missed one (with a note); the row then shows it was corrected. Never deleted.
--   staff_leave       a request for whole days (annual, sick, unpaid, other), approved or rejected by a manager, or cancelled. No overlap with the
--                     person's other live requests.
-- Who may do what (permission hr.manage, new: owner, general manager):
--   anyone who works at the hotel (an active membership with a role there)  clock in and out, ask for leave, cancel their own leave, read the
--     rota (everyone's shifts), their own attendance and leave;
--   hr.manage  make and remove shifts, correct attendance, decide leave, see everyone's attendance and leave, the people list, the hours report.
-- The hours report counts worked minutes by the day of clock-in, scheduled minutes by the day of the shift start, and approved leave days inside
-- the window. The app turns it into a CSV; a CSV is the whole of the "payroll export".
-- Plan flag staff_hr (enforced, Pro plan). With it off nothing is written; everything can still be read.
-- Not built: pay rates, overtime rules, shift swaps, geofenced clocking, leave balances and entitlements, public holidays.

insert into permissions (key) values ('hr.manage');
insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r, permissions p where p.key = 'hr.manage' and r.is_system and r.key in ('owner', 'general_manager');

create or replace function plan_enforced_flags() returns text[]
language sql immutable set search_path = public as $$
  select array['reports.export', 'online_payments', 'discounts', 'online_booking', 'guest_cancel', 'guest_changes', 'early_checkin',
               'housekeeping', 'maintenance', 'audit_log', 'branding', 'dynamic_pricing', 'sms_notifications', 'restaurant_pos', 'group_bookings', 'inventory',
               'guest_services', 'api_access', 'loyalty', 'staff_hr']
$$;
revoke all on function plan_enforced_flags() from public, anon;
update plans set features = (select array_agg(distinct k order by k) from unnest(features || array['staff_hr']) k) where code = 'pro';

create function hr_is_staff(p_property uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from tenant_memberships m
      join properties pr on pr.tenant_id = m.tenant_id and pr.id = p_property
      join membership_roles mr on mr.membership_id = m.id
     where m.user_id = p_user and m.status = 'active' and (mr.property_id is null or mr.property_id = p_property))
$$;
revoke all on function hr_is_staff(uuid, uuid) from public, anon;
grant execute on function hr_is_staff(uuid, uuid) to authenticated;

create table staff_shifts (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  property_id uuid not null,
  user_id     uuid not null references auth.users (id) on delete cascade,
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  label       text check (label is null or char_length(label) between 1 and 40),
  note        text check (note is null or char_length(note) <= 200),
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  foreign key (tenant_id, property_id) references properties (tenant_id, id),
  unique (tenant_id, property_id, id),
  check (ends_at > starts_at and ends_at - starts_at <= interval '16 hours')
);
create index staff_shifts_idx on staff_shifts (property_id, starts_at);
create index staff_shifts_user_idx on staff_shifts (user_id, starts_at);

create table staff_attendance (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  property_id uuid not null,
  user_id     uuid not null references auth.users (id) on delete cascade,
  clock_in_at  timestamptz not null,
  clock_out_at timestamptz,
  shift_id    uuid references staff_shifts (id) on delete set null,
  corrected   boolean not null default false,
  note        text check (note is null or char_length(note) <= 200),
  created_at  timestamptz not null default now(),
  foreign key (tenant_id, property_id) references properties (tenant_id, id),
  check (clock_out_at is null or (clock_out_at > clock_in_at and clock_out_at - clock_in_at <= interval '20 hours'))
);
create unique index staff_attendance_one_open on staff_attendance (property_id, user_id) where clock_out_at is null;
create index staff_attendance_idx on staff_attendance (property_id, clock_in_at);
create index staff_attendance_user_idx on staff_attendance (user_id, clock_in_at);

create table staff_leave (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  property_id uuid not null,
  user_id     uuid not null references auth.users (id) on delete cascade,
  start_date  date not null,
  end_date    date not null,
  kind        text not null check (kind in ('annual', 'sick', 'unpaid', 'other')),
  status      text not null default 'requested' check (status in ('requested', 'approved', 'rejected', 'cancelled')),
  note        text check (note is null or char_length(note) <= 200),
  decided_by  uuid references auth.users (id) on delete set null,
  decided_at  timestamptz,
  created_at  timestamptz not null default now(),
  foreign key (tenant_id, property_id) references properties (tenant_id, id),
  check (end_date >= start_date and end_date - start_date <= 60)
);
create index staff_leave_idx on staff_leave (property_id, start_date);
create index staff_leave_user_idx on staff_leave (user_id, start_date);

alter table staff_shifts enable row level security;
alter table staff_attendance enable row level security;
alter table staff_leave enable row level security;
create policy staff_shifts_select on staff_shifts for select to authenticated
  using (has_permission(property_id, 'hr.manage') or hr_is_staff(property_id, (select auth.uid())));
create policy staff_attendance_select on staff_attendance for select to authenticated
  using (has_permission(property_id, 'hr.manage') or user_id = (select auth.uid()));
create policy staff_leave_select on staff_leave for select to authenticated
  using (has_permission(property_id, 'hr.manage') or user_id = (select auth.uid()));
revoke all on staff_shifts, staff_attendance, staff_leave from anon, authenticated;
grant select on staff_shifts, staff_attendance, staff_leave to authenticated;

-- attendance is never deleted
create function hr_guard_attendance() returns trigger language plpgsql as $$
begin raise exception 'attendance is never deleted' using errcode = 'P0001'; end $$;
create trigger staff_attendance_guard before delete on staff_attendance for each row execute function hr_guard_attendance();

-- ---- helper -------------------------------------------------------------------------------------
-- 'self': any person who works at the hotel. 'manage': hr.manage. Both need the flag. No access is NOT_FOUND.
create function hr_require(p_property uuid, p_level text) returns uuid
language plpgsql stable security definer set search_path = public as $$
declare v_prop properties%rowtype; v_actor uuid := auth.uid();
begin
  select * into v_prop from properties where id = p_property;
  if not found or v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if p_level = 'manage' then
    v_actor := require_permission(p_property, 'hr.manage', 'NOT_FOUND');
  elsif not hr_is_staff(p_property, v_actor) then
    raise exception 'NOT_FOUND' using errcode = 'P0001';
  end if;
  if not tenant_feature_on(v_prop.tenant_id, 'staff_hr') then raise exception 'POLICY_VIOLATION: hr off' using errcode = 'P0001'; end if;
  return v_actor;
end $$;
revoke all on function hr_require(uuid, text) from public, anon, authenticated;

-- ---- shifts (hr.manage) ---------------------------------------------------------------------------
create function staff_shift_save(p_property uuid, p_shift uuid, p_user uuid, p_starts timestamp, p_ends timestamp, p_label text, p_note text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid; v_prop properties%rowtype; v_s timestamptz; v_e timestamptz; v_id uuid;
  v_label text := nullif(btrim(coalesce(p_label, '')), ''); v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  v_actor := hr_require(p_property, 'manage');
  select * into v_prop from properties where id = p_property;
  if p_user is null or not hr_is_staff(p_property, p_user) then raise exception 'POLICY_VIOLATION: person' using errcode = 'P0001'; end if;
  if p_starts is null or p_ends is null or p_ends <= p_starts then raise exception 'POLICY_VIOLATION: times' using errcode = 'P0001'; end if;
  v_s := p_starts at time zone v_prop.timezone; v_e := p_ends at time zone v_prop.timezone;
  if v_e - v_s > interval '16 hours' or v_s < now() - interval '30 days' or v_s > now() + interval '365 days' then raise exception 'POLICY_VIOLATION: times' using errcode = 'P0001'; end if;
  if char_length(coalesce(v_label, '')) > 40 or char_length(coalesce(v_note, '')) > 200 then raise exception 'POLICY_VIOLATION: text' using errcode = 'P0001'; end if;
  perform pg_advisory_xact_lock(hashtext('staff_shift:' || p_user::text));
  if exists (select 1 from staff_shifts x where x.user_id = p_user and x.id is distinct from p_shift and x.starts_at < v_e and x.ends_at > v_s) then
    raise exception 'POLICY_VIOLATION: overlap' using errcode = 'P0001';
  end if;
  if exists (select 1 from staff_leave l where l.user_id = p_user and l.status = 'approved'
                and (v_s at time zone v_prop.timezone)::date <= l.end_date and (v_e at time zone v_prop.timezone)::date >= l.start_date) then
    raise exception 'POLICY_VIOLATION: on leave' using errcode = 'P0001';
  end if;
  if p_shift is null then
    insert into staff_shifts (tenant_id, property_id, user_id, starts_at, ends_at, label, note, created_by)
    values (v_prop.tenant_id, p_property, p_user, v_s, v_e, v_label, v_note, v_actor) returning id into v_id;
  else
    update staff_shifts set user_id = p_user, starts_at = v_s, ends_at = v_e, label = v_label, note = v_note
     where id = p_shift and property_id = p_property returning id into v_id;
    if v_id is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  end if;
  perform write_audit(v_prop.tenant_id, p_property, v_actor, 'staff_shift.saved', 'staff_shift', v_id, null,
                      jsonb_build_object('user_id', p_user, 'starts_at', v_s, 'ends_at', v_e, 'label', v_label, 'created', p_shift is null));
  return jsonb_build_object('shift_id', v_id);
end $$;

create function staff_shift_remove(p_shift uuid) returns void
language plpgsql security definer set search_path = public as $$
declare s staff_shifts%rowtype; v_actor uuid;
begin
  select * into s from staff_shifts where id = p_shift;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := hr_require(s.property_id, 'manage');
  if s.ends_at < now() - interval '7 days' then raise exception 'INVALID_STATE: past' using errcode = 'P0001'; end if;
  delete from staff_shifts where id = p_shift;
  perform write_audit(s.tenant_id, s.property_id, v_actor, 'staff_shift.removed', 'staff_shift', s.id, null,
                      jsonb_build_object('user_id', s.user_id, 'starts_at', s.starts_at, 'ends_at', s.ends_at));
end $$;

-- ---- clocking (anyone who works here) ------------------------------------------------------------------
create function staff_clock_in(p_property uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_actor uuid; v_prop properties%rowtype; a staff_attendance%rowtype; v_shift uuid;
begin
  v_actor := hr_require(p_property, 'self');
  select * into v_prop from properties where id = p_property;
  perform pg_advisory_xact_lock(hashtext('staff_clock:' || v_actor::text || p_property::text));
  select * into a from staff_attendance where property_id = p_property and user_id = v_actor and clock_out_at is null;
  if found then return jsonb_build_object('attendance_id', a.id, 'already', true); end if;   -- a second tap changes nothing
  select id into v_shift from staff_shifts where user_id = v_actor and property_id = p_property
     and now() between starts_at - interval '2 hours' and ends_at order by abs(extract(epoch from (starts_at - now()))) limit 1;
  insert into staff_attendance (tenant_id, property_id, user_id, clock_in_at, shift_id) values (v_prop.tenant_id, p_property, v_actor, now(), v_shift) returning id into a.id;
  perform write_audit(v_prop.tenant_id, p_property, v_actor, 'staff_attendance.clock_in', 'staff_attendance', a.id, null, jsonb_build_object('shift_id', v_shift));
  return jsonb_build_object('attendance_id', a.id, 'already', false);
end $$;

create function staff_clock_out(p_property uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_actor uuid; v_prop properties%rowtype; a staff_attendance%rowtype; v_out timestamptz := now();
begin
  v_actor := hr_require(p_property, 'self');
  select * into v_prop from properties where id = p_property;
  select * into a from staff_attendance where property_id = p_property and user_id = v_actor and clock_out_at is null for update;
  if not found then raise exception 'INVALID_STATE: not clocked in' using errcode = 'P0001'; end if;
  -- a forgotten clock-out is capped at 20 hours so the row stays valid; a manager corrects it
  if v_out - a.clock_in_at > interval '20 hours' then v_out := a.clock_in_at + interval '20 hours'; end if;
  update staff_attendance set clock_out_at = v_out where id = a.id;
  perform write_audit(v_prop.tenant_id, p_property, v_actor, 'staff_attendance.clock_out', 'staff_attendance', a.id, null,
                      jsonb_build_object('minutes', extract(epoch from (v_out - a.clock_in_at))::int / 60));
  return jsonb_build_object('attendance_id', a.id, 'minutes', extract(epoch from (v_out - a.clock_in_at))::int / 60);
end $$;

-- A manager corrects a row or adds a missed one. Times are the hotel's own time.
create function staff_attendance_save(p_property uuid, p_attendance uuid, p_user uuid, p_in timestamp, p_out timestamp, p_note text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid; v_prop properties%rowtype; v_in timestamptz; v_out timestamptz; v_id uuid; old staff_attendance%rowtype; v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  v_actor := hr_require(p_property, 'manage');
  select * into v_prop from properties where id = p_property;
  if p_user is null or not hr_is_staff(p_property, p_user) then raise exception 'POLICY_VIOLATION: person' using errcode = 'P0001'; end if;
  if p_in is null then raise exception 'POLICY_VIOLATION: times' using errcode = 'P0001'; end if;
  v_in := p_in at time zone v_prop.timezone; v_out := p_out at time zone v_prop.timezone;
  if v_in > now() or (p_out is not null and (v_out <= v_in or v_out - v_in > interval '20 hours' or v_out > now())) then raise exception 'POLICY_VIOLATION: times' using errcode = 'P0001'; end if;
  if char_length(coalesce(v_note, '')) > 200 then raise exception 'POLICY_VIOLATION: text' using errcode = 'P0001'; end if;
  if p_attendance is null then
    begin
      insert into staff_attendance (tenant_id, property_id, user_id, clock_in_at, clock_out_at, corrected, note)
      values (v_prop.tenant_id, p_property, p_user, v_in, v_out, true, v_note) returning id into v_id;
    exception when unique_violation then raise exception 'POLICY_VIOLATION: open row' using errcode = 'P0001';
    end;
  else
    select * into old from staff_attendance where id = p_attendance and property_id = p_property for update;
    if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
    begin
      update staff_attendance set user_id = p_user, clock_in_at = v_in, clock_out_at = v_out, corrected = true, note = v_note where id = p_attendance returning id into v_id;
    exception when unique_violation then raise exception 'POLICY_VIOLATION: open row' using errcode = 'P0001';
    end;
  end if;
  perform write_audit(v_prop.tenant_id, p_property, v_actor, 'staff_attendance.corrected', 'staff_attendance', v_id, null,
                      jsonb_build_object('user_id', p_user, 'clock_in_at', v_in, 'clock_out_at', v_out, 'created', p_attendance is null,
                                         'was_in', old.clock_in_at, 'was_out', old.clock_out_at));
  return jsonb_build_object('attendance_id', v_id);
end $$;

-- ---- leave ----------------------------------------------------------------------------------------------------
create function staff_leave_request(p_property uuid, p_start date, p_end date, p_kind text, p_note text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_actor uuid; v_prop properties%rowtype; v_id uuid; v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  v_actor := hr_require(p_property, 'self');
  select * into v_prop from properties where id = p_property;
  if p_start is null or p_end is null or p_end < p_start or p_end - p_start > 60 then raise exception 'POLICY_VIOLATION: dates' using errcode = 'P0001'; end if;
  if p_start < property_today(p_property) or p_start > property_today(p_property) + 365 then raise exception 'POLICY_VIOLATION: dates' using errcode = 'P0001'; end if;
  if p_kind is null or p_kind not in ('annual', 'sick', 'unpaid', 'other') then raise exception 'POLICY_VIOLATION: kind' using errcode = 'P0001'; end if;
  if char_length(coalesce(v_note, '')) > 200 then raise exception 'POLICY_VIOLATION: text' using errcode = 'P0001'; end if;
  perform pg_advisory_xact_lock(hashtext('staff_leave:' || v_actor::text));
  if exists (select 1 from staff_leave l where l.user_id = v_actor and l.property_id = p_property and l.status in ('requested', 'approved') and l.start_date <= p_end and l.end_date >= p_start) then
    raise exception 'POLICY_VIOLATION: overlap' using errcode = 'P0001';
  end if;
  insert into staff_leave (tenant_id, property_id, user_id, start_date, end_date, kind, note) values (v_prop.tenant_id, p_property, v_actor, p_start, p_end, p_kind, v_note) returning id into v_id;
  perform write_audit(v_prop.tenant_id, p_property, v_actor, 'staff_leave.requested', 'staff_leave', v_id, null, jsonb_build_object('start', p_start, 'end', p_end, 'kind', p_kind));
  return jsonb_build_object('leave_id', v_id);
end $$;

create function staff_leave_decide(p_leave uuid, p_decision text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare l staff_leave%rowtype; v_actor uuid; v_to text;
begin
  select * into l from staff_leave where id = p_leave;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := hr_require(l.property_id, 'manage');
  if p_decision is null or p_decision not in ('approve', 'reject') then raise exception 'POLICY_VIOLATION: decision' using errcode = 'P0001'; end if;
  v_to := case p_decision when 'approve' then 'approved' else 'rejected' end;
  select * into l from staff_leave where id = p_leave for update;
  if l.status = v_to then return jsonb_build_object('status', l.status); end if;
  if l.status <> 'requested' then raise exception 'INVALID_STATE: %', l.status using errcode = 'P0001'; end if;
  if v_to = 'approved' and exists (select 1 from staff_shifts s join properties pr on pr.id = s.property_id
        where s.user_id = l.user_id and s.property_id = l.property_id
          and (s.starts_at at time zone pr.timezone)::date <= l.end_date and (s.ends_at at time zone pr.timezone)::date >= l.start_date) then
    raise exception 'POLICY_VIOLATION: has shifts' using errcode = 'P0001';   -- remove or move the shifts first
  end if;
  update staff_leave set status = v_to, decided_by = v_actor, decided_at = now() where id = l.id;
  perform write_audit(l.tenant_id, l.property_id, v_actor, 'staff_leave.' || v_to, 'staff_leave', l.id, null,
                      jsonb_build_object('user_id', l.user_id, 'start', l.start_date, 'end', l.end_date, 'own', l.user_id = v_actor));
  return jsonb_build_object('status', v_to);
end $$;

create function staff_leave_cancel(p_leave uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare l staff_leave%rowtype; v_actor uuid := auth.uid();
begin
  select * into l from staff_leave where id = p_leave;
  if not found or v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if l.user_id = v_actor then perform hr_require(l.property_id, 'self'); else perform hr_require(l.property_id, 'manage'); end if;
  select * into l from staff_leave where id = p_leave for update;
  if l.status = 'cancelled' then return jsonb_build_object('status', 'cancelled'); end if;
  if l.status not in ('requested', 'approved') or l.end_date < property_today(l.property_id) then raise exception 'INVALID_STATE: %', l.status using errcode = 'P0001'; end if;
  update staff_leave set status = 'cancelled', decided_by = v_actor, decided_at = now() where id = l.id;
  perform write_audit(l.tenant_id, l.property_id, v_actor, 'staff_leave.cancelled', 'staff_leave', l.id, null, jsonb_build_object('user_id', l.user_id, 'was', l.status));
  return jsonb_build_object('status', 'cancelled');
end $$;

-- ---- people (staff) and hours (hr.manage) -----------------------------------------------------------------------------
create function hr_people(p_property uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_manage boolean := has_permission(p_property, 'hr.manage');
begin
  -- the people who work at the hotel, for the rota: everyone who works here sees names; only managers see email addresses. Readable with the flag off.
  if not v_manage and not hr_is_staff(p_property, auth.uid()) then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('user_id', x.user_id, 'name', coalesce(nullif(x.full_name, ''), split_part(x.email, '@', 1)),
                                        'email', case when v_manage then x.email end) order by coalesce(nullif(x.full_name, ''), x.email))
      from (select distinct m.user_id, up.full_name, u.email
              from tenant_memberships m
              join properties pr on pr.id = p_property and pr.tenant_id = m.tenant_id
              join membership_roles mr on mr.membership_id = m.id and (mr.property_id is null or mr.property_id = p_property)
              join auth.users u on u.id = m.user_id
              left join user_profiles up on up.id = m.user_id
             where m.status = 'active') x), '[]'::jsonb);
end $$;

create function hr_hours_report(p_property uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_actor uuid; v_tz text;
begin
  v_actor := require_permission(p_property, 'hr.manage', 'NOT_FOUND');
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then raise exception 'POLICY_VIOLATION: dates' using errcode = 'P0001'; end if;
  select timezone into v_tz from properties where id = p_property;
  return jsonb_build_object('from', p_from, 'to', p_to, 'people', coalesce((
    select jsonb_agg(jsonb_build_object(
      'user_id', p ->> 'user_id', 'name', p ->> 'name', 'email', p ->> 'email',
      'worked_minutes', coalesce((select sum(extract(epoch from (a.clock_out_at - a.clock_in_at)) / 60)::int from staff_attendance a
                                   where a.property_id = p_property and a.user_id = (p ->> 'user_id')::uuid and a.clock_out_at is not null
                                     and (a.clock_in_at at time zone v_tz)::date between p_from and p_to), 0),
      'open_rows', (select count(*) from staff_attendance a where a.property_id = p_property and a.user_id = (p ->> 'user_id')::uuid and a.clock_out_at is null
                       and (a.clock_in_at at time zone v_tz)::date between p_from and p_to),
      'corrected_rows', (select count(*) from staff_attendance a where a.property_id = p_property and a.user_id = (p ->> 'user_id')::uuid and a.corrected
                       and (a.clock_in_at at time zone v_tz)::date between p_from and p_to),
      'scheduled_minutes', coalesce((select sum(extract(epoch from (s.ends_at - s.starts_at)) / 60)::int from staff_shifts s
                                      where s.property_id = p_property and s.user_id = (p ->> 'user_id')::uuid
                                        and (s.starts_at at time zone v_tz)::date between p_from and p_to), 0),
      'leave_days', coalesce((select jsonb_object_agg(k.kind, k.days) from (
                        select l.kind, sum(least(l.end_date, p_to) - greatest(l.start_date, p_from) + 1)::int as days from staff_leave l
                         where l.property_id = p_property and l.user_id = (p ->> 'user_id')::uuid and l.status = 'approved' and l.start_date <= p_to and l.end_date >= p_from
                         group by l.kind) k), '{}'::jsonb)
    ) order by p ->> 'name') from jsonb_array_elements(hr_people(p_property)) p), '[]'::jsonb));
end $$;

revoke all on function staff_shift_save(uuid, uuid, uuid, timestamp, timestamp, text, text), staff_shift_remove(uuid), staff_clock_in(uuid), staff_clock_out(uuid),
  staff_attendance_save(uuid, uuid, uuid, timestamp, timestamp, text), staff_leave_request(uuid, date, date, text, text), staff_leave_decide(uuid, text),
  staff_leave_cancel(uuid), hr_people(uuid), hr_hours_report(uuid, date, date) from public, anon;
grant execute on function staff_shift_save(uuid, uuid, uuid, timestamp, timestamp, text, text), staff_shift_remove(uuid), staff_clock_in(uuid), staff_clock_out(uuid),
  staff_attendance_save(uuid, uuid, uuid, timestamp, timestamp, text), staff_leave_request(uuid, date, date, text, text), staff_leave_decide(uuid, text),
  staff_leave_cancel(uuid), hr_people(uuid), hr_hours_report(uuid, date, date) to authenticated;
