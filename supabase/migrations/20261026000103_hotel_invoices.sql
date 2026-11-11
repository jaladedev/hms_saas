-- 103 A hotel sees the invoices the platform has raised to it.
--
-- Migration 098 lets a platform admin raise, settle and void invoices to a hotel group, and keeps them away from hotels. This adds the
-- hotel's own read-only view, so the owner can see what is open, what is due and what was paid without asking.
--
-- hotel_billing(property): for someone with property.configure at that hotel (the owner and general manager, as for hotel setup).
-- NOT_FOUND for anyone else, another hotel or an unknown property. Returns the group's current plan code and its invoices, newest
-- period first. Void invoices are left out (they were withdrawn, and the reason is internal). Nothing else of the platform side is
-- returned: no creator, no internal ids other than the invoice id.

create function hotel_billing(p_property uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_tenant uuid;
begin
  select tenant_id into v_tenant from properties where id = p_property;
  if v_tenant is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  perform require_permission(p_property, 'property.configure', 'NOT_FOUND');
  return jsonb_build_object(
    'plan_code', (select s.plan_code from tenant_subscriptions s where s.tenant_id = v_tenant order by s.created_at desc limit 1),
    'invoices', coalesce((select jsonb_agg(jsonb_build_object(
        'id', i.id, 'number', i.number, 'period_start', i.period_start, 'period_end', i.period_end, 'amount_minor', i.amount_minor,
        'currency', i.currency, 'status', i.status, 'due_date', i.due_date, 'note', i.note, 'paid_at', i.paid_at, 'payment_ref', i.payment_ref)
        order by i.period_start desc, i.created_at desc)
      from platform_invoices i where i.tenant_id = v_tenant and i.status <> 'void'), '[]'::jsonb));
end $$;
revoke all on function hotel_billing(uuid) from public, anon;
grant execute on function hotel_billing(uuid) to authenticated;
