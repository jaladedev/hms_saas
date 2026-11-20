-- 156 Group bookings, step six (TODO 8.7): one company payment settling the group's bookings (the master folio).
--
-- A company usually pays once for many guests. record_group_payment takes ONE payment from the company and splits it into ordinary payments
-- on the group's linked bookings by calling record_manual_payment (034) for each, so every money rule stays where it already lives: a booking
-- can never be paid above its total (OVERPAYMENT), a pending booking that gets enough money is confirmed, the payment is allocated to the
-- booking's live invoice, the booking's payment status is refreshed, and the daily report, settlement and refunds see normal payments.
-- Nothing is counted twice and no money function was changed. The group tables only remember which payments belong to one company payment.
--   * Split: either you give each booking's share, or (no shares given) the money fills the bookings' outstanding amounts in arrival order.
--     The whole amount must be placed: more than the group owes is refused (POLICY_VIOLATION: exceeds outstanding), there is no credit balance.
--     Only pending, confirmed, checked-in and checked-out bookings linked to the group can receive a share.
--   * All or nothing, and idempotent per key. Needs group.manage and payment.record. NOT_FOUND for no permission or another hotel.
--   * reverse_group_payment reverses every still-succeeded line through reverse_payment (012), so it needs refund.approve as well and is refused
--     where a line has a refund. A group payment is never edited or deleted; its state is read from its payments.
--   * It does not mark the company invoice (154) paid. That stays a separate click, so the invoice and the money are recorded deliberately.
--   * group_statement now also shows each booking's money held (payments less refunds) and what is still outstanding, with totals.

create table group_payments (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  property_id  uuid not null,
  group_id     uuid not null references group_bookings (id),
  amount_minor bigint not null check (amount_minor > 0),
  method       text not null check (method in ('cash', 'bank_transfer', 'pos', 'other')),
  reference    text check (reference is null or char_length(reference) <= 60),
  note         text check (note is null or char_length(note) <= 200),
  received_at  timestamptz not null default now(),
  recorded_by  uuid references auth.users (id) on delete set null,
  foreign key (tenant_id, property_id) references properties (tenant_id, id)
);
create index group_payments_group_idx on group_payments (group_id, received_at desc);

create table group_payment_lines (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null,
  property_id      uuid not null,
  group_payment_id uuid not null references group_payments (id),
  reservation_id   uuid not null references reservations (id),
  payment_id       uuid not null unique references payments (id),
  amount_minor     bigint not null check (amount_minor > 0)
);
create index group_payment_lines_gp_idx on group_payment_lines (group_payment_id);

create function group_payments_history() returns trigger language plpgsql as $$
begin raise exception '% rows are kept as history', tg_table_name using errcode = '23514'; end $$;
create trigger group_payments_history_trg before update or delete on group_payments for each row execute function group_payments_history();
create trigger group_payment_lines_history_trg before update or delete on group_payment_lines for each row execute function group_payments_history();
revoke all on function group_payments_history() from public, anon, authenticated;

alter table group_payments enable row level security;
alter table group_payment_lines enable row level security;
create policy group_payments_select on group_payments for select to authenticated using (has_permission(property_id, 'group.manage') and can_view_money(property_id));
create policy group_payment_lines_select on group_payment_lines for select to authenticated using (has_permission(property_id, 'group.manage') and can_view_money(property_id));
revoke insert, update, delete on group_payments, group_payment_lines from authenticated, anon;

