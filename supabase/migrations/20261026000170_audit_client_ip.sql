-- 170 Audit log: the address a change came from (the prototype's "Audit Log" screen has an IP column).
--
-- audit_logs keeps who, what and when. This adds `client_ip`, the network address the staff member's request came from, so a hotel
-- can tell "the front desk at the hotel" from "a phone in another country" when something looks wrong.
--
-- How it gets there: the app's server client (lib/supabase/server.ts) sends the address it saw in front of the app (the same
-- `clientIp` the rate limits use) as the request header `x-client-ip`. PostgREST exposes request headers to the database as the
-- setting `request.headers`, and ONE trigger on audit_logs reads it when a row is inserted. One place, so every way of writing an
-- audit row (write_audit, the three direct inserts, the audit triggers) is covered, and a new one is covered without remembering.
--
-- What it does not do, on purpose:
--   * It never stops an audit row. A missing, malformed or odd header leaves client_ip null; the trigger swallows its own errors.
--   * Guests are not recorded. The guest site and the payment webhooks use the service client, which sends no address, so their
--     rows have null here. Only a signed-in person's requests carry one.
--   * It is the address the app reported, not proof. The app's host must overwrite X-Forwarded-For (docs/STAGING.md already says
--     so for the rate limits). Someone with a valid login who calls the database API directly, bypassing the app, could choose
--     what the header says; the row would still show who they are and what they did.
--   * It is stored as given, the whole address. audit_logs is append-only, so a stored address cannot later be shortened or
--     purged without a new migration: retention is a decision for the privacy review (TODO "Privacy review").
--   * The platform audit list (126) is unchanged: platform support still does not see hotel staff addresses.
--
-- Who can read it: whoever can read the row, which is people with audit.view at its property (row-level security, 007 and 030).

alter table audit_logs add column client_ip inet;

create function audit_logs_set_client_ip() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare v_ip inet;
begin
  if new.client_ip is not null then return new; end if;
  begin
    v_ip := nullif(btrim(nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-client-ip'), '')::inet;
    -- a host address only: "10.0.0.0/8" is a network, not where a request came from
    if v_ip is not null and masklen(v_ip) <> (case family(v_ip) when 4 then 32 else 128 end) then v_ip := null; end if;
  exception when others then
    v_ip := null; -- bad JSON, bad address: record nothing, never refuse the audit row
  end;
  new.client_ip := v_ip;
  return new;
end $$;

create trigger audit_logs_client_ip before insert on audit_logs
  for each row execute function audit_logs_set_client_ip();

revoke all on function audit_logs_set_client_ip() from public, anon, authenticated;
