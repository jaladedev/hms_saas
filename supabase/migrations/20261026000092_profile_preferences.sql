-- 092 A person's own profile and display preferences (prototype screen "Profile & Preferences").
--
-- user_profiles already holds a name and phone and lets a person read and update only their own row (policies in 002), but
-- nothing creates the row, so a first save must be able to add it. update_my_profile is that one door: it acts only on
-- the caller's own row (auth.uid(), never an id passed in), validates, and creates the row if it is missing.
--
-- density is a display preference for the staff screens, comfortable (the default) or compact. It belongs to the person, not
-- the hotel, and changes nothing about what they may see or do. It is not audited: it is the person's own display setting,
-- and a name or phone change here is the person editing themselves.
-- The hotel-wide look (theme, colours, logo) is a different thing and stays with the hotel's own settings.

alter table user_profiles
  add column density text not null default 'comfortable' check (density in ('comfortable', 'compact'));

create function update_my_profile(p_full_name text, p_phone text, p_density text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_name text := regexp_replace(trim(coalesce(p_full_name, '')), '\s+', ' ', 'g');
  v_phone text := nullif(trim(coalesce(p_phone, '')), '');
begin
  if v_uid is null or not exists (select 1 from auth.users where id = v_uid) then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if length(v_name) = 0 or length(v_name) > 200 then raise exception 'POLICY_VIOLATION: name' using errcode = 'P0001'; end if;
  if length(coalesce(v_phone, '')) > 40 then raise exception 'POLICY_VIOLATION: too long' using errcode = 'P0001'; end if;
  if p_density is null or p_density not in ('comfortable', 'compact') then raise exception 'POLICY_VIOLATION: density' using errcode = 'P0001'; end if;

  insert into user_profiles (id, full_name, phone, density) values (v_uid, v_name, v_phone, p_density)
  on conflict (id) do update set full_name = excluded.full_name, phone = excluded.phone, density = excluded.density;
  return jsonb_build_object('user_id', v_uid, 'density', p_density);
end $$;

revoke all on function update_my_profile(text, text, text) from public, anon;
grant execute on function update_my_profile(text, text, text) to authenticated;
