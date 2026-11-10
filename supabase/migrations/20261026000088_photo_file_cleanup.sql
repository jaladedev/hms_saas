-- 088 Stored photo files that outlive their picture.
--
-- A room type picture is a row (room_type_photos) plus a file in the room-photos bucket, and the file store is outside
-- the database, so deleting the row cannot delete the file. Rows disappear in three ways: staff remove a picture (the
-- app removes the file straight away, but that call can fail), a picture whose upload failed is withdrawn, and a room
-- type is deleted (the rows go with it through the cascade). Each leaves a file nobody can see or remove.
--
-- The fix is a queue written in the same transaction as the delete: every deleted picture row puts its path in
-- room_photo_cleanup. The maintenance job claims paths, asks Storage to remove them, and clears the ones that went.
-- A path that Storage refuses stays queued and is tried again on the next run. Removing a file that is already gone is
-- not an error, so queueing a path whose upload never happened is harmless.
--
-- Only service_role may touch the queue or call the two functions (is_system_caller); logins have no access to the table.

create table room_photo_cleanup (
  path        text primary key,
  queued_at   timestamptz not null default now()
);
alter table room_photo_cleanup enable row level security;
revoke all on room_photo_cleanup from public, anon, authenticated;

create function room_type_photos_queue_cleanup() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into room_photo_cleanup (path) values (old.storage_path) on conflict do nothing;
  return null;
end $$;
revoke all on function room_type_photos_queue_cleanup() from public, anon, authenticated;   -- STAGING step 4c: only three functions are callable by anon
create trigger room_type_photos_queue_cleanup after delete on room_type_photos
  for each row execute function room_type_photos_queue_cleanup();

-- Up to p_limit queued paths, oldest first. Claiming does not remove them: only finish_photo_cleanup does.
create function claim_photo_cleanup(p_limit integer default 50) returns text[]
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  return coalesce((select array_agg(path order by queued_at, path) from (select path, queued_at from room_photo_cleanup order by queued_at, path limit greatest(1, least(coalesce(p_limit, 50), 200))) q), '{}');
end $$;

-- Clears the paths whose files are gone; returns how many it cleared.
create function finish_photo_cleanup(p_paths text[]) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  delete from room_photo_cleanup where path = any(coalesce(p_paths, '{}'));
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function claim_photo_cleanup(integer), finish_photo_cleanup(text[]) from public, anon, authenticated;
grant execute on function claim_photo_cleanup(integer), finish_photo_cleanup(text[]) to service_role;
