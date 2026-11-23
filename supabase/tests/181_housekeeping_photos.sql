-- Before and after photos on a housekeeping task (migration 181). Reuses t_as / t_sys / t_expect (05); the users from 21:
-- aa01 owner A (may assign), aa02 and aa06 housekeeping A (may work tasks, not assign), aa04 front desk A, aa05 accountant A (no
-- housekeeping access), aa08 maintenance A (no housekeeping.view), bb01 owner B (another group). Property A is a2, room 105.
-- The file store is outside the database: what is proven is the table, who may read and write it, the assignment rule, the limits,
-- that a picture cannot hang off another property's task, and that a task is never changed by one.
\set ON_ERROR_STOP on

do $$
declare
  prop uuid := '00000000-0000-0000-0000-0000000000a2';
  owner uuid := '00000000-0000-0000-0000-00000000aa01'; hk uuid := '00000000-0000-0000-0000-00000000aa02';
  hk2 uuid := '00000000-0000-0000-0000-00000000aa06'; fd uuid := '00000000-0000-0000-0000-00000000aa04';
  acc uuid := '00000000-0000-0000-0000-00000000aa05'; mt uuid := '00000000-0000-0000-0000-00000000aa08';
  ob uuid := '00000000-0000-0000-0000-00000000bb01';
  room uuid; task uuid; task2 uuid; tenant uuid; other_prop uuid; other_tenant uuid;
  before_task text; n integer; b1 uuid; b2 uuid; b3 uuid; a1 uuid; path text; bad text; u uuid;
