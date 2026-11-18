-- Events part 5 (migration 144): emails to guests who book or buy on the website. Runs after 141_ticketed_events.sql, whose website
-- bookings (z@example.com) and ticket order (rex@example.com) are what the queue holds.
\set ON_ERROR_STOP on

do $$ declare
  v_n integer; v_id uuid; r jsonb; e jsonb; v_a constant uuid := '00000000-0000-0000-0000-0000000000a2';
begin
  perform t_sys();
  -- one email per kind and booking or order
  select count(*) into v_n from event_email_outbox where kind = 'venue_received' and to_email = 'z@example.com';
  if v_n < 1 then raise exception 'FAIL enquiry email missing'; end if;
  if exists (select 1 from event_email_outbox where kind = 'venue_received' and booking_id in (select id from venue_bookings where status <> 'enquiry' and title = 'Zed wedding')) then
    raise exception 'FAIL an online booking also got the enquiry email';
  end if;
  select count(*) into v_n from event_email_outbox where kind = 'venue_held' and to_email = 'z@example.com';
  if v_n <> 1 then raise exception 'FAIL held email count %', v_n; end if;
  select count(*) into v_n from event_email_outbox where kind = 'venue_confirmed' and to_email = 'z@example.com';
  if v_n <> 1 then raise exception 'FAIL confirmed email count %', v_n; end if;
  select count(*) into v_n from event_email_outbox where kind = 'tickets_paid' and to_email = 'rex@example.com';
  if v_n <> 1 then raise exception 'FAIL tickets email count %', v_n; end if;
  -- staff-made bookings and desk sales never email (they have no guest page)
  if exists (select 1 from event_email_outbox o join venue_bookings b on b.id = o.booking_id where b.source <> 'website') then raise exception 'FAIL staff booking emailed'; end if;
  if exists (select 1 from event_email_outbox o join ticket_orders t on t.id = o.order_id where t.source <> 'website') then raise exception 'FAIL desk sale emailed'; end if;
  -- a second status change to the same state queues nothing more
  select booking_id into v_id from event_email_outbox where kind = 'venue_confirmed' and to_email = 'z@example.com';
  perform enqueue_event_email('venue_confirmed', v_id, null);
  select count(*) into v_n from event_email_outbox where kind = 'venue_confirmed' and booking_id = v_id;
  if v_n <> 1 then raise exception 'FAIL duplicate queued'; end if;
  raise notice 'PASS event emails queued once per booking or order, website only';
end $$;

do $$ declare
  v_n integer; r jsonb; e jsonb; v_id uuid;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  begin perform claim_event_emails(5); raise exception 'FAIL staff claimed'; exception when insufficient_privilege then null; end;
  perform t_sys();
  begin perform claim_event_emails(0); raise exception 'FAIL limit'; exception when sqlstate 'P0001' then null; end;
  r := claim_event_emails(100);
  if jsonb_array_length(r) < 4 then raise exception 'FAIL claimed %', jsonb_array_length(r); end if;
  for e in select * from jsonb_array_elements(r) loop
    if e ->> 'site_host' is null or e -> 'view' is null or e ->> 'target_id' is null or (e ->> 'attempt')::integer <> 1 then raise exception 'FAIL claimed row %', e; end if;
    if e::text like '%tenant%' then raise exception 'FAIL leaked ids'; end if;
    if e ->> 'kind' = 'tickets_paid' and jsonb_array_length(e -> 'view' -> 'tickets') < 1 then raise exception 'FAIL tickets missing in view'; end if;
    if e ->> 'kind' <> 'tickets_paid' and (e -> 'view' ->> 'venue') is null then raise exception 'FAIL booking view'; end if;
  end loop;
  -- claimed rows are not claimed again
  if jsonb_array_length(claim_event_emails(100)) <> 0 then raise exception 'FAIL claimed twice'; end if;
  -- results: ok marks sent; a failure retries later; the fifth failure stops
  v_id := (r -> 0 ->> 'id')::uuid;
  perform mark_event_email_result(v_id, true, null);
  if (select status from event_email_outbox where id = v_id) <> 'sent' then raise exception 'FAIL sent'; end if;
  v_id := (r -> 1 ->> 'id')::uuid;
  perform mark_event_email_result(v_id, false, 'boom');
  if not exists (select 1 from event_email_outbox where id = v_id and status = 'pending' and last_error = 'boom') then raise exception 'FAIL retry'; end if;
  update event_email_outbox set status = 'sending', attempts = 5 where id = v_id;
  perform mark_event_email_result(v_id, false, 'boom');
  if (select status from event_email_outbox where id = v_id) <> 'failed' then raise exception 'FAIL gave up'; end if;
  -- the 90 day purge
  update event_email_outbox set sent_at = now() - interval '91 days' where status = 'sent';
  if (purge_old_operational_data() ->> 'event_emails')::integer < 1 then raise exception 'FAIL purge'; end if;
  raise notice 'PASS event email queue: system only, claim with page view and host, retry and give up, purge';
end $$;
