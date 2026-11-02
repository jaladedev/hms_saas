-- 032 Policy text for the guest booking site, service_role only (the Next.js server calls it with the host it
-- received; nothing here trusts an id from the browser).
--
-- guest_policy(host): the cancellation and payment policy in force today at the property behind the host, the same
-- one create_reservation copies into a booking's snapshot (current_policy), so what a guest reads is what applies.
-- Only the keys a guest needs are returned (cancellation_rules, online_payment, checkin_payment): anything else in
-- the stored config stays private. No policy yet returns empty rules and the defaults the database applies:
-- full payment online, no check-in requirement, free cancellation.

create function guest_policy(p_host text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_tenant uuid; v_property uuid; v_today date; v_cfg jsonb; v_currency text;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select h.tenant_id, h.property_id into v_tenant, v_property from resolve_host(p_host) h;
  v_today := property_today(v_property);
  v_cfg := current_policy(v_property, v_today);
  select currency into v_currency from properties where id = v_property;
  return jsonb_build_object(
    'currency', v_currency,
    'cancellation_rules', coalesce(v_cfg -> 'cancellation_rules', '[]'::jsonb),
    'online_payment', coalesce(v_cfg -> 'online_payment', '{"mode":"full"}'::jsonb),
    'checkin_payment', coalesce(v_cfg -> 'checkin_payment', '"none"'::jsonb));
end $$;

revoke all on function guest_policy(text) from public, anon, authenticated;
grant execute on function guest_policy(text) to service_role;
