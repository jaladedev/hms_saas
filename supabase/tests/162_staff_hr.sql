-- Staff shifts, attendance and leave (migration 162). Reuses t_as / t_sys / t_expect (05).
-- Users: aa01 owner A (hr.manage), aa02 housekeeping A, aa04 front desk A, aa05 accountant A, bb01 owner of Hotel B.
\set ON_ERROR_STOP on

create table t162_ctx (label text primary key, val text not null);
create function t162(p_label text) returns uuid language sql stable as $$ select val::uuid from t162_ctx where label = p_label $$;
create function t162_today() returns date language sql stable as $$ select property_today('00000000-0000-0000-0000-0000000000a2') $$;
create function t162_local(p_plus interval) returns timestamp language sql stable as $$
  select (now() at time zone (select timezone from properties where id = '00000000-0000-0000-0000-0000000000a2')) + p_plus $$;

-- 1. Grants and flag
do $$ declare v_n integer; begin
  perform t_sys();
  select count(*) into v_n from role_permissions rp join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id
   where p.key = 'hr.manage' and r.is_system and r.key in ('owner', 'general_manager');
  if v_n <> 2 then raise exception 'FAIL hr.manage grants (%)', v_n; end if;
  if exists (select 1 from role_permissions rp join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id
              where p.key = 'hr.manage' and r.is_system and r.key not in ('owner', 'general_manager')) then raise exception 'FAIL hr.manage held by another system role'; end if;
  if not ('staff_hr' = any (plan_enforced_flags())) then raise exception 'FAIL staff_hr is not an enforced flag'; end if;
  if not (select 'staff_hr' = any (features) from plans where code = 'pro') or (select 'staff_hr' = any (features) from plans where code = 'starter') then raise exception 'FAIL plan features'; end if;
  raise notice 'PASS grants: hr.manage for owner and general manager only; staff_hr is enforced and on the pro plan only';
end $$;

-- 2. Shifts
do $$ declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_d date := t162_today(); v_id uuid; begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select staff_shift_save(%L, null, %L, %L, %L, ''Desk'', null)', v_p, '00000000-0000-0000-0000-00000000aa04', v_d + 1 + time '08:00', v_d + 1 + time '16:00'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select staff_shift_save(%L, null, %L, %L, %L, ''Desk'', null)', v_p, '00000000-0000-0000-0000-00000000aa04', v_d + 1 + time '08:00', v_d + 1 + time '16:00'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select staff_shift_save(%L, null, %L, %L, %L, ''Desk'', null)', v_p, '00000000-0000-0000-0000-00000000bb01', v_d + 1 + time '08:00', v_d + 1 + time '16:00'), 'POLICY_VIOLATION: person');
  perform t_expect(format('select staff_shift_save(%L, null, %L, %L, %L, ''Desk'', null)', v_p, '00000000-0000-0000-0000-00000000aa04', v_d + 1 + time '16:00', v_d + 1 + time '08:00'), 'POLICY_VIOLATION: times');
  perform t_expect(format('select staff_shift_save(%L, null, %L, %L, %L, ''Desk'', null)', v_p, '00000000-0000-0000-0000-00000000aa04', v_d + 1 + time '02:00', v_d + 1 + time '20:00'), 'POLICY_VIOLATION: times');
  perform t_expect(format('select staff_shift_save(%L, null, %L, %L, %L, ''Desk'', null)', v_p, '00000000-0000-0000-0000-00000000aa04', v_d - 90 + time '08:00', v_d - 90 + time '16:00'), 'POLICY_VIOLATION: times');
  perform t_expect(format('select staff_shift_save(%L, null, %L, %L, %L, %L, null)', v_p, '00000000-0000-0000-0000-00000000aa04', v_d + 1 + time '08:00', v_d + 1 + time '16:00', repeat('x', 41)), 'POLICY_VIOLATION: text');
  v_id := staff_shift_save(v_p, null, '00000000-0000-0000-0000-00000000aa04', v_d + 1 + time '08:00', v_d + 1 + time '16:00', 'Day desk', null) ->> 'shift_id';
  insert into t162_ctx values ('tomorrow', v_id::text);
  perform t_expect(format('select staff_shift_save(%L, null, %L, %L, %L, null, null)', v_p, '00000000-0000-0000-0000-00000000aa04', v_d + 1 + time '15:00', v_d + 1 + time '20:00'), 'POLICY_VIOLATION: overlap');
  -- an edit of the shift itself does not clash with itself
  perform staff_shift_save(v_p, v_id, '00000000-0000-0000-0000-00000000aa04', v_d + 1 + time '09:00', v_d + 1 + time '17:00', 'Day desk', 'Cover for Ada');
  if (select starts_at from staff_shifts where id = v_id) is null or (select note from staff_shifts where id = v_id) <> 'Cover for Ada' then raise exception 'FAIL shift edit'; end if;
  if (select count(*) from audit_logs where action = 'staff_shift.saved' and entity_id = v_id) <> 2 then raise exception 'FAIL shift audit'; end if;
  -- the rota is readable by staff of the hotel, not by another hotel
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  if (select count(*) from staff_shifts where id = v_id) <> 1 then raise exception 'FAIL housekeeping reads the rota'; end if;
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  if (select count(*) from staff_shifts) <> 0 then raise exception 'FAIL other hotel reads the rota'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select staff_shift_remove(%L)', v_id), 'NOT_FOUND');
  raise notice 'PASS shifts: manager only; person must work here; no overlap, 16 hours at most; edit and audit; rota readable by staff of this hotel only';
