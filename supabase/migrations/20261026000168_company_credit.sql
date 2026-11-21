-- 168 Group bookings, step eleven (TODO 8.7): a company credit balance (prepayment).
--
-- A company sometimes pays in advance, or pays more than it owes, and wants the rest kept for its next group. A company account now has a
-- balance of money the hotel holds for it, kept in an append-only ledger (company_credit_ledger):
--   deposit        + money received from the company with no booking to pay yet (method, reference, note). Needs group.manage, payment.record.
--   apply          - part of the balance used to pay a group of that company. It is an ordinary company payment (record_group_payment, 156), method
--                    'other' with reference 'Company credit', so every money rule, invoice allocation and report stays where it already lives and
--                    nothing is counted twice. It cannot exceed the balance or the group's outstanding amount (the balance is locked while spending).
--   reverse_apply  + the balance comes back when that company payment is reversed (reverse_group_payment, replaced here to do it): it returns
--                    exactly what the reversed lines carried.
--   withdraw       - money given back to the company, or written off, with a reason. Needs group.manage and refund.approve. The balance never
--                    goes below zero.
-- Decisions: a balance belongs to one company account at one hotel and is in the hotel's currency. Depositing records no booking payment, so
-- the daily report counts a deposit only when it is used (as the payment on a booking): a deposit is liability, not revenue. The credit limit
-- (157) is unchanged and does not count the balance against what a company owes. A company payment recorded with a credit (apply) can be
-- reversed only through reverse_group_payment, which gives the credit back. Everything under the group_bookings flag and audited.
--
--   company_credit_deposit(company, amount_minor, method, reference, note, key)
--   company_credit_apply(group, amount_minor, key)           POLICY_VIOLATION: credit balance | company (the group has none) | amount
--   company_credit_withdraw(company, amount_minor, reason, key)
--   company_credit_balances(property)                        { company_id: balance_minor } for the hotel's companies
--   company_credit_ledger_list(company, limit)               newest first (up to 200), each with its running meaning by kind

create table company_credit_ledger (
  id               uuid primary key default gen_random_uuid(),
  seq              bigint generated always as identity,
  tenant_id        uuid not null,
  property_id      uuid not null,
  company_id       uuid not null,
  kind             text not null check (kind in ('deposit', 'apply', 'reverse_apply', 'withdraw')),
  amount_minor     bigint not null check (amount_minor <> 0),
  method           text check (method is null or method in ('cash', 'bank_transfer', 'pos', 'other')),
  reference        text check (reference is null or char_length(reference) <= 60),
  note             text check (note is null or char_length(note) between 1 and 200),
  group_id         uuid references group_bookings (id),
  group_payment_id uuid references group_payments (id),
  actor_user_id    uuid,
  created_at       timestamptz not null default now(),
  foreign key (company_id, property_id) references company_accounts (id, property_id),
  foreign key (tenant_id, property_id) references properties (tenant_id, id),
  check (
       (kind = 'deposit'       and amount_minor > 0 and method is not null and group_payment_id is null)
    or (kind = 'apply'         and amount_minor < 0 and group_payment_id is not null and group_id is not null)
    or (kind = 'reverse_apply' and amount_minor > 0 and group_payment_id is not null)
    or (kind = 'withdraw'      and amount_minor < 0 and note is not null)
  )
);
create index company_credit_company_idx on company_credit_ledger (company_id, seq desc);
create index company_credit_gp_idx on company_credit_ledger (group_payment_id) where group_payment_id is not null;
alter table company_credit_ledger enable row level security;
create policy company_credit_select on company_credit_ledger for select to authenticated
  using (has_permission(property_id, 'group.manage') and can_view_money(property_id));
revoke insert, update, delete on company_credit_ledger from authenticated, anon;
create function company_credit_history() returns trigger language plpgsql as $$
begin raise exception 'company_credit_ledger rows are kept as history' using errcode = '23514'; end $$;
create trigger company_credit_history_trg before update or delete on company_credit_ledger for each row execute function company_credit_history();
revoke all on function company_credit_history() from public, anon, authenticated;

