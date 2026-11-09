-- Moving a room type's pictures up or down (081). Captions are changed with a plain update (the write policy from 080
-- already limits that to property.configure, and the audit trigger records it). Order needs a function, because two
-- rows must change together and the first picture in the list is what guests see first.
--
-- move_room_type_photo(photo, 'up' | 'down'): requires property.configure at the picture's hotel (a person without it
-- is told the picture does not exist). It locks the room type, renumbers the type's pictures 0, 1, 2... in their current
-- order (so ties and gaps left by deletions cannot make a move do nothing), then swaps the picture with its neighbour.
-- Moving the first picture up or the last one down changes nothing. Returns the picture's new position, counting from 0.
create function move_room_type_photo(p_photo uuid, p_direction text) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r room_type_photos;
  v_pos integer;
  v_other uuid;
begin
  if p_direction not in ('up', 'down') then raise exception 'INVALID_INPUT: direction must be up or down' using errcode = 'P0001'; end if;
  select * into r from room_type_photos where id = p_photo;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  perform require_permission(r.property_id, 'property.configure', 'NOT_FOUND');
  perform 1 from room_types where id = r.room_type_id for update;

  with ordered as (
    select id, (row_number() over (order by sort_order, created_at, id) - 1)::integer as n
    from room_type_photos where room_type_id = r.room_type_id)
  update room_type_photos p set sort_order = o.n from ordered o where p.id = o.id and p.sort_order <> o.n;

  select sort_order into v_pos from room_type_photos where id = p_photo;
  select id into v_other from room_type_photos
   where room_type_id = r.room_type_id and sort_order = case when p_direction = 'up' then v_pos - 1 else v_pos + 1 end;
  if v_other is null then return v_pos; end if;
  update room_type_photos set sort_order = case when id = p_photo then (select sort_order from room_type_photos where id = v_other) else v_pos end
   where id in (p_photo, v_other);
  return case when p_direction = 'up' then v_pos - 1 else v_pos + 1 end;
end $$;

revoke all on function move_room_type_photo(uuid, text) from public, anon;   -- STAGING step 4c: only three functions are callable by anon
grant execute on function move_room_type_photo(uuid, text) to authenticated;
