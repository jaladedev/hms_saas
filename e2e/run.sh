#!/usr/bin/env bash
# End-to-end test of the guest flow: Next.js app + PostgREST + PostgreSQL 16 + a fake Paystack.
# Needs PostgreSQL 16 server binaries and the PostgREST binary (downloaded to /tmp if PGRST_BIN is unset).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
PORT="${PGPORT:-54330}"
DATA="$(mktemp -d)"
PIDS=()
cp "$ROOT/tsconfig.json" /tmp/tsconfig.e2e.bak   # next build rewrites it for the e2e dist dir
RUNAS=""
if [ "$(id -u)" = "0" ]; then RUNAS="su postgres -s /bin/bash -c"; chown postgres "$DATA"; fi
run() { if [ -n "$RUNAS" ]; then $RUNAS "$*"; else bash -c "$*"; fi; }
cleanup() {
  for p in "${PIDS[@]:-}"; do kill "$p" >/dev/null 2>&1 || true; done
  run "$PGBIN/pg_ctl -D $DATA -m immediate stop" >/dev/null 2>&1 || true
  rm -rf "$DATA" "$ROOT/.next-e2e"
  cp /tmp/tsconfig.e2e.bak "$ROOT/tsconfig.json"
}
trap cleanup EXIT

export PGRST_JWT_SECRET="e2e-jwt-secret-e2e-jwt-secret-e2e-jwt-secret"
export PAYSTACK_SECRET_E2E="sk_test_e2e_secret_value"
export PGHOST=/tmp PGPORT=$PORT PGUSER=postgres PGDATABASE=hms_e2e
psql() { "$PGBIN/psql" -q -v ON_ERROR_STOP=1 "$@"; }

if [ -z "${PGRST_BIN:-}" ]; then
  PGRST_BIN=/tmp/postgrest
  if [ ! -x "$PGRST_BIN" ]; then
    TAG="$(curl -sI https://github.com/PostgREST/postgrest/releases/latest | grep -i '^location' | sed 's#.*/tag/##' | tr -d '\r\n')"
    curl -sL -o /tmp/pgrst.tar.xz "https://github.com/PostgREST/postgrest/releases/download/$TAG/postgrest-$TAG-linux-static-x86-64.tar.xz"
    tar -xJf /tmp/pgrst.tar.xz -C /tmp
  fi
fi

run "$PGBIN/initdb -D $DATA --auth=trust -U postgres" >/dev/null
run "$PGBIN/pg_ctl -D $DATA -o '-p $PORT -k /tmp -c max_connections=100 -c fsync=off' -l $DATA/log -w start" >/dev/null
"$PGBIN/createdb" hms_e2e
psql -f "$ROOT/supabase/tests/00_stub_auth.sql"
for f in "$ROOT"/supabase/migrations/*.sql; do psql -f "$f"; done
psql -f "$ROOT/supabase/tests/01_seed.sql"
psql <<'SQL'
insert into tenant_domains (tenant_id, property_id, host, verified_at)
values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', 'book.hotel-a.test', now());
insert into payment_provider_accounts (tenant_id, provider, mode, account_label, secret_reference, status)
values ('00000000-0000-0000-0000-0000000000a1', 'paystack', 'test', 'Hotel A e2e', 'env:PAYSTACK_SECRET_E2E', 'active');
alter role authenticator login;
insert into auth.users (id) values ('00000000-0000-0000-0000-00000000aa01'), ('00000000-0000-0000-0000-00000000aa05');
insert into tenant_memberships (id, tenant_id, user_id, status) values
  ('00000000-0000-0000-0000-0000000aaa01', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000aa01', 'active'),
  ('00000000-0000-0000-0000-0000000aaa05', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000aa05', 'active');
insert into membership_roles (membership_id, role_id)
  select '00000000-0000-0000-0000-0000000aaa01'::uuid, id from roles where key = 'owner'
  union all select '00000000-0000-0000-0000-0000000aaa05'::uuid, id from roles where key = 'accountant';
SQL
export ACCOUNT_ID="$("$PGBIN/psql" -At -c "select id from payment_provider_accounts limit 1")"

PGRST_DB_URI="postgres://authenticator@/hms_e2e?host=/tmp&port=$PORT" PGRST_DB_SCHEMAS=public PGRST_DB_ANON_ROLE=anon \
  PGRST_SERVER_PORT=3001 PGRST_SERVER_HOST=127.0.0.1 PGRST_DB_POOL=5 "$PGRST_BIN" >/tmp/e2e-postgrest.log 2>&1 &
PIDS+=($!)
node "$ROOT/e2e/proxy.mjs" >/tmp/e2e-proxy.log 2>&1 & PIDS+=($!)
node "$ROOT/e2e/fake-paystack.mjs" >/tmp/e2e-fake.log 2>&1 & PIDS+=($!)
export RESEND_API_KEY_E2E="re_e2e_test_key" FAKE_RESEND_PORT=4011
node "$ROOT/e2e/fake-resend.mjs" >/tmp/e2e-resend.log 2>&1 & PIDS+=($!)

SERVICE_KEY="$(node -e '
const c=require("node:crypto");const b=o=>Buffer.from(JSON.stringify(o)).toString("base64url");
const h=b({alg:"HS256",typ:"JWT"}),p=b({role:"service_role",iss:"e2e"});
console.log(h+"."+p+"."+c.createHmac("sha256",process.env.PGRST_JWT_SECRET).update(h+"."+p).digest("base64url"))')"

export NEXT_DIST_DIR=.next-e2e
export NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:3002 NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=e2e-anon-placeholder
export SUPABASE_SERVICE_ROLE_KEY="$SERVICE_KEY" BOOKING_TOKEN_SECRET="e2e-booking-token-secret-at-least-32-chars"
export PAYSTACK_API_BASE_URL=http://127.0.0.1:4010
export RESEND_API_KEY="$RESEND_API_KEY_E2E" EMAIL_FROM="Hotel A <bookings@hotel-a.test>" RESEND_API_BASE_URL=http://127.0.0.1:4011 EMAIL_LINK_SCHEME=http
export CRON_SECRET="e2e-cron-secret-e2e-cron-secret-e2e-cron-secret"
(cd "$ROOT" && npx next build >/tmp/e2e-build.log 2>&1) || { tail -30 /tmp/e2e-build.log; exit 1; }
(cd "$ROOT" && npx next start -p 3100 >/tmp/e2e-next.log 2>&1) & PIDS+=($!)

for i in $(seq 1 60); do curl -s -o /dev/null http://127.0.0.1:3100/login && break; sleep 1; done
for i in $(seq 1 30); do curl -s -o /dev/null http://127.0.0.1:3001/ && break; sleep 1; done
node "$ROOT/e2e/flow.mjs" || { echo "--- next log"; tail -30 /tmp/e2e-next.log; echo "--- postgrest log"; tail -15 /tmp/e2e-postgrest.log; exit 1; }
