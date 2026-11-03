-- The hotel setting that switches guest self-cancel off (migration 038). Reuses t_as / t_sys / t_expect (05), t07_res (07), t34_* (34).
-- It adds a policy version for Hotel A that turns it off, checks, then removes that version again (policy rows are immutable,
-- so the trigger is disabled for the clean-up, as the superuser) so later files see the policy they expect.
\set ON_ERROR_STOP on

create table t34_keep (label text primary key, res uuid not null);

-- 1. On by default: a policy without the key means guests may cancel, and guest_policy says "on"
do $$ declare v_res uuid; p jsonb; begin
  v_res := t34_setup(1500, 'set-on', '{"cancellation_rules":[]}'::jsonb, false);
  p := guest_cancel_preview(v_res);
  if not (p ->> 'allowed')::boolean then raise exception 'FAIL not allowed by default %', p; end if;
  if guest_policy('book.hotel-a.test') ->> 'guest_cancellation' <> 'on' then raise exception 'FAIL guest_policy default'; end if;
  insert into t34_keep values ('on', v_res);
  raise notice 'PASS default: guests may cancel when the policy says nothing, and guest_policy says on';
end $$;

-- 2. Off: the preview says why, the cancel is refused with nothing changed, guest_policy says off, and staff can still cancel
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); v_on uuid := (select res from t34_keep where label = 'on'); v_other uuid; v_row uuid := gen_random_uuid(); p jsonb; n int;
begin
  perform t_sys();
  insert into property_policies (id, tenant_id, property_id, version, effective_from, config)
  select v_row, tenant_id, id, (select max(version) + 1 from property_policies where property_id = '00000000-0000-0000-0000-0000000000a2'), t,
         current_policy(id, t) || '{"guest_cancellation":"off"}'::jsonb
    from properties where id = '00000000-0000-0000-0000-0000000000a2';
  if guest_policy('book.hotel-a.test') ->> 'guest_cancellation' <> 'off' then raise exception 'FAIL guest_policy off'; end if;

  -- a booking made BEFORE the switch is covered too: the setting is the hotel's, not the booking's
  p := guest_cancel_preview(v_on);
  if (p ->> 'allowed')::boolean or p ->> 'why_not' <> 'disabled' then raise exception 'FAIL preview off %', p; end if;
  perform t_expect(format('select guest_cancel_reservation(%L, 0, %L)', v_on, 't37-off'), 'INVALID_STATE: disabled');
  if (select reservation_status from reservations where id = v_on) <> 'confirmed' then raise exception 'FAIL a refused cancel changed the booking'; end if;

  -- a booking made after it too; status still wins when the booking is not cancellable at all
  v_other := t34_setup(1510, 'set-off', '{"cancellation_rules":[]}'::jsonb, false);
  if guest_cancel_preview(v_other) ->> 'why_not' <> 'disabled' then raise exception 'FAIL new booking not disabled'; end if;
  update reservation_rooms set room_status = 'checked_in' where reservation_id = v_other;
  if guest_cancel_preview(v_other) ->> 'why_not' <> 'started' then raise exception 'FAIL started should win over disabled'; end if;
  update reservation_rooms set room_status = 'booked' where reservation_id = v_other;

  -- staff are not affected
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform cancel_reservation(v_on, 'staff cancel while guests cannot', 't37-staff');
  perform t_sys();
  if (select reservation_status from reservations where id = v_on) <> 'cancelled' then raise exception 'FAIL staff cancel'; end if;

  -- the setting is the policy in force today: remove the version and guests may cancel again
  alter table property_policies disable trigger property_policies_no_update;
  delete from property_policies where id = v_row;
  alter table property_policies enable trigger property_policies_no_update;
  if guest_cancel_preview(v_other) ->> 'why_not' is not null then raise exception 'FAIL still disabled after the version is gone'; end if;
  select count(*) into n from property_policies where id = v_row;
  if n <> 0 then raise exception 'FAIL clean-up'; end if;
  raise notice 'PASS off: preview and cancel refuse (also for bookings made earlier), status reasons still win, staff cancel works, and removing the setting restores it';
end $$;
