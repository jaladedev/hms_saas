-- 091 Adding a guest without a booking, as an audited function (prototype screen "Create / Edit Guest").
--
-- Until now a guest row was only ever made as a side effect of a booking (the staff booking form inserts one through row
-- level security; the website holds insert one inside create_hold). This is the audited door for adding someone on their
-- own, mirroring update_guest (020): it checks guest.manage for the hotel group, validates and normalises the same fields,
-- and writes one audit row naming the fields given (not their values, so personal data is not copied into the log).
--
-- Guests belong to the hotel group (tenant), not to one hotel, so the function takes a property only to say which group.
-- A guest with the same email already in the group is NOT added twice: the existing one is returned with created = false,
-- the same rule the booking forms use so a repeat visitor keeps one record. A guest with no email is always added.

create function create_guest(p_property uuid, p_full_name text, p_email text, p_phone text, p_address text, p_country_code text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := auth.uid(); v_tenant uuid; v_id uuid;
  v_name text := regexp_replace(trim(coalesce(p_full_name, '')), '\s+', ' ', 'g');
  v_email text := nullif(lower(trim(coalesce(p_email, ''))), '');
  v_phone text := nullif(trim(coalesce(p_phone, '')), '');
  v_addr text := nullif(trim(coalesce(p_address, '')), '');
  v_cc text := nullif(upper(trim(coalesce(p_country_code, ''))), '');
  v_fields text[] := '{}';
begin
  select tenant_id into v_tenant from properties where id = p_property;
  if v_tenant is null or v_actor is null or not has_tenant_permission(v_tenant, 'guest.manage') then
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

  -- Two people adding the same email at once must not make two records: serialise on the group and the address.
  if v_email is not null then
    perform pg_advisory_xact_lock(hashtextextended('create_guest:' || v_tenant || ':' || v_email, 0));
    select id into v_id from guests where tenant_id = v_tenant and lower(email) = v_email order by created_at limit 1;
    if v_id is not null then return jsonb_build_object('guest_id', v_id, 'created', false); end if;
  end if;

  insert into guests (tenant_id, full_name, email, phone, address, country_code)
  values (v_tenant, v_name, v_email, v_phone, v_addr, v_cc) returning id into v_id;

  v_fields := array['full_name'];
  if v_email is not null then v_fields := array_append(v_fields, 'email'); end if;
  if v_phone is not null then v_fields := array_append(v_fields, 'phone'); end if;
  if v_addr is not null then v_fields := array_append(v_fields, 'address'); end if;
  if v_cc is not null then v_fields := array_append(v_fields, 'country_code'); end if;
  perform write_audit(v_tenant, null, v_actor, 'guest.created', 'guest', v_id, null, jsonb_build_object('fields', to_jsonb(v_fields)));
  return jsonb_build_object('guest_id', v_id, 'created', true);
end $$;

revoke all on function create_guest(uuid, text, text, text, text, text) from public, anon;
grant execute on function create_guest(uuid, text, text, text, text, text) to authenticated;
