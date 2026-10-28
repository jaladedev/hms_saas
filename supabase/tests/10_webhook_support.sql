-- Webhook support lookups and guest booking status (migration 013). Uses fixtures from 08 and 09:
-- t08_ctx (online reservations), the active Paystack account for Hotel A, and refunds on provider payments.
\set ON_ERROR_STOP on

-- 1. Provider account lookup for the webhook URL
do $$ declare acc uuid; r record; n integer; begin
  insert into payment_provider_accounts (tenant_id, provider, mode, account_label, secret_reference, status)
  values ('00000000-0000-0000-0000-0000000000b1', 'paystack', 'test', 'Hotel B test', 'env:PAYSTACK_SECRET_HOTEL_B', 'active');
  select id into acc from payment_provider_accounts where tenant_id = '00000000-0000-0000-0000-0000000000a1' and provider = 'paystack';
  select * into r from payment_provider_account_for_webhook(acc);
  if r.tenant_id <> '00000000-0000-0000-0000-0000000000a1' or r.secret_reference <> 'vault://hotel-a/paystack-test' then raise exception 'FAIL account lookup %', r; end if;
  select count(*) into n from payment_provider_account_for_webhook(gen_random_uuid());
  if n <> 0 then raise exception 'FAIL unknown account returned a row'; end if;
  update payment_provider_accounts set status = 'disabled' where id = acc;
  select count(*) into n from payment_provider_account_for_webhook(acc);
  if n <> 0 then raise exception 'FAIL disabled account returned a row'; end if;
  update payment_provider_accounts set status = 'active' where id = acc;
  update tenants set status = 'suspended' where id = '00000000-0000-0000-0000-0000000000a1';
  select count(*) into n from payment_provider_account_for_webhook(acc);
  update tenants set status = 'active' where id = '00000000-0000-0000-0000-0000000000a1';
  if n <> 0 then raise exception 'FAIL suspended tenant returned a row'; end if;
  raise notice 'PASS webhook account lookup: active accounts of active tenants only';
end $$;

-- 2. Matching a refund webhook to our refund
do $$ declare v_ref uuid; v_pay uuid; v_prov_ref text; v_amt bigint; found uuid; begin
  select c_refund, c_pay into v_ref, v_pay from t09_ctx where label = 'prov';
  select provider_reference, amount_minor into v_prov_ref, v_amt from payments where id = v_pay;
  -- the provider refund in 09 already succeeded, so nothing is processing: no match
  if find_processing_refund('00000000-0000-0000-0000-0000000000a1', 'paystack', v_prov_ref, v_amt) is not null then raise exception 'FAIL matched a finished refund'; end if;
  -- a fresh online payment with a processing refund
  perform t08_online('mr1', 218);
  perform t08_conf('mr1', 'evt-mr1-pay');
  select id, provider_reference, amount_minor into v_pay, v_prov_ref, v_amt from payments where reservation_id = (select res from t08_ctx where label = 'mr1');
  v_ref := (request_refund(v_pay, v_amt, 'support test', 't10-rq') ->> 'refund_id')::uuid;
  perform approve_refund(v_ref, true, null, 't10-ap');
  perform begin_refund_processing(v_ref);
  found := find_processing_refund('00000000-0000-0000-0000-0000000000a1', 'paystack', v_prov_ref, v_amt);
  if found is distinct from v_ref then raise exception 'FAIL refund match %', found; end if;
  if find_processing_refund('00000000-0000-0000-0000-0000000000b1', 'paystack', v_prov_ref, v_amt) is not null then raise exception 'FAIL matched across tenants'; end if;
  if find_processing_refund('00000000-0000-0000-0000-0000000000a1', 'paystack', v_prov_ref, v_amt + 1) is not null then raise exception 'FAIL matched a different amount'; end if;
  raise notice 'PASS refund webhook matching is exact on tenant, transaction and amount';
end $$;

-- 3. Guest booking status
do $$ declare s jsonb; v_res uuid; begin
  select res into v_res from t08_ctx where label = 'happy';
  s := guest_booking_status(v_res);
  if s ->> 'status' <> 'confirmed' or s ->> 'payment_status' <> 'paid' or (s ->> 'outstanding_minor')::bigint <> 0
     or (s ->> 'booking_reference') not like 'BK-%' or jsonb_array_length(s -> 'rooms') <> 1 or s ->> 'property_name' is null
    then raise exception 'FAIL status %', s; end if;
  if s::text like '%claim%' or s::text like '%tenant%' or (s -> 'rooms' -> 0) ? 'room_id' then raise exception 'FAIL internal ids leaked %', s; end if;
  select res into v_res from t08_ctx where label = 'fresh';
  s := guest_booking_status(v_res);
  if s ->> 'status' <> 'pending' or s ->> 'payment_status' <> 'unpaid' or (s ->> 'hold_expires_at') is null then raise exception 'FAIL pending status %', s; end if;
  perform t06_expect_err(format('select guest_booking_status(%L)', gen_random_uuid()), 'NOT_FOUND%');
  raise notice 'PASS guest booking status: shape, no internal ids, hold expiry for pending bookings';
end $$;

-- 4. Closed to everyone but service_role
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000aa01';
do $$ begin
  begin perform guest_booking_status(gen_random_uuid()); raise exception 'FAIL authenticated guest_booking_status';
  exception when insufficient_privilege then null; end;
  begin perform payment_provider_account_for_webhook(gen_random_uuid()); raise exception 'FAIL authenticated account lookup';
  exception when insufficient_privilege then null; end;
  begin perform find_processing_refund(gen_random_uuid(), 'paystack', 'x', 1); raise exception 'FAIL authenticated refund lookup';
  exception when insufficient_privilege then null; end;
end $$;
rollback;
do $$ begin raise notice 'PASS webhook support lookups are closed to authenticated callers'; end $$;
