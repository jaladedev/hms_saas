-- 159 Loyalty points (TODO 8.4, first half; vouchers are the second half and are not here).
--
-- A guest earns points on a completed stay and can spend them as a discount on a later booking. Staff do the spending (a guest cannot
-- redeem alone yet); the guest sees the balance on the booking link. Decisions, taken because the TODO left them open:
--   * What earns: the ROOM price only (reservations.subtotal_minor, after any discount), not tax and not extras (POS, experiences, folio
--     charges). A booking paid partly with points therefore earns less: the discount is taken off the room price first.
--   * When: when the booking becomes checked_out. Cancelled, expired and no-show bookings never earn. One earn row per booking.
--   * How much: floor(base / 100 naira) * earn_per_100, a per-property setting (1 to 50 points per 100 naira). A point is worth
--     point_value_minor kobo when spent (per-property, 10 to 10000). Default 1 point per 100 naira, 1 naira a point, which is 1% back.
--   * Who: one account per hotel GROUP (tenant) and e-mail address, never across groups. A guest with no e-mail on the booking has no
--     account. The key is the lower-cased, trimmed address. Names and phone numbers play no part.
--   * Spending: apply path of 058 and 062. A points redemption is a fixed-amount discount with the reason 'Loyalty points', so it uses the
--     same figures, the same tax rule (the discount comes off room price plus tax, so points can pay tax; the open tax adviser question in
--     TODO.md applies unchanged) and the same guards: a confirmed booking with no payment, no live invoice and no payment in progress. It
--     needs discount.apply (so the discounts flag turns it off too) and NO role cap: the guest earned it. A booking that already has a
--     discount (a promo code, a percentage, an amount) cannot take points: one discount per booking.
--   * Giving back: a redemption is reversed, with a ledger row, when the booking is cancelled, expires or is marked a no-show, when staff
--     release it, and whenever the booking's discount stops being exactly that redemption (a staff discount replaces it, 058 and 062).
--   * No expiry and no tiers in this version. The ledger has no kind for them, on purpose, so adding them is a new migration, not a
--     reinterpretation of rows.
--   * The ledger is append-only (a trigger refuses update and delete), like folio_payments. A balance is the sum of points for the key and
--     can never go below zero: spending and negative adjustments take a lock on the account, then check.
-- Settings are off by default for every property (loyalty_settings.enabled), and the `loyalty` flag (no row = on, as since 052) can switch
-- the whole group off. Writes to the settings go through save_loyalty_settings (property.configure, as for offers in 102).
--
--   loyalty_settings_get(property)           property.configure or discount.apply: the settings (defaults when none are saved) and the flag.
--   save_loyalty_settings(property, enabled, earn_per_100, point_value_minor, min_redeem)   property.configure and the flag on. Audited.
--   loyalty_booking(reservation)             reservation.view: for the booking page, the balance, what is redeemed, and whether points can be spent.
--   loyalty_redeem(reservation, points, key) discount.apply and the flag on. POLICY_VIOLATION: loyalty off | no email | points | balance | amount.
--                                            INVALID_STATE: <status> | money held | invoice | payment in progress | discount. Replay-safe.
--   loyalty_release(reservation, key)        discount.apply: removes the redemption and its discount, same guards. Replay-safe.
--   loyalty_adjust(property, email, points, reason)   property.configure and the flag on: a manual plus or minus, 1 to 100000, with a reason. Audited.
--   loyalty_ledger_list(property, email, limit)       property.configure: the group's rows, newest first, optionally for one e-mail.
--   guest_loyalty_balance(reservation)       service role only, for the booking link: { enabled, balance, point_value_minor }.
-- NOT_FOUND for no permission or another hotel, as everywhere.

