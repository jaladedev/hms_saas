-- platform_open_invoices (migration 116). Platform people from 51: f050 admin, f051 support, f052 an ordinary hotel owner; group 't50-hotel'.
\set ON_ERROR_STOP on

do $$ declare v_t uuid := (select id from tenants where slug = 't50-hotel'); l jsonb; v_a uuid; v_b uuid; v_c uuid; v_n0 int;
begin
  perform t_sys();
  select count(*) into v_n0 from platform_invoices where status = 'open';
  insert into platform_invoices (tenant_id, number, period_start, period_end, amount_minor, due_date) values
    (v_t, 'PI-T116-A', '2031-01-01', '2031-02-01', 100, '2031-02-10') returning id into v_a;
  insert into platform_invoices (tenant_id, number, period_start, period_end, amount_minor, due_date) values
    (v_t, 'PI-T116-B', '2031-02-01', '2031-03-01', 200, '2031-01-05') returning id into v_b;
  insert into platform_invoices (tenant_id, number, period_start, period_end, amount_minor, due_date) values
    (v_t, 'PI-T116-C', '2031-03-01', '2031-04-01', 300, null) returning id into v_c;
  insert into platform_invoices (tenant_id, number, period_start, period_end, amount_minor, status, paid_at, payment_ref) values
    (v_t, 'PI-T116-P', '2031-04-01', '2031-05-01', 400, 'paid', now(), 'ref');
  insert into platform_invoices (tenant_id, number, period_start, period_end, amount_minor, status, void_reason) values
    (v_t, 'PI-T116-V', '2031-05-01', '2031-06-01', 500, 'void', 'raised in error');

  perform t_as('00000000-0000-0000-0000-00000000f051');   -- support reads
  l := platform_open_invoices();
  if jsonb_array_length(l) <> v_n0 + 3 then raise exception 'FAIL expected % open invoices, got %', v_n0 + 3, jsonb_array_length(l); end if;
  -- ours are in due order: B (earliest due) before A, then C (no due date) after both
  if not (
       (select ord from jsonb_array_elements(l) with ordinality as e(v, ord) where v ->> 'number' = 'PI-T116-B') <
       (select ord from jsonb_array_elements(l) with ordinality as e(v, ord) where v ->> 'number' = 'PI-T116-A')
   and (select ord from jsonb_array_elements(l) with ordinality as e(v, ord) where v ->> 'number' = 'PI-T116-A') <
       (select ord from jsonb_array_elements(l) with ordinality as e(v, ord) where v ->> 'number' = 'PI-T116-C')) then
    raise exception 'FAIL order %', l;
  end if;
  if l::text ~ 'PI-T116-P|PI-T116-V' then raise exception 'FAIL a paid or void invoice was listed'; end if;
  if (select v ->> 'tenant_name' from jsonb_array_elements(l) e(v) where v ->> 'number' = 'PI-T116-A') is null then raise exception 'FAIL no group name'; end if;

  perform t_as('00000000-0000-0000-0000-00000000f050');
  if jsonb_array_length(platform_open_invoices()) <> v_n0 + 3 then raise exception 'FAIL admin list'; end if;
  perform t_as('00000000-0000-0000-0000-00000000f052');   -- a hotel owner, not platform staff
  perform t_expect('select platform_open_invoices()', 'NOT_FOUND');
  reset role;
  perform t_sys();
  delete from platform_invoices where number like 'PI-T116-%';
  raise notice 'PASS platform open invoices: open only, oldest due first, support and admin read, hotel owner refused';
end $$;