end $$;

-- 3a. Clock in: links the shift it falls in, a second tap changes nothing
do $$ declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_sh uuid; r jsonb; begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  v_sh := staff_shift_save(v_p, null, '00000000-0000-0000-0000-00000000aa04', t162_local(interval '-1 hour'), t162_local(interval '7 hours'), 'Now desk', null) ->> 'shift_id';
  insert into t162_ctx values ('now', v_sh::text);
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select staff_clock_in(%L)', v_p), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r := staff_clock_in(v_p);
  if (r ->> 'already')::boolean then raise exception 'FAIL first clock in'; end if;
  insert into t162_ctx values ('att', r ->> 'attendance_id');
  if staff_clock_in(v_p) ->> 'attendance_id' <> r ->> 'attendance_id' or not (staff_clock_in(v_p) ->> 'already')::boolean then raise exception 'FAIL second tap'; end if;
  if (select shift_id from staff_attendance where id = t162('att')) is distinct from v_sh then raise exception 'FAIL shift link'; end if;
  if (select count(*) from staff_attendance where property_id = v_p and user_id = '00000000-0000-0000-0000-00000000aa04' and clock_out_at is null) <> 1 then raise exception 'FAIL one open row'; end if;
  raise notice 'PASS clock in: staff only, linked to the shift it falls in, a second tap returns the same open row';
end $$;

-- 3b. Clock out, and who can see the rows
do $$ declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; r jsonb; begin
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform t_expect(format('select staff_clock_out(%L)', v_p), 'INVALID_STATE');
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r := staff_clock_out(v_p);
  if (select clock_out_at from staff_attendance where id = t162('att')) is null then raise exception 'FAIL clock out'; end if;
  perform t_expect(format('select staff_clock_out(%L)', v_p), 'INVALID_STATE');
  if (select count(*) from staff_attendance) <> 1 then raise exception 'FAIL own rows'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  if (select count(*) from staff_attendance) <> 0 then raise exception 'FAIL housekeeping sees attendance'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  if (select count(*) from staff_attendance where id = t162('att')) <> 1 then raise exception 'FAIL manager sees attendance'; end if;
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  if (select count(*) from staff_attendance) <> 0 then raise exception 'FAIL other hotel sees attendance'; end if;
  raise notice 'PASS clock out: needs an open row; people see their own attendance, managers see all, other hotels none';
end $$;

