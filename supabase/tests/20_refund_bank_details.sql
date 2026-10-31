-- Refunds Paystack cannot finish without bank details (migration 022).
-- Reuses t_as / t_sys / t_expect (05) and the t13_ctx fixture (13): the 'online' reservation has a Paystack refund
-- that test 13 left in "processing". The 'two' reservation's refunds are manual and never reach processing.
-- Users: aa01 owner A (refund.approve), aa04 front desk, bb01 owner B.
\set ON_ERROR_STOP on

create table t20_ctx (refund uuid, other uuid);
insert into t20_ctx
select (select id from refunds where reservation_id = (select res from t13_ctx where label = 'online')),
       (select id from refunds where payment_id = (select pay from t13_ctx where label = 'two') limit 1);

-- 1. Paystack reports needs-attention: the refund is marked, the provider id is kept, a refund not processing is ignored
do $$ declare v_ref uuid; v_other uuid; f refunds%rowtype; begin
  select refund, other into v_ref, v_other from t20_ctx;
  if (select refund_status from refunds where id = v_ref) <> 'processing' then raise exception 'FAIL fixture is not processing'; end if;
  if (select needs_bank_details from refunds where id = v_ref) then raise exception 'FAIL flag set before Paystack said so'; end if;

  perform mark_refund_needs_details(v_ref, '4242', 'Paystack needs the customer''s bank details');
  select * into f from refunds where id = v_ref;
  if not f.needs_bank_details or f.provider_refund_id <> '4242' or f.details_retry_started_at is not null
     or f.attention_note not like 'Paystack needs%' then raise exception 'FAIL marked state %', f; end if;
  if not exists (select 1 from audit_logs where entity_id = v_ref and action = 'refund.needs_bank_details') then raise exception 'FAIL mark audit'; end if;

  -- a blank provider id must not erase the one we have
  perform mark_refund_needs_details(v_ref, ' ', 'again');
  if (select provider_refund_id from refunds where id = v_ref) <> '4242' then raise exception 'FAIL provider id erased'; end if;
  perform mark_refund_needs_details(v_ref, '4242', 'Paystack needs the customer''s bank details');

  -- a refund that is not processing is left alone
  perform mark_refund_needs_details(v_other, '9', 'ignored');
  if (select needs_bank_details from refunds where id = v_other) or (select provider_refund_id from refunds where id = v_other) is not null
    then raise exception 'FAIL marked a refund that is not processing'; end if;
  raise notice 'PASS needs-attention marks only a processing refund and keeps the provider refund id';
end $$;

-- 2. Exactly one staff caller may send the details, and only someone with refund.approve at that hotel
do $$ declare v_ref uuid; v_other uuid; a jsonb; b jsonb; begin
  select refund, other into v_ref, v_other from t20_ctx;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select start_refund_details_retry(%L)', v_ref), 'NOT_FOUND');      -- front desk
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select start_refund_details_retry(%L)', v_ref), 'NOT_FOUND');      -- another hotel
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select start_refund_details_retry(%L)', v_other), 'INVALID_STATE: refund is not waiting for bank details');
  a := start_refund_details_retry(v_ref);
  b := start_refund_details_retry(v_ref);
  perform t_sys();
  if (a ->> 'call_allowed') <> 'true' or (b ->> 'call_allowed') <> 'false' or a ->> 'provider_refund_id' <> '4242' or a ->> 'currency' is null
    then raise exception 'FAIL retry guard % %', a, b; end if;
  if (select details_retry_started_at from refunds where id = v_ref) is null then raise exception 'FAIL retry not stamped'; end if;
  if not exists (select 1 from audit_logs where entity_id = v_ref and action = 'refund.bank_details_retry_started'
                  and actor_user_id = '00000000-0000-0000-0000-00000000aa01') then raise exception 'FAIL retry audit'; end if;
  raise notice 'PASS one caller per retry; front desk, another hotel and a refund not waiting are refused';
end $$;

