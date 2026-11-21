-- Morning summary counts guest messages and waiting-list requests (migration 138). Hotel A: tenant a1, property a2.
\set ON_ERROR_STOP on

do $$ declare
  v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_t constant uuid := '00000000-0000-0000-0000-0000000000a1';
  v_zone text; pl jsonb; v_today date; v_msgs integer; v_wait integer;
begin
  perform t_sys();
  select name into v_zone from pg_timezone_names where extract(hour from now() at time zone name) between 8 and 20 order by name limit 1;
  update properties set timezone = v_zone, digest_email = 'owner@hotel-a.test' where id = v_p;
  v_today := property_today(v_p);
  delete from digest_outbox where property_id = v_p;
  delete from contact_messages; delete from waitlist_requests;

  insert into contact_messages (tenant_id, property_id, guest_name, email, message, status) values
    (v_t, v_p, 'Msg One', 'one@example.test', 'Is there parking?', 'new'),
    (v_t, v_p, 'Msg Two', 'two@example.test', 'Late arrival okay?', 'new'),
    (v_t, v_p, 'Msg Three', 'three@example.test', 'Already answered', 'handled');
  insert into waitlist_requests (tenant_id, property_id, room_type_id, arrival_date, departure_date, adults, guest_name, email, status) values
    (v_t, v_p, '00000000-0000-0000-0000-0000000000a4', v_today + 200, v_today + 202, 2, 'Wait One', 'w1@example.test', 'waiting'),
    (v_t, v_p, '00000000-0000-0000-0000-0000000000a4', v_today + 210, v_today + 212, 2, 'Wait Two', 'w2@example.test', 'contacted'),
    (v_t, v_p, '00000000-0000-0000-0000-0000000000a4', v_today + 220, v_today + 222, 2, 'Wait Three', 'w3@example.test', 'waiting');
  update waitlist_requests set arrival_date = v_today - 5, departure_date = v_today - 3 where guest_name = 'Wait Three';  -- already past

  if queue_daily_digests() < 1 then raise exception 'FAIL nothing queued'; end if;
  select payload into pl from digest_outbox where property_id = v_p and report_date = v_today;
  if (pl ->> 'messages')::int <> 2 then raise exception 'FAIL messages count: %', pl; end if;
  if (pl ->> 'waiting')::int <> 1 then raise exception 'FAIL waiting count: %', pl; end if;
  if pl::text ~* 'Msg One|parking|example.test|Wait One' then raise exception 'FAIL guest details in the digest: %', pl; end if;

  delete from digest_outbox where property_id = v_p; delete from contact_messages; delete from waitlist_requests;
  raise notice 'PASS digest: counts new guest messages and still-waiting requests, no details';
end $$;

-- Leave hotel A as the seed made it. This test moves it to a zone where the local hour suits the summary, and every later test that
-- compares current_date (Lagos) with property_today() would otherwise run against that zone, and fail for part of each day.
update properties set timezone = 'Africa/Lagos', digest_email = null where id = '00000000-0000-0000-0000-0000000000a2';