-- 4. Corrections, never deleted
do $$ declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_d date := t162_today(); v_id uuid; begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select staff_attendance_save(%L, null, %L, %L, %L, ''x'')', v_p, '00000000-0000-0000-0000-00000000aa02', v_d - 1 + time '09:00', v_d - 1 + time '17:00'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select staff_attendance_save(%L, null, %L, %L, %L, ''x'')', v_p, '00000000-0000-0000-0000-00000000bb01', v_d - 1 + time '09:00', v_d - 1 + time '17:00'), 'POLICY_VIOLATION: person');
  perform t_expect(format('select staff_attendance_save(%L, null, %L, %L, %L, ''x'')', v_p, '00000000-0000-0000-0000-00000000aa02', v_d + 5 + time '09:00', null), 'POLICY_VIOLATION: times');
  perform t_expect(format('select staff_attendance_save(%L, null, %L, %L, %L, ''x'')', v_p, '00000000-0000-0000-0000-00000000aa02', v_d - 1 + time '17:00', v_d - 1 + time '09:00'), 'POLICY_VIOLATION: times');
  v_id := staff_attendance_save(v_p, null, '00000000-0000-0000-0000-00000000aa02', v_d - 1 + time '09:00', v_d - 1 + time '17:00', 'Forgot to clock in') ->> 'attendance_id';
  if not (select corrected from staff_attendance where id = v_id) then raise exception 'FAIL corrected flag'; end if;
  insert into t162_ctx values ('missed', v_id::text);
  perform staff_attendance_save(v_p, v_id, '00000000-0000-0000-0000-00000000aa02', v_d - 1 + time '09:00', v_d - 1 + time '18:00', 'Left at six');
  if (select clock_out_at - clock_in_at from staff_attendance where id = v_id) <> interval '9 hours' then raise exception 'FAIL correction'; end if;
  if (select count(*) from audit_logs where action = 'staff_attendance.corrected' and entity_id = v_id) <> 2 then raise exception 'FAIL correction audit'; end if;
  -- only one open row per person
  perform staff_attendance_save(v_p, null, '00000000-0000-0000-0000-00000000aa05', t162_local(interval '-2 hours'), null, 'Open');
  perform t_expect(format('select staff_attendance_save(%L, null, %L, %L, null, ''again'')', v_p, '00000000-0000-0000-0000-00000000aa05', t162_local(interval '-1 hour')), 'POLICY_VIOLATION: open row');
  perform t_sys();
  perform t_expect('delete from staff_attendance', 'attendance is never deleted');
  raise notice 'PASS corrections: manager only, marked corrected, audited with the old times, one open row per person, never deleted';
end $$;

-- 5. Leave
do $$ declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_d date := t162_today(); v_id uuid; v_id2 uuid; begin
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select staff_leave_request(%L, %L, %L, ''annual'', null)', v_p, v_d + 10, v_d + 12), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select staff_leave_request(%L, %L, %L, ''annual'', null)', v_p, v_d - 1, v_d + 2), 'POLICY_VIOLATION: dates');
  perform t_expect(format('select staff_leave_request(%L, %L, %L, ''annual'', null)', v_p, v_d + 12, v_d + 10), 'POLICY_VIOLATION: dates');
  perform t_expect(format('select staff_leave_request(%L, %L, %L, ''holiday'', null)', v_p, v_d + 10, v_d + 12), 'POLICY_VIOLATION: kind');
  v_id := staff_leave_request(v_p, v_d + 10, v_d + 12, 'annual', 'Family') ->> 'leave_id';
  insert into t162_ctx values ('leave', v_id::text);
  perform t_expect(format('select staff_leave_request(%L, %L, %L, ''sick'', null)', v_p, v_d + 12, v_d + 14), 'POLICY_VIOLATION: overlap');
  perform t_expect(format('select staff_leave_decide(%L, ''approve'')', v_id), 'NOT_FOUND');                 -- nobody approves their own as a non-manager
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform t_expect(format('select staff_leave_decide(%L, ''approve'')', v_id), 'NOT_FOUND');
  perform t_expect(format('select staff_leave_cancel(%L)', v_id), 'NOT_FOUND');                              -- not theirs, not a manager
  if (select count(*) from staff_leave) <> 0 then raise exception 'FAIL housekeeping sees leave'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select staff_leave_decide(%L, ''maybe'')', v_id), 'POLICY_VIOLATION: decision');
  perform staff_leave_decide(v_id, 'approve');
  if staff_leave_decide(v_id, 'approve') ->> 'status' <> 'approved' then raise exception 'FAIL approve twice'; end if;
  perform t_expect(format('select staff_leave_decide(%L, ''reject'')', v_id), 'INVALID_STATE');
  if (select count(*) from audit_logs where action = 'staff_leave.approved' and entity_id = v_id) <> 1 then raise exception 'FAIL leave audit'; end if;
  -- a shift cannot be placed on a day of approved leave
  perform t_expect(format('select staff_shift_save(%L, null, %L, %L, %L, null, null)', v_p, '00000000-0000-0000-0000-00000000aa04', v_d + 11 + time '08:00', v_d + 11 + time '16:00'), 'POLICY_VIOLATION: on leave');
  -- leave over a day that holds a shift cannot be approved until the shift is moved
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  v_id2 := staff_leave_request(v_p, v_d + 1, v_d + 1, 'sick', null) ->> 'leave_id';
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select staff_leave_decide(%L, ''approve'')', v_id2), 'POLICY_VIOLATION: has shifts');
  perform staff_leave_decide(v_id2, 'reject');
  -- a person cancels their own, a manager cancels anyone's; cancel twice is fine
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  v_id2 := staff_leave_request(v_p, v_d + 20, v_d + 21, 'unpaid', null) ->> 'leave_id';
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform staff_leave_decide(v_id2, 'approve');
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform staff_leave_cancel(v_id2);
  if staff_leave_cancel(v_id2) ->> 'status' <> 'cancelled' then raise exception 'FAIL cancel twice'; end if;
  perform t_expect(format('select staff_leave_decide(%L, ''approve'')', v_id2), 'NOT_FOUND');
  if (select count(*) from staff_leave) <> 3 then raise exception 'FAIL own leave visibility'; end if;
  raise notice 'PASS leave: request, no overlap, manager decides once, no shift on approved leave, cancel by owner or manager, reads limited to self and managers';
