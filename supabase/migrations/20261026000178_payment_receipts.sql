-- 178 Receipts on a recorded payment (prototype "Record Manual Payment" and "Payment Details": a picture or PDF of the bank slip,
-- POS slip or cash receipt). Until now a payment kept only a reference number.
--
--   * `payment_receipts`: one row per file (tenant, property, payment, storage path, content type, size). The file lives in the
--     PRIVATE Storage bucket `payment-receipts`: nobody reaches it by address. The app shows it with a short-lived signed link
--     made after it has read the row as the signed-in person, so the row's access rule is the file's access rule.
--   * who: read by whoever may see money at the property (can_view_money, as for payments); attach and remove with payment.record,
--     the permission that records a payment. A receipt is never edited: there is no update, so a wrong file is removed and a right one
--     added, and both are in the audit trail (`payment_receipt.created` and `.deleted`, which name the path, never the file).
--   * limits, enforced here so no script can break them: JPEG, PNG, WebP or PDF; 1 byte to 5 MB; at most 3 files per payment (a
--     trigger that locks the payment row, lightly, while it counts); the path must be exactly `<tenant>/<property>/<payment>/<uuid>.<ext>`; the
--     row's property must be the payment's own property (the policies read it), so a receipt can never hang off a payment of a
--     property its writer has no rights at.
--   * the payment is not touched. Attaching or removing a receipt changes no amount, status, allocation or verification: it is a
--     document beside the payment, and a payment is never changed by it.
--   * the file store is outside the database, so the app removes the file BEFORE the row on removal (a failed file removal leaves
--     the row and an error; a failed row removal leaves a row whose file is gone and can be removed again), and on adding it writes
--     the row first and withdraws it if the upload fails. No queue is needed because payments are never deleted, so no cascade can
--     strand a file.
--   * the bucket is created here when Storage exists (not in the plain-Postgres test database): private, 5 MB, the four types.
--     Uploads and signed links are made by the server with the service role after the checks above, never from the browser, so the
--     bucket needs no policy for logins.

create table payment_receipts (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null,
  property_id   uuid not null,
  payment_id    uuid not null,
  storage_path  text not null unique,
  content_type  text not null check (content_type in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  size_bytes    integer not null check (size_bytes between 1 and 5242880),
  uploaded_by   uuid default auth.uid(),
  created_at    timestamptz not null default now(),
  foreign key (tenant_id, payment_id) references payments (tenant_id, id),
  constraint payment_receipts_path_check check (storage_path ~ ('^' || tenant_id::text || '/' || property_id::text || '/' || payment_id::text
    || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](jpg|png|webp|pdf)$'))
);
create index on payment_receipts (payment_id, created_at);

alter table payment_receipts enable row level security;
create policy payment_receipts_select on payment_receipts for select to authenticated using (can_view_money(property_id));
create policy payment_receipts_insert on payment_receipts for insert to authenticated with check (has_permission(property_id, 'payment.record'));
create policy payment_receipts_delete on payment_receipts for delete to authenticated using (has_permission(property_id, 'payment.record'));
revoke all on payment_receipts from anon;
revoke update on payment_receipts from authenticated;

-- Runs as the owner: it must lock and read the payment, which logins cannot lock. It only refuses or lets the row through; the
-- row-level policies still decide who may write it (they run after this trigger).
create function payment_receipts_check() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_property uuid;
begin
  select property_id into v_property from payments where id = new.payment_id and tenant_id = new.tenant_id for no key update;
  if v_property is null or v_property <> new.property_id then
    raise exception 'POLICY_VIOLATION: receipt property' using errcode = 'P0001';
  end if;
  if (select count(*) from payment_receipts where payment_id = new.payment_id) >= 3 then
    raise exception 'POLICY_VIOLATION: receipts limit' using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke all on function payment_receipts_check() from public, anon, authenticated;   -- STAGING step 4c: only three functions are callable by anon
create trigger payment_receipts_check before insert on payment_receipts
  for each row execute function payment_receipts_check();

create trigger payment_receipts_audit after insert or delete on payment_receipts
  for each row execute function audit_setup_row('payment_receipt', 'payment_id,storage_path,content_type,size_bytes');

do $b$ begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('payment-receipts', 'payment-receipts', false, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
    on conflict (id) do update set public = false, file_size_limit = 5242880, allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
  end if;
end $b$;
