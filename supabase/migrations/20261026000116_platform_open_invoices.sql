-- 116 Every unpaid invoice the platform has raised, across all hotels, in one list.
--
-- The platform raises invoices by hand (098) and nothing chases them, so the only way to find a late one was to open each hotel.
-- platform_open_invoices() is for platform support or admin (read only; the changes stay on the hotel's page, admin only). It returns
-- the open invoices (not paid, not void) of every hotel group, oldest due date first and ones with no due date last, at most 500:
-- invoice id and number, group id and name, period, amount, currency, due date and note. It changes nothing and returns no secrets.
-- Whether an invoice is late is the app's call (due date against today), as on the hotel's billing page.

create function platform_open_invoices() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform platform_require('support');
  return coalesce((select jsonb_agg(row_to_json(x)::jsonb) from (
    select i.id, i.number, i.tenant_id, t.name as tenant_name, i.period_start, i.period_end, i.amount_minor, i.currency, i.due_date, i.note
      from platform_invoices i join tenants t on t.id = i.tenant_id
     where i.status = 'open'
     order by i.due_date asc nulls last, i.created_at
     limit 500) x), '[]'::jsonb);
end $$;
revoke all on function platform_open_invoices() from public, anon;
grant execute on function platform_open_invoices() to authenticated;