create function record_group_payment(p_group uuid, p_amount_minor bigint, p_method text, p_reference text, p_note text, p_allocations jsonb, p_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  b group_bookings%rowtype; g record; v_idem record; v_ref text := nullif(btrim(coalesce(p_reference, '')), ''); v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_gp uuid := gen_random_uuid(); v_left bigint; v_share bigint; v_out bigint; v_pay jsonb; v_lines integer := 0; v_sum bigint := 0; e jsonb; v_res uuid; v_seen uuid[] := '{}';
  r record; v_result jsonb; v_explicit boolean := p_allocations is not null and jsonb_typeof(p_allocations) = 'array' and jsonb_array_length(p_allocations) > 0;
begin
  select * into b from group_bookings where id = p_group;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  select * into g from group_guard(b.property_id);
  perform require_permission(b.property_id, 'payment.record', 'NOT_FOUND');
  if p_amount_minor is null or p_amount_minor <= 0 or p_amount_minor > 1000000000000 then raise exception 'POLICY_VIOLATION: amount' using errcode = 'P0001'; end if;
  if p_method is null or p_method not in ('cash', 'bank_transfer', 'pos', 'other') then raise exception 'POLICY_VIOLATION: method' using errcode = 'P0001'; end if;
  if (v_ref is not null and char_length(v_ref) > 60) or (v_note is not null and char_length(v_note) > 200) then raise exception 'POLICY_VIOLATION: details' using errcode = 'P0001'; end if;
  if p_allocations is not null and jsonb_typeof(p_allocations) not in ('array', 'null') then raise exception 'POLICY_VIOLATION: allocation' using errcode = 'P0001'; end if;
  if v_explicit and jsonb_array_length(p_allocations) > 50 then raise exception 'POLICY_VIOLATION: allocation' using errcode = 'P0001'; end if;

  select * into v_idem from idem_begin(g.o_tenant, 'record_group_payment', p_key, md5(concat_ws('|', p_group, p_amount_minor, p_method, coalesce(v_ref, ''), coalesce(p_allocations::text, ''))));
  if not v_idem.out_is_new then return v_idem.out_response; end if;

  perform 1 from group_bookings where id = b.id for update;
  insert into group_payments (id, tenant_id, property_id, group_id, amount_minor, method, reference, note, recorded_by)
  values (v_gp, b.tenant_id, b.property_id, b.id, p_amount_minor, p_method, v_ref, v_note, g.o_actor);

  if v_explicit then
    for e in select * from jsonb_array_elements(p_allocations) loop
      begin
        v_res := (e ->> 'reservation_id')::uuid; v_share := (e ->> 'amount_minor')::bigint;
      exception when others then raise exception 'POLICY_VIOLATION: allocation' using errcode = 'P0001';
      end;
      if v_share is null or v_share <= 0 or v_res = any (v_seen)
         or not exists (select 1 from group_rooming gr join reservations v on v.id = gr.reservation_id
                         where gr.group_id = b.id and v.id = v_res and v.reservation_status in ('pending', 'confirmed', 'checked_in', 'checked_out')) then
        raise exception 'POLICY_VIOLATION: allocation' using errcode = 'P0001';
      end if;
      v_seen := v_seen || v_res; v_sum := v_sum + v_share;
    end loop;
    if v_sum <> p_amount_minor then raise exception 'POLICY_VIOLATION: allocation total' using errcode = 'P0001'; end if;
    for e in select * from jsonb_array_elements(p_allocations) loop
      v_res := (e ->> 'reservation_id')::uuid; v_share := (e ->> 'amount_minor')::bigint;
      v_pay := record_manual_payment(v_res, v_share, p_method, v_ref, left(concat_ws(' | ', 'Group payment: ' || b.name, v_note), 500), md5(p_key || ':' || v_res::text));
      insert into group_payment_lines (tenant_id, property_id, group_payment_id, reservation_id, payment_id, amount_minor)
      values (b.tenant_id, b.property_id, v_gp, v_res, (v_pay ->> 'payment_id')::uuid, v_share);
      v_lines := v_lines + 1;
    end loop;
  else
    v_left := p_amount_minor;
    for r in select v.id, v.total_minor - reservation_money_held(v.id) as outstanding
               from group_rooming gr join reservations v on v.id = gr.reservation_id
              where gr.group_id = b.id and v.reservation_status in ('pending', 'confirmed', 'checked_in', 'checked_out')
              order by v.arrival_date, v.booking_reference loop
      exit when v_left <= 0;
      continue when r.outstanding <= 0;
      v_share := least(v_left, r.outstanding);
      v_pay := record_manual_payment(r.id, v_share, p_method, v_ref, left(concat_ws(' | ', 'Group payment: ' || b.name, v_note), 500), md5(p_key || ':' || r.id::text));
      insert into group_payment_lines (tenant_id, property_id, group_payment_id, reservation_id, payment_id, amount_minor)
      values (b.tenant_id, b.property_id, v_gp, r.id, (v_pay ->> 'payment_id')::uuid, v_share);
      v_left := v_left - v_share; v_lines := v_lines + 1;
    end loop;
    if v_left > 0 then raise exception 'POLICY_VIOLATION: exceeds outstanding' using errcode = 'P0001'; end if;
  end if;

  v_result := jsonb_build_object('group_payment_id', v_gp, 'amount_minor', p_amount_minor, 'line_count', v_lines);
  perform idem_finish(g.o_tenant, 'record_group_payment', p_key, v_result);
  perform write_audit(g.o_tenant, b.property_id, g.o_actor, 'group_payment.recorded', 'group_payment', v_gp, p_key,
                      jsonb_build_object('group_id', b.id, 'amount_minor', p_amount_minor, 'method', p_method, 'line_count', v_lines));
  return v_result;
end $$;

create function reverse_group_payment(p_group_payment uuid, p_reason text, p_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare gp group_payments%rowtype; g record; v_idem record; v_reason text := nullif(btrim(coalesce(p_reason, '')), ''); l record; v_n integer := 0; v_result jsonb;
begin
  select * into gp from group_payments where id = p_group_payment;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  select * into g from group_guard(gp.property_id);
  perform require_permission(gp.property_id, 'refund.approve', 'NOT_FOUND');
  if v_reason is null or char_length(v_reason) > 200 then raise exception 'POLICY_VIOLATION: reason' using errcode = 'P0001'; end if;
  select * into v_idem from idem_begin(g.o_tenant, 'reverse_group_payment', p_key, md5(p_group_payment::text || '|' || v_reason));
  if not v_idem.out_is_new then return v_idem.out_response; end if;

  for l in select pl.payment_id from group_payment_lines pl join payments p on p.id = pl.payment_id
            where pl.group_payment_id = gp.id and p.payment_status = 'succeeded' order by pl.id loop
    perform reverse_payment(l.payment_id, left('Group payment reversed: ' || v_reason, 250), md5(p_key || ':' || l.payment_id::text));
    v_n := v_n + 1;
  end loop;
  if v_n = 0 then raise exception 'INVALID_STATE: reversed' using errcode = 'P0001'; end if;
  v_result := jsonb_build_object('group_payment_id', gp.id, 'reversed', v_n);
  perform idem_finish(g.o_tenant, 'reverse_group_payment', p_key, v_result);
  perform write_audit(g.o_tenant, gp.property_id, g.o_actor, 'group_payment.reversed', 'group_payment', gp.id, p_key, jsonb_build_object('reason', v_reason, 'lines', v_n));
  return v_result;
end $$;

create function group_payment_list(p_group uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare b group_bookings%rowtype;
begin
  select * into b from group_bookings where id = p_group;
  if not found or not has_permission(b.property_id, 'group.manage') or not can_view_money(b.property_id) then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', gp.id, 'amount_minor', gp.amount_minor, 'method', gp.method, 'reference', gp.reference, 'note', gp.note, 'received_at', gp.received_at,
      'state', case when not exists (select 1 from group_payment_lines l join payments p on p.id = l.payment_id where l.group_payment_id = gp.id and p.payment_status = 'succeeded') then 'reversed'
                    when exists (select 1 from group_payment_lines l join payments p on p.id = l.payment_id where l.group_payment_id = gp.id and p.payment_status <> 'succeeded') then 'partly_reversed'
                    else 'recorded' end,
      'lines', (select coalesce(jsonb_agg(jsonb_build_object('reservation_id', l.reservation_id, 'booking_reference', v.booking_reference, 'guest_name', gu.full_name,
                  'amount_minor', l.amount_minor, 'payment_status', p.payment_status) order by v.arrival_date, v.booking_reference), '[]'::jsonb)
                  from group_payment_lines l join payments p on p.id = l.payment_id join reservations v on v.id = l.reservation_id join guests gu on gu.id = v.primary_guest_id
                 where l.group_payment_id = gp.id)) order by gp.received_at desc, gp.id)
    from group_payments gp where gp.group_id = b.id), '[]'::jsonb);
