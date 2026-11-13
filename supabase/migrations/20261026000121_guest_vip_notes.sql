-- 121 A VIP flag and private notes on a guest (prototype "Guest Directory" VIP tag and the guest profile's notes).
--
--   vip    true for a guest the hotel wants to treat specially; false by default
--   notes  free text for staff (preferences, allergies, "always wants a quiet room"), up to 2000 characters, null when empty
--
-- Both are for staff only. Nothing here is read by the guest site, the booking emails or the guest's own pages. They are read by
-- whoever may already read the guest (guest.view, the guests_select policy), and written only through set_guest_profile, the same
-- way update_guest (020) is the only door for contact details: direct updates on guests were revoked in 047. The function checks
-- guest.manage for the guest's hotel group (anyone else, and an unknown guest, get NOT_FOUND), trims the notes, turns every line break into a
-- single \n (a browser sends \r\n, which would count twice toward the limit and make an unchanged note look changed), stores a blank as
-- null, changes nothing and audits nothing when nothing differs, and writes one audit row naming the fields that changed (vip,
-- notes), never their values: a note is personal data and must not be copied into the log.

alter table guests
  add column vip boolean not null default false,
  add column notes text,
  add constraint guests_notes_check check (notes is null or length(notes) between 1 and 2000);

create function set_guest_profile(p_guest uuid, p_vip boolean, p_notes text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  g guests%rowtype; v_actor uuid := auth.uid();
  v_notes text := nullif(btrim(replace(replace(coalesce(p_notes, ''), E'\r\n', E'\n'), E'\r', E'\n')), '');
  v_changed text[] := '{}';
begin
  select * into g from guests where id = p_guest for update;
  if not found or v_actor is null or not has_tenant_permission(g.tenant_id, 'guest.manage') then
    raise exception 'NOT_FOUND' using errcode = 'P0001';
  end if;
  if p_vip is null then raise exception 'POLICY_VIOLATION: vip' using errcode = 'P0001'; end if;
  if length(coalesce(v_notes, '')) > 2000 then raise exception 'POLICY_VIOLATION: notes' using errcode = 'P0001'; end if;

  if g.vip is distinct from p_vip then v_changed := array_append(v_changed, 'vip'::text); end if;
  if g.notes is distinct from v_notes then v_changed := array_append(v_changed, 'notes'::text); end if;
  if cardinality(v_changed) = 0 then return jsonb_build_object('guest_id', g.id, 'changed', false, 'vip', g.vip); end if;

  update guests set vip = p_vip, notes = v_notes where id = g.id;
  perform write_audit(g.tenant_id, null, v_actor, 'guest.profile_updated', 'guest', g.id, null, jsonb_build_object('fields', to_jsonb(v_changed)));
  return jsonb_build_object('guest_id', g.id, 'changed', true, 'vip', p_vip, 'fields', to_jsonb(v_changed));
end $$;

revoke all on function set_guest_profile(uuid, boolean, text) from public, anon;
grant execute on function set_guest_profile(uuid, boolean, text) to authenticated;
