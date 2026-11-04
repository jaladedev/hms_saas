-- Idempotency keys expire (migration 042): purge_old_operational_data() deletes keys older than 30 days, keeps newer ones,
-- reports the count, and a purged key runs as a new request.
\set ON_ERROR_STOP on

do $$ declare r jsonb; t constant uuid := '00000000-0000-0000-0000-0000000000a1'; n_before bigint; begin
  insert into idempotency_keys (tenant_id, operation, idempotency_key, request_hash, response, created_at, expires_at) values
    (t, 't43', 'old-1',    'h', '{"x":1}', now() - interval '31 days', now() - interval '30 days'),
    (t, 't43', 'old-2',    'h', null,      now() - interval '90 days', now() - interval '89 days'),
    (t, 't43', 'edge',     'h', '{"x":1}', now() - interval '29 days', now() - interval '28 days'),
    (t, 't43', 'fresh',    'h', '{"x":1}', now(), now() + interval '24 hours');
  select count(*) into n_before from idempotency_keys;

  r := purge_old_operational_data();
  if (r ->> 'idempotency_keys')::int <> 2 then raise exception 'FAIL purge reported %', r; end if;
  if not (r ?& array['rate_limit_rows','emails','idempotency_keys']) then raise exception 'FAIL purge keys %', r; end if;
  if exists (select 1 from idempotency_keys where operation = 't43' and idempotency_key in ('old-1','old-2')) then raise exception 'FAIL old keys remain'; end if;
  if (select count(*) from idempotency_keys where operation = 't43') <> 2 then raise exception 'FAIL a current key was removed'; end if;
  if (select count(*) from idempotency_keys) <> n_before - 2 then raise exception 'FAIL purge removed other keys'; end if;
  raise notice 'PASS purge deletes idempotency keys older than 30 days and keeps the rest';

  -- A purged key is a new request; a kept key still replays its stored answer.
  if not (select out_is_new from idem_begin(t, 't43', 'old-1', 'h')) then raise exception 'FAIL purged key not new'; end if;
  if (select out_is_new from idem_begin(t, 't43', 'fresh', 'h')) or (select out_response ->> 'x' from idem_begin(t, 't43', 'fresh', 'h')) <> '1' then
    raise exception 'FAIL kept key did not replay';
  end if;
  raise notice 'PASS a purged key runs as new and a kept key still replays';

  r := purge_old_operational_data();
  if (r ->> 'idempotency_keys')::int <> 0 then raise exception 'FAIL second purge %', r; end if;
  raise notice 'PASS a second purge finds nothing more';
end $$;
