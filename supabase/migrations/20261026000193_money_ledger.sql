-- 193 The money ledger: every payment and refund, one row each, for the accountant.
--
-- The daily report (`daily_report`) gives one row per DAY. An accountant works from the entries behind those totals: what was received,
-- when, how, against which booking and guest, and what was paid back. `money_ledger` returns exactly those entries for a date range.
--
-- It follows the day report's own rules, so the two always agree (a test proves it for every day in the test database):
--   * received: `payments` (booking money, which already includes each share of a company payment: `record_group_payment` splits it
--     into ordinary payments, so nothing is counted twice) and `folio_payments` (extras), only `payment_status = 'succeeded'`, dated by
--     `received_at` on the hotel's own calendar day (its timezone), the same way the report dates it;
--   * paid back: `refunds` with `refund_status = 'succeeded'` and a `completed_at`, dated by `completed_at`, shown as a NEGATIVE amount.
--   Pending, failed and reversed entries are not listed, because the report does not count them either.
--   All currencies are listed (a `currency` column says which); the day report counts the hotel's own currency, so add up one
--   currency at a time. Amounts are in minor units (kobo), as everywhere in the database.
--
-- Columns: entry_at (exact time), entry_day (the hotel's calendar day), kind ('booking_payment', 'extras_payment', 'refund'), the
-- internal reference and the provider's reference, the booking reference, the booking's main guest, method (cash, bank_transfer,
-- pos, ... for a refund the provider that paid it back is not stored, so null), provider (the online provider of a booking payment),
-- group_reference (the company payment this booking payment was a share of, when it was), amount_minor, currency, note.
--
-- Permission: `report.export` at the hotel (the same right as the report download, so a hotel that switched `reports.export` off
-- gets nothing here either) and NOT_FOUND otherwise, so nobody learns that a hotel exists. It lists guest names, which is why the right
-- is the export one and not `report.view`. Range: at most 366 days, as the report. Authenticated only, no anon.

create function money_ledger(p_property uuid, p_from date, p_to date)
returns table (
  entry_at timestamptz, entry_day date, kind text, internal_reference text, provider_reference text,
  booking_reference text, guest_name text, method text, provider text, group_reference text,
  amount_minor bigint, currency text, note text
) language plpgsql stable security definer set search_path = public as $$
declare v_tz text;
begin
  perform require_permission(p_property, 'report.export', 'NOT_FOUND');
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    raise exception 'POLICY_VIOLATION: report range' using errcode = 'P0001';
  end if;
  select timezone into v_tz from properties where id = p_property;

  return query
  select x.entry_at, (x.entry_at at time zone v_tz)::date, x.kind, x.internal_reference, x.provider_reference,
         r.booking_reference, g.full_name, x.method, x.provider, x.group_reference, x.amount_minor, x.currency, x.note
    from (
      select p.received_at as entry_at, 'booking_payment'::text as kind, p.internal_reference, p.provider_reference, p.reservation_id,
             p.payment_method as method, p.payment_provider as provider, gp.reference as group_reference,
             p.amount_minor, p.currency::text as currency, p.note
        from payments p
        left join group_payment_lines gl on gl.payment_id = p.id
        left join group_payments gp on gp.id = gl.group_payment_id
       where p.property_id = p_property and p.payment_status = 'succeeded'
         and (p.received_at at time zone v_tz)::date between p_from and p_to
      union all
      select f.received_at, 'extras_payment', f.internal_reference, f.provider_reference, f.reservation_id,
             f.payment_method, null::text, null::text, f.amount_minor, f.currency::text, f.note
        from folio_payments f
       where f.property_id = p_property and f.payment_status = 'succeeded'
         and (f.received_at at time zone v_tz)::date between p_from and p_to
      union all
      select rf.completed_at, 'refund', rf.internal_reference, rf.provider_refund_id, rf.reservation_id,
             null::text, null::text, null::text, -rf.amount_minor, rf.currency::text, rf.reason
        from refunds rf
       where rf.property_id = p_property and rf.refund_status = 'succeeded' and rf.completed_at is not null
         and (rf.completed_at at time zone v_tz)::date between p_from and p_to
    ) x
    join reservations r on r.id = x.reservation_id
    left join guests g on g.id = r.primary_guest_id
   order by x.entry_at, x.kind, x.internal_reference;
end $$;
revoke all on function money_ledger(uuid, date, date) from public, anon;
grant execute on function money_ledger(uuid, date, date) to authenticated;
