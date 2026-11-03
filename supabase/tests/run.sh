#!/usr/bin/env bash
# Runs migrations and tests against a throwaway local PostgreSQL 16 cluster.
# Usage: supabase/tests/run.sh   (needs PostgreSQL server binaries; run as root or a normal user)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
PORT="${PGPORT:-54329}"
DATA="${PGDATA_DIR:-$(mktemp -d)}"
RUNAS=""
if [ "$(id -u)" = "0" ]; then RUNAS="su postgres -s /bin/bash -c"; chown postgres "$DATA"; fi
run() { if [ -n "$RUNAS" ]; then $RUNAS "$*"; else bash -c "$*"; fi; }
cleanup() { run "$PGBIN/pg_ctl -D $DATA -m immediate stop" >/dev/null 2>&1 || true; rm -rf "$DATA"; }
[ -n "${KEEP_DB:-}" ] || trap cleanup EXIT

run "$PGBIN/initdb -D $DATA --auth=trust -U postgres" >/dev/null
run "$PGBIN/pg_ctl -D $DATA -o '-p $PORT -k /tmp -c max_connections=200 -c fsync=off' -l $DATA/log -w start" >/dev/null
export PGHOST=/tmp PGPORT=$PORT PGUSER=postgres
"$PGBIN/createdb" hms_test
export PGDATABASE=hms_test
psql() { "$PGBIN/psql" -q -v ON_ERROR_STOP=1 "$@"; }
# Run pgbench and fail if any client hit an unhandled error (for example an unretried deadlock).
bench() {
  local out; out="$("$PGBIN/pgbench" -n --verbose-errors "$@" 2>&1)" || true
  # A client that hits an unhandled error is aborted, which pgbench does not count as a failed transaction.
  if echo "$out" | grep -qE 'failed transactions: [1-9]|aborted in command|Run was aborted'; then echo "$out" | grep -E 'ERROR|failed|aborted' | sort | uniq -c | head; echo "BENCH FAILED"; exit 1; fi
}

