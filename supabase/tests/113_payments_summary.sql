-- payments_summary (migration 113). Reuses t_as / t_sys / t_expect (05). Hotel A: property a2, room type a3, guest a5. Owner aa01,
-- accountant aa05, housekeeping aa02, other hotel's owner bb01. Offset 1300 days: no other test books there.
\set ON_ERROR_STOP on

create table t113_ctx (label text primary key, val text not null);
create function t113_get(p_label text) returns text language sql stable as $$ select val from t113_ctx where label = p_label $$;
-- The NGN row of one list, as (amount, count); (0, 0) when the list has none.
create function t113_row(s jsonb, p_list text, out amount bigint, out n integer) language sql immutable as $$
  select coalesce(max((e ->> 'amount_minor')::bigint), 0), coalesce(max((e ->> 'count')::integer), 0)
    from jsonb_array_elements(s -> p_list) e where e ->> 'currency' = 'NGN'
$$;

-- 1. a first look, and who sees what
do $$
declare s jsonb; r record;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  s := payments_summary();
  if not (s ? 'received' and s ? 'unverified' and s ? 'refunds_open' and s ? 'refunded') then raise exception 'FAIL shape %', s; end if;
  insert into t113_ctx select 'base_received', (t113_row(s, 'received')).amount::text;
  insert into t113_ctx select 'base_received_n', (t113_row(s, 'received')).n::text;
  insert into t113_ctx select 'base_unverified', (t113_row(s, 'unverified')).amount::text;
  insert into t113_ctx select 'base_unverified_n', (t113_row(s, 'unverified')).n::text;
  insert into t113_ctx select 'base_open', (t113_row(s, 'refunds_open')).amount::text;
  insert into t113_ctx select 'base_open_n', (t113_row(s, 'refunds_open')).n::text;
  insert into t113_ctx select 'yesterday', (now() - interval '1 day')::text;

  -- housekeeping may see no money and another hotel's owner sees none of A's: both get empty lists, not an error
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  s := payments_summary();
  if s <> '{"received":[],"unverified":[],"refunds_open":[],"refunded":[]}'::jsonb then raise exception 'FAIL housekeeping saw money %', s; end if;
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  s := payments_summary();
  if (t113_row(s, 'received')).amount <> 0 or (t113_row(s, 'unverified')).amount <> 0 then raise exception 'FAIL hotel B saw hotel A money %', s; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  s := payments_summary();
  if (t113_row(s, 'received')).amount <> t113_get('base_received')::bigint then raise exception 'FAIL the accountant sees a different total than the owner'; end if;
  perform t_sys();
  raise notice 'PASS payments_summary: the shape is right; housekeeping and another hotel see nothing; the accountant sees what the owner sees';
end $$;

-- 2. a cash payment and a bank transfer move "received"; only the bank transfer is waiting to be verified
do $$
declare t date := property_today('00000000-0000-0000-0000-0000000000a2'); h jsonb; res uuid; tot bigint; cash bigint; bank bigint; s jsonb; p_bank uuid;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  h := create_staff_hold('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a5', 'phone', t + 1300, t + 1302,
    jsonb_build_array(jsonb_build_object('room_type_id', '00000000-0000-0000-0000-0000000000a3', 'adults', 1)), 'ps-hold');
  res := (h ->> 'reservation_id')::uuid;
  perform t_sys();
  select total_minor into tot from reservations where id = res;
  cash := tot / 2; bank := tot - cash;
  insert into t113_ctx values ('cash', cash::text), ('bank', bank::text), ('res', res::text);
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform record_manual_payment(res, cash, 'cash', null, null, 'ps-cash');
  perform record_manual_payment(res, bank, 'bank_transfer', 'REF-PS', null, 'ps-bank');
  s := payments_summary();
  if (t113_row(s, 'received')).amount <> t113_get('base_received')::bigint + tot or (t113_row(s, 'received')).n <> t113_get('base_received_n')::integer + 2
    then raise exception 'FAIL received did not grow by both payments %', s -> 'received'; end if;
  if (t113_row(s, 'unverified')).amount <> t113_get('base_unverified')::bigint + bank or (t113_row(s, 'unverified')).n <> t113_get('base_unverified_n')::integer + 1
    then raise exception 'FAIL only the bank transfer should wait for verification %', s -> 'unverified'; end if;
  perform t_sys();
  select id into p_bank from payments where reservation_id = res and payment_method = 'bank_transfer';
  insert into t113_ctx values ('p_bank', p_bank::text);
  raise notice 'PASS payments_summary: both payments are received; only the bank transfer is waiting to be verified';