-- The `loyalty` flag is enforced by plan, like the others since 112: a plan lists it in its features. Added to the pro plan, as dynamic pricing
-- and the restaurant POS were; no row for a hotel group still means on, and a group can be switched off on the platform plans page.
create or replace function plan_enforced_flags() returns text[]
language sql immutable set search_path = public as $$
  select array['reports.export', 'online_payments', 'discounts', 'online_booking', 'guest_cancel', 'guest_changes', 'early_checkin',
               'housekeeping', 'maintenance', 'audit_log', 'branding', 'dynamic_pricing', 'sms_notifications', 'restaurant_pos', 'group_bookings', 'inventory',
               'guest_services', 'api_access', 'loyalty']
$$;
revoke all on function plan_enforced_flags() from public, anon;
update plans set features = (select array_agg(distinct k order by k) from unnest(features || array['loyalty']) k) where code = 'pro';

create table loyalty_settings (
  property_id       uuid primary key,
  tenant_id         uuid not null,
  enabled           boolean not null default false,
  earn_per_100      smallint not null default 1 check (earn_per_100 between 1 and 50),
  point_value_minor integer not null default 100 check (point_value_minor between 10 and 10000),
  min_redeem        smallint not null default 100 check (min_redeem between 1 and 10000),
  updated_at        timestamptz not null default now(),
  foreign key (tenant_id, property_id) references properties (tenant_id, id)
);
alter table loyalty_settings enable row level security;
create policy loyalty_settings_select on loyalty_settings for select to authenticated
  using (has_permission(property_id, 'property.configure') or has_permission(property_id, 'discount.apply'));
revoke insert, update, delete on loyalty_settings from authenticated, anon;
create trigger loyalty_settings_updated before update on loyalty_settings for each row execute function set_updated_at();

create table loyalty_ledger (
  id             uuid primary key default gen_random_uuid(),
  seq            bigint generated always as identity,   -- strict order of events: created_at ties inside one transaction
  tenant_id      uuid not null references tenants (id),
  property_id    uuid not null,
  member_key     text not null check (member_key = lower(btrim(member_key)) and length(member_key) between 3 and 254),
  kind           text not null check (kind in ('earn', 'redeem', 'reverse', 'adjust')),
  points         integer not null check (points <> 0 and abs(points) <= 10000000),
  value_minor    bigint check (value_minor is null or value_minor > 0),
  reservation_id uuid references reservations (id),
  reverses_id    uuid references loyalty_ledger (id),
  reason         text check (reason is null or length(reason) between 1 and 200),
  actor_user_id  uuid,
  created_at     timestamptz not null default now(),
  foreign key (tenant_id, property_id) references properties (tenant_id, id),
  check (
       (kind = 'earn'    and points > 0 and reservation_id is not null and reverses_id is null and value_minor is null)
    or (kind = 'redeem'  and points < 0 and reservation_id is not null and reverses_id is null and value_minor is not null)
    or (kind = 'reverse' and points > 0 and reservation_id is not null and reverses_id is not null and value_minor is null)
    or (kind = 'adjust'  and reason is not null and reservation_id is null and reverses_id is null and value_minor is null)
  )
);
create unique index loyalty_one_earn_per_booking on loyalty_ledger (reservation_id) where kind = 'earn';
create unique index loyalty_one_reverse_per_redeem on loyalty_ledger (reverses_id) where kind = 'reverse';
create index loyalty_ledger_member_idx on loyalty_ledger (tenant_id, member_key, created_at desc);
create index loyalty_ledger_reservation_idx on loyalty_ledger (reservation_id) where reservation_id is not null;
alter table loyalty_ledger enable row level security;
create policy loyalty_ledger_select on loyalty_ledger for select to authenticated
  using (has_permission(property_id, 'property.configure'));
revoke insert, update, delete on loyalty_ledger from authenticated, anon;

create function loyalty_ledger_append_only() returns trigger language plpgsql set search_path = public as $$
begin
  raise exception 'loyalty_ledger is append-only' using errcode = '23514';
