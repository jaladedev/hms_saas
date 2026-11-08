-- The guest_cancel plan flag (migration 067). Reuses t_as, t_sys, t_expect, t34_setup (34). Hotel group A (a1) is switched off and on.
\set ON_ERROR_STOP on

do $$ declare
  v_t uuid := '00000000-0000-0000-0000-0000000000a1'; v_res uuid; v_res2 uuid; p jsonb;
begin
  perform t_sys();
  v_res := t34_setup(1600, 'gcf-1', '{"cancellation_rules":[]}'::jsonb, false);
  v_res2 := t34_setup(1610, 'gcf-2', '{"cancellation_rules":[]}'::jsonb, false);
  -- no row: guests may cancel and the policy says on
  if not (guest_cancel_preview(v_res) ->> 'allowed')::boolean or guest_policy('book.hotel-a.test') ->> 'guest_cancellation' <> 'on' then raise exception 'FAIL default'; end if;

  -- an unrelated flag off changes nothing
  perform t_as('00000000-0000-0000-0000-00000000f050');
  perform platform_set_entitlement(v_t, 'online_payments', false);
  perform t_sys();
  if not (guest_cancel_preview(v_res) ->> 'allowed')::boolean then raise exception 'FAIL an unrelated flag disabled guest cancel'; end if;

  -- off: the preview says disabled, the cancel is refused and changes nothing, the policy says off
  perform t_as('00000000-0000-0000-0000-00000000f050');
  perform platform_set_entitlement(v_t, 'guest_cancel', false);
  perform t_sys();
  p := guest_cancel_preview(v_res);
  if (p ->> 'allowed')::boolean or p ->> 'why_not' <> 'disabled' then raise exception 'FAIL preview with the flag off %', p; end if;
  if guest_policy('book.hotel-a.test') ->> 'guest_cancellation' <> 'off' then raise exception 'FAIL guest_policy with the flag off'; end if;
  perform t_expect(format('select guest_cancel_reservation(%L, 0, %L)', v_res, 'gcf-off'), 'INVALID_STATE: disabled');
  if (select reservation_status from reservations where id = v_res) <> 'confirmed' then raise exception 'FAIL a refused cancel changed the booking'; end if;

  -- staff can still cancel
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform cancel_reservation(v_res, 'staff cancel while guests cannot', 'gcf-staff');
  perform t_sys();
  if (select reservation_status from reservations where id = v_res) <> 'cancelled' then raise exception 'FAIL staff could not cancel'; end if;

  -- on again: guests may cancel
  perform t_as('00000000-0000-0000-0000-00000000f050');
  perform platform_set_entitlement(v_t, 'guest_cancel', true);
  perform platform_set_entitlement(v_t, 'online_payments', true);
  perform t_sys();
  if not (guest_cancel_preview(v_res2) ->> 'allowed')::boolean or guest_policy('book.hotel-a.test') ->> 'guest_cancellation' <> 'on' then raise exception 'FAIL guest cancel did not return'; end if;
  raise notice 'PASS guest_cancel off disables guest self-cancel and the policy sentence, staff can still cancel, on or absent keeps it';
end $$;
