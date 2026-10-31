-- payment_no_room email (migration 021). Reuses t08_online / t08_conf (08) and t_book, t_sys.
\set ON_ERROR_STOP on

do $$ declare v_res uuid; r jsonb; p jsonb; v_amount bigint; begin
  perform t_sys();
  v_res := t08_online('lostmail', 340, '00000000-0000-0000-0000-0000000000a4');
  update room_inventory_claims set hold_expires_at = now() - interval '2 minutes'
   where reservation_room_id in (select id from reservation_rooms where reservation_id = v_res);
  update payment_attempts set created_at = now() - interval '1 hour' where reservation_id = v_res;
  perform expire_lapsed_holds();
  perform t_book('00000000-0000-0000-0000-0000000000a4', property_today('00000000-0000-0000-0000-0000000000a2') + 340,
                 property_today('00000000-0000-0000-0000-0000000000a2') + 342, 't18-steal-room');
  -- nothing about a lost room yet: the hold email exists, the payment one does not
  if exists (select 1 from email_outbox where kind = 'payment_no_room' and reservation_id = v_res) then raise exception 'FAIL email before payment'; end if;

  r := t08_conf('lostmail', 'evt-lostmail-1');
  if r ->> 'result' <> 'recorded_inventory_lost' then raise exception 'FAIL expected the lost-room outcome %', r; end if;
  select amount into v_amount from t08_ctx where label = 'lostmail';
  select payload into p from email_outbox where kind = 'payment_no_room' and reservation_id = v_res and to_email = 'lostmail@example.com';
  if p is null then raise exception 'FAIL no email queued'; end if;
  if (p ->> 'paid_minor')::bigint <> v_amount or p ->> 'currency' <> 'NGN' then raise exception 'FAIL payload %', p; end if;

  -- clearing and re-flagging does not email twice
  update reservations set attention_reason = null where id = v_res;
  update reservations set attention_reason = 'paid_inventory_lost' where id = v_res;
  if (select count(*) from email_outbox where kind = 'payment_no_room' and reservation_id = v_res) <> 1 then raise exception 'FAIL emailed twice'; end if;

  -- other flags and staff bookings do not send it
  update reservations set attention_reason = 'paid_after_cancel' where id = v_res;
  if (select count(*) from email_outbox where kind = 'payment_no_room' and reservation_id = v_res) <> 1 then raise exception 'FAIL other flag emailed'; end if;
  update reservations set attention_reason = null, source = 'staff_entry' where id = v_res;
  delete from email_outbox where kind = 'payment_no_room' and reservation_id = v_res;
  update reservations set attention_reason = 'paid_inventory_lost' where id = v_res;
  if exists (select 1 from email_outbox where kind = 'payment_no_room' and reservation_id = v_res) then raise exception 'FAIL staff booking emailed'; end if;
  raise notice 'PASS payment_no_room: queued once with the amount when the room is lost, website bookings only';
end $$;