end $$;
create trigger loyalty_ledger_no_change before update or delete on loyalty_ledger
  for each row execute function loyalty_ledger_append_only();

-- The account key for an e-mail address, or null when there is no usable address.
create function loyalty_member_key(p_email text) returns text
language sql immutable set search_path = public as $$
  select case when p_email is not null and length(btrim(p_email)) between 3 and 254 and position('@' in p_email) > 1
              then lower(btrim(p_email)) end
$$;
revoke all on function loyalty_member_key(text) from public, anon, authenticated;

create function loyalty_balance_of(p_tenant uuid, p_key text) returns bigint
language sql stable security definer set search_path = public as $$
  select coalesce(sum(points), 0)::bigint from loyalty_ledger where tenant_id = p_tenant and member_key = p_key
$$;
revoke all on function loyalty_balance_of(uuid, text) from public, anon, authenticated;

-- One lock per account, held until the end of the transaction, so two spends or adjustments cannot both pass the balance check.
create function loyalty_lock_account(p_tenant uuid, p_key text) returns void
language sql security definer set search_path = public as $$
  select pg_advisory_xact_lock(hashtextextended('loyalty|' || p_tenant::text || '|' || p_key, 0))
$$;
revoke all on function loyalty_lock_account(uuid, text) from public, anon, authenticated;

-- Earn on check-out, and give points back when the discount they paid for goes away. Runs inside the statement that changes the booking,
-- so it must never raise for a reason that is not the ledger's own rules: a failed earn would otherwise fail a check-out.
create function loyalty_on_reservation_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  s loyalty_settings%rowtype; v_key text; v_base bigint; v_pts bigint;
  v_ended constant text[] := array['cancelled', 'expired', 'no_show'];
begin
  if new.reservation_status = 'checked_out' and old.reservation_status is distinct from 'checked_out' then
    select * into s from loyalty_settings where property_id = new.property_id and enabled;
    if found and tenant_feature_on(new.tenant_id, 'loyalty') then
      select loyalty_member_key(g.email) into v_key from guests g where g.tenant_id = new.tenant_id and g.id = new.primary_guest_id;
      v_base := greatest(new.subtotal_minor - new.discount_minor, 0);
      v_pts := least((v_base / 10000) * s.earn_per_100, 1000000);
      if v_key is not null and v_pts > 0 then
        insert into loyalty_ledger (tenant_id, property_id, member_key, kind, points, reservation_id, reason)
        values (new.tenant_id, new.property_id, v_key, 'earn', v_pts::integer, new.id, 'Stay ' || new.booking_reference)
        on conflict (reservation_id) where kind = 'earn' do nothing;
      end if;
    end if;
  end if;

  -- A redemption is reversed when the booking ends, or when the discount on it is no longer exactly what the points paid for.
  if (new.reservation_status = any (v_ended) and old.reservation_status <> all (v_ended))
     or new.discount_minor is distinct from old.discount_minor then
    insert into loyalty_ledger (tenant_id, property_id, member_key, kind, points, reservation_id, reverses_id, reason, actor_user_id)
    select l.tenant_id, l.property_id, l.member_key, 'reverse', -l.points, l.reservation_id, l.id,
           case when new.reservation_status = any (v_ended) then 'Booking ended' else 'Discount changed' end, auth.uid()
      from loyalty_ledger l
     where l.reservation_id = new.id and l.kind = 'redeem'
       and not exists (select 1 from loyalty_ledger x where x.reverses_id = l.id and x.kind = 'reverse')
       and (new.reservation_status = any (v_ended) or new.discount_minor is distinct from l.value_minor);
  end if;
  return null;
end $$;
create trigger loyalty_reservation_change after update of reservation_status, discount_minor on reservations
  for each row when (old.reservation_status is distinct from new.reservation_status or old.discount_minor is distinct from new.discount_minor)
  execute function loyalty_on_reservation_change();

