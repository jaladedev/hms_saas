-- Review request emails (migration 128). Hotel A: tenant a1, property a2; owner aa01, front desk aa04; another hotel's owner bb01.
\set ON_ERROR_STOP on

create function t128_stay(p_email text, p_key text, p_out interval default '1 day', p_status text default 'checked_out') returns uuid
language plpgsql as $$
declare v_res uuid; v_arr date := current_date + 30 + (random() * 300)::int;
begin
  v_res := (create_hold('book.hotel-a.test', v_arr, v_arr + 2,
                        '[{"room_type_id":"00000000-0000-0000-0000-0000000000a3","adults":1}]'::jsonb,
                        jsonb_build_object('full_name', 'Review Guest', 'email', p_email), p_key) ->> 'reservation_id')::uuid;
  set local session_replication_role = replica;
  delete from room_inventory_claims where reservation_room_id in (select id from reservation_rooms where reservation_id = v_res);
  update reservations set reservation_status = p_status where id = v_res;
  update reservation_rooms set room_status = 'checked_out', checked_out_at = now() - p_out where reservation_id = v_res;
  set local session_replication_role = origin;
  return v_res;
end $$;

-- 1. only property.configure sets it; off by default; audited; anon refused
do $$ declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_state text; begin
  perform t_sys();
  if (select review_request_enabled from properties where id = v_p) then raise exception 'FAIL should start off'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select set_review_request(%L, true)', v_p), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select set_review_request(%L, true)', v_p), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform set_review_request(v_p, true);
  perform t_sys();
  if not (select review_request_enabled from properties where id = v_p) then raise exception 'FAIL not saved'; end if;
  if not exists (select 1 from audit_logs where entity_id = v_p and action = 'property.updated' and metadata -> 'changed' ? 'review_request_enabled') then raise exception 'FAIL not audited'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform set_review_request(v_p, null);
  perform t_sys();
  if (select review_request_enabled from properties where id = v_p) then raise exception 'FAIL null did not turn it off'; end if;
  begin
    set local role anon;
    perform set_review_request(v_p, true);
    v_state := 'allowed';
  exception when insufficient_privilege then v_state := 'refused';
  end;
  reset role;
  if v_state <> 'refused' then raise exception 'FAIL anon could call set_review_request'; end if;
  raise notice 'PASS review requests: set by property.configure only, off by default, audited, anon refused';
end $$;

-- 2. off sends nothing; on queues only recently checked-out, unreviewed bookings with an email
do $$ declare
  v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; a uuid; b uuid; c uuid; d uuid; e uuid; f uuid; n integer;
begin
  perform t_sys();
  a := t128_stay('v-a@example.test', 't128-a');                       -- left a day ago
  b := t128_stay('v-b@example.test', 't128-b', '20 days');            -- too long ago
  c := t128_stay('v-c@example.test', 't128-c', '30 minutes');         -- just left
  d := t128_stay('v-d@example.test', 't128-d', '1 day', 'confirmed'); -- not checked out
  e := t128_stay('v-e@example.test', 't128-e');                       -- already reviewed
  f := t128_stay('v-f@example.test', 't128-f');                                     -- no email
  update guests set email = '' where id = (select primary_guest_id from reservations where id = f);
  insert into guest_reviews (tenant_id, property_id, reservation_id, rating, comment, author)
  select tenant_id, property_id, id, 5, '', 'Review G.' from reservations where id = e;

  if queue_review_requests() <> 0 then raise exception 'FAIL queued while the setting is off'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform set_review_request(v_p, true);
  perform t_sys();
  n := queue_review_requests();
  if n <> 1 then raise exception 'FAIL expected 1 queued, got %', n; end if;
  if not exists (select 1 from email_outbox where reservation_id = a and kind = 'review_request' and to_email = 'v-a@example.test') then raise exception 'FAIL booking A not queued'; end if;
  if exists (select 1 from email_outbox where kind = 'review_request' and reservation_id in (b, c, d, e, f)) then raise exception 'FAIL a booking outside the rules was queued'; end if;
  if queue_review_requests() <> 0 then raise exception 'FAIL a repeat queued again'; end if;
  raise notice 'PASS review requests: off sends nothing; on queues once, only for recent, unreviewed stays with an email';
end $$;

-- 3. the limit holds; the queue function is for the system only
do $$ declare n integer; begin
  perform t_sys();
  perform t128_stay('v-g@example.test', 't128-g');
  perform t128_stay('v-h@example.test', 't128-h');
  n := queue_review_requests(1);
  if n <> 1 then raise exception 'FAIL limit 1 queued %', n; end if;
  if queue_review_requests(1) <> 1 or queue_review_requests() <> 0 then raise exception 'FAIL limit sequence'; end if;
  raise notice 'PASS review requests: limit respected';
end $$;
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000aa01';
do $$ begin
  begin perform queue_review_requests(); raise exception 'FAIL authenticated queue_review_requests';
  exception when insufficient_privilege then null; end;
end $$;
rollback;
do $$ begin raise notice 'PASS review requests: queue function closed to authenticated callers'; end $$;

do $$ begin
  perform t_sys();
  update properties set review_request_enabled = false where id = '00000000-0000-0000-0000-0000000000a2';
end $$;
drop function t128_stay(text, text, interval, text);
