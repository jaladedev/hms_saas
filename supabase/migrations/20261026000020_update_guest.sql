-- 020 Editing a guest's contact details, as an audited function.
--
-- Staff with guest.manage could already change guests rows directly through row level security, but that leaves
-- no record of who changed a phone number or an email. This function is the audited door: it checks the
-- permission for the guest's hotel group, validates the fields, changes only what differs, and writes one audit
-- row naming the fields that changed (not their values, so personal data is not copied into the log).
-- An unchanged save does nothing and writes nothing.

create function update_guest(p_guest uuid, p_full_name text, p_email text, p_phone text, p_address text, p_country_code text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  g guests%rowtype; v_actor uuid := auth.uid();
  v_name text := regexp_replace(trim(coalesce(p_full_name, '')), '\s+', ' ', 'g');
  v_email text := nullif(lower(trim(coalesce(p_email, ''))), '');
  v_phone text := nullif(trim(coalesce(p_phone, '')), '');
  v_addr text := nullif(trim(coalesce(p_address, '')), '');
  v_cc text := nullif(upper(trim(coalesce(p_country_code, ''))), '');
  v_changed text[] := '{}';
begin
  select * into g from guests where id = p_guest for update;
  if not found or v_actor is null or not has_tenant_permission(g.tenant_id, 'guest.manage') then
    raise exception 'NOT_FOUND' using errcode = 'P0001';
  end if;

  if length(v_name) = 0 or length(v_name) > 200 then raise exception 'POLICY_VIOLATION: name' using errcode = 'P0001'; end if;
  if v_email is not null and (length(v_email) > 254 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') then
    raise exception 'POLICY_VIOLATION: email' using errcode = 'P0001';
  end if;
  if v_cc is not null and v_cc !~ '^[A-Z]{2}$' then raise exception 'POLICY_VIOLATION: country' using errcode = 'P0001'; end if;
  if length(coalesce(v_phone, '')) > 40 or length(coalesce(v_addr, '')) > 500 then
    raise exception 'POLICY_VIOLATION: too long' using errcode = 'P0001';
  end if;

  if g.full_name is distinct from v_name then v_changed := array_append(v_changed, 'full_name'::text); end if;
  if g.email is distinct from v_email then v_changed := array_append(v_changed, 'email'::text); end if;
  if g.phone is distinct from v_phone then v_changed := array_append(v_changed, 'phone'::text); end if;
  if g.address is distinct from v_addr then v_changed := array_append(v_changed, 'address'::text); end if;
  if g.country_code is distinct from v_cc then v_changed := array_append(v_changed, 'country_code'::text); end if;
  if cardinality(v_changed) = 0 then return jsonb_build_object('guest_id', g.id, 'changed', false); end if;

  update guests set full_name = v_name, email = v_email, phone = v_phone, address = v_addr, country_code = v_cc where id = g.id;
  perform write_audit(g.tenant_id, null, v_actor, 'guest.updated', 'guest', g.id, null, jsonb_build_object('fields', to_jsonb(v_changed)));
  return jsonb_build_object('guest_id', g.id, 'changed', true, 'fields', to_jsonb(v_changed));
end $$;

revoke all on function update_guest(uuid, text, text, text, text, text) from public, anon;
grant execute on function update_guest(uuid, text, text, text, text, text) to authenticated;
