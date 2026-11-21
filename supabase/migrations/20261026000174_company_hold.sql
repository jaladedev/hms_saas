-- 174 Group bookings, step fourteen: put a company on hold when it pays late (the last leftover of 8.7, "blocking when overdue").
-- A company account can have hold_after_days (null = no hold, the default; 1 to 365). While any of its issued group invoices is more than that many
-- days past its due date (in the hotel's day), no further group booking can be linked to the company: set_group_company refuses with
-- POLICY_VIOLATION: company on hold. Nothing that already exists is touched: groups already linked, their invoices, payments, credit and
-- reminders all carry on, so the company can still pay its way out. Unlinking (p_company null) and re-linking the same company are always allowed.
-- Setting the number is a company.manage action (company_set_hold) and is audited with the new value; anyone else gets NOT_FOUND.
-- company_list returns hold_after_days and on_hold (true while the rule is tripping) for the screen.

alter table company_accounts add column hold_after_days smallint check (hold_after_days is null or hold_after_days between 1 and 365);

create function company_on_hold(p_company uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(c.hold_after_days is not null and exists (
           select 1 from group_invoices i join group_bookings b on b.id = i.group_id
            where b.company_id = c.id and i.invoice_status = 'issued'
              and i.due_date < property_today(c.property_id) - c.hold_after_days), false)
    from company_accounts c where c.id = p_company
$$;
revoke all on function company_on_hold(uuid) from public, anon, authenticated;

create function company_set_hold(p_company uuid, p_days integer) returns void
language plpgsql security definer set search_path = public as $$
declare c company_accounts%rowtype; g record;
begin
  select * into c from company_accounts where id = p_company for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  select * into g from company_guard(c.property_id);
  if p_days is not null and p_days not between 1 and 365 then raise exception 'POLICY_VIOLATION: details' using errcode = 'P0001'; end if;
  if c.hold_after_days is not distinct from p_days then return; end if;
  update company_accounts set hold_after_days = p_days where id = c.id;
  perform write_audit(g.o_tenant, c.property_id, g.o_actor, 'company.hold_set', 'company', c.id, null,
                      jsonb_build_object('old', c.hold_after_days, 'hold_after_days', p_days));
end $$;
revoke all on function company_set_hold(uuid, integer) from public, anon;
grant execute on function company_set_hold(uuid, integer) to authenticated;

create or replace function set_group_company(p_group uuid, p_company uuid) returns void
language plpgsql security definer set search_path = public as $$
declare b group_bookings%rowtype; g record; c company_accounts%rowtype;
begin
  select * into b from group_bookings where id = p_group for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  select * into g from group_guard(b.property_id);
  if b.status = 'cancelled' then raise exception 'INVALID_STATE: cancelled' using errcode = 'P0001'; end if;
  if p_company is not null then
    select * into c from company_accounts where id = p_company and property_id = b.property_id and status = 'active';
    if not found then raise exception 'POLICY_VIOLATION: company' using errcode = 'P0001'; end if;
    if b.company_id is distinct from p_company and company_on_hold(p_company) then raise exception 'POLICY_VIOLATION: company on hold' using errcode = 'P0001'; end if;
  end if;
  update group_bookings set company_id = p_company where id = b.id;
  perform write_audit(g.o_tenant, b.property_id, g.o_actor, 'group.company_set', 'group', b.id, null, jsonb_build_object('company_id', p_company));
end $$;

create or replace function company_list(p_property uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not (has_permission(p_property, 'group.manage') or has_permission(p_property, 'company.manage')) then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'billing_contact', c.billing_contact, 'billing_email', c.billing_email,
           'billing_phone', c.billing_phone, 'credit_days', c.credit_days, 'discount_percent', c.discount_percent, 'status', c.status, 'notes', c.notes,
           'groups', (select count(*) from group_bookings b where b.company_id = c.id),
           'credit_limit_minor', c.credit_limit_minor, 'auto_apply_rate', c.auto_apply_rate, 'remind_overdue', c.remind_overdue, 'remind_sms', c.remind_sms, 'hold_after_days', c.hold_after_days, 'on_hold', company_on_hold(c.id),
           'rates', (select coalesce(jsonb_agg(jsonb_build_object('room_type_id', rr.room_type_id, 'room_type_name', t.name, 'mode', rr.mode,
                                'nightly_rate_minor', rr.nightly_rate_minor, 'percent', rr.percent) order by t.name), '[]'::jsonb)
                       from company_room_rates rr join room_types t on t.id = rr.room_type_id where rr.company_id = c.id),
           'exposure_minor', (select coalesce(sum(i.total_minor), 0) from group_invoices i join group_bookings b on b.id = i.group_id where b.company_id = c.id and i.invoice_status = 'issued'),
           'overdue_minor', (select coalesce(sum(i.total_minor), 0) from group_invoices i join group_bookings b on b.id = i.group_id
                              where b.company_id = c.id and i.invoice_status = 'issued' and i.due_date < property_today(c.property_id))) order by (c.status = 'active') desc, lower(c.name))
         from company_accounts c where c.property_id = p_property), '[]'::jsonb);
end $$;
revoke all on function company_list(uuid) from public, anon;
grant execute on function company_list(uuid) to authenticated;
