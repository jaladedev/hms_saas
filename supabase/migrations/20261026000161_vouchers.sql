-- 161 Gift and discount vouchers (TODO 8.4, second half; loyalty points are 159). Under the `loyalty` flag.
--
-- A hotel issues a voucher with a code. Staff apply it to a later booking as the booking's one discount. Two kinds:
--   gift      stored value. Spending part of it leaves the rest for another booking.
--   discount  one use: it takes its face value off one booking (never more than that booking's total) and is then used up, whatever is left.
-- Decisions, taken because the TODO left them open:
--   * Codes are made by the system (GV-XXXX-XXXX, no 0/O/1/I/L), unique per hotel, looked up in capitals. A voucher belongs to one hotel
--     (property): it cannot be spent at another property of the same group.
--   * Issuing needs property.configure. It does NOT record a payment: a sold gift voucher is money the hotel takes in its own books; this
--     only makes the value usable. Value 100 to 1,000,000 naira, optional expiry date (after the hotel's today, within 5 years), a note.
--   * Spending needs discount.apply (so the discounts flag turns it off too) and NO role cap. It is the booking's one discount, like points
--     and promo codes: a booking that already has a discount cannot take a voucher. Same guards as 058 and 159: a confirmed booking with no
--     payment, no live invoice and no payment in progress. The voucher pays room price plus tax, as every discount does (the open tax adviser
--     question in TODO.md applies unchanged). It never exceeds the booking's total.
--   * An expired voucher cannot be spent (the balance stays on the ledger and is shown as expired). Voiding writes the balance off.
--   * The ledger (voucher_ledger) is append-only: issue, redeem, reverse, void. A balance is the sum and can never go below zero; spending
--     locks the voucher first. Value comes back (a 'reverse' row) when the booking ends (cancelled, expired, no-show), when staff release
--     it, or whenever the booking's discount stops being exactly that voucher's. A voucher voided in the meantime is written off again at once.
--   * Staff only: a guest does not enter a voucher on the website yet (promo codes, 131, are the website's code).
--
--   voucher_issue(property, kind, amount_minor, expires_on, note, key)   property.configure and the flag. Returns { voucher_id, code }. Replay-safe.
--   voucher_void(voucher, reason)       property.configure: writes off the balance. INVALID_STATE: void | used.
--   voucher_list(property, limit)       property.configure: vouchers with balance and status (active | used | expired | void), newest first.
--   voucher_ledger_list(voucher)        property.configure.
--   voucher_booking(reservation)        reservation.view: the voucher on the booking (code, applied) for the booking page.
--   voucher_redeem(reservation, code, key)   discount.apply and the flag. POLICY_VIOLATION: loyalty off | voucher | voucher expired | voucher used
--                                       | voucher void | amount. INVALID_STATE: <status> | money held | invoice | payment in progress | discount. Replay-safe.
--   voucher_release(reservation, key)   discount.apply: removes the voucher and its discount, same guards. Replay-safe.
-- NOT_FOUND for no permission or another hotel, as everywhere.

create table vouchers (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants (id),
  property_id      uuid not null,
  code             text not null check (code ~ '^[A-Z0-9-]{6,24}$'),
  kind             text not null check (kind in ('gift', 'discount')),
  face_value_minor bigint not null check (face_value_minor between 10000 and 100000000),
  expires_on       date,
  note             text check (note is null or length(note) between 1 and 200),
  voided_at        timestamptz,
  voided_reason    text check (voided_reason is null or length(voided_reason) between 1 and 200),
  created_by       uuid,
  created_at       timestamptz not null default now(),
  unique (property_id, code),
  foreign key (tenant_id, property_id) references properties (tenant_id, id)
);
alter table vouchers enable row level security;
create policy vouchers_select on vouchers for select to authenticated using (has_permission(property_id, 'property.configure'));
revoke insert, update, delete on vouchers from authenticated, anon;

create table voucher_ledger (
  id             uuid primary key default gen_random_uuid(),
  seq            bigint generated always as identity,
  tenant_id      uuid not null references tenants (id),
  property_id    uuid not null,
  voucher_id     uuid not null references vouchers (id),
  kind           text not null check (kind in ('issue', 'redeem', 'reverse', 'void')),
  amount_minor   bigint not null check (amount_minor <> 0),
  applied_minor  bigint check (applied_minor is null or applied_minor > 0),
  reservation_id uuid references reservations (id),
  reverses_id    uuid references voucher_ledger (id),
  reason         text check (reason is null or length(reason) between 1 and 200),
  actor_user_id  uuid,
  created_at     timestamptz not null default now(),
  foreign key (tenant_id, property_id) references properties (tenant_id, id),
  check (
       (kind = 'issue'   and amount_minor > 0 and reservation_id is null and reverses_id is null and applied_minor is null)
    or (kind = 'redeem'  and amount_minor < 0 and reservation_id is not null and reverses_id is null and applied_minor is not null)
    or (kind = 'reverse' and amount_minor > 0 and reservation_id is not null and reverses_id is not null and applied_minor is null)
    or (kind = 'void'    and amount_minor < 0 and reason is not null and reservation_id is null and reverses_id is null and applied_minor is null)
  )
);
create unique index voucher_one_issue on voucher_ledger (voucher_id) where kind = 'issue';
create unique index voucher_one_reverse_per_redeem on voucher_ledger (reverses_id) where kind = 'reverse';
create index voucher_ledger_voucher_idx on voucher_ledger (voucher_id, seq);
create index voucher_ledger_reservation_idx on voucher_ledger (reservation_id) where reservation_id is not null;
alter table voucher_ledger enable row level security;
create policy voucher_ledger_select on voucher_ledger for select to authenticated using (has_permission(property_id, 'property.configure'));
revoke insert, update, delete on voucher_ledger from authenticated, anon;

create function voucher_ledger_append_only() returns trigger language plpgsql set search_path = public as $$
begin
  raise exception 'voucher_ledger is append-only' using errcode = '23514';
end $$;
create trigger voucher_ledger_no_change before update or delete on voucher_ledger
  for each row execute function voucher_ledger_append_only();

-- Face value and code never change after issue; only the void columns may be set, once.
create function vouchers_guard() returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then raise exception 'vouchers cannot be deleted' using errcode = '23514'; end if;
  if (new.id, new.tenant_id, new.property_id, new.code, new.kind, new.face_value_minor, new.expires_on, new.note, new.created_by, new.created_at)
     is distinct from (old.id, old.tenant_id, old.property_id, old.code, old.kind, old.face_value_minor, old.expires_on, old.note, old.created_by, old.created_at)
     or (old.voided_at is not null and new.voided_at is distinct from old.voided_at) then
    raise exception 'a voucher can only be voided' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger vouchers_no_change before update or delete on vouchers for each row execute function vouchers_guard();

create function voucher_balance_of(p_voucher uuid) returns bigint
language sql stable security definer set search_path = public as $$
  select coalesce(sum(amount_minor), 0)::bigint from voucher_ledger where voucher_id = p_voucher
$$;
revoke all on function voucher_balance_of(uuid) from public, anon, authenticated;

create function voucher_new_code(p_property uuid) returns text
language plpgsql security definer set search_path = public as $$
declare c_alpha constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; v text; i integer; n integer := 0;
begin
  loop
    v := 'GV-';
    for i in 1..8 loop
      v := v || substr(c_alpha, 1 + floor(random() * length(c_alpha))::integer, 1);
      if i = 4 then v := v || '-'; end if;
    end loop;
    exit when not exists (select 1 from vouchers where property_id = p_property and code = v);
    n := n + 1;
    if n > 20 then raise exception 'POLICY_VIOLATION: code' using errcode = 'P0001'; end if;
  end loop;
  return v;
end $$;
revoke all on function voucher_new_code(uuid) from public, anon, authenticated;

create function voucher_status(p_voucher uuid, p_today date) returns text
language sql stable security definer set search_path = public as $$
  select case
           when v.voided_at is not null then 'void'
           when voucher_balance_of(v.id) <= 0 then 'used'
           when v.expires_on is not null and v.expires_on < p_today then 'expired'
           else 'active' end
    from vouchers v where v.id = p_voucher
$$;
revoke all on function voucher_status(uuid, date) from public, anon, authenticated;

create function voucher_issue(p_property uuid, p_kind text, p_amount_minor bigint, p_expires_on date, p_note text, p_idempotency_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_prop properties%rowtype; v_actor uuid; v_idem record; v_hash text; v_note text := nullif(btrim(p_note), ''); v_today date; v_id uuid; v_code text; v_result jsonb;
begin
  select * into v_prop from properties where id = p_property;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(p_property, 'property.configure', 'NOT_FOUND');
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if not tenant_feature_on(v_prop.tenant_id, 'loyalty') then raise exception 'POLICY_VIOLATION: loyalty off' using errcode = 'P0001'; end if;
  v_today := property_today(p_property);
  if p_kind is null or p_kind not in ('gift', 'discount') then raise exception 'POLICY_VIOLATION: kind' using errcode = 'P0001'; end if;
  if p_amount_minor is null or p_amount_minor < 10000 or p_amount_minor > 100000000 then raise exception 'POLICY_VIOLATION: amount' using errcode = 'P0001'; end if;
  if p_expires_on is not null and (p_expires_on <= v_today or p_expires_on > v_today + 1826) then raise exception 'POLICY_VIOLATION: expiry' using errcode = 'P0001'; end if;
  if v_note is not null and length(v_note) > 200 then raise exception 'POLICY_VIOLATION: note' using errcode = 'P0001'; end if;

  v_hash := md5(concat_ws('|', p_property, p_kind, p_amount_minor, p_expires_on, coalesce(v_note, '')));
  select * into v_idem from idem_begin(v_prop.tenant_id, 'voucher_issue', p_idempotency_key, v_hash);
  if not v_idem.out_is_new then return v_idem.out_response; end if;

  v_code := voucher_new_code(p_property);
  insert into vouchers (tenant_id, property_id, code, kind, face_value_minor, expires_on, note, created_by)
  values (v_prop.tenant_id, p_property, v_code, p_kind, p_amount_minor, p_expires_on, v_note, v_actor) returning id into v_id;
  insert into voucher_ledger (tenant_id, property_id, voucher_id, kind, amount_minor, reason, actor_user_id)
  values (v_prop.tenant_id, p_property, v_id, 'issue', p_amount_minor, 'Issued', v_actor);

  v_result := jsonb_build_object('voucher_id', v_id, 'code', v_code, 'kind', p_kind, 'amount_minor', p_amount_minor, 'expires_on', p_expires_on);
  perform idem_finish(v_prop.tenant_id, 'voucher_issue', p_idempotency_key, v_result);
  perform write_audit(v_prop.tenant_id, p_property, v_actor, 'voucher.issued', 'voucher', v_id, p_idempotency_key,
                      jsonb_build_object('code', v_code, 'kind', p_kind, 'amount_minor', p_amount_minor, 'expires_on', p_expires_on));
  return v_result;
end $$;
revoke all on function voucher_issue(uuid, text, bigint, date, text, text) from public, anon;
grant execute on function voucher_issue(uuid, text, bigint, date, text, text) to authenticated;

create function voucher_void(p_voucher uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v vouchers%rowtype; v_actor uuid; v_reason text := nullif(btrim(p_reason), ''); v_bal bigint;
begin
  select * into v from vouchers where id = p_voucher;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(v.property_id, 'property.configure', 'NOT_FOUND');
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if v_reason is null or length(v_reason) > 200 then raise exception 'POLICY_VIOLATION: reason' using errcode = 'P0001'; end if;
  select * into v from vouchers where id = p_voucher for update;
  if v.voided_at is not null then raise exception 'INVALID_STATE: void' using errcode = 'P0001'; end if;
  v_bal := voucher_balance_of(v.id);
  if v_bal <= 0 then raise exception 'INVALID_STATE: used' using errcode = 'P0001'; end if;
  update vouchers set voided_at = now(), voided_reason = v_reason where id = v.id;
  insert into voucher_ledger (tenant_id, property_id, voucher_id, kind, amount_minor, reason, actor_user_id)
  values (v.tenant_id, v.property_id, v.id, 'void', -v_bal, v_reason, v_actor);
  perform write_audit(v.tenant_id, v.property_id, v_actor, 'voucher.voided', 'voucher', v.id, null,
                      jsonb_build_object('code', v.code, 'written_off_minor', v_bal, 'reason', v_reason));
  return jsonb_build_object('voucher_id', v.id, 'written_off_minor', v_bal);
end $$;
revoke all on function voucher_void(uuid, text) from public, anon;
grant execute on function voucher_void(uuid, text) to authenticated;

create function voucher_list(p_property uuid, p_limit integer default 200) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_today date;
begin
  if p_property is null or not has_permission(p_property, 'property.configure') then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_today := property_today(p_property);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', v.id, 'code', v.code, 'kind', v.kind, 'face_value_minor', v.face_value_minor, 'balance_minor', voucher_balance_of(v.id),
             'status', voucher_status(v.id, v_today), 'expires_on', v.expires_on, 'note', v.note, 'created_at', v.created_at) order by v.created_at desc, v.id)
      from (select * from vouchers where property_id = p_property order by created_at desc, id limit least(greatest(coalesce(p_limit, 200), 1), 500)) v), '[]'::jsonb);
end $$;
revoke all on function voucher_list(uuid, integer) from public, anon;
grant execute on function voucher_list(uuid, integer) to authenticated;

create function voucher_ledger_list(p_voucher uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v vouchers%rowtype;
begin
  select * into v from vouchers where id = p_voucher;
  if not found or not has_permission(v.property_id, 'property.configure') then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('kind', l.kind, 'amount_minor', l.amount_minor, 'reservation_id', l.reservation_id,
                                                       'booking_reference', r.booking_reference, 'reason', l.reason, 'created_at', l.created_at) order by l.seq desc)
                     from voucher_ledger l left join reservations r on r.id = l.reservation_id where l.voucher_id = v.id), '[]'::jsonb);