create function loyalty_settings_get(p_property uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_prop properties%rowtype; s loyalty_settings%rowtype;
begin
  select * into v_prop from properties where id = p_property;
  if not found or not (has_permission(p_property, 'property.configure') or has_permission(p_property, 'discount.apply')) then
    raise exception 'NOT_FOUND' using errcode = 'P0001';
  end if;
  select * into s from loyalty_settings where property_id = p_property;
  return jsonb_build_object(
    'enabled', coalesce(s.enabled, false), 'earn_per_100', coalesce(s.earn_per_100, 1),
    'point_value_minor', coalesce(s.point_value_minor, 100), 'min_redeem', coalesce(s.min_redeem, 100),
    'flag_on', tenant_feature_on(v_prop.tenant_id, 'loyalty'));
end $$;
revoke all on function loyalty_settings_get(uuid) from public, anon;
grant execute on function loyalty_settings_get(uuid) to authenticated;

create function save_loyalty_settings(p_property uuid, p_enabled boolean, p_earn integer, p_value integer, p_min integer) returns void
language plpgsql security definer set search_path = public as $$
declare v_prop properties%rowtype; v_actor uuid;
begin
  select * into v_prop from properties where id = p_property;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(p_property, 'property.configure', 'NOT_FOUND');
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if not tenant_feature_on(v_prop.tenant_id, 'loyalty') then raise exception 'POLICY_VIOLATION: loyalty off' using errcode = 'P0001'; end if;
  if p_enabled is null then raise exception 'POLICY_VIOLATION: enabled' using errcode = 'P0001'; end if;
  if p_earn is null or p_earn not between 1 and 50 then raise exception 'POLICY_VIOLATION: earn' using errcode = 'P0001'; end if;
  if p_value is null or p_value not between 10 and 10000 then raise exception 'POLICY_VIOLATION: value' using errcode = 'P0001'; end if;
  if p_min is null or p_min not between 1 and 10000 then raise exception 'POLICY_VIOLATION: minimum' using errcode = 'P0001'; end if;

  insert into loyalty_settings (property_id, tenant_id, enabled, earn_per_100, point_value_minor, min_redeem)
  values (p_property, v_prop.tenant_id, p_enabled, p_earn, p_value, p_min)
  on conflict (property_id) do update
    set enabled = excluded.enabled, earn_per_100 = excluded.earn_per_100,
        point_value_minor = excluded.point_value_minor, min_redeem = excluded.min_redeem;
  perform write_audit(v_prop.tenant_id, p_property, v_actor, 'loyalty.settings_saved', 'property', p_property, null,
                      jsonb_build_object('enabled', p_enabled, 'earn_per_100', p_earn, 'point_value_minor', p_value, 'min_redeem', p_min));
end $$;
revoke all on function save_loyalty_settings(uuid, boolean, integer, integer, integer) from public, anon;
grant execute on function save_loyalty_settings(uuid, boolean, integer, integer, integer) to authenticated;

create function loyalty_booking(p_reservation uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r reservations%rowtype; s loyalty_settings%rowtype; v_key text; v_on boolean; v_redeemed integer;
begin
  select * into r from reservations where id = p_reservation;
  if not found or not has_permission(r.property_id, 'reservation.view') then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  select * into s from loyalty_settings where property_id = r.property_id;
  v_on := coalesce(s.enabled, false) and tenant_feature_on(r.tenant_id, 'loyalty');
  if not v_on then return jsonb_build_object('enabled', false); end if;
  select loyalty_member_key(g.email) into v_key from guests g where g.tenant_id = r.tenant_id and g.id = r.primary_guest_id;
  select coalesce(-sum(l.points), 0)::integer into v_redeemed
    from loyalty_ledger l
   where l.reservation_id = r.id and l.kind = 'redeem'
     and not exists (select 1 from loyalty_ledger x where x.reverses_id = l.id and x.kind = 'reverse');
  return jsonb_build_object(
    'enabled', true, 'has_email', v_key is not null,
    'balance', case when v_key is null then 0 else loyalty_balance_of(r.tenant_id, v_key) end,
    'point_value_minor', s.point_value_minor, 'min_redeem', s.min_redeem, 'redeemed_points', v_redeemed,
    'redeemed_minor', case when v_redeemed > 0 then r.discount_minor else 0 end,
    'earn_per_100', s.earn_per_100);
end $$;
revoke all on function loyalty_booking(uuid) from public, anon;
grant execute on function loyalty_booking(uuid) to authenticated;

create function loyalty_redeem(p_reservation uuid, p_points integer, p_idempotency_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r reservations%rowtype; s loyalty_settings%rowtype; v_actor uuid; v_idem record; v_hash text; v_key text;
  v_amount bigint; v_balance bigint; v_result jsonb;
begin
  select * into r from reservations where id = p_reservation;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(r.property_id, 'discount.apply', 'NOT_FOUND');
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;   -- a person, never the system

  select * into s from loyalty_settings where property_id = r.property_id and enabled;
  if not found or not tenant_feature_on(r.tenant_id, 'loyalty') then raise exception 'POLICY_VIOLATION: loyalty off' using errcode = 'P0001'; end if;
  select loyalty_member_key(g.email) into v_key from guests g where g.tenant_id = r.tenant_id and g.id = r.primary_guest_id;
  if v_key is null then raise exception 'POLICY_VIOLATION: no email' using errcode = 'P0001'; end if;
  if p_points is null or p_points < s.min_redeem or p_points > 1000000 then raise exception 'POLICY_VIOLATION: points' using errcode = 'P0001'; end if;
  v_amount := p_points::bigint * s.point_value_minor;

  v_hash := md5(concat_ws('|', p_reservation, p_points));
  select * into v_idem from idem_begin(r.tenant_id, 'loyalty_redeem', p_idempotency_key, v_hash);
  if not v_idem.out_is_new then return v_idem.out_response; end if;

  -- the booking row first: serialises with edits, cancellations, payments, invoices and other discounts on this booking
  select * into r from reservations where id = p_reservation for update;
  if r.reservation_status <> 'confirmed' then raise exception 'INVALID_STATE: %', r.reservation_status using errcode = 'P0001'; end if;
  if exists (select 1 from payments where reservation_id = r.id) then raise exception 'INVALID_STATE: money held' using errcode = 'P0001'; end if;
  if exists (select 1 from invoices where reservation_id = r.id and invoice_status <> 'void') then raise exception 'INVALID_STATE: invoice' using errcode = 'P0001'; end if;
  if exists (select 1 from payment_attempts where reservation_id = r.id and status = 'initiated') then raise exception 'INVALID_STATE: payment in progress' using errcode = 'P0001'; end if;
  if r.discount_minor > 0 then raise exception 'INVALID_STATE: discount' using errcode = 'P0001'; end if;
  if v_amount > r.subtotal_minor + r.tax_minor then raise exception 'POLICY_VIOLATION: amount' using errcode = 'P0001'; end if;

  perform loyalty_lock_account(r.tenant_id, v_key);
  v_balance := loyalty_balance_of(r.tenant_id, v_key);
  if p_points > v_balance then raise exception 'POLICY_VIOLATION: balance' using errcode = 'P0001'; end if;

  update reservations set discount_minor = v_amount, discount_percent = null, discount_amount_minor = v_amount,
         discount_reason = 'Loyalty points', total_minor = subtotal_minor + tax_minor - v_amount
   where id = r.id returning * into r;
  insert into loyalty_ledger (tenant_id, property_id, member_key, kind, points, value_minor, reservation_id, reason, actor_user_id)
  values (r.tenant_id, r.property_id, v_key, 'redeem', -p_points, v_amount, r.id, 'Booking ' || r.booking_reference, v_actor);

  v_result := jsonb_build_object('reservation_id', r.id, 'changed', true, 'points', p_points, 'discount_minor', r.discount_minor,
                                 'total_minor', r.total_minor, 'balance', v_balance - p_points);
  perform idem_finish(r.tenant_id, 'loyalty_redeem', p_idempotency_key, v_result);
  perform write_audit(r.tenant_id, r.property_id, v_actor, 'loyalty.redeemed', 'reservation', r.id, p_idempotency_key,
                      jsonb_build_object('points', p_points, 'discount_minor', v_amount, 'to_total_minor', r.total_minor));
  return v_result;
end $$;
revoke all on function loyalty_redeem(uuid, integer, text) from public, anon;
grant execute on function loyalty_redeem(uuid, integer, text) to authenticated;

create function loyalty_release(p_reservation uuid, p_idempotency_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r reservations%rowtype; v_actor uuid; v_idem record; v_hash text; l loyalty_ledger%rowtype; v_result jsonb; v_balance bigint;
begin
  select * into r from reservations where id = p_reservation;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(r.property_id, 'discount.apply', 'NOT_FOUND');
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;

  v_hash := md5(concat_ws('|', p_reservation, 'release'));
  select * into v_idem from idem_begin(r.tenant_id, 'loyalty_release', p_idempotency_key, v_hash);
  if not v_idem.out_is_new then return v_idem.out_response; end if;

  select * into r from reservations where id = p_reservation for update;
  if r.reservation_status <> 'confirmed' then raise exception 'INVALID_STATE: %', r.reservation_status using errcode = 'P0001'; end if;
  if exists (select 1 from payments where reservation_id = r.id) then raise exception 'INVALID_STATE: money held' using errcode = 'P0001'; end if;
  if exists (select 1 from invoices where reservation_id = r.id and invoice_status <> 'void') then raise exception 'INVALID_STATE: invoice' using errcode = 'P0001'; end if;
  if exists (select 1 from payment_attempts where reservation_id = r.id and status = 'initiated') then raise exception 'INVALID_STATE: payment in progress' using errcode = 'P0001'; end if;

  select * into l from loyalty_ledger x
   where x.reservation_id = r.id and x.kind = 'redeem'
     and not exists (select 1 from loyalty_ledger y where y.reverses_id = x.id and y.kind = 'reverse');
  if not found then
    v_result := jsonb_build_object('reservation_id', r.id, 'changed', false);
    perform idem_finish(r.tenant_id, 'loyalty_release', p_idempotency_key, v_result);
    return v_result;
  end if;

  -- removing the discount makes the trigger above write the reversal, so there is one path for giving points back
  update reservations set discount_minor = 0, discount_percent = null, discount_amount_minor = null, discount_reason = null,
         total_minor = subtotal_minor + tax_minor
   where id = r.id returning * into r;

  v_balance := loyalty_balance_of(r.tenant_id, l.member_key);
  v_result := jsonb_build_object('reservation_id', r.id, 'changed', true, 'points', -l.points, 'total_minor', r.total_minor, 'balance', v_balance);
  perform idem_finish(r.tenant_id, 'loyalty_release', p_idempotency_key, v_result);
  perform write_audit(r.tenant_id, r.property_id, v_actor, 'loyalty.released', 'reservation', r.id, p_idempotency_key,
                      jsonb_build_object('points', -l.points, 'to_total_minor', r.total_minor));
  return v_result;
end $$;
revoke all on function loyalty_release(uuid, text) from public, anon;
grant execute on function loyalty_release(uuid, text) to authenticated;

create function loyalty_adjust(p_property uuid, p_email text, p_points integer, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_prop properties%rowtype; v_actor uuid; v_key text := loyalty_member_key(p_email); v_reason text := nullif(btrim(p_reason), ''); v_balance bigint;
begin
  select * into v_prop from properties where id = p_property;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(p_property, 'property.configure', 'NOT_FOUND');
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if not tenant_feature_on(v_prop.tenant_id, 'loyalty') then raise exception 'POLICY_VIOLATION: loyalty off' using errcode = 'P0001'; end if;
  if v_key is null then raise exception 'POLICY_VIOLATION: email' using errcode = 'P0001'; end if;
  if p_points is null or p_points = 0 or abs(p_points) > 100000 then raise exception 'POLICY_VIOLATION: points' using errcode = 'P0001'; end if;
  if v_reason is null or length(v_reason) > 200 then raise exception 'POLICY_VIOLATION: reason' using errcode = 'P0001'; end if;

  perform loyalty_lock_account(v_prop.tenant_id, v_key);
  v_balance := loyalty_balance_of(v_prop.tenant_id, v_key);
  if v_balance + p_points < 0 then raise exception 'POLICY_VIOLATION: balance' using errcode = 'P0001'; end if;
  insert into loyalty_ledger (tenant_id, property_id, member_key, kind, points, reason, actor_user_id)
  values (v_prop.tenant_id, p_property, v_key, 'adjust', p_points, v_reason, v_actor);
  perform write_audit(v_prop.tenant_id, p_property, v_actor, 'loyalty.adjusted', 'property', p_property, null,
                      jsonb_build_object('email', v_key, 'points', p_points, 'reason', v_reason));
  return jsonb_build_object('balance', v_balance + p_points);
end $$;
revoke all on function loyalty_adjust(uuid, text, integer, text) from public, anon;
grant execute on function loyalty_adjust(uuid, text, integer, text) to authenticated;

create function loyalty_ledger_list(p_property uuid, p_email text default null, p_limit integer default 100) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_prop properties%rowtype; v_key text := loyalty_member_key(p_email);
begin
  select * into v_prop from properties where id = p_property;
  if not found or not has_permission(p_property, 'property.configure') then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if p_email is not null and btrim(p_email) <> '' and v_key is null then raise exception 'POLICY_VIOLATION: email' using errcode = 'P0001'; end if;
  return coalesce((
    select jsonb_agg(to_jsonb(x) - 'seq' order by x.seq desc)
      from (
        select l.seq, l.id, l.member_key as email, l.kind, l.points, l.reason, l.created_at, res.booking_reference,
               (select coalesce(sum(points), 0) from loyalty_ledger b where b.tenant_id = l.tenant_id and b.member_key = l.member_key) as balance
          from loyalty_ledger l left join reservations res on res.id = l.reservation_id
         where l.tenant_id = v_prop.tenant_id and (v_key is null or l.member_key = v_key)
         order by l.seq desc
         limit least(greatest(coalesce(p_limit, 100), 1), 200)) x), '[]'::jsonb);
end $$;
revoke all on function loyalty_ledger_list(uuid, text, integer) from public, anon;
grant execute on function loyalty_ledger_list(uuid, text, integer) to authenticated;

create function guest_loyalty_balance(p_reservation uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r reservations%rowtype; s loyalty_settings%rowtype; v_key text;
begin
  select * into r from reservations where id = p_reservation;
  if not found then return jsonb_build_object('enabled', false); end if;
  select * into s from loyalty_settings where property_id = r.property_id and enabled;
  if not found or not tenant_feature_on(r.tenant_id, 'loyalty') then return jsonb_build_object('enabled', false); end if;
  select loyalty_member_key(g.email) into v_key from guests g where g.tenant_id = r.tenant_id and g.id = r.primary_guest_id;
  if v_key is null then return jsonb_build_object('enabled', false); end if;
  return jsonb_build_object('enabled', true, 'balance', loyalty_balance_of(r.tenant_id, v_key), 'point_value_minor', s.point_value_minor);
end $$;
revoke all on function guest_loyalty_balance(uuid) from public, anon, authenticated;
grant execute on function guest_loyalty_balance(uuid) to service_role;
