-- Group bookings, step seven (migration 157): credit limit on a company account, and the overdue list. Hotel A as in tests 149 to 156.
\set ON_ERROR_STOP on

do $$ declare
  v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_c uuid; v_g uuid; e jsonb; ra text; rb text; rc text; ta bigint; tb bigint; i1 jsonb; i2 jsonb; o jsonb;
  v_exp bigint; v_over bigint; v_id uuid; l jsonb;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select company_create(%L, ''Lim Co'', ''Ada'', null, null, 30, 0, null, 0)', v_p), 'POLICY_VIOLATION: details');
  v_c := (company_create(v_p, 'Limit Co', 'Tola', null, null, 14, 0, null, null)::jsonb ->> 'company_id')::uuid;
  v_g := (t149_group('Limit Group', 3, 0, 900, 4, 890)::jsonb ->> 'group_id')::uuid;
  perform set_group_company(v_g, v_c);
  ra := t150_ref(900, 902, 'g157-a'); rb := t150_ref(900, 903, 'g157-b'); rc := t150_ref(901, 903, 'g157-c');
  e := add_rooming_entry(v_g, 'A', null, null); perform link_rooming_reservation((e ->> 'entry_id')::uuid, ra);
  e := add_rooming_entry(v_g, 'B', null, null); perform link_rooming_reservation((e ->> 'entry_id')::uuid, rb);
  perform t_sys();
  update reservations set reservation_status = 'confirmed' where booking_reference in (ra, rb, rc);
  select total_minor into ta from reservations where booking_reference = ra;
  select total_minor into tb from reservations where booking_reference = rb;
  perform t_as('00000000-0000-0000-0000-00000000aa01');

  -- no limit yet
  l := company_list(v_p);
  if (select (x ->> 'credit_limit_minor') is not null from jsonb_array_elements(l) x where x ->> 'id' = v_c::text) then raise exception 'FAIL limit should be empty'; end if;

  -- a limit below what A and B come to: the invoice is refused and leaves nothing behind
  perform company_update(v_c, 'Tola', null, null, 14, 0, null, 'active', ta + tb - 1);
  if (select (x ->> 'credit_limit_minor')::bigint from jsonb_array_elements(company_list(v_p)) x where x ->> 'id' = v_c::text) <> ta + tb - 1 then raise exception 'FAIL limit not saved'; end if;
  perform t_expect(format('select issue_group_invoice(%L, current_date + 14, ''cl-1'')', v_g), 'POLICY_VIOLATION: credit limit ' || (ta + tb - 1));
  if (select count(*) from group_invoices where group_id = v_g) <> 0 then raise exception 'FAIL refused invoice left a row'; end if;

  -- a limit that just covers both: issues, and the exposure shows
  perform company_update(v_c, 'Tola', null, null, 14, 0, null, 'active', ta + tb);
  i1 := issue_group_invoice(v_g, current_date + 14, 'cl-2');
  select (x ->> 'exposure_minor')::bigint, (x ->> 'overdue_minor')::bigint into v_exp, v_over from jsonb_array_elements(company_list(v_p)) x where x ->> 'id' = v_c::text;
  if v_exp <> ta + tb or v_over <> 0 then raise exception 'FAIL exposure % %', v_exp, v_over; end if;

  -- a third booking would go over the limit (nothing is left)
  e := add_rooming_entry(v_g, 'C', null, null); perform link_rooming_reservation((e ->> 'entry_id')::uuid, rc);
  perform t_expect(format('select issue_group_invoice(%L, current_date + 14, ''cl-3'')', v_g), 'POLICY_VIOLATION: credit limit 0');

  -- only an owner or general manager changes the limit
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select company_update(%L, ''x'', null, null, 14, 0, null, ''active'', 1000)', v_c), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');

  -- marking the first invoice paid lowers the exposure, so the third booking fits
  perform mark_group_invoice_paid((i1 ->> 'group_invoice_id')::uuid, 'bank_transfer', 'TRF-1');
  i2 := issue_group_invoice(v_g, current_date + 14, 'cl-3');
  if (i2 ->> 'line_count')::int <> 1 then raise exception 'FAIL third invoice %', i2; end if;

  -- overdue: an issued invoice whose due date has passed is listed with its days overdue
  v_id := (i2 ->> 'group_invoice_id')::uuid;
  perform t_sys();
  alter table group_invoices disable trigger group_invoices_guard_trg;
  update group_invoices set due_date = current_date - 3 where id = v_id;
  alter table group_invoices enable trigger group_invoices_guard_trg;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  o := group_invoice_overdue(v_p);
  if jsonb_array_length(o) <> 1 or (o -> 0 ->> 'days_overdue')::int < 3 or o -> 0 ->> 'bill_to' <> 'Tola' and o -> 0 ->> 'bill_to' <> 'Limit Co' then raise exception 'FAIL overdue %', o; end if;
  select (x ->> 'overdue_minor')::bigint into v_over from jsonb_array_elements(company_list(v_p)) x where x ->> 'id' = v_c::text;
  if v_over <= 0 then raise exception 'FAIL overdue amount'; end if;
  perform mark_group_invoice_paid(v_id, 'cash', null);
  if jsonb_array_length(group_invoice_overdue(v_p)) <> 0 then raise exception 'FAIL paid invoice still overdue'; end if;

  -- no limit at all: never refused; and who may read the list
  perform company_update(v_c, 'Tola', null, null, 14, 0, null, 'active', null);
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select group_invoice_overdue(%L)', v_p), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select group_invoice_overdue(%L)', v_p), 'NOT_FOUND');
  raise notice 'PASS group bookings step seven: credit limit blocks and leaves nothing, paid lowers exposure, only managers change it, overdue list';
end $$;
