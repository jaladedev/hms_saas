-- hotel_billing (migration 103). Hotel A: tenant ...a1, property ...a2; owner aa01, front desk aa04, Hotel B owner bb01.
\set ON_ERROR_STOP on

do $$ declare
  v_t constant uuid := '00000000-0000-0000-0000-0000000000a1'; v_tb constant uuid := '00000000-0000-0000-0000-0000000000b1';
  v_a constant uuid := '00000000-0000-0000-0000-0000000000a2'; r jsonb;
begin
  perform t_sys();
  delete from platform_invoices where number like 'PI-T103-%';
  insert into platform_invoices (tenant_id, number, plan_code, period_start, period_end, amount_minor, status, due_date, note, paid_at, payment_ref, void_reason) values
    (v_t, 'PI-T103-000001', 'standard', '2031-01-01', '2031-02-01', 3500000, 'paid', '2031-01-15', 'January', now(), 'TRF-1', null),
    (v_t, 'PI-T103-000002', 'standard', '2031-02-01', '2031-03-01', 3500000, 'void', null, null, null, null, 'raised in error'),
    (v_tb, 'PI-T103-000003', 'standard', '2031-01-01', '2031-02-01', 9900000, 'open', null, null, null, null, null);

  -- who may look
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select hotel_billing(%L)', v_a), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select hotel_billing(%L)', v_a), 'NOT_FOUND');
  perform t_expect(format('select hotel_billing(%L)', gen_random_uuid()), 'NOT_FOUND');

  -- the owner sees this group's invoices only, without void ones or anything internal
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  r := hotel_billing(v_a);
  if not (r -> 'invoices') @> '[{"number":"PI-T103-000001","status":"paid","payment_ref":"TRF-1","amount_minor":3500000}]'::jsonb then raise exception 'FAIL own invoice missing %', r; end if;
  if r::text like '%PI-T103-000002%' or r::text like '%raised in error%' then raise exception 'FAIL a void invoice or its reason shown'; end if;
  if r::text like '%PI-T103-000003%' then raise exception 'FAIL another group''s invoice shown'; end if;
  if r::text like '%created_by%' or r::text like '%tenant_id%' then raise exception 'FAIL internal field shown'; end if;
  perform t_sys();
  delete from platform_invoices where number like 'PI-T103-%';
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  if jsonb_array_length(hotel_billing(v_a) -> 'invoices') <> 0 then raise exception 'FAIL expected no invoices'; end if;
  raise notice 'PASS hotel_billing: owner sees own non-void invoices only; front desk, other hotel and unknown refused';
end $$;

do $$ declare v_state text; begin
  perform t_sys();
  begin set local role anon; perform hotel_billing('00000000-0000-0000-0000-0000000000a2'); v_state := 'allowed';
  exception when insufficient_privilege then v_state := 'refused'; end;
  reset role;
  if v_state <> 'refused' then raise exception 'FAIL anon could read billing'; end if;
  raise notice 'PASS hotel_billing: anon refused';
end $$;
