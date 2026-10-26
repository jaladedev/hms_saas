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
trap cleanup EXIT

run "$PGBIN/initdb -D $DATA --auth=trust -U postgres" >/dev/null
run "$PGBIN/pg_ctl -D $DATA -o '-p $PORT -k /tmp -c max_connections=200 -c fsync=off' -l $DATA/log -w start" >/dev/null
export PGHOST=/tmp PGPORT=$PORT PGUSER=postgres
"$PGBIN/createdb" hms_test
export PGDATABASE=hms_test
psql() { "$PGBIN/psql" -q -v ON_ERROR_STOP=1 "$@"; }

psql -f "$HERE/00_stub_auth.sql"
for f in "$ROOT"/supabase/migrations/*.sql; do echo "migrate $(basename "$f")"; psql -f "$f"; done
psql -f "$HERE/01_seed.sql"
OUT="$(psql -f "$HERE/02_claims.sql" 2>&1)" || { echo "$OUT"; echo "CLAIM TESTS FAILED"; exit 1; }
echo "$OUT" | grep -E 'PASS' || true
if echo "$OUT" | grep -qE 'FAIL|ERROR'; then echo "$OUT"; echo "CLAIM TESTS FAILED"; exit 1; fi

SEC="$(psql -f "$HERE/03_security.sql" 2>&1)" || { echo "$SEC"; echo "SECURITY TESTS FAILED"; exit 1; }
echo "$SEC" | grep -E 'PASS' || true
if echo "$SEC" | grep -qE 'FAIL|ERROR'; then echo "$SEC"; echo "SECURITY TESTS FAILED"; exit 1; fi

echo "--- concurrency: last room race (1 room, 50 clients)"
cat > "$DATA/race_one.sql" <<'SQL'
select test_try_claim('last_room', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a4', '2027-10-01', '2027-10-03');
SQL
"$PGBIN/pgbench" -n -c 50 -j 10 -t 1 -f "$DATA/race_one.sql" >/dev/null
psql -At -c "select 'successes=' || count(*) filter (where ok) || ' failures=' || count(*) filter (where not ok) from test_results where label='last_room'"
psql -At -c "do \$\$ begin if (select count(*) from test_results where label='last_room' and ok) <> 1 then raise exception 'FAIL last room race'; end if; end \$\$"

echo "--- concurrency: type-level race (5 rooms, 100 clients)"
cat > "$DATA/race_type.sql" <<'SQL'
select test_try_claim('type_race', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a3', '2027-11-01', '2027-11-04');
SQL
"$PGBIN/pgbench" -n -c 100 -j 10 -t 1 -f "$DATA/race_type.sql" >/dev/null
psql -At -c "select 'successes=' || count(*) filter (where ok) || ' failures=' || count(*) filter (where not ok) from test_results where label='type_race'"
psql -At -c "do \$\$ begin
  if (select count(*) from test_results where label='type_race' and ok) <> 5 then raise exception 'FAIL type race count'; end if;
  if exists (select 1 from room_inventory_claims a join room_inventory_claims b
              on a.room_id = b.room_id and a.id < b.id and a.status='active' and b.status='active'
             and daterange(a.start_date,a.end_date,'[)') && daterange(b.start_date,b.end_date,'[)'))
  then raise exception 'FAIL overlapping claims exist'; end if; end \$\$"
echo "ALL TESTS PASSED"