begin
  perform t_sys();
  select tenant_id into tenant from properties where id = prop;
  select id, tenant_id into other_prop, other_tenant from properties where tenant_id <> tenant order by id limit 1;
  select id into room from rooms where property_id = prop and room_number = '105';
  if other_prop is null or room is null then raise exception 'FAIL setup'; end if;
  perform t_as(owner::text);
  perform create_housekeeping_task(room, 'other', 'normal', null, 't181 task', null);
  perform create_housekeeping_task(room, 'other', 'normal', null, 't181 task two', null);
  perform t_sys();
  select id into task from housekeeping_tasks where notes = 't181 task';
  select id into task2 from housekeeping_tasks where notes = 't181 task two';
  before_task := (select row_to_json(t)::text from housekeeping_tasks t where id = task);
  if (select count(*) from audit_logs where action like 'housekeeping_photo.%') <> 0 then raise exception 'FAIL photos audited before any exist'; end if;

  -- 1. housekeeping adds a before picture as itself; the audit names the path, the kind and who
  perform t_as(hk::text);
  path := tenant || '/' || prop || '/' || task || '/before/' || gen_random_uuid() || '.jpg';
  insert into housekeeping_task_photos (tenant_id, property_id, task_id, kind, storage_path, content_type, size_bytes)
    values (tenant, prop, task, 'before', path, 'image/jpeg', 200000) returning id into b1;
  perform t_sys();
  if (select uploaded_by from housekeeping_task_photos where id = b1) is distinct from hk then raise exception 'FAIL uploaded_by is not the housekeeper'; end if;
  if (select count(*) from audit_logs where action = 'housekeeping_photo.created' and entity_id = b1 and actor_user_id = hk) <> 1 then raise exception 'FAIL create not audited under the housekeeper'; end if;
  if (select metadata::text from audit_logs where action = 'housekeeping_photo.created' and entity_id = b1) not like '%' || path || '%' then raise exception 'FAIL audit lacks the path'; end if;

  -- 2. three of each kind; a fourth of a kind is refused, the other kind is counted apart; removing one makes room
  perform t_as(hk::text);
  insert into housekeeping_task_photos (tenant_id, property_id, task_id, kind, storage_path, content_type, size_bytes)
    values (tenant, prop, task, 'before', tenant || '/' || prop || '/' || task || '/before/' || gen_random_uuid() || '.png', 'image/png', 5242880) returning id into b2;
  insert into housekeeping_task_photos (tenant_id, property_id, task_id, kind, storage_path, content_type, size_bytes)
    values (tenant, prop, task, 'before', tenant || '/' || prop || '/' || task || '/before/' || gen_random_uuid() || '.webp', 'image/webp', 1) returning id into b3;
  perform t_expect(format('insert into housekeeping_task_photos (tenant_id, property_id, task_id, kind, storage_path, content_type, size_bytes) values (%L, %L, %L, ''before'', %L, ''image/jpeg'', 10)',
    tenant, prop, task, tenant || '/' || prop || '/' || task || '/before/' || gen_random_uuid() || '.jpg'), 'POLICY_VIOLATION: task photos limit');
  insert into housekeeping_task_photos (tenant_id, property_id, task_id, kind, storage_path, content_type, size_bytes)
    values (tenant, prop, task, 'after', tenant || '/' || prop || '/' || task || '/after/' || gen_random_uuid() || '.jpg', 'image/jpeg', 10) returning id into a1;
  delete from housekeeping_task_photos where id = b3;
  insert into housekeeping_task_photos (tenant_id, property_id, task_id, kind, storage_path, content_type, size_bytes)
    values (tenant, prop, task, 'before', tenant || '/' || prop || '/' || task || '/before/' || gen_random_uuid() || '.jpg', 'image/jpeg', 10) returning id into b3;
  perform t_sys();
  if (select count(*) from housekeeping_task_photos where task_id = task and kind = 'before') <> 3 then raise exception 'FAIL expected three before pictures'; end if;
  if (select count(*) from audit_logs where action = 'housekeeping_photo.deleted') <> 1 then raise exception 'FAIL removal not audited'; end if;

  -- 3. the table's own limits (as the system). One picture goes first: the limit trigger runs before the table's checks.
  delete from housekeeping_task_photos where id = b3;
  foreach bad in array array['image/gif', 'application/pdf', 'image/svg+xml'] loop
    begin insert into housekeeping_task_photos (tenant_id, property_id, task_id, kind, storage_path, content_type, size_bytes)
      values (tenant, prop, task, 'before', tenant || '/' || prop || '/' || task || '/before/' || gen_random_uuid() || '.jpg', bad, 10);
      raise exception 'FAIL type % accepted', bad; exception when check_violation then null; end;
  end loop;
  begin insert into housekeeping_task_photos (tenant_id, property_id, task_id, kind, storage_path, content_type, size_bytes)
    values (tenant, prop, task, 'before', tenant || '/' || prop || '/' || task || '/before/' || gen_random_uuid() || '.jpg', 'image/jpeg', 0);
    raise exception 'FAIL empty file accepted'; exception when check_violation then null; end;
  begin insert into housekeeping_task_photos (tenant_id, property_id, task_id, kind, storage_path, content_type, size_bytes)
    values (tenant, prop, task, 'before', tenant || '/' || prop || '/' || task || '/before/' || gen_random_uuid() || '.jpg', 'image/jpeg', 5242881);
    raise exception 'FAIL oversize file accepted'; exception when check_violation then null; end;
  begin insert into housekeeping_task_photos (tenant_id, property_id, task_id, kind, storage_path, content_type, size_bytes)
    values (tenant, prop, task, 'during', tenant || '/' || prop || '/' || task || '/during/' || gen_random_uuid() || '.jpg', 'image/jpeg', 10);
    raise exception 'FAIL a third kind accepted'; exception when check_violation then null; end;
  foreach bad in array array[
    other_tenant || '/' || prop || '/' || task || '/before/' || gen_random_uuid() || '.jpg',
    tenant || '/' || other_prop || '/' || task || '/before/' || gen_random_uuid() || '.jpg',
    tenant || '/' || prop || '/' || gen_random_uuid() || '/before/' || gen_random_uuid() || '.jpg',
    tenant || '/' || prop || '/' || task || '/after/' || gen_random_uuid() || '.jpg',   -- the kind in the path must be the row's kind
    tenant || '/' || prop || '/' || task || '/before/' || 'not-a-uuid.jpg',
    tenant || '/' || prop || '/' || task || '/before/' || gen_random_uuid() || '.jpg.exe',
    '../' || tenant || '/' || prop || '/' || task || '/before/' || gen_random_uuid() || '.jpg'] loop
    begin
      insert into housekeeping_task_photos (tenant_id, property_id, task_id, kind, storage_path, content_type, size_bytes)
        values (tenant, prop, task, 'before', bad, 'image/jpeg', 10);
      raise exception 'FAIL a path outside the task was accepted: %', bad;
    exception when check_violation then null; end;
  end loop;

  -- 4. a picture cannot hang off a task of another property or group
  begin
    insert into housekeeping_task_photos (tenant_id, property_id, task_id, kind, storage_path, content_type, size_bytes)
      values (tenant, other_prop, task, 'before', tenant || '/' || other_prop || '/' || task || '/before/' || gen_random_uuid() || '.jpg', 'image/jpeg', 10);
    raise exception 'FAIL a picture was filed under another property';
  exception when sqlstate 'P0001' then
    if sqlerrm not like '%photo property%' then raise; end if;
  end;
  begin
    insert into housekeeping_task_photos (tenant_id, property_id, task_id, kind, storage_path, content_type, size_bytes)
      values (other_tenant, other_prop, task, 'before', other_tenant || '/' || other_prop || '/' || task || '/before/' || gen_random_uuid() || '.jpg', 'image/jpeg', 10);
    raise exception 'FAIL a picture was filed under another group';
  exception when sqlstate 'P0001' then
    if sqlerrm not like '%photo property%' then raise; end if;
  end;
  begin
    insert into housekeeping_task_photos (tenant_id, property_id, task_id, kind, storage_path, content_type, size_bytes)
      values (tenant, prop, task, 'before', (select storage_path from housekeeping_task_photos where id = b1), 'image/jpeg', 10);
    raise exception 'FAIL a duplicate path was accepted';
  exception when unique_violation then null; end;

  -- 5. who can read: housekeeping, front desk and the owner see them; accounting, maintenance and another group see none
  foreach u in array array[hk, hk2, fd, owner] loop
    perform t_as(u::text);
    select count(*) into n from housekeeping_task_photos where task_id = task;
    if n <> 3 then raise exception 'FAIL % sees % pictures, expected 3', u, n; end if;   -- b1, b2 (before) and a1 (after)
  end loop;
  foreach u in array array[acc, mt, ob] loop
    perform t_as(u::text);
    select count(*) into n from housekeeping_task_photos;
    if n <> 0 then raise exception 'FAIL % read % pictures', u, n; end if;
  end loop;

  -- 6. who can add and remove: housekeeping.update; people with no housekeeping rights and other groups cannot
  foreach u in array array[acc, mt, ob] loop
    perform t_as(u::text);
    begin
      insert into housekeeping_task_photos (tenant_id, property_id, task_id, kind, storage_path, content_type, size_bytes)
        values (tenant, prop, task, 'after', tenant || '/' || prop || '/' || task || '/after/' || gen_random_uuid() || '.jpg', 'image/jpeg', 10);
      raise exception 'FAIL % attached a picture', u;
    exception when insufficient_privilege then null; end;
    delete from housekeeping_task_photos where id = a1;
  end loop;
  perform t_sys();
  if (select count(*) from housekeeping_task_photos where id = a1) <> 1 then raise exception 'FAIL a refused delete removed a picture'; end if;
  perform t_as(hk::text);
  begin
    update housekeeping_task_photos set size_bytes = 1 where id = b1;
    raise exception 'FAIL a picture was edited';
  exception when insufficient_privilege then null; end;

  -- 7. the assignment rule: a task assigned to hk2 is worked by hk2 or by someone who may assign
  perform t_sys();
  update housekeeping_tasks set assigned_to = hk2 where id = task;
  before_task := (select row_to_json(t)::text from housekeeping_tasks t where id = task);
  perform t_as(hk::text);
  begin
    insert into housekeeping_task_photos (tenant_id, property_id, task_id, kind, storage_path, content_type, size_bytes)
      values (tenant, prop, task, 'after', tenant || '/' || prop || '/' || task || '/after/' || gen_random_uuid() || '.jpg', 'image/jpeg', 10);
    raise exception 'FAIL housekeeping added a picture to a task assigned to someone else';
  exception when insufficient_privilege then null; end;
  delete from housekeeping_task_photos where id = a1;
  perform t_sys();
  if (select count(*) from housekeeping_task_photos where id = a1) <> 1 then raise exception 'FAIL housekeeping removed a picture from a task assigned to someone else'; end if;
  perform t_as(hk2::text);
  insert into housekeeping_task_photos (tenant_id, property_id, task_id, kind, storage_path, content_type, size_bytes)
    values (tenant, prop, task, 'after', tenant || '/' || prop || '/' || task || '/after/' || gen_random_uuid() || '.jpg', 'image/jpeg', 10);
  perform t_as(owner::text);
  insert into housekeeping_task_photos (tenant_id, property_id, task_id, kind, storage_path, content_type, size_bytes)
    values (tenant, prop, task, 'after', tenant || '/' || prop || '/' || task || '/after/' || gen_random_uuid() || '.jpg', 'image/jpeg', 10);
  delete from housekeeping_task_photos where id = a1;   -- the owner may assign, so may remove
  perform t_sys();
  if (select count(*) from housekeeping_task_photos where id = a1) <> 0 then raise exception 'FAIL the owner could not remove a picture'; end if;

  -- 8. a cancelled task takes no new picture, but a mistaken one can still be taken down
  perform t_sys();
  update housekeeping_tasks set status = 'cancelled', cancelled_at = now(), cancel_reason = 't181' where id = task2;
  perform t_as(hk::text);
  begin
    insert into housekeeping_task_photos (tenant_id, property_id, task_id, kind, storage_path, content_type, size_bytes)
      values (tenant, prop, task2, 'before', tenant || '/' || prop || '/' || task2 || '/before/' || gen_random_uuid() || '.jpg', 'image/jpeg', 10);
    raise exception 'FAIL a picture was added to a cancelled task';
  exception when insufficient_privilege then null; end;
  perform t_sys();
  insert into housekeeping_task_photos (tenant_id, property_id, task_id, kind, storage_path, content_type, size_bytes)
    values (tenant, prop, task2, 'before', tenant || '/' || prop || '/' || task2 || '/before/' || gen_random_uuid() || '.jpg', 'image/jpeg', 10) returning id into b3;
  perform t_as(hk::text);
  delete from housekeeping_task_photos where id = b3;
  perform t_sys();
  if (select count(*) from housekeeping_task_photos where id = b3) <> 0 then raise exception 'FAIL a picture could not be taken down from a cancelled task'; end if;

  -- 9. the policies themselves, and the privileges
  if (select count(*) from pg_policies where tablename = 'housekeeping_task_photos') <> 3 then raise exception 'FAIL expected exactly three policies'; end if;
  if (select qual from pg_policies where tablename = 'housekeeping_task_photos' and cmd = 'SELECT') not like '%housekeeping.view%' then raise exception 'FAIL read is not for housekeeping.view'; end if;
  if (select with_check from pg_policies where tablename = 'housekeeping_task_photos' and cmd = 'INSERT') not like '%hk_photo_allowed%' then raise exception 'FAIL adding does not use the task rule'; end if;
  if (select qual from pg_policies where tablename = 'housekeeping_task_photos' and cmd = 'DELETE') not like '%hk_photo_allowed%' then raise exception 'FAIL removing does not use the task rule'; end if;
  if has_table_privilege('anon', 'housekeeping_task_photos', 'select') or has_table_privilege('authenticated', 'housekeeping_task_photos', 'update') then raise exception 'FAIL a role holds a privilege it should not'; end if;

  -- 10. the task itself was never touched by any picture
  if (select row_to_json(t)::text from housekeeping_tasks t where id = task) is distinct from before_task then raise exception 'FAIL a picture changed the task'; end if;

  raise notice 'PASS housekeeping photos: housekeeping adds and removes as itself (audited), three of each kind, limits and path rules, no filing under another property or group, the assignment rule, cancelled tasks, no edits, task untouched';
end $$;
