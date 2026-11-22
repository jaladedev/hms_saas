-- Receipts on a payment (migration 178). Reuses t_as / t_sys / t_expect (05) and t07_res (07).
-- Users: aa01 owner A, aa02 housekeeping A (no money), aa04 front desk A (records payments), bb01 owner B (another group).
-- The bookings sit 1960 days ahead. The file store is outside the database: what is proven here is the table, who may read and
-- write it, the limits, that a receipt cannot hang off another property's payment, and that a payment is never changed by one.
\set ON_ERROR_STOP on

do $$
declare
  prop uuid := '00000000-0000-0000-0000-0000000000a2';
  owner uuid := '00000000-0000-0000-0000-00000000aa01'; hk uuid := '00000000-0000-0000-0000-00000000aa02';
  fd uuid := '00000000-0000-0000-0000-00000000aa04'; ob uuid := '00000000-0000-0000-0000-00000000bb01';
  res uuid; pay uuid; tenant uuid; other_prop uuid; other_tenant uuid;
  before_pay text; before_res text; n integer; r1 uuid; r2 uuid; r3 uuid; path text; u text;
  function_path text;
begin
  perform t_sys();
  select tenant_id into tenant from properties where id = prop;
  select id, tenant_id into other_prop, other_tenant from properties where tenant_id <> tenant order by id limit 1;
  if other_prop is null then raise exception 'FAIL setup: no second group'; end if;
  res := t07_res(1960, 2, 't178-b1');
  perform t_as(fd::text);
  perform record_manual_payment(res, 100000, 'bank_transfer', 'GTB slip 178', null, 't178-bank');
  perform t_sys();
  select id into pay from payments where reservation_id = res and payment_method = 'bank_transfer';
  before_pay := (select row_to_json(p)::text from payments p where id = pay);
  before_res := (select row_to_json(x)::text from reservations x where id = res);
  select count(*) into n from audit_logs where action like 'payment_receipt.%';
  if n <> 0 then raise exception 'FAIL receipts audited before any exist'; end if;

  -- 1. the desk attaches a receipt as itself; the audit names the path and who
  perform t_as(fd::text);
  path := tenant || '/' || prop || '/' || pay || '/' || gen_random_uuid() || '.jpg';
  insert into payment_receipts (tenant_id, property_id, payment_id, storage_path, content_type, size_bytes)
    values (tenant, prop, pay, path, 'image/jpeg', 200000) returning id into r1;
  perform t_sys();
  if (select uploaded_by from payment_receipts where id = r1) is distinct from fd then raise exception 'FAIL uploaded_by is not the desk user'; end if;
  if (select count(*) from audit_logs where action = 'payment_receipt.created' and entity_id = r1 and actor_user_id = fd) <> 1 then raise exception 'FAIL create not audited under the desk user'; end if;
  if (select metadata::text from audit_logs where action = 'payment_receipt.created' and entity_id = r1) not like '%' || path || '%' then raise exception 'FAIL audit lacks the path'; end if;

  -- 2. PDF and PNG too; a fourth file is refused; removing one makes room
  perform t_as(fd::text);
  insert into payment_receipts (tenant_id, property_id, payment_id, storage_path, content_type, size_bytes)
    values (tenant, prop, pay, tenant || '/' || prop || '/' || pay || '/' || gen_random_uuid() || '.pdf', 'application/pdf', 1) returning id into r2;
  insert into payment_receipts (tenant_id, property_id, payment_id, storage_path, content_type, size_bytes)
    values (tenant, prop, pay, tenant || '/' || prop || '/' || pay || '/' || gen_random_uuid() || '.png', 'image/png', 5242880) returning id into r3;
  perform t_expect(format('insert into payment_receipts (tenant_id, property_id, payment_id, storage_path, content_type, size_bytes) values (%L, %L, %L, %L, ''image/webp'', 10)',
    tenant, prop, pay, tenant || '/' || prop || '/' || pay || '/' || gen_random_uuid() || '.webp'), 'POLICY_VIOLATION: receipts limit');
  delete from payment_receipts where id = r3;
  insert into payment_receipts (tenant_id, property_id, payment_id, storage_path, content_type, size_bytes)
    values (tenant, prop, pay, tenant || '/' || prop || '/' || pay || '/' || gen_random_uuid() || '.webp', 'image/webp', 10) returning id into r3;
  perform t_sys();
  if (select count(*) from payment_receipts where payment_id = pay) <> 3 then raise exception 'FAIL expected three receipts'; end if;
  if (select count(*) from audit_logs where action = 'payment_receipt.deleted') <> 1 then raise exception 'FAIL removal not audited'; end if;

  -- 3. the table's own limits (as the system, so only the table's rules are tested). One file goes first: the limit trigger runs
  -- before the table's checks, so with three files it would answer every attempt below.
  delete from payment_receipts where id = r3;
  begin insert into payment_receipts (tenant_id, property_id, payment_id, storage_path, content_type, size_bytes)
    values (tenant, prop, pay, tenant || '/' || prop || '/' || pay || '/' || gen_random_uuid() || '.gif', 'image/gif', 10);
    raise exception 'FAIL gif accepted'; exception when check_violation then null; end;
  begin insert into payment_receipts (tenant_id, property_id, payment_id, storage_path, content_type, size_bytes)
    values (tenant, prop, pay, tenant || '/' || prop || '/' || pay || '/' || gen_random_uuid() || '.jpg', 'image/jpeg', 0);
    raise exception 'FAIL empty file accepted'; exception when check_violation then null; end;
  begin insert into payment_receipts (tenant_id, property_id, payment_id, storage_path, content_type, size_bytes)
    values (tenant, prop, pay, tenant || '/' || prop || '/' || pay || '/' || gen_random_uuid() || '.jpg', 'image/jpeg', 5242881);
    raise exception 'FAIL oversize file accepted'; exception when check_violation then null; end;
  foreach function_path in array array[
    other_tenant || '/' || prop || '/' || pay || '/' || gen_random_uuid() || '.jpg',
    tenant || '/' || other_prop || '/' || pay || '/' || gen_random_uuid() || '.jpg',
    tenant || '/' || prop || '/' || gen_random_uuid() || '/' || gen_random_uuid() || '.jpg',
    tenant || '/' || prop || '/' || pay || '/' || 'not-a-uuid.jpg',
    tenant || '/' || prop || '/' || pay || '/' || gen_random_uuid() || '.pdf.exe',
    '../' || tenant || '/' || prop || '/' || pay || '/' || gen_random_uuid() || '.jpg'] loop
    begin
      insert into payment_receipts (tenant_id, property_id, payment_id, storage_path, content_type, size_bytes)
        values (tenant, prop, pay, function_path, 'image/jpeg', 10);
      raise exception 'FAIL a path outside the payment was accepted: %', function_path;
    exception when check_violation then null; end;
  end loop;

  -- 4. a receipt cannot hang off a payment of another property: the row's property must be the payment's own
  begin
    insert into payment_receipts (tenant_id, property_id, payment_id, storage_path, content_type, size_bytes)
      values (tenant, other_prop, pay, tenant || '/' || other_prop || '/' || pay || '/' || gen_random_uuid() || '.jpg', 'image/jpeg', 10);
    raise exception 'FAIL a receipt was filed under another property';
  exception when sqlstate 'P0001' then
    if sqlerrm not like '%receipt property%' then raise; end if;
  end;
  begin
    insert into payment_receipts (tenant_id, property_id, payment_id, storage_path, content_type, size_bytes)
      values (other_tenant, other_prop, pay, other_tenant || '/' || other_prop || '/' || pay || '/' || gen_random_uuid() || '.jpg', 'image/jpeg', 10);
    raise exception 'FAIL a receipt was filed under another group';
  exception when sqlstate 'P0001' then
    if sqlerrm not like '%receipt property%' then raise; end if;   -- the trigger answers before the foreign key would
  end;
  begin
    insert into payment_receipts (tenant_id, property_id, payment_id, storage_path, content_type, size_bytes)
      values (tenant, prop, pay, (select storage_path from payment_receipts where id = r1), 'image/jpeg', 10);
    raise exception 'FAIL a duplicate path was accepted';
  exception when unique_violation then null; end;

  -- 5. who can read, add and remove
  perform t_as(hk::text);
  select count(*) into n from payment_receipts;
  if n <> 0 then raise exception 'FAIL housekeeping read % receipts', n; end if;
  begin
    insert into payment_receipts (tenant_id, property_id, payment_id, storage_path, content_type, size_bytes)
      values (tenant, prop, pay, tenant || '/' || prop || '/' || pay || '/' || gen_random_uuid() || '.jpg', 'image/jpeg', 10);
    raise exception 'FAIL housekeeping attached a receipt';
  exception when insufficient_privilege then null; end;
  delete from payment_receipts where id = r1;
  perform t_as(ob::text);
  select count(*) into n from payment_receipts;
  if n <> 0 then raise exception 'FAIL another group read % receipts', n; end if;
  begin
    insert into payment_receipts (tenant_id, property_id, payment_id, storage_path, content_type, size_bytes)
      values (tenant, prop, pay, tenant || '/' || prop || '/' || pay || '/' || gen_random_uuid() || '.jpg', 'image/jpeg', 10);
    raise exception 'FAIL another group attached a receipt';
  exception when insufficient_privilege then null; end;
  delete from payment_receipts where id = r1;
  perform t_as(owner::text);
  select count(*) into n from payment_receipts where payment_id = pay;
  if n <> 2 then raise exception 'FAIL the owner sees % receipts, expected 2 (r1 and r2)', n; end if;
  perform t_as(fd::text);
  select count(*) into n from payment_receipts where payment_id = pay;
  if n <> 2 then raise exception 'FAIL the desk sees % receipts, expected 2', n; end if;
  begin
    update payment_receipts set size_bytes = 1 where id = r1;
    raise exception 'FAIL a receipt was edited';
  exception when insufficient_privilege then null; end;
  perform t_sys();
  if (select count(*) from payment_receipts where id = r1) <> 1 then raise exception 'FAIL a refused delete removed a receipt'; end if;

  -- 6. removal by someone who may: the desk removes one, and it is audited
  perform t_as(fd::text);
  delete from payment_receipts where id = r2;
  perform t_sys();
  if (select count(*) from payment_receipts where payment_id = pay) <> 1 then raise exception 'FAIL expected one receipt left'; end if;
  if (select count(*) from audit_logs where action = 'payment_receipt.deleted' and entity_id = r2 and actor_user_id = fd) <> 1 then raise exception 'FAIL removal of r2 not audited'; end if;

  -- 6b. the policies themselves: read with money view, write only with payment.record, nothing else (no update policy). The stock
  -- roles cannot tell these apart (everyone who records payments can also see them), so the definitions are checked directly.
  if (select count(*) from pg_policies where tablename = 'payment_receipts') <> 3 then raise exception 'FAIL expected exactly three policies'; end if;
  if (select qual from pg_policies where tablename = 'payment_receipts' and cmd = 'SELECT') not like '%can_view_money%' then raise exception 'FAIL read is not for money viewers'; end if;
  if (select with_check from pg_policies where tablename = 'payment_receipts' and cmd = 'INSERT') not like '%payment.record%' then raise exception 'FAIL attaching is not for payment.record'; end if;
  if (select qual from pg_policies where tablename = 'payment_receipts' and cmd = 'DELETE') not like '%payment.record%' then raise exception 'FAIL removing is not for payment.record'; end if;
  if has_table_privilege('anon', 'payment_receipts', 'select') or has_table_privilege('authenticated', 'payment_receipts', 'update') then raise exception 'FAIL a role holds a privilege it should not'; end if;

  -- 7. the payment and the booking were never touched by any of it
  if (select row_to_json(p)::text from payments p where id = pay) is distinct from before_pay then raise exception 'FAIL a receipt changed the payment'; end if;
  if (select row_to_json(x)::text from reservations x where id = res) is distinct from before_res then raise exception 'FAIL a receipt changed the booking'; end if;

  raise notice 'PASS payment receipts: desk attaches and removes as itself (audited), three files of four types, limits and path rules, no filing under another property or group, housekeeping and other groups blocked, no edits, payment untouched';
end $$;