end $$;

-- 6. People and the hours report
do $$ declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_d date := t162_today(); r jsonb; a jsonb; begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  if jsonb_array_length(hr_people(v_p)) < 4 or hr_people(v_p)::text like '%@%' then raise exception 'FAIL staff people list %', hr_people(v_p); end if;   -- names, no emails
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select hr_people(%L)', v_p), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select hr_hours_report(%L, %L, %L)', v_p, v_d - 7, v_d + 30), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  if jsonb_array_length(hr_people(v_p)) < 4 or hr_people(v_p)::text like '%bb01%' or hr_people(v_p)::text not like '%@%' then raise exception 'FAIL people %', hr_people(v_p); end if;
  perform t_expect(format('select hr_hours_report(%L, %L, %L)', v_p, v_d + 5, v_d), 'POLICY_VIOLATION: dates');
  perform t_expect(format('select hr_hours_report(%L, %L, %L)', v_p, v_d - 400, v_d), 'POLICY_VIOLATION: dates');
  r := hr_hours_report(v_p, v_d - 7, v_d + 30);
  select e into a from jsonb_array_elements(r -> 'people') e where e ->> 'user_id' = '00000000-0000-0000-0000-00000000aa04';
  if a is null then raise exception 'FAIL aa04 missing from report'; end if;
  if (a ->> 'worked_minutes')::int < 0 or (a -> 'leave_days' ->> 'annual')::int <> 3 or a -> 'leave_days' ? 'unpaid' then raise exception 'FAIL front desk row %', a; end if;
  if (a ->> 'scheduled_minutes')::int <> 16 * 60 then raise exception 'FAIL scheduled minutes %', a; end if;   -- tomorrow 8h + today 8h
  select e into a from jsonb_array_elements(r -> 'people') e where e ->> 'user_id' = '00000000-0000-0000-0000-00000000aa02';
  if (a ->> 'worked_minutes')::int <> 9 * 60 or (a ->> 'corrected_rows')::int <> 1 then raise exception 'FAIL housekeeping row %', a; end if;
  select e into a from jsonb_array_elements(r -> 'people') e where e ->> 'user_id' = '00000000-0000-0000-0000-00000000aa05';
  if (a ->> 'open_rows')::int <> 1 then raise exception 'FAIL open rows %', a; end if;
  raise notice 'PASS report: people list and hours report for managers, worked, scheduled, open, corrected and leave days per person';
end $$;

-- 7. The flag: off refuses every write and still lets managers read
do $$ declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_t constant uuid := '00000000-0000-0000-0000-0000000000a1'; v_d date := t162_today(); begin
  perform t_sys();
  insert into tenant_feature_entitlements (tenant_id, feature_key, enabled) values (v_t, 'staff_hr', false);
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select staff_clock_out(%L)', v_p), 'POLICY_VIOLATION: hr off');
  perform t_expect(format('select staff_leave_request(%L, %L, %L, ''annual'', null)', v_p, v_d + 40, v_d + 41), 'POLICY_VIOLATION: hr off');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select staff_shift_remove(%L)', t162('tomorrow')), 'POLICY_VIOLATION: hr off');
  perform t_expect(format('select staff_leave_cancel(%L)', t162('leave')), 'POLICY_VIOLATION: hr off');
  if jsonb_array_length(hr_people(v_p)) < 4 or hr_hours_report(v_p, v_d - 7, v_d + 30) is null then raise exception 'FAIL reads with the flag off'; end if;
  perform t_sys();
  delete from tenant_feature_entitlements where tenant_id = v_t and feature_key = 'staff_hr';
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform staff_shift_remove(t162('tomorrow'));
  if exists (select 1 from staff_shifts where id = t162('tomorrow')) then raise exception 'FAIL shift remove'; end if;
  raise notice 'PASS flag: off refuses every write, reads work; on again, writes work';
end $$;
