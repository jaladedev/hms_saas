-- The early check-out email (migration 074). Reuses t_as / t_sys / t_book / t_rr (05). One room of our own (T74-1).
-- The policy in force is edited with triggers off and put back at the end, like tests 62 and 73.
\set ON_ERROR_STOP on

create function t74_mode(m text) returns void language plpgsql as $$
declare prop uuid := '00000000-0000-0000-0000-0000000000a2'; cfg jsonb; pid uuid;
begin
  set local session_replication_role = replica;
  select id, config into pid, cfg from property_policies where property_id = prop and effective_from <= property_today(prop) order by effective_from desc limit 1;
  cfg := cfg - 'early_checkout';
  if m <> 'none' then cfg := cfg || jsonb_build_object('early_checkout', m); end if;
  update property_policies set config = cfg where id = pid;
  set local session_replication_role = origin;
end $$;

do $$ declare
  prop uuid := '00000000-0000-0000-0000-0000000000a2'; t date; owner text := '00000000-0000-0000-0000-00000000aa01';
  room uuid; b jsonb; res uuid; rr uuid; old_total bigint; n integer; e record;
begin
  perform t_sys();
  t := property_today(prop);
  insert into rooms (tenant_id, property_id, room_type_id, room_number, floor)
    select tenant_id, id, '00000000-0000-0000-0000-0000000000a3', 'T74-1', 9 from properties where id = prop;
  select id into room from rooms where property_id = prop and room_number = 'T74-1';
  update rooms set housekeeping_status = 'clean' where id = room;
  perform t74_mode('credit');

  -- A. a staff-made booking: the credit is applied and nobody is emailed
  perform t_as(owner);
  b := t_book('00000000-0000-0000-0000-0000000000a3', t, t + 3, 't74-a', room); res := (b ->> 'reservation_id')::uuid; rr := t_rr(b);
  perform check_in(rr);
  perform check_out(rr);
  perform t_sys();
  if (select early_checkout_credit_minor from reservations where id = res) <= 0 then raise exception 'FAIL no credit applied (A)'; end if;
  if exists (select 1 from email_outbox where reservation_id = res and kind = 'early_checkout_credit') then raise exception 'FAIL a staff booking was emailed'; end if;

  -- B. a website booking with a guest email and money paid: one email with the credit and the refund due
  update rooms set housekeeping_status = 'clean' where id = room;
  perform t_as(owner);
  b := t_book('00000000-0000-0000-0000-0000000000a3', t, t + 3, 't74-b', room); res := (b ->> 'reservation_id')::uuid; rr := t_rr(b);
  perform t_sys();
  select total_minor into old_total from reservations where id = res;
  update reservations set source = 'website' where id = res;
  update guests set email = 'guest74@example.test' where id = (select primary_guest_id from reservations where id = res);
  perform t_as(owner);
  perform record_manual_payment(res, old_total, 'cash', 't74 cash', null, 't74-b-pay');
  perform check_in(rr);
  perform check_out(rr);
  perform t_sys();
  select count(*) into n from email_outbox where reservation_id = res and kind = 'early_checkout_credit';
  select * into e from email_outbox where reservation_id = res and kind = 'early_checkout_credit';
  if n <> 1 or e.to_email <> 'guest74@example.test' then raise exception 'FAIL email not queued once (%)', n; end if;
  if (e.payload ->> 'credit_minor')::bigint <> old_total or (e.payload ->> 'new_total_minor')::bigint <> 0
     or (e.payload ->> 'refund_due_minor')::bigint <> old_total or (e.payload ->> 'nights_credited')::int <> 3 then raise exception 'FAIL email payload %', e.payload; end if;

  perform t74_mode('none');
  update rooms set operational_status = 'retired' where id = room;
  raise notice 'PASS early check-out email: none for staff bookings, one for a website guest with the credit, the new total and the refund due';
end $$;

drop function t74_mode(text);