psql -f "$HERE/00_stub_auth.sql"
for f in "$ROOT"/supabase/migrations/*.sql; do echo "migrate $(basename "$f")"; psql -f "$f"; done
psql -f "$HERE/01_seed.sql"
OUT="$(psql -f "$HERE/02_claims.sql" 2>&1)" || { echo "$OUT"; echo "CLAIM TESTS FAILED"; exit 1; }
echo "$OUT" | grep -E 'PASS' || true
if echo "$OUT" | grep -qE 'FAIL|ERROR'; then echo "$OUT"; echo "CLAIM TESTS FAILED"; exit 1; fi

SEC="$(psql -f "$HERE/03_security.sql" 2>&1)" || { echo "$SEC"; echo "SECURITY TESTS FAILED"; exit 1; }
echo "$SEC" | grep -E 'PASS' || true
if echo "$SEC" | grep -qE 'FAIL|ERROR'; then echo "$SEC"; echo "SECURITY TESTS FAILED"; exit 1; fi

RES="$(psql -f "$HERE/04_reservations.sql" 2>&1)" || { echo "$RES"; echo "RESERVATION TESTS FAILED"; exit 1; }
echo "$RES" | grep -E 'PASS' || true
if echo "$RES" | grep -qE 'FAIL|ERROR'; then echo "$RES"; echo "RESERVATION TESTS FAILED"; exit 1; fi

OPS="$(psql -f "$HERE/05_operations.sql" 2>&1)" || { echo "$OPS"; echo "OPERATION TESTS FAILED"; exit 1; }
echo "$OPS" | grep -E 'PASS' || true
if echo "$OPS" | grep -qE 'FAIL|ERROR'; then echo "$OPS"; echo "OPERATION TESTS FAILED"; exit 1; fi

HOLDS="$(psql -f "$HERE/06_holds.sql" 2>&1)" || { echo "$HOLDS"; echo "HOLD TESTS FAILED"; exit 1; }
echo "$HOLDS" | grep -E 'PASS' || true
if echo "$HOLDS" | grep -qE 'FAIL|ERROR'; then echo "$HOLDS"; echo "HOLD TESTS FAILED"; exit 1; fi

MONEY="$(psql -f "$HERE/07_money.sql" 2>&1)" || { echo "$MONEY"; echo "MONEY TESTS FAILED"; exit 1; }
echo "$MONEY" | grep -E 'PASS' || true
if echo "$MONEY" | grep -qE 'FAIL|ERROR'; then echo "$MONEY"; echo "MONEY TESTS FAILED"; exit 1; fi

PROV="$(psql -f "$HERE/08_provider_payments.sql" 2>&1)" || { echo "$PROV"; echo "PROVIDER PAYMENT TESTS FAILED"; exit 1; }
echo "$PROV" | grep -E 'PASS' || true
if echo "$PROV" | grep -qE 'FAIL|ERROR'; then echo "$PROV"; echo "PROVIDER PAYMENT TESTS FAILED"; exit 1; fi

REF="$(psql -f "$HERE/09_refunds.sql" 2>&1)" || { echo "$REF"; echo "REFUND TESTS FAILED"; exit 1; }
echo "$REF" | grep -E 'PASS' || true
if echo "$REF" | grep -qE 'FAIL|ERROR'; then echo "$REF"; echo "REFUND TESTS FAILED"; exit 1; fi

WH="$(psql -f "$HERE/10_webhook_support.sql" 2>&1)" || { echo "$WH"; echo "WEBHOOK SUPPORT TESTS FAILED"; exit 1; }
echo "$WH" | grep -E 'PASS' || true
if echo "$WH" | grep -qE 'FAIL|ERROR'; then echo "$WH"; echo "WEBHOOK SUPPORT TESTS FAILED"; exit 1; fi

GB="$(psql -f "$HERE/11_guest_booking.sql" 2>&1)" || { echo "$GB"; echo "GUEST BOOKING TESTS FAILED"; exit 1; }
echo "$GB" | grep -E 'PASS' || true
if echo "$GB" | grep -qE 'FAIL|ERROR'; then echo "$GB"; echo "GUEST BOOKING TESTS FAILED"; exit 1; fi

EM="$(psql -f "$HERE/12_email_rate_limits.sql" 2>&1)" || { echo "$EM"; echo "EMAIL TESTS FAILED"; exit 1; }
echo "$EM" | grep -E 'PASS' || true
if echo "$EM" | grep -qE 'FAIL|ERROR'; then echo "$EM"; echo "EMAIL TESTS FAILED"; exit 1; fi

ST="$(psql -f "$HERE/13_settlement.sql" 2>&1)" || { echo "$ST"; echo "SETTLEMENT TESTS FAILED"; exit 1; }
echo "$ST" | grep -E 'PASS' || true
if echo "$ST" | grep -qE 'FAIL|ERROR'; then echo "$ST"; echo "SETTLEMENT TESTS FAILED"; exit 1; fi

SE="$(psql -f "$HERE/14_staff_email.sql" 2>&1)" || { echo "$SE"; echo "STAFF EMAIL TESTS FAILED"; exit 1; }
echo "$SE" | grep -E 'PASS' || true
if echo "$SE" | grep -qE 'FAIL|ERROR'; then echo "$SE"; echo "STAFF EMAIL TESTS FAILED"; exit 1; fi

HK="$(psql -f "$HERE/15_housekeeping.sql" 2>&1)" || { echo "$HK"; echo "HOUSEKEEPING TESTS FAILED"; exit 1; }
echo "$HK" | grep -E 'PASS' || true
if echo "$HK" | grep -qE 'FAIL|ERROR'; then echo "$HK"; echo "HOUSEKEEPING TESTS FAILED"; exit 1; fi

SM="$(psql -f "$HERE/16_staff_management.sql" 2>&1)" || { echo "$SM"; echo "STAFF MANAGEMENT TESTS FAILED"; exit 1; }
echo "$SM" | grep -E 'PASS' || true
if echo "$SM" | grep -qE 'FAIL|ERROR'; then echo "$SM"; echo "STAFF MANAGEMENT TESTS FAILED"; exit 1; fi

GU="$(psql -f "$HERE/17_guest_update.sql" 2>&1)" || { echo "$GU"; echo "GUEST UPDATE TESTS FAILED"; exit 1; }
echo "$GU" | grep -E 'PASS' || true
if echo "$GU" | grep -qE 'FAIL|ERROR'; then echo "$GU"; echo "GUEST UPDATE TESTS FAILED"; exit 1; fi

LR="$(psql -f "$HERE/18_lost_room_email.sql" 2>&1)" || { echo "$LR"; echo "LOST ROOM EMAIL TESTS FAILED"; exit 1; }
echo "$LR" | grep -E 'PASS' || true
if echo "$LR" | grep -qE 'FAIL|ERROR'; then echo "$LR"; echo "LOST ROOM EMAIL TESTS FAILED"; exit 1; fi

RB="$(psql -f "$HERE/20_refund_bank_details.sql" 2>&1)" || { echo "$RB"; echo "REFUND BANK DETAILS TESTS FAILED"; exit 1; }
echo "$RB" | grep -E 'PASS' || true
if echo "$RB" | grep -qE 'FAIL|ERROR'; then echo "$RB"; echo "REFUND BANK DETAILS TESTS FAILED"; exit 1; fi

HT="$(psql -f "$HERE/21_housekeeping_tasks.sql" 2>&1)" || { echo "$HT"; echo "HOUSEKEEPING TASK TESTS FAILED"; exit 1; }
echo "$HT" | grep -E 'PASS' || true
if echo "$HT" | grep -qE 'FAIL|ERROR'; then echo "$HT"; echo "HOUSEKEEPING TASK TESTS FAILED"; exit 1; fi

RT="$(psql -f "$HERE/22_room_type_status.sql" 2>&1)" || { echo "$RT"; echo "ROOM TYPE STATUS TESTS FAILED"; exit 1; }
echo "$RT" | grep -E 'PASS' || true
if echo "$RT" | grep -qE 'FAIL|ERROR'; then echo "$RT"; echo "ROOM TYPE STATUS TESTS FAILED"; exit 1; fi

SA="$(psql -f "$HERE/23_setup_audit.sql" 2>&1)" || { echo "$SA"; echo "SETUP AUDIT TESTS FAILED"; exit 1; }
echo "$SA" | grep -E 'PASS' || true
if echo "$SA" | grep -qE 'FAIL|ERROR'; then echo "$SA"; echo "SETUP AUDIT TESTS FAILED"; exit 1; fi

MT="$(psql -f "$HERE/24_maintenance_requests.sql" 2>&1)" || { echo "$MT"; echo "MAINTENANCE REQUEST TESTS FAILED"; exit 1; }
echo "$MT" | grep -E 'PASS' || true
if echo "$MT" | grep -qE 'FAIL|ERROR'; then echo "$MT"; echo "MAINTENANCE REQUEST TESTS FAILED"; exit 1; fi

FT="$(psql -f "$HERE/25_folio_charges.sql" 2>&1)" || { echo "$FT"; echo "FOLIO TESTS FAILED"; exit 1; }
echo "$FT" | grep -E 'PASS' || true
if echo "$FT" | grep -qE 'FAIL|ERROR'; then echo "$FT"; echo "FOLIO TESTS FAILED"; exit 1; fi

TX="$(psql -f "$HERE/26_tax_rule_audit.sql" 2>&1)" || { echo "$TX"; echo "TAX RULE AUDIT TESTS FAILED"; exit 1; }
echo "$TX" | grep -E 'PASS' || true
if echo "$TX" | grep -qE 'FAIL|ERROR'; then echo "$TX"; echo "TAX RULE AUDIT TESTS FAILED"; exit 1; fi

PA="$(psql -f "$HERE/29_policy_audit.sql" 2>&1)" || { echo "$PA"; echo "POLICY AUDIT TESTS FAILED"; exit 1; }
echo "$PA" | grep -E 'PASS' || true
if echo "$PA" | grep -qE 'FAIL|ERROR'; then echo "$PA"; echo "POLICY AUDIT TESTS FAILED"; exit 1; fi

AN="$(psql -f "$HERE/27_audit_actor_names.sql" 2>&1)" || { echo "$AN"; echo "AUDIT ACTOR NAME TESTS FAILED"; exit 1; }
echo "$AN" | grep -E 'PASS' || true
if echo "$AN" | grep -qE 'FAIL|ERROR'; then echo "$AN"; echo "AUDIT ACTOR NAME TESTS FAILED"; exit 1; fi

MV="$(psql -f "$HERE/28_audit_membership_visibility.sql" 2>&1)" || { echo "$MV"; echo "AUDIT MEMBERSHIP VISIBILITY TESTS FAILED"; exit 1; }
echo "$MV" | grep -E 'PASS' || true
if echo "$MV" | grep -qE 'FAIL|ERROR'; then echo "$MV"; echo "AUDIT MEMBERSHIP VISIBILITY TESTS FAILED"; exit 1; fi

GP="$(psql -f "$HERE/30_guest_policy.sql" 2>&1)" || { echo "$GP"; echo "GUEST POLICY TESTS FAILED"; exit 1; }
echo "$GP" | grep -E 'PASS' || true
if echo "$GP" | grep -qE 'FAIL|ERROR'; then echo "$GP"; echo "GUEST POLICY TESTS FAILED"; exit 1; fi
SGE="$(psql -f "$HERE/31_stay_edit.sql" 2>&1)" || { echo "$SGE"; echo "STAY EDIT TESTS FAILED"; exit 1; }
echo "$SGE" | grep -E 'PASS' || true
if echo "$SGE" | grep -qE 'FAIL|ERROR'; then echo "$SGE"; echo "STAY EDIT TESTS FAILED"; exit 1; fi
SH="$(psql -f "$HERE/33_staff_hold.sql" 2>&1)" || { echo "$SH"; echo "STAFF HOLD TESTS FAILED"; exit 1; }
echo "$SH" | grep -E 'PASS' || true
if echo "$SH" | grep -qE 'FAIL|ERROR'; then echo "$SH"; echo "STAFF HOLD TESTS FAILED"; exit 1; fi
GC="$(psql -f "$HERE/34_guest_cancel.sql" 2>&1)" || { echo "$GC"; echo "GUEST CANCEL TESTS FAILED"; exit 1; }
echo "$GC" | grep -E 'PASS' || true
if echo "$GC" | grep -qE 'FAIL|ERROR'; then echo "$GC"; echo "GUEST CANCEL TESTS FAILED"; exit 1; fi

echo "--- concurrency: last room race (1 room, 50 clients)"
cat > "$DATA/race_one.sql" <<'SQL'
select test_try_claim('last_room', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a4', '2027-10-01', '2027-10-03');
SQL
bench -c 50 -j 10 -t 1 -f "$DATA/race_one.sql"
psql -At -c "select 'successes=' || count(*) filter (where ok) || ' failures=' || count(*) filter (where not ok) from test_results where label='last_room'"
psql -At -c "do \$\$ begin if (select count(*) from test_results where label='last_room' and ok) <> 1 then raise exception 'FAIL last room race'; end if; end \$\$"

echo "--- concurrency: type-level race (5 rooms, 100 clients)"
cat > "$DATA/race_type.sql" <<'SQL'
select test_try_claim('type_race', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a3', '2027-11-01', '2027-11-04');
SQL
bench -c 100 -j 10 -t 1 -f "$DATA/race_type.sql"
psql -At -c "select 'successes=' || count(*) filter (where ok) || ' failures=' || count(*) filter (where not ok) from test_results where label='type_race'"
psql -At -c "do \$\$ begin
  if (select count(*) from test_results where label='type_race' and ok) <> 5 then raise exception 'FAIL type race count'; end if;
  if exists (select 1 from room_inventory_claims a join room_inventory_claims b
              on a.room_id = b.room_id and a.id < b.id and a.status='active' and b.status='active'
             and daterange(a.start_date,a.end_date,'[)') && daterange(b.start_date,b.end_date,'[)'))
  then raise exception 'FAIL overlapping claims exist'; end if; end \$\$"
echo "--- concurrency: create_reservation, last room (1 room, 50 clients)"
cat > "$DATA/res_one.sql" <<'SQL'
select test_try_reserve('res_one', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a5', '2028-01-10', '2028-01-12', '[{"room_type_id":"00000000-0000-0000-0000-0000000000a4","adults":2}]'::jsonb);
SQL
bench -c 50 -j 10 -t 1 -f "$DATA/res_one.sql"
psql -At -c "select 'successes=' || count(*) filter (where ok) || ' failures=' || count(*) filter (where not ok) from test_results where label like 'res_one%'"
psql -At -c "do \$\$ begin
  if (select count(*) from test_results where label = 'res_one' and ok) <> 1 then raise exception 'FAIL reservation race winners'; end if;
  if (select count(*) from test_results where label like '%gave_up') <> 0 then raise exception 'FAIL deadlock retries exhausted'; end if;
  if (select count(*) from reservations where arrival_date = '2028-01-10') <> 1 then raise exception 'FAIL orphan reservations'; end if;
end \$\$"

echo "--- concurrency: two-room reservations (5 rooms, 40 clients each asking for 2)"
cat > "$DATA/res_multi.sql" <<'SQL'
select test_try_reserve('res_multi', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a5', '2028-02-01', '2028-02-03', '[{"room_type_id":"00000000-0000-0000-0000-0000000000a3","adults":2},{"room_type_id":"00000000-0000-0000-0000-0000000000a3","adults":2}]'::jsonb);
SQL
bench -c 40 -j 10 -t 1 -f "$DATA/res_multi.sql"
psql -At -c "select 'successes=' || count(*) filter (where ok) || ' failures=' || count(*) filter (where not ok) from test_results where label like 'res_multi%'"
psql -At -c "do \$\$ begin
  if (select count(*) from test_results where label = 'res_multi' and ok) <> 2 then raise exception 'FAIL multi-room winners'; end if;
  if (select count(*) from test_results where label like '%gave_up') <> 0 then raise exception 'FAIL deadlock retries exhausted'; end if;
  if (select count(*) from room_inventory_claims where start_date = '2028-02-01' and status = 'active') <> 4 then raise exception 'FAIL claim count'; end if;
  if exists (select 1 from reservations r where r.arrival_date = '2028-02-01'
              and (select count(*) from reservation_rooms rr where rr.reservation_id = r.id) <> 2) then raise exception 'FAIL partial multi-room reservation'; end if;
  if exists (select 1 from room_inventory_claims a join room_inventory_claims b
              on a.room_id = b.room_id and a.id < b.id and a.status='active' and b.status='active'
             and daterange(a.start_date,a.end_date,'[)') && daterange(b.start_date,b.end_date,'[)'))
  then raise exception 'FAIL overlapping claims exist'; end if;
end \$\$"
echo "--- concurrency: create_hold, last room (1 room, 50 clients, distinct guests)"
# Other tests book the solo room (201) on fixed calendar dates, so a fixed offset from today collides with them
# on some days of the year. Take the first offset whose two nights are free on that room and have no website booking.
HOLD_OFF="$(psql -At -c "select o from generate_series(100, 330) o
  where not exists (select 1 from room_inventory_claims c join rooms r on r.id = c.room_id
                     where r.room_number = '201' and c.status = 'active'
                       and daterange(c.start_date, c.end_date, '[)') && daterange(current_date + o, current_date + o + 2, '[)'))
    and not exists (select 1 from reservations where source = 'website' and arrival_date = current_date + o)
  order by o limit 1")"
[ -n "$HOLD_OFF" ] || { echo "no free window for the hold race"; exit 1; }
cat > "$DATA/hold_one.sql" <<SQL
select test_try_hold('hold_one', $HOLD_OFF, 2, '[{"room_type_id":"00000000-0000-0000-0000-0000000000a4","adults":2}]'::jsonb);
SQL
bench -c 50 -j 10 -t 1 -f "$DATA/hold_one.sql"
psql -At -c "select 'successes=' || count(*) filter (where ok) || ' failures=' || count(*) filter (where not ok) from test_results where label like 'hold_one%'"
psql -At -c "do \$\$ begin
  if (select count(*) from test_results where label = 'hold_one' and ok) <> 1 then raise exception 'FAIL hold race winners'; end if;
  if (select count(*) from test_results where label like '%gave_up') <> 0 then raise exception 'FAIL deadlock retries exhausted'; end if;
  if (select count(*) from reservations where source = 'website' and arrival_date = current_date + $HOLD_OFF) <> 1 then raise exception 'FAIL orphan hold reservations'; end if;
  if (select count(*) from guests where full_name = 'Race Guest') <> 1 then raise exception 'FAIL orphan guests'; end if;
end \$\$"

echo "--- concurrency: two-room holds (5 rooms, 40 clients each asking for 2)"
cat > "$DATA/hold_multi.sql" <<'SQL'
select test_try_hold('hold_multi', 130, 2, '[{"room_type_id":"00000000-0000-0000-0000-0000000000a3","adults":2},{"room_type_id":"00000000-0000-0000-0000-0000000000a3","adults":2}]'::jsonb);
SQL
bench -c 40 -j 10 -t 1 -f "$DATA/hold_multi.sql"
psql -At -c "select 'successes=' || count(*) filter (where ok) || ' failures=' || count(*) filter (where not ok) from test_results where label like 'hold_multi%'"
psql -At -c "do \$\$ begin
  if (select count(*) from test_results where label = 'hold_multi' and ok) <> 2 then raise exception 'FAIL multi-room hold winners'; end if;
  if (select count(*) from test_results where label like '%gave_up') <> 0 then raise exception 'FAIL deadlock retries exhausted'; end if;
  if (select count(*) from room_inventory_claims where start_date = current_date + 130 and claim_type = 'hold' and status = 'active') <> 4 then raise exception 'FAIL hold claim count'; end if;
  if exists (select 1 from reservations r where r.arrival_date = current_date + 130
              and (select count(*) from reservation_rooms rr where rr.reservation_id = r.id) <> 2) then raise exception 'FAIL partial multi-room hold'; end if;
end \$\$"
echo "--- concurrency: manual payments (total split in 5, 20 clients, exactly 5 fit)"
cat > "$DATA/pay_race.sql" <<'SQL'
select test_try_pay('pay_race', (select id from t07_ctx where label = 'race'),
  (select r.total_minor / 5 from reservations r join t07_ctx c on c.id = r.id where c.label = 'race'));
SQL
bench -c 20 -j 10 -t 1 -f "$DATA/pay_race.sql"
psql -At -c "select 'successes=' || count(*) filter (where ok) || ' failures=' || count(*) filter (where not ok) from test_results where label like 'pay_race%'"
psql -At -c "do \$\$ declare v_res uuid := (select id from t07_ctx where label = 'race'); begin
  if (select count(*) from test_results where label = 'pay_race' and ok) <> 5 then raise exception 'FAIL payment race winners'; end if;
  if (select count(*) from test_results where label like '%gave_up') <> 0 then raise exception 'FAIL deadlock retries exhausted'; end if;
  if (select sum(amount_minor) from payments where reservation_id = v_res) <> (select total_minor from reservations where id = v_res) then raise exception 'FAIL payments differ from total'; end if;
  if (select sum(a.amount_minor) from payment_allocations a join invoices i on i.id = a.invoice_id where i.reservation_id = v_res) <> (select total_minor from reservations where id = v_res) then raise exception 'FAIL allocations differ from total'; end if;
  if (select payment_status from reservations where id = v_res) <> 'paid' or (select invoice_status from invoices where reservation_id = v_res) <> 'paid' then raise exception 'FAIL statuses after race'; end if;
end \$\$"
echo "--- concurrency: the same webhook delivered 20 times at once"
cat > "$DATA/confirm_race.sql" <<'SQL'
select test_try_confirm('confirm_race');
SQL
bench -c 20 -j 10 -t 1 -f "$DATA/confirm_race.sql"
psql -At -c "select 'first deliveries=' || count(*) filter (where ok) || ' repeats=' || count(*) filter (where not ok) from test_results where label = 'confirm_race'"
psql -At -c "do \$\$ declare v_res uuid := (select res from t08_ctx where label = 'race'); begin
  if (select count(*) from test_results where label = 'confirm_race' and ok) <> 1 then raise exception 'FAIL more than one first delivery'; end if;
  if (select count(*) from payments where reservation_id = v_res) <> 1 then raise exception 'FAIL duplicate webhook recorded money twice'; end if;
  if (select count(*) from payment_events where provider_event_id = 'evt-race-1') <> 1 then raise exception 'FAIL event rows'; end if;
  if (select reservation_status from reservations where id = v_res) <> 'confirmed' then raise exception 'FAIL not confirmed'; end if;
  if (select count(*) from room_inventory_claims c join reservation_rooms rr on rr.id = c.reservation_room_id where rr.reservation_id = v_res and c.status = 'active' and c.claim_type = 'stay') <> 1 then raise exception 'FAIL claims after race'; end if;
end \$\$"
echo "--- concurrency: refund requests (20 clients ask 600,000 of a 1,000,000 payment)"
cat > "$DATA/refund_race.sql" <<'SQL'
select test_try_refund('refund_race');
SQL
bench -c 20 -j 10 -t 1 -f "$DATA/refund_race.sql"
psql -At -c "select 'successes=' || count(*) filter (where ok) || ' failures=' || count(*) filter (where not ok) from test_results where label like 'refund_race%'"
psql -At -c "do \$\$ declare v_pay uuid := (select c_pay from t09_ctx where label = 'race'); begin
  if (select count(*) from test_results where label = 'refund_race' and ok) <> 1 then raise exception 'FAIL refund race winners'; end if;
  if (select count(*) from test_results where label like '%gave_up') <> 0 then raise exception 'FAIL deadlock retries exhausted'; end if;
  if (select coalesce(sum(amount_minor), 0) from refunds where payment_id = v_pay and refund_status in ('requested','approved','processing','succeeded')) <> 600000 then raise exception 'FAIL refunds exceed or miss'; end if;
end \$\$"
echo "--- concurrency: email workers (20 pending emails, 30 workers claiming one each)"
# earlier races create website holds, which queue their own emails: leave only the 20 fixture rows claimable
psql -c "update email_outbox set status = 'sent', sent_at = now() where status = 'pending' and (dedupe_key is null or dedupe_key not like 'race-%')"
cat > "$DATA/claim_race.sql" <<'SQL'
select test_try_claim('claim_race');
SQL
bench -c 30 -j 10 -t 1 -f "$DATA/claim_race.sql"
psql -At -c "select 'claimed=' || count(*) filter (where ok) || ' empty=' || count(*) filter (where not ok) from test_results where label = 'claim_race'"
psql -At -c "do \$\$ begin
  if (select count(*) from t12_claims) <> 20 or (select count(distinct email_id) from t12_claims) <> 20 then raise exception 'FAIL an email was claimed twice or missed'; end if;
  if (select count(*) from email_outbox where status = 'sending' and dedupe_key like 'race-%') <> 20 then raise exception 'FAIL claimed rows not marked sending'; end if;
end \$\$"
echo "--- concurrency: transfers and blocks over the same rooms"
psql -f "$HERE/19_race_fixtures.sql"
# first window (two nights) from $1 on in which no STD room has any active claim
free_std_window() {
  psql -At -c "select o from generate_series($1, 340) o
    where not exists (select 1 from room_inventory_claims c join rooms r on r.id = c.room_id
                       where r.room_type_id = '00000000-0000-0000-0000-0000000000a3' and c.status = 'active'
                         and daterange(c.start_date, c.end_date, '[)') && daterange(property_today('00000000-0000-0000-0000-0000000000a2') + o, property_today('00000000-0000-0000-0000-0000000000a2') + o + 2, '[)'))
    order by o limit 1"
}
W1="$(free_std_window 150)"; [ -n "$W1" ] || { echo "no free window for the transfer race"; exit 1; }
psql -c "select t19_setup('xfer_race', $W1, 4)"
W2="$(free_std_window $((W1 + 3)))"; [ -n "$W2" ] || { echo "no free window for the auto transfer race"; exit 1; }
psql -c "select t19_setup('xfer_auto', $W2, 4)"
W3="$(free_std_window $((W2 + 3)))"; [ -n "$W3" ] || { echo "no free window for the block race"; exit 1; }
W4="$(free_std_window $((W3 + 3)))"; [ -n "$W4" ] || { echo "no free window for the block-and-move race"; exit 1; }
psql -c "select t19_setup('block_move', $W4, 1)"

echo "--- 4 guests all move into the one free room (105) at once: exactly one gets it, the others keep theirs"
cat > "$DATA/xfer_race.sql" <<'SQL'
select t19_try_transfer('xfer_race', :client_id, '105', 0);
SQL
bench -c 4 -j 4 -t 1 -f "$DATA/xfer_race.sql"
psql -At -c "select 'successes=' || count(*) filter (where ok) || ' failures=' || count(*) filter (where not ok) from test_results where label like 'xfer_race%'"
psql -At -c "do \$\$ declare t date := property_today('00000000-0000-0000-0000-0000000000a2'); begin
  if (select count(*) from test_results where label = 'xfer_race' and ok) <> 1 then raise exception 'FAIL transfer race winners'; end if;
  if (select count(*) from test_results where label = 'xfer_race') <> 4 then raise exception 'FAIL a client got no clean answer'; end if;
  if (select count(*) from test_results where label like '%gave_up') <> 0 then raise exception 'FAIL deadlock retries exhausted'; end if;
  if (select count(*) from room_inventory_claims c join rooms r on r.id = c.room_id where r.room_number = '105' and c.status = 'active' and c.claim_type = 'stay'
        and c.start_date = t + $W1) <> 1 then raise exception 'FAIL room 105 claimed by more or fewer than one stay'; end if;
  if exists (select 1 from t19_rr x where x.label = 'xfer_race'
              and (select count(*) from room_inventory_claims c where c.reservation_room_id = x.rr and c.status = 'active') <> 1) then
    raise exception 'FAIL a guest lost their room or holds two';
  end if;
  if (select count(distinct c.room_id) from room_inventory_claims c join t19_rr x on x.rr = c.reservation_room_id
       where x.label = 'xfer_race' and c.status = 'active') <> 4 then raise exception 'FAIL two guests share a room'; end if;
end \$\$"

echo "--- 8 clients move 4 guests to any free room from the second night (two clients per guest): nobody loses a night, no room is shared"
cat > "$DATA/xfer_auto.sql" <<'SQL'
select t19_try_transfer('xfer_auto', :client_id, null, 1);
SQL
bench -c 8 -j 8 -t 1 -f "$DATA/xfer_auto.sql"
psql -At -c "select 'moved=' || count(*) filter (where ok) || ' refused_stale_duplicate=' || count(*) filter (where label = 'xfer_auto_stale') from test_results where label like 'xfer_auto%'"
psql -At -c "do \$\$ begin
  if (select count(*) from test_results where label like '%gave_up') <> 0 then raise exception 'FAIL deadlock retries exhausted'; end if;
  if exists (select 1 from t19_rr x where x.label = 'xfer_auto'
              and (select coalesce(sum(c.end_date - c.start_date), 0) from room_inventory_claims c where c.reservation_room_id = x.rr and c.status = 'active') <> 2) then
    raise exception 'FAIL a guest lost or doubled a night';
  end if;
  if exists (select 1 from room_inventory_claims c join generate_series(c.start_date, c.end_date - 1, interval '1 day') n on true
              where c.status = 'active' and c.claim_type in ('stay','hold','block') and c.start_date >= property_today('00000000-0000-0000-0000-0000000000a2') + $W2 and c.start_date < property_today('00000000-0000-0000-0000-0000000000a2') + $W2 + 2
              group by c.room_id, n having count(*) > 1) then raise exception 'FAIL a room is claimed twice on one night'; end if;
  if (select count(*) from test_results where label like 'xfer_auto%' and label not like '%gave_up') <> 8 then raise exception 'FAIL a client got no clean answer'; end if;
  if (select count(*) from test_results where label = 'xfer_auto' and ok) < 4 then raise exception 'FAIL fewer successful moves than guests'; end if;
end \$\$"

echo "--- 12 clients block the same free room at once: exactly one block"
cat > "$DATA/block_fail.sql" <<SQL
select t19_try_block('block_fail', '105', $W3, 'fail');
SQL
bench -c 12 -j 6 -t 1 -f "$DATA/block_fail.sql"
psql -At -c "select 'created=' || count(*) filter (where ok) || ' reported_conflict=' || count(*) filter (where not ok) from test_results where label like 'block_fail%'"
psql -At -c "do \$\$ begin
  if (select count(*) from test_results where label = 'block_fail' and ok) <> 1 then raise exception 'FAIL block race winners'; end if;
  if (select count(*) from test_results where label = 'block_fail') <> 12 then raise exception 'FAIL a client got no clean answer'; end if;
  if (select count(*) from test_results where label like '%gave_up') <> 0 then raise exception 'FAIL deadlock retries exhausted'; end if;
  if (select count(*) from room_inventory_claims c join rooms r on r.id = c.room_id where r.room_number = '105' and c.claim_type = 'block' and c.status = 'active'
        and c.start_date = property_today('00000000-0000-0000-0000-0000000000a2') + $W3) <> 1 then raise exception 'FAIL block count'; end if;
end \$\$"

echo "--- 12 clients block a room that has a guest in it, asking to move the guest: one block, the guest moved once, no loss"
cat > "$DATA/block_move.sql" <<SQL
select t19_try_block('block_move', '101', $W4, 'move');
SQL
bench -c 12 -j 6 -t 1 -f "$DATA/block_move.sql"
psql -At -c "select 'created=' || count(*) filter (where ok) || ' reported_conflict=' || count(*) filter (where not ok) from test_results where label like 'block_move%'"
psql -At -c "do \$\$ declare v_rr uuid := (select rr from t19_rr where label = 'block_move' and n = 0); begin
  if (select count(*) from test_results where label = 'block_move' and ok) <> 1 then raise exception 'FAIL block-and-move winners'; end if;
  if (select count(*) from test_results where label = 'block_move') <> 12 then raise exception 'FAIL a client got no clean answer'; end if;
  if (select count(*) from test_results where label like '%gave_up') <> 0 then raise exception 'FAIL deadlock retries exhausted'; end if;
  if (select count(*) from room_inventory_claims c join rooms r on r.id = c.room_id where r.room_number = '101' and c.claim_type = 'block' and c.status = 'active'
        and c.start_date = property_today('00000000-0000-0000-0000-0000000000a2') + $W4) <> 1 then raise exception 'FAIL block count'; end if;
  if (select coalesce(sum(end_date - start_date), 0) from room_inventory_claims where reservation_room_id = v_rr and status = 'active') <> 2 then raise exception 'FAIL guest lost a night'; end if;
  if exists (select 1 from room_inventory_claims c join rooms r on r.id = c.room_id where c.reservation_room_id = v_rr and c.status = 'active' and r.room_number = '101') then
    raise exception 'FAIL guest still in the blocked room';
  end if;
  if (select count(*) from room_inventory_claims where reservation_room_id = v_rr and status = 'active') <> 1 then raise exception 'FAIL guest claims'; end if;
end \$\$"
echo "--- concurrency: a block, website holds and staff bookings fight over the one room of the solo type (rounds 1-6: all three; rounds 7-10: only blocks and website holds, the blocks arriving late in 9 and 10; who wins varies, exactly one must)"
psql -f "$HERE/27_block_race_fixtures.sql"
PREV=200
for i in 1 2 3 4 5 6 7 8 9 10; do
  KINDS=3; [ "$i" -le 6 ] || KINDS=2
  OFF="$(psql -At -c "select t27_setup($PREV)")"; [ -n "$OFF" ] || { echo "no free window for the block and booking race"; exit 1; }
  PREV=$((OFF + 3))
  # Rounds 9 and 10: the clients that block wait 40 ms, so the holds are already racing when the blocks arrive.
  if [ "$i" -ge 9 ]; then HEAD='\set k :client_id % 2
\if :k = 0
\sleep 40 ms
\endif'; else HEAD="\\set k :client_id % $KINDS"; fi
  cat > "$DATA/block_vs_book.sql" <<SQL
$HEAD
select t27_try('t27_r$i', :k);
SQL
  bench -c 24 -j 8 -t 1 -f "$DATA/block_vs_book.sql"
  psql -At -c "select 'round $i: winner=' || coalesce((select case split_part(label, ':', 2) when '0' then 'block' when '1' then 'hold' else 'staff booking' end from test_results where label like 't27_r$i:%' and ok limit 1), 'NOBODY') || ' refused=' || count(*) filter (where not ok) from test_results where label like 't27_r$i:%'"
  psql -At -c "do \$\$ declare
    v_d date := (select d from t27_ctx);
    v_room uuid := (select id from rooms where property_id = '00000000-0000-0000-0000-0000000000a2' and room_number = '201');
    v_n integer; v_type text; v_kind text := (select split_part(label, ':', 2) from test_results where label like 't27_r$i:%' and ok limit 1);
  begin
    if (select count(*) from test_results where label like 't27_r$i:%' and ok) <> 1 then raise exception 'FAIL round $i: not exactly one client got the room'; end if;
    if (select count(*) from test_results where label like 't27_r$i:%') <> 24 then raise exception 'FAIL round $i: a client got no clean answer'; end if;
    select count(*), min(claim_type) into v_n, v_type from room_inventory_claims
     where room_id = v_room and status = 'active' and daterange(start_date, end_date, '[)') && daterange(v_d, v_d + 2, '[)');
    if v_n <> 1 then raise exception 'FAIL round $i: % active claims on the room, expected one', v_n; end if;
    if (v_kind = '0') <> (v_type = 'block') or (v_kind = '1') <> (v_type = 'hold') or (v_kind = '2') <> (v_type = 'stay') then
      raise exception 'FAIL round $i: the winner (kind %) and the claim (%) do not match', v_kind, v_type;
    end if;
    if (select count(*) from reservations where arrival_date = v_d) <> (case when v_type = 'block' then 0 else 1 end) then
      raise exception 'FAIL round $i: orphan or missing reservation';
    end if;
    if exists (select 1 from guests g where g.full_name = 'T27 Race Guest' and not exists (select 1 from reservations r where r.primary_guest_id = g.id)) then
      raise exception 'FAIL round $i: a refused hold left a guest behind';
    end if;
  end \$\$"
done

echo "--- concurrency: housekeeping task claimed by two housekeepers at once (20 clients): exactly one of them gets it"
psql -c "select t21_race_setup()"
cat > "$DATA/hk_claim.sql" <<'SQL'
select t21_try_claim('hk_claim', :client_id);
SQL
bench -c 20 -j 10 -t 1 -f "$DATA/hk_claim.sql"
psql -At -c "select 'housekeeper A ok=' || count(*) filter (where label = 'hk_claim_a' and ok) || ' B ok=' || count(*) filter (where label = 'hk_claim_b' and ok) from test_results where label like 'hk_claim%'"
psql -At -c "do \$\$ declare v_t uuid := (select id from t21_ctx where label = 'claim'); begin
  if (select count(*) from test_results where label like 'hk_claim%') <> 20 then raise exception 'FAIL a client got no clean answer'; end if;
  if (select count(*) from test_results where label = 'hk_claim_a' and ok) > 0 and (select count(*) from test_results where label = 'hk_claim_b' and ok) > 0 then raise exception 'FAIL both housekeepers got the task'; end if;
  if (select count(*) from test_results where label like 'hk_claim%' and ok) = 0 then raise exception 'FAIL nobody got the task'; end if;
  if (select assigned_to from housekeeping_tasks where id = v_t) not in ('00000000-0000-0000-0000-00000000aa02', '00000000-0000-0000-0000-00000000aa06') then raise exception 'FAIL task not assigned'; end if;
  if (select count(*) from audit_logs where action = 'housekeeping.task_assigned' and entity_id = v_t) <> 1 then raise exception 'FAIL claim audit rows'; end if;
end \$\$"

echo "--- concurrency: one room, 16 clients mixing room status changes and task start/complete (no deadlock, task and room agree)"
cat > "$DATA/hk_mix.sql" <<'SQL'
\set w random(0, 4)
select t21_mix('hk_mix', :w);
SQL
bench -c 16 -j 8 -t 25 -f "$DATA/hk_mix.sql"
psql -At -c "select 'ok=' || count(*) filter (where ok) || ' refused=' || count(*) filter (where not ok) from test_results where label = 'hk_mix'"
psql -At -c "do \$\$ declare v_room uuid := t21_room('103'); v_status text; v_live integer; begin
  select housekeeping_status into v_status from rooms where id = v_room;
  select count(*) into v_live from housekeeping_tasks where room_id = v_room and task_type = 'cleaning' and status in ('open', 'in_progress');
  if (select count(*) from test_results where label = 'hk_mix') <> 400 then raise exception 'FAIL a client got no clean answer'; end if;
  if v_live > 1 then raise exception 'FAIL % live cleaning tasks for one room', v_live; end if;
  if v_status in ('clean', 'inspected') and v_live <> 0 then raise exception 'FAIL room % but a cleaning task is still live', v_status; end if;
  if v_status = 'dirty' and v_live <> 1 then raise exception 'FAIL dirty room without exactly one live task (%)', v_live; end if;
  if exists (select 1 from housekeeping_tasks where room_id = v_room and status = 'in_progress' and started_at is null) then raise exception 'FAIL started task without a start time'; end if;
end \$\$"
echo "--- concurrency: maintenance request claimed by two technicians at once (20 clients): exactly one of them gets it"
psql -c "select t24_race_setup()"
cat > "$DATA/mt_claim.sql" <<'SQL'
select t24_try_claim('mt_claim', :client_id);
SQL
bench -c 20 -j 10 -t 1 -f "$DATA/mt_claim.sql"
psql -At -c "select 'technician A ok=' || count(*) filter (where label = 'mt_claim_a' and ok) || ' B ok=' || count(*) filter (where label = 'mt_claim_b' and ok) from test_results where label like 'mt_claim%'"
psql -At -c "do \$\$ declare v_r uuid := (select id from t24_ctx where label = 'claim'); begin
  if (select count(*) from test_results where label like 'mt_claim%') <> 20 then raise exception 'FAIL a client got no clean answer'; end if;
  if (select count(*) from test_results where label = 'mt_claim_a' and ok) > 0 and (select count(*) from test_results where label = 'mt_claim_b' and ok) > 0 then raise exception 'FAIL both technicians got the request'; end if;
  if (select count(*) from test_results where label like 'mt_claim%' and ok) = 0 then raise exception 'FAIL nobody got the request'; end if;
  if (select assigned_to from maintenance_requests where id = v_r) not in ('00000000-0000-0000-0000-00000000aa08', '00000000-0000-0000-0000-00000000aa10') then raise exception 'FAIL request not assigned'; end if;
  if (select count(*) from audit_logs where action = 'maintenance.request_assigned' and entity_id = v_r) <> 1 then raise exception 'FAIL claim audit rows'; end if;
end \$\$"

echo "--- concurrency: the same fault reported 20 times at once with one key: one request, one answer"
cat > "$DATA/mt_report.sql" <<'SQL'
select t24_try_report('mt_report');
SQL
bench -c 20 -j 10 -t 1 -f "$DATA/mt_report.sql"
psql -At -c "select 'answers=' || count(*) || ' distinct request ids=' || count(distinct val) from t24_out where label = 'mt_report'"
psql -At -c "do \$\$ begin
  if (select count(*) from t24_out where label = 'mt_report') <> 20 then raise exception 'FAIL a client got no answer'; end if;
  if (select count(distinct val) from t24_out where label = 'mt_report') <> 1 then raise exception 'FAIL clients were told different requests'; end if;
  if (select count(*) from maintenance_requests where title = 'Race: double tap') <> 1 then raise exception 'FAIL more than one request was made'; end if;
  if (select count(*) from audit_logs where action = 'maintenance.request_created' and entity_id = (select id from maintenance_requests where title = 'Race: double tap')) <> 1 then raise exception 'FAIL created audit rows'; end if;
end \$\$"

echo "--- concurrency: a folio balance paid in full by 20 clients at once: exactly one payment is taken"
psql -c "select t25_race_setup()"
cat > "$DATA/fol_pay.sql" <<'SQL'
select t25_try_pay('fol_pay', :client_id);
SQL
bench -c 20 -j 10 -t 1 -f "$DATA/fol_pay.sql"
psql -At -c "select 'payments ok=' || count(*) filter (where ok) || ' refused=' || count(*) filter (where not ok) from test_results where label = 'fol_pay'"
psql -At -c "do \$\$ declare v_tot record; begin
  select * into v_tot from folio_totals(t25_res());
  if (select count(*) from test_results where label = 'fol_pay') <> 20 then raise exception 'FAIL a client got no clean answer'; end if;
  if (select count(*) from test_results where label = 'fol_pay' and ok) <> 1 then raise exception 'FAIL % payments were taken for one balance', (select count(*) from test_results where label = 'fol_pay' and ok); end if;
  if v_tot.paid_minor <> v_tot.charges_minor then raise exception 'FAIL balance not settled exactly (paid %, charges %)', v_tot.paid_minor, v_tot.charges_minor; end if;
end \$\$"

echo "--- concurrency: the same folio charge posted 20 times at once with one key: one charge, one answer"
cat > "$DATA/fol_post.sql" <<'SQL'
select t25_try_post('fol_post');
SQL
bench -c 20 -j 10 -t 1 -f "$DATA/fol_post.sql"
psql -At -c "select 'answers=' || count(*) || ' distinct charge ids=' || count(distinct val) from t25_out where label = 'fol_post'"
psql -At -c "do \$\$ begin
  if (select count(*) from t25_out where label = 'fol_post') <> 20 then raise exception 'FAIL a client got no answer'; end if;
  if (select count(distinct val) from t25_out where label = 'fol_post') <> 1 then raise exception 'FAIL clients were told different charges'; end if;
  if (select count(*) from folio_charges where description = 'Race snack') <> 1 then raise exception 'FAIL more than one charge was made'; end if;
  if (select count(*) from audit_logs where action = 'folio.charge_posted' and entity_id = (select id from folio_charges where description = 'Race snack')) <> 1 then raise exception 'FAIL posted audit rows'; end if;
end \$\$"

echo "--- concurrency: one reservation, 12 clients posting, paying and voiding at once (no deadlock, never over-paid)"
cat > "$DATA/fol_mix.sql" <<'SQL'
\set w random(0, 2)
\set n random(1, 1000000000)
select t25_mix('fol_mix', :w, :n);
SQL
bench -c 12 -j 6 -t 20 -f "$DATA/fol_mix.sql"
psql -At -c "select 'ok=' || count(*) filter (where ok) || ' refused=' || count(*) filter (where not ok) from test_results where label = 'fol_mix'"
psql -At -c "do \$\$ declare v_tot record; begin
  select * into v_tot from folio_totals(t25_res());
  if (select count(*) from test_results where label = 'fol_mix') <> 240 then raise exception 'FAIL a client got no clean answer'; end if;
  if v_tot.paid_minor > v_tot.charges_minor then raise exception 'FAIL folio over-paid (paid %, charges %)', v_tot.paid_minor, v_tot.charges_minor; end if;
  if v_tot.paid_minor < 0 or v_tot.charges_minor < 0 then raise exception 'FAIL negative folio'; end if;
  if t25_money(t25_res()) <> (select val from t25_ctx where label = 'money') then raise exception 'FAIL the reservation''s own money changed'; end if;
end \$\$"

echo "--- concurrency: 4 bookings edited, moved and competed for at once (no deadlock, claims always tile the stay, totals equal the nights)"
psql -f "$HERE/32_stay_edit_race.sql"
psql -c "select t32_setup('stay_race', 900, 4)"
cat > "$DATA/stay_race.sql" <<'SQL'
\set w random(0, 11)
\set n random(0, 1000000)
select t32_act('stay_race', :client_id, :w, :n);
SQL
bench -c 12 -j 6 -t 25 -f "$DATA/stay_race.sql"
psql -At -c "select 'ok=' || count(*) filter (where ok) || ' refused=' || count(*) filter (where not ok) from test_results where label = 'stay_race'"
psql -At -c "do \$\$ declare v record; begin
  if (select count(*) from test_results where label = 'stay_race') <> 300 then raise exception 'FAIL a client got no clean answer'; end if;
  if exists (select 1 from test_results where label like 'stay_race\_%') then
    raise exception 'FAIL %', (select string_agg(distinct label, '; ') from test_results where label like 'stay_race\_%');
  end if;
  if (select count(*) filter (where ok) from test_results where label = 'stay_race') = 0 then raise exception 'FAIL no edit or move ever succeeded'; end if;
  for v in select s.res, s.rr, r.arrival_date a, r.departure_date d, r.total_minor, r.subtotal_minor, r.tax_minor
             from t32_res s join reservations r on r.id = s.res where s.label = 'stay_race' loop
    if v.total_minor <> (select coalesce(sum(n.rate_minor + n.tax_minor), 0) from reservation_nights n where n.reservation_room_id = v.rr) then raise exception 'FAIL total <> nights for %', v.res; end if;
    if v.subtotal_minor + v.tax_minor <> v.total_minor then raise exception 'FAIL total <> subtotal + tax for %', v.res; end if;
    if (select count(*) || '/' || min(n.night_date) || '/' || max(n.night_date) from reservation_nights n where n.reservation_room_id = v.rr) <> (v.d - v.a)::text || '/' || v.a || '/' || (v.d - 1) then
      raise exception 'FAIL nights do not match the dates for %', v.res; end if;
    if (select coalesce(sum(c.end_date - c.start_date), 0) || '/' || min(c.start_date) || '/' || max(c.end_date) from room_inventory_claims c where c.reservation_room_id = v.rr and c.status = 'active' and c.claim_type = 'stay')
       <> (v.d - v.a)::text || '/' || v.a || '/' || v.d then raise exception 'FAIL claims do not tile the stay for %', v.res; end if;
    if exists (select 1 from payments where reservation_id = v.res) or exists (select 1 from invoices where reservation_id = v.res) then raise exception 'FAIL money records appeared'; end if;
  end loop;
end \$\$"

echo "ALL TESTS PASSED"
