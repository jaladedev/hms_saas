-- Payment verification (migration 056). Reuses t_as / t_sys / t_expect (05), t07_res (07) and t50_rows (56).
-- Users: aa01 owner A, aa02 housekeeping A, aa04 front desk A, aa05 accountant A, bb01 owner B. Bookings sit 1900 to 1930 days ahead.
\set ON_ERROR_STOP on

do $$ declare
  prop uuid := '00000000-0000-0000-0000-0000000000a2';
  owner uuid := '00000000-0000-0000-0000-00000000aa01'; fd uuid := '00000000-0000-0000-0000-00000000aa04';
  acc uuid := '00000000-0000-0000-0000-00000000aa05'; ob uuid := '00000000-0000-0000-0000-00000000bb01';
  hk uuid := '00000000-0000-0000-0000-00000000aa02';
  res uuid; p_bank uuid; p_cash uuid; p_pos uuid; p_other uuid; p_web uuid; r jsonb; n integer; a uuid; tenant uuid;
begin
  perform t_sys();
  select tenant_id into tenant from properties where id = prop;
  res := t07_res(1900, 2, 't57-b1');

  -- 1. what the desk records
  perform t_as(fd::text);
  perform record_manual_payment(res, 100000, 'bank_transfer', 'GTB slip 1', null, 't57-bank');
  perform record_manual_payment(res, 100000, 'cash', 'receipt 1', null, 't57-cash');
  perform record_manual_payment(res, 100000, 'pos', 'pos 1', null, 't57-pos');
  perform record_manual_payment(res, 100000, 'other', 'cheque 1', null, 't57-other');
  perform t_sys();
  select id into p_bank from payments where reservation_id = res and payment_method = 'bank_transfer';
  select id into p_cash from payments where reservation_id = res and payment_method = 'cash';
  select id into p_pos from payments where reservation_id = res and payment_method = 'pos';
  select id into p_other from payments where reservation_id = res and payment_method = 'other';
  if (select verification_status from payments where id = p_bank) <> 'unverified' or (select verification_status from payments where id = p_other) <> 'unverified' then
    raise exception 'FAIL bank transfer and other must start unverified'; end if;
  if (select verification_status from payments where id = p_cash) <> 'verified' or (select verification_status from payments where id = p_pos) <> 'verified'
     or (select verified_at from payments where id = p_cash) is null then raise exception 'FAIL cash and pos must be verified on entry'; end if;
  if (select payment_status from reservations where id = res) not in ('partially_paid', 'paid') then raise exception 'FAIL unverified money must still count toward the balance'; end if;

  -- a Paystack payment is verified by definition
  insert into payments (tenant_id, property_id, reservation_id, payment_provider, payment_method, provider_reference, internal_reference, amount_minor, currency)
    select tenant, prop, res, 'paystack', 'other', 't57-ps-ref', 't57-ps-int', 1000, currency from reservations where id = res returning id into p_web;
  if (select verification_status from payments where id = p_web) <> 'verified' then raise exception 'FAIL a provider payment must be verified'; end if;

  -- 2. the notices: bank and other only, once each, to payment.verify holders
  if (select count(*) from t50_rows('payment_unverified', p_bank)) <> 1 or (select count(*) from t50_rows('payment_unverified', p_other)) <> 1 then raise exception 'FAIL expected one notice each for bank and other'; end if;
  if exists (select 1 from notifications where kind = 'payment_unverified' and entity_id in (p_cash, p_pos, p_web)) then raise exception 'FAIL a verified payment raised a notice'; end if;
  select id into a from t50_rows('payment_unverified', p_bank);
  if (select title from notifications where id = a) !~ '^Payment to verify: ' or (select link from notifications where id = a) <> '/app/payments' or (select category from notifications where id = a) <> 'money' then raise exception 'FAIL notice shape'; end if;
  if not t50_sees(acc, a) or not t50_sees(owner, a) or t50_sees(fd, a) or t50_sees(hk, a) or t50_sees(ob, a) then raise exception 'FAIL notice visibility'; end if;

  -- 3. the queue
  perform t_as(fd::text);
  r := payments_to_verify();
  if jsonb_array_length(r -> 'items') <> 0 or (r ->> 'unverified')::int <> 0 then raise exception 'FAIL front desk saw the queue: %', r; end if;
  perform t_as(ob::text);
  r := payments_to_verify();
  if jsonb_array_length(r -> 'items') <> 0 then raise exception 'FAIL hotel B saw hotel A payments'; end if;
  perform t_as(acc::text);
  r := payments_to_verify();
  select count(*) into n from jsonb_array_elements(r -> 'items') i where (i ->> 'id')::uuid in (p_bank, p_other);
  if n <> 2 or exists (select 1 from jsonb_array_elements(r -> 'items') i where (i ->> 'id')::uuid in (p_cash, p_pos, p_web)) then raise exception 'FAIL queue content: %', r; end if;
  if (select (i ->> 'reference') from jsonb_array_elements(r -> 'items') i where (i ->> 'id')::uuid = p_bank) <> 'GTB slip 1'
     or (select (i ->> 'booking_reference') from jsonb_array_elements(r -> 'items') i where (i ->> 'id')::uuid = p_bank) is null
     or (select (i ->> 'recorded_by_name') is null from jsonb_array_elements(r -> 'items') i where (i ->> 'id')::uuid = p_bank) is null then raise exception 'FAIL queue row fields: %', r; end if;
  if (r ->> 'unverified')::int < 2 then raise exception 'FAIL open count'; end if;
  perform t_expect('select payments_to_verify(''nonsense'')', 'POLICY_VIOLATION');
  perform t_expect('select payments_to_verify(''unverified'', 0)', 'POLICY_VIOLATION');
  perform t_expect('select payments_to_verify(''unverified'', 201)', 'POLICY_VIOLATION');

  -- 4. verifying
  perform t_as(fd::text);
  perform t_expect(format('select verify_payment(%L)', p_bank), 'NOT_FOUND');
  perform t_as(hk::text);
  perform t_expect(format('select verify_payment(%L)', p_bank), 'NOT_FOUND');
  perform t_as(ob::text);
  perform t_expect(format('select verify_payment(%L)', p_bank), 'NOT_FOUND');
  perform t_as(acc::text);
  perform t_expect(format('select verify_payment(%L)', gen_random_uuid()), 'NOT_FOUND');
  r := verify_payment(p_bank, 'matches the 14 Nov statement');
  if r ->> 'verification_status' <> 'verified' or (r ->> 'already')::boolean then raise exception 'FAIL verify result %', r; end if;
  r := verify_payment(p_bank, 'again');
  if not (r ->> 'already')::boolean then raise exception 'FAIL a second verify must say already'; end if;
  perform t_sys();
  if (select verification_status from payments where id = p_bank) <> 'verified' or (select verified_by from payments where id = p_bank) <> acc
     or (select verification_note from payments where id = p_bank) <> 'matches the 14 Nov statement' or (select verified_at from payments where id = p_bank) is null then raise exception 'FAIL verified columns'; end if;
  if (select count(*) from audit_logs where action = 'payment.verified' and entity_id = p_bank) <> 1 then raise exception 'FAIL expected exactly one audit row'; end if;
  if (select actor_user_id from audit_logs where action = 'payment.verified' and entity_id = p_bank) <> acc then raise exception 'FAIL audit actor'; end if;
  perform t_as(acc::text);
  r := payments_to_verify();
  if exists (select 1 from jsonb_array_elements(r -> 'items') i where (i ->> 'id')::uuid = p_bank) then raise exception 'FAIL a verified payment is still queued'; end if;
  r := payments_to_verify('verified');
  if (select (i ->> 'verified_by_name') is null and (i ->> 'verification_note') is null from jsonb_array_elements(r -> 'items') i where (i ->> 'id')::uuid = p_bank) then raise exception 'FAIL verified list row: %', r; end if;
  if (r ->> 'unverified')::int < 1 then raise exception 'FAIL the open count must still include the other payment'; end if;

  -- the owner (who also holds payment.verify) may verify what the desk recorded, and may then undo what proved false
  perform t_as(owner::text);
  perform reverse_payment(p_other, 'cheque bounced', 't57-rev');
  perform t_as(acc::text);
  perform t_expect(format('select verify_payment(%L)', p_other), 'INVALID_STATE');
  r := payments_to_verify();
  if exists (select 1 from jsonb_array_elements(r -> 'items') i where (i ->> 'id')::uuid = p_other) then raise exception 'FAIL a reversed payment is still queued'; end if;

  -- 5. a verified payment never goes back, and the money fields still cannot be rewritten
  perform t_sys();
  begin update payments set verification_status = 'unverified' where id = p_bank; raise exception 'FAIL verified went back';
  exception when check_violation then null; end;
  begin update payments set amount_minor = 5 where id = p_bank; raise exception 'FAIL amount rewritten';
  exception when check_violation then null; end;

  -- 6. anon is shut out
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('role', 'anon', true);
  begin perform payments_to_verify(); raise exception 'FAIL anon read the queue'; exception when insufficient_privilege then null; end;
  begin perform verify_payment(p_bank); raise exception 'FAIL anon verified'; exception when insufficient_privilege then null; end;
  perform set_config('role', 'postgres', true);

  perform t_sys();
  perform t_as(owner::text); perform cancel_reservation(res, 'test over', 't57-cancel'); perform t_sys();
  raise notice 'PASS payment verification: cash and pos are verified on entry, bank transfers and other queue (still counting) with one notice each; only payment.verify holders see and clear the queue; verifying is audited, repeatable and one-way; reversed payments leave the queue';
end $$;
