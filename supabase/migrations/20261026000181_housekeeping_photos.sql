-- 181 Before and after photos on a housekeeping task (prototype "Housekeeping Task").
--
--   * `housekeeping_task_photos`: one row per picture (tenant, property, task, kind `before` or `after`, storage path, content
--     type, size). The file lives in the PRIVATE Storage bucket `housekeeping-photos`: nobody reaches it by address. The app shows
--     it with a short-lived signed link made after it has read the row as the signed-in person, so the row's access rule is the
--     file's access rule (the same design as payment receipts, 178).
--   * who: read by whoever may see housekeeping at the property (housekeeping.view); add and remove need housekeeping.update, and,
--     like starting or completing the task, a task assigned to someone else is only for that person or someone with
--     housekeeping.assign. Adding is refused on a cancelled task; removing is not (a mistaken picture can always be taken down).
--     A picture is never edited: there is no update; a wrong one is removed and a right one added, both audited by path.
--   * limits, enforced here so no script can break them: JPEG, PNG or WebP; 1 byte to 5 MB; at most 3 pictures of each kind per task
--     (a trigger that locks the task row, lightly, while it counts); the path must be exactly
--     `<tenant>/<property>/<task>/<kind>/<uuid>.<jpg|png|webp>`; the row's tenant and property must be the task's own (the policies
--     read them), so a picture can never hang off a task of a property its writer has no rights at.
--   * the task is not touched: a picture changes no status, assignment or note. Tasks are never deleted (a cancelled one stays), so
--     no cascade can strand a file, and the app removes the file BEFORE the row on removal (a failed file removal leaves the row and
--     an error), and writes the row first on adding and withdraws it if the upload fails: no cleanup queue is needed.
--   * the bucket is created here when Storage exists (not in the plain-Postgres test database): private, 5 MB, the three image
--     types. Uploads and signed links are made by the server with the service role after the checks above, never from the browser.
--   * retention: pictures are kept as long as the task. Pictures of rooms can show guests' belongings, so how long they may be kept
--     is a question for the privacy review (TODO), not decided here.

create table housekeeping_task_photos (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null,
  property_id   uuid not null,
  task_id       uuid not null references housekeeping_tasks (id),
  kind          text not null check (kind in ('before', 'after')),
  storage_path  text not null unique,
  content_type  text not null check (content_type in ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes    integer not null check (size_bytes between 1 and 5242880),
  uploaded_by   uuid default auth.uid(),
  created_at    timestamptz not null default now(),
  constraint housekeeping_task_photos_path_check check (storage_path ~ ('^' || tenant_id::text || '/' || property_id::text || '/' || task_id::text
    || '/' || kind || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](jpg|png|webp)$'))
);
create index on housekeeping_task_photos (task_id, kind, created_at);

-- May the signed-in person add (p_adding) or remove a picture on this task? The same people and the same assignment rule as
-- working the task (start_housekeeping_task, complete_housekeeping_task, 023).
create function hk_photo_allowed(p_task uuid, p_adding boolean) returns boolean
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare t housekeeping_tasks%rowtype;
begin
  select * into t from housekeeping_tasks where id = p_task;
  if not found then return false; end if;
  if not has_permission(t.property_id, 'housekeeping.update') then return false; end if;
  if t.assigned_to is not null and t.assigned_to <> (select auth.uid()) and not has_permission(t.property_id, 'housekeeping.assign') then return false; end if;
  if p_adding and t.status = 'cancelled' then return false; end if;
  return true;
end $$;
revoke all on function hk_photo_allowed(uuid, boolean) from public, anon;
grant execute on function hk_photo_allowed(uuid, boolean) to authenticated;

alter table housekeeping_task_photos enable row level security;
create policy housekeeping_task_photos_select on housekeeping_task_photos for select to authenticated using (has_permission(property_id, 'housekeeping.view'));
create policy housekeeping_task_photos_insert on housekeeping_task_photos for insert to authenticated with check (hk_photo_allowed(task_id, true));
create policy housekeeping_task_photos_delete on housekeeping_task_photos for delete to authenticated using (hk_photo_allowed(task_id, false));
revoke all on housekeeping_task_photos from anon;
revoke update on housekeeping_task_photos from authenticated;

-- Runs as the owner: it must lock and read the task, which logins cannot lock. It only refuses or lets the row through; the
-- row-level policies still decide who may write it (they run after this trigger).
create function housekeeping_task_photos_check() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare t housekeeping_tasks%rowtype;
begin
  select * into t from housekeeping_tasks where id = new.task_id for no key update;
  if not found or t.tenant_id <> new.tenant_id or t.property_id <> new.property_id then
    raise exception 'POLICY_VIOLATION: photo property' using errcode = 'P0001';
  end if;
  if (select count(*) from housekeeping_task_photos where task_id = new.task_id and kind = new.kind) >= 3 then
    raise exception 'POLICY_VIOLATION: task photos limit' using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke all on function housekeeping_task_photos_check() from public, anon, authenticated;   -- STAGING step 4c: only three functions are callable by anon
create trigger housekeeping_task_photos_check before insert on housekeeping_task_photos
  for each row execute function housekeeping_task_photos_check();

create trigger housekeeping_task_photos_audit after insert or delete on housekeeping_task_photos
  for each row execute function audit_setup_row('housekeeping_photo', 'task_id,kind,storage_path,content_type,size_bytes');

do $b$ begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('housekeeping-photos', 'housekeeping-photos', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
    on conflict (id) do update set public = false, file_size_limit = 5242880, allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];
  end if;
end $b$;
