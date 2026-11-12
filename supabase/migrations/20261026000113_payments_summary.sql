-- 113 Money position at a glance (prototype "Payments Overview" tiles: Total Paid, Pending Verification, Refunds).
--
-- One read-only function that totals the payments and refunds the caller can already see. It is SECURITY INVOKER on purpose: the
-- row level security on payments (can_view_money) and refunds already decides which rows a person may read, so a person who may
-- see no money gets empty lists, a hotel group sees only its own, and no permission rule is repeated here to drift out of step.
--
-- payments_summary(p_from, p_to) returns four lists, each one row per currency (never summed across currencies):
--   received      payments that succeeded and were received in [p_from, p_to), either end may be null for "no limit":
--                 {currency, amount_minor, count}. This is money taken before any refund, which is counted separately below.
--   unverified    succeeded payments still waiting to be checked against the bank (all time: they are work to do, not history)
--   refunds_open  refunds asked for or being paid out but not finished: requested, approved or processing (all time)
--   refunded      refunds that succeeded and completed in [p_from, p_to)
-- Reversed payments and rejected or failed refunds are in none of them.
--
-- There is deliberately no "outstanding" figure: what a guest still owes mixes the room total, extras on the folio and deposits,
-- and the settlement page already shows it exactly for one booking. A number summed here would be a second, different answer.

create function payments_summary(p_from timestamptz default null, p_to timestamptz default null) returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object(
    'received', coalesce((
      select jsonb_agg(jsonb_build_object('currency', currency, 'amount_minor', amount, 'count', n) order by currency)
        from (select currency::text as currency, sum(amount_minor)::bigint as amount, count(*)::int as n
                from payments
               where payment_status = 'succeeded'
                 and (p_from is null or received_at >= p_from) and (p_to is null or received_at < p_to)
               group by currency) s), '[]'::jsonb),
    'unverified', coalesce((
      select jsonb_agg(jsonb_build_object('currency', currency, 'amount_minor', amount, 'count', n) order by currency)
        from (select currency::text as currency, sum(amount_minor)::bigint as amount, count(*)::int as n
                from payments
               where payment_status = 'succeeded' and verification_status = 'unverified'
               group by currency) s), '[]'::jsonb),
    'refunds_open', coalesce((
      select jsonb_agg(jsonb_build_object('currency', currency, 'amount_minor', amount, 'count', n) order by currency)
        from (select currency::text as currency, sum(amount_minor)::bigint as amount, count(*)::int as n
                from refunds
               where refund_status in ('requested', 'approved', 'processing')
               group by currency) s), '[]'::jsonb),
    'refunded', coalesce((
      select jsonb_agg(jsonb_build_object('currency', currency, 'amount_minor', amount, 'count', n) order by currency)
        from (select currency::text as currency, sum(amount_minor)::bigint as amount, count(*)::int as n
                from refunds
               where refund_status = 'succeeded'
                 and (p_from is null or completed_at >= p_from) and (p_to is null or completed_at < p_to)
               group by currency) s), '[]'::jsonb));
$$;
revoke all on function payments_summary(timestamptz, timestamptz) from public, anon;
grant execute on function payments_summary(timestamptz, timestamptz) to authenticated;