end $$;
revoke all on function voucher_ledger_list(uuid) from public, anon;
grant execute on function voucher_ledger_list(uuid) to authenticated;

create function voucher_booking(p_reservation uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r reservations%rowtype; l voucher_ledger%rowtype; v vouchers%rowtype;
begin
  select * into r from reservations where id = p_reservation;
  if not found or not has_permission(r.property_id, 'reservation.view') then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if not tenant_feature_on(r.tenant_id, 'loyalty') then return jsonb_build_object('enabled', false); end if;
  select * into l from voucher_ledger x
   where x.reservation_id = r.id and x.kind = 'redeem'
     and not exists (select 1 from voucher_ledger y where y.reverses_id = x.id and y.kind = 'reverse');
  if found then
    select * into v from vouchers where id = l.voucher_id;
    return jsonb_build_object('enabled', true, 'applied', true, 'code', v.code, 'kind', v.kind, 'applied_minor', l.applied_minor);
  end if;
  return jsonb_build_object('enabled', true, 'applied', false);
end $$;
revoke all on function voucher_booking(uuid) from public, anon;
grant execute on function voucher_booking(uuid) to authenticated;

create function voucher_redeem(p_reservation uuid, p_code text, p_idempotency_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r reservations%rowtype; v vouchers%rowtype; v_actor uuid; v_idem record; v_hash text; v_code text := upper(btrim(coalesce(p_code, '')));
  v_bal bigint; v_applied bigint; v_deduct bigint; v_status text; v_result jsonb;
begin
  select * into r from reservations where id = p_reservation;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(r.property_id, 'discount.apply', 'NOT_FOUND');
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if not tenant_feature_on(r.tenant_id, 'loyalty') then raise exception 'POLICY_VIOLATION: loyalty off' using errcode = 'P0001'; end if;
  select * into v from vouchers where property_id = r.property_id and code = v_code;
  if not found then raise exception 'POLICY_VIOLATION: voucher' using errcode = 'P0001'; end if;

  v_hash := md5(concat_ws('|', p_reservation, v_code));
  select * into v_idem from idem_begin(r.tenant_id, 'voucher_redeem', p_idempotency_key, v_hash);
  if not v_idem.out_is_new then return v_idem.out_response; end if;

  select * into r from reservations where id = p_reservation for update;
  if r.reservation_status <> 'confirmed' then raise exception 'INVALID_STATE: %', r.reservation_status using errcode = 'P0001'; end if;
  if exists (select 1 from payments where reservation_id = r.id) then raise exception 'INVALID_STATE: money held' using errcode = 'P0001'; end if;
  if exists (select 1 from invoices where reservation_id = r.id and invoice_status <> 'void') then raise exception 'INVALID_STATE: invoice' using errcode = 'P0001'; end if;
  if exists (select 1 from payment_attempts where reservation_id = r.id and status = 'initiated') then raise exception 'INVALID_STATE: payment in progress' using errcode = 'P0001'; end if;
  if r.discount_minor > 0 then raise exception 'INVALID_STATE: discount' using errcode = 'P0001'; end if;

  select * into v from vouchers where id = v.id for update;          -- two spends of one voucher queue here
  v_status := voucher_status(v.id, property_today(r.property_id));
  if v_status <> 'active' then raise exception 'POLICY_VIOLATION: voucher %', v_status using errcode = 'P0001'; end if;
  v_bal := voucher_balance_of(v.id);
  v_applied := least(v_bal, r.subtotal_minor + r.tax_minor);
  if v_applied <= 0 then raise exception 'POLICY_VIOLATION: amount' using errcode = 'P0001'; end if;
  v_deduct := case when v.kind = 'discount' then v_bal else v_applied end;      -- a discount voucher is used up whatever is left

  update reservations set discount_minor = v_applied, discount_percent = null, discount_amount_minor = v_applied,
         discount_reason = 'Voucher ' || v.code, total_minor = subtotal_minor + tax_minor - v_applied
   where id = r.id returning * into r;
  insert into voucher_ledger (tenant_id, property_id, voucher_id, kind, amount_minor, applied_minor, reservation_id, reason, actor_user_id)
  values (r.tenant_id, r.property_id, v.id, 'redeem', -v_deduct, v_applied, r.id, 'Booking ' || r.booking_reference, v_actor);

  v_result := jsonb_build_object('reservation_id', r.id, 'changed', true, 'code', v.code, 'applied_minor', v_applied, 'total_minor', r.total_minor,
                                 'balance_minor', v_bal - v_deduct);
  perform idem_finish(r.tenant_id, 'voucher_redeem', p_idempotency_key, v_result);
  perform write_audit(r.tenant_id, r.property_id, v_actor, 'voucher.redeemed', 'reservation', r.id, p_idempotency_key,
                      jsonb_build_object('code', v.code, 'applied_minor', v_applied, 'to_total_minor', r.total_minor));
  return v_result;
end $$;
revoke all on function voucher_redeem(uuid, text, text) from public, anon;
grant execute on function voucher_redeem(uuid, text, text) to authenticated;

create function voucher_release(p_reservation uuid, p_idempotency_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r reservations%rowtype; v_actor uuid; v_idem record; v_hash text; l voucher_ledger%rowtype; v_result jsonb; v_code text;
begin
  select * into r from reservations where id = p_reservation;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(r.property_id, 'discount.apply', 'NOT_FOUND');
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;

  v_hash := md5(concat_ws('|', p_reservation, 'release'));
  select * into v_idem from idem_begin(r.tenant_id, 'voucher_release', p_idempotency_key, v_hash);
  if not v_idem.out_is_new then return v_idem.out_response; end if;

  select * into r from reservations where id = p_reservation for update;
  if r.reservation_status <> 'confirmed' then raise exception 'INVALID_STATE: %', r.reservation_status using errcode = 'P0001'; end if;
  if exists (select 1 from payments where reservation_id = r.id) then raise exception 'INVALID_STATE: money held' using errcode = 'P0001'; end if;
  if exists (select 1 from invoices where reservation_id = r.id and invoice_status <> 'void') then raise exception 'INVALID_STATE: invoice' using errcode = 'P0001'; end if;
  if exists (select 1 from payment_attempts where reservation_id = r.id and status = 'initiated') then raise exception 'INVALID_STATE: payment in progress' using errcode = 'P0001'; end if;

  select * into l from voucher_ledger x
   where x.reservation_id = r.id and x.kind = 'redeem'
     and not exists (select 1 from voucher_ledger y where y.reverses_id = x.id and y.kind = 'reverse');
  if not found then
    v_result := jsonb_build_object('reservation_id', r.id, 'changed', false);
    perform idem_finish(r.tenant_id, 'voucher_release', p_idempotency_key, v_result);
    return v_result;
  end if;
  select code into v_code from vouchers where id = l.voucher_id;

  -- removing the discount makes the trigger below write the reversal: one path for giving value back
  update reservations set discount_minor = 0, discount_percent = null, discount_amount_minor = null, discount_reason = null,
         total_minor = subtotal_minor + tax_minor
   where id = r.id returning * into r;

  v_result := jsonb_build_object('reservation_id', r.id, 'changed', true, 'code', v_code, 'total_minor', r.total_minor,
                                 'balance_minor', voucher_balance_of(l.voucher_id));
  perform idem_finish(r.tenant_id, 'voucher_release', p_idempotency_key, v_result);
  perform write_audit(r.tenant_id, r.property_id, v_actor, 'voucher.released', 'reservation', r.id, p_idempotency_key,
                      jsonb_build_object('code', v_code, 'to_total_minor', r.total_minor));
  return v_result;
end $$;
revoke all on function voucher_release(uuid, text) from public, anon;
grant execute on function voucher_release(uuid, text) to authenticated;

-- Give value back when the booking ends or its discount is no longer exactly the voucher's. Runs inside the statement that changes the
-- booking, so it never raises for anything but the ledger's own rules. A voucher voided meanwhile is written off again at once.
create function voucher_on_reservation_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_ended constant text[] := array['cancelled', 'expired', 'no_show']; l record; v_rev uuid; v vouchers%rowtype;
begin
  if (new.reservation_status = any (v_ended) and old.reservation_status <> all (v_ended))
     or new.discount_minor is distinct from old.discount_minor then
    for l in
      select x.* from voucher_ledger x
       where x.reservation_id = new.id and x.kind = 'redeem'
         and not exists (select 1 from voucher_ledger y where y.reverses_id = x.id and y.kind = 'reverse')
         and (new.reservation_status = any (v_ended) or new.discount_minor is distinct from x.applied_minor)
    loop
      insert into voucher_ledger (tenant_id, property_id, voucher_id, kind, amount_minor, reservation_id, reverses_id, reason, actor_user_id)
      values (l.tenant_id, l.property_id, l.voucher_id, 'reverse', -l.amount_minor, l.reservation_id, l.id,
              case when new.reservation_status = any (v_ended) then 'Booking ended' else 'Discount changed' end, auth.uid())
      returning id into v_rev;
      select * into v from vouchers where id = l.voucher_id;
      if v.voided_at is not null then
        insert into voucher_ledger (tenant_id, property_id, voucher_id, kind, amount_minor, reason, actor_user_id)
        values (l.tenant_id, l.property_id, l.voucher_id, 'void', l.amount_minor, 'Voided voucher', auth.uid());
      end if;
    end loop;
  end if;
  return null;
end $$;
create trigger voucher_reservation_change after update of reservation_status, discount_minor on reservations
  for each row when (old.reservation_status is distinct from new.reservation_status or old.discount_minor is distinct from new.discount_minor)
  execute function voucher_on_reservation_change();
