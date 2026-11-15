-- 133 Guest search: the service charge, shown apart from tax.
--   search_availability (last defined in 080) gains `service_minor` on each room type: the part of `tax_minor` that is a service charge
--   (migration 132), summed over the nights with calc_night_service. `tax_minor` and `total_minor` are unchanged, so the guest still pays
--   the same amount; the website can now show "Service charge" and "Tax" as separate lines. Nothing else in the answer changes.

create or replace function search_availability(p_host text, p_arrival date, p_departure date, p_adults integer, p_children integer default 0)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  c_max_nights  constant integer := 30;
  c_max_advance constant integer := 365;
  v_tenant uuid; v_property uuid; v_today date; v_prop record; v_plan uuid;
  t record; v_free integer; v_night date; v_rate bigint; v_tax bigint; v_sub bigint; v_taxsum bigint; v_svc bigint;
  v_nights jsonb; v_ok boolean; v_types jsonb := '[]'::jsonb;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select h.tenant_id, h.property_id into v_tenant, v_property from resolve_host(p_host) h;
  v_today := property_today(v_property);

  if p_arrival is null or p_departure is null or p_departure <= p_arrival then
    raise exception 'POLICY_VIOLATION: departure must follow arrival' using errcode = 'P0001';
  end if;
  if p_arrival < v_today then raise exception 'POLICY_VIOLATION: arrival in the past' using errcode = 'P0001'; end if;
  if p_departure - p_arrival > c_max_nights then raise exception 'POLICY_VIOLATION: stay too long' using errcode = 'P0001'; end if;
  if p_arrival > v_today + c_max_advance then raise exception 'POLICY_VIOLATION: arrival too far ahead' using errcode = 'P0001'; end if;
  if p_adults is null or p_adults < 1 or p_adults > 20 or p_children is null or p_children < 0 or p_children > 20 then
    raise exception 'POLICY_VIOLATION: party size' using errcode = 'P0001';
  end if;

  select name, currency, check_in_time, check_out_time, timezone into v_prop from properties where id = v_property;
  select id into v_plan from rate_plans where property_id = v_property and is_default and status = 'active';

  for t in
    select * from room_types rt
     where rt.property_id = v_property and rt.is_public and rt.status = 'active'
       and p_adults <= rt.max_adults and p_children <= rt.max_children and p_adults + p_children <= rt.max_occupancy
     order by rt.base_rate_minor, rt.name
  loop
    select count(*) into v_free from rooms r
     where r.property_id = v_property and r.room_type_id = t.id and r.operational_status = 'active'
       and not exists (
         select 1 from room_inventory_claims c
          where c.room_id = r.id and c.status = 'active'
            and (c.claim_type <> 'hold' or c.hold_expires_at > now())
            and daterange(c.start_date, c.end_date, '[)') && daterange(p_arrival, p_departure, '[)'));
    continue when v_free = 0 or v_plan is null;

    v_sub := 0; v_taxsum := 0; v_svc := 0; v_nights := '[]'::jsonb; v_ok := true;
    for v_night in select generate_series(p_arrival, p_departure - 1, interval '1 day')::date loop
      begin
        select amount_minor into v_rate from resolve_rate(v_property, t.id, v_plan, v_night);
      exception when sqlstate 'P0001' then
        v_ok := false; exit;
      end;
      v_tax := calc_night_tax(v_property, v_night, v_rate) + case when v_night = p_arrival then calc_stay_tax(v_property, p_arrival) else 0 end;   -- 057
      v_sub := v_sub + v_rate; v_taxsum := v_taxsum + v_tax;
      v_svc := v_svc + least(calc_night_service(v_property, v_night, v_rate), calc_night_tax(v_property, v_night, v_rate));   -- 132
      v_nights := v_nights || jsonb_build_object('date', v_night, 'rate_minor', v_rate);
    end loop;
    continue when not v_ok;

    v_types := v_types || jsonb_build_object(
      'room_type_id', t.id, 'name', t.name, 'description', t.description, 'bed_config', t.bed_config,
      'amenities', to_jsonb(t.amenities),   -- 077
      'photos', coalesce((select jsonb_agg(jsonb_build_object('path', p.storage_path, 'caption', p.caption) order by p.sort_order, p.created_at)
                            from room_type_photos p where p.room_type_id = t.id), '[]'::jsonb),   -- 080
      'max_adults', t.max_adults, 'max_children', t.max_children, 'max_occupancy', t.max_occupancy,
      'rooms_available', v_free, 'nights', v_nights,
      'subtotal_minor', v_sub, 'tax_minor', v_taxsum, 'service_minor', v_svc, 'total_minor', v_sub + v_taxsum);
  end loop;

  return jsonb_build_object(
    'property_name', v_prop.name, 'currency', v_prop.currency, 'timezone', v_prop.timezone,
    'check_in_time', v_prop.check_in_time, 'check_out_time', v_prop.check_out_time,
    'arrival_date', p_arrival, 'departure_date', p_departure, 'nights', p_departure - p_arrival,
    'adults', p_adults, 'children', p_children, 'room_types', v_types);
end $$;