end $$;

-- group_statement again, with what each booking holds and still owes.
create or replace function group_statement(p_group uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare b group_bookings%rowtype; v_money boolean; v_rows jsonb; v_cur text;
begin
  select * into b from group_bookings where id = p_group;
  if not found or not has_permission(b.property_id, 'group.manage') then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_money := can_view_money(b.property_id);
  select coalesce(jsonb_agg(jsonb_build_object(
           'entry_id', r.id, 'guest_name', r.guest_name, 'reservation_id', v.id, 'booking_reference', v.booking_reference,
           'reservation_status', v.reservation_status, 'payment_status', v.payment_status, 'arrival_date', v.arrival_date, 'departure_date', v.departure_date,
           'held_minor', case when v_money then (select coalesce(sum(reservation_money_held(v.id)), 0) from group_rooming r join reservations v on v.id = r.reservation_id
                                           where r.group_id = b.id and v.reservation_status in ('pending', 'confirmed', 'checked_in', 'checked_out')) end,
    'outstanding_minor', case when v_money then (select coalesce(sum(greatest(v.total_minor - reservation_money_held(v.id), 0)), 0) from group_rooming r join reservations v on v.id = r.reservation_id
                                                  where r.group_id = b.id and v.reservation_status in ('pending', 'confirmed', 'checked_in', 'checked_out')) end,
    'total_minor', case when v_money then v.total_minor end,
           'extras_minor', case when v_money then f.charges_minor end,
           'extras_paid_minor', case when v_money then f.paid_minor end,
           'held_minor', case when v_money then reservation_money_held(v.id) end,
           'outstanding_minor', case when v_money and v.reservation_status in ('pending', 'confirmed', 'checked_in', 'checked_out')
                                     then greatest(v.total_minor - reservation_money_held(v.id), 0) end) order by r.created_at, r.id), '[]'::jsonb),
         max(v.currency)
    into v_rows, v_cur
    from group_rooming r join reservations v on v.id = r.reservation_id left join lateral folio_totals(v.id) f on true
   where r.group_id = b.id;
  return jsonb_build_object(
    'money_visible', v_money, 'currency', coalesce(v_cur, 'NGN'), 'bookings', v_rows,
    'linked_count', jsonb_array_length(v_rows),
    'names_without_booking', (select count(*) from group_rooming where group_id = b.id and reservation_id is null),
    'total_minor', case when v_money then (select coalesce(sum(v.total_minor), 0) from group_rooming r join reservations v on v.id = r.reservation_id
                                            where r.group_id = b.id and v.reservation_status not in ('cancelled', 'expired', 'no_show')) end,
    'extras_minor', case when v_money then (select coalesce(sum(f.charges_minor), 0) from group_rooming r join reservations v on v.id = r.reservation_id,
                                                  lateral folio_totals(v.id) f where r.group_id = b.id and v.reservation_status not in ('cancelled', 'expired', 'no_show')) end);
end $$;


do $$ declare f text; begin
  foreach f in array array['record_group_payment(uuid, bigint, text, text, text, jsonb, text)', 'reverse_group_payment(uuid, text, text)', 'group_payment_list(uuid)', 'group_statement(uuid)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