-- 3. Outcomes: rejected frees the retry, unknown keeps it used, accepted clears the state
do $$ declare v_ref uuid; a jsonb; begin
  select refund into v_ref from t20_ctx;
  perform finish_refund_details_retry(v_ref, 'rejected', 'Paystack refused the bank details: invalid account');
  if (select details_retry_started_at from refunds where id = v_ref) is not null or not (select needs_bank_details from refunds where id = v_ref)
     or (select attention_note from refunds where id = v_ref) not like '%invalid account' then raise exception 'FAIL rejected state'; end if;

  perform t_as('00000000-0000-0000-0000-00000000aa01');
  a := start_refund_details_retry(v_ref);
  perform t_sys();
  if (a ->> 'call_allowed') <> 'true' then raise exception 'FAIL retry not allowed again after a refusal %', a; end if;

  perform finish_refund_details_retry(v_ref, 'unknown', 'outcome unknown: timeout. Check Paystack.');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  a := start_refund_details_retry(v_ref);
  perform t_sys();
  if (a ->> 'call_allowed') <> 'false' then raise exception 'FAIL unknown outcome allowed a second send %', a; end if;
  if (select attention_note from refunds where id = v_ref) not like 'outcome unknown%' then raise exception 'FAIL unknown note'; end if;

  -- Paystack reports needs-attention again: a person may try once more
  perform mark_refund_needs_details(v_ref, null, 'Paystack still needs bank details');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  a := start_refund_details_retry(v_ref);
  perform t_sys();
  if (a ->> 'call_allowed') <> 'true' then raise exception 'FAIL re-reported state did not reopen the retry %', a; end if;

  perform finish_refund_details_retry(v_ref, 'accepted', null);
  if (select needs_bank_details from refunds where id = v_ref) or (select attention_note from refunds where id = v_ref) is not null
     or (select refund_status from refunds where id = v_ref) <> 'processing' then raise exception 'FAIL accepted state'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select start_refund_details_retry(%L)', v_ref), 'INVALID_STATE: refund is not waiting for bank details');
  perform t_sys();
  begin perform finish_refund_details_retry(v_ref, 'bogus', null); raise exception 'FAIL bad outcome accepted';
  exception when sqlstate 'P0001' then if sqlerrm not like 'POLICY_VIOLATION: retry outcome%' then raise; end if; end;
  raise notice 'PASS outcomes: a refusal frees the retry, an unknown answer keeps it used, acceptance clears the state';
end $$;

-- 4. Nothing about the account is stored: audit rows for this refund carry outcomes and notes only
do $$ declare v_ref uuid; begin
  select refund into v_ref from t20_ctx;
  if exists (select 1 from audit_logs where entity_id = v_ref and action like 'refund.bank_details_%'
              and (metadata ? 'account_number' or metadata ? 'bank_id' or metadata::text ~ '[0-9]{10}')) then raise exception 'FAIL account detail in audit'; end if;
  if exists (select 1 from information_schema.columns where table_name = 'refunds' and column_name ~ 'account|bank_id|iban') then
    raise exception 'FAIL refunds has a column for account details'; end if;
  raise notice 'PASS no account details are stored on the refund or in the audit log';
end $$;

-- 5. A refund that leaves processing no longer needs details
do $$ declare v_ref uuid; begin
  select refund into v_ref from t20_ctx;
  perform mark_refund_needs_details(v_ref, '4242', 'needs details again');
  perform record_refund_result('paystack', 't20-processed', v_ref, 'succeeded', '4242', null, '{}'::jsonb);
  if (select refund_status from refunds where id = v_ref) <> 'succeeded' or (select needs_bank_details from refunds where id = v_ref)
    then raise exception 'FAIL flag survived the refund closing'; end if;
  raise notice 'PASS closing a refund clears the needs-details flag';
end $$;

-- 6. Closed to the wrong callers
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000aa01';
do $$ begin
  begin perform mark_refund_needs_details(gen_random_uuid(), '1', 'x'); raise exception 'FAIL authenticated mark'; exception when insufficient_privilege then null; end;
  begin perform finish_refund_details_retry(gen_random_uuid(), 'accepted', null); raise exception 'FAIL authenticated finish'; exception when insufficient_privilege then null; end;
end $$;
rollback;
begin;
set local role anon;
do $$ begin
  begin perform start_refund_details_retry(gen_random_uuid()); raise exception 'FAIL anon start'; exception when insufficient_privilege then null; end;
end $$;
rollback;
do $$ begin raise notice 'PASS retry functions are closed to the wrong callers'; end $$;
