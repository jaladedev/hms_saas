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
  if echo "$out" | grep -qE 'failed transactions: [1-9]'; then echo "$out" | grep -E 'ERROR|failed' | sort | uniq -c | head; echo "BENCH FAILED"; exit 1; fi
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
cat > "$DATA/hold_one.sql" <<'SQL'
select test_try_hold('hold_one', 120, 2, '[{"room_type_id":"00000000-0000-0000-0000-0000000000a4","adults":2}]'::jsonb);
SQL
bench -c 50 -j 10 -t 1 -f "$DATA/hold_one.sql"
psql -At -c "select 'successes=' || count(*) filter (where ok) || ' failures=' || count(*) filter (where not ok) from test_results where label like 'hold_one%'"
psql -At -c "do \$\$ begin
  if (select count(*) from test_results where label = 'hold_one' and ok) <> 1 then raise exception 'FAIL hold race winners'; end if;
  if (select count(*) from test_results where label like '%gave_up') <> 0 then raise exception 'FAIL deadlock retries exhausted'; end if;
  if (select count(*) from reservations where source = 'website' and arrival_date = current_date + 120) <> 1 then raise exception 'FAIL orphan hold reservations'; end if;
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
echo "ALL TESTS PASSED"