create function company_credit_of(p_company uuid) returns bigint
language sql stable security definer set search_path = public as $$
  select coalesce(sum(amount_minor), 0)::bigint from company_credit_ledger where company_id = p_company
$$;
revoke all on function company_credit_of(uuid) from public, anon, authenticated;

create function company_credit_deposit(p_company uuid, p_amount_minor bigint, p_method text, p_reference text, p_note text, p_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c company_accounts%rowtype; g record; v_idem record; v_ref text := nullif(btrim(coalesce(p_reference, '')), ''); v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_id uuid; v_result jsonb;
begin
  select * into c from company_accounts where id = p_company;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  select * into g from group_guard(c.property_id);
  perform require_permission(c.property_id, 'payment.record', 'NOT_FOUND');
  if not can_view_money(c.property_id) then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if p_amount_minor is null or p_amount_minor <= 0 or p_amount_minor > 1000000000000 then raise exception 'POLICY_VIOLATION: amount' using errcode = 'P0001'; end if;
  if p_method is null or p_method not in ('cash', 'bank_transfer', 'pos', 'other') then raise exception 'POLICY_VIOLATION: method' using errcode = 'P0001'; end if;
  if (v_ref is not null and char_length(v_ref) > 60) or (v_note is not null and char_length(v_note) > 200) then raise exception 'POLICY_VIOLATION: details' using errcode = 'P0001'; end if;
  select * into v_idem from idem_begin(g.o_tenant, 'company_credit_deposit', p_key, md5(concat_ws('|', p_company, p_amount_minor, p_method, coalesce(v_ref, ''), coalesce(v_note, ''))));
  if not v_idem.out_is_new then return v_idem.out_response; end if;
  perform 1 from company_accounts where id = c.id for update;
  insert into company_credit_ledger (tenant_id, property_id, company_id, kind, amount_minor, method, reference, note, actor_user_id)
  values (c.tenant_id, c.property_id, c.id, 'deposit', p_amount_minor, p_method, v_ref, v_note, g.o_actor) returning id into v_id;
  v_result := jsonb_build_object('entry_id', v_id, 'balance_minor', company_credit_of(c.id));
  perform idem_finish(g.o_tenant, 'company_credit_deposit', p_key, v_result);
  perform write_audit(g.o_tenant, c.property_id, g.o_actor, 'company_credit.deposited', 'company_account', c.id, p_key,
                      jsonb_build_object('amount_minor', p_amount_minor, 'method', p_method));
  return v_result;
end $$;
revoke all on function company_credit_deposit(uuid, bigint, text, text, text, text) from public, anon;
grant execute on function company_credit_deposit(uuid, bigint, text, text, text, text) to authenticated;

create function company_credit_apply(p_group uuid, p_amount_minor bigint, p_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  b group_bookings%rowtype; g record; v_idem record; v_pay jsonb; v_gp uuid; v_bal bigint; v_result jsonb; c company_accounts%rowtype;
begin
  select * into b from group_bookings where id = p_group;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  select * into g from group_guard(b.property_id);
  perform require_permission(b.property_id, 'payment.record', 'NOT_FOUND');
  if not can_view_money(b.property_id) then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if b.company_id is null then raise exception 'POLICY_VIOLATION: company' using errcode = 'P0001'; end if;
  if p_amount_minor is null or p_amount_minor <= 0 or p_amount_minor > 1000000000000 then raise exception 'POLICY_VIOLATION: amount' using errcode = 'P0001'; end if;
  select * into v_idem from idem_begin(g.o_tenant, 'company_credit_apply', p_key, md5(concat_ws('|', p_group, p_amount_minor)));
  if not v_idem.out_is_new then return v_idem.out_response; end if;

  select * into c from company_accounts where id = b.company_id for update;       -- two spends of one balance queue here
  v_bal := company_credit_of(c.id);
  if p_amount_minor > v_bal then raise exception 'POLICY_VIOLATION: credit balance' using errcode = 'P0001'; end if;

  v_pay := record_group_payment(p_group, p_amount_minor, 'other', 'Company credit', 'Paid from the company''s credit balance', null, md5(p_key || ':credit'));
  v_gp := (v_pay ->> 'group_payment_id')::uuid;
  insert into company_credit_ledger (tenant_id, property_id, company_id, kind, amount_minor, group_id, group_payment_id, actor_user_id)
  values (c.tenant_id, c.property_id, c.id, 'apply', -p_amount_minor, p_group, v_gp, g.o_actor);

  v_result := jsonb_build_object('group_payment_id', v_gp, 'amount_minor', p_amount_minor, 'balance_minor', v_bal - p_amount_minor);
  perform idem_finish(g.o_tenant, 'company_credit_apply', p_key, v_result);
  perform write_audit(g.o_tenant, b.property_id, g.o_actor, 'company_credit.applied', 'group_booking', b.id, p_key,
                      jsonb_build_object('company_id', c.id, 'amount_minor', p_amount_minor, 'group_payment_id', v_gp));
  return v_result;
end $$;
revoke all on function company_credit_apply(uuid, bigint, text) from public, anon;
grant execute on function company_credit_apply(uuid, bigint, text) to authenticated;

create function company_credit_withdraw(p_company uuid, p_amount_minor bigint, p_reason text, p_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c company_accounts%rowtype; g record; v_idem record; v_reason text := nullif(btrim(coalesce(p_reason, '')), ''); v_bal bigint; v_result jsonb;
begin
  select * into c from company_accounts where id = p_company;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  select * into g from group_guard(c.property_id);
  perform require_permission(c.property_id, 'refund.approve', 'NOT_FOUND');
  if not can_view_money(c.property_id) then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if p_amount_minor is null or p_amount_minor <= 0 or p_amount_minor > 1000000000000 then raise exception 'POLICY_VIOLATION: amount' using errcode = 'P0001'; end if;
  if v_reason is null or char_length(v_reason) > 200 then raise exception 'POLICY_VIOLATION: reason' using errcode = 'P0001'; end if;
  select * into v_idem from idem_begin(g.o_tenant, 'company_credit_withdraw', p_key, md5(concat_ws('|', p_company, p_amount_minor, v_reason)));
  if not v_idem.out_is_new then return v_idem.out_response; end if;
  select * into c from company_accounts where id = c.id for update;
  v_bal := company_credit_of(c.id);
  if p_amount_minor > v_bal then raise exception 'POLICY_VIOLATION: credit balance' using errcode = 'P0001'; end if;
  insert into company_credit_ledger (tenant_id, property_id, company_id, kind, amount_minor, note, actor_user_id)
  values (c.tenant_id, c.property_id, c.id, 'withdraw', -p_amount_minor, v_reason, g.o_actor);
  v_result := jsonb_build_object('balance_minor', v_bal - p_amount_minor);
  perform idem_finish(g.o_tenant, 'company_credit_withdraw', p_key, v_result);
  perform write_audit(g.o_tenant, c.property_id, g.o_actor, 'company_credit.withdrawn', 'company_account', c.id, p_key,
                      jsonb_build_object('amount_minor', p_amount_minor, 'reason', v_reason));
  return v_result;
end $$;
revoke all on function company_credit_withdraw(uuid, bigint, text, text) from public, anon;
grant execute on function company_credit_withdraw(uuid, bigint, text, text) to authenticated;

-- Reversing a company payment that was paid from credit gives the credit back. Same function as 156 with the credit step added; what it
-- restores is the amount of the lines it reverses now, never more than was applied and not yet restored.
create or replace function reverse_group_payment(p_group_payment uuid, p_reason text, p_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  gp group_payments%rowtype; g record; v_idem record; v_reason text := nullif(btrim(coalesce(p_reason, '')), ''); l record; v_n integer := 0; v_result jsonb;
  v_back bigint := 0; ap company_credit_ledger%rowtype; v_left bigint;
begin
  select * into gp from group_payments where id = p_group_payment;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  select * into g from group_guard(gp.property_id);
  perform require_permission(gp.property_id, 'refund.approve', 'NOT_FOUND');
  if v_reason is null or char_length(v_reason) > 200 then raise exception 'POLICY_VIOLATION: reason' using errcode = 'P0001'; end if;
  select * into v_idem from idem_begin(g.o_tenant, 'reverse_group_payment', p_key, md5(p_group_payment::text || '|' || v_reason));
  if not v_idem.out_is_new then return v_idem.out_response; end if;

  for l in select pl.payment_id, pl.amount_minor from group_payment_lines pl join payments p on p.id = pl.payment_id
            where pl.group_payment_id = gp.id and p.payment_status = 'succeeded' order by pl.id loop
    perform reverse_payment(l.payment_id, left('Group payment reversed: ' || v_reason, 250), md5(p_key || ':' || l.payment_id::text));
    v_n := v_n + 1;
    v_back := v_back + l.amount_minor;
  end loop;
  if v_n = 0 then raise exception 'INVALID_STATE: reversed' using errcode = 'P0001'; end if;

  select * into ap from company_credit_ledger where group_payment_id = gp.id and kind = 'apply';
  if found then
    perform 1 from company_accounts where id = ap.company_id for update;
    select (-ap.amount_minor) - coalesce(sum(amount_minor), 0) into v_left from company_credit_ledger where group_payment_id = gp.id and kind = 'reverse_apply';
    v_back := least(v_back, v_left);
    if v_back > 0 then
      insert into company_credit_ledger (tenant_id, property_id, company_id, kind, amount_minor, group_id, group_payment_id, note, actor_user_id)
      values (ap.tenant_id, ap.property_id, ap.company_id, 'reverse_apply', v_back, ap.group_id, gp.id, left('Payment reversed: ' || v_reason, 200), g.o_actor);
    end if;
  end if;

  v_result := jsonb_build_object('group_payment_id', gp.id, 'reversed', v_n);
  perform idem_finish(g.o_tenant, 'reverse_group_payment', p_key, v_result);
  perform write_audit(g.o_tenant, gp.property_id, g.o_actor, 'group_payment.reversed', 'group_payment', gp.id, p_key, jsonb_build_object('reason', v_reason, 'lines', v_n));
  return v_result;
end $$;

create function company_credit_balances(p_property uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if p_property is null or not has_permission(p_property, 'group.manage') or not can_view_money(p_property) then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  return coalesce((select jsonb_object_agg(c.id::text, company_credit_of(c.id)) from company_accounts c where c.property_id = p_property), '{}'::jsonb);
end $$;
revoke all on function company_credit_balances(uuid) from public, anon;
grant execute on function company_credit_balances(uuid) to authenticated;

create function company_credit_ledger_list(p_company uuid, p_limit integer default 50) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare c company_accounts%rowtype;
begin
  select * into c from company_accounts where id = p_company;
  if not found or not has_permission(c.property_id, 'group.manage') or not can_view_money(c.property_id) then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('kind', x.kind, 'amount_minor', x.amount_minor, 'method', x.method, 'reference', x.reference, 'note', x.note,
                                        'group_name', gb.name, 'created_at', x.created_at) order by x.seq desc)
      from (select * from company_credit_ledger where company_id = c.id order by seq desc limit least(greatest(coalesce(p_limit, 50), 1), 200)) x
      left join group_bookings gb on gb.id = x.group_id), '[]'::jsonb);
end $$;
revoke all on function company_credit_ledger_list(uuid, integer) from public, anon;
grant execute on function company_credit_ledger_list(uuid, integer) to authenticated;