end $$;

-- 3. verifying clears it from the waiting list but not from received
do $$
declare s jsonb;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform verify_payment(t113_get('p_bank')::uuid, 'ps-verify');
  s := payments_summary();
  if (t113_row(s, 'unverified')).amount <> t113_get('base_unverified')::bigint or (t113_row(s, 'unverified')).n <> t113_get('base_unverified_n')::integer
    then raise exception 'FAIL verified payment still waiting %', s -> 'unverified'; end if;
  if (t113_row(s, 'received')).amount <> t113_get('base_received')::bigint + t113_get('cash')::bigint + t113_get('bank')::bigint
    then raise exception 'FAIL verifying changed received'; end if;
  perform t_sys();
  raise notice 'PASS payments_summary: verifying a payment takes it off the waiting list and leaves it in received';
end $$;

-- 4. the date window applies to received and refunded, and never to the waiting lists
do $$
declare s jsonb;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  -- everything up to yesterday: the new payments are not in it
  s := payments_summary(null, t113_get('yesterday')::timestamptz);
  if (t113_row(s, 'received')).amount >= t113_get('base_received')::bigint + t113_get('cash')::bigint then raise exception 'FAIL window did not exclude today %', s -> 'received'; end if;
  -- from tomorrow on: nothing has been received yet
  s := payments_summary(now() + interval '1 day', null);
  if jsonb_array_length(s -> 'received') <> 0 then raise exception 'FAIL a future window has payments %', s -> 'received'; end if;
  -- only the last hour: exactly the two new payments are in it (earlier tests ran moments ago too, so compare with the full total)
  s := payments_summary(now() - interval '1 day', now() + interval '1 day');
  if (t113_row(s, 'received')).amount < t113_get('cash')::bigint + t113_get('bank')::bigint then raise exception 'FAIL window missed the new payments'; end if;
  -- the waiting list ignores the window
  s := payments_summary(now() + interval '1 day', now() + interval '2 days');
  if (t113_row(s, 'unverified')).amount <> t113_get('base_unverified')::bigint then raise exception 'FAIL the window changed the waiting list'; end if;
  perform t_sys();
  raise notice 'PASS payments_summary: the window applies to received and refunded only';
end $$;

-- 5. a refund asked for is open, and is not "refunded" until it succeeds
do $$
declare s jsonb; p_cash uuid; refunded0 bigint; n0 integer;
begin
  perform t_sys();
  select id into p_cash from payments where reservation_id = t113_get('res')::uuid and payment_method = 'cash';
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  s := payments_summary();
  refunded0 := (t113_row(s, 'refunded')).amount; n0 := (t113_row(s, 'refunds_open')).n;
  perform request_refund(p_cash, 1000, 'ps-refund', 'ps-refund-key');
  s := payments_summary();
  if (t113_row(s, 'refunds_open')).amount <> t113_get('base_open')::bigint + 1000 or (t113_row(s, 'refunds_open')).n <> t113_get('base_open_n')::integer + 1
    then raise exception 'FAIL the refund is not open %', s -> 'refunds_open'; end if;
  if (t113_row(s, 'refunded')).amount <> refunded0 then raise exception 'FAIL an unfinished refund counts as refunded'; end if;
  perform t_sys();
  raise notice 'PASS payments_summary: a requested refund is open and not yet refunded';
end $$;

-- 6. anon cannot call it; reversed payments and rejected refunds are not counted
do $$
declare v_state text; s jsonb; before_amt bigint; p uuid;
begin
  begin
    set local role anon;
    perform payments_summary();
    v_state := 'allowed';
  exception when insufficient_privilege then v_state := 'refused';
  end;
  reset role;
  if v_state <> 'refused' then raise exception 'FAIL anon may call payments_summary'; end if;

  perform t_sys();
  select id into p from payments where reservation_id = t113_get('res')::uuid and payment_method = 'cash';
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  before_amt := (t113_row(payments_summary(), 'received')).amount;
  perform t_sys();
  -- a reversed payment drops out of received (set directly: the guard allows this status change for the table owner's fixtures)
  alter table payments disable trigger user;
  update payments set payment_status = 'reversed' where id = p;
  alter table payments enable trigger user;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  s := payments_summary();
  if (t113_row(s, 'received')).amount <> before_amt - t113_get('cash')::bigint then raise exception 'FAIL a reversed payment is still counted %', s -> 'received'; end if;
  perform t_sys();
  raise notice 'PASS payments_summary: anon is refused; a reversed payment is not received money';
end $$;
