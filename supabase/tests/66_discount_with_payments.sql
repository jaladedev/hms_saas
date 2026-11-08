-- Discounts on a booking that already has money (migration 065). Reuses t_as, t_sys, t_expect, t_book, t59_disc (59), t63_amt (63).
\set ON_ERROR_STOP on

do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); b jsonb; res uuid; total bigint; r jsonb; paid bigint; d bigint;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  b := t_book('00000000-0000-0000-0000-0000000000a3', t + 1400, t + 1402, 'dp-1'); res := (b ->> 'reservation_id')::uuid;
  perform t_sys(); select total_minor into total from reservations where id = res;
  paid := total / 2;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform record_manual_payment(res, paid, 'cash', null, null, 'dp-1-p');
  -- a deposit does not block a percentage discount that leaves the price above the deposit
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  r := t59_disc(res, 10, 'loyal guest', 'dp-1-d');
  perform t_sys();
  select discount_minor into d from reservations where id = res;
  if (r ->> 'changed')::boolean is not true or (select total_minor from reservations where id = res) <> total - d then raise exception 'FAIL discount with a deposit: %', r; end if;
  if (select payment_status from reservations where id = res) <> 'partially_paid' then raise exception 'FAIL payment status after discount'; end if;
  -- an amount that would take the price below what was paid is refused, nothing changes
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select t63_amt(%L, %s, %L, %L)', res, total - paid + 1, 'too much', 'dp-1-e'), 'POLICY_VIOLATION: below paid');
  perform t_sys();
  if (select discount_minor from reservations where id = res) <> d then raise exception 'FAIL a refused discount changed the booking'; end if;
  -- an amount exactly down to the deposit is allowed and the booking becomes paid
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t63_amt(res, total - paid, 'settle at the deposit', 'dp-1-f');
  perform t_sys();
  if (select payment_status from reservations where id = res) <> 'paid' or (select total_minor from reservations where id = res) <> paid then raise exception 'FAIL booking not paid at the deposit'; end if;
  -- removing the discount puts the balance back
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t59_disc(res, 0, 'removed', 'dp-1-g');
  perform t_sys();
  if (select payment_status from reservations where id = res) <> 'partially_paid' or (select total_minor from reservations where id = res) <> total then raise exception 'FAIL removal with money held'; end if;
  -- a live invoice still blocks it
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform issue_invoice(res, 'dp-1-i');
  perform t_expect(format('select t59_disc(%L, 5, %L, %L)', res, 'x', 'dp-1-h'), 'INVALID_STATE: invoice');
  perform t_sys();
  raise notice 'PASS discounts with money held: allowed down to what is paid, refused below it, status follows the total, an invoice still blocks';
end $$;
