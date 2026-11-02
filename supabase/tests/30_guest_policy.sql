-- guest_policy (migration 032). Reuses the hosts made in 06: book.hotel-a.test (property A), hotel-b.test (Hotel B),
-- draft.hotel-a.test (not verified). Policy version 1 for property A comes from 05 and carries cancellation rules only.
\set ON_ERROR_STOP on

-- 1. The policy in force at the host's property, with the defaults for what it does not set
do $$ declare r jsonb; begin
  r := guest_policy('book.hotel-a.test');
  if jsonb_array_length(r -> 'cancellation_rules') <> 2
     or (r #>> '{cancellation_rules,0,charge,type}') <> 'nights'
     or r #>> '{online_payment,mode}' <> 'full'
     or r ->> 'checkin_payment' <> 'none'
     or r ->> 'currency' is null then
    raise exception 'FAIL guest policy %', r;
  end if;
  raise notice 'PASS guest_policy returns the rules in force and the defaults for what is not set';
end $$;

-- 2. Keys a guest does not need are not returned
do $$ declare r jsonb; begin
  r := guest_policy('book.hotel-a.test');
  if (select count(*) from jsonb_object_keys(r)) <> 4
     or not (r ?& array['currency','cancellation_rules','online_payment','checkin_payment']) then
    raise exception 'FAIL extra keys %', r;
  end if;
  raise notice 'PASS guest_policy returns only the four keys guests need';
end $$;

-- 3. Another hotel sees its own (empty) policy, never this one's; an unverified or unknown host finds nothing
do $$ declare r jsonb; begin
  r := guest_policy('hotel-b.test');
  if jsonb_array_length(r -> 'cancellation_rules') <> 0 or r #>> '{online_payment,mode}' <> 'full' then raise exception 'FAIL hotel B policy %', r; end if;
  begin perform guest_policy('draft.hotel-a.test'); raise exception 'FAIL unverified host';
  exception when sqlstate 'P0001' then null; end;
  begin perform guest_policy('nowhere.test'); raise exception 'FAIL unknown host';
  exception when sqlstate 'P0001' then null; end;
  raise notice 'PASS guest_policy is scoped to the host: other hotels and unverified hosts get nothing of this one';
end $$;

-- 4. Closed to everyone but service_role
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000aa01';
do $$ begin
  begin perform guest_policy('book.hotel-a.test'); raise exception 'FAIL authenticated guest_policy';
  exception when insufficient_privilege then null; end;
end $$;
rollback;
do $$ begin raise notice 'PASS guest_policy is closed to authenticated callers'; end $$;
